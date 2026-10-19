/**
 * Lot handling over HTTP (Phase 7 slice 7g, WP4; contract ns/receipt.ts lotHandlingRoutes; decision 0025): the witnessed
 * destruction of a rejected lot (stores record it as its performer, a witness other than the performer signs
 * LOT_DESTRUCTION_WITNESS through the ceremony, the performer destroys the lot with that signature), a reservation
 * cancelled with the person's reason, a stock-location exception closed by QA with a deviation linked to the lot, the
 * OOS record of an approved failing result, and a vendor-history route disabled with the reason. Every rule and right is
 * the database's (site services 0712, 0740, 0911); these tests prove the routes reach them and show what they answer.
 *
 * TEST FIXTURES (arranged as the superuser with triggers off, never used to prove a control): a reservation, a
 * stock-location exception and an enabled vendor-history route, whose own acts are proven in packages/site-services.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes, type Result } from '@ebmr/api-contract';
import { terminalOf } from '@ebmr/test-kit';
import { personaIn, refusalOf, startSigningServer, tapFor, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { confirmErpPending, signAction } from '../support/signed-acts.ts';

const Q = routes.quality;
const MATERIAL = `MAT-LH-${randomUUID().slice(0, 6).toUpperCase()}`;
let gmp: TestServer;
/** The database's refusal as the server answers it: its code, then why. */
const refused = (r: Result<unknown>): string => `${refusalOf(r)?.code ?? ''} ${refusalOf(r)?.why ?? ''}`;
let stores: TestBrowser;
let qa: TestBrowser;
let analyst: TestBrowser;
let head: TestBrowser;

async function signedOk(r: Promise<Result<unknown>>): Promise<void> {
  const out = await r;
  expect(out.ok, out.ok ? '' : JSON.stringify(out.error)).toBe(true);
}

/** Superuser test setup with triggers off for this transaction only (never used to prove a control). */
async function arrange<T = unknown>(sql: string, params: unknown[]): Promise<T | undefined> {
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const { rows } = await c.query<{ r: T }>(sql, params);
    await c.query('commit');
    return rows[0]?.r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

const receive = async () =>
  valueOf(
    await stores.call(Q.receiveLot, {
      body: { materialCode: MATERIAL, lotCode: `LH-${randomUUID().slice(0, 6).toUpperCase()}`, supplier: 'Demo Excipients', supplierLot: `S-${randomUUID().slice(0, 6)}`, quantity: '50.000', expiresAt: '2029-09-30T00:00:00+05:30', retestAt: '2027-03-31T00:00:00+05:30' },
    }),
  );
const statusOf = async (lotId: string) => valueOf(await stores.call(Q.lots, { query: { materialCode: MATERIAL } })).lots.find((l) => l.lotId === lotId);

/** A deviation raised by QA and linked to lot `lotId`; its id. */
async function linkedDeviation(lotId: string, kind: 'DEVIATION' | 'OOS' = 'DEVIATION'): Promise<string> {
  const d = valueOf(await qa.call(Q.raiseDeviation, { body: { kind, title: `${kind} on a lot of ${MATERIAL}`, classification: 'MAJOR', riskRationale: 'Material status at risk; lot blocked until closed' } }));
  valueOf(await qa.call(Q.linkDeviation, { params: { deviationId: d.deviationId }, body: { subjectKind: 'LOT', subjectId: lotId } }));
  return d.deviationId;
}

beforeAll(async () => {
  gmp = await startSigningServer('GMP');
  const erp = gmp.seed.services.find((s) => s.key === 'erpInterface');
  if (!erp) throw new Error('no ERP interface in the GMP seed');
  const creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(gmp.seed, erp.terminal).fingerprint };
  const material = { materialCode: MATERIAL, materialName: 'Lot handling excipient', materialKind: 'EXCIPIENT' as const, unit: 'kg', maxRetestMonths: 24, erpReference: `SAP-${MATERIAL}` };
  valueOf(await gmp.browser().call(Q.erpImport, { body: { ...creds, catalogue: { products: [], materials: [material], orders: [] } } }));
  await confirmErpPending(gmp);
  [stores, qa, analyst, head] = await Promise.all([gmp.asPersona('stores'), gmp.asPersona('qaInvestigator'), gmp.asPersona('qcAnalyst'), gmp.asPersona('qcApprover')]);
  const spec = valueOf(await analyst.call(routes.specifications.draft, {
    body: {
      materialCode: MATERIAL, title: 'Lot handling excipient', monographReference: 'In-house STP-LH',
      tests: [{ testCode: 'ASSAY', methodReference: 'STP-LH-01', unit: '%', lowerLimit: '98.0', upperLimit: '102.0', required: true, pharmacopoeia: 'IP', edition: '2022', sampleQuantity: '0.010', sampleUnit: 'kg' }],
    },
  }));
  await signedOk(signAction(gmp, head, 'qcApprover', { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: spec.specificationId }));
  vi.useFakeTimers({ toFake: ['performance'] });
}, 300_000);
afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

describe('the witnessed destruction of a lot (IN-24 (a))', () => {
  it('[IN-24] stores record the destruction of a rejected lot as its performer; a witness other than the performer signs it; only the performer destroys the lot, with that signature', async () => {
    const lot = await receive();
    const id = { lotId: lot.lotId };
    const record = { method: 'Incineration by the approved contractor', reason: 'Lot rejected: supplier certificate does not match' };
    // Only a rejected, returned or recalled lot is destroyed (the database's state rule).
    expect(refused(await stores.call(Q.recordLotDestruction, { params: id, body: record }))).toMatch(/EBMR-SITE-150/);
    await signedOk(signAction(gmp, head, 'qcApprover', { kind: 'LOT_DECISION', lotId: lot.lotId, decision: 'REJECT', reason: { code: 'QC_FAILURE', text: 'Supplier certificate does not match the lot' } }));
    // The witness cannot sign before the destruction is recorded (the record would supersede it).
    const witness = { kind: 'LOT_DESTRUCTION_WITNESS' as const, lotId: lot.lotId };
    const verifier = await gmp.asPersona('verifier1');
    vi.advanceTimersByTime(7_000);
    expect(refusalOf(await signAction(gmp, verifier, 'verifier1', witness))?.code).toBe('EBMR-API-NO-DESTRUCTION');
    // QA holds no MATERIAL.HANDLE: refused by the database for want of the right.
    expect(refusalOf(await qa.call(Q.recordLotDestruction, { params: id, body: record }))?.code).toBe('EBMR-IAM-040');
    const recorded = valueOf(await stores.call(Q.recordLotDestruction, { params: id, body: record }));
    expect(recorded).toMatchObject({ destruction: { method: record.method, reason: record.reason, quantity: '50.000', unit: 'kg', performedBy: { loginName: 'manoj.pillai' } }, witness: null });
    // The performer does not witness his own destruction.
    expect((await signAction(gmp, stores, 'stores', witness)).ok).toBe(false);
    vi.advanceTimersByTime(7_000);
    await signedOk(signAction(gmp, verifier, 'verifier1', witness));
    const h = valueOf(await stores.call(Q.lotHandling, { params: id }));
    expect(h.witness?.signedBy.loginName).toBe('kavya.reddy');
    const witnessSignatureId = h.witness?.signatureId ?? '';
    const version = (await statusOf(lot.lotId))?.version ?? '0';
    // Only the performer fires DESTROY: the witness holds no MATERIAL.HANDLE.
    vi.advanceTimersByTime(7_000);
    expect(refusalOf(await verifier.call(Q.destroyLot, { params: id, body: { expectedVersion: version, witnessSignatureId }, attribution: await kioskTap(verifier, `/api/lots/${lot.lotId}/destroy`, { expectedVersion: version, witnessSignatureId }) }))?.code).toBe('EBMR-IAM-040');
    // A signature that is not the lot's witnessing is refused.
    expect((await stores.call(Q.destroyLot, { params: id, body: { expectedVersion: version, witnessSignatureId: randomUUID() } })).ok).toBe(false);
    valueOf(await stores.call(Q.destroyLot, { params: id, body: { expectedVersion: version, witnessSignatureId } }));
    expect((await statusOf(lot.lotId))?.status).toBe('DESTROYED');
  }, 180_000);
});

/** The fresh badge tap of verifier1 on its kiosk for one request. */
const kioskTap = (b: TestBrowser, path: string, body: Record<string, unknown>) => tapFor(b, personaIn(gmp, 'verifier1'), 'POST', path, body);

describe('reservations, stock-location exceptions and the OOS record of a lot', () => {
  it('[DI-22] stores cancel an open reservation with their own reason; QA is refused for want of the right; a cancelled reservation is not cancelled again', async () => {
    const lot = await receive();
    const reservationId = await arrange<string>(
      `insert into site.lot_reservation (lot_id, batch_id, batch_number, edition, quantity, unit, expires_at, lot_state_version, reserved_by_person, reserved_by_account)
       values ($1, gen_random_uuid(), 'B26-9001', 'TABLETS', 5, 'kg', clock_timestamp() + interval '30 days', 1, gen_random_uuid(), gen_random_uuid()) returning id as r`,
      [lot.lotId],
    );
    const params = { reservationId: reservationId ?? '' };
    expect(valueOf(await stores.call(Q.lotHandling, { params: { lotId: lot.lotId } })).reservations).toEqual([expect.objectContaining({ reservationId, batchNumber: 'B26-9001', revoked: null })]);
    expect((await stores.call(Q.cancelReservation, { params, body: { reason: '   ' } })).ok).toBe(false);
    expect(refusalOf(await qa.call(Q.cancelReservation, { params, body: { reason: 'Batch cancelled' } }))?.code).toBe('EBMR-IAM-040');
    const h = valueOf(await stores.call(Q.cancelReservation, { params, body: { reason: 'Batch B26-9001 cancelled by planning' } }));
    expect(h.reservations[0]?.revoked).toMatchObject({ kind: 'CANCELLED', reason: 'Batch B26-9001 cancelled by planning', by: { loginName: 'manoj.pillai' } });
    expect(refused(await stores.call(Q.cancelReservation, { params, body: { reason: 'Again' } }))).toMatch(/EBMR-SITE-146 the reservation is already revoked/);
  }, 120_000);

  it('[PR-46] QA closes a stock-location exception only with a deviation linked to the lot and what was done; stores are refused for want of the right', async () => {
    const lot = await receive();
    const exceptionId =
      (await arrange<string>("insert into site.lot_location_exception (lot_id, move_id, problem, alarm_id) values ($1, gen_random_uuid(), $2, gen_random_uuid()) returning id as r", [
        lot.lotId,
        `lot ${lot.lotCode} is QUARANTINE: it may go only to quarantine stock`,
      ])) ?? '';
    const unlinked = valueOf(await qa.call(Q.raiseDeviation, { body: { kind: 'DEVIATION', title: 'Unrelated deviation', classification: 'MAJOR', riskRationale: 'Not linked to the lot at all' } }));
    const note = 'Pallet returned to quarantine; WMS rule corrected';
    expect(refused(await qa.call(Q.resolveLotLocationException, { params: { exceptionId }, body: { deviationId: unlinked.deviationId, note } }))).toMatch(/EBMR-SITE-921 .*closed with a deviation linked to the lot/);
    const deviationId = await linkedDeviation(lot.lotId);
    expect(refusalOf(await stores.call(Q.resolveLotLocationException, { params: { exceptionId }, body: { deviationId, note } }))?.code).toBe('EBMR-IAM-040');
    const h = valueOf(await qa.call(Q.resolveLotLocationException, { params: { exceptionId }, body: { deviationId, note } }));
    expect(h.locationExceptions).toHaveLength(1);
    expect(h.locationExceptions[0]).toMatchObject({ exceptionId, resolved: { deviationId, note, by: { loginName: 'divya.menon' } } });
  }, 120_000);

  it('[IN-20] QC links the OOS record of an approved failing result; a result not yet approved, a person without the right and a second link are refused', async () => {
    const lot = await receive();
    const result = valueOf(await analyst.call(Q.recordLotResult, { params: { lotId: lot.lotId }, body: { testCode: 'ASSAY', methodReference: 'STP-LH-01', purpose: 'RELEASE', value: '91.0', unit: '%' } }));
    expect(result.verdict).toBe('FAIL');
    const oos = await linkedDeviation(lot.lotId, 'OOS');
    const params = { resultId: result.resultId };
    expect(refused(await analyst.call(Q.linkLotTestOos, { params, body: { deviationId: oos } }))).toMatch(/EBMR-SITE-205 only a current approved failing result/);
    await signedOk(signAction(gmp, head, 'qcApprover', { kind: 'QUALITY_ACT', act: 'LOT_RESULT_APPROVE', subjectId: result.resultId, input: {} }));
    expect(refusalOf(await stores.call(Q.linkLotTestOos, { params, body: { deviationId: oos } }))?.code).toBe('EBMR-IAM-040');
    expect(valueOf(await analyst.call(Q.linkLotTestOos, { params, body: { deviationId: oos } }))).toEqual({ resultId: result.resultId, deviationId: oos });
    expect(refused(await analyst.call(Q.linkLotTestOos, { params, body: { deviationId: oos } }))).toMatch(/EBMR-SITE-205 the result is already linked/);
  }, 120_000);
});

describe('vendor-history routes (IN-24 (c))', () => {
  it('[IN-24] QA disables an enabled vendor-history route with the reason; stores are refused; the route is listed disabled and is not disabled again', async () => {
    const routeId =
      (await arrange<string>(
        `with v as (insert into site.vendor_route (site_code, material_code, material_kind, justification, statistical_reference, proposed_by_person, proposed_by_account)
                    values ('SITE-1', $1, 'EXCIPIENT', 'Twenty consecutive lots passed full testing at receipt', 'STAT-REP-2026-07', gen_random_uuid(), gen_random_uuid()) returning id)
         , e as (insert into site.vendor_route_enablement (route_id, signature_id, enabled_by_person, enabled_by_account) select id, gen_random_uuid(), gen_random_uuid(), gen_random_uuid() from v)
         select id as r from v`,
        [MATERIAL],
      )) ?? '';
    const listed = valueOf(await qa.call(Q.vendorRoutes)).routes.find((r) => r.routeId === routeId);
    expect(listed).toMatchObject({ materialCode: MATERIAL, disabled: null });
    expect(listed?.enabled).not.toBeNull();
    const reason = 'A lot failed its full test at receipt';
    expect(refusalOf(await stores.call(Q.disableVendorRoute, { params: { routeId }, body: { reason } }))?.code).toBe('EBMR-IAM-040');
    expect(valueOf(await qa.call(Q.disableVendorRoute, { params: { routeId }, body: { reason } }))).toMatchObject({ routeId, disabled: { reason, by: { loginName: 'divya.menon' } } });
    expect(refused(await qa.call(Q.disableVendorRoute, { params: { routeId }, body: { reason } }))).toMatch(/EBMR-SITE-133 .* is not enabled/);
  }, 120_000);
});
