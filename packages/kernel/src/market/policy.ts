/**
 * Policy switches as versioned data (build outline 3.5, 5.8; L-25; INV-47).
 *
 * A policy lists its positions from least to most strict. A new version takes effect at an instant
 * that is never in the past; a batch pins, at issue, the versions in force; afterwards only a
 * tightening already in force can be applied to it. A loosening never applies to a batch issued
 * before the loosening took effect (enforced by triggers in market.batch_policy_pin).
 */
import { MarketRuleError } from './errors.ts';
import type { Queryable } from './repository.ts';

export interface PolicyDefinition {
  code: string;
  title: string;
  level: 'VENDOR' | 'TENANT';
  controls?: string[];
  /** Least strict first. */
  positions: string[];
  defaultPosition: string;
  looseningRequires?: 'QA_APPROVAL' | 'CHANGE_CONTROL' | 'OWNER_CONFIRMATION';
  reason?: string;
}

export interface PolicyVersion {
  id: string;
  policyCode: string;
  version: number;
  position: string;
  effectiveFrom: string;
  recordedAt: string;
  direction: 'INITIAL' | 'TIGHTENING' | 'LOOSENING' | 'UNCHANGED';
  approvalId: string | null;
  changeRef: string | null;
}

export interface BatchPolicy {
  pinId: string;
  pinKind: 'ISSUE' | 'TIGHTENING';
  issueInstant: string;
  versionId: string;
  version: number;
  position: string;
  direction: PolicyVersion['direction'];
}

async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const message = (error as Error).message;
    const code = /^(EBMR-[A-Z]+-[0-9]{3})\s/.exec(message)?.[1];
    if (code) throw new MarketRuleError(code, message.slice(code.length + 1));
    throw error;
  }
}

function toVersion(v: Record<string, unknown>): PolicyVersion {
  return {
    id: v['id'] as string,
    policyCode: v['policy_code'] as string,
    version: v['version'] as number,
    position: v['position'] as string,
    effectiveFrom: v['effective_from'] as string,
    recordedAt: v['recorded_at'] as string,
    direction: v['direction'] as PolicyVersion['direction'],
    approvalId: (v['approval_id'] as string | null) ?? null,
    changeRef: (v['change_ref'] as string | null) ?? null,
  };
}

/** Define a policy; its version 1 (the default position) is in force from now. Run inside a command. */
export async function definePolicy(client: Queryable, definition: PolicyDefinition): Promise<PolicyVersion> {
  return run(async () => {
    const { rows } = await client.query<{ v: Record<string, unknown> }>('select market.define_policy($1::jsonb) as v', [JSON.stringify(definition)]);
    return toVersion(rows[0]?.v ?? {});
  });
}

/**
 * New policy version. `effectiveFrom` is an ISO instant that must not be in the past (omit for "now").
 * A loosening needs `approvalId` and `changeRef`; every change after version 1 needs `changeRef`.
 */
export async function setPolicyVersion(
  client: Queryable,
  policy: string,
  position: string,
  options: { effectiveFrom?: string; approvalId?: string; changeRef?: string; reason?: string } = {},
): Promise<PolicyVersion> {
  return run(async () => {
    const { rows } = await client.query<{ v: Record<string, unknown> }>('select market.set_policy_version($1, $2, $3::timestamptz, $4::jsonb) as v', [
      policy,
      position,
      options.effectiveFrom ?? null,
      JSON.stringify({ approvalId: options.approvalId, changeRef: options.changeRef, reason: options.reason }),
    ]);
    return toVersion(rows[0]?.v ?? {});
  });
}

/** The version in force at a batch's issue instant. */
export async function policyForBatch(db: Queryable, policy: string, issueInstant: string): Promise<PolicyVersion> {
  return run(async () => {
    const { rows } = await db.query<{ v: Record<string, unknown> }>('select market.policy_for_batch($1, $2::timestamptz) as v', [policy, issueInstant]);
    return toVersion(rows[0]?.v ?? {});
  });
}

/** Pin every policy for a batch at issue (call inside the batch-issue command). */
export async function pinPoliciesForBatch(client: Queryable, batchId: string): Promise<{ issueInstant: string; pins: { policy: string; versionId: string; version: number; position: string }[] }> {
  return run(async () => {
    const { rows } = await client.query<{ r: { issueInstant: string; pins: { policy: string; versionId: string; version: number; position: string }[] } }>(
      'select market.pin_policies_for_batch($1) as r',
      [batchId],
    );
    const r = rows[0]?.r;
    if (!r) throw new MarketRuleError('EBMR-MKT-087', 'pinning returned no result');
    return r;
  });
}

/** Apply a tightening already in force to an issued batch; anything else is refused (INV-47). */
export async function applyPolicyTightening(client: Queryable, batchId: string, policy: string, versionId: string, changeRef: string, reason?: string): Promise<void> {
  await run(() => client.query('select market.apply_policy_tightening($1, $2, $3, $4, $5)', [batchId, policy, versionId, changeRef, reason ?? null]));
}

/** What the batch applies now for a policy (issue pin or a later tightening), or null if never pinned. */
export async function batchPolicy(db: Queryable, batchId: string, policy: string): Promise<BatchPolicy | null> {
  const { rows } = await db.query<{ p: BatchPolicy | null }>('select market.batch_policy($1, $2) as p', [batchId, policy]);
  return rows[0]?.p ?? null;
}
