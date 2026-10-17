/**
 * The audit-trail methods in the runner (slice 6A-4; decision 0016 item 8; D-6A-12; draft control DI-53): ATA.RULES v1
 * reads report.audit_fact_v1, report.auth_fact_v1 and report.manual_digit_v1; ATA.BASELINE v1 reads the first two. Their
 * rows become the methods' input here, field by field; the pool keeps every time as the database's text (pool.ts), so
 * the methods read instants exactly and the site's wall clock from the views' own `*_local` text. No value of an audit
 * entry reaches this file: the views export none (DI-53), and the last digit of a manual entry is all the
 * terminal-digit test reads.
 *
 * The objects are written in the shape of MethodImplementation (implementation.ts) without importing it, so that
 * implementation.ts can list them in IMPLEMENTATIONS without an import cycle.
 */
import { ATA_BASELINE, ATA_RULES, type AuditInput } from '@ebmr/analytics';

type Row = Readonly<Record<string, unknown>>;

export const AUDIT_FACTS = { view: 'report.audit_fact_v1', version: 1, filter: null } as const;
export const AUTH_FACTS = { view: 'report.auth_fact_v1', version: 1, filter: null } as const;
export const MANUAL_DIGITS = { view: 'report.manual_digit_v1', version: 1, filter: null } as const;

class AuditRowError extends Error {}

const text = (r: Row, k: string): string => {
  const v = r[k];
  if (typeof v !== 'string' || v === '') throw new AuditRowError(`column ${k} is not text in an audit-trail input row`);
  return v;
};
const textOrNull = (r: Row, k: string): string | null => {
  const v = r[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new AuditRowError(`column ${k} is not text in an audit-trail input row`);
  return v;
};
const boolOrNull = (r: Row, k: string): boolean | null => {
  const v = r[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'boolean') throw new AuditRowError(`column ${k} is not a boolean in an audit-trail input row`);
  return v;
};
const intOrNull = (r: Row, k: string): number | null => {
  const v = r[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new AuditRowError(`column ${k} is not an integer in an audit-trail input row`);
  return v;
};

/** The methods' input from the rows of the audit-trail views (digits only when the method reads them). */
export function auditInput(rows: Readonly<Record<string, readonly Row[]>>): AuditInput {
  const events = (rows[AUDIT_FACTS.view] ?? []).map((r) => ({
    eventId: text(r, 'event_id'), chainKey: text(r, 'chain_key'), recordedAt: text(r, 'recorded_at'), recordedLocal: text(r, 'recorded_local'),
    claimedAt: textOrNull(r, 'claimed_at'), personId: text(r, 'person_id'), accountId: textOrNull(r, 'account_id') ?? '', role: textOrNull(r, 'role'),
    terminal: textOrNull(r, 'terminal'), action: text(r, 'action'), tableName: textOrNull(r, 'table_name'), field: textOrNull(r, 'field'),
    isCorrection: boolOrNull(r, 'is_correction') === true, reasonCode: textOrNull(r, 'reason_code'), batchId: textOrNull(r, 'batch_id'), step: textOrNull(r, 'step'),
    attempt: intOrNull(r, 'attempt'), failed: boolOrNull(r, 'failed'), deviationLinked: boolOrNull(r, 'deviation_linked') === true, configArea: textOrNull(r, 'config_area'),
  }));
  const auth = (rows[AUTH_FACTS.view] ?? []).map((r) => {
    const kind = text(r, 'kind');
    if (kind !== 'LOGIN' && kind !== 'FAILED' && kind !== 'LOCKOUT') throw new AuditRowError(`unknown authentication fact kind ${kind}`);
    return { ref: text(r, 'event_ref'), accountId: text(r, 'account_id'), personId: text(r, 'person_id'), terminal: textOrNull(r, 'terminal'), kind, at: text(r, 'at'), atLocal: text(r, 'at_local') } as const;
  });
  const digits = (rows[MANUAL_DIGITS.view] ?? []).map((r) => {
    const digit = intOrNull(r, 'terminal_digit');
    if (digit === null || digit < 0 || digit > 9) throw new AuditRowError('a manual entry\'s terminal digit is not 0 to 9');
    return { personId: text(r, 'person_id'), eventId: text(r, 'event_id'), chainKey: text(r, 'chain_key'), recordedLocal: text(r, 'recorded_local'), digit };
  });
  return { events, auth, digits };
}

/** ATA.RULES v1 in the runner. */
export const ATA_RULES_IMPLEMENTATION = {
  id: 'ATA.RULES',
  versions: [1],
  inputs: [AUDIT_FACTS, AUTH_FACTS, MANUAL_DIGITS],
  assemble: (rows: Readonly<Record<string, readonly Row[]>>): AuditInput => auditInput(rows),
  method: ATA_RULES,
  // The audit trail changes all day, not with a completed batch: the nightly run assesses it (D-6A-7-R3).
  onBatchComplete: false,
} as const;

/** ATA.BASELINE v1 in the runner. */
export const ATA_BASELINE_IMPLEMENTATION = {
  id: 'ATA.BASELINE',
  versions: [1],
  inputs: [AUDIT_FACTS, AUTH_FACTS],
  assemble: (rows: Readonly<Record<string, readonly Row[]>>): AuditInput => auditInput(rows),
  method: ATA_BASELINE,
  // The audit trail changes all day, not with a completed batch: the nightly run assesses it (D-6A-7-R3).
  onBatchComplete: false,
} as const;
