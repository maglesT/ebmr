/**
 * Review reproducer F22: market.record_evaluation (0330) files an evaluation under
 * coalesce(p_req -> 'subject', <derived from scope>), and market.evaluate_stub_scope passes the
 * caller's subject through unchecked. The market set, predicates and site come from the SCOPE, but
 * the row is listed, flagged and audited under the SUBJECT (listEvaluations(subject),
 * market.batch_flags(subject), audit chain market_evaluation:<subject>).
 *
 * Setup: the IN-52 stub world. Batch T-IN serves {IN}; batch T-ALL (same product) serves
 * {EU, IN, US}. kernel.referenceSamples.monthsAfterExpiry is 3 mo for India and 12 mo for US/EU, so
 * T-ALL must resolve to 12. The site of every stub batch holds an approved LOOSENED value (15 mo)
 * for kernel.managementReview.maxIntervalMonths, so evaluating that key for batch I-ALL gives
 * SITE_LOOSENED, which must show in batch_flags(I-ALL).
 *
 * Safe behaviour asserted (the request is refused, or the subject is bound to the scope):
 *   1. An OPERATOR evaluating scope T-IN with subject BATCH T-ALL never gets a row filed under T-ALL
 *      whose market set is {IN} / value 3: every referenceSamples evaluation listed under T-ALL
 *      has market set {EU, IN, US} and resolved value 12, and T-ALL's audit chain holds no such row.
 *   2. An OPERATOR evaluating scope I-ALL (SITE_LOOSENED) with subject BATCH I-IN cannot hide the
 *      flag: if the evaluation is stored, batch_flags(I-ALL) lists it.
 *
 * Positive controls: without a subject, T-ALL resolves to 12 over {EU, IN, US} and is filed under
 * T-ALL; I-ALL's managementReview evaluation is SITE_LOOSENED and flagged on I-ALL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchFlags, evaluateStubScope, listEvaluations, setSiteValue, type EvaluateStubScopeRequest, type StoredEvaluation } from '../../src/market/repository.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asApp, MARKET_ROLES, publishSeedTables, seedStubWorld, type StubWorld } from '../market/helpers.ts';

let db: TestDatabase;
let world: StubWorld;

const REF_KEY = 'kernel.referenceSamples.monthsAfterExpiry';
const MR_KEY = 'kernel.managementReview.maxIntervalMonths';
const AS_OF = '2026-03-01';

beforeAll(async () => {
  db = await createTestDatabase();
  await publishSeedTables(db);
  world = await seedStubWorld(db);
  // An approved loosening of the GUIDANCE management-review interval (12 -> 15 months) at the site
  // where every stub batch is made.
  const loosened = await asApp(
    db,
    (c) =>
      setSiteValue(c, {
        siteId: world.siteId,
        key: MR_KEY,
        value: '15',
        effectiveFrom: '2026-01-01',
        justificationRef: 'MR-JUST-F22',
        qaApprovalId: randomUUID(),
      }),
    { roleCode: MARKET_ROLES.siteValues },
  );
  expect(loosened.outcome).toBe('LOOSENED');
});

afterAll(async () => {
  await db.drop();
});

/** Evaluate as an OPERATOR (MARKET.RULE_EVALUATE). */
function evaluate(request: EvaluateStubScopeRequest): Promise<StoredEvaluation> {
  return asApp(db, (c) => evaluateStubScope(c, request), { roleCode: MARKET_ROLES.evaluator });
}

/** The stored evaluation, or the refusal code. */
async function attempt(p: Promise<StoredEvaluation>): Promise<StoredEvaluation | string> {
  try {
    return await p;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `REFUSED ${/EBMR-[A-Z]+-\d+/.exec(message)?.[0] ?? message}`;
  }
}

describe('F22: an evaluation is filed only under a subject its scope entails', () => {
  it('[INV-29][IN-52][INV-28] pairing a batch subject with another batch\'s scope cannot file a looser evaluation under it or hide its site-value flag', async () => {
    // Positive control 1: T-ALL resolves to 12 over {EU, IN, US} and is filed under T-ALL.
    const control = await evaluate({ key: REF_KEY, scope: { kind: 'PRODUCT', id: world.batch.tabletAll }, resolutionPoint: 'RELEASE', asOf: AS_OF });
    expect([control.subjectType, control.subjectId, control.marketSet, control.resolvedValue]).toEqual(['BATCH', world.batch.tabletAll, ['EU', 'IN', 'US'], '12']);
    // Positive control 2: I-ALL's management-review evaluation is SITE_LOOSENED and flagged on I-ALL.
    const controlMr = await evaluate({ key: MR_KEY, scope: { kind: 'PRODUCT', id: world.batch.injectableAll }, resolutionPoint: 'EXECUTION', asOf: AS_OF });
    expect([controlMr.subjectId, controlMr.siteOutcome, controlMr.effectiveValue]).toEqual([world.batch.injectableAll, 'SITE_LOOSENED', '15']);
    expect((await batchFlags(db.app, world.batch.injectableAll)).map((f) => f.evaluationId)).toContain(controlMr.id);

    // Attack 1: scope = T-IN ({IN}), subject = T-ALL.
    const swapped = await attempt(
      evaluate({
        key: REF_KEY,
        scope: { kind: 'PRODUCT', id: world.batch.tabletIn },
        subject: { type: 'BATCH', id: world.batch.tabletAll },
        resolutionPoint: 'RELEASE',
        asOf: AS_OF,
      }),
    );
    // Attack 2: scope = I-ALL (SITE_LOOSENED), subject = I-IN.
    const hidden = await attempt(
      evaluate({
        key: MR_KEY,
        scope: { kind: 'PRODUCT', id: world.batch.injectableAll },
        subject: { type: 'BATCH', id: world.batch.injectableIn },
        resolutionPoint: 'EXECUTION',
        asOf: AS_OF,
      }),
    );

    // 1. Every referenceSamples evaluation listed under T-ALL is T-ALL's own ({EU, IN, US}, 12).
    const underTAll = (await listEvaluations(db.app, world.batch.tabletAll)).filter((e) => e.key === REF_KEY);
    const foreignUnderTAll = underTAll
      .filter((e) => e.marketSet.join(',') !== 'EU,IN,US' || e.resolvedValue !== '12')
      .map((e) => `id=${e.id} scope=${e.scopeKind}:${e.scopeId === world.batch.tabletIn ? 'T-IN' : e.scopeId} markets=${e.marketSet.join(',')} value=${JSON.stringify(e.resolvedValue)}`);
    // ... and T-ALL's audit chain carries no such row.
    const { rows: chain } = await db.app.query<{ record_id: string }>(
      'select record_id from kernel.audit_event where chain_key = $1 and table_name = $2',
      [`market_evaluation:${world.batch.tabletAll}`, 'market.evaluation'],
    );
    const chainIds = new Set(chain.map((r) => r.record_id));
    const foreignInChain = typeof swapped === 'string' ? [] : chainIds.has(swapped.id) && swapped.marketSet.join(',') !== 'EU,IN,US' ? [swapped.id] : [];

    // 2. A stored SITE_LOOSENED evaluation of I-ALL is flagged on I-ALL.
    const flagsIAll = (await batchFlags(db.app, world.batch.injectableAll)).map((f) => f.evaluationId);
    const hiddenFlag =
      typeof hidden === 'string'
        ? 'REFUSED'
        : hidden.siteOutcome === 'SITE_LOOSENED' && !flagsIAll.includes(hidden.id)
          ? `HIDDEN: evaluation ${hidden.id} of scope I-ALL (${hidden.siteOutcome}, effective ${JSON.stringify(hidden.effectiveValue)}) filed under ${hidden.subjectId === world.batch.injectableIn ? 'I-IN' : hidden.subjectId}; batch_flags(I-ALL) omits it`
          : 'FLAGGED';

    expect({
      swappedRequest: typeof swapped === 'string' ? swapped.slice(0, 7) : `stored subject=${swapped.subjectId === world.batch.tabletAll ? 'T-ALL' : swapped.subjectId === world.batch.tabletIn ? 'T-IN' : swapped.subjectId} markets=${swapped.marketSet.join(',')} value=${JSON.stringify(swapped.resolvedValue)}`,
      foreignUnderTAll,
      foreignInChain,
      hiddenFlagSafe: hiddenFlag === 'REFUSED' || hiddenFlag === 'FLAGGED' ? 'SAFE' : hiddenFlag,
    }).toEqual({
      // Safe: refused, or filed under the scope's own batch T-IN.
      swappedRequest: typeof swapped === 'string' ? 'REFUSED' : `stored subject=T-IN markets=IN value="3"`,
      foreignUnderTAll: [],
      foreignInChain: [],
      hiddenFlagSafe: 'SAFE',
    });
  });
});
