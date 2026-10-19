/**
 * The first-run set-up from the browser (Phase 7 slice 7g-4; decision 0025 point 2; kernel 1375; features/operations
 * setup.ts): on a migrated installation with no accounts, the set-up with the installer's one-time token creates the
 * site, its zone, the first system administrator and process owner (two persons, DI-18) and the seal key; without the
 * token, or once set up, nothing is created. The administrator then signs in on this browser's key with the first
 * password and must change it.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routes, type SetupRequest } from '@ebmr/api-contract';
import { identity } from '@ebmr/kernel';
import { sha256Hex } from '@ebmr/expr';
import { asAdmin, dropDatabase } from '@ebmr/test-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refusalOf, valueOf } from '../esig/support.ts';
import { freshTemplate, startFreshServer, type FreshBrowser, type FreshServer } from './support.ts';

const O = routes.operations;
let template = '';
let sandboxTemplate = '';
const servers: FreshServer[] = [];

beforeAll(async () => {
  [template, sandboxTemplate] = await Promise.all([freshTemplate('GMP'), freshTemplate('SANDBOX')]);
}, 300_000);
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all([template, sandboxTemplate].filter((t) => t !== '').map((t) => dropDatabase(t)));
});

const start = async (kind: 'GMP' | 'SANDBOX', env: Record<string, string> = {}) => {
  const s = await startFreshServer(kind, kind === 'GMP' ? template : sandboxTemplate, { env });
  servers.push(s);
  return s;
};

const request = (b: FreshBrowser, token: string, over: Partial<SetupRequest> = {}): SetupRequest => ({
  token,
  site: { code: 'BLR-1', name: 'Bengaluru tablets plant', zone: 'Asia/Kolkata' },
  administrator: { legalName: 'Kavya Iyer', loginName: 'kavya.iyer', password: 'First-Admin-Password-1' },
  processOwner: { legalName: 'Rahul Menon', loginName: 'rahul.menon', password: 'First-Owner-Password-1' },
  consoleSpki: b.key.publicKeySpki,
  generateSealKey: false,
  ...over,
});

const accounts = async (s: FreshServer): Promise<number> => Number((await s.db.admin.query<{ n: string }>('select count(*) as n from iam.account')).rows[0]?.n ?? '0');

describe('the first-run set-up (decision 0025, kernel 1375)', () => {
  it('[DI-18] the set-up needs the installer\'s one-time token: without it, with a wrong or an expired one nothing is created; with it the administrator and the process owner exist, the token is used up, and a second set-up is refused', async () => {
    const s = await start('GMP');
    const b = s.browser();
    expect(valueOf(await b.call(routes.meta.get)).setupRequired).toBe(true);
    expect(valueOf(await b.call(O.setupState))).toMatchObject({ required: true, installation: 'GMP', demo: false, tokenIssued: false, siteZone: 'Asia/Kolkata', site: null, sealKey: 'NOT_CONFIGURED' });
    const none = refusalOf(await b.call(O.setup, { body: request(b, 'x'.repeat(43)) }));
    expect(none).toMatchObject({ status: 403, code: 'EBMR-SETUP-002' });
    const token = await s.issueToken();
    expect(valueOf(await b.call(O.setupState)).tokenIssued).toBe(true);
    expect(refusalOf(await b.call(O.setup, { body: request(b, `${token}x`) }))).toMatchObject({ status: 403, code: 'EBMR-SETUP-002' });
    // Expired: the owner sets the token's expiry back (as time passing would).
    await s.db.admin.query("update iam.setup_token set issued_at = issued_at - interval '2 hours', expires_at = clock_timestamp() - interval '1 second'");
    expect(refusalOf(await b.call(O.setup, { body: request(b, token) }))).toMatchObject({ status: 403, code: 'EBMR-SETUP-002' });
    expect(await accounts(s)).toBe(0);

    const good = await s.issueToken();
    const done = valueOf(await b.call(O.setup, { body: request(b, good) }));
    expect(done).toEqual({ siteCode: 'BLR-1', siteZone: 'Asia/Kolkata', administratorLogin: 'kavya.iyer', processOwnerLogin: 'rahul.menon', consoleDeviceCode: 'BOOTSTRAP-CONSOLE-1', sealKeyId: null });
    expect(await accounts(s)).toBe(2);
    const { rows } = await s.db.admin.query<{ role: string; login: string }>(
      "select g.role_code as role, a.login_name as login from iam.role_grant g join iam.account a on a.id = g.account_id where g.status = 'APPROVED' order by 1",
    );
    expect(rows).toEqual([{ role: 'PROCESS_OWNER', login: 'rahul.menon' }, { role: 'SYSTEM_ADMINISTRATOR', login: 'kavya.iyer' }]);
    expect((await s.db.admin.query('select 1 from iam.setup_token where consumed_at is null')).rows).toEqual([]);
    expect((await s.db.admin.query<{ code: string; name: string }>('select site_code as code, site_name as name from iam.installation_site')).rows).toEqual([{ code: 'BLR-1', name: 'Bengaluru tablets plant' }]);
    // The set-up's writes are attributed to the installation pipeline, with the set-up's reason.
    const audit = await s.db.admin.query<{ reason: string }>("select distinct payload ->> 'reason_code' as reason from kernel.audit_event where chain_key like 'installation_site:%'");
    expect(audit.rows).toEqual([{ reason: 'FIRST_RUN_SETUP' }]);
    const by = await s.db.admin.query<{ name: string }>("select distinct payload -> 'actor' ->> 'legal_name' as name from kernel.audit_event where chain_key like 'installation_site:%'");
    expect(by.rows).toEqual([{ name: 'Installation pipeline' }]);
    const meta = valueOf(await b.call(routes.meta.get));
    expect(meta).toMatchObject({ setupRequired: false, site: { code: 'BLR-1', zone: 'Asia/Kolkata' } });

    expect(refusalOf(await b.call(O.setup, { body: request(b, good) }))).toMatchObject({ status: 409, code: 'EBMR-SETUP-001' });
    await expect(s.db.admin.query("select iam.issue_setup_token(repeat('a', 64), 60)")).rejects.toThrow(/EBMR-SETUP-001/);
    // Once set up, the state read without a session says only that.
    expect(valueOf(await b.call(O.setupState))).toMatchObject({ required: false, tokenIssued: false, site: null });
  });

  it('[DI-18] the system administrator and the process owner are two different persons; the token stays unused after a refusal', async () => {
    const s = await start('GMP');
    const b = s.browser();
    const token = await s.issueToken();
    const same = request(b, token, { processOwner: { legalName: 'Kavya Iyer', loginName: 'kavya.owner', password: 'First-Owner-Password-1' } });
    expect(refusalOf(await b.call(O.setup, { body: same }))).toMatchObject({ code: 'EBMR-SETUP-004' });
    const sameLogin = request(b, token, { processOwner: { legalName: 'Rahul Menon', loginName: 'KAVYA.IYER', password: 'First-Owner-Password-1' } });
    expect(refusalOf(await b.call(O.setup, { body: sameLogin }))).toMatchObject({ code: 'EBMR-SETUP-004' });
    expect(refusalOf(await b.call(O.setup, { body: request(b, token, { site: { code: 'bad code!', name: 'x', zone: 'UTC' } }) }))).toMatchObject({ code: 'EBMR-SETUP-003' });
    expect(await accounts(s)).toBe(0);
    expect(valueOf(await b.call(O.setupState)).tokenIssued).toBe(true);
    valueOf(await b.call(O.setup, { body: request(b, token) }));
  });

  it('[DI-27][DI-09] the set-up confirms the site time zone it showed, the one in force; it does not change it (a change is made afterwards under a change record), so another zone is refused and nothing is created', async () => {
    const s = await start('GMP');
    const b = s.browser();
    const token = await s.issueToken();
    const shown = valueOf(await b.call(O.setupState)).siteZone;
    expect(shown).toBe('Asia/Kolkata');
    expect(refusalOf(await b.call(O.setup, { body: request(b, token, { site: { code: 'FRA-1', name: 'Frankfurt', zone: 'Europe/Berlin' } }) }))).toMatchObject({ code: 'EBMR-SETUP-006' });
    expect(await accounts(s)).toBe(0);
    expect((await s.db.admin.query<{ z: string }>("select iam.policy_text('site.zone') as z")).rows[0]?.z).toBe('Asia/Kolkata');
    const done = valueOf(await b.call(O.setup, { body: request(b, token, { site: { code: 'FRA-1', name: 'Frankfurt', zone: shown } }) }));
    expect(done.siteZone).toBe('Asia/Kolkata');
    const zones = await s.db.admin.query<{ z: string }>("select distinct coalesce(payload ->> 'site_zone', payload -> 'actor' ->> 'site_zone') as z from kernel.audit_event where payload ->> 'reason_code' = 'INSTALLATION_BOOTSTRAP'");
    expect(zones.rows.map((r) => r.z)).toEqual(['Asia/Kolkata']);
  });

  it('[DI-20][DI-19] the set-up browser\'s key is the administrator\'s console: the first passwords sign in there only through a change of password; a browser with another key is not a terminal', async () => {
    const s = await start('GMP');
    const b = s.browser();
    valueOf(await b.call(O.setup, { body: request(b, await s.issueToken()) }));
    const body = { proof: await b.proof('POST', '/api/session/identify', {}) };
    expect(valueOf(await b.call(routes.session.identify, { body }))).toMatchObject({ deviceCode: 'BOOTSTRAP-CONSOLE-1', deviceClass: 'PERSONAL' });
    // A browser whose key is no registered terminal is not one (DI-20).
    const other = s.browser();
    expect(refusalOf(await other.call(routes.session.identify, { body: { proof: await other.proof('POST', '/api/session/identify', {}) } })).status).toBeGreaterThanOrEqual(400);
    // The first password is a BOOTSTRAP credential: the sign-in is refused until it is changed (kernel 0150), through
    // the ticket of that refusal; then the administrator is signed in on the console.
    const admin = await b.signIn('kavya.iyer', 'First-Admin-Password-1', 'Changed-Admin-Password-2026');
    expect(admin.ok).toBe(true);
    expect(valueOf(await b.call(routes.session.get))).toMatchObject({ person: { loginName: 'kavya.iyer' }, role: 'SYSTEM_ADMINISTRATOR' });
    expect(refusalOf(await s.browser(b.key).signIn('kavya.iyer', 'First-Admin-Password-1'))).toMatchObject({ status: 401 });
    // The process owner signs in on this terminal too (their own console is a placeholder nobody holds, D-P7g4-4).
    const owner = s.browser(b.key);
    expect((await owner.signIn('rahul.menon', 'First-Owner-Password-1', 'Changed-Owner-Password-2026')).ok).toBe(true);
    expect(valueOf(await owner.call(routes.session.get))).toMatchObject({ person: { loginName: 'rahul.menon' }, role: 'PROCESS_OWNER' });
  });

  it('the set-up generates the seal key into the configured file and registers its id (never its secret); a key already there is kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ebmr-setup-seal-'));
    const file = join(dir, 'seal-key.json');
    const s = await start('GMP', { EBMR_SEAL_KEY_FILE: file });
    const b = s.browser();
    expect(valueOf(await b.call(O.setupState)).sealKey).toBe('GENERATE');
    expect(s.built.ctx.sealKey).toBeNull();
    const done = valueOf(await b.call(O.setup, { body: request(b, await s.issueToken(), { generateSealKey: true }) }));
    expect(done.sealKeyId).toMatch(/^seal-[0-9a-f]{12}$/);
    expect(existsSync(file)).toBe(true);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { keyId: string; algorithm: string; secret: string };
    expect(stored).toMatchObject({ keyId: done.sealKeyId, algorithm: 'HMAC-SHA256' });
    expect(Buffer.from(stored.secret, 'base64')).toHaveLength(32);
    const { rows } = await s.db.admin.query<{ key_id: string; public_key: string | null; who: string }>(
      'select k.key_id, k.public_key, a.login_name as who from esig.seal_key k join iam.account a on a.id = k.registered_by_account',
    );
    expect(rows).toEqual([{ key_id: done.sealKeyId, public_key: null, who: 'kavya.iyer' }]);
    expect(JSON.stringify((await s.db.admin.query('select * from esig.seal_key')).rows)).not.toContain(stored.secret);
    expect(s.built.ctx.sealKey).not.toBeNull();
  });

  it('[DI-18] the database issues a set-up token only as a SHA-256 of 64 lowercase hex digits valid for 5 minutes to 7 days, and takes a token of 32 to 256 characters with the set-up naming its site (a name of 1 to 200 characters), its administrator and its process owner; each part refused on its own', async () => {
    const s = await start('GMP');
    // Each call in its own transaction, rolled back: the installation stays as it is.
    const inTx = (work: (c: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>): Promise<string> =>
      asAdmin(s.database, async (c) => {
        await c.query('begin');
        try {
          await work(c);
          return 'ok';
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        } finally {
          await c.query('rollback');
        }
      });
    const issue = (hash: string | null, minutes: number | null) => inTx((c) => c.query('select iam.issue_setup_token($1, $2)', [hash, minutes]));
    const asSha = /^EBMR-SETUP-003 a set-up token is stored as its SHA-256/;
    const valid = /^EBMR-SETUP-003 a set-up token is valid for 5 minutes to 7 days$/;
    expect(await issue(null, 60)).toMatch(asSha);
    expect(await issue('A'.repeat(64), 60)).toMatch(asSha);
    expect(await issue('a'.repeat(63), 60)).toMatch(asSha);
    expect(await issue('a'.repeat(64), null)).toMatch(valid);
    expect(await issue('a'.repeat(64), 4)).toMatch(valid);
    expect(await issue('a'.repeat(64), 10081)).toMatch(valid);
    expect(await issue('a'.repeat(64), 5)).toBe('ok');
    expect(await issue('a'.repeat(64), 10080)).toBe('ok');
    expect((await s.db.admin.query('select 1 from iam.setup_token')).rows).toEqual([]);

    const site = { code: 'BLR-1', name: 'Bengaluru tablets plant', zone: 'Asia/Kolkata' };
    // The same person twice: a set-up that passes every check before the two-person rule ends with EBMR-SETUP-004.
    const same = { legalName: 'Kavya Iyer', loginName: 'kavya.iyer', verifier: 'x', console: 'x' };
    const def = (over: Record<string, unknown> = {}) => ({ site, administrator: same, processOwner: same, ...over });
    const setup = (token: string | null, d: unknown, issued: string | null = token) =>
      inTx(async (c) => {
        if (issued !== null) await c.query('select iam.issue_setup_token($1, 60)', [sha256Hex(issued)]);
        await c.query('select iam.first_run_setup($1, $2::jsonb)', [token, d === null ? null : JSON.stringify(d)]);
      });
    const notValid = /^EBMR-SETUP-002 /;
    const passed = /^EBMR-SETUP-004 /;
    expect(await setup(null, def(), 'a'.repeat(40))).toMatch(notValid);
    expect(await setup('a'.repeat(31), def())).toMatch(notValid);
    expect(await setup('a'.repeat(257), def())).toMatch(notValid);
    expect(await setup('a'.repeat(32), def())).toMatch(passed);
    expect(await setup('a'.repeat(256), def())).toMatch(passed);
    expect(await setup('a'.repeat(40), def(), 'b'.repeat(40))).toMatch(notValid);

    const names = /^EBMR-SETUP-003 the set-up names the site, the system administrator and the process owner$/;
    const token = 't'.repeat(43);
    expect(await setup(token, null)).toMatch(names);
    expect(await setup(token, [def()])).toMatch(names);
    expect(await setup(token, def({ site: undefined }))).toMatch(names);
    expect(await setup(token, def({ site: 'BLR-1' }))).toMatch(names);
    expect(await setup(token, def({ administrator: undefined }))).toMatch(names);
    expect(await setup(token, def({ administrator: 'kavya.iyer' }))).toMatch(names);
    expect(await setup(token, def({ processOwner: undefined }))).toMatch(names);
    expect(await setup(token, def({ processOwner: ['rahul.menon'] }))).toMatch(names);
    const siteName = /^EBMR-SETUP-003 the site name is 1 to 200 characters$/;
    expect(await setup(token, def({ site: { ...site, name: '  ' } }))).toMatch(siteName);
    expect(await setup(token, def({ site: { ...site, name: undefined } }))).toMatch(siteName);
    expect(await setup(token, def({ site: { ...site, name: 'n'.repeat(201) } }))).toMatch(siteName);
    expect(await setup(token, def({ site: { ...site, name: 'n'.repeat(200) } }))).toMatch(passed);

    // A complete set-up (rolled back): the seal key names its id and HMAC-SHA256 or ED25519, never anything else.
    const person = async (legalName: string, loginName: string) => ({ legalName, loginName, verifier: await identity.hashSecret(`${loginName}-Password-1`), console: randomBytes(32).toString('hex') });
    const complete = { site, administrator: await person('Kavya Iyer', 'kavya.iyer'), processOwner: await person('Rahul Menon', 'rahul.menon') };
    const sealKey = /^EBMR-SETUP-005 /;
    expect(await setup(token, { ...complete, sealKey: { keyId: 'seal-000000000001', algorithm: 'RSA' } })).toMatch(sealKey);
    expect(await setup(token, { ...complete, sealKey: { keyId: 'seal-000000000001' } })).toMatch(sealKey);
    expect(await setup(token, { ...complete, sealKey: 'seal-000000000001' })).toMatch(sealKey);
    expect(await setup(token, { ...complete, sealKey: ['HMAC-SHA256'] })).toMatch(sealKey);
    expect(await setup(token, { ...complete, sealKey: { keyId: 'seal-000000000001', algorithm: 'HMAC-SHA256' } })).toBe('ok');
    expect(await setup(token, { ...complete, sealKey: null })).toBe('ok');
    expect(await accounts(s)).toBe(0);
  });

  it('[DI-05] a sandbox is set up the same way, with its TEST- labels; a name that is not a test label is refused there', async () => {
    const s = await start('SANDBOX');
    const b = s.browser();
    const token = await s.issueToken();
    expect(valueOf(await b.call(O.setupState))).toMatchObject({ required: true, installation: 'SANDBOX' });
    expect((await b.call(O.setup, { body: request(b, token) })).ok).toBe(false);
    const done = valueOf(await b.call(O.setup, {
      body: request(b, token, {
        administrator: { legalName: 'TEST-Kavya Iyer', loginName: 'test-kavya', password: 'First-Admin-Password-1' },
        processOwner: { legalName: 'TEST-Rahul Menon', loginName: 'test-rahul', password: 'First-Owner-Password-1' },
      }),
    }));
    expect(done.consoleDeviceCode).toBe('TEST-BOOTSTRAP-CONSOLE-1');
    const by = await s.db.admin.query<{ name: string }>("select distinct payload -> 'actor' ->> 'legal_name' as name from kernel.audit_event where chain_key like 'installation_site:%'");
    expect(by.rows).toEqual([{ name: 'TEST-Installation pipeline' }]);
  });
});
