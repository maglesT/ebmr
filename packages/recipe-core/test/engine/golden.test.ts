/**
 * Golden runs (outline 9.1 golden batches): both tablet fixture MBRs executed end to end through the
 * engine with scripted data, checked for the completion order, the decisions, the derived values
 * (against the golden cases the MBR author confirmed), the exceptions and the evaluation records.
 */
import { Dec, verifyEvaluationRecord } from '@ebmr/expr';
import { describe, expect, it } from 'vitest';
import { step } from '../../src/engine/engine.ts';
import type { BatchDefinition } from '../../src/engine/definition.ts';
import type { EngineEvent } from '../../src/engine/types.ts';
import { decimalsOf } from '../../src/flow/decimal.ts';
import { autopilot, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, PACKAGING_SCENARIO, Run } from './support.ts';

function completionOrder(events: readonly EngineEvent[]): string[] {
  return events.flatMap((e) => (e.type === 'STEP_STATUS_CHANGED' && (e.to === 'COMPLETED' || e.to === 'NOT_APPLICABLE' || e.to === 'SKIPPED') ? [`${e.stepKey}${e.to === 'NOT_APPLICABLE' ? ' (N/A)' : ''}`] : []));
}

function decisions(events: readonly EngineEvent[]): string[] {
  return events.flatMap((e) => (e.type === 'DECISION_MADE' ? [`${e.decision}=${e.outcome}`] : []));
}

/** Every derived value equals the author's golden result to the decimals written (like the simulator's golden cases). */
function checkGoldenCases(def: BatchDefinition, run: Run): number {
  let checked = 0;
  for (const g of def.mbr.goldenCases) {
    for (const [calc, expected] of Object.entries(g.expected)) {
      if (!('value' in expected)) continue;
      const values = Object.values(run.state.derived).filter((d) => d.calculation === calc && d.status === 'CURRENT');
      const matches = values.some((d) => (d.value.kind === 'DECIMAL' || d.value.kind === 'COUNT') && Dec.parse(d.value.value).toFixed(decimalsOf(expected.value), 'HALF_UP') === expected.value);
      expect(matches, `${g.id}: ${calc} expected ${expected.value}, engine has ${values.map((d) => JSON.stringify(d.value)).join(', ')}`).toBe(true);
      checked += 1;
    }
  }
  return checked;
}

/** INV-25 / DI-33: every stored derived value is re-computable from its evaluation record. */
function checkRecords(def: BatchDefinition, run: Run): void {
  const byHash = Object.fromEntries(Object.values(run.state.derived).map((d) => [d.record.contentHash, d.record]));
  for (const d of Object.values(run.state.derived)) {
    const stepId = run.state.steps[d.stepKey]?.step ?? '';
    const prog = def.programs.get(`${d.calculation}@${stepId}`);
    expect(prog, `${d.calculation}@${stepId}`).toBeDefined();
    const v = verifyEvaluationRecord(prog?.program as NonNullable<typeof prog>['program'], d.record, { derived: byHash });
    expect(v.problems, `${d.id} ${d.calculation}`).toEqual([]);
  }
}

describe('golden run: granulation, drying loop, sub-lots, blending, compression (tablet-granulation-compression)', () => {
  const def = fixtureDefinition('tablet-granulation-compression');
  const run = Run.issue(def, { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
  const outcome = autopilot(run, GRANULATION_SCENARIO);

  it('[DI-34][INV-19] the batch completes, every step in MBR order, sub-lots one after the other, the drying loop per sub-lot', () => {
    expect(outcome).toBe('COMPLETE');
    expect(run.state.status).toBe('EXECUTION_COMPLETE');
    expect(run.state.marking.tokens.size).toBe(0);
    const sl = (n: number, ids: string[]): string[] => ids.map((i) => (i.endsWith(' (N/A)') ? `${i.slice(0, -6)}@R-SUBLOT=${n} (N/A)` : i.includes('@') ? i : `${i}@R-SUBLOT=${n}`));
    expect(completionOrder(run.events)).toEqual([
      'p-disp-clear@',
      'p-disp-bal@',
      'p-potency@',
      'p-disp-api@',
      'p-disp-exc@',
      'p-disp-kits@',
      'p-disp-recon@',
      ...sl(1, ['p-gran-clear', 'p-gran-status', 'p-charge', 'p-vessel-status', 'p-drymix', 'p-binder-prep', 'p-binder-add', 'p-extra-ipa (N/A)', 'p-wetmass', 'p-wet-out', 'p-fbd-load']),
      'p-drycycle@R-SUBLOT=1/L-DRY=1',
      'c-lod/lod-test@R-SUBLOT=1/L-DRY=1',
      'p-drycycle@R-SUBLOT=1/L-DRY=2',
      'c-lod/lod-test@R-SUBLOT=1/L-DRY=2',
      ...sl(1, ['H-OVERDRY (N/A)', 'p-gran-out', 'p-gran-yield']),
      ...sl(2, ['p-gran-clear', 'p-gran-status', 'p-charge', 'p-vessel-status', 'p-drymix', 'p-binder-prep', 'p-binder-add', 'p-extra-ipa', 'p-wetmass', 'p-wet-out', 'p-fbd-load']),
      'p-drycycle@R-SUBLOT=2/L-DRY=1',
      'c-lod/lod-test@R-SUBLOT=2/L-DRY=1',
      ...sl(2, ['H-OVERDRY (N/A)', 'p-gran-out', 'p-gran-yield']),
      'p-blend-clear@',
      'p-blend-status@',
      'p-blend-charge@',
      'p-blend@',
      'p-lube@',
      'p-bu-sample@',
      'p-blend-out@',
      'p-blend-yield@',
      'p-comp-clear@',
      'p-comp-status@',
      'p-comp-charge@',
      'p-first-off@',
      'p-compress@',
      'p-comp-out@',
      'p-comp-rejects@',
      'p-comp-yield@',
      'H-CORES@',
    ]);
  });

  it('[DI-34][INV-19] decisions: sub-lot count and IPA choice by a supervisor with a reason, loop outcomes and the over-dry branch from recorded data', () => {
    expect(decisions(run.events)).toEqual([
      'R-SUBLOT@=2',
      'ALT-IPA@R-SUBLOT=1=b-no-ipa',
      'L-DRY@R-SUBLOT=1/L-DRY=1=CONTINUE',
      'L-DRY@R-SUBLOT=1/L-DRY=2=EXIT',
      'ALT-OVERDRY@R-SUBLOT=1=b-dry-ok',
      'ALT-IPA@R-SUBLOT=2=b-extra-ipa',
      'L-DRY@R-SUBLOT=2/L-DRY=1=EXIT',
      'ALT-OVERDRY@R-SUBLOT=2=b-dry-ok',
    ]);
    const byPerson = Object.values(run.state.decisions).filter((d) => d.decidedBy !== 'SYSTEM');
    expect(byPerson.map((d) => d.construct).sort()).toEqual(['ALT-IPA', 'ALT-IPA', 'R-SUBLOT']);
    for (const d of byPerson) expect(d.reason?.length ?? 0).toBeGreaterThan(0);
    expect(Object.values(run.state.subLots).map((s) => s.id)).toEqual(['B0001-GS1', 'B0001-GS2']);
  });

  it('[INV-25][DI-33] derived values equal the golden cases of the MBR and each evaluation record re-verifies', () => {
    expect(checkGoldenCases(def, run)).toBe(12);
    checkRecords(def, run);
    const theo = Object.values(run.state.derived).find((d) => d.calculation === 'blendTheoretical');
    // The series of per-sub-lot dried quantities is read after the replicate section (validator README).
    expect(theo?.record.inputs.find((i) => i.path === 'driedNet')?.values).toEqual(['25.1', '24.95']);
  });

  it('[INV-19][INV-41][PR-08] every drying iteration is kept; the endpoint is judged at loop exit; an alert is a register item that blocks nothing', () => {
    const lod = Object.values(run.state.points).filter((p) => p.item === 'lod');
    expect(lod.map((p) => `${p.stepKey}=${p.value?.kind === 'DECIMAL' ? p.value.value : ''}:${p.evaluation?.requirement ?? ''}`).sort()).toEqual([
      'c-lod/lod-test@R-SUBLOT=1/L-DRY=1=5.20:ENDPOINT_IN_PROGRESS',
      'c-lod/lod-test@R-SUBLOT=1/L-DRY=2=3.10:NONE',
      'c-lod/lod-test@R-SUBLOT=2/L-DRY=1=3.45:REGISTER_ITEM',
    ]);
    const ex = run.exceptions();
    expect(ex.map((e) => `${e.type}:${e.tier ?? ''}:${e.severity}:${e.source.stepKey ?? ''}`)).toEqual(['LIMIT_BREACH:ALERT:ALERT:c-lod/lod-test@R-SUBLOT=2/L-DRY=1']);
    expect(ex[0]?.block).toBeUndefined();
    expect(ex[0]?.title).toContain('compared as 3.5');
  });

  it('[INV-03][PR-14] every checked step was verified by a person who neither performed nor entered data in it, and the involvement facts were emitted', () => {
    const involvement = run.events.filter((e) => e.type === 'INVOLVEMENT');
    expect(involvement.length).toBeGreaterThan(100);
    for (const inst of Object.values(run.state.steps)) {
      for (const s of inst.signatures.filter((x) => x.role === 'CHECKED')) {
        expect([...inst.performers, ...inst.dataEnterers, ...inst.correctors]).not.toContain(s.signer);
      }
    }
    const stages = run.events.filter((e) => e.type === 'STAGE_SIGNED_OFF');
    expect(stages.map((e) => (e.type === 'STAGE_SIGNED_OFF' ? `${e.stageKey}:${e.statement}` : ''))).toEqual([
      'S-DISP@:COMPLETED_PER_MBR',
      'S-GRAN@R-SUBLOT=1:COMPLETED_PER_MBR',
      'S-GRAN@R-SUBLOT=2:COMPLETED_WITH_DEVIATIONS',
      'S-BLEND@:COMPLETED_PER_MBR',
      'S-COMP@:COMPLETED_PER_MBR',
    ]);
  });

  it('[DI-34] the engine is a pure function: replaying the command log from the issued state gives the same state and events', () => {
    const again = Run.issue(def, { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
    let state = again.state;
    const events: EngineEvent[] = [...again.events];
    for (const { command, nowUs } of run.log) {
      const r = step(def, state, command, { nowUs });
      state = r.state;
      events.push(...r.events);
    }
    // State and events compared whole, bigints and maps included (review F29: the events were compared by count only).
    const ser = (x: unknown): string => JSON.stringify(x, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v instanceof Map ? [...v] : v));
    expect(ser(state)).toBe(ser(run.state));
    expect(events.length).toBeGreaterThan(0);
    expect(ser(events)).toBe(ser(run.events));
  });
});

describe('golden run: blister packaging order (tablet-blister-packaging)', () => {
  const def = fixtureDefinition('tablet-blister-packaging');

  it('[DI-34][INV-25] US export pack: serialisation branch taken from the issue variant, reconciliations computed, no exception', () => {
    const run = Run.issue(def, { inputs: FIXTURE_INPUTS['tablet-blister-packaging'], variants: { packDestination: 'US-EXPORT' } });
    expect(autopilot(run, PACKAGING_SCENARIO)).toBe('COMPLETE');
    expect(completionOrder(run.events)).toEqual([
      'p-pri-clear@',
      'p-line-check@',
      'p-pri-status@',
      'p-bulk-issue@',
      'p-foil-issue@',
      'p-blister@',
      'p-leak@',
      'p-blister-out@',
      'p-bulk-weigh@',
      'p-bulk-return@ (N/A)',
      'p-bulk-recon@',
      'p-sec-clear@',
      'p-sec-status@',
      'p-carton-issue@',
      'p-cartoning@',
      'p-cw-challenge@',
      'p-india-codes@ (N/A)',
      'p-serialise@',
      'p-carton-destroy@',
      'p-carton-recon@',
      'H-PACK@',
    ]);
    expect(decisions(run.events)).toEqual(['ALT-RETURN@=b-nothing-left', 'ALT-DESTINATION@=b-us']);
    expect(checkGoldenCases(def, run)).toBe(6);
    checkRecords(def, run);
    expect(run.exceptions()).toEqual([]);
    const line = run.inst('p-line-check');
    expect(line?.signatures.map((s) => `${s.role}:${s.meaning}:${s.signer}`)).toEqual(['PERFORMED:PERFORMED:VER1', 'CHECKED:WITNESSED:VER2']);
  });

  it('[DI-34] India-domestic pack: the India codes branch runs and serialisation is not applicable', () => {
    const run = Run.issue(def, { inputs: FIXTURE_INPUTS['tablet-blister-packaging'], variants: { packDestination: 'IN-DOMESTIC' } });
    expect(autopilot(run, PACKAGING_SCENARIO)).toBe('COMPLETE');
    expect(run.status('p-serialise')).toBe('NOT_APPLICABLE');
    expect(run.status('p-india-codes')).toBe('COMPLETED');
    const india = Object.values(run.state.points).find((p) => p.item === 'indiaCodesOk');
    expect(india?.source).toEqual({ mode: 'MANUAL', evidence: { kind: 'PHOTO', sha256: 'a'.repeat(64) } });
  });
});
