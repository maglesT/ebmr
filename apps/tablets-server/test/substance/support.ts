/**
 * Shared arrangement of the API edition's chain tests (api-chain.test.ts, A1a; intermediate-lots.test.ts, A2): the
 * signing ceremony, the batch issue, an API master shaped from dc-mini, the dispensing balance of the plant (test
 * arrangement with triggers off, as tb-01-gmp.test.ts) and the QC, QA and authorised-person path to a released API lot.
 */
import { createHash, randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import type pg from 'pg';
import { sha256Hex } from '@ebmr/expr';
import { identity, withCommand } from '@ebmr/kernel';
import { routes, type ContainerView, type SignableAction } from '@ebmr/api-contract';
import type { flow } from '@ebmr/recipe-core/pure';
import { library } from '@ebmr/recipe-core/pure';
import { openPersonaSession, passwordActor } from '@ebmr/test-kit';
import { personaIn, tapFor, valueOf } from '../esig/support.ts';
import { RunDriver, type ExecServer } from '../execution/support.ts';
import type { TestBrowser } from '../support/harness.ts';
import { gmpContent } from '../support/gmp-world.ts';
import { credentialsOf } from '../support/signed-acts.ts';

export type Json = Record<string, unknown>;
export interface BatchRef { batchId: string; batchNumber: string }
export interface Product { code: string; name: string; strength: string }

/** A test reaction block of the API edition (catalogue v1 brings the real ones). */
export const reactBlock = (code: string): library.BlockDefinition => ({
  code,
  version: 1,
  title: 'Reaction (test block)',
  category: 'PROCESS',
  edition: 'substance',
  sections: [{ id: 'run', title: 'Reaction', fields: [
    { id: 'temp', label: 'Reaction temperature', type: 'NUMBER', unit: 'Cel', limitSlot: 'temp', critical: true },
    { id: 'complete', label: 'Reaction complete by the in-process check', type: 'YES_NO', expected: true },
  ] }],
  signatures: [{ meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' }, { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' }],
});

export const range = (unit: string, low: string, high: string, ref = 'REF-API') => ({ unit, ranges: [{ tier: 'REGISTERED', low: { value: low, inclusive: true }, high: { value: high, inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref } }] });
export const phaseOf = (def: library.BlockDefinition, id: string, use: Json): Json => {
  const p = library.libraryPhase(def, id, 'HIGH') as unknown as Json;
  return { ...p, config: { ...(p['config'] as Json), ...use } };
};
export const stage = (like: Json, id: string, name: string, children: Json[]): Json => ({ ...like, id, name, body: { kind: 'sequence', id: `seq-${id}`, children } });

/** The input material of a step: its BOM line and the dispensed-quantity parameter of its G-07 weighing. */
export interface StepInput { code: string; name: string; quantity: string; item: string }

/** A G-07 dispensing step of `input` (BOM line BOM-IN), signed by the dispenser and checked by a verifier. */
export const g07Phase = (id: string, input: StepInput): Json => ({
  kind: 'phase', id, name: `Dispense ${input.name}`, block: { type: 'G-07', version: '1' }, config: { tolerance: { percent: '1.0' } },
  records: [input.item], computes: [], reads: [], consumes: ['BOM-IN'], produces: [], uses: [], equipment: [],
  signatures: { perform: { role: 'DISPENSER' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } },
  significant: true, riskClass: 'HIGH',
});

/** dc-mini reshaped as a master of the API edition: the product's header, the stages given, the input's BOM line (if any). */
export function apiContent(o: {
  family: string; title: string; product: Product; recordKind: 'PROCESSING' | 'PACKAGING' | 'REPROCESSING'; defs: library.BlockDefinition[];
  stages: (like: Json) => Json[]; input?: StepInput; materials?: { code: string; title: string; role: string; quantity: { value: string; unit: string } }[]; packType?: string;
}): flow.MbrContent {
  return gmpContent((m) => {
    const header = m['header'] as Json;
    header['family'] = o.family;
    header['edition'] = 'substance';
    header['recordKind'] = o.recordKind;
    header['title'] = o.title;
    header['product'] = { code: o.product.code, name: o.product.name, strength: o.product.strength, dosageForm: 'API' };
    delete header['unitMassMg'];
    if (o.packType) header['packType'] = o.packType;
    const materials = [
      ...(o.input ? [{ code: o.input.code, title: o.input.name, role: 'ACTIVE', quantity: { value: o.input.quantity, unit: 'kg' }, id: 'BOM-IN' }] : []),
      ...(o.materials ?? []).map((x) => ({ ...x, id: `BOM-${x.code}` })),
    ];
    m['bom'] = materials.map((x) => ({ id: x.id, material: x.code, role: x.role, quantity: x.quantity }));
    m['references'] = [
      ...(m['references'] as Json[]).filter((r) => r['kind'] !== 'MATERIAL'),
      ...materials.map((x) => ({ id: x.code, kind: 'MATERIAL', code: x.code, version: '1', hash: sha256Hex(`${x.code} ${x.title}`), title: x.title })),
    ];
    const body = (m['procedure'] as Json)['body'] as Json;
    body['children'] = o.stages((body['children'] as Json[])[0] as Json);
    for (const k of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) m[k] = [];
    if (o.input) {
      (m['parameters'] as Json[]).push({ id: o.input.item, name: `${o.input.name} dispensed (G-07)`, valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' });
    }
    m['blockDefinitions'] = o.defs;
  });
}

/** The signing ceremony of any act; a kiosk persona confirms the challenge with a fresh badge tap. */
export async function signAs(gmp: ExecServer, b: TestBrowser, key: string, action: SignableAction, meaning?: string): Promise<void> {
  const d = valueOf(await b.call(routes.esig.describe, { body: { action } }));
  const m = meaning ?? d.meaning ?? '';
  const preview = valueOf(await b.call(routes.esig.content, { query: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, intent: m } }));
  const body = { aggregateType: d.aggregateType, aggregateId: d.aggregateId, contentVersion: preview.contentVersion, meaning: m, clientContentHash: sha256Hex(preview.canonicalText), action };
  vi.advanceTimersByTime(7_000);
  const attribution = b.terminal.includes('KIOSK') ? { attribution: await tapFor(b, personaIn(gmp, key), 'POST', '/api/esig/challenges', body) } : {};
  const challenge = valueOf(await b.call(routes.esig.createChallenge, { body, ...attribution }));
  const signBody = { challengeId: challenge.challengeId, credentials: credentialsOf(gmp, key), action };
  const r = await b.call(routes.esig.sign, { body: { ...signBody, proof: await b.proof('POST', '/api/esig/sign', signBody) } });
  if (!r.ok) throw new Error(`${key} ${action.kind} was refused: ${JSON.stringify(r.error.kind === 'REFUSAL' ? r.error.envelope.refusal : r.error)}`);
}

/** The issuer's ISSUED signature on a planned batch (the issue ceremony). */
export async function issueBatch(gmp: ExecServer, batchId: string, why: { code: string; text: string }): Promise<void> {
  const issuer = await gmp.asPersona('issuer');
  const preview = valueOf(await issuer.call(routes.esig.content, { query: { aggregateType: 'batch_issue', aggregateId: batchId, intent: 'ISSUED' } }));
  const action = { kind: 'GMP_BATCH_ISSUE' as const, batchId, reason: why, variants: {}, inputs: {} };
  const challenge = valueOf(await issuer.call(routes.esig.createChallenge, { body: { aggregateType: 'batch_issue', aggregateId: batchId, contentVersion: preview.contentVersion, meaning: 'ISSUED', clientContentHash: sha256Hex(preview.canonicalText), action } }));
  const body = { challengeId: challenge.challengeId, credentials: credentialsOf(gmp, 'issuer'), action };
  valueOf(await issuer.call(routes.esig.sign, { body: { ...body, proof: await issuer.proof('POST', '/api/esig/sign', body) } }));
}

/** Superuser set-up with triggers off (test arrangement of master data only). */
async function arrange(gmp: ExecServer, work: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await work(c);
    await c.query('commit');
  } finally {
    c.release();
  }
}

/**
 * Test arrangement (as tb-01-gmp.test.ts): balance `code` of the dispensing room DISP-1, a registered instrument no
 * gateway serves, qualified and calibrated in the plant register, and the products of the plant.
 */
export async function arrangeBalance(gmp: ExecServer, code: string, products: string[]): Promise<void> {
  const admin = await passwordActor(gmp.db, gmp.seed.bootstrap.admin, gmp.seed.bootstrap.admin.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'dispensing balance', correlationId: randomUUID() });
  await identity.withGuardedCommand(gmp.db.app, admin, (c) =>
    c.query("select iam.register_device($1, 'INSTRUMENT', 'SITE-1', 'DISP-1', null, $2, 'Balance 60 kg in DISP-1 (not interfaced)')", [code, createHash('sha256').update(`${code}:${randomUUID()}`).digest('hex')]),
  );
  await arrange(gmp, async (c) => {
    for (const p of products) await c.query('insert into plant.product (code, name, highly_potent, recorded_by) values ($1, $1, false, gen_random_uuid())', [p]);
    await c.query("insert into plant.equipment_class (code, kind, description, calibration_required, check_regime, recorded_by) values ($1, 'INSTRUMENT', 'Balance 60 kg', true, 'PER_USE', gen_random_uuid())", [`EQC-${code}`]);
    const { rows } = await c.query<{ id: string }>("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ($1, 'Balance 60 kg', $2, 'INSTRUMENT', gen_random_uuid()) returning id", [code, `EQC-${code}`]);
    await c.query("insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id) values ($1, 'QUALIFIED', 'QUAL-BAL', 'IQ/OQ/PQ approved', gen_random_uuid(), gen_random_uuid())", [rows[0]?.id]);
    await c.query("insert into plant.calibration (equipment_id, due_at, as_found, as_left, reference, person_id, account_id) values ($1, clock_timestamp() + interval '1 year', 'PASS', 'PASS', 'CAL-BAL', gen_random_uuid(), gen_random_uuid())", [rows[0]?.id]);
  });
}

/** operator1, by a badge tap at the dispensing kiosk, records the balance's per-use check and books it for the batch. */
export async function bookBalance(gmp: ExecServer, code: string, batchId: string): Promise<void> {
  vi.advanceTimersByTime(7_000);
  const operator = { ...(await openPersonaSession(gmp.db, gmp.seed, 'operator1')), correlationId: randomUUID() };
  const tap = await identity.authenticate(gmp.db.authn, { method: 'BADGE_TAP', identifier: personaIn(gmp, 'operator1').badgeUid ?? '', deviceFingerprint: gmp.seed.terminals.find((t) => t.code === 'KIOSK-DISP-1')?.fingerprint ?? '', purpose: 'COMMAND' });
  await withCommand(gmp.db.app, { ...operator, authEventId: tap.authEventId }, async (c) => {
    await c.query("select plant.record_instrument_check($1, 'PASS', 'Balance per-use check', $2::uuid)", [code, batchId]);
    await c.query("select plant.record_instrument_use($1, $2::uuid, clock_timestamp() + interval '8 hours')", [code, batchId]);
  });
}

/**
 * QC approves the material's specification and the lot's results and pulls the reserve sample; production and QA review
 * each record (every open register item disposed, the audit trail reviewed); G-REL for India has no RED item and the
 * authorised person releases the lot. Returns the release view's items before the release.
 */
export async function releaseApiLot(gmp: ExecServer, lotId: string, materialCode: string, records: BatchRef[]): Promise<{ id: string; group: string; status: string }[]> {
  const [qc, head] = await Promise.all([gmp.asPersona('qcAnalyst'), gmp.asPersona('qcApprover')]);
  const tests = [{ testCode: 'ASSAY', methodReference: `STP-${materialCode}-AS`, unit: '%', lowerLimit: '98.0', upperLimit: '102.0', result: '99.6' }];
  const spec = valueOf(await qc.call(routes.specifications.draft, { body: {
    materialCode, title: 'API specification (invented)', monographReference: 'In-house monograph',
    tests: tests.map((t) => ({ testCode: t.testCode, methodReference: t.methodReference, unit: t.unit, lowerLimit: t.lowerLimit, upperLimit: t.upperLimit, required: true, pharmacopoeia: 'IN_HOUSE' as const, edition: 'STP-2026-1', sampleQuantity: '0.1', sampleUnit: 'kg' })),
  } }));
  await signAs(gmp, head, 'qcApprover', { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: spec.specificationId });
  for (const t of tests) {
    const r = valueOf(await qc.call(routes.quality.recordLotResult, { params: { lotId }, body: { testCode: t.testCode, methodReference: t.methodReference, purpose: 'RELEASE', value: t.result, unit: t.unit } }));
    await signAs(gmp, head, 'qcApprover', { kind: 'QUALITY_ACT', act: 'LOT_RESULT_APPROVE', subjectId: r.resultId, input: {} });
  }
  valueOf(await qc.call(routes.samples.pull, { params: { lotId }, body: { kind: 'RESERVE', quantity: '0.2', container: 'Reserve sample jar', storageLocation: 'Reserve sample room RS-1' } }));
  for (const b of records) {
    const [prod, qa, qa2] = await Promise.all([gmp.asPersona('head1'), gmp.asPersona('qaInvestigator'), gmp.asPersona('qaApprover2')]);
    await signAs(gmp, prod, 'head1', { kind: 'REVIEW_ACT', act: 'PRODUCTION_APPROVE', batchId: b.batchId, input: {} });
    const register = valueOf(await qa2.call(routes.review.register, { params: { batchId: b.batchId }, body: {} }));
    for (const item of register.items.filter((i) => i.reviewStatus === 'OPEN')) {
      if (item.critical) valueOf(await qa2.call(routes.review.openItem, { params: { batchId: b.batchId, exceptionId: item.exceptionId }, body: {} }));
      await signAs(gmp, qa2, 'qaApprover2', { kind: 'REVIEW_ACT', act: 'DISPOSE_ITEM', batchId: b.batchId, input: { items: [item.exceptionId], disposition: 'ACCEPT', ...(item.critical ? { justification: 'Reviewed with its disposition: no impact on the batch' } : {}) } });
    }
    const report = valueOf(await qa.call(routes.review.auditTrail, { params: { batchId: b.batchId }, query: {} }));
    await signAs(gmp, qa, 'qaInvestigator', { kind: 'REVIEW_ACT', act: 'AUDIT_TRAIL_REVIEW', batchId: b.batchId, input: { reviewId: report.reviewId } });
    const view = valueOf(await qa2.call(routes.review.batch, { params: { batchId: b.batchId } }));
    expect(view.gates.qaReview.problems, b.batchNumber).toEqual([]);
    await signAs(gmp, qa2, 'qaApprover2', { kind: 'REVIEW_ACT', act: 'QA_REVIEW', batchId: b.batchId, input: { expectedEpoch: view.epoch } });
  }
  const ap = await gmp.asPersona('qcuAuthoriser');
  const view = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
  expect(view.grel.items.filter((i) => i.status === 'RED').map((i) => `${i.id}: ${i.problem ?? ''}`)).toEqual([]);
  expect(view.state).toBe('READY');
  await signAs(gmp, ap, 'qcuAuthoriser', { kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId, input: { expectedEpoch: view.grel.epoch } });
  expect(valueOf(await ap.call(routes.release.lot, { params: { lotId } }))).toMatchObject({ state: 'RELEASED', lotStatus: 'RELEASED' });
  return view.grel.items.map((i) => ({ id: i.id, group: String(i.group), status: i.status }));
}

/** A run driver with the production personas (operator, verifier, supervisor, QA) and, when given, the dispenser. */
export async function driverOf(gmp: ExecServer, batchId: string): Promise<RunDriver> {
  const keys = ['operator1', 'verifier1', 'supervisor1', 'qa1', 'dispenser1'] as const;
  const browsers = Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await gmp.asPersona(k)] as const)));
  const d = new RunDriver(gmp, batchId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}
export const libraryEntry = (stepKey: string, entryKind: string, data: Json) => ({ type: 'RECORD_ENTRY', stepKey, entry: { kind: 'LIBRARY_ENTRY', entryKind, data } }) as never;
export const statusOf = async (gmp: ExecServer, batchId: string): Promise<string | undefined> =>
  (await gmp.db.admin.query<{ s: string }>('select status as s from recipe.execution_state where batch_id = $1', [batchId])).rows[0]?.s;

/** The isolated output of the batch into one bulk container: the net typed by operator1, verified by verifier1; its label. */
export async function closeBulk(gmp: ExecServer, d: RunDriver, batchId: string, net: string): Promise<string> {
  const operator = d.browser('operator1');
  const tap = (path: string, body: Json) => { vi.advanceTimersByTime(7_000); return tapFor(operator, personaIn(gmp, 'operator1'), 'POST', path, body); };
  const openBody = { batchId, stage: 'ISOLATION', unit: 'kg' as const };
  const c: ContainerView = valueOf(await operator.call(routes.containers.open, { body: openBody, attribution: await tap('/api/containers', openBody) }));
  const closeBody = { expectedVersion: c.version, typed: { net } };
  valueOf(await operator.call(routes.containers.close, { params: { containerId: c.containerId }, body: closeBody, attribution: await tap(`/api/containers/${c.containerId}/close`, closeBody) }));
  await signAs(gmp, d.browser('verifier1'), 'verifier1', { kind: 'CONTAINER_ACT', act: 'VERIFY_CLOSE', containerId: c.containerId });
  return c.label;
}

/** The packaging order takes the bulk and packs it at step p-pack (stage S-PACK) into the drums given (number, net kg). */
export async function packIntoDrums(gmp: ExecServer, order: BatchRef, bulkLabel: string, drums: [string, string][]): Promise<void> {
  const d = await driverOf(gmp, order.batchId);
  const operator = d.browser('operator1');
  const bulkBody = { labels: [bulkLabel] };
  vi.advanceTimersByTime(7_000);
  valueOf(await operator.call(routes.batches.issueBulk, { params: { batchId: order.batchId }, body: bulkBody, attribution: await tapFor(operator, personaIn(gmp, 'operator1'), 'POST', `/api/batches/${order.batchId}/bulk`, bulkBody) }));
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-pack@' });
  for (const [no, net] of drums) await d.ok('operator1', libraryEntry('p-pack@', 'container', { container: `${order.batchNumber}-${no}`, netMass: net, sealed: true, labelOk: true }));
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-pack@' });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: 'p-pack@', meaning: 'VERIFIED' });
  await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-PACK@' });
  expect(await statusOf(gmp, order.batchId)).toBe('EXECUTION_COMPLETE');
}
