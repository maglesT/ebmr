/**
 * Canonical JSON as the database writes it (esig.canonical_json; the kernel's esig/canonical.ts): object keys sorted by
 * Unicode code point (UTF-8 byte order), no insignificant white space, strings escaped as JSON requires, numbers as
 * their exact text. The seal payload names the SHA-256 of the signature's manifestation in this form, so the viewer can
 * prove that the manifestation it shows is the one that was sealed.
 */
import { utf8Bytes } from './crypto.ts';
import { JsonNumber, type JsonValue } from './lossless-json.ts';

function compareCodePoints(a: string, b: string): number {
  const x = utf8Bytes(a);
  const y = utf8Bytes(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return x.length - y.length;
}

export function canonicalJson(v: JsonValue): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof JsonNumber) return v.raw;
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(',')}]`;
  const keys = [...v.keys()].sort(compareCodePoints);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v.get(k) as JsonValue)}`).join(',')}}`;
}
