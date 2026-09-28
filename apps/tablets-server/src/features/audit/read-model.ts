/**
 * The audit trail read model (module C1; plan section 11; DI-22, DI-23): typed Kysely reads over the kernel's
 * hash-chained audit trail (kernel.audit_event, kernel.audit_chain_head), with the account and terminal registry
 * for user IDs and terminal codes. Read-only: the application role holds SELECT on these tables and nothing else,
 * and this module has no write path of any kind.
 *
 * Each entry says who (legal name as recorded, user ID, role), what (the business message, or the fields changed
 * with old and new values), when (site time with offset and zone, plus UTC microseconds), why (the reason given)
 * and how (the terminal; the command's correlation id groups a business entry with its field changes).
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

type AuditChainHeadTable = {
  chain_key: string;
  last_seq: string;
  last_hash: Buffer;
  last_event: string;
};

type AccountTable = {
  id: string;
  person_id: string;
  login_name: string;
};

type DeviceTable = {
  id: string;
  code: string;
};

type PersonTable = {
  id: string;
  legal_name: string;
};

export type AuditTables = {
  'kernel.audit_event': AuditEventTable;
  'kernel.audit_chain_head': AuditChainHeadTable;
  'iam.account': AccountTable;
  'iam.device': DeviceTable;
  'iam.person': PersonTable;
};

export type AuditDb = Kysely<ReadDatabase & AuditTables>;

/** The typed read database of the audit viewer (app.readDb never owns the application pool). */
export const auditDb = (app: AppContext): AuditDb => app.readDb.withTables<AuditTables>();

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** SQL for a UTC epoch-microseconds text parameter as a timestamptz (exact; no floating point). */
const fromMicros = (us: string) => sql<Date>`(timestamptz 'epoch' + (${us}::bigint * interval '1 microsecond'))`;

export interface EventFilter {
  chainKey?: string | undefined;
  correlationId?: string | undefined;
  personId?: string | undefined;
  fromUs?: string | undefined;
  toUs?: string | undefined;
  /** Keyset cursor: the last event id of the previous page. */
  afterId?: string | undefined;
  limit: number;
}

interface EventRow {
  id: string;
  chain_key: string;
  seq: string;
  us: string;
  correlation_id: string;
  action: string;
  table_name: string | null;
  record_id: string | null;
  payload: unknown;
  login_name: string | null;
  device_code: string | null;
  current_legal_name: string | null;
}

/** Events in chronological order (id order), keyset-paged; one row more than the limit tells whether more exist. */
export async function readEvents(db: AuditDb, f: EventFilter): Promise<EventRow[]> {
  let q = db
    .selectFrom('kernel.audit_event as e')
    .leftJoin('iam.account as a', (j) => j.on(sql<boolean>`a.id::text = e.payload -> 'actor' ->> 'account_id'`))
    .leftJoin('iam.device as d', (j) => j.on(sql<boolean>`d.id::text = e.payload -> 'actor' ->> 'device_id'`))
    .leftJoin('iam.person as p', (j) => j.on(sql<boolean>`p.id::text = e.payload -> 'actor' ->> 'person_id'`))
    .select([
      sql<string>`e.id::text`.as('id'),
      'e.chain_key',
      sql<string>`e.seq::text`.as('seq'),
      sql<string>`(extract(epoch from e.recorded_at) * 1000000)::bigint::text`.as('us'),
      sql<string>`e.correlation_id::text`.as('correlation_id'),
      'e.action',
      'e.table_name',
      'e.record_id',
      'e.payload',
      'a.login_name as login_name',
      'd.code as device_code',
      'p.legal_name as current_legal_name',
    ]);
  if (f.chainKey !== undefined) q = q.where('e.chain_key', '=', f.chainKey);
  if (f.correlationId !== undefined) q = q.where(sql<boolean>`e.correlation_id = ${f.correlationId}::uuid`);
  if (f.personId !== undefined) q = q.where(sql<boolean>`e.payload -> 'actor' ->> 'person_id' = ${f.personId}`);
  if (f.fromUs !== undefined) q = q.where(sql<boolean>`e.recorded_at >= ${fromMicros(f.fromUs)}`);
  if (f.toUs !== undefined) q = q.where(sql<boolean>`e.recorded_at <= ${fromMicros(f.toUs)}`);
  if (f.afterId !== undefined) q = q.where(sql<boolean>`e.id > ${f.afterId}::bigint`);
  const rows = await q.orderBy('e.id', 'asc').limit(f.limit + 1).execute();
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
  const legalName = text(actor['legal_name']) ?? r.current_legal_name;
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
    correlationId: r.correlation_id,
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

export async function readChains(db: AuditDb, prefix: string | undefined, limit = 500): Promise<{ chain_key: string; last_seq: string; us: string | null }[]> {
  let q = db
    .selectFrom('kernel.audit_chain_head as h')
    .leftJoin('kernel.audit_event as e', (j) => j.on(sql<boolean>`e.id = h.last_event`))
    .select(['h.chain_key', sql<string>`h.last_seq::text`.as('last_seq'), sql<string | null>`(extract(epoch from e.recorded_at) * 1000000)::bigint::text`.as('us')]);
  if (prefix !== undefined && prefix !== '') {
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    q = q.where(sql<boolean>`h.chain_key like ${`${escaped}%`} escape '\\'`);
  }
  const rows = await q.orderBy(sql`e.id desc nulls last`).limit(limit).execute();
  return rows;
}

export async function chainLength(db: AuditDb, chainKey: string): Promise<number | null> {
  const row = await db.selectFrom('kernel.audit_chain_head').select(sql<string>`last_seq::text`.as('n')).where('chain_key', '=', chainKey).executeTakeFirst();
  return row ? Number(row.n) : null;
}
