/**
 * Review reproducer F23: market.evaluate_stub_scope (0330) says "a PACK scope resolves a
 * PER_DESTINATION key for its own destination", but it fills in the pack's destination only when the
 * caller's stated.destination is null. A caller that names another destination of the batch's
 * market set gets that destination's rule stored against the pack.
 *
 * Setup: the IN-52 stub world. Pack PK-IN (destination IN) belongs to tablet batch T-ALL
 * ({EU, IN, US}). kernel.label.manufacturingDate is PER_DESTINATION: India requires the
 * manufacturing date uncoded on the label (MANDATORY_UNCODED); the US does not require it
 * (NOT_REQUIRED).
 *
 * Safe behaviour asserted: an OPERATOR evaluating the key for PK-IN with
 * stated = {PER_DESTINATION, decisionRef, destination: 'US'} is either refused, or the stored
 * evaluation is resolved for the pack's own destination IN (resolved and effective value
 * MANDATORY_UNCODED, governing market IN, stated destination IN).
 *
 * Positive control: the same request without a destination resolves PK-IN to MANDATORY_UNCODED
 * governed by IN, and its market derivation records the pack destination IN.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateStubScope, type EvaluateStubScopeRequest, type StoredEvaluation } from '../../src/market/repository.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asApp, MARKET_ROLES, publishSeedTables, seedStubWorld, type StubWorld } from '../market/helpers.ts';

let db: TestDatabase;
let world: StubWorld;

const KEY = 'kernel.label.manufacturingDate';
const AS_OF = '2026-03-01';

beforeAll(async () => {
  db = await createTestDatabase();
  await publishSeedTables(db);
  world = await seedStubWorld(db);
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

function packDestination(e: StoredEvaluation): unknown {
  const pack = (e.marketDerivation as { source?: string; destination?: string }[]).find((d) => d.source === 'PACK');
  return pack?.destination;
}

describe('F23: a PACK scope resolves a PER_DESTINATION key only for its own destination', () => {
  it('[IN-52][IN-31][INV-28] an India-domestic pack cannot be resolved under the US label rule by naming destination US', async () => {
    // Positive control: without a destination, PK-IN resolves for IN.
    const control = await evaluate({
      key: KEY,
      scope: { kind: 'PACK', id: world.pack.tabletAllIn },
      resolutionPoint: 'EXECUTION',
      asOf: AS_OF,
      stated: { method: 'PER_DESTINATION', decisionRef: 'x' },
    });
    expect([control.resolvedValue, control.effectiveValue, control.governingMarkets, packDestination(control)]).toEqual([
      'MANDATORY_UNCODED',
      'MANDATORY_UNCODED',
      ['IN'],
      'IN',
    ]);

    // Attack: the same pack, naming destination US (inside the batch's market set {EU, IN, US}).
    const overridden = await attempt(
      evaluate({
        key: KEY,
        scope: { kind: 'PACK', id: world.pack.tabletAllIn },
        resolutionPoint: 'EXECUTION',
        asOf: AS_OF,
        stated: { method: 'PER_DESTINATION', decisionRef: 'x', destination: 'US' },
      }),
    );

    const observed =
      typeof overridden === 'string'
        ? 'REFUSED'
        : {
            packDestination: packDestination(overridden),
            resolvedValue: overridden.resolvedValue,
            effectiveValue: overridden.effectiveValue,
            governingMarkets: overridden.governingMarkets,
            statedDestination: (overridden.resolution as { stated?: { destination?: string } }).stated?.destination ?? null,
          };
    const safe =
      observed === 'REFUSED' ||
      (observed.resolvedValue === 'MANDATORY_UNCODED' &&
        observed.effectiveValue === 'MANDATORY_UNCODED' &&
        JSON.stringify(observed.governingMarkets) === '["IN"]' &&
        (observed.statedDestination === 'IN' || observed.statedDestination === null));

    expect(safe, `stored evaluation of PK-IN with stated destination US: ${JSON.stringify(observed)}`).toBe(true);
  });
});
