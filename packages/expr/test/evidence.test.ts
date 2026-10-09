/**
 * Evidence (brief A1 item 7; DI-33 behaviour and catalog test; INV-25).
 *
 * DI-33 catalog test: "The yield step shows inputs, formula version, result and a verification
 * signature. Correct an input and recalculate. Both results are kept, with their reasons."
 * Covered here: inputs, formula version, result, correction and recalculation with both results
 * kept and their reasons. The verification signature and the stored result history are the
 * engine's (Phase 3: kernel e-signatures and the execution records).
 */
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJson, compareCodePoints, contentHashOf, sha256Hex, unstorableText, UnstorableTextError } from '../src/evidence/hash.ts';
import { evaluate, inputsFromRecord, recalculate, verifyEvaluationRecord } from '../src/evidence/record.ts';
import type { EvaluationRecord } from '../src/evidence/record-types.ts';
import { compile } from '../src/lang/compile.ts';
import type { InputValues } from '../src/lang/evaluator.ts';
import { EXPR_LANGUAGE_VERSION } from '../src/version.ts';

function yieldStep() {
  const r = compile('yield(good + residue, theoretical)', {
    name: 'granulation_yield',
    inputs: {
      good: { unit: 'kg', source: 'DEVICE', description: 'dried granules (K-22 weighing)' },
      residue: { unit: 'kg', source: 'DEVICE', description: 'reusable residue' },
      theoretical: { unit: 'kg', source: 'CAPTURED', description: 'theoretical mass (C-07)' },
    },
    output: { unit: '%', tag: 'yield' },
  });
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join('; '));
  return r.program;
}

const INPUTS: InputValues = {
  good: { value: '50.300', unit: 'kg', source: 'batch 24A017 / step 12 / balance BAL-07 reading 3' },
  residue: { value: '350', unit: 'g', source: 'batch 24A017 / step 12 / balance BAL-02 reading 1' },
  theoretical: { value: '51.200', unit: 'kg', source: 'batch 24A017 / step 11 / entry 4' },
};

describe('evaluation record', () => {
  it('[DI-33] the yield step result shows its inputs with units and sources, the formula version and the result', () => {
    const program = yieldStep();
    const r = evaluate(program, INPUTS);
    expect(r).toMatchObject({
      schema: 'ebmr.expr.evaluation/1',
      languageVersion: EXPR_LANGUAGE_VERSION,
      calculation: 'granulation_yield',
      expression: 'yield(good + residue, theoretical)',
      canonical: 'yield(good + residue, theoretical)',
      programHash: program.programHash,
      unitTable: { version: '1', ucumLhc: '7.1.9' },
      output: { kind: 'quantity', value: '98.92578125', unit: '%', tag: 'yield' },
    });
    expect(r.inputs).toEqual([
      { path: 'good', kind: 'quantity', source: 'batch 24A017 / step 12 / balance BAL-07 reading 3', value: '50.3', unit: 'kg' },
      { path: 'residue', kind: 'quantity', source: 'batch 24A017 / step 12 / balance BAL-02 reading 1', value: '350', unit: 'g' },
      { path: 'theoretical', kind: 'quantity', source: 'batch 24A017 / step 11 / entry 4', value: '51.2', unit: 'kg' },
    ]);
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('[DI-33] the record stores every unit conversion with its exact factor', () => {
    const r = evaluate(yieldStep(), INPUTS);
    expect(r.conversions).toEqual([{ at: 'input residue', from: 'g', to: 'kg', factor: '0.001', exact: true }]);
  });

  it('[DI-33] the record is immutable and its content hash covers every field', () => {
    const r = evaluate(yieldStep(), INPUTS);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.output)).toBe(true);
    expect(() => {
      (r.output as { value: string }).value = '100';
    }).toThrow(TypeError);
    const { contentHash, ...body } = r;
    expect(contentHashOf(body)).toBe(contentHash);
    expect(evaluate(yieldStep(), INPUTS).contentHash).toBe(contentHash);
  });

  it('[DI-33] the program hash changes when the formula, a declaration or the output changes', () => {
    const base = yieldStep().programHash;
    const other = compile('yield(good, theoretical)', { inputs: { good: { unit: 'kg' }, theoretical: { unit: 'kg' } }, output: { unit: '%', tag: 'yield' } });
    const other2 = compile('yield(good + residue, theoretical)', { inputs: { good: { unit: 'kg' }, residue: { unit: 'kg' }, theoretical: { unit: 'g' } }, output: { unit: '%', tag: 'yield' } });
    expect(other.ok && other.program.programHash).not.toBe(base);
    expect(other2.ok && other2.program.programHash).not.toBe(base);
  });
});

describe('verification: derived values are computed, never typed (INV-25)', () => {
  it('[INV-25][DI-33] a stored result recomputes identically from its recorded inputs', () => {
    const program = yieldStep();
    const r = evaluate(program, INPUTS);
    expect(verifyEvaluationRecord(program, r)).toEqual({ ok: true, problems: [] });
  });

  it('[INV-25] a result typed over the computed one is detected, even with a recomputed hash', () => {
    const program = yieldStep();
    const r = evaluate(program, INPUTS);
    const typed = { ...r, output: { ...r.output, value: '99.5' } };
    const body = Object.fromEntries(Object.entries(typed).filter(([k]) => k !== 'contentHash'));
    const rehashed: EvaluationRecord = { ...typed, contentHash: contentHashOf(body) };
    const v1 = verifyEvaluationRecord(program, typed);
    expect(v1.ok).toBe(false);
    expect(v1.problems[0]).toMatch(/changed after it was computed/);
    const v2 = verifyEvaluationRecord(program, rehashed);
    expect(v2.ok).toBe(false);
    expect(v2.problems.join(' ')).toMatch(/recorded result 99.5 % differs from the recomputed 98.92578125 %: a derived value must be computed, never typed \(INV-25\)/);
  });

  it('[INV-25] a record from another version of the calculation does not verify against this one', () => {
    const r = evaluate(yieldStep(), INPUTS);
    const other = compile('yield(good + residue, theoretical) * 1', { inputs: yieldStep().inputs, output: { unit: '%', tag: 'yield' } });
    if (!other.ok) throw new Error('compile');
    expect(verifyEvaluationRecord(other.program, r).problems[0]).toMatch(/not computed by this version/);
  });

  it('[INV-25] records that read derived values verify only with the records they were computed from', () => {
    const t = compile('sum(parts)', { name: 'theoretical', inputs: { parts: { kind: 'series', unit: 'kg', maxLength: 5 } } });
    const y = compile('yield(good, theoretical)', { name: 'y', inputs: { good: { unit: 'kg' }, theoretical: { unit: 'kg', source: 'DERIVED' } }, output: { unit: '%', tag: 'yield' } });
    if (!t.ok || !y.ok) throw new Error('compile');
    const tr = evaluate(t.program, { parts: { values: ['50', '1.2'], source: 'x' } });
    const yr = evaluate(y.program, { good: { value: '50.3', source: 'x' }, theoretical: { derived: tr } });
    expect(verifyEvaluationRecord(y.program, yr).problems[0]).toMatch(/computed inputs theoretical were not supplied/);
    expect(verifyEvaluationRecord(y.program, yr, { derived: { [tr.contentHash]: tr } })).toEqual({ ok: true, problems: [] });
    expect(inputsFromRecord(yr, { [tr.contentHash]: tr })['theoretical']).toEqual({ derived: tr });
  });
});

describe('correction and recalculation (DI-33 catalog test)', () => {
  it('[DI-33] correct an input and recalculate: both results are kept, the new one names the old one, the reason and the correction', () => {
    const program = yieldStep();
    const first = evaluate(program, INPUTS);
    const history: EvaluationRecord[] = [first];
    const corrected = { ...INPUTS, good: { value: '50.030', unit: 'kg', source: 'batch 24A017 / step 12 / correction 1 of reading 3 (transcription error)' } };
    const second = recalculate(program, first, corrected, 'Transcription error: balance printout shows 50.030 kg (deviation DV-0012)');
    history.push(second);
    expect(history).toHaveLength(2);
    expect(history[0]).toBe(first);
    expect(first.output.value).toBe('98.92578125');
    expect(second.output.value).toBe('98.3984375');
    expect(second.supersedes).toEqual({
      contentHash: first.contentHash,
      reason: 'Transcription error: balance printout shows 50.030 kg (deviation DV-0012)',
      corrections: [
        {
          path: 'good',
          previous: { path: 'good', kind: 'quantity', source: 'batch 24A017 / step 12 / balance BAL-07 reading 3', value: '50.3', unit: 'kg' },
          corrected: { path: 'good', kind: 'quantity', source: 'batch 24A017 / step 12 / correction 1 of reading 3 (transcription error)', value: '50.03', unit: 'kg' },
        },
      ],
    });
    // Both records still verify on their own: the earlier one was never changed.
    expect(verifyEvaluationRecord(program, first).ok).toBe(true);
    expect(verifyEvaluationRecord(program, second).ok).toBe(true);
    expect(second.contentHash).not.toBe(first.contentHash);
  });

  it('[DI-33] a recalculation needs a reason, a changed input and the same formula version', () => {
    const program = yieldStep();
    const first = evaluate(program, INPUTS);
    expect(() => recalculate(program, first, { ...INPUTS, good: { value: '50', source: 'x' } }, '  ')).toThrow(/needs a reason/);
    expect(() => recalculate(program, first, INPUTS, 'no change')).toThrow(/No input changed/);
    const other = compile('yield(good + residue, theoretical) * 1', { inputs: program.inputs, output: { unit: '%', tag: 'yield' } });
    if (!other.ok) throw new Error('compile');
    expect(() => recalculate(other.program, first, { ...INPUTS, good: { value: '50', source: 'x' } }, 'x')).toThrow(/another version of the calculation/);
    const tampered = { ...first, output: { ...first.output, value: '1' } };
    expect(() => recalculate(program, tampered, { ...INPUTS, good: { value: '50', source: 'x' } }, 'x')).toThrow(/does not verify/);
  });
});

describe('canonical JSON and SHA-256 (identical in Node and the browser)', () => {
  it('SHA-256 matches node:crypto on known and random texts', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    fc.assert(
      fc.property(fc.string({ maxLength: 300, unit: 'grapheme' }), (t) => {
        expect(sha256Hex(t)).toBe(createHash('sha256').update(t, 'utf8').digest('hex'));
      }),
      { numRuns: 300 },
    );
    const long = 'x'.repeat(1000);
    expect(sha256Hex(long)).toBe(createHash('sha256').update(long, 'utf8').digest('hex'));
  });

  it('follows the kernel canonical-JSON rules: code-point key order, no spaces, decimals as strings', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(canonicalJson({ '\u{1F600}': 1, '￿': 2 })).toBe('{"￿":2,"\u{1F600}":1}');
    expect(compareCodePoints('￿', '\u{1F600}')).toBe(-1);
    expect(canonicalJson(12345678901234567890n)).toBe('12345678901234567890');
    expect(() => canonicalJson({ x: 0.1 })).toThrow(/decimals and large numbers travel as strings/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
  });

  it('refuses what is not plain data (a Date, Map, Set, typed array, class instance, array hole) instead of writing {} or an empty position', () => {
    const refused = (value: unknown, message: string) => {
      expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
      expect(() => canonicalJson(value)).toThrow(message);
    };
    refused(new Date(0), 'a Date has no canonical JSON form');
    refused({ m: new Map([['a', '1']]) }, 'a Map has no canonical JSON form');
    refused([new Set(['a'])], 'a Set has no canonical JSON form');
    refused(new Uint8Array([1]), 'a Uint8Array has no canonical JSON form');
    class Quantity {
      constructor(readonly value: string) {}
    }
    refused(new Quantity('1.0'), 'a Quantity has no canonical JSON form');
    refused(Object.create(Object.create(null) as object), 'a object has no canonical JSON form');
    const holey = ['a'];
    holey[2] = 'c';
    refused(holey, 'a undefined has no canonical JSON form');
    // An object without a prototype (a parsed query string, a dictionary) is plain data.
    expect(canonicalJson(Object.assign(Object.create(null) as object, { b: '2', a: '1' }))).toBe('{"a":"1","b":"2"}');
  });

  it('[DI-37] names the first character no record can hold (U+0000, a surrogate without its other half); well-formed text has none', () => {
    expect(unstorableText('Booth door\u0000 found open')).toBe('U+0000');
    expect(unstorableText('\u0000')).toBe('U+0000');
    expect(unstorableText('a\uD800b')).toBe('an unpaired surrogate U+D800');
    expect(unstorableText('Line stop \uDBFF')).toBe('an unpaired surrogate U+DBFF');
    expect(unstorableText('\uDC00 first')).toBe('an unpaired surrogate U+DC00');
    expect(unstorableText('x\uDFFF')).toBe('an unpaired surrogate U+DFFF');
    expect(unstorableText('\uD83D\uD83D\uDE00')).toBe('an unpaired surrogate U+D83D');
    expect(unstorableText('\uD83D\uDE00\uDE00')).toBe('an unpaired surrogate U+DE00');
    expect(unstorableText('\uDE00\uD83D')).toBe('an unpaired surrogate U+DE00');
    expect(unstorableText('a\uDC00\u0000')).toBe('an unpaired surrogate U+DC00');
    expect(unstorableText('a\u0000\uDC00')).toBe('U+0000');
    for (const ok of ['', 'plain', '\u0001\u001f\u007f', '\uD7FF\uE000\uFFFD\uFFFF', '\u{1F600}\u{10000}\u{10FFFF}', 'मिश्रण 👩🏽‍🔬 é', '%00 \\u0000']) {
      expect(unstorableText(ok), JSON.stringify(ok)).toBeNull();
    }
  });

  it('[DI-37] text no record can hold has no canonical form: refused in a string or a member name, at any depth (review F31)', () => {
    const refused = (value: unknown, what: string) => {
      expect(() => canonicalJson(value)).toThrow(UnstorableTextError);
      expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
      expect(() => canonicalJson(value)).toThrow(`text holding ${what} has no canonical JSON form: no record can hold it`);
      expect(() => contentHashOf(value)).toThrow(UnstorableTextError);
    };
    refused('Reprinted\u0000 label checked', 'U+0000');
    refused({ ['k\u0000']: '1' }, 'U+0000');
    refused({ step: { frames: [{ name: 'Booth clearance \uD800' }] } }, 'an unpaired surrogate U+D800');
    refused(['ok', 'Room humidity is in the room log \uDBFF.'], 'an unpaired surrogate U+DBFF');
    // The key order the kernel and expr used to disagree on: no such key has a canonical form now.
    refused({ ['\uE000']: 1, ['\uD800']: 2 }, 'an unpaired surrogate U+D800');
    // Not bad input: the refusals of non-plain data stay plain CanonicalJsonErrors.
    expect(() => canonicalJson(new Date(0))).not.toThrow(UnstorableTextError);
    expect(canonicalJson({ ['\u{1F600}']: '\uD800\uDC00', a: '\uFFFD' })).toBe('{"a":"\uFFFD","\u{1F600}":"\u{10000}"}');
  });
});
