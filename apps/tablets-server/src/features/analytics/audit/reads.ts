/**
 * The reads of the audit-trail flags (Phase 6A slice 6A-4; contract ns/analytics-audit.ts; kernel 1261, recipe-core
 * 1151; draft control DI-53). Every read goes through a definer that refuses administrators and needs
 * ANALYTICS.DI_REVIEW (analytics.audit_flags, audit_flag_entries, audit_flagged_entries, person_flags,
 * person_flag_dispositions): the application role reads no flag about a person and no audit fact behind one any other
 * way. A flag's key is its method, rule, subject and the first evidence of its first reason (D-6A-4-5); the lists show
 * the latest flag of each key with the key's current disposition.
 */
import type pg from 'pg';
import type { AuditFlagEntryView, AuditFlagRepeat, AuditFlaggedEntryView, FlagView } from '@ebmr/api-contract';
import type { AppContext } from '../../../platform/context.ts';
import { usOf } from '../../common/people.ts';
import type { FlagRow } from '../reads.ts';

type Db = Pick<pg.Pool | pg.PoolClient, 'query'>;

/** A key of analytics.audit_flags: its latest flag, how often it was raised and its current disposition's flag. */
export interface KeyRow extends FlagRow {
  flag_key: string;
  raised_count: number;
  first_us: string;
  disposition_flag: string | null;
  verdict: string | null;
}

/** The key of a flag, as analytics.flag_key computes it (kernel 1261). */
export function flagKey(f: { method: string; rule: string; subject_kind: string; subject_ref: string; reasons: FlagView['reasons'] }): string {
  const e = f.reasons[0]?.evidence?.[0];
  return `${f.method}|${f.rule}|${f.subject_kind}|${f.subject_ref}|${e?.kind ?? ''}:${e?.ref ?? ''}`;
}

/**
 * The keys whose latest flag was raised in [from, to) (site-zone days; open-ended without them); with `openOnly` the
 * keys without a current disposition, and with `key` that key only: both chosen before the list's limit, so an open
 * key is never pushed out by closed ones and a flag's own key is always found.
 */
export async function auditKeys(db: Db, q: { from: string | null; to: string | null; zone: string; openOnly?: boolean; key?: string }): Promise<KeyRow[]> {
  const { rows } = await db.query<KeyRow>(
    `select f.flag_id::text, f.run_id::text, f.method, f.version, f.subject_kind, f.subject_ref, f.rule, f.severity, f.reasons,
            ${usOf('f.raised_at')} as raised_us, ${usOf('r.data_as_of')} as asof_us, ${usOf('r.ended_at')} as finished_us, true as restricted,
            f.flag_key, f.raised_count, ${usOf('f.first_raised_at')} as first_us, f.disposition_flag::text, f.verdict
       from analytics.audit_flags(coalesce($1::date::timestamp at time zone $3, '-infinity'::timestamptz),
                                  coalesce(($2::date + 1)::timestamp at time zone $3, 'infinity'::timestamptz)) f
       join analytics.run_v1 r on r.run_id = f.run_id and r.status = 'DONE'
      where (not $4::boolean or f.disposition_flag is null) and ($5::text is null or f.flag_key = $5)
      order by f.raised_at desc, f.flag_id
      limit 500`,
    [q.from, q.to, q.zone, q.openOnly === true, q.key ?? null],
  );
  return rows;
}

export function repeatOf(app: AppContext, k: KeyRow): AuditFlagRepeat {
  return { flagId: k.flag_id, raisedCount: k.raised_count, firstRaisedAt: app.formatInstant(k.first_us) };
}

interface EntryRow {
  event_id: string; chain_key: string; recorded_us: string; claimed_us: string | null; action: string; command_type: string | null; table_name: string | null;
  field: string | null; is_correction: boolean; reason_code: string | null; terminal: string | null;
}

/** The audit entries a restricted flag names (analytics.audit_flag_entries; no old or new values). */
export async function flagEntries(app: AppContext, db: Db, flagId: string): Promise<AuditFlagEntryView[]> {
  const { rows } = await db.query<EntryRow>(
    `select e.event_id, e.chain_key, ${usOf('e.recorded_at')} as recorded_us, case when e.claimed_at is null then null else ${usOf('e.claimed_at')} end as claimed_us,
            e.action, e.command_type, e.table_name, e.field, e.is_correction, e.reason_code, e.terminal
       from analytics.audit_flag_entries($1) e`,
    [flagId],
  );
  return rows.map((e) => ({
    eventId: e.event_id,
    chainKey: e.chain_key,
    recordedAt: app.formatInstant(e.recorded_us),
    claimedAt: e.claimed_us === null ? null : app.formatInstant(e.claimed_us),
    // An execution command is shown by its type (the audit action of its row is always an insert).
    action: e.command_type ?? e.action,
    tableName: e.table_name,
    field: e.field,
    isCorrection: e.is_correction,
    reasonCode: e.reason_code,
    terminal: e.terminal,
    drill: `/audit?chain=${encodeURIComponent(e.chain_key)}`,
  }));
}

/** The entries of a batch's review scope that the keys name (analytics.audit_flagged_entries), grouped by entry. */
export async function flaggedEntries(db: Db, batchId: string): Promise<AuditFlaggedEntryView[]> {
  const { rows } = await db.query<{ chain_key: string; event_id: string; flag_id: string; rule: string; severity: FlagView['severity']; verdict: 'TRUE_SIGNAL' | 'FALSE_ALARM' | 'NOT_ASSESSABLE' | null }>(
    'select chain_key, event_id, flag_id::text, rule, severity, verdict from analytics.audit_flagged_entries($1)',
    [batchId],
  );
  const out = new Map<string, AuditFlaggedEntryView>();
  for (const r of rows) {
    const k = `${r.chain_key}#${r.event_id}`;
    const e = out.get(k) ?? { eventId: r.event_id, chainKey: r.chain_key, flags: [] };
    e.flags.push({ flagId: r.flag_id, rule: r.rule, severity: r.severity, verdict: r.verdict });
    out.set(k, e);
  }
  return [...out.values()];
}
