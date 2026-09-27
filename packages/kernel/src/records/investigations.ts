/**
 * DI-50 data-integrity investigations: scoping from the audit trail, holds on everything in scope,
 * disposition block on linked batches, and a closure approved by someone other than the investigator.
 * Wrappers over migration 0430; call inside withCommand.
 */
import type pg from 'pg';

type Db = pg.Pool | pg.PoolClient;

export interface ScopeEntry {
  chainKey: string;
  aggregateType: string;
  aggregateId: string;
  tableName: string;
  recordId: string;
  actions: string[];
  eventCount: number;
  firstRecordedAt: Date;
  lastRecordedAt: Date;
}

export interface OpenInvestigation {
  subjectPersonId: string;
  windowFrom: Date;
  windowTo: Date;
  concern: string;
  investigatorPersonId?: string;
  qmsReference?: string;
  links?: { aggregateType: string; aggregateId: string; note?: string }[];
}

type ScopeRow = {
  chain_key: string;
  aggregate_type: string;
  aggregate_id: string;
  table_name: string;
  record_id: string;
  actions: string[];
  event_count: string;
  first_recorded_at: Date;
  last_recorded_at: Date;
};

const toScope = (r: ScopeRow): ScopeEntry => ({
  chainKey: r.chain_key,
  aggregateType: r.aggregate_type,
  aggregateId: r.aggregate_id,
  tableName: r.table_name,
  recordId: r.record_id,
  actions: r.actions,
  eventCount: Number(r.event_count),
  firstRecordedAt: r.first_recorded_at,
  lastRecordedAt: r.last_recorded_at,
});

export async function openDiInvestigation(db: Db, input: OpenInvestigation): Promise<string> {
  const { rows } = await db.query<{ id: string }>('select records.open_di_investigation($1, $2, $3, $4, $5, $6, $7::jsonb) as id', [
    input.subjectPersonId,
    input.windowFrom,
    input.windowTo,
    input.concern,
    input.investigatorPersonId ?? null,
    input.qmsReference ?? null,
    JSON.stringify(input.links ?? []),
  ]);
  return rows[0]?.id ?? '';
}

/** Every record the investigated person created or changed inside the window. */
export async function investigationScope(db: Db, investigationId: string): Promise<ScopeEntry[]> {
  const { rows } = await db.query<ScopeRow>('select * from records.investigation_scope($1)', [investigationId]);
  return rows.map(toScope);
}

/** Scoping report for any person and period, e.g. before deciding to open an investigation. */
export async function personActivity(db: Db, personId: string, from: Date, to: Date): Promise<ScopeEntry[]> {
  const { rows } = await db.query<ScopeRow>('select * from records.person_activity($1, $2, $3)', [personId, from, to]);
  return rows.map(toScope);
}

export async function linkDiInvestigation(db: Db, investigationId: string, aggregateType: string, aggregateId: string, note: string): Promise<void> {
  await db.query('select records.link_di_investigation($1, $2, $3, $4)', [investigationId, aggregateType, aggregateId, note]);
}

export async function refreshDiInvestigationScope(db: Db, investigationId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>('select records.refresh_di_investigation_scope($1) as n', [investigationId]);
  return rows[0]?.n ?? 0;
}

export async function closeDiInvestigation(
  db: Db,
  investigationId: string,
  closure: { conclusion: string; remediation: string; approvalSignatureId: string },
): Promise<void> {
  await db.query('select records.close_di_investigation($1, $2, $3, $4)', [
    investigationId,
    closure.conclusion,
    closure.remediation,
    closure.approvalSignatureId,
  ]);
}
