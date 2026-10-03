/**
 * The audit trail read model (module C1; plan section 11; DI-22, DI-23): reads of the kernel's hash-chained audit trail
 * (kernel.audit_event, kernel.audit_chain_head) through the database's own read functions, for the session whose cookie
 * token the request presents (tablets 0420, review F35; DI-17, DI-50): the database serves only the chains that
 * session's role may read (RECORD-class chains with RECORD.READ; account, person, investigation and the other
 * governance chains only in a governance or audit role, never an investigation to the person it is about), a person
 * filter only on the session's own person or in a governance role, and refuses a chain it may not read
 * (EBMR-TAB-020). The application role has no SELECT on the audit tables; user IDs and terminal codes come from the
 * registry's own audit entries. Read-only: this module has no write path of any kind.
 *
 * Each entry says who (legal name as recorded, user ID, role), what (the business message, or the fields changed
 * with old and new values), when (site time with offset and zone, plus UTC microseconds), why (the reason given)
 * and how (the terminal; the command's correlation id groups a business entry with its field changes).
 *
 * What is shown is what the hash chain covers (review P7; DI-23, INV-08). An entry's chain position, action, table,
 * record, correlation and time come from its hashed payload, never from the indexed columns beside it (those only
 * find the rows; kernel.verify_chain names an entry whose columns differ from its payload). The user ID and the
 * terminal code are not in the entry's payload, only the account and terminal ids: they come from the hashed INSERT
 * entry of that account or terminal in its own chain (account:<id>, device:<id>; both values never change, kernel
 * EBMR-IAM-007 and the account guard), never from the live registry rows. verifyChainFor verifies those chains with
 * the viewed chain.
 */
import { sql, type Kysely } from 'kysely';
import type { AuditEventView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import type { ReadDatabase } from '../../platform/db/read.ts';

type AuditEventTable = {
  id: string;
  chain_key: string;
  seq: string;
  recorded_at: Date;
  correlation_id: string;
  action: 'INSERT' | 'UPDATE' | 'DELETE' | 'BUSINESS' | 'CHECKPOINT';
  table_name: string | null;
  record_id: string | null;
  payload: unknown;
};

/**
 * The head columns kernel.verify_chain checks against the chain (review P7). Its last_event pointer is deliberately left
 * out: verification never checks it, so nothing the viewer shows may be found through it.
 */
type AuditChainHeadTable = {
  chain_key: string;
  last_seq: string;
  last_hash: Buffer;
};

/** Only the audit trail itself: the live registry tables are deliberately not part of the viewer's database. */
export type AuditTables = {
  'kernel.audit_event': AuditEventTable;
  'kernel.audit_chain_head': AuditChainHeadTable;
};

export type AuditDb = Kysely<ReadDatabase & AuditTables>;

/** The typed read database of the audit viewer (app.readDb never owns the application pool). */
export const auditDb = (app: AppContext): AuditDb => app.readDb.withTables<AuditTables>();

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface EventFilter {
  chainKey?: string | undefined;
  correlationId?: string | undefined;
  personId?: string | undefined;
  fromUs?: string | undefined;
  toUs?: string | undefined;
  /** Keyset cursor: the last event id of the previous page. */
  afterId?: string | undefined;
  /** The settled horizon (horizon.ts): no entry beyond it, for lists across chains. */
  upToId?: string | undefined;
  limit: number;
}

interface EventRow {
  id: string;
  chain_key: string;
  seq: string;
  us: string;
  correlation_id: string | null;
  action: string;
  table_name: string | null;
  record_id: string | null;
  payload: unknown;
  /** The user ID as the account's own chain hashed it. */
  login_name: string | null;
  /** The terminal code as the terminal's own chain hashed it. */
  device_code: string | null;
}

/** Events in chronological order (id order), keyset-paged; one row more than the limit tells whether more exist. */
export async function readEvents(db: AuditDb, tokenHash: string, f: EventFilter): Promise<EventRow[]> {
  const { rows } = await sql<EventRow>`
    select * from tab.audit_events(${tokenHash}, ${f.chainKey ?? null}, ${f.correlationId ?? null}::uuid, ${f.personId ?? null}::uuid,
                                   ${f.fromUs ?? null}, ${f.toUs ?? null}, ${f.afterId ?? null}, ${f.upToId ?? null}, ${f.limit})`.execute(db);
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Rows to views

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
};

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Field changes of a row event: UPDATE old -> new (changed fields only), INSERT new, DELETE old, insert-only row hash. */
export function changesOf(action: string, body: Record<string, unknown>): AuditEventView['changes'] {
  const oldRow = obj(body['old']);
  const newRow = obj(body['new']);
  if (action === 'UPDATE') {
    const fields = [...new Set([...Object.keys(oldRow), ...Object.keys(newRow)])].sort();
    return fields.map((field) => ({ field, old: text(oldRow[field]), new: text(newRow[field]) }));
  }
  if (action === 'INSERT') {
    if ('row_hash' in body) return [{ field: 'row_hash', old: null, new: text(body['row_hash']) }];
    return Object.keys(newRow)
      .sort()
      .map((field) => ({ field, old: null, new: text(newRow[field]) }));
  }
  if (action === 'DELETE') {
    return Object.keys(oldRow)
      .sort()
      .map((field) => ({ field, old: text(oldRow[field]), new: null }));
  }
  return [];
}

function summaryOf(action: string, table: string | null, recordId: string | null, body: Record<string, unknown>, changes: AuditEventView['changes']): string {
  const what = `${table ?? 'record'}${recordId ? ` ${recordId}` : ''}`;
  switch (action) {
    case 'BUSINESS':
    case 'CHECKPOINT':
      return text(body['message']) ?? (action === 'CHECKPOINT' ? 'Chain checkpoint' : 'Business entry');
    case 'INSERT':
      return `Created ${what}`;
    case 'UPDATE':
      return `Changed ${changes.map((c) => c.field).join(', ') || 'nothing'} in ${what}`;
    case 'DELETE':
      return `Deleted ${what}`;
    default:
      return `${action} ${what}`;
  }
}

export function toView(r: EventRow, formatInstant: AppContext['formatInstant']): AuditEventView {
  const payload = obj(r.payload);
  const actor = obj(payload['actor']);
  const body = obj(payload['body']);
  const details = obj(body['details']);
  const personId = text(actor['person_id']);
  // The legal name as recorded in the hashed entry; never today's name from the person registry.
  const legalName = text(actor['legal_name']);
  const who =
    personId && personId !== NIL_UUID
      ? { personId, legalName: legalName && legalName !== '' ? legalName : '(unknown)', loginName: r.login_name ?? '(unknown)', role: text(actor['role_code']) ?? '' }
      : null;
  const reasonCode = text(payload['reason_code']);
  const reasonText = text(payload['reason_text']);
  const why = reasonCode && reasonText ? `${reasonCode}: ${reasonText}` : (reasonCode ?? reasonText);
  const changes = changesOf(r.action, body);
  const businessAction = text(details['action']) ?? text(details['event']);
  return {
    eventId: r.id,
    chainKey: r.chain_key,
    seq: r.seq,
    at: formatInstant(r.us),
    kind: r.action === 'BUSINESS' || r.action === 'CHECKPOINT' ? 'BUSINESS' : 'ROW',
    action: r.action === 'BUSINESS' && businessAction ? businessAction : r.action,
    summary: summaryOf(r.action, r.table_name, r.record_id, body, changes),
    table: r.table_name,
    recordId: r.record_id,
    who,
    device: r.device_code,
    why: why ?? null,
    correlationId: r.correlation_id ?? null,
    changes,
  };
}

// ---------------------------------------------------------------------------------------------
// Chains

const CHAIN_LABELS: Readonly<Record<string, string>> = {
  batch: 'Batch',
  mbr_version: 'Master record version',
  mbr_family: 'Master record family',
  esig_stub: 'Signable entry',
  esig_signature: 'Signature',
  esig_challenge: 'Signing request',
  person: 'Person',
  account: 'Account',
  device: 'Terminal',
  attribution_method: 'Attribution method',
};

export function chainLabel(chainKey: string): string {
  const i = chainKey.indexOf(':');
  const type = i < 0 ? chainKey : chainKey.slice(0, i);
  const id = i < 0 ? '' : chainKey.slice(i + 1);
  const name = CHAIN_LABELS[type] ?? type.replace(/_/g, ' ');
  return id ? `${name} ${id}` : name;
}

/**
 * The chains the session may read, newest activity first. What is shown of each (its entry count and the time of its last
 * entry) comes from the hashed payload of the chain's last entry (review P7). That entry is found only through what
 * kernel.verify_chain checks: the head's last_seq and last_hash, matched on the entry's chain key, position and hash. The
 * head's last_event pointer is never used, because verification does not cover it: a pointer moved to an earlier entry
 * would otherwise show a smaller count and an older time while "Verify chain" answers intact. When no entry matches the
 * head (verification then names the chain), the head's own count is shown with no time. The prefix is taken literally.
 */
export async function readChains(db: AuditDb, tokenHash: string, prefix: string | undefined, limit = 500): Promise<{ chain_key: string; last_seq: string; us: string | null }[]> {
  const { rows } = await sql<{ chain_key: string; last_seq: string; us: string | null }>`
    select chain_key, last_seq, us from tab.audit_chains(${tokenHash}, ${prefix ?? null}, ${limit})`.execute(db);
  return rows;
}

/**
 * The chains the session may list that have entries but no head row (a deleted head; review F06), with the number of
 * entries found, in byte order (tablets 0490). They are listed before the others: the head's absence is a tamper.
 */
export async function readHeadlessChains(db: AuditDb, tokenHash: string, prefix: string | undefined): Promise<{ chain_key: string; entries: string }[]> {
  const { rows } = await sql<{ chain_key: string; entries: string }>`
    select chain_key, entries::text as entries from tab.audit_headless_chains(${tokenHash}, ${prefix ?? null})`.execute(db);
  return rows;
}

/**
 * The verification of a chain the session may read (tablets 0530, review F34/F35): the kernel recomputes every hash of
 * the chain from its first entry, then of the registry chains its view draws on (the account and terminal of every actor
 * on it, whose hashed INSERT entries give the user IDs and terminal codes shown; tab.audit_registry_chains), each problem
 * naming its chain. The database decides for the session (EBMR-TAB-020 for a chain its role may not read; nothing for a
 * chain withheld from its person); the application role has no verification of its own (kernel.verify_chain is the
 * owner's).
 */
export async function verifyChainFor(db: AuditDb, tokenHash: string, chainKey: string): Promise<{ chainKey: string; registry: boolean; seq: string; problem: string }[]> {
  const { rows } = await sql<{ chain_key: string; registry: boolean; seq: string; problem: string }>`
    select chain_key, registry, seq::text as seq, problem from tab.audit_verify_chain(${tokenHash}, ${chainKey})`.execute(db);
  return rows.map((r) => ({ chainKey: r.chain_key, registry: r.registry, seq: r.seq, problem: r.problem }));
}

/**
 * The number of entries of a chain the session may read (its head's count, or the entries found when its head row is
 * missing: tablets 0490, F06); null only when the chain has neither a head nor an entry.
 */
export async function chainLength(db: AuditDb, tokenHash: string, chainKey: string): Promise<number | null> {
  const { rows } = await sql<{ n: string | null }>`select tab.audit_chain_length(${tokenHash}, ${chainKey})::text as n`.execute(db);
  const n = rows[0]?.n ?? null;
  return n === null ? null : Number(n);
}
