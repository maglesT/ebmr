/**
 * Signing content of the batch aggregates (module C3; Phase 2 apps plan section 6; DI-37, INV-09):
 * an accepted signing command never changes the content it was signed on, any change of the step's data,
 * finalisation or exceptions does, and after every command the signatures the e-signature kernel would
 * hold valid (valid until the content of their aggregate changes) are exactly those the engine treats as
 * valid.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { prepareForSignature } from '../../src/engine/engine.ts';
import { engineSignatures, signingEnvelope, stepSigningContent, stageSigningContent, exceptionSigningContent } from '../../src/engine/signing-content.ts';
import { stepKey } from '../../src/engine/tx.ts';
import type { BatchDefinition } from '../../src/engine/definition.ts';
import type { IssueRequest } from '../../src/engine/types.ts';
import { buildFlow, candidateCommands, shapes, type ModelData, GENERATED_DATA } from './model-support.ts';
import { Recorder } from './recorder.ts';
import { autopilot, define, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, MIN, OP1, PACKAGING_SCENARIO, QA1, Run, sig, SUP1, T0, VER1 } from './support.ts';
import { fixtureMbr } from '../blocks/support.ts';
import { G07 } from '../../src/blocks/generic/material.ts';

const MOVE = fc.record({ pick: fc.nat({ max: 10_000 }), minutes: fc.constantFrom(0, 1, 2, 5, 13, 90), k: fc.nat({ max: 1_000 }), mode: fc.nat({ max: 9 }), sweep: fc.boolean() });

const FIXTURE_DATA: Record<'tablet-granulation-compression' | 'tablet-blister-packaging', ModelData> = {
  'tablet-granulation-compression': { endpoint: (_i, exit) => ({ kind: 'DECIMAL', value: exit ? '3.00' : '5.00', unit: '%' }), derived: 'granYield', scenario: GRANULATION_SCENARIO },
  'tablet-blister-packaging': { endpoint: () => ({ kind: 'DECIMAL', value: '1', unit: '1' }), derived: 'bulkRecon', scenario: PACKAGING_SCENARIO },
};

function request(def: BatchDefinition, name?: keyof typeof FIXTURE_DATA): IssueRequest {
  return {
    batchId: 'BATCH-1',
    batchNumber: 'TEST-B0001',
    batchSize: def.mbr.header.batchSizes[0]?.id ?? '',
    marketSet: [...def.mbr.header.marketSet],
    inputs: name ? FIXTURE_INPUTS[name] : {},
    ...(name === 'tablet-blister-packaging' ? { variants: { packDestination: 'US-EXPORT' } } : {}),
    issuedBy: SUP1,
  };
}

/** Runs random command sequences through the recorder and checks both properties after every command. */
function exercise(def: BatchDefinition, moves: readonly { pick: number; minutes: number; k: number; mode: number; sweep: boolean }[], exitLoops: boolean, data: ModelData, name?: keyof typeof FIXTURE_DATA): void {
  let now = T0;
  const rec = Recorder.issue(def, request(def, name), now);
  const run = new Run(def, rec.state, now, { checkInvariants: false });
  for (const m of moves) {
    now += BigInt(m.minutes) * MIN;
    if (m.sweep) rec.sweep(now);
    run.state = rec.state;
    run.nowUs = now;
    const c = candidateCommands(def, run, m.k, exitLoops, data);
    const list = m.mode < 7 && c.progress.length > 0 ? c.progress : c.all;
    const input = list[m.pick % list.length];
    if (!input) continue;
    rec.exec({ ...input, commandId: `C-${rec.rows.length + 1}` }, now);
    // INV-09 / DI-37, first half: an accepted signing command never changed the content it was signed on.
    expect(rec.invarianceBreaches).toEqual([]);
    // Second half: the kernel's valid set equals the engine's (on the signatures both know).
    const engine = engineSignatures(rec.state);
    const kernelValid = rec.kernelValid().filter((id) => engine.has(id));
    const engineValid = [...engine.entries()].filter(([id, e]) => e.valid && rec.signatures.has(id)).map(([id]) => id).sort();
    expect(kernelValid).toEqual(engineValid);
  }
}

describe('signing content: invariance and agreement with the kernel (model-based)', { timeout: 240_000 }, () => {
  it('[INV-09][DI-37] on generated flows, no accepted signing command changes its signed content and the kernel valid set equals the engine valid set after every command', () => {
    fc.assert(
      fc.property(shapes.node, fc.array(MOVE, { minLength: 20, maxLength: 120 }), fc.boolean(), (shape, moves, exitLoops) => {
        exercise(define(buildFlow(shape)), moves, exitLoops, GENERATED_DATA);
      }),
      { numRuns: 40 },
    );
  });

  for (const name of ['tablet-granulation-compression', 'tablet-blister-packaging'] as const) {
    it(`[INV-09][DI-37] the same on random command sequences of ${name}`, () => {
      const def = fixtureDefinition(name);
      fc.assert(
        fc.property(fc.array(MOVE, { minLength: 100, maxLength: 350 }), fc.boolean(), (moves, exitLoops) => {
          exercise(def, moves, exitLoops, FIXTURE_DATA[name], name);
        }),
        { numRuns: 8 },
      );
    });
  }
});

describe('signing content: what it includes and excludes', () => {
  it('[INV-09][DI-37] recording data, an entry or a correction changes the step content; PERFORMED, VERIFIED and the status do not', () => {
    const def = fixtureDefinition('tablet-granulation-compression');
    const run = Run.issue(def, { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
    const key = stepKey('p-disp-clear', []);
    const h = (): string => stepSigningContent(def, run.state, key).contentHash;
    const h0 = h();
    run.start('p-disp-clear');
    expect(h()).toBe(h0);
    run.entry('p-disp-clear', { kind: 'CLEARANCE_CHECK', answers: [{ id: 'NO_PREVIOUS_MATERIAL', answer: 'CONFIRMED' }, { id: 'NO_PREVIOUS_DOCUMENTS', answer: 'CONFIRMED' }, { id: 'EQUIPMENT_CLEAN_LABEL', answer: 'CONFIRMED' }] });
    const h1 = h();
    expect(h1).not.toBe(h0);
    run.entry('p-disp-clear', { kind: 'PREVIOUS_BATCH', product: 'Other product', batchNumber: 'TEST-B-9' });
    const h2 = h();
    expect(h2).not.toBe(h1);
    run.perform('p-disp-clear', [], OP1, 'LINE_CLEARANCE_PERFORMED');
    expect(h()).toBe(h2);
    run.verify('p-disp-clear', [], VER1, 'LINE_CLEARANCE_VERIFIED');
    expect(h()).toBe(h2);
    expect(stepSigningContent(def, run.state, key).state).toBe('COMPLETED');
    expect(stepSigningContent(def, run.state, key).enteredBy).toEqual(['OP1']);
  });

  it('[INV-09][DI-37] the finalisation of a PERFORMED attempt (a dispensing total out of tolerance) is in the prepared content the signer is shown', () => {
    const def = define(fixtureMbr(G07));
    const run = Run.issue(def, { inputs: { target: { value: { kind: 'DECIMAL', value: '8.741486', unit: 'kg' }, source: 'test' } } });
    run.start('p');
    // Dispensed short: 7.750 kg against a target of 8.741 kg with a 0.5 % tolerance.
    run.entry('p', { kind: 'CONTAINER_WEIGHING', item: 'disp', bomLine: 'BOM-API', container: 'C-001', lot: { id: 'AR-1', material: 'MAT-API', status: 'RELEASED', identityTested: true }, gross: '9.000', tare: '1.250', unit: 'kg', balance: 'BAL-07', source: 'DEVICE' });
    const key = stepKey('p', []);
    const before = stepSigningContent(def, run.state, key).contentHash;
    const prepared = prepareForSignature(def, run.state, { type: 'SIGN_PERFORMED', step: 'p' }, OP1, { nowUs: run.nowUs });
    expect(prepared.changed).toBe(true);
    expect(stepSigningContent(def, prepared.state, key).contentHash).not.toBe(before);
    expect(Object.values(prepared.state.exceptions).map((e) => e.type)).toContain('DISPENSE_OUT_OF_TOLERANCE');
    // Preparing again at the same time changes nothing more (the finalisation is idempotent).
    const again = prepareForSignature(def, prepared.state, { type: 'SIGN_PERFORMED', step: 'p' }, OP1, { nowUs: run.nowUs });
    expect(again.changed).toBe(false);
    expect(stepSigningContent(def, again.state, key).contentHash).toBe(stepSigningContent(def, prepared.state, key).contentHash);
  });

  it('[DI-37] the stage content covers every step of the stage; the exception content never its status or disposition', () => {
    const def = fixtureDefinition('tablet-granulation-compression');
    const run = Run.issue(def, { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
    run.ok({ type: 'RAISE_EXCEPTION', actor: OP1, description: 'observation', severity: 'ALERT' });
    const ex = Object.values(run.state.exceptions)[0];
    const before = exceptionSigningContent(def, run.state, ex?.id ?? '').contentHash;
    run.ok({ type: 'DISPOSITION_EXCEPTION', actor: QA1, exception: ex?.id ?? '', outcome: 'NO_IMPACT', justification: 'no impact', signature: sig('EXCEPTION_DISPOSITIONED', QA1) });
    expect(exceptionSigningContent(def, run.state, ex?.id ?? '').contentHash).toBe(before);
    expect(exceptionSigningContent(def, run.state, ex?.id ?? '').state).toBe('DISPOSITIONED');
    expect(autopilot(run, GRANULATION_SCENARIO)).toBe('COMPLETE');
    for (const key of Object.keys(run.state.stages)) {
      const c = stageSigningContent(def, run.state, key);
      expect(c.state).toBe('SIGNED_OFF');
      expect((c.content['steps'] as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it('[DI-37] the envelope is the kernel envelope: aggregate type and id, content version and content, canonical', () => {
    const e = signingEnvelope('batch_step', 'R:p@', 3, { b: '1', a: null });
    expect(e.text).toBe('{"aggregate_id":"R:p@","aggregate_type":"batch_step","content":{"a":null,"b":"1"},"content_version":3}');
    expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
