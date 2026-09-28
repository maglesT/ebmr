/**
 * Security baseline checks for a production or validation installation (control DI-13; build outline
 * 4.7; docs/security/security-baseline.md).
 *
 * The server refuses to start GMP operation with a configuration that would allow a connection without
 * TLS: a database URL without sslmode verify-full / verify-ca / require, a public URL that is not
 * HTTPS, a listener that serves plain HTTP, missing HSTS or secure cookie flags, or an integration
 * endpoint on a plain-text protocol. At run time assertEncryptedDatabaseSession confirms from the
 * server side (pg_stat_ssl) that the database session really is encrypted.
 *
 * The same rules are applied to the pg_hba.conf and postgresql.conf templates in ops/postgres/.
 */

export type Environment = 'production' | 'validation' | 'development';

export interface Finding {
  code: string;
  severity: 'ERROR' | 'WARNING';
  path: string;
  message: string;
}

export interface ServerConfig {
  /** URL users and devices reach the application at. */
  publicUrl: string;
  /** Where TLS terminates: in the application server, or in a reverse proxy on the same host or LAN segment. */
  tlsTermination: 'SERVER' | 'REVERSE_PROXY';
  /** Certificate and key when the server terminates TLS. */
  tls?: { certFile: string; keyFile: string; minVersion?: 'TLSv1.2' | 'TLSv1.3' };
  /** What a plain-HTTP listener may do: nothing, or redirect to HTTPS. Serving content is refused. */
  plainHttp: 'REFUSE' | 'REDIRECT_TO_HTTPS' | 'SERVE';
  hsts?: { maxAgeSeconds: number; includeSubDomains?: boolean };
  cookies: { secure: boolean; httpOnly: boolean; sameSite: 'Strict' | 'Lax' | 'None' };
}

export interface IntegrationEndpoint {
  name: string;
  url: string;
  /** For opc.tcp endpoints: the OPC UA message security mode. */
  opcUaSecurityMode?: 'None' | 'Sign' | 'SignAndEncrypt';
}

export interface ProductionConfig {
  environment: Environment;
  database: { url: string };
  siteServicesDatabase?: { url: string };
  server: ServerConfig;
  integrations?: IntegrationEndpoint[];
  /** Allow a database URL that points at a local Unix socket (no network path). Default false. */
  allowLocalDatabaseSocket?: boolean;
}

export class SecurityBaselineError extends Error {
  override readonly name = 'SecurityBaselineError';
  constructor(readonly findings: Finding[]) {
    super(`EBMR-SEC-001 the configuration does not meet the security baseline:\n${findings.map((f) => `  ${f.code} ${f.path}: ${f.message}`).join('\n')}`);
  }
}

const HSTS_MIN_SECONDS = 31_536_000; // one year
const SECURE_SCHEMES = new Set(['https:', 'wss:', 'mqtts:', 'amqps:', 'sftp:', 'ldaps:', 'opc.tcp:']);
const PLAIN_SCHEMES = new Set(['http:', 'ws:', 'mqtt:', 'amqp:', 'ftp:', 'ldap:', 'tcp:', 'telnet:']);

function error(code: string, path: string, message: string): Finding {
  return { code, severity: 'ERROR', path, message };
}
function warning(code: string, path: string, message: string): Finding {
  return { code, severity: 'WARNING', path, message };
}

/** Database connection URL: TLS is mandatory, and the server certificate should be verified. */
export function checkDatabaseUrl(url: string, path = 'database.url', options: { allowLocalSocket?: boolean } = {}): Finding[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [error('EBMR-SEC-010', path, 'is not a valid URL')];
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return [error('EBMR-SEC-010', path, `unsupported scheme ${u.protocol}`)];
  // A parameter given twice is read differently by different parsers (this check reads the first
  // value, the database driver the last), so what is checked would not be what connects.
  const repeated = [...new Set([...u.searchParams.keys()])].filter((k) => u.searchParams.getAll(k).length > 1);
  if (repeated.length > 0) {
    return [error('EBMR-SEC-017', path, `repeats the parameter(s) ${repeated.join(', ')}; give each connection parameter once`)];
  }
  const host = u.searchParams.get('host') ?? decodeURIComponent(u.hostname);
  if (host.startsWith('/')) {
    return options.allowLocalSocket
      ? [warning('EBMR-SEC-013', path, 'uses a local Unix socket; acceptable only when the database runs on the same host')]
      : [error('EBMR-SEC-013', path, 'points at a local Unix socket; allow it explicitly for a single-host installation')];
  }
  const findings: Finding[] = [];
  const mode = u.searchParams.get('sslmode');
  const ssl = u.searchParams.get('ssl');
  if (ssl === 'false' || ssl === '0') findings.push(error('EBMR-SEC-011', path, 'disables TLS (ssl=false)'));
  if (mode === null) {
    findings.push(error('EBMR-SEC-011', path, 'has no sslmode; use sslmode=verify-full'));
  } else if (!['verify-full', 'verify-ca', 'require'].includes(mode)) {
    findings.push(error('EBMR-SEC-011', path, `sslmode=${mode} allows a connection without TLS; use sslmode=verify-full`));
  } else if (mode !== 'verify-full') {
    findings.push(warning('EBMR-SEC-012', path, `sslmode=${mode} encrypts but does not fully verify the server identity; prefer verify-full`));
  }
  if (u.password) findings.push(warning('EBMR-SEC-014', path, 'contains a password; take database credentials from the secrets vault'));
  return findings;
}

export function checkServerConfig(cfg: ServerConfig, path = 'server'): Finding[] {
  const findings: Finding[] = [];
  let u: URL | null = null;
  try {
    u = new URL(cfg.publicUrl);
  } catch {
    findings.push(error('EBMR-SEC-020', `${path}.publicUrl`, 'is not a valid URL'));
  }
  if (u && u.protocol !== 'https:') findings.push(error('EBMR-SEC-020', `${path}.publicUrl`, `must be https, not ${u.protocol.replace(':', '')}`));
  if (cfg.plainHttp === 'SERVE') findings.push(error('EBMR-SEC-021', `${path}.plainHttp`, 'plain HTTP may only redirect to HTTPS or be refused'));
  if (cfg.tlsTermination === 'SERVER') {
    if (!cfg.tls?.certFile || !cfg.tls.keyFile) findings.push(error('EBMR-SEC-022', `${path}.tls`, 'the server terminates TLS but has no certificate and key'));
    if (cfg.tls?.minVersion !== undefined && !['TLSv1.2', 'TLSv1.3'].includes(cfg.tls.minVersion)) {
      findings.push(error('EBMR-SEC-023', `${path}.tls.minVersion`, 'must be TLSv1.2 or TLSv1.3'));
    }
  }
  if (!cfg.hsts) findings.push(error('EBMR-SEC-024', `${path}.hsts`, 'HTTP Strict Transport Security must be enabled'));
  else if (cfg.hsts.maxAgeSeconds < HSTS_MIN_SECONDS) findings.push(error('EBMR-SEC-024', `${path}.hsts.maxAgeSeconds`, `must be at least ${HSTS_MIN_SECONDS}`));
  if (!cfg.cookies.secure) findings.push(error('EBMR-SEC-025', `${path}.cookies.secure`, 'session cookies must be Secure'));
  if (!cfg.cookies.httpOnly) findings.push(error('EBMR-SEC-025', `${path}.cookies.httpOnly`, 'session cookies must be HttpOnly'));
  if (cfg.cookies.sameSite !== 'Strict') findings.push(error('EBMR-SEC-025', `${path}.cookies.sameSite`, 'session cookies must be SameSite=Strict'));
  return findings;
}

export function checkIntegrationEndpoint(e: IntegrationEndpoint, path = `integrations.${e.name}`): Finding[] {
  let u: URL;
  try {
    u = new URL(e.url);
  } catch {
    return [error('EBMR-SEC-030', `${path}.url`, 'is not a valid URL')];
  }
  if (PLAIN_SCHEMES.has(u.protocol)) return [error('EBMR-SEC-030', `${path}.url`, `${u.protocol.replace(':', '')} is a plain-text protocol; use its TLS form`)];
  if (!SECURE_SCHEMES.has(u.protocol)) return [error('EBMR-SEC-030', `${path}.url`, `unknown scheme ${u.protocol}; only encrypted transports are allowed`)];
  if (u.protocol === 'opc.tcp:' && e.opcUaSecurityMode !== 'SignAndEncrypt') {
    return [error('EBMR-SEC-031', `${path}.opcUaSecurityMode`, 'OPC UA endpoints must use SignAndEncrypt')];
  }
  return [];
}

/** All findings. In production and validation environments violations are errors; in development they are warnings. */
export function checkProductionConfig(cfg: ProductionConfig): Finding[] {
  const dbOptions = cfg.allowLocalDatabaseSocket ? { allowLocalSocket: true } : {};
  const findings = [
    ...checkDatabaseUrl(cfg.database.url, 'database.url', dbOptions),
    ...(cfg.siteServicesDatabase ? checkDatabaseUrl(cfg.siteServicesDatabase.url, 'siteServicesDatabase.url', dbOptions) : []),
    ...checkServerConfig(cfg.server),
    ...(cfg.integrations ?? []).flatMap((e) => checkIntegrationEndpoint(e)),
  ];
  return cfg.environment === 'development' ? findings.map((f) => ({ ...f, severity: 'WARNING' as const })) : findings;
}

/** Throws SecurityBaselineError when any finding is an error. */
export function assertProductionConfig(cfg: ProductionConfig): Finding[] {
  const findings = checkProductionConfig(cfg);
  const errors = findings.filter((f) => f.severity === 'ERROR');
  if (errors.length > 0) throw new SecurityBaselineError(errors);
  return findings;
}

interface Queryable {
  query(text: string): Promise<{ rows: unknown[] }>;
}

/**
 * Server-side confirmation that the current database session is TLS-encrypted (pg_stat_ssl). The
 * application calls this on every new pooled connection in production and validation.
 */
export async function assertEncryptedDatabaseSession(db: Queryable): Promise<{ version: string; cipher: string }> {
  const { rows } = await db.query('select ssl, version, cipher from pg_stat_ssl where pid = pg_backend_pid()');
  const r = rows[0] as { ssl: boolean; version: string | null; cipher: string | null } | undefined;
  if (!r?.ssl) {
    throw new SecurityBaselineError([error('EBMR-SEC-015', 'database.session', 'the database session is not encrypted; plain-text connections are refused')]);
  }
  if (r.version !== 'TLSv1.2' && r.version !== 'TLSv1.3') {
    throw new SecurityBaselineError([error('EBMR-SEC-016', 'database.session', `TLS version ${r.version ?? 'unknown'} is below TLSv1.2`)]);
  }
  return { version: r.version, cipher: r.cipher ?? 'unknown' };
}

// ---------------------------------------------------------------------------------------------
// Database server configuration templates
// ---------------------------------------------------------------------------------------------

const WEAK_METHODS = new Set(['trust', 'password', 'md5', 'ident']);
const CONNECTION_TYPES = new Set(['local', 'host', 'hostssl', 'hostnossl', 'hostgssenc', 'hostnogssenc']);

/**
 * pg_hba.conf: only hostssl for network connections, scram-sha-256 or client certificates, never trust.
 * An explicit `reject` rule (for example `hostnossl all all 0.0.0.0/0 reject`) is always acceptable.
 * With `knownRoles`, every role a rule names must be one of them: a misspelt role never matches and
 * the connection falls through to the final reject (for example the authentication service).
 */
export function checkPgHba(text: string, path = 'pg_hba.conf', options: { knownRoles?: Iterable<string> } = {}): Finding[] {
  const findings: Finding[] = [];
  const known = options.knownRoles ? new Set(options.knownRoles) : null;
  let hostssl = 0;
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*/, '').trim();
    if (line === '') return;
    const f = line.split(/\s+/);
    const type = f[0] ?? '';
    const at = `${path}:${i + 1}`;
    if (type === 'include' || type === 'include_if_exists' || type === 'include_dir') {
      findings.push(error('EBMR-SEC-040', at, 'include directives hide rules from review; keep every rule in this file'));
      return;
    }
    if (!CONNECTION_TYPES.has(type)) {
      findings.push(error('EBMR-SEC-040', at, `unknown connection type ${type}`));
      return;
    }
    if (known) {
      // USER field: comma-separated names; "all", +group, /regex and @file are not role names.
      for (const role of (f[2] ?? '').split(',')) {
        if (role === '' || role === 'all' || /^[+/@]/.test(role)) continue;
        if (!known.has(role)) findings.push(error('EBMR-SEC-045', at, `role ${role} is not a role of the installation; the rule would never match it`));
      }
    }
    const method = type === 'local' ? f[3] : f[4];
    if (method === 'reject') return;
    if (type === 'host' || type === 'hostnossl' || type === 'hostgssenc' || type === 'hostnogssenc') {
      findings.push(error('EBMR-SEC-041', at, `${type} allows network connections without TLS; use hostssl`));
    } else if (type === 'hostssl') {
      hostssl += 1;
      if (method !== 'scram-sha-256' && method !== 'cert') findings.push(error('EBMR-SEC-042', at, `hostssl must use scram-sha-256 or cert, not ${method ?? '(none)'}`));
    } else if (method !== 'peer' && method !== 'scram-sha-256') {
      findings.push(error('EBMR-SEC-042', at, `local connections must use peer or scram-sha-256, not ${method ?? '(none)'}`));
    }
    if (method !== undefined && WEAK_METHODS.has(method)) findings.push(error('EBMR-SEC-043', at, `authentication method ${method} is not allowed`));
  });
  if (hostssl === 0) findings.push(error('EBMR-SEC-044', path, 'no hostssl rule: the application could not connect over TLS'));
  return findings;
}

function confValue(text: string, key: string): string | null {
  let value: string | null = null;
  for (const raw of text.split('\n')) {
    const m = raw.replace(/#.*/, '').match(new RegExp(`^\\s*${key}\\s*=\\s*'?([^'\\s]*)'?\\s*$`));
    if (m) value = m[1] ?? null;
  }
  return value;
}

/** postgresql.conf fragment: TLS on, TLS 1.2 or later, SCRAM password hashing. */
export function checkPostgresqlConf(text: string, path = 'postgresql.conf'): Finding[] {
  const findings: Finding[] = [];
  if (confValue(text, 'ssl') !== 'on') findings.push(error('EBMR-SEC-050', `${path}:ssl`, 'must be on'));
  const min = confValue(text, 'ssl_min_protocol_version');
  if (min !== 'TLSv1.2' && min !== 'TLSv1.3') findings.push(error('EBMR-SEC-051', `${path}:ssl_min_protocol_version`, 'must be TLSv1.2 or TLSv1.3'));
  if (confValue(text, 'password_encryption') !== 'scram-sha-256') findings.push(error('EBMR-SEC-052', `${path}:password_encryption`, 'must be scram-sha-256'));
  return findings;
}
