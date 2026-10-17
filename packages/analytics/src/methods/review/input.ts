/**
 * The input of REVIEW.PRIORITY (slice 6A-5; decision 0016 item 9; draft control PR-61), as the runner assembles it from
 * its catalogued inputs:
 *   records  report.review_fact_v1: the GMP batch records in the review queue that the score is for, with the counts
 *            the database gives (exceptions by severity, corrections, linked deviations, new operators and units, the
 *            review outcome so far);
 *   values   report.cpp_value_v1: the critical values of the records, the last attempt of each item (D-6A-2-2), as
 *            decimal text with the master's outermost limits;
 *   steps    report.step_use_v1 with report.batch_fact_v1: when each step of each GMP record started and ended, with the
 *            record's product and MBR family, for the duration baselines;
 *   audit    report.audit_fact_v1: the audit entries ATA.RULES reads, so the audit-trail flags on a record's entries are
 *            counted from the same snapshot (D-6A-5-4). No value of an entry is in them (DI-53).
 */
import type { DecimalText } from '../../numeric/from-decimal.ts';
import type { AuditEvent } from '../audit/input.ts';

/** One record awaiting (or just past) QA review, as report.review_fact_v1 gives it. */
export interface ReviewRecord {
  readonly batchId: string;
  readonly batchNumber: string;
  readonly product: string | null;
  readonly family: string | null;
  readonly reviewState: string;
  /** When the record reached EXECUTION_COMPLETE or ABORTED (database text), or null. */
  readonly endedAt: string | null;
  readonly exceptionsCritical: number;
  readonly exceptionsMajor: number;
  readonly exceptionsMinor: number;
  readonly corrections: number;
  readonly deviations: number;
  readonly newOperators: number;
  /** The units new to the site's GMP records or maintained in the 7 days before their use here. */
  readonly newEquipment: readonly string[];
  /** The review outcome so far, kept with the score for learned weights later (D-6A-20). */
  readonly reviewFindings: number;
  readonly reviewReopenings: number;
}

/** One critical value of a record (its last attempt), with the master's limits as decimal text. */
export interface ReviewValue {
  readonly batchId: string;
  /** item and step, with the reading number of a SERIES (`item@step#n`). */
  readonly ref: string;
  readonly value: DecimalText;
  readonly lower: DecimalText | null;
  readonly upper: DecimalText | null;
}

/** One executed step of a GMP record: its product and family, and when it started and ended (database text). */
export interface ReviewStep {
  readonly batchId: string;
  readonly product: string;
  readonly family: string;
  readonly step: string;
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface ReviewInput {
  readonly records: readonly ReviewRecord[];
  readonly values: readonly ReviewValue[];
  readonly steps: readonly ReviewStep[];
  readonly audit: readonly AuditEvent[];
}
