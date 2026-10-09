/**
 * Canonical JSON and SHA-256 for evaluation records, identical in Node and the browser.
 *
 * canonicalJson follows the kernel's rules (packages/kernel/src/esig/canonical.ts; expr may not
 * import the kernel): object keys sorted by Unicode code point, no insignificant white space,
 * strings escaped as JSON requires, only safe integers as numbers (decimals travel as strings),
 * bigints as integers, undefined object members omitted. Text no record can hold (U+0000, or a
 * UTF-16 surrogate without its other half) has no canonical form and is refused, in a string or a
 * member name: esig.canonical_json can never receive it (jsonb refuses both), so no client hashes
 * content the server cannot store (review F31). SHA-256 is implemented here in plain TypeScript
 * (FIPS 180-4) so hashing is synchronous and needs neither node:crypto nor WebCrypto; the tests
 * compare it with node:crypto.
 */

export class CanonicalJsonError extends Error {}

/** Refused text (U+0000, an unpaired surrogate): the value came from outside, so this is bad input, never a programming error. */
export class UnstorableTextError extends CanonicalJsonError {}

/**
 * U+0000, or a UTF-16 surrogate without its other half: PostgreSQL text and jsonb refuse U+0000, jsonb refuses the
 * escape of a lone surrogate, and UTF-8 encoding (node-postgres, TextEncoder, a browser's fetch) silently writes U+FFFD
 * in its place, so a record would hold a character nobody sent.
 */
// eslint-disable-next-line no-control-regex -- U+0000 is looked for on purpose.
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Null when a record can hold `text`; otherwise the first character no record can hold, named for a person:
 * "U+0000" or "an unpaired surrogate U+D83D".
 */
export function unstorableText(text: string): string | null {
  const m = UNSTORABLE.exec(text);
  if (m === null) return null;
  const unit = m[0].charCodeAt(m[0].length - 1);
  return unit === 0 ? 'U+0000' : `an unpaired surrogate U+${unit.toString(16).toUpperCase()}`;
}

/** A string or member name as canonical JSON, or UnstorableTextError for text no record can hold. */
function jsonString(text: string): string {
  const problem = unstorableText(text);
  if (problem !== null) throw new UnstorableTextError(`text holding ${problem} has no canonical JSON form: no record can hold it`);
  return JSON.stringify(text);
}

/** Orders strings by Unicode code point (= UTF-8 byte order = PostgreSQL COLLATE "C"). */
export function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const p = x[i]?.codePointAt(0) ?? 0;
    const q = y[i]?.codePointAt(0) ?? 0;
    if (p !== q) return p < q ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return jsonString(value);
    case 'bigint':
      return value.toString();
    case 'number':
      if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(`${String(value)} is not canonical: decimals and large numbers travel as strings`);
      return String(value);
    case 'object': {
      // Array.from reads a hole as undefined, which has no canonical form: [,1] is refused, never written "[,1]".
      if (Array.isArray(value)) return `[${Array.from(value, (v) => canonicalJson(v)).join(',')}]`;
      // Plain data only: a Date, Map, Set, typed array or class instance would be written as {} or as some of its
      // fields, so two different values would have one text and one hash.
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError(`a ${(proto as { constructor?: { name?: string } }).constructor?.name ?? 'object'} has no canonical JSON form`);
      }
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
      entries.sort(([a], [b]) => compareCodePoints(a, b));
      return `{${entries.map(([k, v]) => `${jsonString(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`a ${typeof value} has no canonical JSON form`);
  }
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** SHA-256 of the UTF-8 encoding of `text`, as lower-case hex. */
export function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text);
  const bitLength = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15] ?? 0;
      const b = w[i - 2] ?? 0;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = ((h[0] ?? 0) + a) >>> 0;
    h[1] = ((h[1] ?? 0) + b) >>> 0;
    h[2] = ((h[2] ?? 0) + c) >>> 0;
    h[3] = ((h[3] ?? 0) + d) >>> 0;
    h[4] = ((h[4] ?? 0) + e) >>> 0;
    h[5] = ((h[5] ?? 0) + f) >>> 0;
    h[6] = ((h[6] ?? 0) + g) >>> 0;
    h[7] = ((h[7] ?? 0) + hh) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** SHA-256 of the canonical JSON of a value. */
export function contentHashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
