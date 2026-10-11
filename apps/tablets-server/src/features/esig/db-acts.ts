/**
 * Signed acts whose rule is the database's (Phase 3 slice 6): one signable handler per act, built from what the act signs
 * and the database command it runs with the signature. The ceremony is the usual one (preview, challenge on the content
 * the person saw, sign); the dry run only finds the record and its content, and the database command, run with the real
 * signature inside the signing command, decides: when it refuses, the whole command rolls back and nothing is signed.
 */
import type pg from 'pg';
import type { SignableAction } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import type { DryRunOutcome, SignableActionHandler, SignableContext } from '../../platform/ports.ts';
import { kernelContent, recordContentForSigning, type EsigSignableContext } from './content.ts';

export interface ActTarget {
  aggregateType: string;
  aggregateId: string;
  /** '' when the person chooses it (the challenge names it) or it depends on the record's state (see `now`). */
  meaning: string;
  expectedState?: string;
}

export interface DbActSpec<A extends SignableAction> {
  kind: A['kind'];
  aggregateTypes: readonly string[];
  /** What the action signs, from the action alone. */
  target(action: A): ActTarget;
  /** What the action signs, read now (the meaning when it depends on the record's state). */
  targetNow?(db: pg.Pool | pg.PoolClient, action: A): Promise<ActTarget>;
  /** The person's own reason the signing command carries, when the act's record change needs one (EBMR-AUDIT-002). */
  reasonOf?(action: A): { reasonCode: string; reasonText: string } | undefined;
  /** Checks the server makes before anything is signed (the database checks them again). */
  precheck?(client: pg.PoolClient, ctx: SignableContext, action: A): Promise<DryRunOutcome | null>;
  /** The database command, with the signature just made. */
  apply(client: pg.PoolClient, ctx: SignableContext, action: A, signatureId: string): Promise<Record<string, unknown> | null>;
}

export function refusedOutcome(status: number, code: string, whatHappened: string, why: string, controls: string[], whatYouCanDo: string[]): DryRunOutcome {
  return { accepted: false, status, refusal: { code, kind: status === 409 ? 'STALE' : 'NOT_ALLOWED', whatHappened, why, controls, whatYouCanDo, whoCanHelp: [] } };
}

export function dbActHandler<A extends SignableAction>(app: AppContext, spec: DbActSpec<A>): SignableActionHandler<A> {
  return {
    kind: spec.kind,
    aggregateTypes: spec.aggregateTypes,
    describe: (a) => spec.target(a),
    ...(spec.reasonOf ? { reasonOf: (a: A) => (spec.reasonOf as NonNullable<typeof spec.reasonOf>)(a) } : {}),
    ...(spec.targetNow ? { describeNow: (db: pg.Pool | pg.PoolClient, a: A) => (spec.targetNow as NonNullable<typeof spec.targetNow>)(db, a) } : {}),
    async expectedStateNow(client, a) {
      const t = spec.target(a);
      if (t.expectedState !== undefined) return t.expectedState;
      return (await recordContentForSigning(client, t.aggregateType, t.aggregateId)).state ?? null;
    },
    previewContent: (ctx, query) => kernelContent(app.pools.app, (ctx as Partial<EsigSignableContext>).tokenHash ?? '', query),
    async prepareForChallenge(client, _ctx, a) {
      const t = spec.target(a);
      const c = await recordContentForSigning(client, t.aggregateType, t.aggregateId);
      return { contentVersion: c.contentVersion ?? '0', contentHash: c.contentHash ?? '', changed: false };
    },
    async dryRun(client, ctx, a) {
      const t = spec.target(a);
      const pre = spec.precheck ? await spec.precheck(client, ctx, a) : null;
      if (pre) return pre;
      const c = await recordContentForSigning(client, t.aggregateType, t.aggregateId);
      if (!c.exists || !c.contentHash || !c.contentVersion) {
        return refusedOutcome(404, 'EBMR-API-NO-RECORD', 'The record to be signed was not found. Nothing was signed.', `${t.aggregateType} ${t.aggregateId} does not exist.`, ['DI-37'], ['Reload the screen.']);
      }
      return { accepted: true, contentHash: c.contentHash, contentVersion: c.contentVersion };
    },
    // A refusal by the database propagates: the signing command rolls back whole and nothing is signed.
    apply: (client, ctx, a, signature) => spec.apply(client, ctx, a, signature.signatureId),
  };
}
