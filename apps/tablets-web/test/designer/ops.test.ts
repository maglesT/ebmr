/**
 * The designer's pure edit operations (module C2; plan section 13: "designer edit operations keep parseMbr ok and
 * ids unique"). Property tests over random operation sequences on the shared tablet fixtures, plus undo and redo.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { unstorableText } from '@ebmr/expr';
import { flow, limits } from '@ebmr/recipe-core/pure';
import granulation from '../../../../packages/recipe-core/test/fixtures/tablet-granulation-compression.mbr.json' with { type: 'json' };
import packaging from '../../../../packages/recipe-core/test/fixtures/tablet-blister-packaging.mbr.json' with { type: 'json' };
import { applyOp, canRedo, canUndo, initHistory, insertionPoint, locate, newStep, OpError, perform, redo, treeIds, undo, type Content, type Op, type PaletteEntry } from '../../src/features/designer/model/ops.ts';

function parsed(json: unknown): Content {
  const r = flow.parseMbr(json);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.mbr;
}

const FIXTURES: Content[] = [parsed(granulation), parsed(packaging)];

const PALETTE: PaletteEntry[] = [
  { key: 'G-03@1', type: 'G-03', version: '1', plainName: 'Instruction to read or confirm', level: 'PHASE', significant: false, defaultConfig: {} },
  { key: 'G-07@1', type: 'G-07', version: '1', plainName: 'Weigh and dispense', level: 'PHASE', significant: true, defaultConfig: {} },
  { key: 'G-10@1', type: 'G-10', version: '1', plainName: 'Clear the room or line', level: 'PHASE', significant: true, defaultConfig: {} },
  { key: 'G-17@1', type: 'G-17', version: '1', plainName: 'QA hold point', level: 'HOLD_POINT', significant: false, defaultConfig: {} },
];

function steps(c: Content): string[] {
  const out: string[] = [];
  flow.walk(c.procedure.body, (n) => {
    if (n.kind === 'phase' || n.kind === 'holdPoint') out.push(n.id);
  });
  return out;
}

const decimalText = fc.oneof(
  fc.bigInt({ min: -99999n, max: 999999n }).map((v) => v.toString()),
  fc.tuple(fc.nat(9999), fc.nat(999)).map(([a, b]) => `${a}.${String(b).padStart(3, '0')}`),
);
const anyText = fc.oneof(decimalText, fc.constantFrom('', 'abc', '1e3', '.5', '-0', '1,5', ' 12'));

interface Seed {
  k: number;
  a: number;
  b: number;
  s: string;
  flag: boolean;
}
const seed: fc.Arbitrary<Seed> = fc.record({ k: fc.nat(12), a: fc.nat(), b: fc.nat(), s: anyText, flag: fc.boolean() });

const pick = <T>(list: readonly T[], i: number): T | undefined => (list.length === 0 ? undefined : list[i % list.length]);

/** A concrete operation for the current content (or undefined when the content offers no subject). */
function opFor(c: Content, x: Seed): Op | undefined {
  const all = steps(c);
  const phases = all.filter((id) => locate(c, id)?.node.kind === 'phase');
  switch (x.k) {
    case 0:
      return { kind: 'SET_TITLE', title: x.flag ? `Title ${x.s}` : x.s };
    case 1:
      return { kind: 'SET_MARKETS', markets: x.flag ? ['IN', 'US'] : x.a % 3 === 0 ? ['US'] : ['IN', 'EU'] };
    case 2: {
      const after = pick(all, x.a);
      const block = pick(PALETTE, x.b);
      const at = after ? insertionPoint(c, after) : undefined;
      return at && block ? { kind: 'INSERT_STEP', ...at, step: newStep(c, block) } : undefined;
    }
    case 3: {
      const id = pick(all, x.a);
      return id ? { kind: 'MOVE_STEP', nodeId: id, direction: x.flag ? 1 : -1 } : undefined;
    }
    case 4: {
      const id = pick(all, x.a);
      return id ? { kind: 'DELETE_STEP', nodeId: id } : undefined;
    }
    case 5: {
      const id = pick(phases, x.a);
      return id ? { kind: 'UPDATE_PHASE', nodeId: id, patch: { name: x.flag ? `Step ${x.s}` : x.s, significant: x.flag } } : undefined;
    }
    case 6: {
      const id = pick(phases, x.a);
      const p = c.parameters[x.b % Math.max(1, c.parameters.length)];
      return id && p ? { kind: 'UPDATE_PHASE', nodeId: id, patch: { records: x.flag ? [p.id] : [], config: {} } } : undefined;
    }
    case 7: {
      const owners = c.parameters.filter((p) => p.limits && p.limits.ranges.length > 0);
      const p = pick(owners, x.a);
      const r = p?.limits?.ranges[x.b % (p.limits?.ranges.length ?? 1)];
      return p && r ? { kind: 'SET_LIMIT_BOUND', owner: 'parameter', id: p.id, tier: r.tier, side: x.flag ? 'low' : 'high', value: x.a % 5 === 0 ? null : x.s } : undefined;
    }
    case 8: {
      const y = pick(c.yieldCheckpoints, x.a);
      return y ? { kind: 'SET_LIMIT_BOUND', owner: 'yield', id: y.id, tier: (limits.LIMIT_TIERS[x.b % 4] as limits.LimitTier) ?? 'ALERT', side: x.flag ? 'low' : 'high', value: x.s } : undefined;
    }
    case 9: {
      const p = pick(c.parameters, x.a);
      return p ? { kind: 'SET_TARGET', parameterId: p.id, value: x.flag ? x.s : null } : undefined;
    }
    case 10: {
      const t = pick(c.timeConstraints, x.a);
      return t ? { kind: 'SET_TIME_BOUND', constraintId: t.id, side: x.flag ? 'max' : 'min', value: x.b % 4 === 0 ? null : x.s } : undefined;
    }
    case 11: {
      const p = pick(c.parameters.filter((q) => q.limits && q.limits.ranges.length > 0), x.a);
      const r = p?.limits?.ranges[x.b % (p.limits?.ranges.length ?? 1)];
      return p && r ? { kind: 'SET_LIMIT_INCLUSIVE', owner: 'parameter', id: p.id, tier: r.tier, side: x.flag ? 'low' : 'high', inclusive: x.a % 2 === 0 } : undefined;
    }
    default: {
      const i = pick(c.intermediates.filter((m) => m.holdTime), x.a);
      return i ? { kind: 'SET_HOLD_TIME', intermediateId: i.id, value: x.s } : undefined;
    }
  }
}

const canonical = (c: unknown): string => flow.canonicalJson(c);

describe('designer edit operations', () => {
  it('[PR-03] any sequence of operations keeps the content well formed (parseMbr) and every step id unique; the input is never changed', () => {
    fc.assert(
      fc.property(fc.constantFrom(0, 1), fc.array(seed, { minLength: 1, maxLength: 30 }), (fixture, seeds) => {
        let c = FIXTURES[fixture] as Content;
        for (const x of seeds) {
          const op = opFor(c, x);
          if (!op) continue;
          const before = canonical(c);
          let next: Content;
          try {
            next = applyOp(c, op);
          } catch (e) {
            expect(e).toBeInstanceOf(OpError);
            expect(canonical(c)).toBe(before);
            continue;
          }
          expect(canonical(c)).toBe(before);
          const round = flow.parseMbr(JSON.parse(JSON.stringify(next)));
          expect(round.ok, round.ok ? '' : JSON.stringify(round.problems)).toBe(true);
          const ids = treeIds(next);
          expect(new Set(ids).size).toBe(ids.length);
          expect(next.header.marketSet).toContain('IN');
          c = next;
        }
      }),
      { numRuns: 150 },
    );
  });

  it('undo returns exactly the earlier content and redo the later one, for any sequence', () => {
    fc.assert(
      fc.property(fc.array(seed, { minLength: 1, maxLength: 20 }), (seeds) => {
        let h = initHistory(FIXTURES[0] as Content);
        const trail: string[] = [canonical(h.present)];
        for (const x of seeds) {
          const op = opFor(h.present, x);
          if (!op) continue;
          try {
            h = perform(h, op);
            trail.push(canonical(h.present));
          } catch (e) {
            expect(e).toBeInstanceOf(OpError);
          }
        }
        for (let i = trail.length - 1; i > 0; i -= 1) {
          expect(canUndo(h)).toBe(true);
          h = undo(h);
          expect(canonical(h.present)).toBe(trail[i - 1]);
        }
        expect(canUndo(h)).toBe(false);
        for (let i = 1; i < trail.length; i += 1) {
          h = redo(h);
          expect(canonical(h.present)).toBe(trail[i]);
        }
        expect(canRedo(h)).toBe(false);
      }),
      { numRuns: 60 },
    );
  });

  it('limit and target values stay decimal strings: anything else is refused and never enters the content', () => {
    const c = FIXTURES[0] as Content;
    const p = c.parameters.find((x) => x.limits && x.limits.ranges.length > 0) as flow.Parameter;
    const tier = (p.limits as limits.LimitSpec).ranges[0]?.tier as limits.LimitTier;
    for (const bad of ['1e3', '12,5', '', '.5', 'NaN', ' 1']) {
      expect(() => applyOp(c, { kind: 'SET_LIMIT_BOUND', owner: 'parameter', id: p.id, tier, side: 'high', value: bad })).toThrow(OpError);
    }
    const next = applyOp(c, { kind: 'SET_LIMIT_BOUND', owner: 'parameter', id: p.id, tier, side: 'high', value: '123.450' });
    expect(next.parameters.find((x) => x.id === p.id)?.limits?.ranges.find((r) => r.tier === tier)?.high).toEqual({ value: '123.450', inclusive: true });
    expect(typeof next.parameters.find((x) => x.id === p.id)?.limits?.ranges.find((r) => r.tier === tier)?.high?.value).toBe('string');
  });

  it('[INV-28] India cannot be removed from the market set', () => {
    expect(() => applyOp(FIXTURES[0] as Content, { kind: 'SET_MARKETS', markets: ['US'] })).toThrow(/India/);
  });

  it('[IN-02] R-rest A11: the master names its criticality assessment, pinned as a reference; a document of another kind is refused; none removes it', () => {
    const c = FIXTURES[0] as Content;
    const ra: flow.Reference = { id: 'RA-CRIT-01', kind: 'RISK_ASSESSMENT', code: 'RA-CRIT-01', version: '1', hash: 'a'.repeat(64), title: 'Criticality assessment' };
    const set = applyOp(c, { kind: 'SET_CRITICALITY_ASSESSMENT', reference: ra });
    expect(set.header.criticalityAssessment).toBe('RA-CRIT-01');
    expect(set.references.filter((r) => r.id === 'RA-CRIT-01')).toEqual([ra]);
    expect(() => applyOp(c, { kind: 'SET_CRITICALITY_ASSESSMENT', reference: { ...ra, kind: 'SOP' } })).toThrow(/risk assessment/);
    expect('criticalityAssessment' in applyOp(set, { kind: 'SET_CRITICALITY_ASSESSMENT', reference: null }).header).toBe(false);
  });

  it('[IN-45][ST-29] the author marks a master as a process simulation and clears the mark; the marked content parses and no other value is set', () => {
    const c: Content = { ...(FIXTURES[0] as Content), header: { ...(FIXTURES[0] as Content).header, edition: 'injectables' } };
    const marked = applyOp(c, { kind: 'SET_NON_PRODUCT', nonProduct: 'PROCESS_SIMULATION' });
    expect(marked.header.nonProduct).toBe('PROCESS_SIMULATION');
    expect(flow.parseMbr(JSON.parse(JSON.stringify(marked))).ok).toBe(true);
    expect(() => applyOp(c, { kind: 'SET_NON_PRODUCT', nonProduct: 'ROUTINE_MONITORING' as flow.NonProduct })).toThrow(/process simulation/);
    expect('nonProduct' in applyOp(marked, { kind: 'SET_NON_PRODUCT', nonProduct: null }).header).toBe(false);
    expect('nonProduct' in c.header).toBe(false);
  });

  it('[IN-45][ST-29] only an injectables processing master can be marked a process simulation: a tablets master and a packaging master are refused', () => {
    const tablets = FIXTURES[0] as Content;
    const packaging = { ...(FIXTURES[1] as Content), header: { ...(FIXTURES[1] as Content).header, edition: 'injectables' as const } };
    for (const c of [tablets, packaging]) {
      expect(() => applyOp(c, { kind: 'SET_NON_PRODUCT', nonProduct: 'PROCESS_SIMULATION' })).toThrow(/Only an injectables processing master/);
    }
  });

  it('[DI-37][DI-04] no operation lets text no record can hold into the content: each refusal names the field and leaves the content as it was (review F31 round 2)', () => {
    const c = FIXTURES[0] as Content;
    const phase = steps(c).find((id) => locate(c, id)?.node.kind === 'phase') as string;
    const hold = steps(c).find((id) => locate(c, id)?.node.kind === 'holdPoint') as string;
    const before = canonical(c);
    const cases: Array<[(t: string) => Op, RegExp]> = [
      [(t) => ({ kind: 'SET_TITLE', title: t }), /^The title holds /],
      [(t) => ({ kind: 'UPDATE_PHASE', nodeId: phase, patch: { name: t } }), /^The step name holds /],
      [(t) => ({ kind: 'UPDATE_PHASE', nodeId: phase, patch: { config: { text: t } } }), /^The configuration field text holds /],
      [(t) => ({ kind: 'UPDATE_PHASE', nodeId: phase, patch: { config: { checks: ['Floor clean', t] } } }), /^The configuration field checks\.1 holds /],
      [(t) => ({ kind: 'UPDATE_PHASE', nodeId: phase, patch: { config: { [t]: 'x' } } }), /^The configuration has a field name holding /],
      [(t) => ({ kind: 'UPDATE_HOLD', nodeId: hold, patch: { name: t } }), /^The hold point name holds /],
      [(t) => ({ kind: 'UPDATE_HOLD', nodeId: hold, patch: { role: t } }), /^The releasing role holds /],
    ];
    const texts: Array<[string, string]> = [
      ['Edited\u0000 title', 'U+0000'],
      ['Booth \ud800 clearance', 'an unpaired surrogate U+D800'],
      ['\udfffBooth', 'an unpaired surrogate U+DFFF'],
      ['Booth \udc00\ud800 reversed', 'an unpaired surrogate U+DC00'],
      ['Booth \ud83d\ude00\ud83d', 'an unpaired surrogate U+D83D'],
    ];
    for (const [text, problem] of texts) {
      for (const [op, field] of cases) {
        let error: unknown;
        try {
          applyOp(c, op(text));
        } catch (e) {
          error = e;
        }
        expect(error, `${JSON.stringify(op(text))} is refused`).toBeInstanceOf(OpError);
        expect((error as OpError).message).toMatch(field);
        expect((error as OpError).message).toContain(`hold${(error as OpError).message.includes('field name') ? 'ing' : 's'} ${problem}, which no record can hold`);
        expect((error as OpError).message).not.toContain(text);
      }
      // A new step whose name holds such text is refused too (its shape check names the place).
      const step = { ...newStep(c, PALETTE[0] as PaletteEntry), name: text };
      expect(() => applyOp(c, { kind: 'INSERT_STEP', ...(insertionPoint(c, phase) as { sequenceId: string; index: number }), step })).toThrow(OpError);
    }
    expect(canonical(c)).toBe(before);
  });

  it('[DI-37][DI-04] text edits: whatever the author types, the content either refuses it with an OpError or holds only text a record can hold, so its hash never throws', () => {
    const c = FIXTURES[0] as Content;
    const phase = steps(c).find((id) => locate(c, id)?.node.kind === 'phase') as string;
    const hold = steps(c).find((id) => locate(c, id)?.node.kind === 'holdPoint') as string;
    const piece = fc.constantFrom('a', 'Z', ' ', '-', '\u00e9', '\u0915', '\u0000', '\u0001', '\ud800', '\udbff', '\udc00', '\udfff', '\ud83d\ude00', '\ufffd', '\uffff');
    const text = fc.array(piece, { minLength: 1, maxLength: 12 }).map((p) => p.join(''));
    const opOf = (k: number, t: string): Op => {
      if (k === 0) return { kind: 'SET_TITLE', title: t };
      if (k === 1) return { kind: 'UPDATE_PHASE', nodeId: phase, patch: { name: t } };
      if (k === 2) return { kind: 'UPDATE_PHASE', nodeId: phase, patch: { config: { text: t } } };
      if (k === 3) return { kind: 'UPDATE_HOLD', nodeId: hold, patch: { name: t } };
      return { kind: 'UPDATE_HOLD', nodeId: hold, patch: { role: t } };
    };
    fc.assert(
      fc.property(fc.nat(4), text, (k, typed) => {
        const o = opOf(k, typed);
        let next: Content | undefined;
        try {
          next = applyOp(c, o);
        } catch (e) {
          expect(e).toBeInstanceOf(OpError);
        }
        if (unstorableText(typed) !== null) expect(next, 'text no record can hold is refused').toBeUndefined();
        if (next) expect(() => flow.mbrContentHash(next)).not.toThrow();
      }),
      { numRuns: 400 },
    );
  });

  it('inserts a palette step with a unique id after the chosen step, and moves it within its sequence only', () => {
    const c = FIXTURES[0] as Content;
    const first = steps(c)[0] as string;
    const at = insertionPoint(c, first);
    expect(at).toBeDefined();
    const step = newStep(c, PALETTE[1] as PaletteEntry);
    const next = applyOp(c, { kind: 'INSERT_STEP', ...(at as { sequenceId: string; index: number }), step });
    expect(steps(next)[1]).toBe(step.id);
    expect(step.kind === 'phase' && step.signatures.check).toEqual({ meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' });
    const up = applyOp(next, { kind: 'MOVE_STEP', nodeId: step.id, direction: -1 });
    expect(steps(up)[0]).toBe(step.id);
    expect(() => applyOp(up, { kind: 'MOVE_STEP', nodeId: step.id, direction: -1 })).toThrow(/already first/);
    expect(() => applyOp(next, { kind: 'INSERT_STEP', ...(at as { sequenceId: string; index: number }), step })).toThrow(/already used/);
  });
});
