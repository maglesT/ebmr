/**
 * Small shared reads of the slice 6 features (Phase 3 slice 6a): a person as PersonRef by person id, and epoch
 * microseconds of a timestamp as SQL text. The record names a person by id; the name and user id are read here.
 */
import type pg from 'pg';
import type { PersonRef } from '@ebmr/api-contract';

type Db = Pick<pg.Pool, 'query'>;

/** SQL: epoch microseconds of a timestamptz column as text (for app.formatInstant). */
export const usOf = (col: string): string => `(extract(epoch from ${col}) * 1000000)::numeric(20, 0)::text`;

/** PersonRefs of the given person ids (one query); the role is the act's, given by the caller. */
export async function peopleOf(db: Db, ids: readonly (string | null | undefined)[]): Promise<Map<string, { legalName: string; loginName: string }>> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x !== ''))];
  const out = new Map<string, { legalName: string; loginName: string }>();
  if (want.length === 0) return out;
  const { rows } = await db.query<{ id: string; legal_name: string; login_name: string | null }>(
    'select p.id, p.legal_name, (select a.login_name from iam.account a where a.person_id = p.id order by a.login_name limit 1) as login_name from iam.person p where p.id = any ($1::uuid[])',
    [want],
  );
  for (const r of rows) out.set(r.id, { legalName: r.legal_name, loginName: r.login_name ?? 'unknown' });
  return out;
}

/** The object without its undefined members (a zod output with optional members for a definer's JSON input). */
export function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function personRef(people: Map<string, { legalName: string; loginName: string }>, id: string, role: string): PersonRef {
  const p = people.get(id);
  return { personId: id, legalName: p?.legalName ?? 'unknown person', loginName: p?.loginName ?? 'unknown', role };
}
