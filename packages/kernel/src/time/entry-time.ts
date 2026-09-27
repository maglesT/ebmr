/**
 * Two times per business event (build outline 5.6; INV-16; DI-27, DI-28 context).
 *
 * recorded_at is always the database clock at commit; the application never supplies it.
 * occurred_at is an optional claimed or source time with a trust level. These helpers mirror
 * the SQL rules (platform.time_basis, platform.is_late_entry, platform.guard_instants) for
 * previews and for evaluating status guards of a late entry at both instants. The database
 * functions remain the authority.
 */
import type { Instant } from './instant.ts';

export const TIME_TRUST_LEVELS = ['DEVICE_SYNCED', 'DEVICE_UNSYNCED', 'USER_CLAIMED', 'PAPER'] as const;
export type TimeTrust = (typeof TIME_TRUST_LEVELS)[number];

export type TimeBasis = 'OCCURRED_AT' | 'RECORDED_AT';

/** The time that drives time constraints: occurred_at only when device-synchronised. */
export function timeBasis(recordedAt: Instant, occurred?: { at: Instant; trust: TimeTrust }): { basis: TimeBasis; at: Instant } {
  return occurred && occurred.trust === 'DEVICE_SYNCED' ? { basis: 'OCCURRED_AT', at: occurred.at } : { basis: 'RECORDED_AT', at: recordedAt };
}

/** A person-claimed event time (USER_CLAIMED or PAPER) makes an entry a late entry. */
export function isLateEntry(occurred?: { trust: TimeTrust }): boolean {
  return occurred !== undefined && (occurred.trust === 'USER_CLAIMED' || occurred.trust === 'PAPER');
}

export interface GuardInstant {
  role: 'OCCURRED_AT' | 'RECORDED_AT';
  at: Instant;
}

/** The instants at which status guards are evaluated: the claimed event time (if any) and the recorded time. */
export function guardInstants(recordedAt: Instant, occurredAt?: Instant): GuardInstant[] {
  const out: GuardInstant[] = [];
  if (occurredAt && occurredAt.compare(recordedAt) !== 0) out.push({ role: 'OCCURRED_AT', at: occurredAt });
  out.push({ role: 'RECORDED_AT', at: recordedAt });
  return out;
}

export interface GuardVerdict {
  passed: boolean;
  reason?: string;
}

export interface InstantEvaluation extends GuardInstant {
  passed: boolean;
  reason?: string;
}

export interface StatusEvaluation {
  evaluations: InstantEvaluation[];
  /** True when every evaluation passed. */
  passed: boolean;
  /**
   * True when any evaluation failed. The caller must then raise a GMP exception for the entry:
   * a late entry is never refused silently and never accepted silently (outline 5.6).
   */
  exceptionRequired: boolean;
}

/** Evaluates one status guard at every instant and reports each result. */
export async function evaluateAtInstants(
  instants: readonly GuardInstant[],
  guard: (at: Instant) => GuardVerdict | Promise<GuardVerdict>,
): Promise<StatusEvaluation> {
  if (instants.length === 0) throw new Error('at least one instant is required');
  const evaluations: InstantEvaluation[] = [];
  for (const instant of instants) {
    const verdict = await guard(instant.at);
    evaluations.push({ ...instant, passed: verdict.passed, ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}) });
  }
  const passed = evaluations.every((e) => e.passed);
  return { evaluations, passed, exceptionRequired: !passed };
}
