/**
 * The audit trail read model (module C1; plan section 11; DI-22, DI-23): typed Kysely reads over the kernel's
 * hash-chained audit trail (kernel.audit_event, kernel.audit_chain_head); user IDs and terminal codes come from the
 * registry's own audit entries. Read-only: the application role holds SELECT on these tables and nothing else, and
 * this module has no write path of any kind.
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
 * EBMR-IAM-007 and the account guard), never from the live registry rows. registryChainsOf names those chains so a
 * verification of the viewed chain verifies them too.
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

/**
 * A registry value as its own chain hashed it: `field` of the new row in the audited INSERT of `table` whose record
 * is the actor's `idMember` (account_id or device_id), on chain `<prefix>:<id>`. Matched on the hashed payload only.
 */
const hashedRegistryValue = (prefix: 'account' | 'device', table: 'iam.account' | 'iam.device', idMember: 'account_id' | 'device_id', field: 'login_name' | 'code') =>
  sql<string | null>`(select x.payload -> 'body' -> 'new' ->> ${field}
      from kernel.audit_event x
     where x.chain_key = ${`${prefix}:`} || (e.payload -> 'actor' ->> ${idMember})
       and x.payload ->> 'action' = 'INSERT' and x.payload ->> 'table' = ${table}
       and x.payload ->> 'record_id' = e.payload -> 'actor' ->> ${idMember}
     order by x.seq limit 1)`;

/** The hashed recorded_at as epoch microseconds (the column only if the payload's value is not a time at all). */
const hashedMicros = sql<string>`(extract(epoch from case when pg_input_is_valid(e.payload ->> 'recorded_at', 'timestamptz')
      then (e.payload ->> 'recorded_at')::timestamptz else e.recorded_at end) * 1000000)::bigint::text`;

/** Events in chronological order (id order), keyset-paged; one row more than the limit tells whether more exist. */
export async function readEvents(db: AuditDb, f: EventFilter): Promise<EventRow[]> {
  let q = db
    .selectFrom('kernel.audit_event as e')
    .select([
      sql<string>`e.id::text`.as('id'),
      sql<string>`coalesce(e.payload ->> 'chain_key', '')`.as('chain_key'),
      sql<string>`coalesce(e.payload ->> 'seq', '')`.as('seq'),
      hashedMicros.as('us'),
      sql<string | null>`e.payload ->> 'correlation_id'`.as('correlation_id'),
      sql<string>`coalesce(e.payload ->> 'action', '')`.as('action'),
      sql<string | null>`e.payload ->> 'table'`.as('table_name'),
      sql<string | null>`e.payload ->> 'record_id'`.as('record_id'),
      'e.payload',
      hashedRegistryValue('account', 'iam.account', 'account_id', 'login_name').as('login_name'),
      hashedRegistryValue('device', 'iam.device', 'device_id', 'code').as('device_code'),
    ]);
  if (f.chainKey !== undefined) q = q.where('e.chain_key', '=', f.chainKey);
  if (f.correlationId !== undefined) q = q.where(sql<boolean>`e.correlation_id = ${f.correlationId}::uuid`);
  if (f.personId !== undefined) q = q.where(sql<boolean>`e.payload -> 'actor' ->> 'person_id' = ${f.personId}`);
  if (f.fromUs !== undefined) q = q.where(sql<boolean>`e.recorded_at >= ${fromMicros(f.fromUs)}`);
  if (f.toUs !== undefined) q = q.where(sql<boolean>`e.recorded_at <= ${fromMicros(f.toUs)}`);
  if (f.afterId !== undefined) q = q.where(sql<boolean>`e.id > ${f.afterId}::bigint`);
  if (f.upToId !== undefined) q = q.where(sql<boolean>`e.id <= ${f.upToId}::bigint`);
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
 * The chains, newest activity first. What is shown of each (its entry count and the time of its last entry) comes from
 * the hashed payload of the chain's last entry (review P7). That entry is found only through what kernel.verify_chain
 * checks: the head's last_seq and last_hash, matched on the entry's chain key, position and hash. The head's
 * last_event pointer is never used, because verification does not cover it: a pointer moved to an earlier entry would
 * otherwise show a smaller count and an older time while "Verify chain" answers intact. When no entry matches the head
 * (verification then names the chain), the head's own count is shown with no time.
 */
export async function readChains(db: AuditDb, prefix: string | undefined, limit = 500): Promise<{ chain_key: string; last_seq: string; us: string | null }[]> {
  let q = db
    .selectFrom('kernel.audit_chain_head as h')
    .leftJoin('kernel.audit_event as e', (j) =>
      j.on(sql<boolean>`e.chain_key = h.chain_key and e.seq = h.last_seq and e.hash = h.last_hash and e.payload ->> 'chain_key' = h.chain_key`),
    )
    .select([
      'h.chain_key',
      sql<string>`coalesce(e.payload ->> 'seq', h.last_seq::text)`.as('last_seq'),
      sql<string | null>`case when e.id is null then null else ${hashedMicros} end`.as('us'),
    ]);
  if (prefix !== undefined && prefix !== '') {
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    q = q.where(sql<boolean>`h.chain_key like ${`${escaped}%`} escape '\\'`);
  }
  const rows = await q.orderBy(sql`e.id desc nulls last`).limit(limit).execute();
  return rows;
}

/**
 * The registry chains the view of a chain draws on: the account and terminal of every actor on it (their hashed INSERT
 * entries give the user IDs and terminal codes shown), in byte order. The installation pipeline's nil ids have none.
 */
export async function registryChainsOf(db: AuditDb, chainKey: string): Promise<string[]> {
  const { rows } = await sql<{ chain_key: string }>`
    select k.chain_key
      from kernel.audit_event e
     cross join lateral (values ('account:' || (e.payload -> 'actor' ->> 'account_id')), ('device:' || (e.payload -> 'actor' ->> 'device_id'))) k (chain_key)
     where e.chain_key = ${chainKey} and k.chain_key is not null and k.chain_key not like ${`%:${NIL_UUID}`}
     group by k.chain_key
     order by k.chain_key collate "C"`.execute(db);
  return rows.map((r) => r.chain_key);
}

export async function chainLength(db: AuditDb, chainKey: string): Promise<number | null> {
  const row = await db.selectFrom('kernel.audit_chain_head').select(sql<string>`last_seq::text`.as('n')).where('chain_key', '=', chainKey).executeTakeFirst();
  return row ? Number(row.n) : null;
}
