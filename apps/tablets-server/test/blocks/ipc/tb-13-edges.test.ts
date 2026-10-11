/**
 * TB-13@1 tablet physical IPC (tablets spec IN-35) at its edges, through its exported handlers with a minimal view: the
 * tablet count and parameters, the appearance list, individual and mean limits per parameter, breaking force in N or kp,
 * the definition checks and the nominal values. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks } from '@ebmr/recipe-core/pure';
import { acceptPhysicalCheck, examined, physicalConfigProblems, physicalNominal, TB13 } from '../../../src/blocks/tb-13.ts';

type Json = Record<string, unknown>;
const NOW = 1_800_000_000_000_000n;
const view = (config: Json, entries: { kind: string }[] = []): blocks.HandlerView =>
  ({
    phase: { block: { type: 'TB-13', version: '1' } },
    config,
    stepKey: 'p@',
    nowUs: NOW,
    entries: (kind?: string) => entries.filter((x) => kind === undefined || x.kind === kind).map((x, i) => ({ id: `E${i}`, data: {}, recordedAt: NOW, ...x })),
    batch: { marketSet: ['IN'] },
    actor: { id: 'OP1' },
  }) as unknown as blocks.HandlerView;
const R = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${(i + 1).toString().padStart(12, '0')}`);
const cfg: Json = {
  n: 2,
  thickness: { individual: { action: { min: '3.2', max: '3.6' } } },
  hardness: { unit: 'N', mean: { action: { min: '60' }, alert: { min: '75' } } },
};
const check = (tablets: Json[], extra: Json = {}): Json & { kind: string } => ({ kind: 'PHYSICAL_CHECK', instrument: 'HT', capture: 'DEVICE', readings: R(tablets.length * 2), tablets, ...extra });
const res = (c: Json, entry: Json & { kind: string }) => {
  const r = acceptPhysicalCheck(view(c), entry);
  return r.ok ? r.t.data : r.problems.map((p) => p.message).join(' | ');
};

describe('TB-13 physical checks', () => {
  it('[IN-35][PR-29][DI-32] the MBR\'s count of tablets, each with exactly the examined parameters', () => {
    expect(res(cfg, check([{ thickness: '3.4', hardness: '80' }]))).toBe('This check examines 2 tablets, not 1 (TB13-COUNT; PR-29, IN-35)');
    expect(res(cfg, check([{ thickness: '3.4', hardness: '80' }, { thickness: '3.4' }]))).toBe('Each tablet gives exactly the parameters the MBR examines (thickness, hardness) (TB13-PARAMETERS; PR-29, DI-32)');
    expect(res(cfg, check([{ thickness: '3.4', hardness: '80' }, { thickness: '3.4', diameter: '9' }]))).toMatch(/TB13-PARAMETERS/);
    expect(res(cfg, check([{ thickness: '3.4', hardness: '80' }, { thickness: '3.4', hardness: '80', diameter: '9' }]))).toMatch(/TB13-PARAMETERS/);
    expect(res({ n: 1, defects: ['CAPPING'] }, check([{ thickness: '3' }], { defects: [], readings: undefined, capture: 'MANUAL' }))).toBe('Each tablet gives exactly the parameters the MBR examines (none) (TB13-PARAMETERS; PR-29, DI-32)');
    expect(res(cfg, check([{ thickness: '3.4', hardness: '80' }, { thickness: '3.4', hardness: '80' }], { readings: R(2) }))).toMatch(/one claimed reading per value \(4\)/);
  });

  it('[IN-35][PR-29] appearance: listed (empty when none) only where the MBR examines it, each defect once and from the MBR\'s list; a defect fails the check', () => {
    const app = { ...cfg, defects: ['CAPPING', 'STICKING'] };
    const ok = [{ thickness: '3.4', hardness: '80' }, { thickness: '3.4', hardness: '80' }];
    expect(res(app, check(ok))).toBe('The MBR examines appearance: list the defects observed (an empty list when none) (TB13-APPEARANCE; IN-35, PR-29)');
    expect(res(cfg, check(ok, { defects: [] }))).toBe('The MBR examines no appearance at this check (TB13-APPEARANCE; IN-35, PR-29)');
    expect(res(app, check(ok, { defects: ['CAPPING', 'CAPPING'] }))).toBe('The defects observed are listed once each, from the defects the MBR examines (TB13-APPEARANCE; IN-35)');
    expect(res(app, check(ok, { defects: ['CHIPPING'] }))).toBe('The defects observed are listed once each, from the defects the MBR examines (TB13-APPEARANCE; IN-35)');
    expect(res(app, check(ok, { defects: [] }))).toMatchObject({ defects: [], result: 'PASS', evaluation: { appearance: { defects: [], result: 'PASS' } } });
    expect(res(app, check(ok, { defects: ['STICKING'] }))).toMatchObject({ defects: ['STICKING'], result: 'FAIL', evaluation: { appearance: { defects: ['STICKING'], result: 'FAIL' } } });
    expect(res(cfg, check(ok))).not.toHaveProperty('defects');
  });

  it('[IN-35][PR-29][PR-08] each parameter is judged on its individual and its mean limits, the worst deciding; breaking force in N, or in kp converted to N', () => {
    // Thickness individual 3.2 to 3.6: 3.61 fails; the hardness mean 74.5 is below its alert limit.
    expect(res(cfg, check([{ thickness: '3.4', hardness: '74' }, { thickness: '3.61', hardness: '75' }]))).toMatchObject({
      result: 'FAIL',
      evaluation: { thickness: { unit: 'mm', mean: '3.5050', min: '3.4', max: '3.61', result: 'FAIL' }, hardness: { unit: 'N', mean: '74.5000', result: 'ALERT' } },
    });
    expect(res(cfg, check([{ thickness: '3.2', hardness: '75' }, { thickness: '3.6', hardness: '75' }]))).toMatchObject({ result: 'PASS' });
    expect(res(cfg, check([{ thickness: '3.4', hardness: '59' }, { thickness: '3.4', hardness: '60' }]))).toMatchObject({ evaluation: { hardness: { result: 'FAIL' } } });
    const kp = { ...cfg, hardness: { unit: 'kp', individual: { action: { min: '60' } } } };
    // 6 kp = 58.8399 N < 60 N.
    expect(res(kp, check([{ thickness: '3.4', hardness: '6' }, { thickness: '3.4', hardness: '7' }]))).toMatchObject({ evaluation: { hardness: { unit: 'N', min: '58.8399', max: '68.64655', result: 'FAIL' } } });
    expect(res({ ...cfg, hardness: { unit: 'N', individual: { action: { min: '6' } } } }, check([{ thickness: '3.4', hardness: '6' }, { thickness: '3.4', hardness: '7' }]))).toMatchObject({ evaluation: { hardness: { min: '6', max: '7', result: 'PASS' } } });
    // Thickness is never converted, whatever the hardness unit.
    expect(res(kp, check([{ thickness: '3.4', hardness: '7' }, { thickness: '3.4', hardness: '7' }]))).toMatchObject({ evaluation: { thickness: { min: '3.4', max: '3.4', result: 'PASS' } } });
  });

  it('[IN-35][PR-29] the step refuses other entries and needs a check before PERFORMED', () => {
    const accept = TB13.handler?.acceptEntry as (v: blocks.HandlerView, e: Json & { kind: string }) => { problems?: { message: string }[] };
    expect(accept(view(cfg), { kind: 'OTHER' }).problems?.map((p) => p.message)).toEqual(['OTHER is not an entry of a physical check step (TB13-ENTRY; PR-29)']);
    const before = TB13.handler?.beforePerform as (v: blocks.HandlerView) => { message: string }[];
    expect(before(view(cfg)).map((p) => p.message)).toEqual(['p@ has no physical check (TB13-NO-CHECK; PR-29, IN-35)']);
    expect(before(view(cfg, [{ kind: 'PHYSICAL_CHECK' }]))).toEqual([]);
  });

  it('[PR-29][IN-35] definition checks: something examined, limits for each parameter, each tier well formed', () => {
    const P = (c: Json) => physicalConfigProblems('X', c).map((p) => `${p.code} [${p.controls.join(',')}] ${p.message}`);
    expect(P(cfg)).toEqual([]);
    expect(P({ n: 2 })).toEqual(['TB13-NOTHING [PR-29] X examines no parameter and no appearance']);
    expect(P({ n: 2, defects: ['CAPPING'] })).toEqual([]);
    expect(P({ n: 2, thickness: {} })).toEqual(['TB13-LIMITS [PR-29,IN-35] X: thickness has no limits']);
    expect(P({ n: 2, thickness: { mean: { action: { min: '3' } } } })).toEqual([]);
    expect(P({ n: 2, thickness: { individual: { action: { min: '4', max: '3' } }, mean: { action: { min: '4', max: '3' } } } })).toEqual([
      'TB13-LIMITS [PR-29] X: thickness individual has a lower limit above its upper limit',
      'TB13-LIMITS [PR-29] X: thickness mean has a lower limit above its upper limit',
    ]);
    expect(examined({ hardness: {}, thickness: {}, diameter: 'x' })).toEqual(['thickness', 'hardness']);
  });

  it('[DI-34] nominal values sit in the middle of the action limits (one-sided limits at the limit; kp converted back), two decimals', () => {
    const tablets = (c: Json) => (physicalNominal(c, undefined)[0]?.['tablets'] as Json[])[0];
    expect(tablets(cfg)).toEqual({ thickness: '3.40', hardness: '60.00' });
    expect(tablets({ n: 1, hardness: { unit: 'kp', individual: { action: { min: '60', max: '120' } } } })).toEqual({ hardness: '9.18' });
    expect(tablets({ n: 1, thickness: { individual: { action: { max: '4' } } } })).toEqual({ thickness: '4.00' });
    expect(tablets({ n: 1, thickness: { mean: { action: { min: '3', max: '5' } } } })).toEqual({ thickness: '4.00' });
    const nom = physicalNominal({ n: 2, thickness: { individual: { action: { min: '3', max: '4' } } } }, 'S1')[0];
    expect(nom).toMatchObject({ capture: 'DEVICE', stream: 'S1', readings: R(2).map((_, i) => `00000000-0000-4000-8000-${(i + 101).toString().padStart(12, '0')}`) });
    expect(nom).not.toHaveProperty('defects');
    const manual = physicalNominal({ n: 1, defects: ['CAPPING'] }, undefined)[0];
    expect(manual).toMatchObject({ capture: 'MANUAL', defects: [] });
    expect(manual).not.toHaveProperty('readings');
    expect(manual).not.toHaveProperty('stream');
    expect(physicalNominal({ thickness: { individual: { action: { min: '3', max: '4' } } } }, undefined)[0]?.['tablets']).toHaveLength(1);
  });
});
