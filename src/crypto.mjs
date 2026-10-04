// WorkBuddy at-rest 加密（sym-v1）复刻。
//
// 还原自 D:\workbuddy\resources\app.asar!main/process-cpu-sampler.js 里的
// AtRestCrypto + buildAuthenticatedContextAad；只实现字段级（framing=field）与
// 整文件级（framing=file）两种对称信封，够用于读取/回写会话文件。
//
// 关键点：AAD 不是随便的字符串，而是按固定 TLV 拼出来的，任何一个字节不同都解不开。
import crypto from 'node:crypto';

const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii');
// 上面是 7 字节（含结尾的 \0），对应源码 Buffer.from("WB-AAD\0", "ascii")
const FRAMING_CODE = { file: 1, field: 2, record: 3, stream: 4 };
const STANDARD_FORMAT_ID = { file: 'WBEF1', field: 'WBEV1', record: 'WBER1', stream: 'WBES1' };
const SCHEME = 'sym-v1';

const u32 = (n) => {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n);
  return b;
};
const lenPrefixed = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([u32(b.length), b]);
};

/** at-rest keyId = sha256(key) 的前 16 个 hex 字符。 */
export function keyIdOf(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * 静态密钥派生：源码 normalizeAtRestKeyPayload()
 *   key = sha256(atRestSecretKey 字符串的 utf8 字节)
 * 注意不是 base64 解码后再 hash，而是把 base64 文本本身当输入。
 */
export function keyFromSecret(atRestSecretKey) {
  return crypto.createHash('sha256').update(atRestSecretKey, 'utf8').digest();
}

/** 复刻 buildAuthenticatedContextAad(keyId, suite, context, 'sym-v1')。 */
function buildAad(keyId, suite, context) {
  if (!/^[0-9a-f]{16}$/.test(keyId)) throw new TypeError('keyId 必须是 16 位小写 hex');
  const { framing } = context;
  if (!(framing in FRAMING_CODE)) throw new TypeError(`不支持的 framing: ${framing}`);
  if (framing === 'record' || framing === 'stream') throw new TypeError('本实现只覆盖 file / field');
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]), // TLV 版本
    lenPrefixed(STANDARD_FORMAT_ID[framing]),
    lenPrefixed(SCHEME),
    u32(suite),
    lenPrefixed(keyId),
    Buffer.from([FRAMING_CODE[framing]]),
    Buffer.from([0]), // context.sequence 缺省
    Buffer.from([0]), // context.final 缺省
  ]);
}

/** 解一个信封对象 {suite,keyId,nonce,authTag,ciphertext}。 */
export function openEnvelope(key, envelope, context) {
  const keyId = keyIdOf(key);
  if (envelope.keyId !== keyId) {
    throw new Error(`keyId 不匹配：信封 ${envelope.keyId} vs 密钥 ${keyId}`);
  }
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'), { authTagLength: 16 });
  d.setAAD(buildAad(envelope.keyId, envelope.suite, context));
  d.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(envelope.ciphertext, 'base64')), d.final()]);
}

/** 封一个信封，返回与源码一致的 JSON 字符串 Buffer。 */
export function sealEnvelope(key, plaintext, context) {
  const keyId = keyIdOf(key);
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  c.setAAD(buildAad(keyId, 1, context));
  const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.from(
    JSON.stringify({
      suite: 1,
      keyId,
      nonce: nonce.toString('base64'),
      authTag: c.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }),
    'utf8',
  );
}

/** 字段级（$wbEncrypted 包装）解密。 */
export function openField(key, wrapper) {
  if (!wrapper || wrapper.$wbEncrypted !== 1 || typeof wrapper.envelope !== 'string') {
    throw new Error('不是标准字段信封');
  }
  const json = Buffer.from(wrapper.envelope, 'base64');
  if (json.toString('base64') !== wrapper.envelope) throw new Error('envelope 不是规范 base64');
  return openEnvelope(key, JSON.parse(json.toString('utf8')), { framing: 'field' });
}

/** 字段级加密，产出 { $wbEncrypted: 1, envelope } 包装。 */
export function sealField(key, plaintext) {
  const sealed = sealEnvelope(key, Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8'), { framing: 'field' });
  return { $wbEncrypted: 1, envelope: sealed.toString('base64') };
}

/** 整文件级解密（keyblob 的 static-v1 槽就是这种）。 */
export function openFileEnvelope(key, envelope) {
  return openEnvelope(key, envelope, { framing: 'file' });
}

export function isFieldWrapper(v) {
  return !!v && typeof v === 'object' && v.$wbEncrypted === 1 && typeof v.envelope === 'string';
}
