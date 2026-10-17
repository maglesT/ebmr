/**
 * The analytics feature's reads (Phase 6A slice 6A-1; contract ns/analytics.ts; kernel 1243, 1245; ADR 0020 point 4).
 * The application role reads only the analytics.*_v1 views and, for flags about a person or an account, the definer
 * functions that check ANALYTICS.DI_REVIEW (analytics.person_flags, analytics.person_flag_dispositions; DI-53). Every
 * statistic is the database's double precision as a JSON number (StatNumber); every instant is the database's.
 */
import type pg from 'pg';
import {
  AnalyticsMethodId,
  type AnalyticsCatalogView,
  type AnalyticsMonitorView,
  type DispositionView,
  type FlagView,
  type MethodVersionView,
  type ReferenceSetView,
} from '@ebmr/api-contract';
import { catalogMethods } from '../../analytics/catalog.ts';
import type { AppContext } from '../../platform/context.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool | pg.PoolClient, 'query'>;
type MethodId = AnalyticsMethodId;

const isMethod = (m: string): m is MethodId => AnalyticsMethodId.safeParse(m).success;

/** The advisory envelope of a response that spans several methods and runs (D-6A-0-6). */
export function envelope(dataAgeSeconds = 0): { advisory: true; notForGmpDecisions: true; method: null; run: null; dataAgeSeconds: number } {
  return { advisory: true, notForGmpDecisions: true, method: null, run: null, dataAgeSeconds };
}

// ---------------------------------------------------------------------------------------------
// Catalogue, methods, monitor
// ---------------------------------------------------------------------------------------------

export async function catalog(db: Db): Promise<AnalyticsCatalogView> {
  const { rows: effective } = await db.query<{ method: string; versions: number[] }>(
    `select method, array_agg(distinct version order by version) as versions from analytics.method_version_v1
      where status = 'EFFECTIVE' and valid_from <= statement_timestamp() and (valid_to is null or valid_to > statement_timestamp())
      group by method`,
  );
  const inForce = new Map(effective.map((e) => [e.method, e.versions]));
  const { rows: inputs } = await db.query<{ name: string; kind: 'VIEW' | 'FUNCTION'; version: number; owner_slice: string; grain: string }>(
    'select name, kind, version, owner_slice, grain from analytics.input_catalog_v1 order by name',
  );
  return {
    ...envelope(),
    methods: catalogMethods().map((m) => ({ ...m, effectiveVersions: inForce.get(m.id) ?? [] })),
    inputs: inputs.map((i) => ({ name: i.name, kind: i.kind, version: i.version, ownerSlice: i.owner_slice, grain: i.grain })),
  };
}

interface VersionRow {
  method: string; version: number; status: 'EFFECTIVE' | 'RETIRED'; title: string; intended_use: string; acceptance: Record<string, unknown>; parameters_sha256: string;
  code_identity: string; validation_ref: string; from_us: string; to_us: string | null; change_record: string | null;
}

export async function methodVersions(app: AppContext, db: Db, filter: { method?: string; version?: number; rowId?: string } = {}): Promise<MethodVersionView[]> {
  const { rows } = await db.query<VersionRow>(
    `select method, version, status, title, intended_use, acceptance, parameters_sha256, code_identity, validation_ref, ${usOf('valid_from')} as from_us,
            case when valid_to is null then null else ${usOf('valid_to')} end as to_us, change_record
       from analytics.method_version_v1
      where ($1::text is null or method = $1) and ($2::integer is null or version = $2) and ($3::uuid is null or row_id = $3)
      order by method, version, valid_from, recorded_at`,
    [filter.method ?? null, filter.version ?? null, filter.rowId ?? null],
  );
  return rows.filter((r) => isMethod(r.method)).map((r) => ({
    method: r.method as MethodId, version: r.version, status: r.status, title: r.title, intendedUse: r.intended_use, acceptance: r.acceptance,
    parametersSha256: r.parameters_sha256, codeIdentity: r.code_identity, validationRef: r.validation_ref, validFrom: app.formatInstant(r.from_us),
    validTo: r.to_us === null ? null : app.formatInstant(r.to_us), changeRecord: r.change_record,
  }));
}

export async function referenceSets(app: AppContext, db: Db, id: string): Promise<ReferenceSetView[]> {
  const { rows } = await db.query<{ method: string; scope: Record<string, unknown>; batch_ids: string[]; candidate_output: string; model_sha256: string; status: 'EFFECTIVE' | 'RETIRED';
                                    from_us: string; to_us: string | null; change_record: string | null }>(
    `select method, scope, batch_ids::text[] as batch_ids, candidate_output::text, model_sha256, status, ${usOf('valid_from')} as from_us,
            case when valid_to is null then null else ${usOf('valid_to')} end as to_us, change_record
       from analytics.reference_set_v1 where reference_set_id = $1 order by valid_from, recorded_at`,
    [id],
  );
  return rows.filter((r) => isMethod(r.method)).map((r) => ({
    referenceSetId: id, method: r.method as MethodId, scope: r.scope, batchIds: r.batch_ids, candidateOutput: r.candidate_output, modelSha256: r.model_sha256, status: r.status,
    validFrom: app.formatInstant(r.from_us), validTo: r.to_us === null ? null : app.formatInstant(r.to_us), changeRecord: r.change_record,
  }));
}

export async function monitor(db: Db): Promise<AnalyticsMonitorView> {
  const { rows } = await db.query<{ method: string; version: number; month: string; runs: number; failures: number; flags: number; dispositioned_share: number | null; false_alarm_rate: number | null }>(
    "select method, version, to_char(month, 'YYYY-MM') as month, runs, failures, flags, dispositioned_share, false_alarm_rate from analytics.method_monitor_v1 order by method, version, month",
  );
  return {
    ...envelope(),
    rows: rows.filter((r) => isMethod(r.method)).map((r) => ({
      method: r.method as MethodId, version: r.version, month: r.month, runs: r.runs, failures: r.failures, flags: r.flags,
      dispositionedShare: r.dispositioned_share, falseAlarmRate: r.false_alarm_rate,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------

/** A flag row as the views and analytics.person_flags give it, with its run's times. */
export interface FlagRow {
  flag_id: string; run_id: string; method: string; version: number; subject_kind: FlagView['subjectKind']; subject_ref: string; rule: string;
  severity: FlagView['severity']; reasons: FlagView['reasons']; raised_us: string; asof_us: string; finished_us: string; restricted: boolean;
  /** The open-flags list only (kernel 1271, D-6A-3-9): the raises of the same hit and the first one's time. */
  raised_count?: number; first_us?: string;
}

interface DispositionRow {
  disposition_id: string; flag_id: string; verdict: DispositionView['verdict']; cause: string; deviation_ref: string | null; supersedes: string | null;
  reason: string | null; person_id: string; recorded_us: string; current: boolean;
}

const FLAG_COLUMNS = `f.flag_id::text, f.run_id::text, f.method, f.version, f.subject_kind, f.subject_ref, f.rule, f.severity, f.reasons,
  ${usOf('f.raised_at')} as raised_us, ${usOf('f.data_as_of')} as asof_us, ${usOf('f.finished_at')} as finished_us`;

/** Unrestricted flags: the open ones, or every one raised in the period [from, to) (site-zone days). */
export async function unrestrictedFlags(db: Db, q: { from: string | null; to: string | null; kind: string | null; zone: string; flagId?: string }): Promise<FlagRow[]> {
  const open = q.from === null && q.to === null && q.flagId === undefined;
  const { rows } = await db.query<FlagRow>(
    `select ${FLAG_COLUMNS}, false as restricted${open ? `, f.raised_count, ${usOf('f.first_raised_at')} as first_us` : ''}
       from ${open ? 'analytics.open_flag_v1' : 'analytics.flag_v1'} f
      where ($1::text is null or f.subject_kind = $1)
        and ($2::date is null or f.raised_at >= ($2::date::timestamp at time zone $4))
        and ($3::date is null or f.raised_at < (($3::date + 1)::timestamp at time zone $4))
        and ($5::uuid is null or f.flag_id = $5)
      order by f.raised_at desc, f.flag_id
      limit 500`,
    [q.kind, q.from, q.to, q.zone, q.flagId ?? null],
  );
  return rows;
}

/** Restricted flags (about a person or an account) of the period, through analytics.person_flags (ANALYTICS.DI_REVIEW). */
export async function restrictedFlags(c: Db, q: { from: string | null; to: string | null; kind: string | null; zone: string; flagId?: string }): Promise<FlagRow[]> {
  const { rows } = await c.query<FlagRow>(
    `select f.id::text as flag_id, f.run::text as run_id, r.method, r.version, f.subject_kind, f.subject_ref, f.rule, f.severity, f.reasons,
            ${usOf('f.raised_at')} as raised_us, ${usOf('r.data_as_of')} as asof_us, ${usOf('r.ended_at')} as finished_us, true as restricted
       from analytics.person_flags(coalesce($2::date::timestamp at time zone $4, '-infinity'::timestamptz),
                                   coalesce(($3::date + 1)::timestamp at time zone $4, 'infinity'::timestamptz)) f
       join analytics.run_v1 r on r.run_id = f.run and r.status = 'DONE'
      where ($1::text is null or f.subject_kind = $1) and ($5::uuid is null or f.id = $5)
      order by f.raised_at desc, f.id
      limit 500`,
    [q.kind, q.from, q.to, q.zone, q.flagId ?? null],
  );
  return rows;
}

/**
 * The dispositions covering flags: those of each flag's group, the same hit raised by other runs included (kernel 1280,
 * D-6A-7-R1), as one query for unrestricted flags or one restricted flag at a time (ANALYTICS.DI_REVIEW). Each row is
 * given under the flag asked about, whichever raise it was recorded on.
 */
export async function dispositionsOf(db: Db, flags: readonly FlagRow[]): Promise<DispositionRow[]> {
  const open = flags.filter((f) => !f.restricted).map((f) => f.flag_id);
  const out: DispositionRow[] = [];
  if (open.length > 0) {
    const { rows } = await db.query<DispositionRow>(
      `select disposition_id::text, flag_id::text, verdict, cause, deviation_ref, supersedes::text, reason, person_id::text, ${usOf('recorded_at')} as recorded_us, current
         from analytics.flag_group_disposition_v1 where flag_id = any($1::uuid[]) order by recorded_at, disposition_id`,
      [open],
    );
    out.push(...rows);
  }
  for (const f of flags.filter((x) => x.restricted)) {
    const { rows } = await db.query<DispositionRow>(
      `select d.id::text as disposition_id, $1::uuid::text as flag_id, d.verdict, d.cause, d.deviation_ref, d.supersedes::text, d.reason, d.person_id::text,
              ${usOf('d.recorded_at')} as recorded_us, not exists (select 1 from analytics.person_flag_dispositions($1) s where s.supersedes = d.id) as current
         from analytics.person_flag_dispositions($1) d order by d.recorded_at, d.id`,
      [f.flag_id],
    );
    out.push(...rows);
  }
  return out;
}

/** FlagViews of flag rows, with the subjects' labels, the current dispositions and the oldest data age shown. */
export async function flagViews(app: AppContext, db: Db, rows: readonly FlagRow[], dispositions: readonly DispositionRow[]): Promise<{ flags: FlagView[]; dataAgeSeconds: number }> {
  const batchIds = rows.filter((r) => r.subject_kind === 'BATCH' && /^[0-9a-f-]{36}$/.test(r.subject_ref)).map((r) => r.subject_ref);
  const { rows: numbers } = batchIds.length === 0 ? { rows: [] } : await db.query<{ id: string; n: string }>('select id::text, batch_number as n from recipe.batch_execution where id = any($1::uuid[])', [batchIds]);
  const batchNumber = new Map(numbers.map((n) => [n.id, n.n]));
  const personIds = [...rows.filter((r) => r.subject_kind === 'PERSON').map((r) => r.subject_ref), ...dispositions.map((d) => d.person_id)].filter((x) => /^[0-9a-f-]{36}$/.test(x));
  const people = await peopleOf(db, personIds);
  const views = dispositionViews(app, dispositions, people);
  const { rows: age } = await db.query<{ age: number }>(
    'select coalesce(greatest(floor(extract(epoch from statement_timestamp() - to_timestamp(min($1::numeric) / 1000000))), 0), 0)::integer as age',
    [rows.length === 0 ? null : rows.map((r) => BigInt(r.asof_us)).reduce((a, b) => (a < b ? a : b)).toString()],
  );
  const flags: FlagView[] = rows.filter((r) => isMethod(r.method)).map((r) => {
    const label = r.subject_kind === 'BATCH' ? batchNumber.get(r.subject_ref) : r.subject_kind === 'PERSON' ? people.get(r.subject_ref)?.legalName : undefined;
    return {
      flagId: r.flag_id,
      method: { id: r.method as MethodId, version: r.version },
      run: { id: r.run_id, dataAsOf: app.formatInstant(r.asof_us), finishedAt: app.formatInstant(r.finished_us) },
      subjectKind: r.subject_kind,
      subjectRef: r.subject_ref,
      subjectLabel: label ?? r.subject_ref,
      rule: r.rule,
      severity: r.severity,
      reasons: r.reasons,
      raisedAt: app.formatInstant(r.raised_us),
      restricted: r.restricted,
      disposition: views.find((d) => d.flagId === r.flag_id && d.current) ?? null,
      drill: r.subject_kind === 'BATCH' && batchNumber.has(r.subject_ref) ? `/review/${r.subject_ref}` : null,
      ...(r.raised_count !== undefined && r.first_us !== undefined ? { raisedCount: r.raised_count, firstRaisedAt: app.formatInstant(r.first_us) } : {}),
    };
  });
  return { flags, dataAgeSeconds: age[0]?.age ?? 0 };
}

export function dispositionViews(app: AppContext, rows: readonly DispositionRow[], people: Map<string, { legalName: string; loginName: string }>): DispositionView[] {
  return rows.map((d) => ({
    dispositionId: d.disposition_id, flagId: d.flag_id, verdict: d.verdict, cause: d.cause, deviationRef: d.deviation_ref, supersedes: d.supersedes, reason: d.reason,
    person: personRef(people, d.person_id, ''), recordedAt: app.formatInstant(d.recorded_us), current: d.current,
  }));
}
