/**
 * The outputs of a GB-T-01 batch as D-S6-7 compares them (Phase 3 slice 6d), read from the database after the run:
 *  - states: the batch, each stage and each step instance, and each plant output container of the batch;
 *  - exceptions: type, step, tier, severity and disposition (with whether a deviation is linked);
 *  - quantities and yields: the recorded and computed items (exact decimals as stored) and the dispensing calculation;
 *  - genealogy: the lot consumptions, the addition's source edge and the batch's containers;
 *  - the signatures of the batch record (the engine's set: aggregates batch_issue, batch_step, batch_stage,
 *    batch_exception of the batch);
 *  - the SHA-256 of the normalised true copy: the batch's stored record head (recipe.execution_state), canonical JSON,
 *    with each UUID replaced by its ordinal of first appearance, each batch number by its ordinal, each instant of the
 *    run in epoch microseconds by its offset from the batch's issue in whole minutes, and each expiry month and the year
 *    in each deviation number by a placeholder (see normalise).
 */
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { GBT01_LOTS } from '../../../src/features/execution/seed-gb-t-01.ts';
import type { GoldenWorld } from './world.ts';

type Json = Record<string, unknown>;

export interface BatchResults {
  batchNumber: string;
  states: { batch: string; stages: Record<string, string>; steps: Record<string, string>; containers: Record<string, string> };
  exceptions: { type: string; step: string | null; tier: string | null; severity: string; status: string; disposition: string | null; deviation: boolean }[];
  values: Record<string, string | string[]>;
  dispensing: Json;
  genealogy: { consumptions: string[]; additions: string[]; containers: string[] };
  signatures: number;
  trueCopy: { sha256: string; normalised: string };
}

async function one<T>(w: GoldenWorld, sql: string, params: unknown[]): Promise<T> {
  const { rows } = await w.server.db.admin.query<{ r: T }>(sql, params);
  return rows[0]?.r as T;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const MICROS = /^1[6-9][0-9]{14}$/;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The year in a deviation number (DEV-<site>-<year>-<sequence>): the year the run raised it in. */
const DEVIATION_YEAR = /\b(DEV-[A-Z0-9-]+?-)\d{4}(-\d+)\b/g;

/**
 * The seeded lots' fixed retest and expiry instants, in epoch microseconds. They lie years after any run, so "at or
 * after the scenario's start" alone would take them for the run's instants, and as minutes from the issue they would
 * change with the day of the run (and the hash with them). They are fixed data, kept as they are.
 */
const SEEDED_LOT_INSTANTS: ReadonlySet<string> = new Set(
  GBT01_LOTS.flatMap((l) => (l.retestAt === undefined ? [l.expiresAt] : [l.expiresAt, l.retestAt])).map((t) => `${String(Date.parse(t))}000`),
);

/**
 * The normalised true copy of a record head: UUIDs and batch numbers by ordinal, the instants of the run (at or after
 * `sinceUs`, the scenario's start) as minutes from the issue, and an expiry month and a deviation number's year (both
 * derived from the run's dates) as placeholders. Instants before the scenario and the seeded lots' fixed retest and expiry dates stay as they are.
 */
export function normalise(head: unknown, issueUs: bigint, batchNumbers: readonly string[], sinceUs: bigint): string {
  const ids = new Map<string, string>();
  const idOf = (u: string): string => {
    let x = ids.get(u);
    if (!x) {
      x = `<uuid-${String(ids.size + 1)}>`;
      ids.set(u, x);
    }
    return x;
  };
  const text = (s: string): string => {
    let out = s.replace(UUID_IN, (u) => idOf(u)).replace(DEVIATION_YEAR, '$1<year>$2');
    batchNumbers.forEach((b, i) => {
      out = out.split(b).join(`<batch-${String(i + 1)}>`);
    });
    if (MICROS.test(out) && BigInt(out) >= sinceUs && !SEEDED_LOT_INSTANTS.has(out)) out = `<t+${String((BigInt(out) - issueUs) / 60_000_000n)}m>`;
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return UUID.test(v) ? idOf(v) : text(v);
    if (Array.isArray(v)) return v.map(walk);
    // The record codec writes a bigint (an instant or a duration in microseconds) as {"$u": "<digits>"}.
    if (v && typeof v === 'object' && Object.keys(v).length === 1 && typeof (v as Json)['$u'] === 'string') return { $u: text(String((v as Json)['$u'])) };
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Json).map(([k, x]) => [text(k), k === 'expiry' && typeof x === 'string' && MONTH.test(x) ? '<expiry-month>' : walk(x)]));
    return v;
  };
  // Keys are walked in canonical (sorted) order so the first appearance of an id is the same on every run.
  return canonicalJson(walk(JSON.parse(canonicalJson(head))));
}

/** A stored value as text: its decimal or text value, or its list of values as JSON. */
const textOf = (v: Json): string => (typeof v['value'] === 'string' ? v['value'] : JSON.stringify(v['value'] ?? v['values'] ?? ''));

/** The outputs of batch `batchId` (`batchNumbers`: every batch of the scenario, in order; `sinceUs`: its start). */
export async function resultsOf(w: GoldenWorld, batchId: string, batchNumbers: readonly string[], sinceUs: bigint): Promise<BatchResults> {
  const state = await one<Json & { status: string; header: Json & { batchNumber: string; issuedAt: { $u: string } }; steps: Record<string, Json>; stages: Record<string, Json>; exceptions: Record<string, Json>; points: Record<string, Json>; derived: Record<string, Json>; entries: Record<string, Json> }>(
    w,
    'select state as r from recipe.execution_state where batch_id = $1',
    [batchId],
  );
  const steps = Object.fromEntries(Object.entries(state.steps).map(([k, s]): [string, string] => [k, String(s['status'])]).sort(([a], [b]) => a.localeCompare(b)));
  const stageState = (s: Json): string => (s['signOff'] ? 'SIGNED_OFF' : s['awaitingSignOff'] ? 'AWAITING_SIGN_OFF' : s['endedAt'] !== undefined ? 'ENDED' : 'IN_PROGRESS');
  const stages = Object.fromEntries(Object.entries(state.stages).map(([k, s]): [string, string] => [k, stageState(s)]).sort(([a], [b]) => a.localeCompare(b)));
  const containers = await one<Record<string, string>>(
    w,
    "select coalesce(jsonb_object_agg(c.stage || '/' || coalesce(c.stream, '-') || '/' || lpad(c.ordinal::text, 2, '0'), plant.container_state(c.id)), '{}'::jsonb) as r from (select o.*, row_number() over (partition by o.stage, o.stream order by o.opened_at, o.id) as ordinal from plant.output_container o where o.batch_id = $1) c",
    [batchId],
  );
  const exceptions = Object.values(state.exceptions)
    .sort((a, b) => Number(a['raisedSeq']) - Number(b['raisedSeq']))
    .map((e) => {
      const src = (e['source'] ?? {}) as Json;
      const disp = e['disposition'] as Json | undefined;
      return {
        type: String(e['type']),
        step: typeof src['stepKey'] === 'string' ? src['stepKey'] : null,
        tier: typeof e['tier'] === 'string' ? e['tier'] : null,
        severity: String(e['severity']),
        status: String(e['status']),
        disposition: disp ? String(disp['outcome']) : null,
        deviation: e['deviation'] !== undefined,
      };
    });
  const values: Record<string, string | string[]> = {};
  for (const p of Object.values(state.points)) {
    if (p['kind'] !== 'VALUE' || p['status'] !== 'VALID') continue;
    const item = String(p['item']);
    const v = p['value'] as Json | undefined;
    const text = v ? textOf(v) : '';
    const key = `${item}@${String(p['stepKey'])}`;
    values[key] = text;
  }
  for (const d of Object.values(state.derived)) {
    const v = d['value'] as Json | undefined;
    if (!v || d['status'] !== 'CURRENT') continue;
    values[`${String(d['calculation'])}@${String(d['stepKey'])}`] = textOf(v);
  }
  const calc = Object.values(state.entries).find((e) => e['kind'] === 'POTENCY_CALCULATION');
  const consumptions = await one<string[]>(
    w,
    "select coalesce(jsonb_agg(l.lot_code || ' ' || trim_scale(c.quantity)::text || ' ' || c.unit order by l.lot_code, c.consumed_at), '[]'::jsonb) as r from site.lot_consumption c join site.material_lot l on l.id = c.lot_id where c.batch_id = $1",
    [batchId],
  );
  const additions = await one<string[]>(
    w,
    "select coalesce(jsonb_agg(sb.batch_number || ' ' || o.stage || ' ' || trim_scale(a.net_quantity)::text || ' kg' order by a.id), '[]'::jsonb) as r from recipe.source_addition a join plant.output_container o on o.id = a.container_id join recipe.batch_execution sb on sb.id = o.batch_id where a.batch_id = $1",
    [batchId],
  );
  const closed = await one<string[]>(
    w,
    "select coalesce(jsonb_agg(o.stage || '/' || coalesce(o.stream, '-') || ' ' || coalesce(trim_scale(x.net_quantity)::text, 'open') order by o.stage, o.stream, o.opened_at), '[]'::jsonb) as r from plant.output_container o left join plant.container_close x on x.container_id = o.id where o.batch_id = $1",
    [batchId],
  );
  const signatures = await one<string>(
    w,
    "select count(*)::text as r from esig.signature s where s.aggregate_type in ('batch_issue', 'batch_step', 'batch_stage', 'batch_exception') and (s.aggregate_id = $1 or s.aggregate_id like $1 || ':%')",
    [batchId],
  );
  const issueUs = BigInt(state.header.issuedAt.$u);
  const normalised = normalise(state, issueUs, batchNumbers, sinceUs);
  return {
    batchNumber: state.header.batchNumber,
    states: { batch: state.status, stages, steps, containers },
    exceptions,
    values,
    dispensing: (calc?.['data'] as Json | undefined) ?? {},
    genealogy: { consumptions, additions, containers: closed },
    signatures: Number(signatures),
    trueCopy: { sha256: sha256Hex(normalised), normalised },
  };
}
