/**
 * The security verification tools (slice 7d; docs/security/pentest-checklist.md): the installation hardening check,
 * the licence and secret scans, the SBOM and the signed release manifest. Each rule is shown to pass a good input and
 * to fail a bad one; the live checks run on the test cluster and on this repository.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ADMIN_URL } from '@ebmr/test-kit';
import { demoChecks, hbaChecks, listeners, portChecks, postgresChecks, roleChecks, runHardeningCheck, serverChecks, type RoleRow } from '../src/hardening.ts';
import { buildSbom, expressionAllowed, licenceFindings, scanRepository, scanText, signBytes, signingKey, spkiSha256, verifyBytes } from '../src/supply-chain.ts';

const status = (checks: { id: string; status: string }[]) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

const GOOD_SETTINGS = new Map([
  ['ssl', 'on'], ['ssl_min_protocol_version', 'TLSv1.2'], ['password_encryption', 'scram-sha-256'], ['fsync', 'on'], ['full_page_writes', 'on'],
  ['log_connections', 'on'], ['log_disconnections', 'on'], ['synchronous_commit', 'on'], ['shared_preload_libraries', 'pgaudit'], ['archive_mode', 'on'], ['archive_timeout', '60'],
]);
const role = (rolname: string, over: Partial<RoleRow> = {}): RoleRow => ({ rolname, rolsuper: false, rolcanlogin: true, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolreplication: false, pw: 'SCRAM-S', ...over });

describe('installation hardening check (slice 7d)', () => {
  it('[DI-13] PostgreSQL settings: TLS 1.2 or later, SCRAM, durability, connection logging, pgaudit and WAL archiving, by the kernel\'s rules', () => {
    expect(Object.values(status(postgresChecks(GOOD_SETTINGS))).every((s) => s === 'PASS')).toBe(true);
    const bad = new Map(GOOD_SETTINGS);
    for (const [k, v] of [['ssl', 'off'], ['fsync', 'off'], ['synchronous_commit', 'off'], ['log_connections', 'off'], ['shared_preload_libraries', ''], ['archive_mode', 'off']] as const) bad.set(k, v);
    expect(status(postgresChecks(bad))).toMatchObject({ 'PG-TLS': 'FAIL', 'PG-FSYNC': 'FAIL', 'PG-SYNC': 'FAIL', 'PG-LOGCONN': 'FAIL', 'PG-AUDIT': 'FAIL', 'PG-ARCHIVE': 'FAIL', 'PG-FPW': 'PASS' });
    expect(status(postgresChecks(new Map([...GOOD_SETTINGS, ['ssl_min_protocol_version', 'TLSv1.1']])))['PG-TLS']).toBe('FAIL');
  });

  it('[DI-13] client authentication: hostssl with SCRAM or certificates passes; host, trust and md5 fail', () => {
    const ok = [{ type: 'local', database: ['all'], users: ['postgres'], address: null, netmask: null, method: 'peer' }, { type: 'hostssl', database: ['ebmr_tablets'], users: ['ebmr_app'], address: '10.0.0.0', netmask: '255.255.255.0', method: 'scram-sha-256' }];
    expect(status(hbaChecks(ok))['PG-HBA']).toBe('PASS');
    expect(status(hbaChecks([...ok, { type: 'host', database: ['all'], users: ['all'], address: '0.0.0.0', netmask: '0.0.0.0', method: 'scram-sha-256' }]))['PG-HBA']).toBe('FAIL');
    expect(status(hbaChecks([...ok, { type: 'hostssl', database: ['all'], users: ['all'], address: '10.0.0.0', netmask: '255.0.0.0', method: 'trust' }]))['PG-HBA']).toBe('FAIL');
    expect(status(hbaChecks([{ type: 'local', database: ['all'], users: ['all'], address: null, netmask: null, method: 'md5' }]))['PG-HBA']).toBe('FAIL');
  });

  it('[DI-13][DI-18] roles: the installation logins hold no strong right, the owner cannot log in, passwords are SCRAM, only the break-glass login is a superuser', () => {
    const good = [role('ebmr_app'), role('ebmr_authn'), role('ebmr_owner', { rolcanlogin: false, pw: '' }), role('postgres', { rolsuper: true })];
    expect(Object.values(status(roleChecks(good, ['postgres']))).every((s) => s === 'PASS')).toBe(true);
    expect(status(roleChecks([...good, role('ebmr_listener', { rolbypassrls: true })], ['postgres']))['ROLE-APP']).toBe('FAIL');
    expect(status(roleChecks([role('ebmr_app'), role('ebmr_owner', { pw: '' })], ['postgres']))['ROLE-OWNER']).toBe('FAIL');
    expect(status(roleChecks([...good, role('legacy', { pw: 'md5abcd' })], ['postgres']))['ROLE-SCRAM']).toBe('FAIL');
    expect(status(roleChecks([...good, role('ops', { rolsuper: true })], ['postgres']))['ROLE-SUPER']).toBe('FAIL');
  });

  it('[DI-13][DI-05] demo material: a demo marker, a DEMO-ONLY key or a demo person fails a production database; PUBLIC may not connect', () => {
    expect(Object.values(status(demoChecks({ demoMarker: false, demoKeys: [], demoPersons: [], publicConnect: false }))).every((s) => s === 'PASS')).toBe(true);
    expect(status(demoChecks({ demoMarker: true, demoKeys: ['seal key demo-gmp-hmac-1'], demoPersons: ['asha.rao'], publicConnect: true }))).toEqual({ 'DEMO-MARKER': 'FAIL', 'DEMO-KEYS': 'FAIL', 'DEMO-PERSONS': 'FAIL', 'DB-PUBLIC': 'FAIL' });
  });

  it('[DI-13] the server: database URLs verify the server (sslmode=verify-full), the origin is https, the plain-HTTP listener is on loopback, no demo switch', () => {
    const env = { EBMR_ENV: 'production', EBMR_PUBLIC_ORIGIN: 'https://ebmr.site.example', EBMR_HOST: '127.0.0.1', EBMR_DB_APP_URL: 'postgres://ebmr_app@db1/ebmr?sslmode=verify-full', EBMR_DB_AUTHN_URL: 'postgres://ebmr_authn@db1/ebmr?sslmode=verify-full' };
    expect(Object.values(status(serverChecks(env))).every((s) => s === 'PASS')).toBe(true);
    expect(status(serverChecks({ ...env, EBMR_DB_APP_URL: 'postgres://ebmr_app@db1/ebmr?sslmode=prefer' }))['SRV-CONFIG']).toBe('FAIL');
    expect(status(serverChecks({ ...env, EBMR_PUBLIC_ORIGIN: 'http://ebmr.site.example' }))['SRV-CONFIG']).toBe('FAIL');
    expect(status(serverChecks({ ...env, EBMR_HOST: '0.0.0.0' }))['SRV-LISTEN']).toBe('FAIL');
    expect(status(serverChecks({ ...env, EBMR_DEMO: '1' }))['SRV-DEMO']).toBe('FAIL');
  });

  it('[DI-13] open ports: listeners off loopback must be in the allowed list; loopback listeners are not counted', () => {
    const tcp = ['  sl  local_address rem_address   st', '   0: 0100007F:0BB9 00000000:0000 0A', '   1: 00000000:01BB 00000000:0000 0A', '   2: 00000000:1538 00000000:0000 0A', '   3: 0100007F:1F90 0100007F:D0D0 01'].join('\n');
    const tcp6 = ['  sl  local_address rem_address   st', '   0: 00000000000000000000000001000000:0CEA 00000000000000000000000000000000:0000 0A', '   1: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A'].join('\n');
    const list = listeners(tcp, tcp6);
    expect(list).toEqual([{ address: '127.0.0.1', port: 3001 }, { address: '0.0.0.0', port: 443 }, { address: '0.0.0.0', port: 5432 }, { address: '::1', port: 3306 }, { address: '::', port: 22 }]);
    expect(status(portChecks(list, [443, 5432, 22]))['PORTS']).toBe('PASS');
    const failed = portChecks(list, [443, 5432]);
    expect(failed[0]?.status).toBe('FAIL');
    expect(failed[0]?.evidence).toContain(':::22');
  });

  it('[DI-13] the live check reads the test cluster: settings, roles and the database, each check with its evidence', async () => {
    const r = await runHardeningCheck({ databaseUrl: ADMIN_URL, serverEnv: {}, allowedPorts: [], procNet: { tcp: 'header\n', tcp6: 'header\n' }, breakGlassRoles: ['postgres'] });
    expect(r.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['PG-TLS', 'PG-FSYNC', 'PG-HBA', 'ROLE-APP', 'ROLE-SUPER', 'DEMO-KEYS', 'SRV-CONFIG', 'PORTS']));
    for (const c of r.checks) expect(c.evidence, c.id).not.toBe('');
    // The development cluster's own superuser login is not the break-glass account: the check names it.
    expect(r.checks.find((c) => c.id === 'ROLE-SUPER')).toMatchObject({ status: 'FAIL', evidence: expect.stringContaining('ebmr_dev') as unknown });
  });
});

describe('supply chain: licences, secrets, SBOM and the signed manifest (slice 7d)', () => {
  it('[DI-13] the licence policy: permissive licences pass; a copyleft licence fails in production; a reviewed package is named with its note', () => {
    expect(expressionAllowed('(MIT AND Zlib)', (x) => ['MIT', 'Zlib'].includes(x))).toBe(true);
    expect(expressionAllowed('WTFPL OR GPL-3.0', (x) => x === 'WTFPL')).toBe(true);
    expect(expressionAllowed('Apache-2.0 AND GPL-2.0', (x) => x === 'Apache-2.0')).toBe(false);
    const all = { MIT: [{ name: 'a', versions: ['1.0.0'] }], 'GPL-3.0': [{ name: 'b', versions: ['2.0.0'] }], 'MPL-2.0': [{ name: 'c', versions: ['1.0.0'] }, { name: 'd', versions: ['1.0.0'] }], Unknown: [{ name: 'humanize', versions: ['0.0.9'] }] };
    const prod = { MIT: [{ name: 'a', versions: ['1.0.0'] }], 'GPL-3.0': [{ name: 'b', versions: ['2.0.0'] }], 'MPL-2.0': [{ name: 'd', versions: ['1.0.0'] }], Unknown: [{ name: 'humanize', versions: ['0.0.9'] }] };
    const f = Object.fromEntries(licenceFindings(all, prod).map((x) => [x.package, x.status]));
    expect(f).toEqual({ 'a@1.0.0': 'ALLOWED', 'b@2.0.0': 'DENIED', 'c@1.0.0': 'DEV_ONLY', 'd@1.0.0': 'DENIED', 'humanize@0.0.9': 'REVIEWED' });
  });

  it('[DI-13] the secret scan finds keys and tokens in any file, allows only the documented test material, and finds none open in this repository', () => {
    const fake = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    expect(scanText('apps/x/src/a.ts', `const k = '${fake}\\nMIIE'`).map((h) => [h.pattern, h.allowed])).toEqual([['PEM_PRIVATE_KEY', 'the marker as text in code or docs (a parser or a check), not a key']]);
    expect(scanText('apps/x/config.json', `{"secret": "${'A'.repeat(43)}="}`).map((h) => [h.pattern, h.allowed])).toEqual([['PRIVATE_KEY_FIELD', null]]);
    expect(scanText('docs/x.md', `token ${'gh'}p_${'a1'.repeat(20)}`)[0]?.allowed).toBeNull();
    expect(scanText('docs/x.md', 'postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres')[0]?.allowed).not.toBeNull();
    expect(scanText('tools/x/test/a.ts', 'EBMR_DB_APP_URL=postgres://ebmr_app:********@localhost:5433/ebmr')[0]?.allowed).not.toBeNull();
    expect(scanText('tools/x/test/a.ts', 'postgres://ebmr_app:' + 'Xq7Zp2r9' + '@localhost:5433/ebmr')[0]?.allowed).toBeNull();
    expect(scanText('ops/x.sh', ['postgres://backup', 'Hunter2Real!@db1/ebmr'].join(':'))[0]?.allowed).toBeNull();
    const open = scanRepository().filter((h) => h.allowed === null);
    expect(open).toEqual([]);
  });

  it('[DI-13] the SBOM lists every locked package with its purl, licence, integrity hash and scope, from the commit and the lockfile only', () => {
    const lockfile = "lockfileVersion: '9.0'\npackages:\n  '@scope/a@1.2.3':\n    resolution: {integrity: sha512-AAAA}\n  b@4.5.6:\n    resolution: {integrity: sha512-BBBB}\n";
    const licences = { MIT: [{ name: '@scope/a', versions: ['1.2.3'] }], ISC: [{ name: 'b', versions: ['4.5.6'] }] };
    const sbom = buildSbom({ lockfile, licences, production: { MIT: [{ name: '@scope/a', versions: ['1.2.3'] }] }, commit: 'abc', commitTime: '2026-10-18T00:00:00Z', product: { name: 'Batchwright Tablets', version: '0.1.0' } });
    expect(sbom.components.map((c) => [c.purl, c.scope, c.licenses?.[0]?.expression, c.hashes?.[0]?.content])).toEqual([
      ['pkg:npm/%40scope/a@1.2.3', 'required', 'MIT', Buffer.from('AAAA', 'base64').toString('hex')],
      ['pkg:npm/b@4.5.6', 'optional', 'ISC', Buffer.from('BBBB', 'base64').toString('hex')],
    ]);
    const again = buildSbom({ lockfile, licences, production: {}, commit: 'abc', commitTime: '2026-10-18T00:00:00Z', product: { name: 'Batchwright Tablets', version: '0.1.0' } });
    expect(again.serialNumber).toBe(sbom.serialNumber);
    expect(sbom.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('[DI-13] the manifest and the SBOM are signed with the release key (Ed25519); one changed byte, or another key, fails the verification', () => {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const k = signingKey(pem);
    expect(k.kind).toBe('RELEASE_KEY');
    const bytes = Buffer.from('{"kind":"ebmr.release-manifest"}\n');
    const sig = signBytes(k.key, bytes);
    expect(verifyBytes(k.publicPem, bytes, sig)).toBe(true);
    expect(verifyBytes(k.publicPem, Buffer.from('{"kind":"ebmr.release-manifest"} \n'), sig)).toBe(false);
    const demo = signingKey(undefined);
    expect(demo.kind).toBe('DEMO-ONLY ephemeral');
    expect(verifyBytes(demo.publicPem, bytes, sig)).toBe(false);
    expect(spkiSha256(k.publicPem)).toMatch(/^[0-9a-f]{64}$/);
  });
});
