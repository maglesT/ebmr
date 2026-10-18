/**
 * The transfers and federation routes over HTTP with two GMP servers, each on its own database and its own installation
 * key (Phase 6 slice 6i; contract ns/transfers.ts, genealogy.federatedTrace, recall; kernel 1220, site services 0980,
 * 0981, recipe-core 1090, 1091, tablets 1300, 1301; L-41, DI-31, DI-39, PR-57, IN-29). PUNE seals a package of a released
 * intermediate; GOA takes it in (a tampered copy is refused with an alarm) and its QA accepts it through the ceremony;
 * PUNE's explorer and mock recall ask GOA over real HTTP, and mark the result incomplete while GOA does not answer.
 *
 * Fixtures, not proofs (written as the owner, triggers off; each act is proven in the database tests of site services):
 * the installation identities and the proposed peer entries (deployment steps), the released intermediate lot at PUNE,
 * and GOA's consumption of the received lot with its finished lot and shipment.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { FEDERATION_RATE } from '../../src/features/transfers/index.ts';
import { rawPublicKeyOf } from '../../src/features/transfers/keys.ts';
import { withCommand } from '@ebmr/kernel';
import { passwordActor, type DatabaseHandle, type SiteSeed } from '@ebmr/test-kit';
import { decideRoleGrant, requestRoleGrant } from '../../../../packages/kernel/src/identity/admin.ts';
import { integrationActor, type Administration } from '../../../../packages/kernel/test/integrations/support.ts';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { FEDERATION_TERMINAL } from '../../src/features/transfers/index.ts';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

interface Site {
  code: string;
  server: TestServer;
  url: string;
  port: number;
  publicKey: string;
  stores: TestBrowser;
  qa: TestBrowser;
}

const tag = randomUUID().slice(0, 4).toUpperCase();
const lot = { id: randomUUID(), code: `INT-${tag}` };
let pune: Site;
let goa: Site;

async function fixture(server: TestServer, sql: string, params: unknown[]): Promise<void> {
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(sql, params);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

async function site(code: string): Promise<Site> {
  const pair = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'ebmr-6i-'));
  const file = join(dir, 'installation-key.json');
  writeFileSync(file, JSON.stringify({ installationCode: code, privateKeyPkcs8: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), label: 'DEMO-ONLY test key' }));
  const keys = join(dir, 'service-keys.json');
  // The federation endpoint's INTEGRATION identity in role FEDERATION_INTERFACE (recipe-core 1093), in the service-keys file.
  const server = await startSigningServer('GMP', {
    env: { EBMR_INSTALLATION_KEY_FILE: file, EBMR_FEDERATION_TIMEOUT_S: '3', EBMR_SERVICE_KEYS_FILE: keys },
    beforeStart: async (handle: DatabaseHandle, seed: SiteSeed) => {
      const db = handle as unknown as TestDatabase;
      const adm: Administration = {
        admin: await passwordActor(handle, seed.bootstrap.admin, seed.bootstrap.admin.fingerprint),
        owner: await passwordActor(handle, seed.bootstrap.owner, seed.bootstrap.owner.fingerprint),
        authn: handle.authn,
      };
      const fed = await integrationActor(db, `${code} federation endpoint`, adm);
      const reason = { reasonCode: 'TEST_SETUP', reasonText: 'the federation endpoint identity', correlationId: randomUUID() };
      const grant = await withCommand(db.app, { ...adm.admin, ...reason }, (c) => requestRoleGrant(c, { accountId: fed.accountId, roleCode: 'FEDERATION_INTERFACE', scope: {}, reason: 'federation endpoint' }));
      await withCommand(db.app, { ...adm.owner, ...reason, correlationId: randomUUID() }, (c) => decideRoleGrant(c, grant, true, 'approved for test'));
      writeFileSync(keys, JSON.stringify({ services: [{ terminal: FEDERATION_TERMINAL, loginName: fed.seed.loginName, serviceKey: fed.seed.password, fingerprint: fed.seed.deviceFingerprint }] }));
    },
  });
  await server.built.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (server.built.app.server.address() as AddressInfo).port;
  const publicKey = rawPublicKeyOf(pair.privateKey);
  const who = randomUUID();
  await fixture(server, `insert into platform.installation_identity (version, installation_code, site_code, edition, public_key, key_fingerprint, set_by_person, set_by_account)
                         values (1, $1, 'SITE-1', 'TABLETS', decode($2, 'base64'), encode(sha256(decode($2, 'base64')), 'hex'), $3, $3)`, [code, publicKey, who]);
  const [stores, qa] = await Promise.all([server.asPersona('stores'), server.asPersona('qaInvestigator')]);
  return { code, server, url: `http://127.0.0.1:${port}`, port, publicKey, stores, qa };
}

/** `at` proposes `peer` (fixture, the administrator's step); QA approves its key through the ceremony. */
async function trust(at: Site, peer: Site): Promise<void> {
  const id = randomUUID();
  await fixture(at.server, `insert into platform.peer_installation (id, installation_code, site_code, edition, base_url, public_key, key_fingerprint, proposed_by_person, proposed_by_account)
                            values ($1, $2, 'SITE-1', 'TABLETS', $3, decode($4, 'base64'), encode(sha256(decode($4, 'base64')), 'hex'), $1, $1)`, [id, peer.code, peer.url, peer.publicKey]);
  const r = await signAction(at.server, at.qa, 'qaInvestigator', { kind: 'PEER_INSTALLATION_APPROVE', peerId: id });
  expect(r.ok, JSON.stringify(r.ok ? null : r.error)).toBe(true);
}

beforeAll(async () => {
  [pune, goa] = await Promise.all([site(`PUNE-${tag}`), site(`GOA-${tag}`)]);
  await trust(pune, goa);
  await trust(goa, pune);
  const who = randomUUID();
  await fixture(pune.server, `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, retest_at, expires_at,
                                                            received_by_person, received_by_account, correlation_id)
                              values ($1, 'SITE-1', $2, 'GRAN-500', 'Paracetamol granules 500 mg', 'INTERMEDIATE', 500, 'kg', '2029-01-01T00:00:00Z', '2030-01-01T00:00:00Z', $3, $3, $3)`,
    [lot.id, lot.code, who]);
  await fixture(pune.server, `insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version)
                              select 'material_lot', $1, 'material_lot', max(v.version), 'RELEASED_FOR_FURTHER_PROCESSING', 2 from platform.machine_version v where v.machine_code = 'material_lot'`, [lot.id]);
}, 300_000);
afterAll(async () => {
  await Promise.all([pune?.server.close(), goa?.server.close()]);
});

let file: { packageId: string; packageNo: string; payload: string; seal: string };
let receiptId: string;

describe('lot-transfer packages over HTTP (L-41)', () => {
  it('[DI-31] PUNE seals a package with its installation key; GOA refuses a tampered copy with an alarm and takes the genuine one into QUARANTINE', async () => {
    const peers = valueOf(await pune.qa.call(routes.transfers.peers));
    expect(peers.installation).toMatchObject({ installationCode: pune.code, serverHoldsKey: true });
    expect(peers.peers).toMatchObject([{ installationCode: goa.code, state: 'APPROVED', baseUrl: goa.url }]);
    file = valueOf(await pune.stores.call(routes.transfers.prepare, { body: { lotId: lot.id, destination: goa.code, quantity: '100' } }));
    expect(file).toMatchObject({ packageNo: `${lot.code}/T1` });
    expect(valueOf(await pune.stores.call(routes.transfers.packages)).packages[0]).toMatchObject({ packageId: file.packageId, destination: goa.code, quantity: '100', status: 'RELEASED_FOR_FURTHER_PROCESSING', sealed: true });
    expect(valueOf(await pune.stores.call(routes.transfers.packageFile, { params: { packageId: file.packageId } }))).toEqual(file);
    // QA does not ship (MATERIAL.HANDLE is the stores').
    expect(refusalOf(await pune.qa.call(routes.transfers.prepare, { body: { lotId: lot.id, destination: goa.code, quantity: '1' } })).code).toMatch(/^EBMR-IAM-04/);

    const tampered = valueOf(await goa.stores.call(routes.transfers.import, { body: { payload: file.payload.replace('"quantity": "100"', '"quantity": "400"'), seal: file.seal } }));
    expect(tampered).toMatchObject({ outcome: 'REFUSED', kind: 'TAMPERED' });
    const alarms = valueOf(await goa.qa.call(routes.transfers.alarms)).alarms;
    expect(alarms[0]).toMatchObject({ kind: 'TAMPERED', severity: 'MAJOR', path: 'TRANSFER_IMPORT', peer: pune.code, acknowledgement: null });

    const r = valueOf(await goa.stores.call(routes.transfers.import, { body: { payload: file.payload, seal: file.seal } }));
    if (r.outcome !== 'RECEIVED') throw new Error(JSON.stringify(r));
    receiptId = r.receipt.receiptId;
    expect(r.receipt).toMatchObject({ origin: pune.code, originLotCode: lot.code, originState: 'RELEASED_FOR_FURTHER_PROCESSING', lotCode: lot.code, lotState: 'QUARANTINE', state: 'RECEIVED', quantity: '100', decision: null });
    expect(Number(r.receipt.holdRemainingSeconds)).toBeGreaterThan(0);
    expect(r.receipt.genealogy.map((n) => n.id)).toContain(lot.id);
    expect(valueOf(await goa.stores.call(routes.transfers.import, { body: { payload: file.payload, seal: file.seal } }))).toMatchObject({ outcome: 'REFUSED', kind: 'DUPLICATE' });
  });

  it('[DI-39] GOA\'s QA accepts the received lot through the ceremony; the stores cannot', async () => {
    const stores = await signAction(goa.server, goa.stores, 'stores', { kind: 'TRANSFER_RECEIPT_DECIDE', receiptId, decision: 'ACCEPTED' });
    expect(stores.ok).toBe(false);
    const ok = await signAction(goa.server, goa.qa, 'qaInvestigator', { kind: 'TRANSFER_RECEIPT_DECIDE', receiptId, decision: 'ACCEPTED' });
    expect(ok.ok, JSON.stringify(ok.ok ? null : ok.error)).toBe(true);
    expect(valueOf(await goa.qa.call(routes.transfers.receipt, { params: { receiptId } }))).toMatchObject({ state: 'ACCEPTED', decision: { decision: 'ACCEPTED' }, lotState: 'QUARANTINE' });
  });
});

describe('federated genealogy over HTTP (PR-57, IN-29)', () => {
  let received: string;
  it('[PR-57] the explorer\'s forward trace crosses the transfer: GOA answers, sealed, as of the instant asked', async () => {
    received = valueOf(await goa.qa.call(routes.transfers.receipt, { params: { receiptId } })).lotId;
    const ids = { batch: randomUUID(), finished: randomUUID(), shipment: randomUUID() };
    const who = randomUUID();
    await fixture(goa.server,
      `with b as (insert into recipe.batch_allocation_link (batch_id, allocation_id, batch_number, person_id, account_id, correlation_id)
                  values ($1, gen_random_uuid(), $4, $5, $5, $5) returning batch_id),
            c as (insert into site.lot_consumption (lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before, quantity_after,
                                                    market_set, identity_basis, consumed_by_person, consumed_by_account, xact_id)
                  values ($6, gen_random_uuid(), $1, $4, 'TABLETS', 'GRAN-500', 10, 'kg', 100, 90, '{IN}', 'INTERMEDIATE', $5, $5, 1) returning id),
            l as (insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                                 received_by_person, received_by_account, correlation_id)
                  values ($2, 'SITE-1', $4, 'PCM-500', 'Paracetamol tablets 500 mg', 'FINISHED', 1000, 'units', '2029-01-01T00:00:00Z', $5, $5, $5) returning id),
            fl as (insert into site.finished_lot (lot_id, batch_id, batch_number, edition, product_code, strength, markets, posted_by_person, posted_by_account)
                   values ($2, $1, $4, 'TABLETS', 'PCM-500', '500 mg', '{IN}', $5, $5) returning lot_id)
       insert into site.erp_shipment (id, shipment_no, lot_id, market, consignee_code, consignee_name, consignee_address, quantity, unit, quarantine, manufacturer_state,
                                      disposition_state, erp_reference, shipped_at, lot_code, product_name, strength, recorded_by_person, recorded_by_account, correlation_id)
       values ($3, $7, $2, 'IN', 'CUST-GOA', 'Goa Distributors', '4 Harbour Road, Panaji', 400, 'units', false, 'RELEASED', 'RELEASED', 'DN-1', now(), $4,
               'Paracetamol tablets 500 mg', '500 mg', $5, $5, $5)`,
      [ids.batch, ids.finished, ids.shipment, `GB-${tag}`, who, received, `SH-${tag}`]);
    const t = valueOf(await pune.qa.call(routes.genealogy.federatedTrace, { query: { kind: 'LOT', id: lot.id, direction: 'FORWARD' } }));
    expect(t.local.edges.map((e) => [e.node.kind, e.edgeKind])).toEqual([['LOT', null], ['TRANSFER', 'TRANSFERRED']]);
    expect(t.local.counts).toMatchObject({ transfers: 1 });
    expect(t.complete, JSON.stringify({ remote: t.remote.map((p) => [p.status, p.detail]), beyond: t.beyondOneHop })).toBe(true);
    expect(t.remote).toHaveLength(1);
    const part = t.remote[0]!;
    expect(part).toMatchObject({ transferId: file.packageId, peer: goa.code, status: 'ANSWERED', detail: null });
    expect(part.excerptAsOf?.us).toBe(t.local.asOf.us);
    expect(part.edges.map((e) => [e.node.kind, e.edgeKind, e.depth])).toEqual([['TRANSFER', null, 0], ['LOT', 'TRANSFER_RECEIVED', 1], ['BATCH', 'CONSUMED', 2], ['LOT', 'FINISHED', 3], ['SHIPMENT', 'SHIPPED', 4]]);
    expect(part.nodes.find((n) => n.kind === 'SHIPMENT')).toMatchObject({ state: 'CUST-GOA', label: `SH-${tag}` });
    // The plain trace route carries the TRANSFER node too (the additive node kind).
    expect(valueOf(await pune.qa.call(routes.genealogy.trace, { query: { kind: 'TRANSFER', id: file.packageId, direction: 'BACKWARD' } })).start).toMatchObject({ kind: 'TRANSFER', subKind: 'OUTBOUND', state: 'SEALED', name: goa.code });
  });

  it('[IN-29] a mock recall with one site down is marked incomplete, and complete once the site answers again', async () => {
    // GOA stops answering (its listener closes; the server itself keeps running).
    goa.server.built.app.server.closeAllConnections();
    await new Promise<void>((resolve) => goa.server.built.app.server.close(() => resolve()));
    const t = valueOf(await pune.qa.call(routes.genealogy.federatedTrace, { query: { kind: 'LOT', id: lot.id, direction: 'FORWARD' } }));
    expect(t.complete).toBe(false);
    expect(t.remote[0]).toMatchObject({ status: 'UNREACHABLE', peer: goa.code });
    expect(BigInt(t.remote[0]!.excerptAsOf!.us) < BigInt(t.local.asOf.us)).toBe(true);
    expect(t.remote[0]!.nodes.length).toBeGreaterThan(0);

    const run = valueOf(await pune.qa.call(routes.recall.run, { body: { subjectKind: 'LOT', subjectId: lot.id, authorityInformed: false } }));
    expect(run.queryVersion).toBe(2);
    expect(run.federation).toMatchObject({ complete: false, transfers: [{ transferId: file.packageId, destination: goa.code, status: 'UNREACHABLE' }] });
    expect(run.federation!.transfers[0]!.shipments).toMatchObject([{ consigneeCode: 'CUST-GOA' }]);
    const alarms = valueOf(await pune.qa.call(routes.transfers.alarms)).alarms;
    expect(alarms.some((a) => a.kind === 'UNREACHABLE' && a.path === 'FEDERATION_QUERY' && a.peer === goa.code)).toBe(true);

    // GOA answers again; the run is completed as of its own instant.
    await new Promise<void>((resolve, reject) => goa.server.built.app.server.listen(goa.port, '127.0.0.1', () => resolve()).once('error', reject));
    const again = valueOf(await pune.qa.call(routes.recall.refreshFederation, { params: { mockRecallId: run.mockRecallId }, body: {} }));
    expect(again.federation).toMatchObject({ complete: true, transfers: [{ status: 'ANSWERED' }] });
    expect(again.federation!.transfers[0]!.excerptAsOf?.us).toBe(run.asOf.us);
  });

  it('[IN-29][PR-57] a mock recall asks the destinations of its own stored run, so a failed genealogy read is no "no destination"; and nobody is asked before RECALL.MOCK_RUN is checked (6jc-R12)', async () => {
    // The server's own forward-genealogy read fails (the application role may not run it for this test): the run still
    // asks GOA, because the destinations are the stored run's (recipe-core 1225), and GOA answers.
    await pune.server.db.admin.query('revoke execute on function recipe.genealogy(text, uuid, text, timestamptz) from ebmr_app');
    const answered = await (async () => {
      try {
        return await pune.qa.call(routes.recall.run, { body: { subjectKind: 'LOT', subjectId: lot.id, authorityInformed: false } });
      } finally {
        await pune.server.db.admin.query('grant execute on function recipe.genealogy(text, uuid, text, timestamptz) to ebmr_app');
      }
    })();
    const run = valueOf(answered);
    expect(run.federation).toMatchObject({ complete: true, transfers: [{ transferId: file.packageId, destination: goa.code, status: 'ANSWERED' }] });

    // A person holding GENEALOGY.FEDERATE but not RECALL.MOCK_RUN (the QA MBR approver) is refused before any site is
    // asked: a stand-in listens at GOA's address and counts what reaches it.
    goa.server.built.app.server.closeAllConnections();
    await new Promise<void>((resolve) => goa.server.built.app.server.close(() => resolve()));
    let asked = 0;
    const standIn = createServer((_req, res) => {
      asked += 1;
      res.writeHead(503).end();
    });
    await new Promise<void>((resolve, reject) => standIn.listen(goa.port, '127.0.0.1', () => resolve()).once('error', reject));
    try {
      const approver = await pune.server.asPersona('approver');
      const refused = await approver.call(routes.recall.run, { body: { subjectKind: 'LOT', subjectId: lot.id, authorityInformed: false } });
      expect(refused.ok).toBe(false);
      expect(JSON.stringify(refused)).toMatch(/RECALL\.MOCK_RUN/);
      expect(refused.ok ? null : await approver.call(routes.recall.refreshFederation, { params: { mockRecallId: run.mockRecallId }, body: {} })).toMatchObject({ ok: false });
      expect(asked).toBe(0);
    } finally {
      await new Promise<void>((resolve) => standIn.close(() => resolve()));
      await new Promise<void>((resolve, reject) => goa.server.built.app.server.listen(goa.port, '127.0.0.1', () => resolve()).once('error', reject));
    }
  });

  it('[DI-31] the site-to-site endpoint is counted per client address: past the limit it answers 429 without asking the database (review 6i-R3)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < FEDERATION_RATE.max + 5; i += 1) {
      const res = await fetch(`${pune.url}/api/federation/genealogy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: 'not a request', seal: 'x' }) });
      statuses.push(res.status);
      if (res.status === 429) break;
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, -1).every((s) => s === 403)).toBe(true);
    expect(statuses.length).toBeGreaterThan(FEDERATION_RATE.max - 5);
  });

  it('[DI-31] the site-to-site endpoint refuses a request not sealed by a trusted installation', async () => {
    const res = await fetch(`${goa.url}/api/federation/genealogy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: JSON.stringify({ format: 'ebmr.federation-request.v1', nonce: randomUUID(), from: pune.code, to: goa.code, issuedAtUs: '1', query: {} }), seal: `${'A'.repeat(84)}BA==` }),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/EBMR-FED-00[46]/);
  });
});
