/**
 * Contingency packs: numbered paper forms issued at batch issue and at stage start, and their reconciliation before the
 * batch completes (Phase 4 slice 6b; DI-43, PR-16; D-6-6; kernel 1170). The rules are the database's; these helpers call
 * the records definers inside the caller's command (withCommand).
 */
import type pg from 'pg';

type Db = pg.Pool | pg.PoolClient;

export type ContingencyMoment = 'ISSUE' | 'STAGE_START';
export type ContingencyFormEvent = 'RETURNED' | 'TRANSCRIBED' | 'VERIFIED' | 'VOIDED' | 'REPORTED_MISSING';
export type ContingencyFormState = 'ISSUED' | 'RETURNED' | 'TRANSCRIBED' | 'VERIFIED' | 'VOIDED' | 'MISSING';
export type FormReconciliationState = 'NONE' | 'OPEN' | 'RECONCILED' | 'SIGNED';

export interface IssueContingencyPack {
  batchId: string;
  batchLabel: string;
  moment: ContingencyMoment;
  stageRef?: string | null;
  templateRef: string;
  destination: string;
  pages: number;
  reason: string;
}

export interface IssuedForm {
  formId: string;
  serial: string;
  pageNo: number;
  pageCount: number;
  packId: string;
}

export async function issueContingencyPack(db: Db, p: IssueContingencyPack): Promise<IssuedForm[]> {
  const { rows } = await db.query<{ f: IssuedForm[] }>('select records.issue_contingency_pack($1, $2, $3, $4, $5, $6, $7, $8) as f', [
    p.batchId,
    p.batchLabel,
    p.moment,
    p.stageRef ?? null,
    p.templateRef,
    p.destination,
    p.pages,
    p.reason,
  ]);
  return rows[0]?.f ?? [];
}

export async function recordContingencyFormEvent(db: Db, formId: string, event: ContingencyFormEvent, reason?: string | null, reference?: string | null): Promise<void> {
  await db.query('select records.record_contingency_form_event($1, $2, $3, $4)', [formId, event, reason ?? null, reference ?? null]);
}

export async function signFormReconciliation(db: Db, batchId: string, signatureId: string): Promise<void> {
  await db.query('select records.sign_form_reconciliation($1, $2)', [batchId, signatureId]);
}

/** NULL when the batch may complete as far as its paper forms go, else why not (the message names the gap). */
export async function formReconciliationProblem(db: Db, batchId: string): Promise<string | null> {
  const { rows } = await db.query<{ p: string | null }>('select records.form_reconciliation_problem($1) as p', [batchId]);
  return rows[0]?.p ?? null;
}

export async function formReconciliationState(db: Db, batchId: string): Promise<FormReconciliationState> {
  const { rows } = await db.query<{ s: FormReconciliationState }>('select records.form_reconciliation_state($1) as s', [batchId]);
  return rows[0]?.s ?? 'NONE';
}
