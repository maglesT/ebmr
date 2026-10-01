/**
 * Canonical JSON and content hashes (outline 5.5 step 1; DI-37).
 *
 * The same rules as esig.canonical_json in SQL: object keys sorted by Unicode code point (UTF-8
 * byte order), no insignificant white space, strings escaped as JSON requires. GMP decimals travel
 * as strings; only safe integers are accepted as numbers, so a client can never produce a
 * different text for the same value. The content hash is SHA-256 of the canonical envelope
 * {aggregate_type, aggregate_id, content_version, content}.
 *
 * A client normally hashes the canonical text the server returned (esig.content_for_signing) and
 * that it rendered; canonicalJson lets modules and tests build the same text themselves.
 */
import { createHash } from 'node:crypto';
import { EsigError } from './errors.ts';

/** Orders strings by Unicode code point, as PostgreSQL's COLLATE "C" orders UTF-8 text. */
export function compareCodePoints(a: string, b: string): number {
  // Stryker disable next-line StringLiteral: equivalent; Buffer.from reads a string with an empty encoding name in its default encoding, utf8, so '' yields the same bytes as 'utf8'
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    // Stryker disable next-line ConditionalExpression: equivalent; without this case a boolean falls through to the string case, where JSON.stringify writes true and false exactly as this case does
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      return value.toString();
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new EsigError('EBMR-ESIG-004', `${value} is not canonical: send decimals and large numbers as strings`);
      }
      return String(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
      entries.sort(([a], [b]) => compareCodePoints(a, b));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new EsigError('EBMR-ESIG-004', `a ${typeof value} has no canonical JSON form`);
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The canonical envelope text a content hash is computed over. `contentVersion` is a decimal string. */
export function canonicalEnvelope(aggregateType: string, aggregateId: string, contentVersion: string, content: Record<string, unknown>): string {
  if (!/^[1-9][0-9]*$/.test(contentVersion)) throw new EsigError('EBMR-ESIG-004', `content version ${contentVersion} is not a positive integer`);
  return canonicalJson({ aggregate_type: aggregateType, aggregate_id: aggregateId, content_version: BigInt(contentVersion), content });
}

/** SHA-256 (hex) of canonical text: what the client sends with its challenge request. */
export function contentHash(canonicalText: string): string {
  return sha256Hex(canonicalText);
}
