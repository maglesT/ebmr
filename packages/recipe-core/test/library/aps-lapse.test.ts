/**
 * INV-23 (c) (lead ruling, 15 November 2026): a lapse of the filling line's APS validity during the fill refuses no later
 * entry; at the step's sign-off the engine raises an ACTION exception that requires a deviation (LIB_APS_LAPSED), from
 * the validity the server read and stated in the command (PerformFacts). Schedule M Part II 5.5 and 21 CFR 211.113(b),
 * paraphrased: the aseptic process is validated by process simulations repeated at set intervals. The database refuses
 * the sign-off without it (tablets 1915, EBMR-PLANT-094; apps/tablets-server/test/injectables/aps-interval-gate.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { libraryBlockType, libraryBlockVersion, type BlockDefinition, type BlockUse } from '../../src/library/index.ts';
import { apsLapseExceptions } from '../../src/library/block-version.ts';
import type { PerformFacts } from '../../src/engine/types.ts';
import { performMeaning } from '../../src/engine/actions.ts';
import { prepareForSignature } from '../../src/engine/engine.ts';
import { define, MIN, OP1, QA1, Run, sig, SUP1, T0, testRegistry } from '../engine/support.ts';
import { expr, mbrWith, phase } from '../flow/support.ts';

const fill = (category: BlockDefinition['category'] = 'PROCESS'): BlockDefinition => ({
  code: 'FILL-LINE',
  version: 1,
  title: 'Aseptic filling',
  category,
  sections: [
    { id: 'setup', title: 'Set-up', fields: [{ id: 'line', label: 'Filling line', type: 'EQUIPMENT', kind: 'LINE', classSlot: 'lineClass' }, { id: 'pump', label: 'Pump', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'pumpClass' }] },
    { id: 'count', title: 'Count', fields: [{ id: 'filled', label: 'Units filled', type: 'TEXT' }] },
  ],
  signatures: [{ meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' }],
});
const use: BlockUse = { block: { code: 'FILL-LINE', version: 1 }, equipmentClasses: { lineClass: 'EQC-FILL', pumpClass: 'EQC-PUMP' } };

function runFor(def: BlockDefinition): Run {
  const p = phase('p', { block: { type: libraryBlockType(def.code), version: String(def.version) }, config: { equipmentClasses: use.equipmentClasses } as never });
  const d = define(mbrWith({ kind: 'sequence', id: 'ops', children: [p, phase('after')] }), { registry: testRegistry().extend(libraryBlockVersion(def, expr)) });
  const run = Run.issue(d, { inputs: {} }, T0);
  run.start('p');
  run.entry('p', { kind: 'setup', line: 'FL-1', pump: 'PU-1', equipment: { line: { code: 'FL-1', classCode: 'EQC-FILL', fitness: 'QUALIFIED' }, pump: { code: 'PU-1', classCode: 'EQC-PUMP', fitness: 'QUALIFIED' } } });
  run.minutes(30);
  run.entry('p', { kind: 'count', filled: '1000' });
  return run;
}

const signWith = (run: Run, facts?: PerformFacts) =>
  run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig(performMeaning(run.def, 'p'), OP1), ...(facts !== undefined ? { facts } : {}) });

describe('the engine raises the APS lapse at the filling step\'s sign-off (INV-23 (c))', () => {
  it('[INV-23] a line whose APS validity ended before the sign-off raises an ACTION exception requiring a deviation (QA only), naming the line, when the validity ended and the clauses; it holds the step and the steps after it until QA dispositions it under the linked deviation', () => {
    const run = runFor(fill());
    const until = run.nowUs - 10n * MIN;
    const first = signWith(run, { apsValidUntilUs: { 'FL-1': until } });
    expect(first.accepted).toBe(false);
    expect(first.refusal?.code).toBe('ENG-BLOCKED');
    const [x, ...more] = run.exceptions('LIB_APS_LAPSED');
    expect(more).toEqual([]);
    expect(x).toMatchObject({ severity: 'ACTION', category: 'TIME_LIMIT', deviationRequired: true, qaOnly: true, status: 'OPEN', controls: ['INV-23'], source: { stepKey: 'p@', item: 'p.line' }, block: { steps: ['p@'], until: 'DISPOSITION' } });
    expect(x!.block?.downstream).toBeDefined();
    expect(x!.raisedAt >= until).toBe(true);
    expect(x!.title).toMatch(/filling line FL-1 was valid until \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ, before the step's sign-off.*a deviation is required.*\(Schedule M Part II 5\.5; 21 CFR 211\.113\(b\)\)$/);
    // A second attempt on the same facts raises nothing new; the step waits for the disposition.
    expect(signWith(run, { apsValidUntilUs: { 'FL-1': until } }).accepted).toBe(false);
    expect(run.exceptions('LIB_APS_LAPSED')).toHaveLength(1);
    const QA = QA1;
    run.ok({ type: 'ATTACH_DEVIATION', actor: SUP1, exception: x!.id, deviationRef: 'DEV-26-001' });
    run.refused({ type: 'DISPOSITION_EXCEPTION', actor: QA, exception: x!.id, outcome: 'NO_IMPACT', justification: 'No impact', signature: sig('EXCEPTION_DISPOSITIONED', QA) }, 'ENG-DEVIATION-REQUIRED');
    run.ok({ type: 'DISPOSITION_EXCEPTION', actor: QA, exception: x!.id, outcome: 'DEVIATION_RAISED', justification: 'Deviation DEV-26-001 investigates the fill', signature: sig('EXCEPTION_DISPOSITIONED', QA) });
    expect(signWith(run, { apsValidUntilUs: { 'FL-1': until } }).accepted).toBe(true);
    expect(run.exceptions('LIB_APS_LAPSED')).toHaveLength(1);
  });

  it('[INV-23] a validity the server reads as none at all (null) is a lapse; one ending after the sign-off, a line the server does not list (out of scope) and a sign-off without facts raise nothing', () => {
    const none = runFor(fill());
    signWith(none, { apsValidUntilUs: { 'FL-1': null } });
    expect(none.exceptions('LIB_APS_LAPSED').map((e) => e.title)).toEqual([expect.stringMatching(/filling line FL-1 is no longer valid, before/)]);
    for (const facts of [{ apsValidUntilUs: { 'FL-1': 0n } }, { apsValidUntilUs: { 'FL-2': null } }, {}, undefined] as (PerformFacts | undefined)[]) {
      const run = runFor(fill());
      const ok = facts?.apsValidUntilUs?.['FL-1'] === 0n ? { apsValidUntilUs: { 'FL-1': run.nowUs + 1n } } : facts;
      expect(signWith(run, ok).accepted, JSON.stringify(ok, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).toBe(true);
      expect(run.exceptions('LIB_APS_LAPSED')).toEqual([]);
    }
  });

  it('[INV-23] the validity ends at the instant itself: a validity ending exactly at the sign-off is a lapse, one microsecond later is not', () => {
    const at = runFor(fill());
    signWith(at, { apsValidUntilUs: { 'FL-1': at.nowUs } });
    expect(at.exceptions('LIB_APS_LAPSED')).toHaveLength(1);
    const after = runFor(fill());
    expect(signWith(after, { apsValidUntilUs: { 'FL-1': after.nowUs + 1n } }).accepted).toBe(true);
  });

  it('[INV-23] the facts reach the engine through the PREPARE target as through the command: a lapse found when the signature is prepared is raised then, once', () => {
    const run = runFor(fill());
    const facts = { apsValidUntilUs: { 'FL-1': run.nowUs - 1n } };
    const prepared = prepareForSignature(run.def, run.state, { type: 'SIGN_PERFORMED', step: 'p', context: [], facts }, OP1, { nowUs: run.nowUs });
    expect(prepared.changed).toBe(true);
    expect(Object.values(prepared.state.exceptions).filter((e) => e.type === 'LIB_APS_LAPSED')).toHaveLength(1);
    run.state = prepared.state;
    expect(signWith(run, facts).accepted).toBe(false);
    expect(run.exceptions('LIB_APS_LAPSED')).toHaveLength(1);
  });

  it('[INV-23] only the line fields of a non-packaging block are read: a packaging block\'s line and an EQUIPMENT field of another kind raise nothing', () => {
    const view = (def: BlockDefinition, data: Record<string, unknown>) => ({
      phase: { kind: 'phase', id: 'p' } as never,
      nowUs: 100n,
      entries: (kind?: string) => (kind === 'setup' ? [{ data } as never] : []),
      exceptions: () => [],
      facts: { apsValidUntilUs: { 'FL-1': 50n, 'PU-1': 50n } },
    });
    expect(apsLapseExceptions(fill('PACKAGING'), view(fill('PACKAGING'), { line: 'FL-1' }))).toEqual([]);
    expect(apsLapseExceptions(fill(), view(fill(), { pump: 'PU-1' }))).toEqual([]);
    expect(apsLapseExceptions(fill(), view(fill(), { line: 'FL-1', pump: 'PU-1' })).map((e) => e.item)).toEqual(['p.line']);
    expect(apsLapseExceptions(fill(), { ...view(fill(), { line: 'FL-1' }), facts: {} })).toEqual([]);
  });

  it('[INV-23] one exception per lapsed line: two entries naming the same line raise one; a second lapsed line raises its own, also when the step already holds the first line\'s', () => {
    const def = fill();
    const view = (entries: Record<string, unknown>[], held: { type: string; title: string }[] = []) => ({
      phase: { kind: 'phase', id: 'p' } as never,
      nowUs: 100n,
      entries: (kind?: string) => (kind === 'setup' ? entries.map((data) => ({ data }) as never) : []),
      exceptions: () => held as never,
      facts: { apsValidUntilUs: { 'FL-1': 50n, 'FL-2': null } },
    });
    const twice = apsLapseExceptions(def, view([{ line: 'FL-1' }, { line: 'FL-1' }]));
    expect(twice.map((e) => e.title.match(/line (FL-\d)/)?.[1])).toEqual(['FL-1']);
    const both = apsLapseExceptions(def, view([{ line: 'FL-1' }, { line: 'FL-2' }]));
    expect(both.map((e) => e.title.match(/line (FL-\d)/)?.[1])).toEqual(['FL-1', 'FL-2']);
    // The step holds FL-1's exception: only FL-2's is raised; an exception of another type with the same text is not FL-1's.
    expect(apsLapseExceptions(def, view([{ line: 'FL-1' }, { line: 'FL-2' }], [both[0]!])).map((e) => e.title)).toEqual([both[1]!.title]);
    expect(apsLapseExceptions(def, view([{ line: 'FL-1' }], [{ type: 'OPERATOR_RAISED', title: both[0]!.title }]))).toHaveLength(1);
  });
});
