/**
 * Canonical JSON and content hashes on the TypeScript side (esig/canonical.ts): the text a client
 * hashes for the challenge must be exactly the text esig.canonical_json builds in SQL, so every value
 * has one canonical form or none at all (DI-37: what is signed is what was shown). signing.test.ts
 * compares this text with the database's; these tests pin the rules value type by value type, the
 * refusals with their stable code, and the content-version check of the envelope. No database.
 */
import { describe, expect, it } from 'vitest';
import { canonicalEnvelope, canonicalJson, compareCodePoints, contentHash, sha256Hex } from '../../src/esig/canonical.ts';
import { EsigError } from '../../src/esig/errors.ts';

/** The refusal canonicalJson or canonicalEnvelope throws: an EsigError with code EBMR-ESIG-004 and this message. */
function refusal(run: () => unknown): EsigError {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(EsigError);
    expect((e as EsigError).code).toBe('EBMR-ESIG-004');
    return e as EsigError;
  }
  throw new Error('expected a refusal');
}

describe('canonical JSON: scalars', () => {
  it('[DI-37] true and false are written as the JSON literals, alone and inside containers', () => {
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson([false, true])).toBe('[false,true]');
    expect(canonicalJson({ closed: false })).toBe('{"closed":false}');
  });

  it('[DI-37] strings are escaped as JSON requires and keep non-ASCII characters as they are', () => {
    expect(canonicalJson('12.503')).toBe('"12.503"');
    expect(canonicalJson('quote " backslash \\ nl \n tab \t ctl \u0001')).toBe('"quote \\" backslash \\\\ nl \\n tab \\t ctl \\u0001"');
    expect(canonicalJson('Granulación ✓')).toBe('"Granulación ✓"');
    expect(canonicalJson('')).toBe('""');
  });

  it('[DI-37] safe integers are written in decimal; bigints are written exactly, beyond the safe range too', () => {
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-42)).toBe('-42');
    expect(canonicalJson(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    expect(canonicalJson(12345678901234567890123n)).toBe('12345678901234567890123');
    expect(canonicalJson(-7n)).toBe('-7');
  });

  it('[DI-37] a decimal, an unsafe integer or a non-finite number is refused: GMP decimals travel as strings', () => {
    expect(refusal(() => canonicalJson(1.5)).message).toBe('EBMR-ESIG-004 1.5 is not canonical: send decimals and large numbers as strings');
    expect(refusal(() => canonicalJson(2 ** 53)).message).toBe('EBMR-ESIG-004 9007199254740992 is not canonical: send decimals and large numbers as strings');
    expect(refusal(() => canonicalJson(Number.NaN)).message).toBe('EBMR-ESIG-004 NaN is not canonical: send decimals and large numbers as strings');
    expect(refusal(() => canonicalJson({ q: [Number.POSITIVE_INFINITY] })).message).toBe(
      'EBMR-ESIG-004 Infinity is not canonical: send decimals and large numbers as strings',
    );
  });

  it('[DI-37] a value JSON cannot carry (undefined, a function, a symbol) has no canonical form and is refused, not dropped', () => {
    expect(refusal(() => canonicalJson(undefined)).message).toBe('EBMR-ESIG-004 a undefined has no canonical JSON form');
    expect(refusal(() => canonicalJson(() => 1)).message).toBe('EBMR-ESIG-004 a function has no canonical JSON form');
    expect(refusal(() => canonicalJson([Symbol('s')])).message).toBe('EBMR-ESIG-004 a symbol has no canonical JSON form');
    // An array position cannot be skipped the way an absent object member can.
    expect(refusal(() => canonicalJson(['a', undefined])).message).toBe('EBMR-ESIG-004 a undefined has no canonical JSON form');
  });
});

describe('canonical JSON: containers', () => {
  it('[DI-37] object members are sorted by key whatever the insertion order; arrays keep their order; no white space', () => {
    expect(canonicalJson({ b: '1', a: '2', c: ['z', 'y'] })).toBe('{"a":"2","b":"1","c":["z","y"]}');
    expect(canonicalJson({ c: null, a: { y: true, x: [] }, b: {} })).toBe('{"a":{"x":[],"y":true},"b":{},"c":null}');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson(null)).toBe('null');
  });

  it('[DI-37] an absent (undefined) member is left out, exactly as the stored JSON has no such member', () => {
    expect(canonicalJson({ a: '1', b: undefined })).toBe('{"a":"1"}');
    expect(canonicalJson({ b: undefined })).toBe('{}');
    expect(canonicalJson({ z: { y: undefined, x: '0' }, w: undefined })).toBe('{"z":{"x":"0"}}');
    expect(canonicalJson({ a: '1', b: undefined })).toBe(canonicalJson({ a: '1' }));
  });

  it('[DI-37] keys are ordered by Unicode code point (UTF-8 byte order, as COLLATE "C"), not by UTF-16 code unit', () => {
    // U+1F600 is above U+FFFD as a code point, but its first UTF-16 code unit (0xD83D) is below 0xFFFD.
    expect(compareCodePoints('😀', '�')).toBeGreaterThan(0);
    expect(compareCodePoints('�', '😀')).toBeLessThan(0);
    expect(compareCodePoints('B', 'a')).toBeLessThan(0);
    expect(compareCodePoints('é', 'z')).toBeGreaterThan(0);
    expect(compareCodePoints('ab', 'a')).toBeGreaterThan(0);
    expect(compareCodePoints('same', 'same')).toBe(0);
    expect(canonicalJson({ '😀': '2', '�': '1', z: '0', B: '-1' })).toBe('{"B":"-1","z":"0","�":"1","😀":"2"}');
  });
});

describe('content envelope and hash', () => {
  it('[DI-37] the envelope is the canonical text of aggregate type, id, content version (a number) and content', () => {
    expect(canonicalEnvelope('esig_stub', 'id-1', '1', { value: '12.503', unit: 'kg' })).toBe(
      '{"aggregate_id":"id-1","aggregate_type":"esig_stub","content":{"unit":"kg","value":"12.503"},"content_version":1}',
    );
    expect(canonicalEnvelope('t', 'i', '10', {})).toBe('{"aggregate_id":"i","aggregate_type":"t","content":{},"content_version":10}');
    expect(canonicalEnvelope('t', 'i', '90071992547409930', {})).toBe('{"aggregate_id":"i","aggregate_type":"t","content":{},"content_version":90071992547409930}');
  });

  it('[DI-37] a content version that is not a positive decimal integer is refused before anything is hashed', () => {
    for (const version of ['0', '01', '-1', '+1', '1.0', '1e3', '1a', 'a1', '12 ', ' 12', '1\n', '']) {
      expect(refusal(() => canonicalEnvelope('t', 'i', version, {})).message).toBe(`EBMR-ESIG-004 content version ${version} is not a positive integer`);
    }
  });

  it('[DI-37] the content hash is the SHA-256 of the UTF-8 text, in lower-case hex', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    // 'é' as UTF-8 (C3 A9), not as Latin-1 (E9).
    expect(contentHash('é')).toBe('4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
    expect(contentHash(canonicalEnvelope('t', 'i', '1', { a: '1' }))).toBe(sha256Hex('{"aggregate_id":"i","aggregate_type":"t","content":{"a":"1"},"content_version":1}'));
  });
});
