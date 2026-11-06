/**
 * Capsules edition C7 (docs/build-plan/capsules/plan.md, section 3.3): soft gels II. A chewable, enteric-coated seamless
 * soft gel built from the ready-made catalogue (a chewable gel mass on SG-GEL-MASS, its hold as PROC-HOLD, seamless
 * encapsulation, fill and shell weight, drying, hardness, the enteric coat on the shared coating blocks, inspection,
 * printing, polishing and the rupture test on IPC-CAPS-DT) passes the formulation checks and runs to completion. Chewable
 * and enteric are data: the formula's lines and the existing blocks; no block of their own.
 */
import { describe, expect, it } from 'vitest';
import type { HoldPointNode, MbrContent } from '../../src/flow/model.ts';
import { checkBlockUse } from '../../src/library/index.ts';
import { CAPSULE_CATALOGUE, SEED_GROUPS } from '../../src/library/seed/index.ts';
import { define, QA1, Run, sig, T0 } from '../engine/support.ts';
import { expr } from '../flow/support.ts';
import { byCode as item, catalogueMaster, configOf, fieldOf, judgedRun, nominalRun, runNominalStep, useOf, type MasterStep } from './seed-support.ts';

const STEPS: readonly MasterStep[] = [
  { id: 'p-gel', code: 'SG-GEL-MASS', bomLines: { gelatinLine: 'BOM-GELATIN' } },
  { id: 'p-gel-hold', code: 'PROC-HOLD' },
  { id: 'p-encap', code: 'SG-ENCAP-SEAMLESS' },
  { id: 'p-fill-shell', code: 'IPC-SG-FILL-SHELL' },
  { id: 'p-dry', code: 'SG-DRY' },
  { id: 'p-hardness', code: 'IPC-SG-HARDNESS' },
  { id: 'p-ent-susp', code: 'COAT-SUSPENSION-PREP', bomLines: { coatingLine: 'BOM-ENTERIC' } },
  { id: 'p-ent-coat', code: 'COAT-ENTERIC' },
  { id: 'p-inspect', code: 'PROC-CAPS-INSPECT' },
  { id: 'p-print', code: 'PROC-CAPS-PRINT' },
  // The printed capsules wait for QC approval before going on (Schedule M Part VIII 6.2; the G-17 hold point, D-C3-2).
  { id: 'p-polish', code: 'PROC-CAPS-POLISH' },
  { id: 'p-dt', code: 'IPC-CAPS-DT' },
];

/** A chewable soft gel: the gel mass carries the chewable formula's sweetener and flavour as per-batch excipient lines. */
const BOM: MbrContent['bom'] = [
  { id: 'BOM-API', material: 'MAT-API', role: 'ACTIVE', quantity: { value: '5', unit: 'kg' } },
  { id: 'BOM-OIL', material: 'MAT-SOYBEAN-OIL', role: 'EXCIPIENT', quantity: { value: '45', unit: 'kg' } },
  { id: 'BOM-GELATIN', material: 'MAT-GELATIN-BOVINE', role: 'EXCIPIENT', quantity: { value: '30', unit: 'kg' } },
  { id: 'BOM-GLYCERIN', material: 'MAT-GLYCERIN', role: 'EXCIPIENT', quantity: { value: '12', unit: 'kg' } },
  { id: 'BOM-SORBITOL', material: 'MAT-SORBITOL', role: 'EXCIPIENT', quantity: { value: '8', unit: 'kg' } },
  { id: 'BOM-FLAVOUR', material: 'MAT-FLAVOUR-ORANGE', role: 'EXCIPIENT', quantity: { value: '0.5', unit: 'kg' } },
  { id: 'BOM-ENTERIC', material: 'MAT-METHACRYLIC-COPOLYMER', role: 'EXCIPIENT', quantity: { value: '6', unit: 'kg' } },
];

/** The QA hold point after printing (G-17). */
const PRINT_HOLD: HoldPointNode = { kind: 'holdPoint', id: 'h-print', name: 'Printed capsules approved by QC', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] };

/** The master: the steps in order, with the hold point right after printing. */
const NODES = STEPS.flatMap((s) => (s.id === 'p-print' ? [s, PRINT_HOLD] : [s]));

describe('soft gels II (Capsules C7)', () => {
  it('[PR-03][PR-18][IN-36][IN-37] a chewable, enteric-coated seamless soft gel from the catalogue (chewable gel mass, hold, seamless encapsulation, fill and shell weight, drying, hardness, enteric coat, inspection, printing held for QC (G-17), polishing, rupture) passes the formulation checks and runs to completion with no exception', () => {
    const { mbr, registry } = catalogueMaster(NODES, BOM, 'Chewable soft gelatin capsule');
    for (const s of STEPS) expect(checkBlockUse(item(s.code).definition, useOf(s), expr, BOM), s.id).toEqual([]);
    const run = Run.issue(define(mbr, { registry }), {}, T0);
    for (const s of STEPS) {
      if (s.id === 'p-polish') {
        // Polishing cannot start while the printed capsules wait for QC; QA's release opens it.
        expect(() => run.start('p-polish')).toThrow(/ENG-NOT-ENABLED/);
        run.ok({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: 'h-print', context: [], disposition: 'APPROVED', signature: sig('HOLD_POINT_RELEASED', QA1) });
      }
      runNominalStep(run, s.id, item(s.code).definition, configOf(useOf(s)), mbr);
      expect(run.status(s.id), s.id).toBe('COMPLETED');
    }
    expect(run.status('h-print')).toBe('COMPLETED');
    expect(run.exceptions().map((x) => x.type)).toEqual([]);
  });

  it('[PR-05] seamless encapsulation is a soft gel block in the capsule catalogue; chewable and enteric add no block of their own', () => {
    expect(SEED_GROUPS['soft gels']?.map((s) => s.definition.code)).toContain('SG-ENCAP-SEAMLESS');
    const capsules = CAPSULE_CATALOGUE.map((s) => s.definition.code);
    expect(capsules).toContain('SG-ENCAP-SEAMLESS');
    expect(capsules.filter((c) => /CHEW|ENTERIC/.test(c))).toEqual([]);
  });

  it('[PR-08][IN-37] seamless encapsulation: the encapsulator, nozzle, gel mass and fill inputs, the lines-connected check (EU GMP 5.14) and, at each round, nozzle and cooling liquid temperatures against their limits (not critical); signed by operator and verifier; a warm cooling liquid raises an exception', () => {
    const enc = item('SG-ENCAP-SEAMLESS');
    expect(fieldOf(enc, 'encapsulator')).toMatchObject({ type: 'EQUIPMENT', classSlot: 'encapsulatorClass' });
    expect([fieldOf(enc, 'gelMassIn'), fieldOf(enc, 'fillIn')]).toEqual([expect.objectContaining({ type: 'CONTAINER', action: 'CONSUME' }), expect.objectContaining({ type: 'CONTAINER', action: 'CONSUME' })]);
    expect(fieldOf(enc, 'linesConnected')).toMatchObject({ type: 'YES_NO', expected: true });
    const round = enc.definition.sections.find((x) => x.id === 'round');
    expect(round?.repeat).toEqual({ kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' });
    expect(round?.fields.map((f) => [f.id, (f as { critical?: boolean }).critical])).toEqual([['nozzleTemp', undefined], ['coolingTemp', undefined]]);
    expect(enc.definition.signatures.map((x) => x.meaning)).toEqual(['PERFORMED', 'VERIFIED']);
    // No in-step holding timer (D-C3-6).
    expect(enc.definition.sections.flatMap((x) => x.fields).filter((f) => f.type === 'TIMER')).toEqual([]);
    expect(nominalRun(enc)).toEqual({ exceptions: [], status: 'COMPLETED' });
    expect(judgedRun(enc, { round: { coolingTemp: '12.0' } })).toEqual({ exceptions: ['LIB_LIMIT_BREACH'], status: 'IN_PROGRESS' });
  });

  it('[PR-03][IN-37] the capsule disintegration test records which test the specification names, disintegration or rupture (21 CFR 211.110(a)(2), (b)), with the same time limit slot and no new one', () => {
    const dt = item('IPC-CAPS-DT');
    expect(fieldOf(dt, 'testKind')).toMatchObject({ type: 'CHOICE', options: ['Disintegration', 'Rupture'] });
    expect(fieldOf(dt, 'time')).toMatchObject({ type: 'TEST_RESULT', statistics: [{ statistic: 'MAX', limitSlot: 'maxTime' }] });
    expect(Object.keys(dt.exampleUse.limits ?? {}).sort()).toEqual(['maxTime', 'mediumTemp']);
    expect(nominalRun(dt)).toEqual({ exceptions: [], status: 'COMPLETED' });
    // The rupture path: the same step completes with the rupture test chosen.
    expect(judgedRun(dt, { test: { testKind: 'Rupture' } })).toEqual({ exceptions: [], status: 'COMPLETED' });
  });
});
