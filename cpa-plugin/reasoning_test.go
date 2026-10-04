package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/pluginapi"
)

// TestApplyReasoningEffortPrecedence walks the documented priority order, which
// is the contract: an explicit client choice survives untouched and only a
// request that expressed no preference may receive the default.
//
// want is the exact JSON expected for reasoning_effort, "-" when it must be
// absent; nested records whether a "reasoning" key survives. Comparing encoded
// JSON also covers the pass-through of a non-string value.
func TestApplyReasoningEffortPrecedence(t *testing.T) {
	cases := []struct {
		name, fields, def, want string
		nested                  bool
	}{
		{"valid client effort wins", `"reasoning_effort":"low"`, "high", `"low"`, false},
		// The upstream is case-sensitive (code 11150); passing it through lets it
		// name the offending value instead of the plugin hiding the bug.
		{"invalid client effort passed through", `"reasoning_effort":"HIGH"`, "high", `"HIGH"`, false},
		{"numeric client effort passed through", `"reasoning_effort":3`, "high", `3`, false},
		{"SDK nested shape converted", `"reasoning":{"effort":"medium"}`, "high", `"medium"`, false},
		// An opt-out means "change nothing"; the nested key stays.
		{"nested off injects nothing", `"reasoning":{"effort":"off"}`, "high", "-", true},
		{"nested none injects nothing", `"reasoning":{"effort":"none"}`, "high", "-", true},
		{"reasoning:false injects nothing", `"reasoning":false`, "high", "-", true},
		{"reasoning:null injects nothing", `"reasoning":null`, "high", "-", true},
		{"reasoning:'none' injects nothing", `"reasoning":"none"`, "high", "-", true},
		{"no preference takes the default", `"messages":[]`, "high", `"high"`, false},
		{"empty nested effort takes the default", `"reasoning":{"effort":""}`, "xhigh", `"xhigh"`, true},
		// A garbage configured level disables injection rather than send
		// something the upstream answers with 11150.
		{"invalid configured level injects nothing", `"messages":[]`, "bogus", "-", false},
		{"empty configured level injects nothing", `"messages":[]`, "", "-", false},
		// Configuration is forgiving about case; the client path is not.
		{"case-variant configured level normalised", `"messages":[]`, " High ", `"high"`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, _ := applyReasoningEffort([]byte(`{"model":"m",`+tc.fields+`}`), tc.def)
			var doc map[string]json.RawMessage
			if err := json.Unmarshal(out, &doc); err != nil {
				t.Fatalf("output is not valid JSON: %v (%s)", err, out)
			}
			got, present := doc["reasoning_effort"]
			switch {
			case tc.want == "-" && present:
				t.Fatalf("reasoning_effort = %s, want absent", got)
			case tc.want != "-" && !present:
				t.Fatalf("reasoning_effort absent, want %s", tc.want)
			case tc.want != "-" && string(got) != tc.want:
				t.Fatalf("reasoning_effort = %s, want %s", got, tc.want)
			}
			if _, ok := doc["reasoning"]; ok != tc.nested {
				t.Fatalf("nested reasoning present = %v, want %v", ok, tc.nested)
			}
		})
	}
}

// TestApplyReasoningEffortIsFaithful guards the map-based rewrite: only the
// thinking fields may change, nested structures it does not model must survive,
// a second pass must be a no-op, and a non-object body must be left alone.
func TestApplyReasoningEffortIsFaithful(t *testing.T) {
	const body = `{"model":"glm-5.2","stream":true,"max_tokens":4096,` +
		`"messages":[{"role":"user","content":"hi"}],` +
		`"tools":[{"type":"function","function":{"name":"f","parameters":{"type":"object"}}}],` +
		`"metadata":{"trace":"abc"}}`
	out, changed := applyReasoningEffort([]byte(body), "high")
	if !changed {
		t.Fatal("expected the default to be injected")
	}
	var doc map[string]any
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}
	if doc["model"] != "glm-5.2" || doc["stream"] != true || doc["max_tokens"] != float64(4096) {
		t.Fatalf("scalar fields were altered: %v", doc)
	}
	if doc["reasoning_effort"] != "high" || len(doc) != 7 { // 7 also guards against drops
		t.Fatalf("reasoning_effort = %v, field count = %d: %v", doc["reasoning_effort"], len(doc), doc)
	}
	if meta, ok := doc["metadata"].(map[string]any); !ok || meta["trace"] != "abc" {
		t.Fatalf("nested metadata was altered: %v", doc["metadata"])
	}
	if again, c := applyReasoningEffort(out, "high"); c || string(again) != string(out) {
		t.Fatalf("second pass = %s (changed=%v), want %s", again, c, out)
	}
	for _, raw := range []string{"", "not json", `[1,2,3]`, `"a string"`} {
		if got, c := applyReasoningEffort([]byte(raw), "high"); c || string(got) != raw {
			t.Errorf("body %q -> %q (changed=%v)", raw, got, c)
		}
	}
}

// interceptBody runs one before-auth interception; nil means "no change".
func interceptBody(t *testing.T, configYAML, body string) []byte {
	t.Helper()
	resetState()
	callOK(t, pluginabi.MethodPluginRegister, lifecycleRequest{ConfigYAML: []byte(configYAML)})
	res := callOK(t, pluginabi.MethodRequestInterceptBefore, pluginapi.RequestInterceptRequest{
		RequestID: "r-reason", Body: []byte(body),
		Metadata: map[string]any{"providers": []any{"codebuddy"}},
	})
	var out pluginapi.RequestInterceptResponse
	if err := json.Unmarshal(res, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out.Body
}

// TestInterceptRequestInjectReasoning covers the wiring through the real hook.
//
// The first case is the regression guard for the actual bug: rewriteModelBody
// short-circuits when the model already matches, so a bare upstream name
// reported "not changed". The injection used to hang off that flag, which meant
// the level was added on almost no request and reasoning_tokens stayed at 0.
func TestInterceptRequestInjectReasoning(t *testing.T) {
	const cfg = "default_provider: codebuddy\nreasoning_effort: %s\n"
	// decode unmarshals a rewritten body, failing when none was produced.
	decode := func(t *testing.T, out []byte) map[string]any {
		t.Helper()
		if len(out) == 0 {
			t.Fatal("no body returned: the level was not injected, which is exactly the reported bug")
		}
		var doc map[string]any
		if err := json.Unmarshal(out, &doc); err != nil {
			t.Fatalf("body is not valid JSON: %v", err)
		}
		return doc
	}

	t.Run("a bare model name still gets the level", func(t *testing.T) {
		doc := decode(t, interceptBody(t, fmt.Sprintf(cfg, "high"),
			`{"model":"glm-5.2","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
		if doc["reasoning_effort"] != "high" || doc["model"] != "glm-5.2" {
			t.Fatalf("body = %v, want glm-5.2 with reasoning_effort=high", doc)
		}
	})

	// Both mutations at once: prefix stripped and level added.
	t.Run("the prefix rewrite and the injection compose", func(t *testing.T) {
		doc := decode(t, interceptBody(t, fmt.Sprintf(cfg, "medium"), `{"model":"codebuddy/glm-5.2","messages":[]}`))
		if doc["model"] != "glm-5.2" || doc["reasoning_effort"] != "medium" {
			t.Fatalf("body = %v, want a stripped model and reasoning_effort=medium", doc)
		}
	})

	t.Run("the master switch turns it off", func(t *testing.T) {
		out := interceptBody(t, "default_provider: codebuddy\nreasoning_enabled: false\nreasoning_effort: high\n",
			`{"model":"glm-5.2","messages":[]}`)
		if len(out) != 0 {
			t.Fatalf("body was rewritten while the feature is off: %s", out)
		}
	})
}

// TestReasoningSettingsDefaultsAndNormalisation covers the configuration path:
// the feature is on unless switched off, and a typo in the level falls back to
// the documented default rather than reaching the upstream.
func TestReasoningSettingsDefaultsAndNormalisation(t *testing.T) {
	if d := defaultGatewaySettings(); !d.ReasoningEnabled || d.ReasoningEffort != defaultReasoningEffort {
		t.Fatalf("defaults = enabled:%v effort:%q, want true/%q",
			d.ReasoningEnabled, d.ReasoningEffort, defaultReasoningEffort)
	}

	cases := map[string]string{
		"":        defaultReasoningEffort, // unset
		"bogus":   defaultReasoningEffort, // typo
		"  MAX  ": "max",                  // trimmed and lower-cased
		"low":     "low",
	}
	for input, want := range cases {
		cfg := gatewaySettings{ReasoningEffort: input}
		cfg.applyDefaults()
		if cfg.ReasoningEffort != want {
			t.Errorf("applyDefaults(%q) = %q, want %q", input, cfg.ReasoningEffort, want)
		}
	}

	// Only an explicit false turns it off: applyDefaults must not resurrect it.
	off := gatewaySettings{ReasoningEnabled: false, ReasoningEffort: "high"}
	off.applyDefaults()
	if off.ReasoningEnabled {
		t.Error("applyDefaults re-enabled an explicit opt-out")
	}
}

// ---- capability declaration ---------------------------------------------
// TestInputModalitiesRequireBothFlags pins the image rule: the capability flag
// alone is not enough, because the catalogue pairs supportsImages=true with
// disabledMultimodal=true on several entries. Text is always claimed, since CPA
// reads an empty list as "nothing allowed".
func TestInputModalitiesRequireBothFlags(t *testing.T) {
	cases := []struct {
		name  string
		model workBuddyModel
		want  string
	}{
		{"capable and not disabled", workBuddyModel{SupportsImages: true}, "text,image"},
		{"capable but multimodal disabled", workBuddyModel{SupportsImages: true, DisabledMultimodal: true}, "text"},
		{"not capable", workBuddyModel{}, "text"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := strings.Join(inputModalitiesFor(tc.model), ","); got != tc.want {
				t.Fatalf("modalities = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestThinkingSupportFollowsTheCatalogue covers the level vocabulary rules.
func TestThinkingSupportFollowsTheCatalogue(t *testing.T) {
	str := func(s string) *string { return &s }
	boolean := func(b bool) *bool { return &b }
	const full = "minimal,low,medium,high,xhigh,max"
	// think builds a model that supports reasoning with the given block.
	think := func(r *workBuddyReasoning) workBuddyModel {
		return workBuddyModel{SupportsReasoning: true, Reasoning: r}
	}

	cases := []struct {
		name, wantLevels  string
		model             workBuddyModel
		wantNil, wantZero bool
	}{
		{"no reasoning at all declares nothing", "", workBuddyModel{}, true, false},
		// supportedEfforts is the model's own enumeration, so it wins and keeps
		// its order.
		{"supportedEfforts is authoritative and ordered", "low,high,max",
			think(&workBuddyReasoning{SupportedEfforts: []string{"low", "high", "max"}}), false, true},
		{"a pinned effort is used when nothing is enumerated", "high",
			think(&workBuddyReasoning{Effort: str("high")}), false, true},
		{"defaultEffort is used when effort is absent", "low",
			think(&workBuddyReasoning{DefaultEffort: str("low")}), false, true},
		// Most catalogue entries enumerate nothing yet are reasoning models
		// reached through the same upstream-wide field.
		{"reasoning with no declared levels gets the vocabulary", full, think(nil), false, true},
		{"onlyReasoning with no block still gets the vocabulary", full,
			workBuddyModel{OnlyReasoning: true}, false, false},
		{"canDisableThinking=false is honoured", full,
			think(&workBuddyReasoning{CanDisableThinking: boolean(false)}), false, false},
		{"canDisableThinking=true is honoured", full,
			think(&workBuddyReasoning{CanDisableThinking: boolean(true)}), false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := thinkingSupportFor(tc.model)
			switch {
			case tc.wantNil:
				if got != nil {
					t.Fatalf("thinking = %+v, want nil", got)
				}
			case got == nil:
				t.Fatal("thinking = nil, want a declaration")
			case strings.Join(got.Levels, ",") != tc.wantLevels:
				t.Fatalf("levels = %v, want %s", got.Levels, tc.wantLevels)
			case got.ZeroAllowed != tc.wantZero:
				t.Fatalf("zeroAllowed = %v, want %v", got.ZeroAllowed, tc.wantZero)
			}
		})
	}
}

// TestParsedCatalogueCarriesCapabilities runs the real captured catalogues
// through the parser and the advertisement, so a field rename upstream shows up
// as a failed assertion rather than as a silently capability-less model list.
// It doubles as the end-to-end check of the advertised ModelInfo shape.
func TestParsedCatalogueCarriesCapabilities(t *testing.T) {
	// "none"/"auto" are legitimate catalogue values; a level the upstream would
	// reject must never be advertised, or the client will send it.
	acceptable := map[string]struct{}{
		"minimal": {}, "low": {}, "medium": {}, "high": {}, "xhigh": {}, "max": {},
		"none": {}, "auto": {},
	}
	for _, file := range []string{"testdata/models_cn.json", "testdata/models_ai.json"} {
		raw, errRead := os.ReadFile(file)
		if errRead != nil {
			t.Skipf("fixture unavailable: %v", errRead)
		}
		models, errParse := parseWorkBuddyModels(raw)
		if errParse != nil {
			t.Fatalf("%s: %v", file, errParse)
		}
		var sawImages, sawThinking, sawOutputLimit bool
		for _, m := range models {
			sawImages = sawImages || m.acceptsImages()
			sawThinking = sawThinking || m.SupportsReasoning || m.OnlyReasoning
			sawOutputLimit = sawOutputLimit || m.MaxOutputTokens > 0
			if m.Reasoning == nil { // some entries carry no reasoning block
				continue
			}
			for _, level := range m.Reasoning.SupportedEfforts {
				if _, ok := acceptable[level]; !ok {
					t.Errorf("%s: %s declares unexpected level %q", file, m.ID, level)
				}
			}
		}
		if !sawImages || !sawThinking || !sawOutputLimit {
			t.Errorf("%s: capabilities were not read (images=%v thinking=%v output=%v)",
				file, sawImages, sawThinking, sawOutputLimit)
		}
		for _, info := range modelsToInfo(models) {
			if len(info.SupportedInputModalities) == 0 {
				t.Errorf("%s: %s advertises no input modality", file, info.ID)
			}
			if info.OutputTokenLimit > 0 && info.MaxCompletionTokens != info.OutputTokenLimit {
				t.Errorf("%s: %s completion limit %d != output limit %d",
					file, info.ID, info.MaxCompletionTokens, info.OutputTokenLimit)
			}
		}
	}
}
