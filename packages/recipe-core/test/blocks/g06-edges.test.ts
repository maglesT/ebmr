/**
 * G-06@1 automated equipment phase (DI-31, DI-32, DI-04, DI-49, PR-14) at its edges, through its handler on a minimal
 * view: the provenance of a value (equipment reading, quality and receipt time, fresh within the maximum age, both ends
 * allowed; the manual fallback only where the MBR allows it, naming no reading), set-point read-backs within their
 * tolerance, collected values within their limits (ends allowed), alarms and their acknowledgement, the recipe check,
 * PERFORMED and the definition checks. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import { actualsOf, G06, maxAgeMicros, setpointsOf } from '../../src/blocks/generic/automated.ts';
import type { HandlerView } from '../../src/blocks/contract.ts';
import type { MbrContent, PhaseNode } from '../../src/flow/model.ts';

type Json = Record<string, unknown>;
const NOW = 1_800_000_000_000_000n;
const S = 1_000_000n;
const RID = '00000000-0000-4000-8000-000000000001';
const CFG: Json = {
  setpoints: [{ tag: 'force', value: '45.00', unit: 'kN', tolerance: '1.00' }],
  actuals: [{ tag: 'gap', unit: 'mm', min: '2.50', max: '3.50' }],
  criticalAlarms: ['temp'],
  maxAgeSeconds: 60,
};
const SYSTEM = { kind: 'PLC', ref: 'SYS', recipe: 'RCP', recipeVersion: '2' };

class World {
  entries: { id: string; kind: string; data: Json; recordedAt: bigint }[] = [];
  constructor(readonly config: Json = CFG, readonly system: Json | null = SYSTEM) {}
  view(): HandlerView {
    return {
      phase: { id: 'p', ...(this.system ? { system: this.system } : {}) },
      config: this.config,
      stepKey: 'p@',
      nowUs: NOW,
      entries: (k?: string) => this.entries.filter((e) => k === undefined || e.kind === k),
      actor: { id: 'OP1' },
    } as unknown as HandlerView;
  }
  rec(entry: Json & { kind: string }): { refused?: string; data?: Json; exceptions?: Json[]; verificationRequired?: boolean } {
    const r = (G06.handler?.acceptEntry as (v: HandlerView, e: Json) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: Json[]; verificationRequired?: boolean })(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length}`, kind: entry.kind, data: r.data ?? {}, recordedAt: NOW });
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}), ...(r.verificationRequired ? { verificationRequired: true } : {}) };
  }
  before(): string[] {
    return (G06.handler?.beforePerform as (v: HandlerView) => { message: string }[])(this.view()).map((p) => p.message);
  }
}
const eq = (kind: string, tag: string, value: string, unit: string, over: Json = {}) => ({ kind, tag, value, unit, source: 'EQUIPMENT', readingId: RID, quality: 'GOOD', receivedAtUs: NOW.toString(), ...over });
const types = (r: { exceptions?: Json[] }) => (r.exceptions ?? []).map((x) => x['type']);

describe('G-06 provenance', () => {
  it('[DI-31][DI-32] an equipment value names its reading, quality and receipt; it counts only when GOOD and received within the maximum age (both ends allowed)', () => {
    const w = new World();
    const PROV = 'A value from the equipment names its process reading, the quality the device reported and when the server received it (G06-PROVENANCE; DI-31, DI-32)';
    expect(w.rec(eq('ACTUAL', 'gap', '3', 'mm', { readingId: undefined })).refused).toBe(PROV);
    expect(w.rec(eq('ACTUAL', 'gap', '3', 'mm', { quality: undefined })).refused).toBe(PROV);
    expect(w.rec(eq('ACTUAL', 'gap', '3', 'mm', { receivedAtUs: 'x' })).refused).toBe(PROV);
    const fresh = w.rec(eq('ACTUAL', 'gap', '3', 'mm'));
    expect(fresh).toStrictEqual({ data: { tag: 'gap', value: '3', unit: 'mm', source: 'EQUIPMENT', readingId: RID, quality: 'GOOD', receivedAtUs: NOW.toString(), manualFallback: false, withinLimits: true, usable: true, recordedBy: 'OP1' } });
    expect(w.rec(eq('ACTUAL', 'gap', '3', 'mm', { receivedAtUs: (NOW - 60n * S).toString() })).data?.['usable']).toBe(true);
    const stale = w.rec(eq('ACTUAL', 'gap', '3', 'mm', { receivedAtUs: (NOW - 60n * S - 1n).toString() }));
    expect(stale.data?.['usable']).toBe(false);
    expect(stale.exceptions).toEqual([
      { type: 'PROCESS_DATA_UNUSABLE', title: `The value of gap at p@ is stale or not good (quality GOOD, received at ${(NOW - 60n * S - 1n).toString()}): it does not count for the step`, controls: ['DI-31', 'DI-32'], severity: 'ALERT', category: 'INTERFACE_FALLBACK', blocks: 'NONE', item: 'gap' },
    ]);
    expect(w.rec(eq('ACTUAL', 'gap', '3', 'mm', { receivedAtUs: (NOW + 1n).toString() })).data?.['usable']).toBe(false);
    expect(w.rec(eq('ACTUAL', 'gap', '3', 'mm', { quality: 'UNCERTAIN' })).data?.['usable']).toBe(false);
    expect(w.rec(eq('SETPOINT_READBACK', 'force', '45', 'kN', { quality: 'BAD' })).exceptions?.[0]?.['title']).toMatch(/^The read-back of force at p@ is stale or not good \(quality BAD/);
    expect([maxAgeMicros({}), maxAgeMicros({ maxAgeSeconds: 1.5 }), maxAgeMicros({ maxAgeSeconds: '9' }), maxAgeMicros({ maxAgeSeconds: 5 })]).toEqual([60n * S, 60n * S, 60n * S, 5n * S]);
  });

  it('[DI-32][PR-14] a manual value only on the MBR\'s fallback path, naming no device reading; it needs a second person', () => {
    const manual = (over: Json = {}) => ({ kind: 'ACTUAL', tag: 'gap', value: '3', unit: 'mm', source: 'MANUAL', ...over });
    expect(new World().rec(manual()).refused).toBe('p takes its values from the equipment; its MBR allows no manual fallback (G06-MANUAL-NOT-ALLOWED; DI-32, PR-14)');
    const w = new World({ ...CFG, manualFallback: true });
    const NO = 'A value keyed by hand names no device reading, quality or receipt time (G06-PROVENANCE; DI-32)';
    expect(w.rec(manual({ readingId: RID })).refused).toBe(NO);
    expect(w.rec(manual({ quality: 'GOOD' })).refused).toBe(NO);
    expect(w.rec(manual({ receivedAtUs: '1' })).refused).toBe(NO);
    expect(new World({ ...CFG, manualFallback: 'yes' }).rec(manual({ quality: 'GOOD' })).refused?.split(' | ')).toHaveLength(2);
    const r = w.rec(manual());
    expect(r.data).toStrictEqual({ tag: 'gap', value: '3', unit: 'mm', source: 'MANUAL', manualFallback: true, withinLimits: true, usable: true, recordedBy: 'OP1' });
    expect(r.verificationRequired).toBe(true);
    expect(r.exceptions).toEqual([{ type: 'PROCESS_MANUAL_FALLBACK', title: "gap at p@ was keyed by hand under the MBR's fallback path; the step now needs a second person", controls: ['PR-14', 'DI-32'], severity: 'ALERT', category: 'MANUAL_ENTRY', blocks: 'NONE', item: 'gap' }]);
  });
});

describe('G-06 values', () => {
  it('[DI-31][PR-14] a read-back of a configured setpoint matches within its tolerance (ends allowed), in its unit; otherwise QA decides', () => {
    const w = new World();
    expect(w.rec(eq('SETPOINT_READBACK', 'speed', '1', 'rpm')).refused).toBe('speed is not a setpoint of p (G06-NOT-A-SETPOINT; DI-31, PR-14)');
    expect(w.rec(eq('SETPOINT_READBACK', 'force', '46.00', 'kN')).data).toMatchObject({ setpoint: { value: '45.00', unit: 'kN' }, matches: true });
    expect(w.rec(eq('SETPOINT_READBACK', 'force', '44.00', 'kN')).data?.['matches']).toBe(true);
    const off = w.rec(eq('SETPOINT_READBACK', 'force', '46.01', 'kN'));
    expect(off.data?.['matches']).toBe(false);
    expect(off.exceptions).toEqual([
      { type: 'SETPOINT_MISMATCH', title: "force at p@ reads back 46.01 kN, not the MBR's 45.00 kN (tolerance 1.00): the step and the steps after it stop until QA decides", controls: ['DI-31', 'PR-14'], severity: 'ACTION', category: 'DEVIATION_OR_OVERRIDE', blocks: 'STEP_AND_DOWNSTREAM', until: 'DISPOSITION', qaOnly: true, item: 'force' },
    ]);
    expect(w.rec(eq('SETPOINT_READBACK', 'force', '45.00', 'N')).data?.['matches']).toBe(false);
    expect(setpointsOf({ setpoints: [{ tag: 't', value: '1', unit: 'u' }, 'x'] })).toEqual([{ tag: 't', value: '1', unit: 'u', tolerance: '0' }]);
    const exact = new World({ ...CFG, setpoints: [{ tag: 'force', value: '45', unit: 'kN' }] });
    expect(exact.rec(eq('SETPOINT_READBACK', 'force', '45.0', 'kN')).data?.['matches']).toBe(true);
    expect(exact.rec(eq('SETPOINT_READBACK', 'force', '45.01', 'kN')).data?.['matches']).toBe(false);
  });

  it('[DI-31][PR-14] a collected value in its unit, within its limits (ends allowed); outside, the steps after it wait for a deviation', () => {
    const w = new World();
    expect(w.rec(eq('ACTUAL', 'speed', '1', 'rpm')).refused).toBe('speed is not a value p collects (G06-NOT-COLLECTED; DI-31)');
    expect(w.rec(eq('ACTUAL', 'gap', '3', 'cm')).refused).toBe('gap is collected in mm, not cm (G06-UNIT; DI-31)');
    expect(w.rec(eq('ACTUAL', 'gap', '2.50', 'mm')).data?.['withinLimits']).toBe(true);
    expect(w.rec(eq('ACTUAL', 'gap', '3.50', 'mm')).data?.['withinLimits']).toBe(true);
    expect(types(w.rec(eq('ACTUAL', 'gap', '2.49', 'mm')))).toEqual(['PROCESS_VALUE_OUT_OF_LIMITS']);
    const hi = w.rec(eq('ACTUAL', 'gap', '3.51', 'mm'));
    expect(hi.exceptions).toEqual([
      { type: 'PROCESS_VALUE_OUT_OF_LIMITS', title: 'gap at p@ is 3.51 mm, outside its acceptance limits (2.50 to 3.50): the steps after it wait for a deviation', controls: ['DI-31', 'PR-14'], severity: 'ACTION', category: 'OUT_OF_LIMIT', blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true, item: 'gap' },
    ]);
    const open = new World({ ...CFG, actuals: [{ tag: 'gap', unit: 'mm', max: '3' }, { tag: 'low', unit: 'mm', min: '1' }] });
    expect(open.rec(eq('ACTUAL', 'gap', '-99', 'mm')).data?.['withinLimits']).toBe(true);
    expect(open.rec(eq('ACTUAL', 'gap', '4', 'mm')).exceptions?.[0]?.['title']).toMatch(/\(- to 3\)/);
    expect(open.rec(eq('ACTUAL', 'low', '0', 'mm')).exceptions?.[0]?.['title']).toMatch(/\(1 to -\)/);
    expect(open.rec(eq('ACTUAL', 'low', '999', 'mm')).data?.['withinLimits']).toBe(true);
    expect(actualsOf({ actuals: [{ tag: 'a', unit: 'u', min: 1, max: 2 }, 3] })).toEqual([{ tag: 'a', unit: 'u' }]);
  });

  it('[DI-49] alarms: GMP-critical ones are flagged and acknowledged with a comment; each once; an unknown alarm is none; the value of an alarm carries no usable flag', () => {
    const w = new World();
    const plain = w.rec(eq('ALARM', 'door', '1', '1', { quality: 'BAD' }));
    expect(plain).toStrictEqual({ data: { tag: 'door', value: '1', unit: '1', source: 'EQUIPMENT', readingId: RID, quality: 'BAD', receivedAtUs: NOW.toString(), manualFallback: false, critical: false, recordedBy: 'OP1' } });
    const crit = w.rec(eq('ALARM', 'temp', '80', 'Cel'));
    expect(crit.exceptions).toEqual([{ type: 'GMP_CRITICAL_ALARM', title: 'GMP-critical alarm on temp at p@ (80 Cel): it is acknowledged with a comment and reviewed', controls: ['DI-49'], severity: 'ALERT', category: 'DEVIATION_OR_OVERRIDE', blocks: 'NONE', item: 'temp' }]);
    expect(w.before()).toEqual(expect.arrayContaining(['Acknowledge alarm E0, E1 first (G06-ALARM-UNACKNOWLEDGED; DI-49)']));
    expect(w.rec({ kind: 'ALARM_ACK', alarm: 'E9' }).refused).toBe('E9 is not an alarm of p@ (G06-ACK-UNKNOWN; DI-49)');
    expect(w.rec({ kind: 'ALARM_ACK', alarm: 'E1' }).refused).toBe('Alarm E1 on temp is GMP-critical: its acknowledgement needs a comment and the action taken (G06-ACK-COMMENT; DI-49)');
    expect(w.rec({ kind: 'ALARM_ACK', alarm: 'E1', comment: '  ' }).refused).toMatch(/G06-ACK-COMMENT/);
    expect(w.rec({ kind: 'ALARM_ACK', alarm: 'E1', comment: 7 }).refused).toMatch(/G06-ACK-COMMENT/);
    expect(w.rec({ kind: 'ALARM_ACK', alarm: 'E0', comment: 7 }).data).toStrictEqual({ alarm: 'E0', acknowledgedBy: 'OP1' });
    expect(w.rec({ kind: 'ALARM_ACK', alarm: 'E0' }).refused).toBe('Alarm E0 is already acknowledged (G06-ACK-TWICE; DI-49)');
    expect(w.rec({ kind: 'ALARM_ACK', alarm: 'E1', comment: 'Cooling restored' }).data).toStrictEqual({ alarm: 'E1', comment: 'Cooling restored', acknowledgedBy: 'OP1' });
    expect(w.before().some((m) => m.includes('G06-ALARM-UNACKNOWLEDGED'))).toBe(false);
    expect(w.rec({ kind: 'OTHER' }).refused).toBe('OTHER is not an entry of an automated step (G06-ENTRY; DI-31)');
    const loss = w.rec({ kind: 'INTERFACE_LOSS', reason: 'cable' });
    expect(loss.verificationRequired).toBe(true);
    expect(loss.exceptions?.[0]?.['title']).toBe('The link to the equipment of p@ was lost (cable): the step needs a second person');
  });

  it('[DI-04][PR-14] the recipe check against the MBR\'s recipe and version; a mismatch stops the step until QA decides', () => {
    expect(new World(CFG, null).rec({ kind: 'RECIPE_CHECK', recipe: 'RCP', recipeVersion: '2' }).refused).toBe('p names no equipment recipe to check against (G06-NO-RECIPE; DI-04)');
    const w = new World();
    expect(w.rec({ kind: 'RECIPE_CHECK', recipe: 'RCP', recipeVersion: '2' })).toStrictEqual({ data: { recipe: 'RCP', recipeVersion: '2', matches: true, checkedBy: 'OP1' } });
    expect(w.rec({ kind: 'RECIPE_CHECK', recipe: 'RCX', recipeVersion: '2' }).data?.['matches']).toBe(false);
    const v = w.rec({ kind: 'RECIPE_CHECK', recipe: 'RCP', recipeVersion: '3' });
    expect(v.exceptions).toEqual([
      { type: 'RECIPE_MISMATCH', title: "The equipment of p@ runs recipe RCP version 3, not the MBR's RCP version 2: the step and the steps after it stop until QA decides", controls: ['DI-04', 'PR-14'], severity: 'ACTION', category: 'DEVIATION_OR_OVERRIDE', blocks: 'STEP_AND_DOWNSTREAM', until: 'DISPOSITION', qaOnly: true },
    ]);
    expect(new World(CFG, { ...SYSTEM, recipeVersion: undefined }).rec({ kind: 'RECIPE_CHECK', recipe: 'RCP', recipeVersion: '3' }).exceptions?.[0]?.['title']).toMatch(/not the MBR's RCP version -:/);
  });
});

describe('G-06 PERFORMED and definition', () => {
  it('[DI-31][DI-04] PERFORMED needs a usable matching read-back of every setpoint, the recipe checked and a usable value of every collected tag', () => {
    const w = new World();
    expect(w.before()).toEqual([
      "Setpoint force has no usable read-back equal to the MBR's (G06-READBACK-MISSING; DI-31, PR-14)",
      'Check the recipe the equipment runs first (G06-RECIPE-UNCHECKED; DI-04, PR-14)',
      'gap has no usable value yet (G06-ACTUAL-MISSING; DI-31, DI-32)',
    ]);
    w.rec(eq('SETPOINT_READBACK', 'force', '47', 'kN'));
    w.rec(eq('SETPOINT_READBACK', 'force', '45', 'kN', { quality: 'BAD' }));
    w.rec(eq('ACTUAL', 'gap', '3', 'mm', { quality: 'BAD' }));
    w.rec(eq('ACTUAL', 'other', '3', 'mm', {}));
    expect(w.before()).toHaveLength(3);
    w.rec(eq('SETPOINT_READBACK', 'force', '45', 'kN'));
    w.rec({ kind: 'RECIPE_CHECK', recipe: 'X', recipeVersion: '9' });
    w.rec(eq('ACTUAL', 'gap', '3', 'mm'));
    expect(w.before()).toEqual([]);
    expect(new World({}).before()).toEqual([]);
    expect(new World({ actuals: CFG['actuals'] }, null).before()).toEqual(['gap has no usable value yet (G06-ACTUAL-MISSING; DI-31, DI-32)']);
    const two = new World({ setpoints: [{ tag: 'a', value: '1', unit: 'u' }, { tag: 'b', value: '1', unit: 'u' }] }, null);
    two.rec(eq('SETPOINT_READBACK', 'a', '1', 'u'));
    expect(two.before()).toEqual(["Setpoint b has no usable read-back equal to the MBR's (G06-READBACK-MISSING; DI-31, PR-14)"]);
  });

  it('[DI-31][DI-04] the definition: each tag once, ordered limits (equal allowed), a recipe when the interface is configured', () => {
    const P = (config: Json, system: Json | null = SYSTEM) => (G06.checkConfig as (p: PhaseNode, c: Json, m: MbrContent) => { code: string; message: string }[])({ id: 'p', ...(system ? { system } : {}) } as unknown as PhaseNode, config, {} as MbrContent).map((x) => `${x.code}: ${x.message}`);
    expect(P(CFG)).toEqual([]);
    const sp = (tag: string) => ({ tag, value: '1', unit: 'u' });
    expect(P({ setpoints: [sp('a'), sp('a'), sp('b'), sp('b'), sp('a')] })).toEqual(['G06-DUPLICATE-TAG: Automated step p lists setpoint a, b twice']);
    expect(P({ actuals: [{ tag: 'g', unit: 'u' }, { tag: 'g', unit: 'u' }] })).toEqual(['G06-DUPLICATE-TAG: Automated step p collects g twice']);
    expect(P({ actuals: [{ tag: 'g', unit: 'u', min: '2', max: '1.99' }] })).toEqual(['G06-LIMITS: Automated step p: the limits of g run from 2 to 1.99']);
    expect(P({ actuals: [{ tag: 'g', unit: 'u', min: '2', max: '2' }] })).toEqual([]);
    expect(P({ actuals: [{ tag: 'g', unit: 'u', min: '2' }] })).toEqual([]);
    expect(P({ actuals: [{ tag: 'g', unit: 'u', max: '2' }] })).toEqual([]);
    expect(P({ setpoints: [sp('a')] }, null)).toEqual(['G06-NO-RECIPE: Automated step p names no equipment recipe and version to check against']);
    expect(P({ actuals: [{ tag: 'g', unit: 'u' }] }, { kind: 'PLC' })).toEqual(['G06-NO-RECIPE: Automated step p names no equipment recipe and version to check against']);
    expect(P({}, null)).toEqual([]);
  });

  it('[DI-31] the nominal path: the recipe, each read-back at its setpoint and each value inside its limits, from the equipment now', () => {
    const nominal = (config: Json, system: Json | null = SYSTEM, nowUs: bigint | null = NOW) => G06.simulatorModel?.nominalEntries?.({ phase: { id: 'p', ...(system ? { system } : {}) }, config, nowUs: nowUs ?? undefined } as never) as Json[];
    const n = nominal({ ...CFG, actuals: [{ tag: 'gap', unit: 'mm', min: '2.5', max: '3.5' }, { tag: 'hi', unit: 'mm', max: '9' }, { tag: 'none', unit: 'mm' }] });
    expect(n.map((e) => [e['kind'], e['tag'] ?? e['recipe'], e['value'] ?? e['recipeVersion']])).toEqual([
      ['RECIPE_CHECK', 'RCP', '2'],
      ['SETPOINT_READBACK', 'force', '45.00'],
      ['ACTUAL', 'gap', '2.5'],
      ['ACTUAL', 'hi', '9'],
      ['ACTUAL', 'none', '0'],
    ]);
    expect(n.slice(1).map((e) => e['readingId'])).toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000064', '00000000-0000-4000-8000-000000000065', '00000000-0000-4000-8000-000000000066']);
    expect(n[1]).toMatchObject({ source: 'EQUIPMENT', quality: 'GOOD', receivedAtUs: NOW.toString(), unit: 'kN' });
    expect(nominal(CFG, null).map((e) => e['kind'])).toEqual(['SETPOINT_READBACK', 'ACTUAL']);
    expect(nominal(CFG, { ...SYSTEM, recipeVersion: undefined })[0]).toMatchObject({ kind: 'RECIPE_CHECK', recipe: 'RCP', recipeVersion: '' });
    expect(nominal(CFG, SYSTEM, null)).toEqual([]);
  });
});
