/**
 * What a migrated database holds, as the evidence bundle lists it and the IQ compares it (Phase 7 slice 7c; moved here
 * from tools/validation in slice 7g-3, decision D-P7R-5, so the server's IQ route runs the same code as the CLI): its
 * migrations, functions, triggers, constraints, privileges, roles, settings and catalogues, in one read-only transaction.
 */
import { createHash } from 'node:crypto';
import { compareText } from '../bundle/validate.ts';
import type { Inventory } from '../bundle/types.ts';

/** The one thing the inventory and the IQ need of a database connection (a pg client fits). */
export interface QueryClient {
  query<T extends object = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

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

const CONTYPE: Record<string, string> = { c: 'CHECK', f: 'FOREIGN KEY', p: 'PRIMARY KEY', u: 'UNIQUE', t: 'CONSTRAINT TRIGGER', x: 'EXCLUSION' };

export type DbInventory = Omit<Inventory, 'messages' | 'routes'>;

/** What the database holds, in one read-only transaction. */
export async function databaseInventory(client: QueryClient, lockedSettings: Readonly<Record<string, string>> = LOCKED_SETTINGS): Promise<DbInventory> {
  await client.query('begin transaction isolation level repeatable read read only');
  try {
    const q = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await client.query<T>(sql, params)).rows;
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
