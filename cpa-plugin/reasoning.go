package main

import (
	"encoding/json"
	"strings"
)

// Thinking-parameter injection for outbound chat requests.
//
// The upstream honours a TOP-LEVEL snake_case "reasoning_effort" only. The
// OpenAI-SDK shape "reasoning": {"effort": ...} is accepted and then ignored:
// measured live, the same question returned 0 reasoning tokens nested and a
// non-zero reasoning_content top-level. A request carrying neither does not
// think at all, which drops the capability of every reasoning model in the
// catalogue — several are onlyReasoning, so "not thinking" is not even valid
// for them. CPA hands the client body to the plugin executor untranslated and
// the executor forwards it almost verbatim, so nothing in between adds it.
//
// Precedence, highest first, so an explicit client choice always wins:
//
//	1. top-level "reasoning_effort"      -> left exactly as is
//	2. "reasoning": {"effort": <level>}  -> converted to snake_case
//	3. explicit opt-out (reasoning false/null/"off"/"none",
//	   or reasoning.effort "off"/"none") -> inject nothing
//	4. otherwise                         -> the configured default
//
// Step 1 passes an invalid value through: the upstream is case-sensitive
// ("HIGH" -> 11150, a number -> 11101), so forwarding lets it name the problem
// instead of the plugin hiding the client's bug behind a working-looking
// request.

// defaultReasoningEffort is injected when neither the client nor the catalogue
// expressed a preference. "high", not the maximum: "max" makes a short request
// return an empty body with finish_reason=length, because the thinking pass
// spends the whole token budget before producing content. It is also the
// defaultEffort the upstream declares for the models that pin one.
const defaultReasoningEffort = "high"

// "none"/"auto" are legal upstream but deliberately absent below: they mean
// "do not think" and "let the upstream decide", i.e. the absence of a chosen
// level, so the opt-out and default branches handle them and the plugin never
// overwrites a deliberate "off" with a configured level.
var (
	validReasoningEfforts = map[string]struct{}{
		"minimal": {}, "low": {}, "medium": {}, "high": {}, "xhigh": {}, "max": {},
	}
	reasoningOffEfforts = map[string]struct{}{"off": {}, "none": {}}
)

func isValidReasoningEffort(level string) bool {
	_, ok := validReasoningEfforts[level]
	return ok
}

func isReasoningOffEffort(level string) bool {
	_, ok := reasoningOffEfforts[level]
	return ok
}

// normaliseReasoningEffort is only ever compared, never forwarded, so
// case-insensitivity costs nothing and keeps an operator's "High" in
// config.yaml from producing a request the upstream rejects with 11150.
func normaliseReasoningEffort(level string) string {
	return strings.ToLower(strings.TrimSpace(level))
}

// applyReasoningEffort returns body with the thinking level resolved. changed
// reports whether the caller must use the returned bytes; when false the input
// slice is returned untouched, keeping its field order. Idempotent.
func applyReasoningEffort(body []byte, defaultLevel string) (out []byte, changed bool) {
	if len(body) == 0 {
		return body, false
	}
	// RawMessage keeps every other field intact, including nested objects this
	// plugin knows nothing about; a typed struct would drop them. A body that is
	// not a JSON object is left for the upstream to report.
	var doc map[string]json.RawMessage
	if errUnmarshal := json.Unmarshal(body, &doc); errUnmarshal != nil {
		return body, false
	}
	if _, ok := doc["reasoning_effort"]; ok { // 1) already decided
		return body, false
	}
	if raw, ok := doc["reasoning"]; ok { // 2) and 3) the SDK shape
		level, optOut, hasLevel := nestedReasoningLevel(raw)
		switch {
		case optOut:
			return body, false
		case hasLevel:
			encoded, errMarshal := json.Marshal(level)
			if errMarshal != nil {
				return body, false
			}
			// Drop the nested key: the upstream ignores it, and leaving it is a
			// trap for the next reader.
			delete(doc, "reasoning")
			doc["reasoning_effort"] = encoded
			return marshalObject(doc, body)
		}
	}
	level := normaliseReasoningEffort(defaultLevel) // 4) the configured default
	if !isValidReasoningEffort(level) {
		return body, false
	}
	encoded, errMarshal := json.Marshal(level)
	if errMarshal != nil {
		return body, false
	}
	doc["reasoning_effort"] = encoded
	return marshalObject(doc, body)
}

// nestedReasoningLevel classifies a "reasoning" field: hasLevel means a usable
// effort to convert, optOut means "do not think" (change nothing at all), and
// neither means no preference, so the default applies. Telling "false" from an
// object without an effort is the point: reading the latter as an opt-out would
// stop the injection for a client that merely sends an empty reasoning object.
func nestedReasoningLevel(raw json.RawMessage) (level string, optOut bool, hasLevel bool) {
	switch strings.TrimSpace(string(raw)) {
	case "false", "null":
		return "", true, false
	}
	var asString string
	if errUnmarshal := json.Unmarshal(raw, &asString); errUnmarshal == nil {
		return "", isReasoningOffEffort(normaliseReasoningEffort(asString)), false
	}
	var nested struct {
		Effort *string `json:"effort"`
	}
	if errUnmarshal := json.Unmarshal(raw, &nested); errUnmarshal != nil || nested.Effort == nil {
		return "", false, false
	}
	if level = strings.TrimSpace(*nested.Effort); level == "" {
		return "", false, false // {"effort": ""} chooses nothing.
	}
	if isReasoningOffEffort(normaliseReasoningEffort(level)) {
		return "", true, false
	}
	return level, false, true
}

// marshalObject re-encodes a decoded body; json.Marshal sorts keys, keeping
// rewritten bodies stable in logs. fallback is returned unchanged if encoding
// fails, so a caller never gets a nil body.
func marshalObject(doc map[string]json.RawMessage, fallback []byte) ([]byte, bool) {
	out, errMarshal := json.Marshal(doc)
	if errMarshal != nil {
		return fallback, false
	}
	return out, true
}
