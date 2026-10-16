/**
 * Controlled-substance mode over HTTP (Phase 6 slice 6e; draft IN-53; contract ns/controlled.ts; recipe-core 1031 to
 * 1034). QA records a flag under an approved change record and a second QA person approves it through the ceremony
 * (CONTROLLED_ACT FLAG_APPROVE); a transfer of a controlled lot is proposed and signed by the first custodian and
 * countersigned by another person (CUSTODY_FIRST, CUSTODY_SECOND), never by the same one; the register export is run and
 * still reproduces. Every refusal is the database's, shown with its code. The material master row and the lot are test
 * set-up written by the superuser (as in the CAPA routes test).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTROLLED_DRAFT_BANNER, routes } from '@ebmr/api-contract';
import { ensureFixtureChangeRecord } from '../../../../packages/kernel/test/support/change-record.ts';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

let server: TestServer;
let db: TestDatabase;
let approver: TestBrowser;
let qa2: TestBrowser;
let stores: TestBrowser;
let verifier: TestBrowser;
const material = `API-CTL-${randomUUID().slice(0, 6).toUpperCase()}`;
const product = `PCTL-${randomUUID().slice(0, 6).toUpperCase()}`;
const lot = { id: randomUUID(), code: `L-${randomUUID().slice(0, 6).toUpperCase()}` };

beforeAll(async () => {
  server = await startSigningServer('GMP');
  db = server.db as unknown as TestDatabase;
  [approver, qa2, stores, verifier] = await Promise.all([server.asPersona('approver'), server.asPersona('qaInvestigator'), server.asPersona('stores'), server.asPersona('verifier1')]);
  await ensureFixtureChangeRecord(db);
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const who = randomUUID();
    await c.query(
      `insert into site.erp_material (material_code, material_name, material_kind, unit, erp_reference, received_by_person, received_by_account, correlation_id)
       values ($1, 'Controlled API', 'API', 'kg', 'ERP-CTL', $2, $2, $2)`,
      [material, who],
    );
    await c.query(
      `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                      received_by_person, received_by_account, correlation_id)
       values ($1, 'SITE-1', $2, $3, 'Controlled API', 'API', 10, 'kg', '2030-01-01T00:00:00Z', $4, $4, $4)`,
      [lot.id, lot.code, material, who],
    );
    await c.query('commit');
  } finally {
    c.release();
  }
}, 600_000);
afterAll(async () => {
  await server?.close();
});

const codeOf = (r: Awaited<ReturnType<typeof signAction>>): string => (r.ok ? 'ok' : (refusalOf(r).why.match(/EBMR-[A-Z]+-\d{3}/)?.[0] ?? refusalOf(r).code));

describe('controlled-substance mode over HTTP (IN-53, draft)', () => {
  it('[IN-53] QA records a flag under a change record and a second QA person approves it through the ceremony; the recorder cannot', async () => {
    const body = { productCode: product, controlled: true, materialCodes: [material], basisRef: 'NDPS licence ML-17 (draft)', changeRecord: 'CR-NOPE' };
    expect(refusalOf(await approver.call(routes.controlled.recordProduct, { body })).code).toBe('EBMR-CFG-002');
    const recorded = valueOf(await approver.call(routes.controlled.recordProduct, { body: { ...body, changeRecord: 'CR-TEST-FIXTURE' } }));
    expect(recorded).toMatchObject({ productCode: product, materialsInEffect: [material], records: [{ state: 'RECORDED', approvedBy: null }] });
    const recordId = recorded.records[0]!.recordId;
    expect(codeOf(await signAction(server, approver, 'approver', { kind: 'CONTROLLED_ACT', act: 'FLAG_APPROVE', subjectId: recordId }))).not.toBe('ok');
    const ok = await signAction(server, qa2, 'qaInvestigator', { kind: 'CONTROLLED_ACT', act: 'FLAG_APPROVE', subjectId: recordId });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    const list = valueOf(await qa2.call(routes.controlled.products));
    expect(list.banner).toBe(CONTROLLED_DRAFT_BANNER);
    expect(list.products.find((p) => p.productCode === product)).toMatchObject({ materialsInEffect: [material], records: [{ state: 'APPROVED', approvedBy: { legalName: 'Divya Menon' } }] });
  });

  it('[IN-53] a transfer of a controlled lot is signed by two different custodians: the proposer first, another person second, never the same person twice', async () => {
    const proposed = valueOf(await stores.call(routes.controlled.proposeCustody, { body: { kind: 'TRANSFER', lotId: lot.id, quantity: '2.500', fromLocation: 'WH-A-01', toLocation: 'DISP-01' } }));
    expect(proposed).toMatchObject({ state: 'PROPOSED', quantity: '2.500', unit: 'kg', lotCode: lot.code, custodians: [] });
    // The second place before the first, or the first by another person, is refused.
    expect(codeOf(await signAction(server, verifier, 'verifier1', { kind: 'CONTROLLED_ACT', act: 'CUSTODY_SECOND', subjectId: proposed.custodyId }))).not.toBe('ok');
    const first = await signAction(server, stores, 'stores', { kind: 'CONTROLLED_ACT', act: 'CUSTODY_FIRST', subjectId: proposed.custodyId });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(codeOf(await signAction(server, stores, 'stores', { kind: 'CONTROLLED_ACT', act: 'CUSTODY_SECOND', subjectId: proposed.custodyId }))).not.toBe('ok');
    const second = await signAction(server, verifier, 'verifier1', { kind: 'CONTROLLED_ACT', act: 'CUSTODY_SECOND', subjectId: proposed.custodyId });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    const records = valueOf(await stores.call(routes.controlled.custody, { query: { lotId: lot.id } })).records;
    expect(records[0]).toMatchObject({ custodyId: proposed.custodyId, state: 'CONFIRMED', custodians: [{ position: 'FIRST', person: { legalName: 'Manoj Pillai' } }, { position: 'SECOND', person: { legalName: 'Kavya Reddy' } }] });
    // A dispensing names its batch: refused by the database with its code.
    expect(refusalOf(await stores.call(routes.controlled.proposeCustody, { body: { kind: 'DISPENSE', lotId: lot.id, quantity: '1' } })).code).toBe('EBMR-CSM-013');
  });

  it('[IN-53] the register export is run, listed and still reproduces; an unknown batch has no account', async () => {
    const today = (await db.admin.query<{ d: string }>("select (now() at time zone 'UTC')::date::text as d")).rows[0]!.d;
    const run = valueOf(await qa2.call(routes.controlled.runRegister, { body: { materialCode: material, from: '2026-01-01', to: today } }));
    expect(run).toMatchObject({ banner: CONTROLLED_DRAFT_BANNER, reproduces: true, materialCode: material });
    expect(run.result.rows.map((r) => r.movement)).toEqual(expect.arrayContaining(['RECEIPT', 'TRANSFER']));
    const again = valueOf(await qa2.call(routes.controlled.runRegister, { body: { materialCode: material, from: '2026-01-01', to: today } }));
    expect(again.resultSha256).toBe(run.resultSha256);
    expect(valueOf(await qa2.call(routes.controlled.registerExtracts)).extracts.map((x) => x.extractId)).toEqual(expect.arrayContaining([run.extractId, again.extractId]));
    expect(valueOf(await qa2.call(routes.controlled.registerExtract, { params: { extractId: run.extractId } })).reproduces).toBe(true);
    expect(refusalOf(await stores.call(routes.controlled.balance, { params: { batchId: randomUUID() } })).status).toBe(404);
    expect(refusalOf(await qa2.call(routes.controlled.recordCheckpoint, { body: { batchId: randomUUID(), stageKey: 'S@', materialCode: material, consumed: '0', inProcess: '0' } })).code).toBe('EBMR-CSM-030');
  });
});
