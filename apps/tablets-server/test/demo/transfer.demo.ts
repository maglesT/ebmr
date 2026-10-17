/**
 * Phase 6 exit demo, item 7 (L-41, DI-31, DI-39): a lot transferred between two sites and accepted by local QA
 * (`pnpm demo:phase6-exit`; vitest.demo.config.ts). Two GMP servers, PUNE and GOA, each on its own database with its own
 * installation key, listening on HTTP, as the slice 6i route tests run them (transfers/transfer-routes.test.ts, whose
 * set-up this file repeats): PUNE's stores seal a package of a released intermediate lot; GOA's stores take in a tampered
 * copy (refused with an alarm) and the genuine one (into QUARANTINE), a second copy is refused as a duplicate; GOA's QA
 * accepts the received lot through the signature ceremony (the stores cannot); PUNE's explorer then traces the lot across
 * the transfer and GOA answers over HTTP.
 *
 * Fixtures, not proofs (as in the route tests): the installation identities and proposed peer entries (deployment
 * steps), the released intermediate lot at PUNE. What the run observed is written to EBMR_DEMO_OUT (JSON) for the record.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
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


/** What the run observed, step by step (written after every step, so a failed run keeps what it saw). */
const record: { steps: { title: string; at: string; observed: Record<string, unknown> }[] } = { steps: [] };
function observe(title: string, observed: Record<string, unknown>): void {
  record.steps.push({ title, at: new Date().toISOString(), observed });
  const out = process.env['EBMR_DEMO_OUT'];
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  }
}

let file: { packageId: string; packageNo: string; payload: string; seal: string };
let receiptId: string;

describe('Phase 6 exit demo: a lot transferred between two sites and accepted by local QA', () => {
  it('[DI-31] PUNE seals a package of the released lot; GOA refuses a tampered copy with an alarm, takes the genuine one into QUARANTINE and refuses a second copy', async () => {
    const peers = valueOf(await pune.qa.call(routes.transfers.peers));
    expect(peers.peers).toMatchObject([{ installationCode: goa.code, state: 'APPROVED', baseUrl: goa.url }]);
    observe('Two installations trust each other (QA approved each peer key through the ceremony)', { pune: `${pune.code} ${pune.url}`, goa: `${goa.code} ${goa.url}`, puneSees: `${goa.code} ${String(peers.peers[0]?.state)}` });
    file = valueOf(await pune.stores.call(routes.transfers.prepare, { body: { lotId: lot.id, destination: goa.code, quantity: '100' } }));
    expect(file).toMatchObject({ packageNo: `${lot.code}/T1` });
    const sealed = valueOf(await pune.stores.call(routes.transfers.packages)).packages[0];
    expect(sealed).toMatchObject({ packageId: file.packageId, destination: goa.code, quantity: '100', sealed: true });
    observe('PUNE stores seal a package of the released intermediate lot for GOA (100 kg)', { lot: lot.code, packageNo: file.packageNo, packageId: file.packageId, sealed: sealed?.sealed ?? null, seal: file.seal.slice(0, 64) });

    const tampered = valueOf(await goa.stores.call(routes.transfers.import, { body: { payload: file.payload.replace('"quantity": "100"', '"quantity": "400"'), seal: file.seal } }));
    expect(tampered).toMatchObject({ outcome: 'REFUSED', kind: 'TAMPERED' });
    const alarms = valueOf(await goa.qa.call(routes.transfers.alarms)).alarms;
    expect(alarms[0]).toMatchObject({ kind: 'TAMPERED', severity: 'MAJOR', path: 'TRANSFER_IMPORT', peer: pune.code });
    observe('GOA stores take in a copy whose quantity was changed to 400', { outcome: tampered.outcome, kind: tampered.outcome === 'REFUSED' ? tampered.kind : null, alarmKind: alarms[0]?.kind ?? null, alarmSeverity: alarms[0]?.severity ?? null, alarmPath: alarms[0]?.path ?? null });

    const r = valueOf(await goa.stores.call(routes.transfers.import, { body: { payload: file.payload, seal: file.seal } }));
    if (r.outcome !== 'RECEIVED') throw new Error(JSON.stringify(r));
    receiptId = r.receipt.receiptId;
    expect(r.receipt).toMatchObject({ origin: pune.code, originLotCode: lot.code, originState: 'RELEASED_FOR_FURTHER_PROCESSING', lotState: 'QUARANTINE', state: 'RECEIVED', quantity: '100', decision: null });
    observe('GOA stores take in the genuine package', { outcome: r.outcome, receiptId, origin: r.receipt.origin, originState: r.receipt.originState, lotState: r.receipt.lotState, state: r.receipt.state, quantity: r.receipt.quantity, holdRemainingSeconds: r.receipt.holdRemainingSeconds });
    const dup = valueOf(await goa.stores.call(routes.transfers.import, { body: { payload: file.payload, seal: file.seal } }));
    expect(dup).toMatchObject({ outcome: 'REFUSED', kind: 'DUPLICATE' });
    observe('GOA stores take in the same package a second time', { outcome: dup.outcome, kind: dup.outcome === 'REFUSED' ? dup.kind : null });
  });

  it('[DI-39] GOA\'s QA accepts the received lot through the signature ceremony; the stores cannot', async () => {
    const stores = await signAction(goa.server, goa.stores, 'stores', { kind: 'TRANSFER_RECEIPT_DECIDE', receiptId, decision: 'ACCEPTED' });
    expect(stores.ok).toBe(false);
    const code = stores.ok ? null : refusalOf(stores).code;
    observe('GOA stores try to accept the receipt', { ok: stores.ok, refusal: code });
    const ok = await signAction(goa.server, goa.qa, 'qaInvestigator', { kind: 'TRANSFER_RECEIPT_DECIDE', receiptId, decision: 'ACCEPTED' });
    expect(ok.ok, JSON.stringify(ok.ok ? null : ok.error)).toBe(true);
    const view = valueOf(await goa.qa.call(routes.transfers.receipt, { params: { receiptId } }));
    expect(view).toMatchObject({ state: 'ACCEPTED', decision: { decision: 'ACCEPTED' } });
    observe('GOA QA accepts the receipt through the ceremony (TRANSFER_RECEIPT_DECIDE)', { ok: ok.ok, signature: ok.ok ? JSON.stringify(ok.value).slice(0, 200) : null, state: view.state, decision: view.decision?.decision ?? null, decidedBy: view.decision ? JSON.stringify(view.decision).slice(0, 200) : null, lotState: view.lotState });
  });

  it('[PR-57] PUNE\'s explorer traces the lot across the transfer and GOA answers over HTTP', async () => {
    const t = valueOf(await pune.qa.call(routes.genealogy.federatedTrace, { query: { kind: 'LOT', id: lot.id, direction: 'FORWARD' } }));
    expect(t.complete).toBe(true);
    expect(t.remote[0]).toMatchObject({ transferId: file.packageId, peer: goa.code, status: 'ANSWERED' });
    observe('PUNE traces its lot forward across the transfer', { complete: t.complete, localEdges: t.local.edges.map((e) => `${e.node.kind}:${String(e.edgeKind)}`).join(' '), remotePeer: t.remote[0]?.peer ?? null, remoteStatus: t.remote[0]?.status ?? null, remoteEdges: (t.remote[0]?.edges ?? []).map((e) => `${e.node.kind}:${String(e.edgeKind)}`).join(' ') });
  });
});
