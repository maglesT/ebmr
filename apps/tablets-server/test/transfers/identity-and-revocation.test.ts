/**
 * The installation identity and the revocation of a trusted peer (Phase 7 slice 7g, work package 2; kernel 1220; L-41,
 * DI-31, DI-18; contract ns/transfers.ts):
 *  - the system administrator sets this installation's identity from the key the server holds (SYSTEM.CONFIGURE), the
 *    first-run set-up's next step; its code and site never change afterwards; QA may not set it; a server without a key
 *    sets nothing;
 *  - QA revokes an approved peer with the reason (TRANSFER.PEER_APPROVE); the administrator, who proposed it, may not.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { rawPublicKeyOf } from '../../src/features/transfers/keys.ts';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

const T = routes.transfers;
const servers: TestServer[] = [];
let server: TestServer;
let admin: TestBrowser;
let qa: TestBrowser;
const code = `PUNE-W2-${randomUUID().slice(0, 4).toUpperCase()}`;
let publicKey = '';

beforeAll(async () => {
  const pair = generateKeyPairSync('ed25519');
  publicKey = rawPublicKeyOf(pair.privateKey);
  const file = join(mkdtempSync(join(tmpdir(), 'ebmr-w2-key-')), 'installation-key.json');
  writeFileSync(file, JSON.stringify({ installationCode: code, privateKeyPkcs8: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), label: 'DEMO-ONLY test key' }));
  server = await startSigningServer('GMP', { stub: false, env: { EBMR_INSTALLATION_KEY_FILE: file } });
  servers.push(server);
  admin = await loginOf(server, await grantedPerson(server, 'SYSTEM_ADMINISTRATOR', 'Ira Admin'));
  qa = await server.asPersona('qaInvestigator');
}, 300_000);
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

describe('this installation\'s identity (first-run set-up, next step)', () => {
  it('[DI-31][DI-17] the administrator sets the identity from the key the server holds; QA may not; the code and site never change afterwards', async () => {
    expect(valueOf(await admin.call(T.peers)).installation).toBeNull();
    expect(refusalOf(await qa.call(T.setInstallationIdentity, { body: { siteCode: 'SITE-1', reason: 'try' } })).code).toBe('EBMR-IAM-040');
    const set = valueOf(await admin.call(T.setInstallationIdentity, { body: { siteCode: 'SITE-1', reason: 'first-run set-up' } }));
    expect(set).toMatchObject({ installationCode: code, siteCode: 'SITE-1', edition: 'TABLETS', keyVersion: 1, serverHoldsKey: true });
    const { rows } = await server.db.admin.query<{ pk: string }>("select encode(public_key, 'base64') as pk from platform.installation_identity");
    expect(rows).toEqual([{ pk: publicKey }]);
    // The site never changes (EBMR-XFR-003); the same key again is no new version.
    expect(refusalOf(await admin.call(T.setInstallationIdentity, { body: { siteCode: 'SITE-2', reason: 'move' } })).code).toBe('EBMR-XFR-003');
    expect(valueOf(await admin.call(T.setInstallationIdentity, { body: { siteCode: 'SITE-1', reason: 'again' } })).keyVersion).toBe(1);
  }, 120_000);

  it('[DI-31] a server that holds no installation key sets no identity', async () => {
    const plain = await startServer('GMP');
    servers.push(plain);
    const a = await loginOf(plain, await grantedPerson(plain, 'SYSTEM_ADMINISTRATOR', 'Ivo Admin'));
    expect(refusalOf(await a.call(T.setInstallationIdentity, { body: { siteCode: 'SITE-1', reason: 'try' } }))).toMatchObject({ status: 503, code: 'EBMR-FED-020' });
    expect((await plain.db.admin.query('select 1 from platform.installation_identity')).rows).toEqual([]);
  }, 120_000);
});

describe('the revocation of a trusted peer', () => {
  it('[DI-31][DI-18] QA revokes an approved peer with the reason; the administrator may not; a peer not approved is refused, and so is a reason under 10 characters', async () => {
    const peerKey = rawPublicKeyOf(generateKeyPairSync('ed25519').privateKey);
    const peer = valueOf(await admin.call(T.proposePeer, { body: { installationCode: `GOA-W2-${code.slice(-4)}`, siteCode: 'GOA-1', edition: 'TABLETS', baseUrl: 'https://goa.example.internal', publicKey: peerKey } }));
    expect(refusalOf(await qa.call(T.revokePeer, { params: { peerId: peer.peerId }, body: { reason: 'not approved yet, so nothing to revoke' } })).code).toBe('EBMR-XFR-006');
    valueOf(await signAction(server, qa, 'qaInvestigator', { kind: 'PEER_INSTALLATION_APPROVE', peerId: peer.peerId }));
    expect(refusalOf(await admin.call(T.revokePeer, { params: { peerId: peer.peerId }, body: { reason: 'the site was sold to another company' } })).code).not.toBe('OK');
    expect(refusalOf(await qa.call(T.revokePeer, { params: { peerId: peer.peerId }, body: { reason: 'sold' } })).status).toBe(400);
    const revoked = valueOf(await qa.call(T.revokePeer, { params: { peerId: peer.peerId }, body: { reason: 'the site was sold to another company' } }));
    expect(revoked).toMatchObject({ peerId: peer.peerId, state: 'REVOKED' });
  }, 120_000);
});
