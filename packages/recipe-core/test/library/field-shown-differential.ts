/**
 * The differential harness of family 6.1, field visibility (ADR 0023 decision 5 (a)): it runs the hand-written copies
 * of the rule, as they were before the switch-over, beside the copies generated from the one definition FIELD_SHOWN,
 * on the same fields and entries, and lists every difference.
 *
 * The four copies:
 * - LEGACY_ENGINE: recipe-core block-version.ts `shown` before the switch-over (frozen here);
 * - the engine now: `holds(FIELD_SHOWN.body, ...)`, which block-version.ts `shown` calls;
 * - LEGACY_GUARD: the guards' condition, recipe-core 1862 recipe.library_limits_problem (and 1928's hidden-field
 *   guard), read from the migration text itself (`legacyGuardCondition`), so the harness compares the guard as written;
 * - recipe.rule_library_field_shown, generated from FIELD_SHOWN (recipe-core 1930).
 */
import { readFileSync } from 'node:fs';
import { FIELD_SHOWN, holds, type Json } from '@ebmr/rules';
import type pg from 'pg';

/** A client or a pool. */
type Queryable = Pick<pg.Pool, 'query'>;

/** block-version.ts `shown` before the switch-over to FIELD_SHOWN, as it was on main at adbd1ba. */
export function LEGACY_ENGINE(f: { showWhen?: { field: string; equals: unknown } }, values: Readonly<Record<string, unknown>>): boolean {
  return f.showWhen === undefined || values[f.showWhen.field] === f.showWhen.equals;
}

export const engineShown = (field: Json, values: Json | undefined): boolean => holds(FIELD_SHOWN.body, { field, values });

/** The hidden condition as the hand-written guards write it, over the field `f` and the stored entry `e`. */
export const LEGACY_CONDITION = "f ? 'showWhen' and (e -> 'data' -> (f -> 'showWhen' ->> 'field')) is distinct from (f -> 'showWhen' -> 'equals')";

/**
 * The condition as it stands in a migration: the harness compares the guard's own text, so it fails if the text it
 * names is not there.
 */
export function legacyGuardCondition(migration: URL): string {
  const sql = readFileSync(migration, 'utf8');
  if (!sql.includes(LEGACY_CONDITION.replace("f ? 'showWhen' and ", ''))) throw new Error(`${migration.pathname} does not hold the guard's visibility condition`);
  return LEGACY_CONDITION;
}

export interface Pair {
  readonly label: string;
  readonly field: Json;
  /** The entry's values (`e -> 'data'`); undefined for no data at all (SQL NULL). */
  readonly values?: Json | undefined;
}

export interface Verdicts {
  readonly legacyEngine: boolean | 'throws';
  readonly engine: boolean;
  readonly legacyGuard: boolean;
  readonly generated: boolean;
}

/** The four verdicts on each pair: the two engine copies here, the two database copies in one query. */
export async function verdicts(db: Queryable, pairs: readonly Pair[]): Promise<Verdicts[]> {
  const out: Verdicts[] = [];
  for (let i = 0; i < pairs.length; i += 2000) {
    const chunk = pairs.slice(i, i + 2000);
    const { rows } = await db.query<{ i: string; legacy: boolean; generated: boolean }>(
      `select x.i, not coalesce(${LEGACY_CONDITION}, false) as legacy, recipe.rule_library_field_shown(f, e -> 'data') as generated
         from jsonb_array_elements($1::jsonb) with ordinality as x(p, i), lateral (select x.p -> 'f' as f, x.p -> 'e' as e) as y
        order by x.i`,
      [JSON.stringify(chunk.map((p) => ({ f: p.field, e: p.values === undefined ? {} : { data: p.values } })))],
    );
    chunk.forEach((p, j) => {
      const r = rows[j];
      if (r === undefined || Number(r.i) !== j + 1) throw new Error(`no database verdict for ${p.label}`);
      let legacyEngine: boolean | 'throws';
      try {
        legacyEngine = LEGACY_ENGINE(p.field as never, (p.values ?? {}) as Record<string, unknown>);
      } catch {
        legacyEngine = 'throws';
      }
      out.push({ legacyEngine, engine: engineShown(p.field, p.values), legacyGuard: r.legacy, generated: r.generated });
    });
  }
  return out;
}

/** Each pair on which the four copies do not all give the same verdict. */
export async function differences(db: Queryable, pairs: readonly Pair[]): Promise<string[]> {
  const vs = await verdicts(db, pairs);
  return pairs.flatMap((p, i) => {
    const v = vs[i]!;
    return v.legacyEngine === v.engine && v.engine === v.legacyGuard && v.legacyGuard === v.generated ? [] : [`${p.label}: ${JSON.stringify(v)} on ${JSON.stringify({ field: p.field, values: p.values })}`];
  });
}

/**
 * Every field of every stored library entry of the database, with the guard's condition and the generated function
 * compared on the stored data: the rows that differ, and how many fields were compared.
 */
export const STORED_DIFFERENCES_SQL = `
with s as (
  select s.batch_id, y.key, y.value as e, recipe.batch_mbr_content(s.batch_id) as c, s.state
    from recipe.execution_state s,
         jsonb_each(case when jsonb_typeof(s.state -> 'entries') = 'object' then s.state -> 'entries' else '{}'::jsonb end) y
   where jsonb_typeof(y.value -> 'data') = 'object'
), n as (
  select s.*, recipe.step_node(c, state -> 'steps' -> (e ->> 'stepKey') ->> 'step') as node from s
), d as (
  select n.*, recipe.library_definition(c, node -> 'block') as def from n where coalesce(node -> 'block' ->> 'type', '') like 'LIB-%'
), f as (
  select d.batch_id, d.key, f, d.e, not coalesce(${LEGACY_CONDITION}, false) as legacy, recipe.rule_library_field_shown(f, d.e -> 'data') as generated
    from d, jsonb_array_elements(d.def -> 'sections') sec, jsonb_array_elements(sec -> 'fields') f
   where d.def is not null and sec ->> 'id' = d.e ->> 'kind'
)
select count(*)::int as compared,
       coalesce(jsonb_agg(jsonb_build_object('batch', batch_id, 'entry', key, 'field', f ->> 'id', 'legacy', legacy, 'generated', generated))
                filter (where legacy is distinct from generated), '[]'::jsonb) as differences
  from f`;

export async function storedDifferences(db: Queryable): Promise<{ compared: number; differences: Json[] }> {
  const { rows } = await db.query<{ compared: number; differences: Json[] }>(STORED_DIFFERENCES_SQL);
  return rows[0] ?? { compared: 0, differences: [] };
}
