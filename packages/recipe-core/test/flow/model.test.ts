import { esig } from '@ebmr/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, libraryElementHash, mbrContentHash } from '../../src/flow/canonical.ts';
import { MAX_FLOW_DEPTH, parseFlowNodeStandalone, parseMbr } from '../../src/flow/parse.ts';
import { clone, fixtureJson, loadFixture, type FixtureName } from './support.ts';

const FIXTURES: FixtureName[] = ['tablet-granulation-compression', 'tablet-blister-packaging'];

describe('MBR content model: parsing', () => {
  it.each(FIXTURES)('[PR-03] the %s fixture parses into the typed model', (name) => {
    const r = parseMbr(fixtureJson(name));
    expect(r.ok ? [] : r.problems).toEqual([]);
  });

  it('[PR-03] parsing is lossless: the parsed content serialises back to the same JSON', () => {
    for (const name of FIXTURES) {
      const json = fixtureJson(name);
      const r = parseMbr(json);
      if (!r.ok) throw new Error('fixture does not parse');
      expect(canonicalJson(r.mbr)).toBe(canonicalJson(json));
    }
  });

  it('[PR-08] a GMP value sent as a JSON number is refused (decimals travel as strings)', () => {
    const json = clone(fixtureJson('tablet-granulation-compression')) as { parameters: { limits?: { ranges: { high?: { value: unknown } }[] } }[] };
    const lod = json.parameters.find((p) => p.limits !== undefined);
    const high = lod?.limits?.ranges[0]?.high;
    if (!high) throw new Error('fixture changed');
    high.value = 3.5;
    const r = parseMbr(json);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.some((p) => p.message.includes('GMP values travel as decimal strings'))).toBe(true);
  });

  it('[PR-03] unknown fields are refused, so nothing unhashed or unvalidated can hide in the content', () => {
    const json = clone(fixtureJson('tablet-blister-packaging')) as Record<string, unknown>;
    json['hiddenField'] = 'x';
    const r = parseMbr(json);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems).toContainEqual({ path: '$.hiddenField', message: 'is not a known field (unknown fields are refused)' });
  });

  it('[INV-19] a loop without a maximum, or with a maximum above 100, is refused', () => {
    const json = clone(fixtureJson('tablet-granulation-compression'));
    const text = JSON.stringify(json).replace('"maxIterations":5', '"maxIterations":0');
    const r = parseMbr(JSON.parse(text));
    expect(r.ok).toBe(false);
    const text2 = JSON.stringify(json).replace('"maxIterations":5,', '');
    const r2 = parseMbr(JSON.parse(text2));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.problems.some((p) => p.path.endsWith('.maxIterations') && p.message === 'is required')).toBe(true);
  });

  it('[DI-34] an operator choice or a run-time instance count must always require a reason', () => {
    const json: unknown = JSON.parse(JSON.stringify(fixtureJson('tablet-granulation-compression')).replaceAll('"reasonRequired":true', '"reasonRequired":false'));
    const r = parseMbr(json);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.filter((p) => p.path.endsWith('.reasonRequired')).length).toBe(2);
  });

  it('a flow nested deeper than the limit is refused instead of exhausting the parser', () => {
    let node: unknown = { kind: 'holdPoint', id: 'H', name: 'Hold', role: 'QA', dispositions: ['OK'] };
    for (let i = 0; i < MAX_FLOW_DEPTH + 5; i++) node = { kind: 'sequence', id: `s${i}`, children: [node] };
    const r = parseFlowNodeStandalone(node);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.some((p) => p.message === `nests flow nodes more than ${MAX_FLOW_DEPTH} deep`)).toBe(true);
  });

  it('[DI-04][IN-02] content holding U+0000 or a lone surrogate is refused with the path of each place, so the designer points at it (review F32)', () => {
    const json = clone(fixtureJson('tablet-blister-packaging')) as { procedure: { name: string }; parameters: { name: string }[]; header?: Record<string, unknown> };
    json.procedure.name = 'Blister\u0000 packaging';
    const first = json.parameters[0];
    if (!first) throw new Error('fixture changed');
    first.name = 'Seal temperature \uD800';
    (json as Record<string, unknown>)['extra\uDC00'] = 'x';
    const r = parseMbr(json);
    expect(r.ok ? [] : r.problems).toEqual([
      { path: '$', message: 'has a field name holding an unpaired surrogate U+DC00, which no record can hold' },
      { path: '$.parameters[0].name', message: 'holds an unpaired surrogate U+D800, which no record can hold' },
      { path: '$.procedure.name', message: 'holds U+0000, which no record can hold' },
    ]);
    // A node parsed on its own (the designer's palette) is checked the same way.
    const node = parseFlowNodeStandalone({ kind: 'holdPoint', id: 'H', name: 'Hold\u0000', role: 'QA', dispositions: ['OK'] });
    expect(node.ok ? [] : node.problems).toEqual([{ path: '$.name', message: 'holds U+0000, which no record can hold' }]);
    // Text a record can hold, however unusual, parses as before.
    const fine = clone(fixtureJson('tablet-blister-packaging')) as { procedure: { name: string } };
    fine.procedure.name = 'Blister packaging मिश्रण 😀 \uFFFD \u0001 e\u0301';
    expect(parseMbr(fine).ok).toBe(true);
  });

  it('every problem names the JSON path of the offending field', () => {
    const r = parseMbr({ format: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems[0]?.path).toMatch(/^\$/);
      expect(r.problems.map((p) => p.path)).toContain('$.format');
      expect(r.problems.map((p) => p.path)).toContain('$.procedure');
    }
  });
});

describe('MBR content model: canonical JSON and content hash', () => {
  it('[DI-04] the content hash uses the kernel e-signature canonical JSON rules and SHA-256', () => {
    const mbr = loadFixture('tablet-granulation-compression');
    expect(mbrContentHash(mbr)).toBe(esig.sha256Hex(esig.canonicalJson(mbr)));
    expect(mbrContentHash(mbr)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('[DI-04] the hash does not depend on key order but changes with any edit', () => {
    const mbr = loadFixture('tablet-blister-packaging');
    const reordered = JSON.parse(JSON.stringify(mbr, Object.keys(mbr).reverse())) as typeof mbr;
    expect(mbrContentHash({ ...reordered, ...mbr })).toBe(mbrContentHash(mbr));
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (title) => {
        const edited = clone(mbr);
        edited.header.title = `${mbr.header.title}${title}`;
        return mbrContentHash(edited) !== mbrContentHash(mbr);
      }),
      { numRuns: 50 },
    );
  });

  it('[DI-04] the embedded library element matches its pinned hash', () => {
    const mbr = loadFixture('tablet-granulation-compression');
    const element = mbr.library[0];
    const ref = mbr.references.find((r) => r.id === element?.ref);
    expect(element && libraryElementHash(element)).toBe(ref?.hash);
  });
});
