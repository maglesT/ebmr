/**
 * The review-priority method of slice 6A-5 (decision 0016 item 9; D-6A-13, D-6A-14; draft control PR-61): a
 * transparent weighted score that orders the QA review queue and never skips, narrows or completes a review.
 */
export { type AuditKeyVerdict, type ReviewInput, type ReviewRecord, type ReviewStep, type ReviewValue } from './input.ts';
export {
  PRIORITY_TERMS,
  REVIEW_PRIORITY,
  nearLimit,
  auditFlagKey,
  recordTerms,
  runReviewPriority,
  scoreOf,
  type CappedTerm,
  type PriorityTerm,
  type ReviewPriorityParameters,
  type TermScore,
} from './priority.ts';
