/**
 * Review reproducer F20: for ALL_APPLY keys "a is at least as strict as b" is decided on criterion
 * ids only (market.at_least_as_strict, 0300: criteria_ids(a) @> criteria_ids(b); TS twin
 * isAtLeastAsStrict in src/market/strictness.ts). The content of a criterion (bands, sampling plan,
 * stage) is never compared, so a criterion that keeps its id but carries weaker content counts as
 * equal or stricter.
 *
 * The HARD India criterion under test is B-14.IN.ipBands (tablets.uniformity.acceptanceCriteria,
 * IP uniformity of weight: 10 / 7.5 / 5 %). The weakened copy keeps the id and replaces the bands by
 * a single 50 % band.
 *
 * Safe behaviour asserted here:
 *   1. A site value that weakens the HARD India criterion (same id, looser bands) is refused
 *      (IN-52: a site value looser than a HARD value is refused, with or without approvals), and the
 *      {IN} tablet batch evaluation keeps the India bands as its effective value.
 *   2. A tablets v2 UPDATE whose only change is the weakened India criterion (same id, effective
 *      since 2023-12-28, so already in force) is refused with EBMR-MKT-031: only a SOURCE_CORRECTION
 *      (citation, two approvers) may loosen a value in force.
 *   3. The TS comparator does not call the weakened criterion "at least as strict" as the India one.
 *
 * Positive controls (same key, same actors): dropping the India criterion id is refused on both
 * paths, so the setup (roles, scopes, publish gate) is right and only the same-id case slips through.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchFlags, evaluateStubScope, setSiteValue } from '../../src/market/repository.ts';
import { isAtLeastAsStrict, jsonEqual } from '../../src/market/strictness.ts';
import type { RuleTableDocument, RuleValue } from '../../src/market/types.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asApp, MARKET_ROLES, publishDocument, publishSeedTables, seedDocument, seedStubWorld, type StubWorld } from '../market/helpers.ts';

let db: TestDatabase;
let world: StubWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  await publishSeedTables(db);
  world = await seedStubWorld(db);
});

afterAll(async () => {
  await db.drop();
});

const KEY = 'tablets.uniformity.acceptanceCriteria';
const IP_ID = 'IP_UNIFORMITY_OF_WEIGHT_BANDS';

type Criterion = { id: string } & Record<string, unknown>;

async function outcomeOf<T>(p: Promise<T>, describeOk: (v: T) => string): Promise<string> {
  try {
    return describeOk(await p);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /EBMR-[A-Z]+-\d+/.exec(message)?.[0] ?? 'UNCODED';
    return `REFUSED ${code}`;
  }
}

describe('F20: ALL_APPLY strictness must compare criterion content, not only ids', () => {
  it('[IN-52][INV-28][IN-34][ST-01] a HARD India criterion cannot be weakened under the same id, by a site value or by an UPDATE', async () => {
    const tablets = seedDocument('tablets');
    const rowsOf = (d: RuleTableDocument) => d.rows;
    const ipRow = rowsOf(tablets).find((r) => r.ref === 'B-14.IN.ipBands');
    const usRow = rowsOf(tablets).find((r) => r.ref === 'B-14.US.udu');
    const euRow = rowsOf(tablets).find((r) => r.ref === 'B-14.EU.udu');
    if (!ipRow || !usRow || !euRow) throw new Error('seed rows B-14.* not found');
    expect(ipRow.floor).toBe('HARD');
    const ip = (ipRow.value as Criterion[])[0] as Criterion;
    const usp = (usRow.value as Criterion[])[0] as Criterion;
    const phEur = (euRow.value as Criterion[])[0] as Criterion;
    expect(ip.id).toBe(IP_ID);

    // Same id, same stage and pharmacopoeia, one 50 % band instead of the IP 10 / 7.5 / 5 % bands.
    const weakIp: Criterion = { ...ip, bands: [{ deviationPercent: '50' }] };

    const setAsSteward = (value: RuleValue) =>
      asApp(db, (c) => setSiteValue(c, { siteId: world.siteId, key: KEY, value, effectiveFrom: '2026-01-01' }), { roleCode: MARKET_ROLES.siteValues });

    // Positive control 1: a site value that drops the India criterion id is refused (the site scope is {EU, IN, US}).
    const controlSite = await outcomeOf(setAsSteward([phEur, usp] as unknown as RuleValue), (sv) => `ACCEPTED ${sv.outcome}`);

    // Attack 1: weaken the India criterion under its own id; keep the EU and US criteria unchanged. No justification, no QA approval.
    const attackSite = await outcomeOf(setAsSteward([weakIp, phEur, usp] as unknown as RuleValue), (sv) => `ACCEPTED ${sv.outcome}`);

    // The {IN} tablet batch, evaluated by an operator after the site value's effective date.
    const e = await asApp(
      db,
      (c) => evaluateStubScope(c, { key: KEY, scope: { kind: 'PRODUCT', id: world.batch.tabletIn }, resolutionPoint: 'EXECUTION', asOf: '2026-03-01' }),
      { roleCode: MARKET_ROLES.evaluator },
    );
    const effectiveIp = (e.effectiveValue as unknown as Criterion[] | null)?.find((c) => c.id === IP_ID) ?? null;
    const flags = await batchFlags(db.app, world.batch.tabletIn);

    // Positive control 2: an UPDATE that replaces the India criterion by a different id is refused as a loosening in force.
    const renamed: RuleTableDocument = {
      ...tablets,
      version: 2,
      change: { kind: 'UPDATE', description: 'F20 control: India criterion under a new id' },
      rows: rowsOf(tablets).map((r) => (r.ref === 'B-14.IN.ipBands' ? { ...r, value: [{ ...ip, id: 'IP_UNIFORMITY_OF_WEIGHT_BANDS_X' }] } : r)),
    };
    const controlPublish = await outcomeOf(publishDocument(db, renamed), (p) => `PUBLISHED loosening=${p.loosening.length} impact=${p.impactCount}`);

    // Attack 2: an UPDATE whose only change is the weakened India criterion under its own id, in force since 2023-12-28.
    const weakened: RuleTableDocument = {
      ...tablets,
      version: 2,
      change: { kind: 'UPDATE', description: 'F20: IP weight bands edited' },
      rows: rowsOf(tablets).map((r) => (r.ref === 'B-14.IN.ipBands' ? { ...r, value: [weakIp] as unknown as RuleValue } : r)),
    };
    const attackPublish = await outcomeOf(publishDocument(db, weakened), (p) => `PUBLISHED loosening=${p.loosening.length} impact=${p.impactCount}`);

    // TS twin of the comparator.
    const tsSaysWeakIsAsStrict = isAtLeastAsStrict('ALL_APPLY', null, [weakIp] as unknown as RuleValue, [ip] as unknown as RuleValue);

    const observed = {
      controlSite,
      controlPublish,
      attackSite,
      evaluation: {
        resolvedIsIndiaBands: jsonEqual(e.resolvedValue, [ip]),
        effectiveIpIsIndiaBands: jsonEqual(effectiveIp, ip),
        siteOutcome: e.siteOutcome,
        batchFlagged: flags.length > 0,
      },
      attackPublish,
      tsSaysWeakIsAsStrict,
    };

    expect(observed).toEqual({
      controlSite: 'REFUSED EBMR-MKT-064',
      controlPublish: 'REFUSED EBMR-MKT-031',
      // A site value looser than a HARD value is refused (IN-52); the same id does not make it tighter.
      attackSite: expect.stringMatching(/^REFUSED EBMR-MKT-06[04]$/) as unknown,
      evaluation: {
        resolvedIsIndiaBands: true,
        // The India HARD bands stay in force for the {IN} batch.
        effectiveIpIsIndiaBands: true,
        siteOutcome: expect.not.stringMatching(/^SITE_TIGHTER$|^SITE_EQUAL$/) as unknown,
        batchFlagged: expect.any(Boolean) as unknown,
      },
      // Loosening a value already in force needs a SOURCE_CORRECTION (EBMR-MKT-031).
      attackPublish: 'REFUSED EBMR-MKT-031',
      tsSaysWeakIsAsStrict: false,
    });
  });
});
