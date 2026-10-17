/**
 * Shared parts of the audit-trail flag screens (slice 6A-4): the reads refreshed after a disposition, the rule names
 * in plain words, and who is offered the data-integrity review (display only; the database decides: CSV_DI_LEAD holds
 * ANALYTICS.DI_REVIEW in the Tablets edition, D-6A-0-5).
 */
import { routes } from '@ebmr/api-contract';

export const AUDIT_READS: readonly string[] = [routes.analyticsAudit.flags.id, routes.analyticsAudit.flag.id, routes.analyticsAudit.entries.id, routes.analytics.flags.id, routes.analytics.flag.id];

export const RULE_LABELS: Readonly<Record<string, string>> = {
  LATE_ENTRY: 'Late entry',
  BACK_DATED: 'Back-dated entry',
  CORRECTIONS_HIGH: 'Many corrections in a week',
  TWO_TERMINALS: 'One account on two terminals',
  TOO_REGULAR: 'Values too regular',
  REPEAT_UNTIL_PASS: 'Test repeated until a pass',
  OFF_HOURS_CONFIG: 'Configuration change outside working hours',
  BASELINE_Z: 'Week unlike the person\'s own',
};
export const ruleLabel = (rule: string): string => RULE_LABELS[rule] ?? rule;

/** Whether the session's role is offered the data-integrity review of flags about persons (display only). */
export const offeredDiReview = (role: string | null): boolean => role === 'CSV_DI_LEAD';
