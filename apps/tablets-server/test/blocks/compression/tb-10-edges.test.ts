/**
 * TB-10@1 compression set-up and first-off approval (INV-24, IN-26, PR-23, PR-08) at its edges, through its handler on a
 * minimal view: the set-up once, the checklist (required items plus the MBR's, each once), the hopper charge, the
 * first-off check after the set-up, checklist and charge, settings against their approved ranges (ends allowed),
 * PERFORMED and the definition checks. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { checklistOf, REQUIRED_CHECKS, settingRangesOf, TB10 } from '../../../src/blocks/tb-10.ts';
import { blockMbr, fixturePhase } from './support.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint };
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CFG = (TB10.goldenFixture as blocks.BlockGoldenFixture).phase.config as Json;

class World {
  entries: E[] = [];
  constructor(readonly config: Json = CFG) {}
  view(): blocks.HandlerView {
    return { phase: { id: 'p', block: { type: 'TB-10', version: '1' } }, config: this.config, stepKey: 'p@', nowUs: 0n, entries: (kind?: string) => this.entries.filter((x) => kind === undefined || x.kind === kind), actor: { id: 'OP1' } } as unknown as blocks.HandlerView;
  }
  rec(entry: Json & { kind: string }): { refused?: string; data?: Json; exceptions?: Json[]; verificationRequired?: boolean } {
    const accept = TB10.handler?.acceptEntry as (v: blocks.HandlerView, x: Json & { kind: string }) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: Json[]; verificationRequired?: boolean };
    const r = accept(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length + 1}`, kind: entry.kind, data: r.data ?? {}, recordedAt: 0n });
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}), ...(r.verificationRequired ? { verificationRequired: true } : {}) };
  }
  before(): string[] {
    return (TB10.handler?.beforePerform as (v: blocks.HandlerView) => { message: string }[])(this.view()).map((p) => p.message).filter((m) => m.includes('TB10-'));
  }
}
const setup = { kind: 'PRESS_SETUP', press: 'PRESS-01', useId: U(1), issueId: U(2) };
const checklist = (items: { item: string; ok: boolean }[]) => ({ kind: 'PRE_USE_CHECKLIST', items });
const allOk = REQUIRED_CHECKS.map((item) => ({ item, ok: true }));

describe('TB-10 set-up', () => {
  it('[PR-23][INV-24] the press is set up once; the checklist names each required and MBR item once, in the checklist\'s order', () => {
    const w = new World({ ...CFG, checklist: ['FEEDER_CLEAN', 'DUST_EXTRACTION'] });
    expect(w.rec(setup).data).toStrictEqual({ press: 'PRESS-01', useId: U(1), issueId: U(2), setUpBy: 'OP1' });
    expect(w.rec(setup).refused).toBe('The press of p@ is set up already (TB10-SETUP-TWICE; PR-23)');
    const msg = 'The pre-use checklist records each of DUST_EXTRACTION, NOZZLES_CLEAN_NO_LEAK, CALIBRATED_BALANCE, FEEDER_CLEAN once (TB10-CHECKLIST; PR-23)';
    expect(w.rec(checklist(allOk)).refused).toBe(msg);
    expect(w.rec(checklist([...allOk, { item: 'FEEDER_CLEAN', ok: true }, { item: 'FEEDER_CLEAN', ok: true }])).refused).toBe(msg);
    expect(w.rec(checklist([...allOk.slice(1), { item: 'FEEDER_CLEAN', ok: true }, { item: 'OTHER', ok: true }])).refused).toBe(msg);
    const r = w.rec(checklist([{ item: 'FEEDER_CLEAN', ok: true }, ...allOk.slice(0, 2), { item: 'CALIBRATED_BALANCE', ok: 'yes' as never }]));
    expect(r.data).toStrictEqual({ items: [{ item: 'DUST_EXTRACTION', ok: true }, { item: 'NOZZLES_CLEAN_NO_LEAK', ok: true }, { item: 'CALIBRATED_BALANCE', ok: false }, { item: 'FEEDER_CLEAN', ok: true }], allOk: false, checkedBy: 'OP1' });
    expect(checklistOf({ checklist: 'x' })).toEqual([...REQUIRED_CHECKS]);
  });

  it('[IN-26][IN-35][PR-23] the hopper is charged after the set-up; the first-off check follows the set-up, an all-in-order checklist and a charge; a failure is noted; it needs a second person', () => {
    const w = new World();
    expect(w.rec({ kind: 'HOPPER_CHARGE', chargeId: U(3) }).refused).toBe('Set up the press of p@ first (TB10-NO-SETUP; PR-23)');
    expect(w.rec({ kind: 'FIRST_OFF', result: 'PASS' }).refused).toBe('Set up the press of p@ first (TB10-NO-SETUP; PR-23, INV-24)');
    w.rec(setup);
    expect(w.rec({ kind: 'FIRST_OFF', result: 'PASS' }).refused).toBe('The pre-use checklist is not all in order (TB10-CHECKLIST-OPEN; PR-23)');
    w.rec(checklist(allOk.map((i, n) => ({ ...i, ok: n > 0 }))));
    expect(w.rec({ kind: 'FIRST_OFF', result: 'PASS' }).refused).toMatch(/TB10-CHECKLIST-OPEN/);
    w.rec(checklist(allOk));
    expect(w.rec({ kind: 'FIRST_OFF', result: 'PASS' }).refused).toBe('Charge the hopper by scan first (TB10-NOT-CHARGED; IN-26)');
    expect(w.rec({ kind: 'HOPPER_CHARGE', chargeId: U(3) }).data).toStrictEqual({ chargeId: U(3), chargedBy: 'OP1' });
    const failed = w.rec({ kind: 'FIRST_OFF', result: 'FAIL', observations: 'Capping at the edges' });
    expect(failed).toStrictEqual({
      data: { result: 'FAIL', observations: 'Capping at the edges', recordedBy: 'OP1' },
      exceptions: [{ type: 'FIRST_OFF_FAILED', title: 'The first-off tablets of p@ failed their check: adjust the press and check again', controls: ['IN-35', 'PR-23'], severity: 'ALERT', category: 'OUT_OF_LIMIT', blocks: 'NONE' }],
      verificationRequired: true,
    });
    expect(w.rec({ kind: 'FIRST_OFF', result: 'PASS' })).toStrictEqual({ data: { result: 'PASS', recordedBy: 'OP1' }, verificationRequired: true });
  });

  it('[PR-08][PR-23] a setting change names an approved tag in its unit; within the range (ends allowed) it is recorded, outside it waits for a deviation', () => {
    const w = new World();
    const set = (value: string, extra: Json = {}) => w.rec({ kind: 'SETTING_CHANGE', tag: 'force.main_kN', value, unit: 'kN', reason: 'tablet hardness', ...extra });
    expect(set('12').refused).toBe('Set up the press of p@ first (TB10-NO-SETUP; PR-23)');
    w.rec(setup);
    expect(set('12', { tag: 'force.pre_kN' }).refused).toBe('force.pre_kN has no approved range in the MBR (TB10-SETTING-TAG; PR-08)');
    expect(set('12', { unit: 'N' }).refused).toBe('force.main_kN is set in kN (TB10-SETTING-UNIT; PR-08)');
    expect(set('10.0').data).toStrictEqual({ tag: 'force.main_kN', value: '10.0', unit: 'kN', reason: 'tablet hardness', withinRange: true, changedBy: 'OP1' });
    expect(set('15.0').exceptions).toBeUndefined();
    expect(set('9.99').exceptions).toEqual([
      { type: 'SETTING_OUT_OF_RANGE', title: 'force.main_kN was set to 9.99 kN at p@, outside the approved 10.0 to 15.0: the steps after it wait for a deviation', controls: ['PR-08', 'PR-23'], severity: 'ACTION', category: 'OUT_OF_LIMIT', blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true, item: 'force.main_kN' },
    ]);
    expect(set('15.01').data?.['withinRange']).toBe(false);
    expect(w.rec({ kind: 'OTHER' }).refused).toBe('OTHER is not an entry of a press set-up step (TB10-ENTRY; PR-23)');
  });

  it('[PR-23][INV-24][IN-26][IN-35] PERFORMED: set up, the checklist in order, a charge and a passing last first-off check', () => {
    const w = new World();
    expect(w.before()).toEqual([
      'The press of p@ is not set up (TB10-NO-SETUP; PR-23, INV-24)',
      'The pre-use checklist is not all in order (TB10-CHECKLIST-OPEN; PR-23)',
      'No container was charged into the hopper by scan (TB10-NOT-CHARGED; IN-26)',
      'Routine compression starts only after a passing first-off check (TB10-FIRST-OFF; IN-35, PR-23)',
    ]);
    w.rec(setup);
    w.rec(checklist(allOk));
    w.rec({ kind: 'HOPPER_CHARGE', chargeId: U(3) });
    w.rec({ kind: 'FIRST_OFF', result: 'PASS' });
    expect(w.before()).toEqual([]);
    w.rec({ kind: 'FIRST_OFF', result: 'FAIL' });
    expect(w.before()).toEqual(['Routine compression starts only after a passing first-off check (TB10-FIRST-OFF; IN-35, PR-23)']);
  });

  it('[PR-08][PR-22][PR-23] definition checks: a press used, each setting range once and ordered (equal allowed)', () => {
    const P = (config: Json, extra: Partial<flow.PhaseNode> = {}) => {
      const p = fixturePhase(TB10, { ...extra, config: config as never });
      const check = TB10.checkConfig as (p: flow.PhaseNode, c: Json, m: flow.MbrContent) => { code: string; message: string; controls: readonly string[] }[];
      return check(p, p.config as Json, blockMbr(TB10, p)).filter((x) => x.code.startsWith('TB10')).map((x) => `${x.code} [${x.controls.join(',')}] ${x.message}`);
    };
    expect(P({})).toEqual([]);
    expect(P({}, { equipment: [{ ref: 'PRESS', use: 'STATUS_CHECK' }] })).toEqual(['TB10-NO-EQUIPMENT [PR-23,PR-22] Press set-up step p names no press it uses']);
    const r = { tag: 'force.main_kN', unit: 'kN', min: '10.0', max: '15.0' };
    expect(P({ settingRanges: [r, r] })).toEqual(['TB10-DUPLICATE-SETTING [PR-08] Press set-up step p lists a setting range twice']);
    expect(P({ settingRanges: [{ ...r, min: '15.1' }] })).toEqual(['TB10-SETTING-RANGE [PR-08] The approved range of force.main_kN at p has its minimum above its maximum']);
    expect(P({ settingRanges: [{ ...r, min: '15.0' }] })).toEqual([]);
    expect(P({ settingRanges: [{ ...r, max: 'x' }] })).toEqual(['TB10-SETTING-RANGE [PR-08] The approved range of force.main_kN at p has its minimum above its maximum']);
    expect(settingRangesOf({ settingRanges: [r, 'x'] })).toEqual([r]);
    expect(settingRangesOf({})).toEqual([]);
  });
});
