/**
 * Installation hardening verification (slice 7d; ASVS V14.1, V14.2; DI-13; docs/security/pentest-checklist.md). The
 * same checks the IQ script runs (slice 7c's tools/validation, unmerged when this was written: the lead reconciles the
 * two at merge, D-P7-0-1), on a running installation:
 *  - PostgreSQL settings, read from the server (pg_settings) and judged by the kernel's own postgresql.conf rules
 *    (continuity.checkPostgresqlConf: TLS on, TLS 1.2 or later, SCRAM) plus durability and logging: fsync,
 *    full_page_writes and synchronous_commit on, connections and disconnections logged, pgaudit loaded, WAL archived;
 *  - the client authentication rules the server applies (pg_hba_file_rules), judged by continuity.checkPgHba;
 *  - roles: the application, authentication, listener, analytics and report logins hold no superuser, role, database,
 *    replication or row-security bypass right; the owner cannot log in; every password is a SCRAM verifier; no login
 *    other than the break-glass superuser is a superuser;
 *  - the GMP database: no demo marker, no DEMO-ONLY seal or installation key, no demo person (the test-kit personas'
 *    user IDs), PUBLIC cannot connect;
 *  - the server's configuration (its EBMR_* environment): continuity.checkProductionConfig on its database URLs and
 *    origin, and a plain-HTTP listener only on loopback (TLS ends in the reverse proxy in front of it);
 *  - open ports: every listening TCP socket of the host (/proc/net/tcp, tcp6) off loopback must be in the allowed list.
 * Each check is PASS, FAIL or NOT_APPLICABLE with its evidence; the run is PASS when nothing FAILs.
 */
import { readFileSync, existsSync } from 'node:fs';
import pg from 'pg';
import { continuity } from '@ebmr/kernel';

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'NOT_APPLICABLE';

export interface HardeningCheck {
  id: string;
  area: 'POSTGRESQL' | 'AUTHENTICATION' | 'ROLES' | 'DEMO' | 'SERVER' | 'PORTS';
  title: string;
  status: CheckStatus;
  evidence: string;
}

export interface HardeningReport {
  kind: 'ebmr.hardening-check';
  version: 1;
  result: 'PASS' | 'FAIL';
  checks: HardeningCheck[];
}

export interface HardeningOptions {
  /** Superuser (or pg_read_all_settings plus pg_read_all_data) connection to the GMP database. */
  databaseUrl?: string;
  /** The server's environment (EBMR_* variables) to judge, e.g. the systemd unit's EnvironmentFile. */
  serverEnv?: Readonly<Record<string, string | undefined>>;
  /** TCP ports that may listen off loopback (the reverse proxy's 443, PostgreSQL's 5432, ...). */
  allowedPorts?: readonly number[];
  /** /proc/net/tcp and tcp6 contents (tests); default the host's. */
  procNet?: { tcp: string; tcp6: string };
  /** Logins that may be superusers (the peer-authenticated break-glass account). */
  breakGlassRoles?: readonly string[];
  /** The demo personas' user IDs (test-kit PERSONAS), refused on a production database. */
  demoLoginNames?: readonly string[];
}

const APP_ROLES = ['ebmr_app', 'ebmr_authn', 'ebmr_listener', 'ebmr_analytics', 'ebmr_report', 'ebmr_sandbox', 'ebmr_sandbox_listener'];
const na = (id: string, area: HardeningCheck['area'], title: string, evidence: string): HardeningCheck => ({ id, area, title, status: 'NOT_APPLICABLE', evidence });
const judge = (id: string, area: HardeningCheck['area'], title: string, ok: boolean, evidence: string, warnOnly = false): HardeningCheck =>
  ({ id, area, title, status: ok ? 'PASS' : warnOnly ? 'WARN' : 'FAIL', evidence });

/** The settings as postgresql.conf lines, for the kernel's rules (values quoted as the file would quote them). */
export function settingsAsConf(settings: ReadonlyMap<string, string>): string {
  return [...settings.entries()].map(([k, v]) => `${k} = '${v.replace(/'/g, "''")}'`).join('\n');
}

export function postgresChecks(settings: ReadonlyMap<string, string>): HardeningCheck[] {
  const out: HardeningCheck[] = [];
  const findings = continuity.checkPostgresqlConf(settingsAsConf(new Map([...settings].filter(([k]) => ['ssl', 'ssl_min_protocol_version', 'password_encryption'].includes(k)))), 'server');
  out.push(judge('PG-TLS', 'POSTGRESQL', 'TLS on, TLS 1.2 or later, SCRAM password hashing (kernel rules)', findings.length === 0,
    findings.length === 0 ? `ssl=${settings.get('ssl') ?? '?'}, ssl_min_protocol_version=${settings.get('ssl_min_protocol_version') ?? '?'}, password_encryption=${settings.get('password_encryption') ?? '?'}` : findings.map((f) => `${f.code} ${f.path}: ${f.message}`).join('; ')));
  for (const [id, name, want] of [['PG-FSYNC', 'fsync', 'on'], ['PG-FPW', 'full_page_writes', 'on'], ['PG-LOGCONN', 'log_connections', 'on'], ['PG-LOGDISC', 'log_disconnections', 'on']] as const) {
    const v = settings.get(name);
    out.push(judge(id, 'POSTGRESQL', `${name} is ${want}`, v === want, `${name}=${v ?? '(unset)'}`));
  }
  const sc = settings.get('synchronous_commit');
  out.push(judge('PG-SYNC', 'POSTGRESQL', 'synchronous_commit is not off (no committed GMP record lost on a crash)', sc !== undefined && sc !== 'off', `synchronous_commit=${sc ?? '(unset)'}`));
  const spl = settings.get('shared_preload_libraries') ?? '';
  out.push(judge('PG-AUDIT', 'POSTGRESQL', 'pgaudit is loaded (database-level audit of DDL, roles and writes)', /\bpgaudit\b/.test(spl), `shared_preload_libraries='${spl}'`));
  const am = settings.get('archive_mode');
  out.push(judge('PG-ARCHIVE', 'POSTGRESQL', 'WAL is archived (the recovery point on site loss)', am === 'on' || am === 'always', `archive_mode=${am ?? '(unset)'}, archive_timeout=${settings.get('archive_timeout') ?? '(unset)'}`));
  return out;
}

export interface HbaRule {
  type: string;
  database: string[];
  users: string[];
  address: string | null;
  netmask: string | null;
  method: string;
}

/** The server's rules as pg_hba.conf lines, for the kernel's checkPgHba. */
export function hbaAsText(rules: readonly HbaRule[]): string {
  return rules.map((r) => [r.type, r.database.join(','), r.users.join(','), ...(r.type === 'local' ? [] : [r.netmask ? `${r.address ?? ''}/${netmaskBits(r.netmask)}` : (r.address ?? 'all')]), r.method].join(' ')).join('\n');
}

function netmaskBits(mask: string): number {
  if (mask.includes(':')) return mask.split(':').reduce((n, part) => n + (parseInt(part || '0', 16).toString(2).match(/1/g)?.length ?? 0), 0);
  return mask.split('.').reduce((n, part) => n + (Number(part).toString(2).match(/1/g)?.length ?? 0), 0);
}

export function hbaChecks(rules: readonly HbaRule[]): HardeningCheck[] {
  const findings = continuity.checkPgHba(hbaAsText(rules), 'pg_hba (server)');
  return [judge('PG-HBA', 'AUTHENTICATION', 'network access only over TLS with SCRAM or client certificates; no trust, password, md5 or ident (kernel rules)', findings.length === 0,
    findings.length === 0 ? `${String(rules.length)} rules` : findings.map((f) => `${f.code} ${f.path}: ${f.message}`).join('; '))];
}

export interface RoleRow {
  rolname: string;
  rolsuper: boolean;
  rolcanlogin: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolbypassrls: boolean;
  rolreplication: boolean;
  /** The first characters of the stored password (SCRAM-SHA-256$..., md5..., or empty). */
  pw: string;
}

export function roleChecks(roles: readonly RoleRow[], breakGlass: readonly string[]): HardeningCheck[] {
  const out: HardeningCheck[] = [];
  const app = roles.filter((r) => APP_ROLES.includes(r.rolname));
  const tooStrong = app.filter((r) => r.rolsuper || r.rolcreaterole || r.rolcreatedb || r.rolbypassrls || r.rolreplication);
  out.push(judge('ROLE-APP', 'ROLES', 'the application, authentication, listener, analytics and report logins hold no superuser, role, database, replication or row-security bypass right', app.length > 0 && tooStrong.length === 0,
    app.length === 0 ? 'none of the installation roles exists' : tooStrong.length === 0 ? app.map((r) => r.rolname).join(', ') : `too strong: ${tooStrong.map((r) => r.rolname).join(', ')}`));
  const owner = roles.find((r) => r.rolname === 'ebmr_owner');
  out.push(owner ? judge('ROLE-OWNER', 'ROLES', 'the schema owner cannot log in', !owner.rolcanlogin && !owner.rolsuper, `ebmr_owner login=${String(owner.rolcanlogin)} superuser=${String(owner.rolsuper)}`) : na('ROLE-OWNER', 'ROLES', 'the schema owner cannot log in', 'no ebmr_owner role'));
  const weak = roles.filter((r) => r.rolcanlogin && r.pw !== '' && !r.pw.startsWith('SCRAM-'));
  out.push(judge('ROLE-SCRAM', 'ROLES', 'every stored password is a SCRAM-SHA-256 verifier', weak.length === 0, weak.length === 0 ? 'all SCRAM' : `not SCRAM: ${weak.map((r) => r.rolname).join(', ')}`));
  const supers = roles.filter((r) => r.rolsuper && r.rolcanlogin && !breakGlass.includes(r.rolname));
  out.push(judge('ROLE-SUPER', 'ROLES', 'no login but the break-glass account is a superuser', supers.length === 0, supers.length === 0 ? `break-glass: ${breakGlass.join(', ') || '(none named)'}` : `superuser logins: ${supers.map((r) => r.rolname).join(', ')}`));
  return out;
}

export interface DemoFacts {
  demoMarker: boolean | null;
  demoKeys: string[];
  demoPersons: string[];
  publicConnect: boolean;
}

export function demoChecks(f: DemoFacts): HardeningCheck[] {
  return [
    f.demoMarker === null ? na('DEMO-MARKER', 'DEMO', 'the database is not marked as a demo or E2E installation', 'no tab.demo_installation (not a Tablets database)')
      : judge('DEMO-MARKER', 'DEMO', 'the database is not marked as a demo or E2E installation', !f.demoMarker, f.demoMarker ? 'tab.demo_installation holds a marker' : 'no marker'),
    judge('DEMO-KEYS', 'DEMO', 'no DEMO-ONLY seal or installation key is registered', f.demoKeys.length === 0, f.demoKeys.length === 0 ? 'none' : f.demoKeys.join(', ')),
    judge('DEMO-PERSONS', 'DEMO', 'no demo person (the test personas\' user IDs) has an account', f.demoPersons.length === 0, f.demoPersons.length === 0 ? 'none' : f.demoPersons.slice(0, 10).join(', ')),
    judge('DB-PUBLIC', 'DEMO', 'PUBLIC cannot connect to the GMP database (only the installation roles can)', !f.publicConnect, f.publicConnect ? 'PUBLIC has CONNECT' : 'PUBLIC has no CONNECT'),
  ];
}

const LOOPBACK = /^(127\.|::1$|localhost$|\[::1\]$)/;

export function serverChecks(env: Readonly<Record<string, string | undefined>>): HardeningCheck[] {
  const out: HardeningCheck[] = [];
  const origin = env['EBMR_PUBLIC_ORIGIN'];
  if (!origin) return [na('SRV-CONFIG', 'SERVER', 'the server configuration meets the security baseline', 'no server environment given')];
  const environment = env['EBMR_ENV'] === 'production' ? 'production' : env['EBMR_ENV'] === 'validation' ? 'validation' : 'development';
  const findings = continuity.checkProductionConfig({
    environment: environment === 'development' ? 'production' : environment,
    database: { url: env['EBMR_DB_APP_URL'] ?? '(development credentials: EBMR_DB_APP_URL is not set)' },
    ...(env['EBMR_DB_AUTHN_URL'] ? { siteServicesDatabase: { url: env['EBMR_DB_AUTHN_URL'] } } : {}),
    server: {
      publicUrl: origin,
      tlsTermination: 'REVERSE_PROXY',
      plainHttp: LOOPBACK.test(env['EBMR_HOST'] ?? '127.0.0.1') ? 'REFUSE' : 'SERVE',
      hsts: origin.startsWith('https:') ? { maxAgeSeconds: 31_536_000, includeSubDomains: true } : undefined,
      cookies: { secure: origin.startsWith('https:'), httpOnly: true, sameSite: 'Strict' },
    } as continuity.ServerConfig,
  });
  out.push(judge('SRV-CONFIG', 'SERVER', 'database URLs with sslmode=verify-full, an https origin, HSTS and Secure cookies (kernel security baseline, judged as production)', findings.filter((f) => f.severity === 'ERROR').length === 0,
    findings.length === 0 ? `origin ${origin}` : findings.map((f) => `${f.code} ${f.path}: ${f.message}`).join('; ')));
  const host = env['EBMR_HOST'] ?? '127.0.0.1';
  out.push(judge('SRV-LISTEN', 'SERVER', 'the server\'s plain-HTTP listener is on loopback only (TLS ends in the reverse proxy on the same host)', LOOPBACK.test(host), `EBMR_HOST=${host}`));
  out.push(judge('SRV-DEMO', 'SERVER', 'no demo switch and no DEMO-ONLY key file in the server configuration', !env['EBMR_DEMO'] && !env['EBMR_DEMO_KEYS_FILE'], `EBMR_DEMO=${env['EBMR_DEMO'] ?? '(unset)'}, EBMR_DEMO_KEYS_FILE=${env['EBMR_DEMO_KEYS_FILE'] ?? '(unset)'}`));
  return out;
}

export interface Listener {
  address: string;
  port: number;
}

/** The listening TCP sockets of /proc/net/tcp (IPv4) and tcp6 (IPv6). */
export function listeners(tcp: string, tcp6: string): Listener[] {
  const out: Listener[] = [];
  const parse = (text: string, v6: boolean) => {
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 4 || f[3] !== '0A') continue;
      const [hex = '', portHex = '0'] = (f[1] ?? '').split(':');
      const port = parseInt(portHex, 16);
      let address: string;
      if (!v6) address = [3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join('.');
      else {
        // Four 32-bit words, each in host (little-endian) byte order: eight 16-bit groups, written out in full.
        const words: string[] = [];
        for (let w = 0; w < 4; w += 1) {
          const le = (hex.slice(w * 8, w * 8 + 8).match(/../g) ?? []).reverse().join('');
          words.push(le.slice(0, 4).toLowerCase(), le.slice(4, 8).toLowerCase());
        }
        const full = words.join(':');
        address = full === '0000:0000:0000:0000:0000:0000:0000:0001' ? '::1' : full.startsWith('0000:0000:0000:0000:0000:ffff:') ? `::ffff:${String(parseInt(words[6]?.slice(0, 2) ?? '0', 16))}.${String(parseInt(words[6]?.slice(2) ?? '0', 16))}.${String(parseInt(words[7]?.slice(0, 2) ?? '0', 16))}.${String(parseInt(words[7]?.slice(2) ?? '0', 16))}` : full === '0000:0000:0000:0000:0000:0000:0000:0000' ? '::' : full;
      }
      out.push({ address, port });
    }
  };
  parse(tcp, false);
  parse(tcp6, true);
  return out;
}

export function portChecks(list: readonly Listener[], allowed: readonly number[]): HardeningCheck[] {
  const open = list.filter((l) => !(l.address.startsWith('127.') || l.address === '::1' || l.address.startsWith('::ffff:127.')));
  const extra = open.filter((l) => !allowed.includes(l.port));
  const ports = [...new Set(open.map((l) => l.port))].sort((a, b) => a - b);
  return [judge('PORTS', 'PORTS', `only the allowed ports listen off loopback (${allowed.join(', ') || 'none allowed'})`, extra.length === 0,
    extra.length === 0 ? `off loopback: ${ports.join(', ') || 'none'}` : `not allowed: ${[...new Set(extra.map((l) => `${l.address}:${String(l.port)}`))].join(', ')}`)];
}

async function databaseChecks(url: string, breakGlass: readonly string[], demoLogins: readonly string[]): Promise<HardeningCheck[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const settings = new Map((await c.query<{ name: string; setting: string }>('select name, setting from pg_settings')).rows.map((r) => [r.name, r.setting]));
    const out = [...postgresChecks(settings)];
    try {
      const rules = (await c.query<HbaRule & { error: string | null }>(
        'select type, database, user_name as users, address, netmask, auth_method as method, error from pg_hba_file_rules order by line_number')).rows;
      out.push(...hbaChecks(rules.filter((r) => r.error === null)));
    } catch (error) {
      out.push(na('PG-HBA', 'AUTHENTICATION', 'client authentication rules', `pg_hba_file_rules cannot be read with this connection: ${(error as Error).message}`));
    }
    const roles = (await c.query<RoleRow>(`select rolname, rolsuper, rolcanlogin, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication, left(coalesce(rolpassword, ''), 7) as pw
                                             from pg_authid where rolname !~ '^pg_' order by rolname`).catch(async () =>
      c.query<RoleRow>(`select rolname, rolsuper, rolcanlogin, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication, '' as pw from pg_roles where rolname !~ '^pg_' order by rolname`))).rows;
    out.push(...roleChecks(roles, breakGlass));
    const has = async (rel: string) => (await c.query<{ ok: boolean }>('select to_regclass($1) is not null as ok', [rel])).rows[0]?.ok ?? false;
    const demoMarker = (await has('tab.demo_installation')) ? Number((await c.query<{ n: string }>('select count(*)::text as n from tab.demo_installation')).rows[0]?.n ?? 0) > 0 : null;
    const demoKeys: string[] = [];
    if (await has('esig.seal_key')) {
      const labels = await c.query<{ k: string }>("select key_id || ' (' || description || ')' as k from esig.seal_key where description ~* 'demo|test-only' or key_id ~* 'demo'");
      demoKeys.push(...labels.rows.map((r) => `seal key ${r.k}`));
    }
    const demoPersons = demoLogins.length > 0 && (await has('iam.account'))
      ? (await c.query<{ l: string }>('select login_name as l from iam.account where login_name = any($1::text[]) order by 1', [demoLogins])).rows.map((r) => r.l)
      : [];
    const publicConnect = (await c.query<{ ok: boolean }>("select has_database_privilege('public', current_database(), 'CONNECT') as ok")).rows[0]?.ok ?? true;
    out.push(...demoChecks({ demoMarker, demoKeys, demoPersons, publicConnect }));
    return out;
  } finally {
    await c.end();
  }
}

export async function runHardeningCheck(o: HardeningOptions): Promise<HardeningReport> {
  const checks: HardeningCheck[] = [];
  if (o.databaseUrl) checks.push(...(await databaseChecks(o.databaseUrl, o.breakGlassRoles ?? ['postgres'], o.demoLoginNames ?? [])));
  else checks.push(na('DB', 'POSTGRESQL', 'database checks', 'no database URL given'));
  checks.push(...serverChecks(o.serverEnv ?? {}));
  const net = o.procNet ?? (existsSync('/proc/net/tcp') ? { tcp: readFileSync('/proc/net/tcp', 'utf8'), tcp6: existsSync('/proc/net/tcp6') ? readFileSync('/proc/net/tcp6', 'utf8') : '' } : null);
  checks.push(...(net ? portChecks(listeners(net.tcp, net.tcp6), o.allowedPorts ?? []) : [na('PORTS', 'PORTS', 'open ports', 'no /proc/net/tcp on this host')]));
  return { kind: 'ebmr.hardening-check', version: 1, result: checks.some((x) => x.status === 'FAIL') ? 'FAIL' : 'PASS', checks };
}

export function renderHardeningMarkdown(r: HardeningReport): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  return [
    `# Installation hardening check: ${r.result}`, '',
    '| Check | Area | What it proves | Result | Evidence |', '|---|---|---|---|---|',
    ...r.checks.map((c) => `| ${c.id} | ${c.area} | ${cell(c.title)} | ${c.status} | ${cell(c.evidence)} |`), '',
  ].join('\n');
}
