/**
 * The input of the audit-trail methods (slice 6A-4; decision 0016 item 8; draft control DI-53), as the runner assembles
 * it from report.audit_fact_v1, report.auth_fact_v1 and report.manual_digit_v1. No old or new value of an audit entry
 * reaches these methods: an entry says who did what, where and when, whether it was a correction, and (for a data
 * entry) its attempt and whether it failed. The terminal-digit rule reads only the last digit of each manual entry.
 *
 * Instants arrive as the database's text (PostgreSQL's output or ISO 8601); `instantMs` reads both exactly to the
 * millisecond, which is all a minutes threshold needs. The site's wall clock arrives as `YYYY-MM-DDTHH:MM:SS` text (the
 * view converts it in the site zone), so hours and weeks are the site's without a time-zone table in the method.
 */
import { AnalyticsInputError } from '../../errors.ts';

/** One audit event (report.audit_fact_v1). */
export interface AuditEvent {
  /** kernel.audit_event id, as decimal text. */
  readonly eventId: string;
  /** The audit chain it belongs to ('batch:<uuid>' for a batch record). */
  readonly chainKey: string;
  readonly recordedAt: string;
  /** The recorded instant on the site's wall clock, YYYY-MM-DDTHH:MM:SS. */
  readonly recordedLocal: string;
  /** The time the entry claims (a late entry's claimed time or a device's source time), or null. */
  readonly claimedAt: string | null;
  readonly personId: string;
  readonly accountId: string;
  readonly role: string | null;
  readonly terminal: string | null;
  readonly action: string;
  readonly tableName: string | null;
  /** The item a data entry records, or the changed columns of an update (names only). */
  readonly field: string | null;
  readonly isCorrection: boolean;
  readonly reasonCode: string | null;
  readonly batchId: string | null;
  readonly step: string | null;
  /** A data entry's attempt of its item in its step (1, 2, ...), or null. */
  readonly attempt: number | null;
  /** Whether a data entry failed its limits or expected answer, or null for another event. */
  readonly failed: boolean | null;
  /** Whether a deviation is linked to the event's batch. */
  readonly deviationLinked: boolean;
  /** The configuration area of the changed table, or null when it is no configuration table. */
  readonly configArea: string | null;
}

/** One authentication event (report.auth_fact_v1). */
export interface AuthEvent {
  /** A stable reference of the source row ('auth_event:<uuid>', 'authn_attempt:<id>', 'account_lock_event:<id>'). */
  readonly ref: string;
  readonly accountId: string;
  readonly personId: string;
  readonly terminal: string | null;
  readonly kind: 'LOGIN' | 'FAILED' | 'LOCKOUT';
  readonly at: string;
  /** The instant on the site's wall clock, YYYY-MM-DDTHH:MM:SS. */
  readonly atLocal: string;
}

/** The last digit of one manual entry (report.manual_digit_v1). */
export interface ManualDigit {
  readonly personId: string;
  readonly eventId: string;
  readonly chainKey: string;
  /** The recorded instant on the site's wall clock, YYYY-MM-DDTHH:MM:SS. */
  readonly recordedLocal: string;
  /** 0 to 9. */
  readonly digit: number;
}

export interface AuditInput {
  readonly events: readonly AuditEvent[];
  readonly auth: readonly AuthEvent[];
  readonly digits: readonly ManualDigit[];
}

const PG = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

const int = (s: string): number => {
  let n = 0;
  for (const c of s) n = n * 10 + (c.charCodeAt(0) - 48);
  return n;
};

/** Milliseconds since the epoch of an instant in PostgreSQL's text output or ISO 8601 (fraction cut to milliseconds). */
export function instantMs(text: string): number {
  const m = PG.exec(text);
  if (!m) throw new AnalyticsInputError(`not an instant: ${JSON.stringify(text)}`, text);
  const [, y, mo, d, h, mi, s, frac, zone] = m as unknown as [string, string, string, string, string, string, string, string | undefined, string];
  const ms = frac === undefined ? 0 : int(`${frac}00`.slice(0, 3));
  let offsetMin = 0;
  if (zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    offsetMin = sign * (int(digits.slice(0, 2)) * 60 + (digits.length > 2 ? int(digits.slice(2, 4)) : 0));
  }
  return Date.UTC(int(y), int(mo) - 1, int(d), int(h), int(mi), int(s), ms) - offsetMin * 60_000;
}

/** The hour (0 to 23) of a site wall-clock text. */
export function localHour(local: string): number {
  const m = LOCAL.exec(local);
  if (!m) throw new AnalyticsInputError(`not a site wall-clock time: ${JSON.stringify(local)}`, local);
  return int(m[4] as string);
}

/** The Monday (YYYY-MM-DD) of the ISO week of a site wall-clock text: the site week an event belongs to. */
export function siteWeek(local: string): string {
  const m = LOCAL.exec(local);
  if (!m) throw new AnalyticsInputError(`not a site wall-clock time: ${JSON.stringify(local)}`, local);
  const day = Date.UTC(int(m[1] as string), int(m[2] as string) - 1, int(m[3] as string));
  const weekday = (new Date(day).getUTCDay() + 6) % 7; // Monday 0 ... Sunday 6
  return new Date(day - weekday * 86_400_000).toISOString().slice(0, 10);
}

/** The site week `n` weeks after `week` (a Monday, YYYY-MM-DD). */
export function weekPlus(week: string, n: number): string {
  return new Date(Date.parse(`${week}T00:00:00Z`) + n * 7 * 86_400_000).toISOString().slice(0, 10);
}

/** Orders decimal-text ids numerically (shorter first, then by text). */
export function compareIds(a: string, b: string): number {
  return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;
}

/** The evidence reference of an audit event: its chain and id, as the audit-trail screens name it. */
export function eventRef(e: { chainKey: string; eventId: string }): string {
  return `${e.chainKey}#${e.eventId}`;
}

/** Ascending order of text (code points), for a deterministic output. */
export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
