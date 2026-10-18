/**
 * The authorization meta scan of a set of schemas (DI-17, DI-18; Phase 7 slice 7b-1, review residual 6jc-R7): every
 * function the application role may execute that can write (VOLATILE) checks a known permission, or is listed with its
 * reason; every one that names a GMP permission refuses administrators before it checks it; the application role writes
 * no table of the schemas. The kernel (iam, esig, sandbox), recipe-core (plant) and Tablets (tab) tests each run it on
 * their own schemas with their own lists; a listed function that no longer exists, or no longer needs its entry, fails
 * the scan too, so the lists stay true.
 */
import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'>;

export interface ScanRules {
  /** App-callable functions that may write and check no permission of their own, with the reason. */
  readonly ungated: Readonly<Record<string, string>>;
  /** App-callable functions whose only check is a call of one gated function (schema.name, every overload gated). */
  readonly delegates: Readonly<Record<string, string>>;
  /**
   * Functions that name a GMP permission and refuse administrators after the permission check rather than before (both
   * refuse before anything is written; the order only decides which refusal an administrator reads), with the reason.
   */
  readonly adminAfterPermission: Readonly<Record<string, string>>;
}

export interface ScanResult {
  /** How many app-callable VOLATILE functions the schemas have. */
  readonly functions: number;
  /** Functions with no authority check, not listed and not a proven delegate. */
  readonly ungated: string[];
  /** Permission literals the catalogue does not know, as `fn: CODE` (functions listed as ungated are not read). */
  readonly unknownPermissions: string[];
  /** Functions naming a GMP permission that do not refuse administrators first (or at all). */
  readonly adminNotFirst: string[];
  /** List entries that name no scanned function, or a function that no longer needs the entry. */
  readonly staleEntries: string[];
  /** Tables of the schemas the application role may write directly. */
  readonly appWritableTables: string[];
}

const AUTHORITY = ['iam.require_permission(', 'platform.authorize('];
const checksAuthority = (src: string): boolean => AUTHORITY.some((g) => src.includes(g));
const permissionLiterals = (src: string): string[] => [...src.matchAll(/'([A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_]*)'/g)].map((m) => m[1] ?? '');
const adminFirst = (src: string): boolean => {
  const guard = src.indexOf('iam.assert_not_administrator()');
  const perm = Math.min(...AUTHORITY.map((g) => src.indexOf(g)).filter((i) => i >= 0), Number.MAX_SAFE_INTEGER);
  return guard >= 0 && guard < perm;
};

export async function authorizationScan(db: Queryable, schemas: readonly string[], rules: ScanRules): Promise<ScanResult> {
  const { rows: fns } = await db.query<{ fn: string; src: string }>(`
    select p.oid::regprocedure::text as fn, p.prosrc as src
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = any($1) and p.provolatile = 'v' and p.prokind = 'f' and has_function_privilege('ebmr_app', p.oid, 'EXECUTE')
     order by 1`, [schemas]);
  const callee = async (name: string): Promise<string[]> => (await db.query<{ src: string }>(
    "select p.prosrc as src from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname || '.' || p.proname = $1",
    [name])).rows.map((r) => r.src);
  const provenDelegate = async (f: { fn: string; src: string }, gate: (src: string) => boolean): Promise<boolean> => {
    const target = rules.delegates[f.fn];
    if (target === undefined || !f.src.includes(`${target}(`)) return false;
    const srcs = await callee(target);
    return srcs.length > 0 && srcs.every(gate);
  };
  const { rows: perms } = await db.query<{ code: string; domain: string }>('select code, domain from iam.permission');
  const domain = new Map(perms.map((p) => [p.code, p.domain]));

  const ungated: string[] = [];
  const adminNotFirst: string[] = [];
  const used = new Set<string>();
  for (const f of fns) {
    if (!checksAuthority(f.src)) {
      if (f.fn in rules.ungated) used.add(`ungated ${f.fn}`);
      else if (await provenDelegate(f, checksAuthority)) used.add(`delegates ${f.fn}`);
      else ungated.push(f.fn);
    }
    if (permissionLiterals(f.src).some((p) => domain.get(p) === 'GMP') && !adminFirst(f.src)) {
      if (f.fn in rules.adminAfterPermission && f.src.includes('iam.assert_not_administrator()')) used.add(`adminAfterPermission ${f.fn}`);
      else if (await provenDelegate(f, adminFirst)) used.add(`delegates ${f.fn}`);
      else adminNotFirst.push(f.fn);
    }
  }
  // In the functions that check authority (a listed read may name codes of another kind, such as an invariant's).
  const unknownPermissions = fns.filter((f) => !(f.fn in rules.ungated))
    .flatMap((f) => permissionLiterals(f.src).filter((p) => !domain.has(p)).map((p) => `${f.fn}: ${p}`));
  const staleEntries = (['ungated', 'delegates', 'adminAfterPermission'] as const)
    .flatMap((k) => Object.keys(rules[k]).map((fn) => `${k} ${fn}`))
    .filter((e) => !used.has(e));
  const { rows: tables } = await db.query<{ t: string }>(`
    select c.oid::regclass::text as t
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any($1) and c.relkind in ('r', 'p')
       and (has_table_privilege('ebmr_app', c.oid, 'INSERT') or has_table_privilege('ebmr_app', c.oid, 'UPDATE')
            or has_table_privilege('ebmr_app', c.oid, 'DELETE') or has_table_privilege('ebmr_app', c.oid, 'TRUNCATE'))
     order by 1`, [schemas]);
  return { functions: fns.length, ungated, unknownPermissions, adminNotFirst, staleEntries, appWritableTables: tables.map((t) => t.t) };
}
