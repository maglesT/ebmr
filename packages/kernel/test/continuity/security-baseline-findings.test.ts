/**
 * Security baseline (control DI-13): every finding the checks report, with its exact code, severity,
 * path and reason, for each rule and for the inputs at the edge of each rule. The operator acts on
 * the path and the reason, so they are part of the behaviour, not decoration. The checks are pure;
 * the run-time session check is given its pg_stat_ssl row through a minimal query interface.
 */
import { describe, expect, it } from 'vitest';
import {
  assertEncryptedDatabaseSession,
  assertProductionConfig,
  checkDatabaseUrl,
  checkIntegrationEndpoint,
  checkPgHba,
  checkPostgresqlConf,
  checkProductionConfig,
  checkServerConfig,
  readPostgresqlConf,
  SecurityBaselineError,
  type Finding,
  type ProductionConfig,
  type ServerConfig,
} from '../../src/continuity/security-baseline.ts';

const E = (code: string, path: string, message: string): Finding => ({ code, severity: 'ERROR', path, message });
const W = (code: string, path: string, message: string): Finding => ({ code, severity: 'WARNING', path, message });

/** The SecurityBaselineError a call throws (or the failure when it throws something else or nothing). */
function thrown(fn: () => unknown): SecurityBaselineError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SecurityBaselineError) return e;
    throw e;
  }
  throw new Error('expected a SecurityBaselineError');
}

const DB = 'postgres://ebmr_app@db1.plant1.example.in:5432/ebmr_tablets';
const NO_SSLMODE = 'has no sslmode; use sslmode=verify-full';

describe('database URL', () => {
  it('[DI-13] a URL that cannot be parsed or is not a PostgreSQL URL is refused', () => {
    expect(checkDatabaseUrl('db1.plant1.example.in/ebmr_tablets')).toEqual([E('EBMR-SEC-010', 'database.url', 'is not a valid URL')]);
    expect(checkDatabaseUrl('mysql://ebmr_app@db1/ebmr_tablets?sslmode=verify-full')).toEqual([E('EBMR-SEC-010', 'database.url', 'unsupported scheme mysql:')]);
    expect(checkDatabaseUrl('https://db1/ebmr_tablets?sslmode=verify-full', 'siteServicesDatabase.url')).toEqual([
      E('EBMR-SEC-010', 'siteServicesDatabase.url', 'unsupported scheme https:'),
    ]);
    // Both spellings of the PostgreSQL scheme are accepted.
    expect(checkDatabaseUrl(`${DB}?sslmode=verify-full`)).toEqual([]);
    expect(checkDatabaseUrl('postgresql://ebmr_app@db1.plant1.example.in:5432/ebmr_tablets?sslmode=verify-full')).toEqual([]);
  });

  it('[DI-13] the sslmode decides: verify-full passes, verify-ca and require warn, anything else or nothing is refused', () => {
    expect(checkDatabaseUrl(DB)).toEqual([E('EBMR-SEC-011', 'database.url', NO_SSLMODE)]);
    for (const mode of ['disable', 'allow', 'prefer', 'no-verify', 'VERIFY-FULL']) {
      expect(checkDatabaseUrl(`${DB}?sslmode=${mode}`), mode).toEqual([
        E('EBMR-SEC-011', 'database.url', `sslmode=${mode} allows a connection without TLS; use sslmode=verify-full`),
      ]);
    }
    for (const mode of ['verify-ca', 'require']) {
      expect(checkDatabaseUrl(`${DB}?sslmode=${mode}`), mode).toEqual([
        W('EBMR-SEC-012', 'database.url', `sslmode=${mode} encrypts but does not fully verify the server identity; prefer verify-full`),
      ]);
    }
  });

  it('[DI-13] ssl=false or ssl=0 is refused even next to a verifying sslmode', () => {
    for (const ssl of ['false', '0']) {
      expect(checkDatabaseUrl(`${DB}?ssl=${ssl}&sslmode=verify-full`), ssl).toEqual([E('EBMR-SEC-011', 'database.url', 'disables TLS (ssl=false)')]);
    }
    for (const ssl of ['true', '1']) expect(checkDatabaseUrl(`${DB}?ssl=${ssl}&sslmode=verify-full`), ssl).toEqual([]);
    // Each problem is reported, in the order the URL is read.
    expect(checkDatabaseUrl(`${DB}?ssl=0`)).toEqual([E('EBMR-SEC-011', 'database.url', 'disables TLS (ssl=false)'), E('EBMR-SEC-011', 'database.url', NO_SSLMODE)]);
  });

  it('[DI-13] a password in the URL is reported: credentials come from the secrets vault', () => {
    const warn = W('EBMR-SEC-014', 'database.url', 'contains a password; take database credentials from the secrets vault');
    expect(checkDatabaseUrl('postgres://ebmr_app:secret@db1/ebmr_tablets?sslmode=verify-full')).toEqual([warn]);
    expect(checkDatabaseUrl('postgres://ebmr_app:secret@db1/ebmr_tablets')).toEqual([E('EBMR-SEC-011', 'database.url', NO_SSLMODE), warn]);
    expect(checkDatabaseUrl('postgres://ebmr_app:@db1/ebmr_tablets?sslmode=verify-full')).toEqual([]);
  });

  it('[DI-13] a repeated connection parameter is refused, naming each repeated parameter once', () => {
    expect(checkDatabaseUrl(`${DB}?sslmode=verify-full&host=db2&sslmode=disable&host=db3&sslmode=verify-full`)).toEqual([
      E('EBMR-SEC-017', 'database.url', 'repeats the parameter(s) sslmode, host; give each connection parameter once'),
    ]);
  });

  it('[DI-13] a Unix socket, in the host or in the host parameter, must be allowed explicitly and is then only a warning', () => {
    const refused = E('EBMR-SEC-013', 'database.url', 'points at a local Unix socket; allow it explicitly for a single-host installation');
    const allowed = W('EBMR-SEC-013', 'database.url', 'uses a local Unix socket; acceptable only when the database runs on the same host');
    for (const url of ['postgres://ebmr_app@%2Frun%2Fpostgresql/ebmr_tablets', 'postgres://ebmr_app@db1/ebmr_tablets?host=%2Frun%2Fpostgresql&sslmode=verify-full']) {
      expect(checkDatabaseUrl(url), url).toEqual([refused]);
      expect(checkDatabaseUrl(url, 'database.url', { allowLocalSocket: true }), url).toEqual([allowed]);
    }
    // The host parameter takes precedence over the host in the authority.
    expect(checkDatabaseUrl('postgres://ebmr_app@%2Frun%2Fpostgresql/ebmr_tablets?host=db1&sslmode=verify-full')).toEqual([]);
  });
});

const TLS = { certFile: '/etc/ebmr/tls/server.crt', keyFile: '/etc/ebmr/tls/server.key' };
const HSTS = { maxAgeSeconds: 31_536_000 };
const serverWithoutTls: ServerConfig = {
  publicUrl: 'https://ebmr.plant1.example.in',
  tlsTermination: 'SERVER',
  plainHttp: 'REDIRECT_TO_HTTPS',
  hsts: HSTS,
  cookies: { secure: true, httpOnly: true, sameSite: 'Strict' },
};
const goodServer: ServerConfig = { ...serverWithoutTls, tls: { ...TLS, minVersion: 'TLSv1.2' } };
const serverWithoutHsts: ServerConfig = {
  publicUrl: goodServer.publicUrl,
  tlsTermination: goodServer.tlsTermination,
  tls: { ...TLS, minVersion: 'TLSv1.2' },
  plainHttp: goodServer.plainHttp,
  cookies: goodServer.cookies,
};

describe('server configuration', () => {
  it('[DI-13] the public URL must parse and be https', () => {
    expect(checkServerConfig({ ...goodServer, publicUrl: 'ebmr.plant1.example.in' })).toEqual([E('EBMR-SEC-020', 'server.publicUrl', 'is not a valid URL')]);
    expect(checkServerConfig({ ...goodServer, publicUrl: 'http://ebmr.plant1.example.in' })).toEqual([E('EBMR-SEC-020', 'server.publicUrl', 'must be https, not http')]);
    expect(checkServerConfig({ ...goodServer, publicUrl: 'ws://ebmr.plant1.example.in' }, 'gateway')).toEqual([E('EBMR-SEC-020', 'gateway.publicUrl', 'must be https, not ws')]);
  });

  it('[DI-13] a plain-HTTP listener may refuse or redirect, never serve', () => {
    expect(checkServerConfig({ ...goodServer, plainHttp: 'SERVE' })).toEqual([E('EBMR-SEC-021', 'server.plainHttp', 'plain HTTP may only redirect to HTTPS or be refused')]);
    expect(checkServerConfig({ ...goodServer, plainHttp: 'REFUSE' })).toEqual([]);
  });

  it('[DI-13] a server that terminates TLS needs a certificate, a key and at least TLS 1.2', () => {
    const noKeyPair = E('EBMR-SEC-022', 'server.tls', 'the server terminates TLS but has no certificate and key');
    expect(checkServerConfig(serverWithoutTls)).toEqual([noKeyPair]);
    expect(checkServerConfig({ ...goodServer, tls: { ...TLS, certFile: '' } })).toEqual([noKeyPair]);
    expect(checkServerConfig({ ...goodServer, tls: { ...TLS, keyFile: '' } })).toEqual([noKeyPair]);
    expect(checkServerConfig({ ...goodServer, tls: { ...TLS, minVersion: 'TLSv1.1' as 'TLSv1.2' } })).toEqual([E('EBMR-SEC-023', 'server.tls.minVersion', 'must be TLSv1.2 or TLSv1.3')]);
    expect(checkServerConfig({ ...goodServer, tls: { ...TLS, minVersion: 'TLSv1.3' } })).toEqual([]);
    expect(checkServerConfig({ ...goodServer, tls: TLS })).toEqual([]);
    // Behind a reverse proxy the application server holds no certificate and sets no TLS version.
    expect(checkServerConfig({ ...goodServer, tlsTermination: 'REVERSE_PROXY', tls: { certFile: '', keyFile: '', minVersion: 'TLSv1.1' as 'TLSv1.2' } })).toEqual([]);
  });

  it('[DI-13] HSTS is required for at least one year', () => {
    expect(checkServerConfig(serverWithoutHsts)).toEqual([E('EBMR-SEC-024', 'server.hsts', 'HTTP Strict Transport Security must be enabled')]);
    expect(checkServerConfig({ ...goodServer, hsts: { maxAgeSeconds: 31_535_999, includeSubDomains: true } })).toEqual([
      E('EBMR-SEC-024', 'server.hsts.maxAgeSeconds', 'must be at least 31536000'),
    ]);
    expect(checkServerConfig({ ...goodServer, hsts: { maxAgeSeconds: 31_536_000 } })).toEqual([]);
  });

  it('[DI-13] session cookies must be Secure, HttpOnly and SameSite=Strict', () => {
    const cookies = goodServer.cookies;
    expect(checkServerConfig({ ...goodServer, cookies: { ...cookies, secure: false } })).toEqual([E('EBMR-SEC-025', 'server.cookies.secure', 'session cookies must be Secure')]);
    expect(checkServerConfig({ ...goodServer, cookies: { ...cookies, httpOnly: false } })).toEqual([E('EBMR-SEC-025', 'server.cookies.httpOnly', 'session cookies must be HttpOnly')]);
    for (const sameSite of ['Lax', 'None'] as const) {
      expect(checkServerConfig({ ...goodServer, cookies: { ...cookies, sameSite } }), sameSite).toEqual([
        E('EBMR-SEC-025', 'server.cookies.sameSite', 'session cookies must be SameSite=Strict'),
      ]);
    }
  });

  it('[DI-13] every gap of a server configuration is reported under the given path', () => {
    const worst: ServerConfig = { publicUrl: 'http://ebmr', tlsTermination: 'SERVER', plainHttp: 'SERVE', cookies: { secure: false, httpOnly: false, sameSite: 'None' } };
    expect(checkServerConfig(worst, 'edge').map((f) => [f.code, f.path])).toEqual([
      ['EBMR-SEC-020', 'edge.publicUrl'],
      ['EBMR-SEC-021', 'edge.plainHttp'],
      ['EBMR-SEC-022', 'edge.tls'],
      ['EBMR-SEC-024', 'edge.hsts'],
      ['EBMR-SEC-025', 'edge.cookies.secure'],
      ['EBMR-SEC-025', 'edge.cookies.httpOnly'],
      ['EBMR-SEC-025', 'edge.cookies.sameSite'],
    ]);
  });
});

describe('integration endpoints', () => {
  it('[DI-13] an endpoint URL that cannot be parsed is refused under the endpoint name', () => {
    expect(checkIntegrationEndpoint({ name: 'erp', url: 'erp.example.in/api' })).toEqual([E('EBMR-SEC-030', 'integrations.erp.url', 'is not a valid URL')]);
    expect(checkIntegrationEndpoint({ name: 'erp', url: 'erp.example.in/api' }, 'lims')).toEqual([E('EBMR-SEC-030', 'lims.url', 'is not a valid URL')]);
  });

  it('[DI-13] a plain-text protocol is refused and its TLS form is asked for', () => {
    for (const scheme of ['http', 'ws', 'mqtt', 'amqp', 'ftp', 'ldap', 'tcp', 'telnet']) {
      expect(checkIntegrationEndpoint({ name: 'ems', url: `${scheme}://ems.example.in:1000/x` }), scheme).toEqual([
        E('EBMR-SEC-030', 'integrations.ems.url', `${scheme} is a plain-text protocol; use its TLS form`),
      ]);
    }
  });

  it('[DI-13] a scheme that is neither known plain nor known encrypted is refused', () => {
    expect(checkIntegrationEndpoint({ name: 'lims', url: 'gopher://lims.example.in/x' })).toEqual([
      E('EBMR-SEC-030', 'integrations.lims.url', 'unknown scheme gopher:; only encrypted transports are allowed'),
    ]);
  });

  it('[DI-13] encrypted transports pass; OPC UA only with SignAndEncrypt', () => {
    for (const scheme of ['https', 'wss', 'mqtts', 'amqps', 'sftp', 'ldaps']) {
      expect(checkIntegrationEndpoint({ name: 'ems', url: `${scheme}://ems.example.in:1000/x` }), scheme).toEqual([]);
    }
    const opc = E('EBMR-SEC-031', 'integrations.press.opcUaSecurityMode', 'OPC UA endpoints must use SignAndEncrypt');
    expect(checkIntegrationEndpoint({ name: 'press', url: 'opc.tcp://press-01:4840' })).toEqual([opc]);
    expect(checkIntegrationEndpoint({ name: 'press', url: 'opc.tcp://press-01:4840', opcUaSecurityMode: 'Sign' })).toEqual([opc]);
    expect(checkIntegrationEndpoint({ name: 'press', url: 'opc.tcp://press-01:4840', opcUaSecurityMode: 'SignAndEncrypt' })).toEqual([]);
    // The security mode matters only for OPC UA.
    expect(checkIntegrationEndpoint({ name: 'erp', url: 'https://erp.example.in/api', opcUaSecurityMode: 'None' })).toEqual([]);
  });
});

const minimal: ProductionConfig = { environment: 'production', database: { url: `${DB}?sslmode=verify-full` }, server: goodServer };

describe('whole configuration', () => {
  it('[DI-13] a configuration without site-services database and integrations is checked for what it has', () => {
    expect(checkProductionConfig(minimal)).toEqual([]);
    expect(assertProductionConfig(minimal)).toEqual([]);
  });

  it('[DI-13] the site-services database and every integration are checked under their own paths', () => {
    const cfg: ProductionConfig = {
      ...minimal,
      siteServicesDatabase: { url: 'postgres://ebmr_app@db1/ebmr_site' },
      integrations: [
        { name: 'erp', url: 'https://erp.example.in/api' },
        { name: 'ems', url: 'mqtt://ems.example.in:1883' },
      ],
    };
    const expected = [E('EBMR-SEC-011', 'siteServicesDatabase.url', NO_SSLMODE), E('EBMR-SEC-030', 'integrations.ems.url', 'mqtt is a plain-text protocol; use its TLS form')];
    expect(checkProductionConfig(cfg)).toEqual(expected);
    expect(thrown(() => assertProductionConfig(cfg)).findings).toEqual(expected);
  });

  it('[DI-13] allowing the local database socket applies to both databases and turns the refusal into a warning', () => {
    const socket = 'postgres://ebmr_app@%2Frun%2Fpostgresql/ebmr_tablets';
    const cfg: ProductionConfig = { ...minimal, database: { url: socket }, siteServicesDatabase: { url: socket } };
    expect(thrown(() => assertProductionConfig(cfg)).findings).toEqual([
      E('EBMR-SEC-013', 'database.url', 'points at a local Unix socket; allow it explicitly for a single-host installation'),
      E('EBMR-SEC-013', 'siteServicesDatabase.url', 'points at a local Unix socket; allow it explicitly for a single-host installation'),
    ]);
    expect(assertProductionConfig({ ...cfg, allowLocalDatabaseSocket: true })).toEqual([
      W('EBMR-SEC-013', 'database.url', 'uses a local Unix socket; acceptable only when the database runs on the same host'),
      W('EBMR-SEC-013', 'siteServicesDatabase.url', 'uses a local Unix socket; acceptable only when the database runs on the same host'),
    ]);
    expect(thrown(() => assertProductionConfig({ ...cfg, allowLocalDatabaseSocket: false })).findings.map((f) => f.severity)).toEqual(['ERROR', 'ERROR']);
  });

  it('[DI-13] warnings alone do not stop the start; they are returned to be logged', () => {
    const cfg: ProductionConfig = { ...minimal, database: { url: `${DB}?sslmode=require` } };
    const warn = W('EBMR-SEC-012', 'database.url', 'sslmode=require encrypts but does not fully verify the server identity; prefer verify-full');
    expect(assertProductionConfig(cfg)).toEqual([warn]);
    // With an error next to it, only the errors are raised.
    expect(thrown(() => assertProductionConfig({ ...cfg, server: { ...goodServer, plainHttp: 'SERVE' } })).findings).toEqual([
      E('EBMR-SEC-021', 'server.plainHttp', 'plain HTTP may only redirect to HTTPS or be refused'),
    ]);
  });

  it('[DI-13] validation is held to the production rules; development keeps every finding as a warning', () => {
    const weak: ProductionConfig = { ...minimal, database: { url: DB }, server: { ...goodServer, publicUrl: 'http://localhost:3001' } };
    const asErrors = [E('EBMR-SEC-011', 'database.url', NO_SSLMODE), E('EBMR-SEC-020', 'server.publicUrl', 'must be https, not http')];
    expect(checkProductionConfig({ ...weak, environment: 'validation' })).toEqual(asErrors);
    expect(thrown(() => assertProductionConfig({ ...weak, environment: 'validation' })).findings).toEqual(asErrors);
    const asWarnings = asErrors.map((f) => ({ ...f, severity: 'WARNING' }));
    expect(checkProductionConfig({ ...weak, environment: 'development' })).toEqual(asWarnings);
    expect(assertProductionConfig({ ...weak, environment: 'development' })).toEqual(asWarnings);
  });

  it('[DI-13] the refusal names itself and lists each error with its code, path and reason', () => {
    const err = thrown(() => assertProductionConfig({ ...minimal, database: { url: DB }, server: { ...goodServer, publicUrl: 'http://ebmr.plant1.example.in' } }));
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SecurityBaselineError');
    expect(err.message).toBe(
      'EBMR-SEC-001 the configuration does not meet the security baseline:\n' +
        '  EBMR-SEC-011 database.url: has no sslmode; use sslmode=verify-full\n' +
        '  EBMR-SEC-020 server.publicUrl: must be https, not http',
    );
  });
});

/** A database session whose pg_stat_ssl query returns the given row (or no row). */
function session(row?: { ssl: boolean; version: string | null; cipher: string | null }) {
  return { query: () => Promise.resolve({ rows: row ? [row] : [] }) };
}

describe('database session at run time', () => {
  const notEncrypted = E('EBMR-SEC-015', 'database.session', 'the database session is not encrypted; plain-text connections are refused');

  it('[DI-13] a session without TLS, or without a pg_stat_ssl row, is refused', async () => {
    for (const db of [session(), session({ ssl: false, version: null, cipher: null })]) {
      const failure = assertEncryptedDatabaseSession(db);
      await expect(failure).rejects.toThrow(SecurityBaselineError);
      await expect(failure).rejects.toMatchObject({ findings: [notEncrypted] });
    }
  });

  it('[DI-13] an encrypted session below TLS 1.2, or of unknown version, is refused', async () => {
    await expect(assertEncryptedDatabaseSession(session({ ssl: true, version: 'TLSv1.1', cipher: 'AES256-SHA' }))).rejects.toMatchObject({
      name: 'SecurityBaselineError',
      findings: [E('EBMR-SEC-016', 'database.session', 'TLS version TLSv1.1 is below TLSv1.2')],
    });
    await expect(assertEncryptedDatabaseSession(session({ ssl: true, version: null, cipher: null }))).rejects.toMatchObject({
      name: 'SecurityBaselineError',
      findings: [E('EBMR-SEC-016', 'database.session', 'TLS version unknown is below TLSv1.2')],
    });
  });

  it('[DI-13] a TLS 1.2 or 1.3 session passes and reports its version and cipher', async () => {
    await expect(assertEncryptedDatabaseSession(session({ ssl: true, version: 'TLSv1.2', cipher: 'ECDHE-RSA-AES256-GCM-SHA384' }))).resolves.toEqual({
      version: 'TLSv1.2',
      cipher: 'ECDHE-RSA-AES256-GCM-SHA384',
    });
    await expect(assertEncryptedDatabaseSession(session({ ssl: true, version: 'TLSv1.3', cipher: null }))).resolves.toEqual({ version: 'TLSv1.3', cipher: 'unknown' });
  });
});

const NO_HOSTSSL = E('EBMR-SEC-044', 'pg_hba.conf', 'no hostssl rule: the application could not connect over TLS');
const APP = 'hostssl ebmr_tablets ebmr_app 10.10.20.0/24 scram-sha-256';

describe('pg_hba.conf', () => {
  it('[DI-13] findings name the file and the line, counting comment and blank lines', () => {
    expect(checkPgHba('# header\n\nhostssl all all 10.0.0.0/8 md5')).toEqual([
      E('EBMR-SEC-042', 'pg_hba.conf:3', 'hostssl must use scram-sha-256 or cert, not md5'),
      E('EBMR-SEC-043', 'pg_hba.conf:3', 'authentication method md5 is not allowed'),
    ]);
    expect(checkPgHba('host all all 0.0.0.0/0 scram-sha-256', 'ops/hba')).toEqual([
      E('EBMR-SEC-041', 'ops/hba:1', 'host allows network connections without TLS; use hostssl'),
      E('EBMR-SEC-044', 'ops/hba', 'no hostssl rule: the application could not connect over TLS'),
    ]);
  });

  it('[DI-13] indentation, whitespace-only lines and trailing comments do not change a rule', () => {
    expect(checkPgHba(`   \n\t${APP}   # application\n  local all postgres peer\n`)).toEqual([]);
  });

  it('[DI-13] include directives are refused: every rule must be in the reviewed file', () => {
    for (const directive of ['include', 'include_if_exists', 'include_dir']) {
      expect(checkPgHba(`${APP}\n${directive} conf.d`), directive).toEqual([
        E('EBMR-SEC-040', 'pg_hba.conf:2', 'include directives hide rules from review; keep every rule in this file'),
      ]);
    }
  });

  it('[DI-13] an unknown connection type is refused without reading the rest of the rule', () => {
    expect(checkPgHba(`hostx all all 0.0.0.0/0 scram-sha-256\n${APP}`)).toEqual([E('EBMR-SEC-040', 'pg_hba.conf:1', 'unknown connection type hostx')]);
  });

  it('[DI-13] every network connection type other than hostssl is refused unless the rule rejects', () => {
    for (const type of ['host', 'hostnossl', 'hostgssenc', 'hostnogssenc']) {
      expect(checkPgHba(`${type} all all 0.0.0.0/0 scram-sha-256\n${APP}`), type).toEqual([
        E('EBMR-SEC-041', 'pg_hba.conf:1', `${type} allows network connections without TLS; use hostssl`),
      ]);
      expect(checkPgHba(`${type} all all 0.0.0.0/0 reject\n${APP}`), type).toEqual([]);
    }
    expect(checkPgHba(`local all all reject\n${APP}`)).toEqual([]);
  });

  it('[DI-13] hostssl rules authenticate with scram-sha-256 or a client certificate only', () => {
    for (const method of ['scram-sha-256', 'cert']) expect(checkPgHba(`hostssl all all 10.0.0.0/8 ${method}`), method).toEqual([]);
    for (const method of ['md5', 'trust', 'password', 'ident']) {
      expect(checkPgHba(`hostssl all all 10.0.0.0/8 ${method}`), method).toEqual([
        E('EBMR-SEC-042', 'pg_hba.conf:1', `hostssl must use scram-sha-256 or cert, not ${method}`),
        E('EBMR-SEC-043', 'pg_hba.conf:1', `authentication method ${method} is not allowed`),
      ]);
    }
    expect(checkPgHba('hostssl all all 10.0.0.0/8 gss')).toEqual([E('EBMR-SEC-042', 'pg_hba.conf:1', 'hostssl must use scram-sha-256 or cert, not gss')]);
    expect(checkPgHba('hostssl all all 10.0.0.0/8')).toEqual([E('EBMR-SEC-042', 'pg_hba.conf:1', 'hostssl must use scram-sha-256 or cert, not (none)')]);
  });

  it('[DI-13] local rules authenticate with peer or scram-sha-256 only', () => {
    for (const method of ['peer', 'scram-sha-256']) expect(checkPgHba(`local all all ${method}\n${APP}`), method).toEqual([]);
    for (const method of ['trust', 'md5']) {
      expect(checkPgHba(`local all all ${method}\n${APP}`), method).toEqual([
        E('EBMR-SEC-042', 'pg_hba.conf:1', `local connections must use peer or scram-sha-256, not ${method}`),
        E('EBMR-SEC-043', 'pg_hba.conf:1', `authentication method ${method} is not allowed`),
      ]);
    }
    expect(checkPgHba(`local all all\n${APP}`)).toEqual([E('EBMR-SEC-042', 'pg_hba.conf:1', 'local connections must use peer or scram-sha-256, not (none)')]);
  });

  it('[DI-13] without a hostssl rule the file is refused, even if every rule is acceptable', () => {
    expect(checkPgHba('local all postgres peer\nhostnossl all all 0.0.0.0/0 reject')).toEqual([NO_HOSTSSL]);
    expect(checkPgHba('')).toEqual([NO_HOSTSSL]);
    // A hostssl rule that only rejects does not let the application connect.
    expect(checkPgHba('hostssl all all 0.0.0.0/0 reject')).toEqual([NO_HOSTSSL]);
    expect(checkPgHba(`${APP}\n${APP.replace('ebmr_app', 'ebmr_authn')}`)).toEqual([]);
  });

  it('[DI-13] with known roles, a rule naming any other role is refused; all, +group, /regex and @file are not role names', () => {
    const knownRoles = ['ebmr_app', 'ebmr_authn'];
    const check = (user: string) => checkPgHba(`hostssl ebmr_tablets ${user} 10.10.20.0/24 scram-sha-256`, 'pg_hba.conf', { knownRoles });
    for (const user of ['ebmr_app', 'ebmr_app,ebmr_authn', 'all', '+ebmr_readers', '/^ebmr_.*$', '@roles.txt', 'ebmr_app,']) expect(check(user), user).toEqual([]);
    for (const role of ['ebmr_auth', 'ebmr+app', 'ebmr/app', 'ebmr@app']) {
      expect(check(`ebmr_app,${role}`), role).toEqual([E('EBMR-SEC-045', 'pg_hba.conf:1', `role ${role} is not a role of the installation; the rule would never match it`)]);
    }
    // A rule without a user field names no role.
    expect(checkPgHba(`local all\n${APP}`, 'pg_hba.conf', { knownRoles })).toEqual([
      E('EBMR-SEC-042', 'pg_hba.conf:1', 'local connections must use peer or scram-sha-256, not (none)'),
    ]);
    // Without known roles, role names are not checked.
    expect(checkPgHba('hostssl ebmr_tablets ebmr_auth 10.10.20.0/24 scram-sha-256')).toEqual([]);
  });
});

describe('postgresql.conf', () => {
  const GOOD = "ssl = on\nssl_min_protocol_version = 'TLSv1.2'\npassword_encryption = scram-sha-256";

  it('[DI-13] each missing or weak setting is reported under the file and setting name', () => {
    const all = [
      E('EBMR-SEC-050', 'postgresql.conf:ssl', 'must be on'),
      E('EBMR-SEC-051', 'postgresql.conf:ssl_min_protocol_version', 'must be TLSv1.2 or TLSv1.3'),
      E('EBMR-SEC-052', 'postgresql.conf:password_encryption', 'must be scram-sha-256'),
    ];
    expect(checkPostgresqlConf('')).toEqual(all);
    expect(checkPostgresqlConf("ssl = off\nssl_min_protocol_version = 'TLSv1.1'\npassword_encryption = md5")).toEqual(all);
    expect(checkPostgresqlConf('', 'conf.d/tls.conf').map((f) => f.path)).toEqual([
      'conf.d/tls.conf:ssl',
      'conf.d/tls.conf:ssl_min_protocol_version',
      'conf.d/tls.conf:password_encryption',
    ]);
  });

  it('[DI-13] TLS 1.2 and TLS 1.3 are accepted as the minimum, quoted or not', () => {
    expect(checkPostgresqlConf(GOOD)).toEqual([]);
    expect(checkPostgresqlConf("ssl = on\nssl_min_protocol_version = TLSv1.3\npassword_encryption = 'scram-sha-256'")).toEqual([]);
  });

  it('[DI-13] trailing comments are ignored, a commented-out setting does not count, and the last setting wins', () => {
    expect(checkPostgresqlConf("ssl = on # TLS for every connection\nssl_min_protocol_version = 'TLSv1.2'  #at least\npassword_encryption = scram-sha-256 #")).toEqual([]);
    expect(checkPostgresqlConf(GOOD.replace('ssl = on', '#ssl = on'))).toEqual([E('EBMR-SEC-050', 'postgresql.conf:ssl', 'must be on')]);
    expect(checkPostgresqlConf(`${GOOD}\nssl = off`)).toEqual([E('EBMR-SEC-050', 'postgresql.conf:ssl', 'must be on')]);
    expect(checkPostgresqlConf(`ssl = off\n${GOOD}`)).toEqual([]);
  });

  // Every expectation below was compared with PostgreSQL 16's own reading of the same file (postgres -C).
  const SSL_OFF = [E('EBMR-SEC-050', 'postgresql.conf:ssl', 'must be on')];
  const UNREADABLE = (line: number) =>
    E('EBMR-SEC-054', `postgresql.conf:${line}`, 'PostgreSQL cannot read this line (expected a setting name, an optional =, one value and nothing else) and would refuse the file');

  it('[DI-13] a later setting turns TLS off whatever the case of its name, with or without "=", quoted or escaped', () => {
    for (const later of ['SSL = off', 'Ssl off', 'ssl\toff', "ssl='off'", "ssl = 'o\\146f'", "ssl = '\\o\\f\\f'", 'ssl = of', 'ssl = 0', 'ssl = n', "ssl = 'f'"]) {
      expect(checkPostgresqlConf(`${GOOD}\n${later}`), later).toEqual(SSL_OFF);
    }
  });

  it('[DI-13] values are read as PostgreSQL reads them: case-insensitive, every spelling of a Boolean, escapes, a NUL ending the value', () => {
    const rest = "\nssl_min_protocol_version = 'TLSv1.2'\npassword_encryption = scram-sha-256";
    expect(checkPostgresqlConf("ssl = TRUE\nssl_min_protocol_version = tlsv1.3\npassword_encryption = 'SCRAM-SHA-256'")).toEqual([]);
    for (const on of ['t', 'tr', 'TRUE', 'y', 'yes', '1', 'On', "'o\\156'", "'on\\000junk'"]) expect(checkPostgresqlConf(`ssl = ${on}${rest}`), on).toEqual([]);
    // Values the server refuses (it would not start): never accepted as on.
    for (const bad of ['o', 'onn', "' on'", "'on#x'", "'truex'", "''", '\u00a0off', 'e', 'rue', 's', 'es', "'o\\n'"]) expect(checkPostgresqlConf(`ssl = ${bad}${rest}`), bad).toEqual(SSL_OFF);
    expect(checkPostgresqlConf(`${GOOD}\nssl_min_protocol_version = ''`)).toEqual([E('EBMR-SEC-051', 'postgresql.conf:ssl_min_protocol_version', 'must be TLSv1.2 or TLSv1.3')]);
    expect(checkPostgresqlConf(`${GOOD}\npassword_encryption = on`)).toEqual([E('EBMR-SEC-052', 'postgresql.conf:password_encryption', 'must be scram-sha-256')]);
  });

  it('[DI-13] comments, line endings and the values of other settings are read as PostgreSQL reads them', () => {
    for (const line of [
      'ssl = on#x',
      "ssl = 'on' # it's fine",
      'ssl = on\r',
      'archive_timeout = 1min',
      'shared_buffers = 0x1000',
      'random_page_cost = .5',
      'random_page_cost = 1.5e1',
      'x.y = .',
      "x.y = 'a''b'",
      "x.y = 'a\\'b'",
      "x.y = 'a\\\rb'",
      "x.y = 'a'''",
      "pgaudit.log = 'ddl, role, write'",
      '',
      '   # only a comment',
    ]) {
      expect(checkPostgresqlConf(`${GOOD}\n${line}`), JSON.stringify(line)).toEqual([]);
    }
    expect(checkPostgresqlConf(GOOD.replace(/\n/g, '\r\n'))).toEqual([]);
  });

  it('[DI-13] the reader decodes values as PostgreSQL does', () => {
    const read = (value: string) => readPostgresqlConf(`ebmr.x = ${value}`).settings.get('ebmr.x');
    expect(read("'a''b'")).toBe("a'b");
    expect(read("'a\\'b'")).toBe("a'b");
    expect(read("'it''s \\'ok\\''")).toBe("it's 'ok'");
    expect(read("''''")).toBe("'");
    expect(read("'\\''''")).toBe("''");
    // One to three octal digits are one byte (a fourth digit is a character of its own); 8 is not an octal digit.
    expect(read("'\\101\\1012\\0101'")).toBe('AA2\b1');
    expect(read("'\\18'")).toBe('\u00018');
    expect(read("'x\\8y'")).toBe('x8y');
    expect(read("'\\777'")).toBe('\u00ff');
    expect(read("'on\\000junk'")).toBe('on');
    expect(read("'\\b\\f\\n\\r\\t|'")).toBe('\b\f\n\r\t|');
    expect(read("'\\q\\\\'")).toBe('q\\');
    expect(read("'a\\\rb'")).toBe('a\rb');
    expect(read("'#x'")).toBe('#x');
    for (const plain of ['60', '.5', '1.5e1', '0x1F', '-1', '+.5e-3', 'abc-d.e:f/g', 'TLSv1.2', 'on']) expect(read(plain), plain).toBe(plain);
  });

  it('[DI-13] the reader keys settings by lower-case name, the last one winning, and reports findings under the file', () => {
    const { settings, findings } = readPostgresqlConf("SSL = on\nPgAudit.Log 'ddl'\nssl off\n# x\n\nEBMR.X = 1");
    expect(findings).toEqual([]);
    expect([...settings]).toEqual([
      ['ssl', 'off'],
      ['pgaudit.log', 'ddl'],
      ['ebmr.x', '1'],
    ]);
    expect(readPostgresqlConf('ssl').findings.map((f) => f.path)).toEqual(['postgresql.conf:1']);
    expect(readPostgresqlConf('\nssl', 'conf.d/tls.conf').findings.map((f) => f.path)).toEqual(['conf.d/tls.conf:2']);
  });

  it('[DI-13] an include directive is refused whatever its case: it brings in settings this check never sees', () => {
    for (const line of ["include_if_exists = 'tls.conf'", "INCLUDE_IF_EXISTS 'tls.conf'", "include 'tls.conf'", "Include_Dir 'conf.d'"]) {
      expect(checkPostgresqlConf(`${GOOD}\n${line}`), line).toEqual([
        E('EBMR-SEC-053', 'postgresql.conf:4', 'include directives bring in settings this check never sees; keep every setting in this file'),
      ]);
    }
  });

  it('[DI-13] a line PostgreSQL cannot read is refused, because the server would refuse the whole file', () => {
    for (const line of ['ssl = on off', 'ssl = = off', 'ssl =', 'ssl', '= off', 'ssl = on.x', 'x.y.z = 1', "'ssl' = off", '1 = 2', '.5 = 1', 'ssl = off =']) {
      expect(checkPostgresqlConf(`${GOOD}\n${line}`), line).toEqual([UNREADABLE(4)]);
    }
    // A quote that never closes starts no token, as a form feed or a vertical tab does not.
    for (const line of ['\fssl = off', 'ssl = off\v', "x.y = 'unterminated", "x.y = 'a'''x'"]) {
      expect(checkPostgresqlConf(`${GOOD}\n${line}`), JSON.stringify(line)).toEqual([
        E('EBMR-SEC-054', 'postgresql.conf:4', 'PostgreSQL cannot read this line (a character no setting, value or comment starts with) and would refuse the file'),
      ]);
    }
    // The setting on an unreadable line is not taken as read.
    expect(checkPostgresqlConf(`${GOOD.replace('ssl = on', 'ssl = on on')}`)).toEqual([UNREADABLE(1), ...SSL_OFF]);
  });
});
