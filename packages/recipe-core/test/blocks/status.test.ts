/**
 * G-09@1 "Equipment status (manual attestation)" and G-10@1 "Clearance checklist" (module C3; Phase 2 apps
 * plan section 7; decision D3): SANDBOX_ONLY block versions. `defineBatch` refuses them for a GMP
 * installation (DI-05, INV-18); in the sandbox they record a person's attestation, block on a failed check
 * until QA decides, and accept `config: {}` with their default lists.
 */
import { describe, expect, it } from 'vitest';
import { G09, G10 } from '../../src/blocks/generic/status.ts';
import { genericBlockRegistry } from '../../src/blocks/generic/index.ts';
import { validateSchema } from '../../src/blocks/schema.ts';
import { defineBatch, EngineDefinitionError } from '../../src/engine/definition.ts';
import { expr, loadFixture, mbrWith, phase } from '../flow/support.ts';
import { define, OP1, QA1, Run, sig, SUP1, testRegistry, VER1 } from '../engine/support.ts';

const BAL = { ref: 'BAL', use: 'STATUS_CHECK' as const };
const yes = (ids = ['CALIBRATED', 'DAILY_CHECK', 'CLEAN']) => ids.map((id) => ({ id, answer: 'YES' }));
const confirmed = (ids = ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL']) => ids.map((id) => ({ id, answer: 'CONFIRMED' }));

function statusMbr(config: Record<string, unknown> = {}) {
  return mbrWith({ kind: 'sequence', id: 'ops', children: [phase('st', { block: { type: 'G-09', version: '1' }, config: config as never, equipment: [BAL, { ref: 'MIX', use: 'STATUS_CHECK' }] }), phase('after')] });
}

function clearanceMbr(config: Record<string, unknown> = {}) {
  return mbrWith({ kind: 'sequence', id: 'ops', children: [phase('cl', { block: { type: 'G-10', version: '1' }, config: config as never, significant: true }), phase('after')] });
}

function codes(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof EngineDefinitionError) return [...new Set(e.problems.map((p) => p.code))];
    throw e;
  }
  return [];
}

describe('G-09@1 and G-10@1 are sandbox only (decision D3)', () => {
  it('[DI-05][INV-18] defineBatch refuses G-09@1 and G-10@1 for a GMP installation, by default and explicitly, and names Phase 3', () => {
    for (const mbr of [statusMbr(), clearanceMbr()]) {
      expect(codes(() => defineBatch(mbr, { registry: genericBlockRegistry(), expressions: expr }))).toEqual(['ENG-DEF-SANDBOX-ONLY']);
      expect(codes(() => defineBatch(mbr, { registry: genericBlockRegistry(), expressions: expr, installation: 'GMP' }))).toEqual(['ENG-DEF-SANDBOX-ONLY']);
      expect(codes(() => defineBatch(mbr, { registry: genericBlockRegistry(), expressions: expr, installation: 'SANDBOX' }))).toEqual([]);
    }
    try {
      defineBatch(clearanceMbr(), { registry: genericBlockRegistry(), expressions: expr });
      expect.unreachable();
    } catch (e) {
      const p = (e as EngineDefinitionError).problems[0];
      expect(p?.message).toMatch(/runs only in the sandbox/);
      expect(p?.message).toMatch(/Phase 3/);
      expect(p?.controls).toEqual(['DI-05', 'INV-18']);
    }
  });

  it('[DI-05][INV-18] both tablet fixtures are refused for GMP at every G-09 and G-10 step, and defined for the sandbox', () => {
    for (const name of ['tablet-granulation-compression', 'tablet-blister-packaging'] as const) {
      const mbr = loadFixture(name);
      try {
        defineBatch(mbr, { registry: testRegistry(), expressions: expr, justifications: [{ key: 'G07-TOLERANCE-MISSING@p-disp-api', text: 'fixture', by: 'TEST' }] });
        expect.unreachable();
      } catch (e) {
        const problems = (e as EngineDefinitionError).problems;
        expect([...new Set(problems.map((p) => p.code))]).toEqual(['ENG-DEF-SANDBOX-ONLY']);
        expect(problems.every((p) => /G-(09|10)@1/.test(p.message))).toBe(true);
      }
    }
  });

  it('[DI-10] both versions accept an empty configuration (the fixtures pin config {}) and refuse unknown fields', () => {
    for (const b of [G09, G10]) {
      expect(validateSchema(b.configSchema as NonNullable<typeof b.configSchema>, {})).toEqual([]);
      expect(validateSchema(b.configSchema as NonNullable<typeof b.configSchema>, { colour: 'blue' }).map((p) => p.path)).toEqual(['$.colour']);
    }
  });
});

describe('G-09@1 Equipment status (manual attestation)', () => {
  it('[DI-34] every STATUS_CHECK equipment needs its attestation before the step can be signed as performed', () => {
    const run = Run.issue(define(statusMbr()));
    run.start('st');
    run.entry('st', { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'LBL-1', answers: yes() });
    expect(run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'st', signature: sig('PERFORMED', OP1) }, 'G09-INCOMPLETE').message).toMatch(/MIX/);
    run.entry('st', { kind: 'EQUIPMENT_STATUS', equipmentRef: 'MIX', labelId: 'LBL-2', answers: yes() });
    run.perform('st');
    run.verify('st');
    expect(run.status('st')).toBe('COMPLETED');
    expect(run.exceptions()).toEqual([]);
  });

  it('[DI-34] an attestation of equipment the step does not check, or with a check missing, duplicated or unknown, is refused', () => {
    const run = Run.issue(define(statusMbr()));
    run.start('st');
    const entry = (e: Record<string, unknown>) => run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'st', entry: { kind: 'EQUIPMENT_STATUS', labelId: 'LBL-1', ...e } });
    expect(entry({ equipmentRef: 'PRESS', answers: yes() }).refusal?.code).toBe('G09-EQUIPMENT');
    expect(entry({ equipmentRef: 'BAL', answers: yes(['CALIBRATED', 'CLEAN']) }).refusal?.code).toBe('G09-ANSWERS');
    expect(entry({ equipmentRef: 'BAL', answers: [...yes(), { id: 'CLEAN', answer: 'YES' }] }).refusal?.code).toBe('G09-ANSWERS');
    expect(entry({ equipmentRef: 'BAL', answers: [...yes(), { id: 'OILED', answer: 'YES' }] }).refusal?.code).toBe('G09-ANSWERS');
    expect(entry({ equipmentRef: 'BAL', answers: yes().map((a) => ({ ...a, answer: 'MAYBE' })) }).refusal?.code).toBe('ENG-ENTRY-SCHEMA');
    expect(Object.keys(run.state.entries)).toEqual([]);
  });

  it('[DI-34] any NO raises EQUIPMENT_STATUS_FAILED that stops the step and the steps after it until QA dispositions it', () => {
    const run = Run.issue(define(statusMbr()));
    run.start('st');
    run.entry('st', { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'LBL-1', answers: [{ id: 'CALIBRATED', answer: 'NO' }, ...yes(['DAILY_CHECK', 'CLEAN'])] });
    run.entry('st', { kind: 'EQUIPMENT_STATUS', equipmentRef: 'MIX', labelId: 'LBL-2', answers: yes() });
    const [ex] = run.exceptions('EQUIPMENT_STATUS_FAILED');
    expect(ex).toMatchObject({ severity: 'ACTION', qaOnly: true, block: { until: 'DISPOSITION' } });
    run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'st', signature: sig('PERFORMED', OP1) }, 'ENG-BLOCKED');
    // A supervisor cannot lift it; QA can.
    run.refused({ type: 'DISPOSITION_EXCEPTION', actor: SUP1, exception: ex?.id ?? '', outcome: 'NO_IMPACT', justification: 'recalibrated', signature: sig('EXCEPTION_DISPOSITIONED', SUP1) }, 'ENG-ROLE');
    run.ok({ type: 'DISPOSITION_EXCEPTION', actor: QA1, exception: ex?.id ?? '', outcome: 'NO_IMPACT', justification: 'balance recalibrated and checked again', signature: sig('EXCEPTION_DISPOSITIONED', QA1) });
    run.perform('st');
    run.verify('st');
    expect(run.status('st')).toBe('COMPLETED');
  });
});

describe('G-10@1 Clearance checklist', () => {
  it('[DI-34] the checklist and the previous batch are both needed; the performer signs LINE_CLEARANCE_PERFORMED and an independent checker LINE_CLEARANCE_VERIFIED', () => {
    const run = Run.issue(define(clearanceMbr()));
    run.start('cl');
    run.entry('cl', { kind: 'CLEARANCE_CHECK', answers: confirmed() });
    expect(run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'cl', signature: sig('LINE_CLEARANCE_PERFORMED', OP1) }, 'G10-INCOMPLETE').message).toMatch(/previous batch/);
    run.entry('cl', { kind: 'PREVIOUS_BATCH', product: 'Ibuprofen 400 mg tablets', batchNumber: 'TEST-B26-0007' });
    run.perform('cl', [], OP1, 'LINE_CLEARANCE_PERFORMED');
    expect(run.status('cl')).toBe('AWAITING_VERIFICATION');
    // INV-03: the performer never verifies their own clearance.
    run.refused({ type: 'VERIFY', actor: OP1, step: 'cl', signature: sig('LINE_CLEARANCE_VERIFIED', OP1) }, 'ENG-ROLE');
    run.verify('cl', [], VER1, 'LINE_CLEARANCE_VERIFIED');
    expect(run.status('cl')).toBe('COMPLETED');
  });

  it('[DI-34] a clearance always needs a second person: an MBR clearance step without a checker cannot be defined', () => {
    const mbr = mbrWith({ kind: 'sequence', id: 'ops', children: [phase('cl', { block: { type: 'G-10', version: '1' }, signatures: { perform: { role: 'OPERATOR' } }, significant: true })] });
    expect(codes(() => define(mbr))).toEqual(['G10-NO-CHECKER']);
  });

  it('[DI-34] NOT_APPLICABLE only where the item allows it; every item answered exactly once', () => {
    const cfg = { checklist: [{ id: 'AREA', text: 'Area empty', expected: 'CONFIRMED' }, { id: 'PRINTER', text: 'Printer cleared', expected: 'CONFIRMED_OR_NOT_APPLICABLE' }] };
    const run = Run.issue(define(clearanceMbr(cfg)));
    run.start('cl');
    const check = (answers: { id: string; answer: string }[]) => run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'cl', entry: { kind: 'CLEARANCE_CHECK', answers } });
    expect(check([{ id: 'AREA', answer: 'NOT_APPLICABLE' }, { id: 'PRINTER', answer: 'CONFIRMED' }]).refusal?.code).toBe('G10-NOT-APPLICABLE');
    expect(check([{ id: 'AREA', answer: 'CONFIRMED' }]).refusal?.code).toBe('G10-ANSWERS');
    expect(check([{ id: 'AREA', answer: 'CONFIRMED' }, { id: 'PRINTER', answer: 'NOT_APPLICABLE' }]).accepted).toBe(true);
  });

  it('[DI-34] NOT_CONFIRMED raises CLEARANCE_FAILED, which stops the clearance and everything after it until QA dispositions it', () => {
    const run = Run.issue(define(clearanceMbr()));
    run.start('cl');
    run.entry('cl', { kind: 'CLEARANCE_CHECK', answers: [{ id: 'NO_PREVIOUS_MATERIAL', answer: 'NOT_CONFIRMED' }, ...confirmed(['NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'])] });
    run.entry('cl', { kind: 'PREVIOUS_BATCH', product: 'Ibuprofen 400 mg tablets', batchNumber: 'TEST-B26-0007' });
    const [ex] = run.exceptions('CLEARANCE_FAILED');
    expect(ex).toMatchObject({ qaOnly: true, block: { until: 'DISPOSITION' } });
    run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'cl', signature: sig('LINE_CLEARANCE_PERFORMED', OP1) }, 'ENG-BLOCKED');
    // The area is cleaned again and checked again; QA decides on the failed check.
    run.entry('cl', { kind: 'CLEARANCE_CHECK', answers: confirmed() });
    run.ok({ type: 'DISPOSITION_EXCEPTION', actor: QA1, exception: ex?.id ?? '', outcome: 'NO_IMPACT', justification: 'area cleaned again and the checklist confirmed', signature: sig('EXCEPTION_DISPOSITIONED', QA1) });
    run.perform('cl', [], OP1, 'LINE_CLEARANCE_PERFORMED');
    run.verify('cl', [], VER1, 'LINE_CLEARANCE_VERIFIED');
    expect(run.status('cl')).toBe('COMPLETED');
    // The failing check stays in the record (never deleted).
    expect(run.exceptions('CLEARANCE_FAILED')).toHaveLength(1);
  });
});
