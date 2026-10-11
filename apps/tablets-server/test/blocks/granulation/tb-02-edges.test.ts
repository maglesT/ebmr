/**
 * TB-02@1 sifting, screening and milling with screen integrity (IN-36, INV-24, PR-23, PR-29) at its edges, through its
 * handler on a minimal view: the screen and its approved aperture, the check order (before, then after use), a damaged
 * screen never used again, the passes held since the last intact check, quantities never above the input, the oversize
 * and foreign matter, PERFORMED and the definition checks. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { screensOf, screenStates, TB02 } from '../../../src/blocks/tb-02.ts';
import { blockMbr, fixturePhase } from './support.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint; recordedSeq: number };
const CFG: Json = { equipmentClass: 'VIBRO_SIFTER', screens: [{ id: 'S1', aperture: { value: '425', unit: 'um' } }, { id: 'S2', aperture: { value: '1.0', unit: 'mm' } }] };
const um = (value: string, unit = 'um') => ({ value, unit });
const kg = (value: string) => ({ value, unit: 'kg' });

class World {
  entries: E[] = [];
  constructor(readonly config: Json = CFG) {}
  view(): blocks.HandlerView {
    return { phase: { id: 'p' }, config: this.config, stepKey: 'p@', nowUs: 0n, entries: (kind?: string) => this.entries.filter((x) => kind === undefined || x.kind === kind), actor: { id: 'OP1' } } as unknown as blocks.HandlerView;
  }
  rec(entry: Json & { kind: string }): { refused?: string; data?: Json; exceptions?: Json[]; verificationRequired?: boolean } {
    const accept = TB02.handler?.acceptEntry as (v: blocks.HandlerView, x: Json & { kind: string }) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: Json[]; verificationRequired?: boolean };
    const r = accept(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length + 1}`, kind: entry.kind, data: r.data ?? {}, recordedAt: 0n, recordedSeq: this.entries.length + 1 });
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}), ...(r.verificationRequired ? { verificationRequired: true } : {}) };
  }
  before(): string[] {
    return (TB02.handler?.beforePerform as (v: blocks.HandlerView) => { message: string }[])(this.view()).map((p) => p.message);
  }
}
const check = (screen: string, when: string, result = 'INTACT', aperture = screen === 'S2' ? um('1.00', 'mm') : um('425')) => ({ kind: 'SCREEN_CHECK', screen, aperture, when, result });
const pass = (screen: string, extra: Json = {}) => ({ kind: 'MATERIAL_PASS', screen, material: 'MAT-1', quantityIn: kg('10'), quantityOut: kg('9.8'), oversize: kg('0.2'), foreignMatter: false, ...extra });

describe('TB-02 screen checks', () => {
  it('[IN-36][PR-23] a check names a screen of the MBR at its approved aperture (equal value in the same unit)', () => {
    const w = new World();
    expect(w.rec(check('S9', 'BEFORE')).refused).toBe('S9 is not a screen the MBR lists for p (TB02-SCREEN; IN-36, PR-23)');
    expect(w.rec(check('S1', 'BEFORE', 'INTACT', um('0.425', 'mm'))).refused).toBe('Screen S1 reads 0.425 mm; the MBR approves 425 um (TB02-APERTURE; IN-36, PR-23)');
    expect(w.rec(check('S1', 'BEFORE', 'INTACT', um('426'))).refused).toMatch(/TB02-APERTURE/);
    expect(w.rec(check('S1', 'BEFORE', 'INTACT', um('x'))).refused).toMatch(/TB02-APERTURE/);
    expect(w.rec({ kind: 'SCREEN_CHECK', screen: 'S1', when: 'BEFORE', result: 'INTACT' }).refused).toBe('Screen S1 reads  ; the MBR approves 425 um (TB02-APERTURE; IN-36, PR-23)');
    expect(w.rec(check('S2', 'BEFORE'))).toStrictEqual({ data: { screen: 'S2', aperture: um('1.00', 'mm'), when: 'BEFORE', result: 'INTACT', checkedBy: 'OP1' }, verificationRequired: true });
    // An MBR aperture that is not decimal text matches nothing.
    expect(new World({ screens: [{ id: 'S1', aperture: { value: 'x', unit: 'um' } }] }).rec(check('S1', 'BEFORE', 'INTACT', um('x'))).refused).toMatch(/TB02-APERTURE/);
  });

  it('[IN-36][INV-24] checks alternate per screen (before, then after use); a screen found damaged is never used again', () => {
    const w = new World();
    expect(w.rec(check('S1', 'AFTER')).refused).toBe('Screen S1 was not checked before use (TB02-CHECK-ORDER; IN-36)');
    w.rec(check('S1', 'BEFORE'));
    expect(w.rec(check('S1', 'BEFORE')).refused).toBe('Screen S1 is in use; check it after use first (TB02-CHECK-ORDER; IN-36)');
    expect(screenStates(w.view()).get('S1')).toBe('IN_USE');
    w.rec(check('S1', 'AFTER'));
    expect(screenStates(w.view()).get('S1')).toBe('IDLE');
    expect(w.rec(check('S1', 'AFTER')).refused).toMatch(/was not checked before use/);
    const before = w.rec(check('S1', 'BEFORE', 'DAMAGED'));
    expect(before.exceptions).toEqual([{ type: 'SCREEN_DAMAGED', title: 'Screen S1 of p@ was found damaged before use: it is not used', controls: ['IN-36', 'PR-23'], severity: 'ALERT', category: 'DEVIATION_OR_OVERRIDE', blocks: 'NONE', item: 'S1' }]);
    expect(before.data).not.toHaveProperty('held');
    expect(screenStates(w.view()).get('S1')).toBe('DAMAGED');
    expect(w.rec(check('S1', 'BEFORE')).refused).toBe('Screen S1 was found damaged and is never used again (TB02-SCREEN-DAMAGED; IN-36, PR-23)');
    expect(w.rec(pass('S1')).refused).toBe('Screen S1 has no intact check before this use; check it first (TB02-NO-PRE-CHECK; IN-36, INV-24)');
  });

  it('[IN-36][INV-24][PR-29] a screen found damaged after use holds the passes made through it since its last intact check', () => {
    const w = new World();
    w.rec(check('S1', 'BEFORE'));
    w.rec(pass('S1'));
    w.rec(check('S1', 'AFTER'));
    w.rec(check('S1', 'BEFORE'));
    w.rec(check('S2', 'BEFORE'));
    w.rec(pass('S1'));
    w.rec(pass('S2'));
    w.rec(pass('S1'));
    const r = w.rec(check('S1', 'AFTER', 'DAMAGED'));
    expect(r.data?.['held']).toEqual(['E6', 'E8']);
    expect(r.exceptions).toEqual([
      {
        type: 'SCREEN_INTEGRITY_FAILED',
        title: 'Screen S1 of p@ was found damaged after use: the material passed through it since its last intact check (E6, E8) is held and the steps after it wait for a deviation',
        controls: ['IN-36', 'INV-24', 'PR-29'],
        severity: 'ACTION',
        category: 'DEVIATION_OR_OVERRIDE',
        blocks: 'DOWNSTREAM',
        until: 'DEVIATION',
        deviationRequired: true,
        item: 'S1',
      },
    ]);
    const none = new World();
    none.rec(check('S2', 'BEFORE'));
    expect(none.rec(check('S2', 'AFTER', 'DAMAGED')).exceptions?.[0]?.['title']).toBe('Screen S2 of p@ was found damaged after use: the material passed through it since its last intact check (none) is held and the steps after it wait for a deviation');
  });
});

describe('TB-02 material passes', () => {
  it('[PR-29][DI-29][IN-36] quantities out and oversize in the input\'s unit and never above it (equal allowed); the oversize recorded unless the MBR waives it; foreign matter described exactly when found', () => {
    const w = new World();
    w.rec(check('S1', 'BEFORE'));
    const q = 'The quantity out and the oversize are in the unit of the quantity in and never above it (TB02-QUANTITY; PR-29, DI-29)';
    expect(w.rec(pass('S1', { quantityOut: kg('10.1') })).refused).toBe(q);
    expect(w.rec(pass('S1', { quantityOut: { value: '9', unit: 'g' } })).refused).toBe(q);
    expect(w.rec(pass('S1', { oversize: kg('10.1') })).refused).toBe(q);
    expect(w.rec(pass('S1', { oversize: { value: '1', unit: 'g' } })).refused).toBe(q);
    expect(w.rec(pass('S1', { quantityIn: undefined })).refused).toBe(q);
    expect(w.rec(pass('S1', { quantityOut: undefined })).refused).toBe(q);
    expect(w.rec(pass('S1', { quantityOut: kg('10'), oversize: kg('10') })).data).toMatchObject({ quantityOut: kg('10'), oversize: kg('10') });
    expect(w.rec(pass('S1', { oversize: undefined })).refused).toBe('The MBR asks for the oversize retained on the screen to be examined and recorded (TB02-OVERSIZE; IN-36)');
    expect(w.rec(pass('S1', { foreignMatter: true })).refused).toBe('Foreign matter found is described; none found has no description (TB02-FOREIGN-MATTER; IN-36)');
    expect(w.rec(pass('S1', { foreignMatterDescription: 'hair' })).refused).toMatch(/TB02-FOREIGN-MATTER/);
    expect(w.rec(pass('S1', { lot: 'L-1' })).data).toStrictEqual({ screen: 'S1', material: 'MAT-1', lot: 'L-1', quantityIn: kg('10'), quantityOut: kg('9.8'), oversize: kg('0.2'), foreignMatter: false, recordedBy: 'OP1' });
    const found = w.rec(pass('S1', { foreignMatter: true, foreignMatterDescription: 'metal shard' }));
    expect(found.data).toMatchObject({ foreignMatter: true, foreignMatterDescription: 'metal shard' });
    expect(found.exceptions).toEqual([{ type: 'FOREIGN_MATTER_FOUND', title: 'Foreign matter in the residue of MAT-1 on screen S1 at p@: the steps after it wait for a deviation', controls: ['IN-36', 'PR-29'], severity: 'ACTION', category: 'DEVIATION_OR_OVERRIDE', blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true, item: 'S1' }]);
    const waived = new World({ ...CFG, oversizeExamination: false });
    waived.rec(check('S1', 'BEFORE'));
    const r = waived.rec(pass('S1', { oversize: undefined }));
    expect(r.data).not.toHaveProperty('oversize');
    expect(r.data).not.toHaveProperty('lot');
  });

  it('[IN-36][PR-29][INV-24] PERFORMED needs a pass and every screen checked after use', () => {
    const w = new World();
    expect(w.before()).toEqual(['p@ has no material pass (TB02-NOTHING-PROCESSED; IN-36, PR-29)']);
    w.rec(check('S1', 'BEFORE'));
    w.rec(check('S2', 'BEFORE'));
    w.rec(pass('S1'));
    expect(w.before()).toEqual(['Check screen S1, S2 after use before the step closes (TB02-AFTER-CHECK-MISSING; IN-36, INV-24)']);
    w.rec(check('S1', 'AFTER'));
    w.rec(check('S2', 'AFTER', 'DAMAGED'));
    expect(w.before()).toEqual([]);
  });
});

describe('TB-02 definition checks', () => {
  it('[IN-36][PR-23][INV-12] screens once each; a sifter or mill used and status-checked by a G-09 step of the MBR', () => {
    const P = (config: Json, extra: Partial<flow.PhaseNode> = {}, mbrOf: (p: flow.PhaseNode) => flow.MbrContent = (p) => blockMbr(TB02, p)) => {
      const p = fixturePhase(TB02, { ...extra, config: config as never });
      const chk = TB02.checkConfig as (p: flow.PhaseNode, c: Json, m: flow.MbrContent) => { code: string; message: string; controls: readonly string[] }[];
      return chk(p, p.config as Json, mbrOf(p)).filter((x) => x.code.startsWith('TB02')).map((x) => `${x.code} [${x.controls.join(',')}] ${x.message}`);
    };
    expect(P(CFG)).toEqual([]);
    expect(P({ screens: [{ id: 'A' }, { id: 'B' }, { id: 'A' }, { id: 'A' }] })).toEqual(['TB02-DUPLICATE-SCREEN [IN-36] Sifting step p lists screen A twice']);
    expect(P(CFG, { equipment: [] })).toEqual(['TB02-NO-EQUIPMENT [PR-23,IN-36] Sifting step p names no sifter or mill it uses']);
    expect(P(CFG, { equipment: [{ ref: 'SIFTER', use: 'USE' }, { ref: 'MILL', use: 'USE' }] })).toEqual(['TB02-EQUIPMENT-UNCHECKED [PR-23,INV-12] No equipment status step (G-09) of the MBR checks MILL, which sifting step p uses']);
    expect(screensOf({ screens: [{ id: 'A', aperture: 'x' }, 'y'] })).toEqual([{ id: 'A', aperture: { value: '', unit: '' } }]);
    expect(screensOf({})).toEqual([]);
  });
});
