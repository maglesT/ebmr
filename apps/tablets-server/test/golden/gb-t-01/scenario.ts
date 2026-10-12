/**
 * The GB-T-01 scenario (Phase 3 slice 6d): the seeded ERP orders plan the two variants (PO-GBT01-0001 the happy one,
 * PO-GBT01-0002 the exception-rich one), the ERP interface posts a third order for the source batch GBT-REC (the batch
 * whose inspection keeps the milled rejects the variants add, case 2), the source batch runs to its release for packing,
 * the quality unit reserves its residue, the golden clock moves 41 days, and each variant runs from dispensing to its
 * release for packing with the quantities of the hand worksheet (README.md, expected.json).
 */
import { randomUUID } from 'node:crypto';
import { routes } from '@ebmr/api-contract';
import { engine, execution } from '@ebmr/recipe-core';
import { personaOf, terminalOf } from '@ebmr/test-kit';
import { runContext } from '../../../src/features/execution/runs.ts';
import { GBT01_ORDERS } from '../../../src/features/execution/seed-gb-t-01.ts';
import { dbAs, dispensing, GoldenBatch, granulation, ok, signAct, type GranulationPlan } from './driver.ts';
import { clean, ROOMS, UNITS } from './plant.ts';
import { blending, coating, compression, inspection, type CompressionPlan } from './stages.ts';
import { signDirect, signOffice, type GoldenWorld } from './world.ts';

/** The reservations of each lot for one batch (kg): what dispensing takes, with room for the extra IPA. */
const RESERVE = { 'MAT-EXZ-NA': '55.000', 'MAT-MCC-101': '8.000', 'MAT-LAC-MH': '14.000', 'MAT-PVP-K30': '2.400', 'MAT-IPA': '3.000', 'MAT-CCS': '2.400', 'MAT-SIO2': '0.400', 'MAT-MGST': '0.800', 'MAT-FCS-W': '2.450' };

/** The 41 days between the source batch's inspection and the variants' additions (README.md). */
export const SOURCE_AGE_MINUTES = 41 * 24 * 60;

/** Every process unit and room cleaned (MAJOR) and verified before a batch: the dirty and clean hold times of the plant. */
async function cleanPlant(w: GoldenWorld): Promise<void> {
  w.b['technician1'] = await w.server.asPersona('technician1');
  w.b['technician2'] = await w.server.asPersona('technician2');
  for (const u of Object.values(UNITS)) await clean(w, 'EQUIPMENT', u.code);
  for (const room of ROOMS) await clean(w, 'AREA', room);
}

/** The ERP interface posts the source batch's production order (the ERP route, its service identity). */
async function postSourceOrder(w: GoldenWorld): Promise<void> {
  const erp = w.seed.services.find((s) => s.key === 'erpInterface');
  if (!erp) throw new Error('no ERP interface in the GMP seed');
  const template = GBT01_ORDERS[0];
  if (!template) throw new Error('no GB-T-01 order in the seed');
  const order = { ...template, orderNo: 'PO-GBT01-0003', erpReference: 'SAP-PP-PO-GBT01-0003' };
  const creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(w.seed, erp.terminal).fingerprint };
  ok(await w.server.browser().call(routes.quality.erpImport, { body: { ...creds, catalogue: { products: [], materials: [], orders: [order] } } }), 'the source order');
}

export interface Planned {
  happy: GoldenBatch;
  exception: GoldenBatch;
  source: GoldenBatch;
}

/** The three batches planned by the issuer: the variants on the seeded orders, the source on the third order. */
export async function planAll(w: GoldenWorld): Promise<Planned> {
  const happy = await GoldenBatch.plan(w);
  const exception = await GoldenBatch.plan(w);
  await postSourceOrder(w);
  const source = await GoldenBatch.plan(w);
  return { happy, exception, source };
}

const DISPENSED_GRANULES: [string, string] = ['38.600', '38.550'];

/** The source batch GBT-REC: the same master, no addition, its inspection keeping 4.520 kg of reusable residue. */
export async function runSource(w: GoldenWorld, g: GoldenBatch): Promise<{ residue: string }> {
  await cleanPlant(w);
  await g.issue();
  await g.reserveLots(RESERVE);
  await dispensing(g);
  await granulation(g, { granules: DISPENSED_GRANULES, lods: [['2.8'], ['2.9']], extraIpa: [null, null] });
  const { blendLabel } = await blending(g, { addition: null, blend: '80.300' });
  await compression(g, { blendLabel, ...steadyRun(['13.000', '13.000', '13.000']), good: '78.000', residue: '0.600', rejects: '0.400' });
  await coating(g, { coreTotal: '8.2000', iterations: [{ total: '8.4401', minutes: 60 }], coated: '80.300' });
  const r = await inspection(g, {
    inspected: { count: '190150', mass: '80.300' },
    accepted: { count: '179000', mass: '75.600' },
    destroyed: { count: '426', mass: '0.180' },
    residue: { count: '10724', mass: '4.520' },
    defects: [{ code: 'CHIPPED', count: '6000' }, { code: 'COLOUR-SPOT', count: '5150' }],
    aql: { MAJOR: '2', MINOR: '5' },
  });
  if (!r.residue) throw new Error('the source batch kept no residue');
  // The quality unit reserves the residue for reprocessing (RESIDUE_RESERVED, the signed act over HTTP).
  const qcu = await w.server.asPersona('qcuAuthoriser');
  ok(await signAct(w, qcu, 'qcuAuthoriser', { kind: 'REPROCESSING_ACT', act: 'RESERVE_RESIDUE', subjectId: r.residue, input: {} }), 'the reservation of the residue');
  return { residue: r.residue };
}

function steadyRun(nets: [string, string, string], failingRight?: string): Pick<CompressionPlan, 'checks' | 'containers'> {
  return {
    checks: { L: ['8205.0', '8198.0', '8201.0'], R: ['8202.0', failingRight ?? '8196.0', '8204.0'] },
    containers: { L: nets, R: nets },
  };
}

export type Variant = 'HAPPY' | 'EXCEPTION_RICH';

/** One variant of GB-T-01 from issue to the release for packing, adding 2.000 kg of the source's residue (case 2). */
export async function runVariant(w: GoldenWorld, g: GoldenBatch, variant: Variant, residue: string): Promise<{ deviation: string | null }> {
  await cleanPlant(w);
  await g.issue();
  await g.reserveLots(RESERVE);
  // The quality unit authorises this batch's use of the reserved residue before the blending (REPROCESSING_AUTHORISED).
  const qcu = await w.server.asPersona('qcuAuthoriser');
  const proposed = await dbAs<{ id: string }>(w, qcu, 'qcuAuthoriser', 'select recipe.propose_reprocessing_authorisation($1, $2, $3, $4, $5) as r', [
    g.batchId,
    'p-rework',
    residue,
    'INV-GBT01-RPR-01',
    'RA-GBT01-RPR-01',
  ]);
  ok(await signAct(w, qcu, 'qcuAuthoriser', { kind: 'REPROCESSING_ACT', act: 'AUTHORISE_ADDITION', subjectId: proposed.id, input: {} }), 'the authorisation of the addition');

  await dispensing(g);
  const gran: GranulationPlan =
    variant === 'HAPPY'
      ? { granules: DISPENSED_GRANULES, lods: [['2.8'], ['2.9']], extraIpa: [null, null] }
      : {
          granules: DISPENSED_GRANULES,
          lods: [['2.8'], ['4.1', '2.9']],
          extraIpa: [null, '0.300'],
          async afterDrying(batch, stepKey) {
            if (stepKey !== 'p-dry@R-GRAN=2/L-DRY=1') return;
            batch.notes['correctionWithoutEvidence'] = await correctionWithoutEvidence(w, batch, stepKey);
            // INV-19: an iteration is ended only by a step of a loop (the granulation step runs in none).
            batch.notes['loopOutsideLoop'] = refusalCode(await batch.d.command('operator1', { type: 'COMPLETE_LOOP_ITERATION', stepKey: 'p-gran@R-GRAN=2' }));
          },
        };
  await granulation(g, gran);
  const { blendLabel } = await blending(g, { addition: { container: residue, authorisation: proposed.id, gross: '3.000', tare: '1.000' }, blend: '82.310', tryUnapproved: variant === 'EXCEPTION_RICH' });
  let deviation: string | null = null;
  await compression(g, {
    blendLabel,
    ...steadyRun(['13.490', '13.490', '13.480'], variant === 'EXCEPTION_RICH' ? '8480.0' : undefined),
    good: '80.920',
    residue: '0.620',
    rejects: '0.390',
    async onFailure(batch, held) {
      deviation = await ipcFailure(w, batch, held);
    },
  });
  await coating(g, { coreTotal: '8.2000', iterations: [{ total: '8.4401', minutes: 60 }], coated: '83.290' });
  await inspection(g, {
    inspected: { count: '197230', mass: '83.290' },
    accepted: { count: '196804', mass: '83.110' },
    destroyed: { count: '426', mass: '0.180' },
    defects: [{ code: 'CHIPPED', count: '300' }, { code: 'COLOUR-SPOT', count: '126' }],
    aql: { MAJOR: '2', MINOR: '5' },
  });
  return { deviation };
}

/**
 * The failing right-side weight check (exception-rich): QA raises a deviation, the supervisor links it to the batch's
 * exception and QA dispositions the exception DEVIATION_RAISED; after the investigation (a re-weighing of the retained
 * sample on a checked balance, in the deviation) QA releases the held container (OUTPUT_CONTAINER_RELEASED).
 */
async function ipcFailure(w: GoldenWorld, g: GoldenBatch, held: { id: string; label: string }[]): Promise<string> {
  const qa = await w.server.asPersona('qaInvestigator');
  const dev = ok(
    await qa.call(routes.quality.raiseDeviation, {
      body: { kind: 'DEVIATION', title: `Right-side weight check failed at compression of ${g.batchNumber}`, classification: 'MAJOR', riskRationale: 'Weight outside the action limit on one side; the containers made since the last passing check are held.' },
    }),
    'the deviation',
  );
  ok(await qa.call(routes.quality.linkDeviation, { params: { deviationId: dev.deviationId }, body: { subjectKind: 'BATCH', subjectId: g.batchId } }), 'the deviation link');
  const ex = (await g.view()).exceptions.find((e) => e.status === 'OPEN' && e.type === 'IPC_CHECK_FAILED');
  if (!ex) throw new Error('no IPC_CHECK_FAILED exception was raised');
  await g.d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: ex.exceptionId, deviationRef: dev.ref });
  await g.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: ex.exceptionId, outcome: 'DEVIATION_RAISED', justification: `Deviation ${dev.ref}: the held containers stay held until QA decides on them` });
  // The investigation re-weighed the retained sample of the failing check on a checked balance: within limits (an
  // instrument reading error). Phase 4 slice 1b (recipe-core 0741): QA releases a held container only once the
  // investigation is concluded. Phase 4 slice 2a (site services 0820 to 0822), the full path: the quality unit's authorised
  // person classifies the record and starts the investigation with the investigator as its owner; the investigator records the
  // finding and the impact on the batch for India; the second QA person signs the impact; the investigator records the
  // closure basis and the second QA person concludes (PENDING_CLOSURE). QA then releases the held container
  // (OUTPUT_CONTAINER_RELEASED: the kernel's ceremony directly) before the approval for coating.
  const approver = (w.b['qaApprover2'] ??= await w.server.asPersona('qaApprover2'));
  const id = { deviationId: dev.deviationId };
  const due = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 28)).toISOString().slice(0, 10);
  ok(
    await (await w.server.asPersona('qcuAuthoriser')).call(routes.quality.startInvestigation, {
      params: id,
      body: { classification: 'MAJOR', riskRationale: 'Weight outside the action limit on one side; held containers at risk', ownerPersonId: personaOf(w.seed, 'qaInvestigator').personId, dueDate: due },
    }),
    'the investigation',
  );
  ok(
    await qa.call(routes.quality.recordFinding, {
      params: { deviationId: dev.deviationId },
      body: { assignableCause: true, cause: 'Instrument reading error: the retained sample re-weighed on a checked balance is within limits', rootCauseCategory: 'EQUIPMENT' },
    }),
    'the finding',
  );
  const link = ok(await qa.call(routes.quality.deviationDetail, { params: id }), 'the deviation detail').links[0];
  if (!link) throw new Error('the deviation has no link');
  ok(
    await qa.call(routes.quality.recordDeviationImpact, {
      params: id,
      body: { linkId: link.linkId, market: 'IN', impact: 'NONE', rationale: 'Retained sample re-weighed within limits on a checked balance: an instrument reading error' },
    }),
    'the impact',
  );
  const assessed = await signOffice(w.seed, approver, 'qaApprover2', { kind: 'QUALITY_ACT', act: 'DEVIATION_IMPACT_ASSESS', subjectId: dev.deviationId, input: {} });
  if (!assessed.ok) throw new Error(`the deviation impact assessment was refused: ${JSON.stringify(assessed.error)}`);
  ok(
    await qa.call(routes.quality.recordDeviationClosureBasis, {
      params: id,
      body: {
        rootCauseMethod: 'Re-weighing of the retained sample on a checked balance',
        capaRefs: ['CAPA-GBT01-001'],
        notificationRequired: false,
        notificationRationale: 'No registered detail or licence condition is affected',
        otherBatches: [{ subjectKind: 'PRODUCT', ref: `Batches compressed on the press since the last passing check of ${g.batchNumber}`, included: false, reason: 'No other batch ran on the press in that time' }],
      },
    }),
    'the closure basis',
  );
  const concluded = await signOffice(w.seed, approver, 'qaApprover2', { kind: 'QUALITY_ACT', act: 'DEVIATION_CONCLUDE', subjectId: dev.deviationId, input: {} });
  if (!concluded.ok) throw new Error(`the deviation conclusion was refused: ${JSON.stringify(concluded.error)}`);
  for (const c of held) {
    const sig = await signDirect(w.server, w.seed, 'qa1', 'output_container', c.id, 'OUTPUT_CONTAINER_RELEASED', 'HELD', 'PC-QA-01');
    const v = (await w.server.db.app.query<{ v: string }>("select version::text as v from platform.aggregate_state where aggregate_type = 'output_container' and aggregate_id = $1", [c.id])).rows[0]?.v;
    await dbAs(w, g.b('qa1'), 'qa1', 'select plant.release_container($1, $2::bigint, $3) as r', [c.id, v, sig], { reasonCode: 'IPC_INVESTIGATED', reasonText: `Deviation ${dev.ref}: retained sample re-weighed within limits` });
  }
  return dev.ref;
}

function refusalCode(r: { ok: true } | { ok: false; error: { kind: string; envelope?: { refusal: { code: string } } } }): string {
  return r.ok ? 'ok' : (r.error.envelope?.refusal.code ?? r.error.kind);
}

/**
 * Outline 9.1: a correction that would make a failing in-process result pass, without objective evidence of the true
 * value, is refused. CORRECT_ENTRY has no HTTP intent in Phase 3 (contract class LATER: a residual), so the engine the
 * server runs is asked directly, on the batch's stored record, with the operator's correction and QA's approval
 * signatures: it refuses before anything could be stored. The LOD of 4.1 % of the first drying of sub-lot 2 failed its
 * validated range of 2.0 to 3.5 %; a correction to 3.0 % without evidence is refused.
 */
async function correctionWithoutEvidence(w: GoldenWorld, g: GoldenBatch, stepKey: string): Promise<string> {
  const run = await runContext(w.server.db.admin, g.batchId);
  const stored = await execution.loadState(w.server.db.admin, g.batchId);
  if (!stored) throw new Error('no record');
  const point = Object.values(stored.state.points).find((p) => p.stepKey === stepKey && p.item === 'lod' && p.status === 'VALID');
  if (!point) throw new Error(`no LOD at ${stepKey}`);
  const op = personaOf(w.seed, 'operator1').personId;
  const qa = personaOf(w.seed, 'qa1').personId;
  const command = {
    type: 'CORRECT_ENTRY' as const,
    commandId: randomUUID(),
    actor: { id: op, kind: 'PERSON' as const, roles: ['PRODUCTION_OPERATOR'] },
    point: point.id,
    value: { kind: 'DECIMAL' as const, value: '3.0', unit: '%' },
    reason: 'Transcription error: the analyser printout reads 3.0 %',
    signature: { id: randomUUID(), meaning: 'CORRECTED', signer: op },
    approval: { approver: { id: qa, kind: 'PERSON' as const, roles: [...run.def.policy.qaRoles] }, signature: { id: randomUUID(), meaning: 'CORRECTION_APPROVED', signer: qa } },
  };
  const r = engine.step(run.def, stored.state, command, { nowUs: stored.state.lastRecordedUs });
  return r.accepted ? 'accepted' : `${r.refusal?.code ?? '?'}: ${r.refusal?.message ?? ''}`;
}
