/**
 * Codec of engine values for the execution store (module C3): reversible, jsonb-safe, and the state hash
 * survives the trip through JSON text (what the database stores and recomputes).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CodecError, decode, decodeState, encode, encodeState, hashJson, stateHash } from '../../src/engine/codec.ts';
import { autopilot, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, PACKAGING_SCENARIO, Run } from './support.ts';

const nasty = fc.constantFrom('', '$u', '$s', '~', '~x', '$', 'a\u0000b', '%', '%00', '%25', '\u0000', 'plain', 'Ω', ' ');
const key = fc.oneof(fc.string(), nasty);
const text = fc.oneof(fc.string(), nasty, fc.string({ unit: 'binary' }).map((s) => s.replace(/[\uD800-\uDFFF]/g, '')));

const value = fc.letrec<{ v: unknown }>((tie) => ({
  v: fc.oneof(
    { maxDepth: 4, depthIdentifier: 'codec' },
    fc.constant(null),
    fc.boolean(),
    fc.maxSafeInteger(),
    fc.bigInt(),
    text,
    fc.array(tie('v'), { maxLength: 4 }),
    fc.array(fc.tuple(key, tie('v')), { maxLength: 3 }).map((entries) => new Map(entries)),
    fc.dictionary(key, tie('v'), { maxKeys: 4 }),
  ),
}));

describe('execution codec', () => {
  it('[DI-34] decode(encode(x)) is x for any engine value: bigints, strings with U+0000, keys that look like tags', () => {
    fc.assert(
      fc.property(value.v, (v) => {
        const json = encode(v);
        // What the database stores is JSON text: the round trip must survive it too.
        const back = decode(JSON.parse(JSON.stringify(json)));
        expect(back).toEqual(v);
        expect(JSON.stringify(json)).not.toContain('\\u0000');
      }),
      { numRuns: 400 },
    );
  });

  it('[DI-34] data shaped like a tag is never mistaken for one', () => {
    const v = { $u: '12', nested: [{ $s: 'x' }], '~$u': 1n };
    expect(encode(v)).toEqual({ '~$u': '12', nested: [{ '~$s': 'x' }], '~~$u': { $u: '1' } });
    expect(decode(encode(v))).toEqual(v);
  });

  it('[INV-25] a JavaScript number that is not a safe integer is refused: GMP values travel as decimal strings', () => {
    expect(() => encode({ x: 0.1 })).toThrow(CodecError);
    expect(() => encode([2 ** 60])).toThrow(CodecError);
    expect(() => encode(Number.NaN)).toThrow(CodecError);
    expect(() => decode({ $u: '1.5' })).toThrow(CodecError);
    expect(() => decode({ $x: 1 })).toThrow(CodecError);
  });

  it('[DI-34] the state hash of both fixtures run to completion is stable through encode, JSON text and decode', () => {
    for (const [name, scenario] of [
      ['tablet-granulation-compression', GRANULATION_SCENARIO],
      ['tablet-blister-packaging', PACKAGING_SCENARIO],
    ] as const) {
      const def = fixtureDefinition(name);
      const run = Run.issue(def, { inputs: FIXTURE_INPUTS[name], ...(name === 'tablet-blister-packaging' ? { variants: { packDestination: 'US-EXPORT' } } : {}) });
      expect(autopilot(run, scenario)).toBe('COMPLETE');
      const h = stateHash(run.state);
      const text = JSON.stringify(encodeState(run.state));
      const back = decodeState(JSON.parse(text));
      expect(back).toEqual(run.state);
      // The token marking (Maps) is part of the state and of its hash.
      expect(back.marking.tokens.size).toBe(run.state.marking.tokens.size);
      expect(text).toContain('"$m"');
      expect(stateHash(back)).toBe(h);
      expect(hashJson(JSON.parse(text))).toBe(h);
      // The engine's NUL-prefixed bookkeeping key survives (jsonb cannot hold U+0000).
      expect(text).not.toContain('\\u0000');
    }
  });
});
