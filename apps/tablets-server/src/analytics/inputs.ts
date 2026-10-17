/**
 * The runner's reads (ADR 0020 point 3; D-6A-5, D-6A-1-11): every input of a run in one REPEATABLE READ READ ONLY
 * transaction as ebmr_analytics, so a run sees one snapshot. For each input it records what analytics.begin_run needs:
 * the view, its version, the filter, the snapshot's data_as_of, the row count and the SHA-256 of the canonical rows.
 *
 * The rows are the view's columns without read_at and data_as_of (the read's own times, recorded once for the
 * input), sorted by their canonical text, so the same data gives the same rows, in the same order, and the same hash
 * on every read, whatever order the view returns them in. The pool parses no time, date or number into a JavaScript
 * value (pool.ts): GMP values stay the views' decimal text.
 */
import type pg from 'pg';
import { canonicalText, sha256Hex } from '@ebmr/analytics';
import type { InputRow, InputSpec } from './implementation.ts';
import { connectRetrying } from './pool.ts';

/** What begin_run records about one input (interfaces section 2, analytics.run inputs). */
export interface InputRecord {
  view: string;
  version: number;
  filter: Readonly<Record<string, string | number | boolean>> | null;
  data_as_of: string;
  rows: number;
  sha256: string;
}

export interface Snapshot {
  rows: Record<string, InputRow[]>;
  inputs: InputRecord[];
  dataAsOf: string;
}

const VIEW = /^report\.[a-z][a-z0-9_]*_v[1-9][0-9]*$/;
const COLUMN = /^[a-z_][a-z0-9_]*$/;
const READ_TIMES = new Set(['read_at', 'data_as_of']);

export class InputSpecError extends Error {}

/** The SQL and parameters of one input read; refuses a name that is not a catalogued view's or a column's shape. */
export function inputQuery(spec: InputSpec): { text: string; values: unknown[] } {
  if (!VIEW.test(spec.view)) throw new InputSpecError(`${spec.view} is not a report view name`);
  if (!spec.view.endsWith(`_v${spec.version}`)) throw new InputSpecError(`${spec.view} is not version ${spec.version} of its name`);
  const entries = Object.entries(spec.filter ?? {});
  for (const [column] of entries) if (!COLUMN.test(column)) throw new InputSpecError(`${column} is not a column name`);
  const where = entries.map(([column], i) => `"${column}" = $${i + 1}`).join(' and ');
  return { text: `select * from ${spec.view}${where ? ` where ${where}` : ''}`, values: entries.map(([, v]) => v) };
}

/** The canonical rows of a read: without the read's own times, sorted by canonical text. */
export function canonicalRows(rows: readonly Record<string, unknown>[]): { rows: InputRow[]; sha256: string } {
  const keyed = rows.map((r) => {
    const row = Object.fromEntries(Object.entries(r).filter(([k]) => !READ_TIMES.has(k)));
    return { row, text: canonicalText(row) };
  });
  keyed.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  return { rows: keyed.map((k) => k.row), sha256: sha256Hex(`[${keyed.map((k) => k.text).join(',')}]`) };
}

/** Reads every input in one REPEATABLE READ READ ONLY snapshot. */
export async function readSnapshot(pool: pg.Pool, specs: readonly InputSpec[]): Promise<Snapshot> {
  const queries = specs.map((s) => ({ spec: s, q: inputQuery(s) }));
  if (new Set(specs.map((s) => s.view)).size !== specs.length) throw new InputSpecError('a method reads each view once (its rows are keyed by the view)');
  const client = await connectRetrying(pool);
  try {
    await client.query('begin transaction isolation level repeatable read read only');
    const { rows: asOf } = await client.query<{ t: string }>(
      `select to_char(coalesce(pg_catalog.pg_last_xact_replay_timestamp(), pg_catalog.transaction_timestamp()) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`,
    );
    const dataAsOf = asOf[0]!.t;
    const out: Snapshot = { rows: {}, inputs: [], dataAsOf };
    for (const { spec, q } of queries) {
      const { rows } = await client.query<Record<string, unknown>>(q.text, q.values);
      const c = canonicalRows(rows);
      out.rows[spec.view] = c.rows;
      out.inputs.push({ view: spec.view, version: spec.version, filter: spec.filter, data_as_of: dataAsOf, rows: c.rows.length, sha256: c.sha256 });
    }
    await client.query('commit');
    return out;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
