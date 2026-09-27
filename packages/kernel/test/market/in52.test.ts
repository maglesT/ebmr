/**
 * IN-52 catalog test with Phase 1 stub scopes (build outline 3.3.2, 11 Phase 1 "IN-52 (stub scopes)").
 *
 * One tablet and one injectable product, each with a batch for {IN} and one for {IN, US, EU}. The
 * {IN, US, EU} batches resolve to: retention = latest of expiry + 1 y, manufacture + 5 y and QP
 * certification + 5 y; reference samples expiry + 1 y; annual self-inspection; a new number on
 * rework; an identity test on every excipient lot; for the tablet the 30-minute compression IPC and
 * the IP weight bands; for the injectable "any contaminated APS unit fails", Grade A viable "no
 * growth", PUPSIT and a single-batch sterilising filter. The stored resolution log names the
 * governing market of every value.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StubResolutionContext, resolveForScope } from '../../src/market/context.ts';
import { evaluateStubScope, listEvaluations, loadRuleTableVersion, type ScopeRef, type StoredEvaluation } from '../../src/market/repository.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asApp, MARKET_ROLES, publishSeedTables, seedStubWorld, type StubWorld } from './helpers.ts';

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

const AS_OF = '2026-01-15';

async function evaluate(key: string, scope: ScopeRef, extra: Partial<Parameters<typeof evaluateStubScope>[1]> = {}): Promise<StoredEvaluation> {
  return asApp(db, (c) => evaluateStubScope(c, { key, scope, resolutionPoint: 'BATCH_ISSUE', asOf: AS_OF, ...extra }));
}

const batchScope = (id: string): ScopeRef => ({ kind: 'PRODUCT', id });

describe('IN-52 catalog test: {IN} and {IN, US, EU} batches of a tablet and an injectable', () => {
  const common: [string, string | boolean, string[]][] = [
    ['kernel.retention.batchRecord.monthsAfterExpiry', '12', ['EU', 'IN', 'US']],
    ['kernel.retention.batchRecord.monthsAfterManufacture', '60', ['IN']],
    ['kernel.retention.batchRecord.monthsAfterQpCertification', '60', ['EU']],
    ['kernel.referenceSamples.monthsAfterExpiry', '12', ['EU', 'US']],
    ['kernel.selfInspection.maxIntervalMonths', '12', ['IN']],
    ['kernel.rework.newBatchNumber', true, ['IN']],
    ['kernel.excipient.identityTestEachLot', true, ['EU', 'IN', 'US']],
  ];

  for (const product of ['tablet', 'injectable'] as const) {
    it(`[IN-52] the ${product} batch for {IN, US, EU} resolves every common row of table B and names the governing market`, async () => {
      const batch = product === 'tablet' ? world.batch.tabletAll : world.batch.injectableAll;
      for (const [key, value, governing] of common) {
        const e = await evaluate(key, batchScope(batch));
        expect([key, e.resolvedValue, e.governingMarkets]).toEqual([key, value, governing]);
        expect(e.marketSet).toEqual(['EU', 'IN', 'US']);
        expect(e.subjectType).toBe('BATCH');
        expect(e.subjectId).toBe(batch);
      }
    });
  }

  it('[IN-52] the {IN} batches keep the India values and nothing looser (reference samples 3 months, no QP period)', async () => {
    for (const batch of [world.batch.tabletIn, world.batch.injectableIn]) {
      expect((await evaluate('kernel.referenceSamples.monthsAfterExpiry', batchScope(batch))).resolvedValue).toBe('3');
      const qp = await evaluate('kernel.retention.batchRecord.monthsAfterQpCertification', batchScope(batch));
      expect(qp.applicable).toBe(false);
      expect(qp.governingMarkets).toEqual([]);
      const mfg = await evaluate('kernel.retention.batchRecord.monthsAfterManufacture', batchScope(batch));
      expect([mfg.resolvedValue, mfg.governingMarkets]).toEqual(['60', ['IN']]);
      expect((await evaluate('kernel.excipient.identityTestEachLot', batchScope(batch))).floorType).toBe('DESIGN');
    }
  });

  it('[IN-52] tablet: 30-minute compression IPC and the IP weight bands, governed by India, for {IN} and {IN, US, EU}', async () => {
    for (const batch of [world.batch.tabletIn, world.batch.tabletAll]) {
      const ipc = await evaluate('tablets.compression.ipcSampleMaxInterval', batchScope(batch));
      expect([ipc.resolvedValue, ipc.governingMarkets, ipc.resolution.unit]).toEqual(['30', ['IN'], 'min']);
      const bands = await evaluate('tablets.uniformity.acceptanceCriteria', batchScope(batch));
      const ip = bands.resolution.components?.find((c) => (c.value as { id: string }).id === 'IP_UNIFORMITY_OF_WEIGHT_BANDS');
      expect(ip?.markets).toEqual(['IN']);
    }
    const all = await evaluate('tablets.uniformity.acceptanceCriteria', batchScope(world.batch.tabletAll));
    expect(all.resolution.components?.map((c) => [(c.value as { id: string }).id, c.markets])).toEqual([
      ['IP_UNIFORMITY_OF_WEIGHT_BANDS', ['IN']],
      ['PH_EUR_2_9_40_UNIFORMITY_OF_DOSAGE_UNITS', ['EU']],
      ['USP_905_UNIFORMITY_OF_DOSAGE_UNITS', ['US']],
    ]);
  });

  it('[IN-52] injectable {IN, US, EU}: any contaminated APS unit fails, Grade A viable no growth, PUPSIT and a single-batch filter', async () => {
    const b = batchScope(world.batch.injectableAll);
    const aps = await evaluate('sterile.aps.acceptance', b);
    expect([aps.resolvedValue, aps.governingMarkets, aps.floorType]).toEqual(['ANY_CONTAMINATED_UNIT_FAILS', ['EU', 'IN', 'US'], 'HARD']);
    const viable = await evaluate('sterile.viable.gradeA.acceptance', b);
    expect([viable.resolvedValue, viable.governingMarkets]).toEqual(['NO_GROWTH', ['EU']]);
    const pupsit = await evaluate('sterile.filter.preUseTestAfterSterilisation', b);
    expect([pupsit.resolvedValue, pupsit.governingMarkets]).toEqual([true, ['EU']]);
    const single = await evaluate('sterile.filter.singleBatchUse', b);
    expect([single.resolvedValue, single.governingMarkets]).toEqual([true, ['EU']]);
  });

  it('[IN-52] injectable {IN}: APS still fails on any contaminated unit (Decision 2); no PUPSIT or single-batch rule from India', async () => {
    const b = batchScope(world.batch.injectableIn);
    expect((await evaluate('sterile.aps.acceptance', b)).resolvedValue).toBe('ANY_CONTAMINATED_UNIT_FAILS');
    expect((await evaluate('sterile.viable.gradeA.acceptance', b)).resolvedValue).toBe('BELOW_1_CFU_PER_SAMPLE');
    expect((await evaluate('sterile.filter.preUseTestAfterSterilisation', b)).resolvedValue).toBe(false);
    expect((await evaluate('sterile.filter.singleBatchUse', b)).resolvedValue).toBe(false);
  });

  it('[IN-52] the retention predicate branch follows the product licence: Form 25 tablet vs Form 28 injectable test records', async () => {
    const tablet = await evaluate('kernel.retention.testRecord.monthsAfterExpiry', batchScope(world.batch.tabletIn));
    expect([tablet.resolvedValue, tablet.predicateBranch]).toEqual(['12', { IN: {} }]);
    const injectable = await evaluate('kernel.retention.testRecord.monthsAfterExpiry', batchScope(world.batch.injectableIn));
    expect([injectable.resolvedValue, injectable.predicateBranch]).toEqual(['24', { IN: { expiryLabelled: true, licenceForm: 'FORM_28' } }]);
    expect(injectable.predicates).toMatchObject({ licenceForm: 'FORM_28', expiryLabelled: true });
  });

  it('[IN-52] the resolution log of a batch holds one stored evaluation per resolution, each naming its governing market(s)', async () => {
    const log = await listEvaluations(db.app, world.batch.tabletAll);
    expect(log.length).toBeGreaterThan(0);
    for (const e of log) {
      if (e.applicable) expect(e.governingMarkets.length).toBeGreaterThan(0);
      expect(e.tableVersion).toBe(1);
      expect(e.inputsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(e.resolution.inputs.marketSet).toEqual(e.marketSet);
    }
  });

  it('[IN-52] a tablets key cannot be resolved for an injectables scope, nor a sterile key for a tablets scope', async () => {
    await expect(evaluate('tablets.compression.ipcSampleMaxInterval', batchScope(world.batch.injectableAll))).rejects.toThrow('EBMR-MKT-054');
    await expect(evaluate('sterile.aps.acceptance', batchScope(world.batch.tabletAll))).rejects.toThrow('EBMR-MKT-054');
  });

  it('[IN-52] a scope cannot override a predicate its product fixes', async () => {
    await expect(
      evaluate('kernel.retention.testRecord.monthsAfterExpiry', batchScope(world.batch.injectableIn), { predicates: { licenceForm: 'FORM_25' } }),
    ).rejects.toThrow('EBMR-MKT-055');
  });
});

describe('scopes: union of markets for lines, rooms, equipment and persons; per consuming batch for lots', () => {
  it('[IN-52] a LINE takes the union of the markets of every product qualified on it', async () => {
    const e = await evaluate('tablets.compression.ipcSampleMaxInterval', { kind: 'LINE', id: world.line.tablets }, { resolutionPoint: 'LINE_QUALIFICATION' });
    expect(e.marketSet).toEqual(['EU', 'IN', 'US']);
    expect(e.subjectType).toBe('LINE');
    expect(JSON.stringify(e.marketDerivation)).toContain('PRODUCT_QUALIFIED');
  });

  it('[IN-52] EQUIPMENT and ROOM scopes do the same', async () => {
    const press = await evaluate('tablets.compression.stationWiseCheckAtRunStart', { kind: 'EQUIPMENT', id: world.equipment.press });
    expect(press.marketSet).toEqual(['EU', 'IN', 'US']);
    const room = await evaluate('sterile.hepa.gradeAB.leakTestMaxInterval', { kind: 'ROOM', id: world.room.sterile });
    expect([room.marketSet, room.resolvedValue, room.floorType]).toEqual([['EU', 'IN', 'US'], '6', 'HARD']);
  });

  it('[IN-52] a PIC/S-member destination counts as EU for sterile line rules only', async () => {
    const sterileRule = await evaluate('sterile.viable.gradeA.acceptance', { kind: 'LINE', id: world.line.picsOnly });
    expect(sterileRule.marketSet).toEqual(['EU', 'IN']);
    expect(sterileRule.resolvedValue).toBe('NO_GROWTH');
    expect(JSON.stringify(sterileRule.marketDerivation)).toContain('PICS_DESTINATION_COUNTS_AS_EU');
    const kernelRule = await evaluate('kernel.selfInspection.maxIntervalMonths', { kind: 'LINE', id: world.line.picsOnly });
    expect(kernelRule.marketSet).toEqual(['IN']);
    const batch = await evaluate('sterile.viable.gradeA.acceptance', batchScope(world.batch.picsIn));
    expect(batch.marketSet).toEqual(['IN']);
  });

  it('[IN-52] a PERSON takes the union over the lines and rooms the person is qualified for', async () => {
    const e = await evaluate('kernel.dataChange.reasonRequired', { kind: 'PERSON', id: world.person });
    expect(e.marketSet).toEqual(['EU', 'IN', 'US']);
    expect(JSON.stringify(e.marketDerivation)).toContain('PERSON_QUALIFIED');
  });

  it('[IN-52] a MATERIAL_LOT is resolved per consuming batch, and not without one', async () => {
    await expect(evaluate('kernel.excipient.identityTestEachLot', { kind: 'MATERIAL_LOT', id: world.lot })).rejects.toThrow('EBMR-MKT-052');
    const intoIndia = await evaluate('kernel.excipient.identityTestEachLot', { kind: 'MATERIAL_LOT', id: world.lot, consumingBatchId: world.batch.tabletIn }, { resolutionPoint: 'CONSUMPTION' });
    expect([intoIndia.marketSet, intoIndia.governingMarkets, intoIndia.floorType]).toEqual([['IN'], ['IN'], 'DESIGN']);
    const intoAll = await evaluate('kernel.excipient.identityTestEachLot', { kind: 'MATERIAL_LOT', id: world.lot, consumingBatchId: world.batch.tabletAll }, { resolutionPoint: 'CONSUMPTION' });
    expect([intoAll.marketSet, intoAll.floorType]).toEqual([['EU', 'IN', 'US'], 'HARD']);
    expect(intoAll.resolution.hardFloor).toBe(true);
  });

  it('[IN-52] a SITE takes its declared markets plus those of every product qualified at the site', async () => {
    const e = await evaluate('kernel.managementReview.maxIntervalMonths', { kind: 'SITE', id: world.siteId });
    expect(e.marketSet).toEqual(['EU', 'IN', 'US']);
  });

  it('[IN-52] a PACK resolves a per-destination label rule for its own destination', async () => {
    const stated = { method: 'PER_DESTINATION' as const, decisionRef: 'RA-2026-031' };
    const domestic = await evaluate('kernel.label.manufacturingDate', { kind: 'PACK', id: world.pack.tabletAllIn }, { stated });
    expect([domestic.resolvedValue, domestic.governingMarkets]).toEqual(['MANDATORY_UNCODED', ['IN']]);
    const us = await evaluate('kernel.label.manufacturingDate', { kind: 'PACK', id: world.pack.tabletAllUs }, { stated });
    expect([us.resolvedValue, us.governingMarkets]).toEqual(['NOT_REQUIRED', ['US']]);
    await expect(evaluate('kernel.label.manufacturingDate', { kind: 'PACK', id: world.pack.tabletAllUs })).rejects.toThrow('EBMR-MKT-046');
  });

  it('[IN-52] the ResolutionContextProvider port gives the same result with the pure engine as the stored evaluation', async () => {
    const provider = new StubResolutionContext(db.app);
    const { rows } = await db.app.query<{ id: string }>("select id from market.rule_table_version where table_code = 'sterile' and version = 1");
    const snapshot = await loadRuleTableVersion(db.app, rows[0]?.id ?? '');
    const scope: ScopeRef = { kind: 'LINE', id: world.line.picsOnly };
    const { resolution, context } = await resolveForScope(provider, snapshot, 'sterile.viable.gradeA.acceptance', scope, AS_OF);
    const stored = await evaluate('sterile.viable.gradeA.acceptance', scope);
    expect(context.markets).toEqual(['EU', 'IN']);
    expect(resolution).toEqual(stored.resolution);
  });
});

describe('INV-28 in the scope data', () => {
  it('[INV-28] a batch market set without India cannot even be stored', async () => {
    await expect(
      asApp(db, (c) => c.query('insert into market.stub_batch (batch_number, product_id, markets) values ($1, $2, $3)', ['NO-IN', world.tablet, ['US', 'EU']]), {
        roleCode: MARKET_ROLES.stubs,
      }),
    ).rejects.toThrow('EBMR-MKT-001');
    await expect(
      asApp(db, (c) => c.query('update market.stub_batch set markets = $1 where id = $2', [['US'], world.batch.tabletAll]), {
        reasonCode: 'MARKET_CHANGE',
        roleCode: MARKET_ROLES.stubs,
      }),
    ).rejects.toThrow('EBMR-MKT-001');
  });

  it('[INV-28] a pack cannot go to a destination outside its batch market set', async () => {
    await expect(
      asApp(db, (c) => c.query('insert into market.stub_pack (code, batch_id, destination) values ($1, $2, $3)', ['PK-X', world.batch.tabletIn, 'US']), {
        roleCode: MARKET_ROLES.stubs,
      }),
    ).rejects.toThrow('EBMR-MKT-050');
  });
});
