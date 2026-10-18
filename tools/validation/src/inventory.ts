/**
 * The inventory of the evidence bundle (Phase 7 slice 7c; interfaces section 1b): what a database migrated to the
 * release holds, read over a read-only connection from pg_catalog and the kernel's registries, and what the code
 * declares (the message catalogue, the API routes).
 *
 * Every list is sorted by its key with compareText (code point order), so the same database and code give the same
 * inventory. Nothing here writes: the database work runs in one READ ONLY transaction that is rolled back.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type pg from 'pg';
import { routes } from '@ebmr/api-contract';
import { compareText, type Inventory, type InvMessage, type InvRoute } from '@ebmr/validation-kit';
import { ROOT, sha256 } from './sources.ts';

/** Settings the release fixes, with their expected value (IQ-09). */
export const LOCKED_SETTINGS: Readonly<Record<string, string>> = { password_encryption: 'scram-sha-256', ssl: 'on' };
/** Settings recorded for the record (no expected value). */
export const RECORDED_SETTINGS: readonly string[] = ['TimeZone', 'max_connections', 'server_version', 'shared_preload_libraries'];

/** The schemas of the product (not PostgreSQL's own). */
const APP_SCHEMAS = `n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'`;

const by = <T>(...keys: ((x: T) => string)[]) => (a: T, b: T): number => {
  for (const k of keys) {
    const c = compareText(k(a), k(b));
    if (c !== 0) return c;
  }
  return 0;
};

/** Removes items whose key repeats (the first, in the given order, is kept). */
function unique<T>(items: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const CONTYPE: Record<string, string> = { c: 'CHECK', f: 'FOREIGN KEY', p: 'PRIMARY KEY', u: 'UNIQUE', t: 'CONSTRAINT TRIGGER', x: 'EXCLUSION' };

export type DbInventory = Omit<Inventory, 'messages' | 'routes'>;

/** What the database holds, in one read-only transaction. */
export async function databaseInventory(client: pg.ClientBase, lockedSettings: Readonly<Record<string, string>> = LOCKED_SETTINGS): Promise<DbInventory> {
  await client.query('begin transaction isolation level repeatable read read only');
  try {
    const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> => (await client.query<T>(sql, params)).rows;
    const migrations = (await q<{ namespace: string; name: string; sha256: string }>('select namespace, name, checksum as sha256 from public.schema_migration'))
      .sort(by((m) => m.namespace, (m) => m.name));
    const functions = (
      await q<{ schema: string; name: string; arg_types: string; definer: boolean; owner: string; roles: string[] | null }>(
        `select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as arg_types, p.prosecdef as definer,
                pg_get_userbyid(p.proowner)::text as owner,
                case when p.proacl is null then array['PUBLIC']::text[]
                     else (select array_agg(distinct case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end)
                             from aclexplode(p.proacl) a where a.privilege_type = 'EXECUTE') end as roles
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where ${APP_SCHEMAS} and p.prokind in ('f', 'p')`,
      )
    )
      .map((r) => ({ schema: r.schema, name: r.name, argTypes: r.arg_types, securityDefiner: r.definer, owner: r.owner, executeRoles: (r.roles ?? []).sort(compareText) }))
      .sort(by((f) => f.schema, (f) => f.name, (f) => f.argTypes));
    const triggers = (
      await q<{ table: string; name: string; enabled: boolean; function: string }>(
        `select n.nspname || '.' || c.relname as table, t.tgname as name, t.tgenabled <> 'D' as enabled, pn.nspname || '.' || p.proname as function
           from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
           join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
          where not t.tgisinternal and ${APP_SCHEMAS}`,
      )
    ).sort(by((t) => t.table, (t) => t.name));
    const constraints = (
      await q<{ table: string; name: string; kind: string; def: string }>(
        `select n.nspname || '.' || c.relname as table, k.conname as name, k.contype::text as kind, pg_get_constraintdef(k.oid) as def
           from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
          where k.conrelid <> 0 and ${APP_SCHEMAS}`,
      )
    )
      .map((r) => ({ table: r.table, name: r.name, kind: CONTYPE[r.kind] ?? r.kind, definitionSha256: sha256(r.def) }))
      .sort(by((c) => c.table, (c) => c.name));
    const privileges = (
      await q<{ role: string; object: string; privilege: string }>(
        `select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end as role, n.nspname || '.' || c.relname as object, a.privilege_type as privilege
           from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
          where c.relkind in ('r', 'v', 'm', 'S', 'p') and c.relacl is not null and ${APP_SCHEMAS}`,
      )
    ).sort(by((p) => p.role, (p) => p.object, (p) => p.privilege));
    const roles = (
      await q<{ name: string; login: boolean; superuser: boolean; create_role: boolean; bypass_rls: boolean; inherit: boolean; limit: number }>(
        `select rolname as name, rolcanlogin as login, rolsuper as superuser, rolcreaterole as create_role, rolbypassrls as bypass_rls, rolinherit as inherit,
                rolconnlimit as limit
           from pg_roles where rolname like 'ebmr\\_%'`,
      )
    )
      .map((r) => ({ name: r.name, login: r.login, superuser: r.superuser, createRole: r.create_role, bypassRls: r.bypass_rls, inherit: r.inherit, connectionLimit: r.limit }))
      .sort(by((r) => r.name));
    const names = [...new Set([...Object.keys(lockedSettings), ...RECORDED_SETTINGS])];
    const settings = (await q<{ name: string; value: string }>('select name, setting as value from pg_settings where name = any($1)', [names]))
      .map((s) => ({ name: s.name, value: s.value === '' ? '(empty)' : s.value, expected: lockedSettings[s.name] ?? null }))
      .sort(by((s) => s.name));
    const auditedTables = (await q<{ table: string }>('select table_name::text as table from kernel.audited_table')).sort(by((t) => t.table));
    const permissions = (
      await q<{ permission: string; roles: string[] | null }>(
        `select p.code as permission, (select array_agg(distinct r.role_code) from iam.role_permission r where r.permission_code = p.code and r.removed_at is null) as roles
           from iam.permission p`,
      )
    )
      .map((p) => ({ permission: p.permission, roles: (p.roles ?? []).sort(compareText), scopeKinds: [] as string[] }))
      .sort(by((p) => p.permission));
    const meanings = (await q<{ meaning: string }>('select distinct code as meaning from esig.meaning_type')).sort(by((m) => m.meaning));
    const versions = await q<{ code: string; version: number; states: string[] }>('select machine_code as code, version, states from platform.machine_version');
    const transitions = await q<{ code: string; version: number; from: string; event: string; to: string }>(
      'select machine_code as code, machine_version as version, from_state as from, event, to_state as to from platform.machine_transition',
    );
    const stateCharts = versions
      .map((v) => ({
        machine: `${v.code} v${String(v.version)}`,
        states: [...v.states],
        transitions: transitions
          .filter((t) => t.code === v.code && t.version === v.version)
          .map((t) => ({ from: t.from, event: t.event, to: t.to }))
          .sort(by((t) => t.from, (t) => t.event, (t) => t.to)),
      }))
      .sort(by((m) => m.machine));
    const blocks = (await q<{ block_type: string; version: string }>('select distinct block_type, block_version as version from recipe.block_data_schema'))
      .map((b) => ({ blockType: b.block_type, version: Number(b.version), controls: [] as string[] }))
      .sort((a, b) => compareText(a.blockType, b.blockType) || a.version - b.version);
    const ruleKeys = (await q<{ key: string }>('select distinct key from market.rule_key')).sort(by((k) => k.key));
    return { migrations, functions, triggers, constraints, privileges, roles, settings, auditedTables, permissions, meanings, stateCharts, blocks, ruleKeys };
  } finally {
    await client.query('rollback');
  }
}

const MESSAGE = /EBMR-[A-Z]+-\d{3,4}/g;

function filesUnder(dir: string, ext: RegExp): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries.sort()) {
    if (e === 'node_modules' || e === 'test' || e === 'fixtures') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, ext));
    else if (ext.test(e)) out.push(p);
  }
  return out;
}

/** The text that goes with a message code on its line: the quoted text around it, without SQL format markers. */
function messageText(line: string, code: string): string {
  const at = line.indexOf(code);
  const quote = (ch: string): [number, number] | null => {
    const start = line.lastIndexOf(ch, at);
    const end = line.indexOf(ch, at + code.length);
    return start >= 0 && end > start ? [start + 1, end] : null;
  };
  const span = quote("'") ?? quote('`') ?? quote('"');
  const raw = span ? line.slice(span[0], span[1]) : line.slice(at);
  const text = raw.replace(code, '').replace(/^[\s:.-]+|[\s[\]]+$/g, '').replace(/\s+/g, ' ').trim();
  return (text === '' ? '(see source)' : text).slice(0, 300);
}

/** The message catalogue: each EBMR code once, with the text of its first occurrence in the SQL and the product code. */
export function messageCatalogue(root = ROOT): InvMessage[] {
  const files = [
    ...['packages', 'apps'].flatMap((top) => {
      let dirs: string[];
      try {
        dirs = readdirSync(join(root, top)).sort();
      } catch {
        return [];
      }
      return dirs.flatMap((d) => [...filesUnder(join(root, top, d, 'sql'), /\.sql$/), ...filesUnder(join(root, top, d, 'src'), /\.tsx?$/)]);
    }),
  ].map((f) => relative(root, f).split('\\').join('/')).sort(compareText);
  const out: InvMessage[] = [];
  for (const file of files) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    for (const line of lines) {
      for (const m of line.matchAll(MESSAGE)) out.push({ code: m[0], text: messageText(line, m[0]), sourceFile: file });
    }
  }
  return unique(out, (m) => m.code).sort(by((m) => m.code));
}

interface RouteLike {
  id: string;
  method: InvRoute['method'];
  path: string;
}
const isRoute = (x: unknown): x is RouteLike =>
  typeof x === 'object' && x !== null && typeof (x as RouteLike).id === 'string' && typeof (x as RouteLike).path === 'string' && typeof (x as RouteLike).method === 'string';

/** Every route of the API contract (the database checks the permission in the command: none is named here). */
export function routeCatalogue(): InvRoute[] {
  const out: InvRoute[] = [];
  const walk = (x: unknown): void => {
    if (isRoute(x)) {
      out.push({ namespace: x.id.split('.')[0] ?? x.id, route: x.path, method: x.method, permission: null });
      return;
    }
    if (typeof x === 'object' && x !== null) for (const v of Object.values(x)) walk(v);
  };
  walk(routes);
  return unique(out.sort(by((r) => r.namespace, (r) => r.route, (r) => r.method)), (r) => `${r.namespace} ${r.route} ${r.method}`);
}

/** The whole inventory: the database's and the code's. */
export async function inventory(client: pg.ClientBase, opts: { lockedSettings?: Readonly<Record<string, string>>; root?: string } = {}): Promise<Inventory> {
  const db = await databaseInventory(client, opts.lockedSettings);
  return { ...db, messages: messageCatalogue(opts.root), routes: routeCatalogue() };
}
