/**
 * Batch retention keys (Phase 4 slice 6b; IN-08, PR-59, DI-46, DI-47; default D-6-5). The facts of a batch, as the
 * edition reads them from its record, become the inputs of the kernel retention engine (retention.ts and its database
 * mirror records.evaluate_retention): the engine takes the longest rule that applies (Schedule M expiry + 1 year,
 * Form 25 or 28 periods, US expiry + 1 year, EU the later of expiry + 1 year and certification + 5 years), keeps an EU
 * batch OPEN until it is certified or finally rejected, keeps an aborted batch like a completed one, and lets a record
 * another record depends on inherit the longer period (records.link_retention_dependency). Nothing here deletes:
 * records.request_disposal answers a deletion request and logs it (kernel 1172).
 */
import type pg from 'pg';
import type { CalendarDate } from './calendar.ts';
import type { Market } from './retention-rules.ts';
import type { RetentionInputs } from './retention.ts';

export interface BatchRetentionFacts {
  markets: Market[];
  licenceForm: 'FORM_25' | 'FORM_28' | null;
  /** Site date the batch was issued for manufacture. */
  manufactureDate: CalendarDate;
  /** Labelled expiry of the lot(s) made from the batch (the latest); null while none is set. */
  expiryDate: CalendarDate | null;
  /** COMPLETED for any batch that ran to its end (released, rejected or never released); ABORTED or CANCELLED otherwise. */
  outcome: 'IN_PROGRESS' | 'COMPLETED' | 'ABORTED' | 'CANCELLED';
  /** Site date of the abort or cancellation. */
  abortCancelDate: CalendarDate | null;
  /** The EU disposition of the batch's lot: certified (with the QP's date), finally rejected (with the date), or pending. */
  eu: { state: 'PENDING' } | { state: 'CERTIFIED'; date: CalendarDate } | { state: 'FINALLY_REJECTED'; date: CalendarDate } | null;
}

/** The retention-engine inputs of a batch from its facts (pure). */
export function batchRetentionInputs(f: BatchRetentionFacts): RetentionInputs {
  const markets = [...new Set<Market>(['IN', ...f.markets])].sort();
  const aborted = f.outcome === 'ABORTED' || f.outcome === 'CANCELLED';
  const inputs: RetentionInputs = {
    markets,
    licenceForm: f.licenceForm,
    manufactureDate: f.manufactureDate,
    expiryDate: f.expiryDate,
  };
  if (aborted) inputs.abortCancelDate = f.abortCancelDate;
  if (markets.includes('EU') && f.eu) {
    if (f.eu.state === 'CERTIFIED') inputs.euCertificationDate = f.eu.date;
    else if (f.eu.state === 'FINALLY_REJECTED') {
      inputs.euNeverCertified = true;
      inputs.dispositionDate = f.eu.date;
    }
  }
  return inputs;
}

export interface DisposalAnswer {
  recordKey: string;
  outcome: 'REFUSED' | 'ELIGIBLE';
  status: 'DATED' | 'OPEN' | null;
  retainUntil: CalendarDate | null;
  governedBy: string[];
  refusals: { code: string; detail: string }[];
}

/** A deletion request: answered from the stored inputs and rules, and logged (records.request_disposal). Deletes nothing. */
export async function requestDisposal(db: pg.Pool | pg.PoolClient, aggregateType: string, aggregateId: string, reason: string): Promise<DisposalAnswer> {
  const { rows } = await db.query<{ r: DisposalAnswer }>('select records.request_disposal($1, $2, $3) as r', [aggregateType, aggregateId, reason]);
  return rows[0]?.r as DisposalAnswer;
}
