/**
 * The installation qualification script (Phase 7 slice 7c; `pnpm validation:iq --db <url> --server <url> --bundle
 * <file>`): checks an installation against the release's evidence bundle, check by check (IQ_CHECKS of the validation
 * kit), and writes the IQ record with each check's expected and actual value. Read-only on the database (one READ ONLY
 * transaction); the server is asked only its public `/api/meta`.
 *
 * A check fails by name: a dropped or disabled trigger (IQ-04), a revoked privilege (IQ-06), a DEMO-ONLY key (IQ-09),
 * and so on. A check that cannot be made (no server given) fails too, saying why: the record never claims what it did
 * not see.
 */
import type pg from 'pg';
import { IQ_CHECKS, type Bundle, type Host, type Measure } from '@ebmr/validation-kit';
import { databaseInventory, type DbInventory } from './inventory.ts';

export interface IqCheckResult {
  id: string;
  name: string;
  expected: string;
  actual: string;
  passed: boolean;
  /** What differs, at most 50 lines. */
  problems: string[];
}

export interface IqRecord {
  kind: 'iq';
  passed: boolean;
  summary: string;
  release: { version: string; commit: string; schemaRelease: string };
  installation: { database: string; server: string | null };
  host: Host;
  checks: IqCheckResult[];
  measures: Measure[];
}

export interface IqInputs {
  db: pg.ClientBase;
  bundle: Bundle;
  /** The server's base URL (https://host:port); null: the server checks fail as not made. */
  server: string | null;
  host: Host;
  fetchFn?: (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;
const APP_ROLES = ['ebmr_app', 'ebmr_authn', 'ebmr_listener', 'ebmr_analytics', 'ebmr_sandbox', 'ebmr_sandbox_listener'];

function diff<T>(want: readonly T[], have: readonly T[], key: (x: T) => string, same: (a: T, b: T) => boolean, what: string): string[] {
  const h = new Map(have.map((x) => [key(x), x]));
  const out: string[] = [];
  for (const w of want) {
    const x = h.get(key(w));
    if (!x) out.push(`${what} ${key(w)} is missing`);
    else if (!same(w, x)) out.push(`${what} ${key(w)} differs`);
  }
  return out;
}

/** What the IQ reads of the installation besides its inventory, in one read-only transaction. */
async function installationFacts(db: pg.ClientBase): Promise<{ release: string; database: string; kind: string; demoKeys: string[]; demoMarker: boolean; undescribed: string[] }> {
  const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;
  await db.query('begin transaction read only');
  try {
    const release = (await q<{ r: string }>('select platform.schema_release() as r'))[0]?.r ?? '';
    const database = (await q<{ d: string }>('select current_database() as d'))[0]?.d ?? '';
    const kind = (await q<{ k: string }>('select kernel.installation_kind() as k'))[0]?.k ?? '';
    const demoKeys = (await q<{ k: string }>(
      `select k.key_id as k from esig.seal_key k where (k.description ilike '%DEMO-ONLY%' or k.key_id ilike 'demo-%')
          and not exists (select 1 from esig.seal_key_retirement r where r.key_id = k.key_id) order by 1`,
    )).map((r) => r.k);
    const marker = (await q<{ n: string }>("select count(*)::text as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'tab' and c.relname = 'demo_installation'"))[0]?.n === '1';
    const demoMarker = marker && (await q<{ n: string }>('select count(*)::text as n from tab.demo_installation'))[0]?.n !== '0';
    const undescribed = (await q<{ code: string }>("select d.code from iam.integration_adapter d where d.status = 'ACTIVE' and not platform.interface_described(d.code) order by 1")).map((r) => r.code);
    return { release, database, kind, demoKeys, demoMarker, undescribed };
  } finally {
    await db.query('rollback');
  }
}

export async function runIq(inp: IqInputs): Promise<IqRecord> {
  const b = inp.bundle;
  const inv = b.inventory;
  const have: DbInventory = await databaseInventory(inp.db, Object.fromEntries(inv.settings.filter((s) => s.expected !== null).map((s) => [s.name, s.expected ?? ''])));
  const { release, database, kind, demoKeys, demoMarker, undescribed } = await installationFacts(inp.db);

  let meta: Record<string, unknown> | null = null;
  let metaProblem: string | null = null;
  if (inp.server) {
    try {
      const res = await (inp.fetchFn ?? ((u: string) => fetch(u)))(`${inp.server.replace(/\/$/, '')}/api/meta`);
      if (res.status !== 200) metaProblem = `GET /api/meta answered ${String(res.status)}`;
      else meta = (await res.json()) as Record<string, unknown>;
    } catch (e) {
      metaProblem = `the server could not be reached: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const checks: IqCheckResult[] = [];
  const add = (id: string, actual: string, problems: string[]): void => {
    const c = IQ_CHECKS.find((x) => x.id === id);
    if (!c) throw new Error(`unknown IQ check ${id}`);
    checks.push({ id, name: c.name, expected: c.expected, actual, passed: problems.length === 0, problems: problems.slice(0, 50) });
  };

  add('IQ-01', release, release === b.release.schemaRelease ? [] : [`the installation runs schema release ${release}, the release is ${b.release.schemaRelease}`]);
  const migProblems = [
    ...diff(inv.migrations, have.migrations, (m) => `${m.namespace}/${m.name}`, (a, x) => a.sha256 === x.sha256, 'migration'),
    ...have.migrations.filter((m) => !inv.migrations.some((w) => w.namespace === m.namespace && w.name === m.name)).map((m) => `migration ${m.namespace}/${m.name} is not of the release`),
  ];
  add('IQ-02', `${String(have.migrations.length)} migrations`, migProblems);
  const serverUrl = inp.server ? new URL(inp.server) : null;
  add('IQ-03', meta ? `server ${String(meta['version'])}, installation ${String(meta['installation'])}` : (metaProblem ?? 'no --server given: not checked'),
    !meta ? [metaProblem ?? 'no --server given: the server version was not checked'] : [
      ...(meta['version'] === b.release.version ? [] : [`the server reports version ${String(meta['version'])}, the release is ${b.release.version}`]),
      ...(meta['edition'] === b.edition ? [] : [`the server is the ${String(meta['edition'])} edition, the release is ${b.edition}`]),
    ]);
  add('IQ-04', `${String(have.triggers.length)} triggers`, [
    ...diff(inv.triggers, have.triggers, (t) => `${t.table}.${t.name}`, (a, x) => a.function === x.function, 'trigger'),
    ...have.triggers.filter((t) => !t.enabled && inv.triggers.some((w) => w.table === t.table && w.name === t.name)).map((t) => `trigger ${t.table}.${t.name} is disabled`),
  ]);
  add('IQ-05', `${String(have.constraints.length)} constraints`, diff(inv.constraints, have.constraints, (c) => `${c.table}.${c.name}`, (a, x) => a.definitionSha256 === x.definitionSha256 && a.kind === x.kind, 'constraint'));
  const privKey = (p: { role: string; object: string; privilege: string }) => `${p.role} ${p.privilege} on ${p.object}`;
  add('IQ-06', `${String(have.privileges.length)} privileges`, [
    ...diff(inv.privileges, have.privileges, privKey, () => true, 'privilege'),
    ...have.privileges.filter((p) => APP_ROLES.includes(p.role) && !inv.privileges.some((w) => privKey(w) === privKey(p))).map((p) => `privilege ${privKey(p)} is not of the release`),
  ]);
  add('IQ-07', `${String(have.functions.filter((f) => f.securityDefiner).length)} SECURITY DEFINER functions`,
    diff(inv.functions, have.functions, (f) => `${f.schema}.${f.name}(${f.argTypes})`, (a, x) => a.securityDefiner === x.securityDefiner && a.executeRoles.join(',') === x.executeRoles.join(','), 'function'));
  add('IQ-08', have.roles.map((r) => r.name).join(', '), have.roles.filter((r) => APP_ROLES.includes(r.name) && (r.superuser || r.createRole || r.bypassRls)).map((r) => `role ${r.name} is ${[r.superuser ? 'a superuser' : '', r.createRole ? 'able to create roles' : '', r.bypassRls ? 'bypassing row security' : ''].filter(Boolean).join(', ')}`));
  const settingProblems = have.settings.filter((s) => s.expected !== null && s.value !== s.expected).map((s) => `setting ${s.name} is ${s.value}, the release requires ${s.expected ?? ''}`);
  add('IQ-09', [`DEMO-ONLY keys: ${demoKeys.join(', ') || 'none'}`, ...have.settings.filter((s) => s.expected !== null).map((s) => `${s.name}=${s.value}`)].join('; '), [
    ...demoKeys.map((k) => `DEMO-ONLY seal key ${k} is registered and not retired`),
    ...(demoMarker ? ['the database is marked as a demo installation (tab.demo_installation)'] : []),
    ...(meta && meta['demo'] === true ? ['the server offers the DEMO-ONLY device picker'] : []),
    ...(serverUrl && serverUrl.protocol !== 'https:' && !LOOPBACK.test(serverUrl.hostname) ? [`the server is reached over plain HTTP off loopback (${inp.server ?? ''})`] : []),
    ...(meta && typeof meta['publicOrigin'] === 'string' && !String(meta['publicOrigin']).startsWith('https://') && !LOOPBACK.test(new URL(String(meta['publicOrigin'])).hostname) ? [`the server's public origin ${String(meta['publicOrigin'])} is plain HTTP`] : []),
    ...settingProblems,
  ]);
  add('IQ-10', undescribed.length === 0 ? 'every active adapter is described' : `undescribed: ${undescribed.join(', ')}`, undescribed.map((c) => `active adapter ${c} is not in the approved system description (DI-06)`));
  add('IQ-11', `${kind} database ${database}`, kind === 'GMP' ? [] : [`the installation is ${kind || 'unmarked'}, not GMP`]);

  const failed = checks.filter((c) => !c.passed);
  return {
    kind: 'iq',
    passed: failed.length === 0,
    summary: failed.length === 0 ? `all ${String(checks.length)} IQ checks passed` : `${String(failed.length)} of ${String(checks.length)} IQ checks failed: ${failed.map((c) => `${c.id} ${c.name}`).join(', ')}`,
    release: { version: b.release.version, commit: b.release.commit, schemaRelease: b.release.schemaRelease },
    installation: { database, server: inp.server },
    host: inp.host,
    checks,
    measures: checks.map((c) => ({ name: `${c.id} ${c.name}: problems`, value: String(c.problems.length), unit: 'problems', limit: '0' })),
  };
}
