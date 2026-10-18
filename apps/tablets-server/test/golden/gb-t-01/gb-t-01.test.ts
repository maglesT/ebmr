/**
 * The golden batch GB-T-01 (outline 9.1 "Golden batches"; Phase 3 slice 6d; D-S6-5 to D-S6-7): the approved GB-T-01
 * master, a source batch, and the happy and exception-rich variants driven over HTTP as the seeded personas, on a frozen
 * database clock. Each batch's outputs must equal expected.json exactly: the hand worksheet's quantities and yields
 * (never changed to make a run pass), and the states, exceptions, genealogy, signature count and the hash of the
 * normalised true copy recorded from the first reviewed run (README.md).
 *
 * Set EBMR_GOLDEN_DUMP to a file path to write the run's outputs there (for a review of a changed run).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { routes } from '@ebmr/api-contract';
import { Dec } from '@ebmr/expr';
import { valueOf } from '../../esig/support.ts';
import { advanceMinutes, FAKETIME_FILE, freezeAt, goldenClockAvailable } from '../clock.ts';
import { masterNegatives, type MasterNegatives } from './negatives.ts';
import { setUpPlant } from './plant.ts';
import { resultsOf, type BatchResults } from './results.ts';
import type { RunReport } from '../../../src/analytics/runner.ts';
import { expectRunnerBeside } from '../analytics-check.ts';
import { planAll, runSource, runVariant, SOURCE_AGE_MINUTES } from './scenario.ts';
import { startGoldenWorld, type GoldenWorld } from './world.ts';
import { DRUMS, ORDER_PLAN, PRODUCT_TESTS, RESERVE_PACKS, runContinuation, TIMINGS, type Continuation } from './release.ts';
import { lotFacts, orderFacts, trueCopyReading, type LotFacts, type OrderFacts } from './release-results.ts';
import { vendorNames } from '../vendor-identity.ts';
import type { GoldenBatch } from './driver.ts';

type Json = Record<string, unknown>;
const expected = JSON.parse(readFileSync(new URL('./expected.json', import.meta.url), 'utf8')) as Json & {
  dispensing: Json & { compensatingExcipient: Record<string, string>; fixed: Record<string, string>; lostInProcessing: Record<string, string> };
  theoretical: Record<string, string>;
  granulation: { driedGranules: string[]; yieldPercent: string };
  recovery: Record<string, string | number>;
  blending: Record<string, string>;
  compression: Record<string, string>;
  coating: Record<string, string>;
  inspection: Record<string, string>;
  fromTheRun: Json & { master: Json; happy: RunExpectation; exceptionRich: RunExpectation };
};
/** The continuation to the release (Phase 4 slice 7b): its own file, recorded once; GB-T-01's outputs above never move. */
const release = JSON.parse(readFileSync(new URL('./expected-release.json', import.meta.url), 'utf8')) as {
  worksheet: Json & { order: Json; lot: Json; drums: string[] };
  fromTheRun: { orders: Json[]; lots: Json[] };
};

interface RunExpectation {
  states: { batch: string; stages: Record<string, string>; containers: Record<string, string>; notCompleted: string[] };
  exceptions: Record<string, number>;
  consumptions: string[];
  containers: string[];
  signatures: number;
  notes: Json;
  normalisedTrueCopySha256: string;
}

/** `v` rounded half up to the decimals of the worksheet's figure `shown`. */
const asShown = (v: string | string[] | undefined, shown: string): string => {
  const places = shown.includes('.') ? shown.length - shown.indexOf('.') - 1 : 0;
  return Dec.parse(String(v)).toFixed(places, 'HALF_UP');
};
const same = (a: string | string[] | undefined, b: string): boolean => Dec.parse(String(a)).eq(Dec.parse(b));

/** The exceptions of a run counted by type, severity and disposition. */
const exceptionCounts = (r: BatchResults): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const e of r.exceptions) {
    const k = `${e.type} ${e.severity} ${e.disposition ?? e.status}${e.deviation ? ' +deviation' : ''}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

/** Whole days to start the golden clock after the next midnight (EBMR_GOLDEN_LATER_DAYS; 0 when unset). */
function laterDays(): number {
  const text = process.env['EBMR_GOLDEN_LATER_DAYS'] ?? '0';
  if (!/^\d{1,4}$/.test(text)) throw new Error(`EBMR_GOLDEN_LATER_DAYS must be a whole number of days, not ${JSON.stringify(text)}`);
  return Number(text);
}

describe.runIf(goldenClockAvailable)('GB-T-01, the tablets golden batch', () => {
  let w: GoldenWorld;
  let negatives: MasterNegatives;
  const run: { happy?: BatchResults; exception?: BatchResults; notes?: { happy: Json; exception: Json }; happyBatch?: GoldenBatch; numbers?: string[]; start?: bigint; analytics?: RunReport[]; analyticsBatches?: string[] } = {};
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    w = await startGoldenWorld();
    await setUpPlant(w);
  }, 1_800_000);
  afterAll(async () => {
    vi.useRealTimers();
    await w?.close();
    // The next run starts on a running clock again (this cluster's databases are dropped with the run).
    writeFileSync(FAKETIME_FILE, '+0s\n');
  });

  it('the approved master is effective for the seeded ERP orders in planning', async () => {
    const orders = valueOf(await w.b['issuer']!.call(routes.planning.orders)).orders.filter((o) => o.productCode === 'GBT01-250');
    expect(orders.map((o) => [o.orderNo, o.match?.versionId ?? o.noMatch])).toEqual([
      ['PO-GBT01-0001', w.versionId],
      ['PO-GBT01-0002', w.versionId],
    ]);
  });

  it('[PR-02] the master is approved only after its check, by someone other than its author, on the revision shown', () => {
    expect(w.masterChecks).toEqual(expected.fromTheRun.master['approval']);
  });

  it('[PR-08][PR-19][PR-47] the sample data problems are caught on the master (9.1): hardness units, a hydrate label, an addition without its case', async () => {
    negatives = await masterNegatives(w);
    const brief = (fs: { rule: string; severity: string }[]) => fs.map((f) => `${f.rule} ${f.severity}`);
    expect({
      hardnessAlias: brief(negatives.hardnessAlias),
      hardnessPressure: brief(negatives.hardnessPressure),
      hardnessKpa: brief(negatives.hardnessKpa),
      trihydrate: brief(negatives.trihydrate),
      additionWithoutCase: brief(negatives.additionWithoutCase),
    }).toEqual(expected.fromTheRun.master['negatives']);
  }, 600_000);

  it('runs the source batch, then 41 days later the happy and exception-rich variants to the release for packing', async () => {
    const p = await planAll(w);
    // The clock is frozen at the next midnight UTC (the same time of day on every run): each act then happens at an
    // instant fixed by the driver's sequence. EBMR_GOLDEN_LATER_DAYS starts it that many whole days later still, to show
    // that the hashes do not depend on the day of the run.
    const start = BigInt(Math.floor(Date.now() / 1000 / 86_400) + 1 + laterDays()) * 86_400n;
    freezeAt(start);
    const { residue } = await runSource(w, p.source);
    advanceMinutes(SOURCE_AGE_MINUTES);
    await runVariant(w, p.happy, 'HAPPY', residue);
    await runVariant(w, p.exception, 'EXCEPTION_RICH', residue);
    const numbers = [p.happy.batchNumber, p.exception.batchNumber, p.source.batchNumber];
    // The analytics runner, on all along, runs once more over the completed batches before their outputs are read.
    run.analytics = await w.analytics();
    run.analyticsBatches = [p.happy.batchId, p.exception.batchId, p.source.batchId];
    run.happy = await resultsOf(w, p.happy.batchId, numbers, start * 1_000_000n);
    run.exception = await resultsOf(w, p.exception.batchId, numbers, start * 1_000_000n);
    run.notes = { happy: p.happy.notes, exception: p.exception.notes };
    run.happyBatch = p.happy;
    run.numbers = numbers;
    run.start = start;
    const dump = process.env['EBMR_GOLDEN_DUMP'];
    if (dump) writeFileSync(dump, JSON.stringify({ notes: run.notes, happy: run.happy, exception: run.exception, negatives, masterChecks: w.masterChecks }, null, 1));
    expect(run.happy.states.batch).toBe('EXECUTION_COMPLETE');
    expect(run.exception.states.batch).toBe('EXECUTION_COMPLETE');
  }, 3_600_000);

  it('[DI-51] the golden batches keep their exact outputs with the analytics runner on', async () => {
    // The exact outputs are this file's own assertions on this run; here, the runner ran over these very batches.
    if (!run.happy || !run.exception) throw new Error('the scenario did not run');
    await expectRunnerBeside(w, run.analytics, run.analyticsBatches ?? []);
  });

  describe.each([
    ['happy', () => run.happy, () => expected.fromTheRun.happy, () => run.notes?.happy],
    ['exception-rich', () => run.exception, () => expected.fromTheRun.exceptionRich, () => run.notes?.exception],
  ] as const)('the %s variant', (_name, result, want, notes) => {
    const r = (): BatchResults => {
      const x = result();
      if (!x) throw new Error('the scenario did not run');
      return x;
    };

    it('[PR-19][DI-33] dispenses the worksheet\'s salt-to-base potency quantities and the compensating excipient', () => {
      const d = expected.dispensing;
      const calc = r().dispensing as Json & { active: Json; excipient: Json; results: Json[] };
      const lot = calc.results[0] ?? {};
      expect({
        factor: calc.active['factor'],
        standard: calc.active['standard'],
        asIs: lot['asIsAssay'],
        calculated: lot['calculated'],
        target: lot['target'],
        mccCalculated: calc.excipient['calculated'],
        mccTarget: calc.excipient['target'],
        adjustment: calc['adjustmentPercent'],
      }).toEqual({
        factor: d['saltFactor'],
        standard: d['apiStandardForm'],
        asIs: d['apiAsIsAssay'],
        calculated: d['apiCalculated'],
        target: d['apiTarget'],
        mccCalculated: d.compensatingExcipient['calculated'],
        mccTarget: d.compensatingExcipient['target'],
        adjustment: d['adjustmentPercent'],
      });
      const v = r().values;
      expect(same(v['dispApi@p-disp-api@'], String(d['apiTarget']))).toBe(true);
      expect(same(v['dispMcc@p-disp-api@'], d.compensatingExcipient['target'] ?? '')).toBe(true);
      const fixed: Record<string, string> = { 'MAT-LAC-MH': 'dispLac', 'MAT-PVP-K30': 'dispPvp', 'MAT-CCS': 'dispCcs', 'MAT-SIO2': 'dispSio', 'MAT-MGST': 'dispMgs' };
      for (const [m, item] of Object.entries(fixed)) expect(same(v[`${item}@p-disp-exc@`], d.fixed[m] ?? ''), m).toBe(true);
      expect(same(v['dispIpa@p-disp-exc@'], d.lostInProcessing['MAT-IPA'] ?? '')).toBe(true);
    });

    it('[IN-17][PR-31] records the worksheet\'s quantities and yields at every stage, (A + B)/T beside A/T', () => {
      const v = r().values;
      const e = expected;
      expect(same(v['intraSolids@p-gran-yield@'], e.theoretical['intragranularSolids'] ?? '')).toBe(true);
      expect([v['granNet@p-gran-out@R-GRAN=1'], v['granNet@p-gran-out@R-GRAN=2']].map((x, i) => same(x, e.granulation.driedGranules[i] ?? ''))).toEqual([true, true]);
      expect(asShown(v['granYield@p-gran-yield@'], e.granulation.yieldPercent)).toBe(e.granulation.yieldPercent);
      expect(same(v['recAdded@p-rework@'], String(e.recovery['added']))).toBe(true);
      expect(same(v['blendIn@p-blend-yield@'], e.blending['input'] ?? '')).toBe(true);
      expect(same(v['blendNet@p-blend-out@'], e.blending['output'] ?? '')).toBe(true);
      expect(asShown(v['blendYield@p-blend-yield@'], e.blending['yieldPercent'] ?? '')).toBe(e.blending['yieldPercent']);
      const c = e.compression;
      expect(same(v['compGood@p-comp-yield@'], c['goodCores'] ?? '')).toBe(true);
      expect(same(v['compResidue@p-comp-yield@'], c['reusableResidue'] ?? '')).toBe(true);
      expect(same(v['compRejects@p-comp-yield@'], c['rejects'] ?? '')).toBe(true);
      expect(same(v['compT@p-comp-yield@'], c['theoretical'] ?? '')).toBe(true);
      expect(asShown(v['compYield@p-comp-yield@'], c['goodOutputYieldPercent'] ?? '')).toBe(c['goodOutputYieldPercent']);
      expect(asShown(v['compYieldAB@p-comp-yield@'], c['yieldWithResidueAplusBoverT'] ?? '')).toBe(c['yieldWithResidueAplusBoverT']);
      expect(asShown(v['compAcc@p-comp-yield@'], c['accountabilityPercent'] ?? '')).toBe(c['accountabilityPercent']);
      expect(same(v['coatedNet@p-coat-out@'], e.coating['coatedTablets'] ?? '')).toBe(true);
      expect(asShown(v['coatGain@p-coat-gain@'], e.coating['weightGainPercent'] ?? '')).toBe(e.coating['weightGainPercent']);
      expect(same(v['acceptedNet@p-insp@'], e.inspection['accepted'] ?? '')).toBe(true);
    });

    it('[PR-47][IN-19][PR-57] adds the case-2 residue of the source batch within its caps, and holds the genealogy of every lot', () => {
      const g = r().genealogy;
      expect(g.additions.map((a) => a.replace(/^\S+ /, '<source> '))).toEqual([`<source> INSPECTION ${Dec.parse(String(expected.recovery['added'])).toString()} kg`]);
      expect(Dec.parse(String(expected.recovery['added'])).lte(Dec.parse(String(expected.recovery['capThreePercent'])))).toBe(true);
      expect(g.consumptions).toEqual(want().consumptions);
      expect(g.containers).toEqual(want().containers);
      expect(g.containers).toContain(`INSPECTION/- ${Dec.parse(expected.inspection['rejectsDestroyed'] ?? '').toString()}`);
    });

    it('ends in the expected states, with the expected exceptions and dispositions', () => {
      // Every step completed but those of the branches not taken.
      const notCompleted = Object.entries(r().states.steps)
        .filter(([, s]) => s !== 'COMPLETED')
        .map(([k, s]) => `${k} ${s}`);
      expect({ batch: r().states.batch, stages: r().states.stages, containers: r().states.containers, notCompleted }).toEqual(want().states);
      expect(exceptionCounts(r())).toEqual(want().exceptions);
      expect(r().exceptions.filter((e) => e.status !== 'CLOSED' && e.disposition === null)).toEqual([]);
    });

    it('refuses the negatives the variant tries on the batch', () => {
      expect(JSON.parse(JSON.stringify(notes() ?? {}))).toEqual(want().notes);
    });

    it('has the expected number of signatures and the hash of its normalised true copy', () => {
      expect(r().signatures).toBe(want().signatures);
      expect(r().trueCopy.sha256).toBe(want().normalisedTrueCopySha256);
    });

    it('its batch record carries the manufacturer\'s identity only: no Batchwright and no Medhanta in its normalised true copy (decision 0020, D-P7-11)', () => {
      expect(vendorNames(r().trueCopy.normalised)).toEqual([]);
    });
  });

  // Phase 4 slice 7b (D-P4-15): GB-T-01 continued from the release for packing to the release. Its outputs are recorded in
  // expected-release.json; nothing it does comes before the outputs above are read.
  describe('continued to the release: two blister orders from one bulk', () => {
    const cont: { c?: Continuation; orders: BatchResults[]; facts: OrderFacts[]; lots: LotFacts[]; units: string[][]; vendorNames: string[] } = { orders: [], facts: [], lots: [], units: [], vendorNames: [] };
    const c = (): Continuation => {
      if (!cont.c) throw new Error('the continuation did not run');
      return cont.c;
    };

    it('packs the happy variant\'s bulk in two blister orders, reviews the records, tests and samples the lots and releases them through G-REL', async () => {
      const happy = run.happyBatch;
      if (!happy || !run.numbers || run.start === undefined) throw new Error('the scenario did not run');
      cont.c = await runContinuation(w, happy);
      const numbers = [...run.numbers, ...cont.c.orders.map((o) => o.batchNumber)];
      const qa = await w.server.asPersona('qaInvestigator');
      for (const o of cont.c.orders) {
        cont.orders.push(await resultsOf(w, o.batchId, numbers, run.start * 1_000_000n));
        cont.facts.push(await orderFacts(w, o.batchId));
        const reading = await trueCopyReading(qa, o.batchId, ['BLISTER-01', 'CTN-01', 'BAL-PL-01', 'PL-1']);
        cont.units.push(reading.units);
        cont.vendorNames.push(...reading.vendorNames);
      }
      for (const l of cont.c.lots) cont.lots.push(await lotFacts(w, l.lotId, numbers));
      const dump = process.env['EBMR_GOLDEN_DUMP'];
      if (dump) writeFileSync(dump.replace(/(\.json)?$/, '-release.json'), JSON.stringify({ orders: cont.orders, facts: cont.facts, lots: cont.lots, units: cont.units, grel: cont.c.grel, timings: TIMINGS }, null, 1));
      expect(cont.c.decisions).toEqual(['RELEASED', 'RELEASED']);
    }, 3_600_000);

    it('[IN-16][INV-27][PR-34][L-30] two packaging records of the one bulk batch: each linked to it, each started on its own verified PACKAGING_ORDER clearance of the line, the line and its units cleaned between them', () => {
      const happy = run.happyBatch?.batchNumber ?? '';
      expect(cont.facts.map((f) => f.parent)).toEqual([happy, happy]);
      expect(cont.facts.map((f) => f.clearance)).toEqual(['PACKAGING_ORDER PASSED VERIFIED', 'PACKAGING_ORDER PASSED VERIFIED']);
      expect(cont.facts.map((f) => f.bulkIssued)).toEqual(release.worksheet['bulkIssued']);
      expect(c().drums.length).toBe(DRUMS.length);
    });

    it('[IN-17][PR-39][PR-31][PR-37] each order reconciles its printed foil and cartons with nothing unexplained, packs the worksheet\'s cartons into shippers and reaches the worksheet\'s packaging yield', () => {
      const o = release.worksheet.order;
      for (const [i, f] of cont.facts.entries()) {
        expect(f.reconciliations, `order ${String(i + 1)}`).toEqual(o['reconciliations']);
        expect({ packs: f.shipperPacks, shippers: f.shippers }).toEqual({ packs: ORDER_PLAN.packs, shippers: o['shippers'] });
        const v = cont.orders[i]?.values ?? {};
        expect(Dec.parse(String(v['packYield@p-pk-yield@'])).toFixed(2, 'HALF_UP')).toBe(o['packYield']);
        expect([v['tabletsIssued@p-pk-count@'], v['tabletsPacked@p-pk-count@']].map((x) => Dec.parse(String(x)).toString())).toEqual([ORDER_PLAN.tabletsIssued, ORDER_PLAN.tabletsPacked]);
      }
    });

    it('[PR-22] the batch report of each order (its PDF/A-3 true copy) names the line and the units it ran on', () => {
      expect(cont.units).toEqual([['BLISTER-01', 'CTN-01', 'BAL-PL-01', 'PL-1'], ['BLISTER-01', 'CTN-01', 'BAL-PL-01', 'PL-1']]);
    });

    it('each order\'s record and its PDF/A-3 true copy carry the manufacturer\'s identity only: no Batchwright and no Medhanta (decision 0020, D-P7-11)', () => {
      expect(cont.orders).toHaveLength(2);
      expect([...cont.orders.flatMap((o) => vendorNames(o.trueCopy.normalised)), ...cont.vendorNames]).toEqual([]);
    });

    it('[INV-05][IN-05][PR-45][PR-44][PR-53] each finished lot: the worksheet\'s packs, release results approved by the head of QC, reserve samples, G-REL for India green with every item read from signed records, RELEASED by the AP', () => {
      const l = release.worksheet.lot;
      for (const x of cont.lots) {
        expect(x.quantity).toBe(`${ORDER_PLAN.packs} packs`);
        expect(x.results).toEqual(PRODUCT_TESTS.map((t) => `${t.testCode} ${t.result} ${t.unit} PASS APPROVED`).sort());
        expect(x.samples).toEqual([`RESERVE ${RESERVE_PACKS} packs`]);
        expect(x.state).toBe(l['state']);
      }
      expect(cont.lots).toEqual(release.fromTheRun.lots);
    });

    it.each([0, 1])('order %i ends in the expected states, exceptions and dispositions, with its signature count and the hash of its normalised true copy', (i) => {
      const x = cont.orders[i];
      if (!x) throw new Error('the continuation did not run');
      const want = release.fromTheRun.orders[i] as Json;
      const notCompleted = Object.entries(x.states.steps).filter(([, st]) => st !== 'COMPLETED').map(([k, st]) => `${k} ${st}`);
      expect({ batch: x.states.batch, stages: x.states.stages, containers: x.states.containers, notCompleted }).toEqual(want['states']);
      expect(exceptionCounts(x)).toEqual(want['exceptions']);
      expect(x.genealogy.consumptions).toEqual(want['consumptions']);
      expect(x.signatures).toBe(want['signatures']);
      expect(x.trueCopy.sha256).toBe(want['normalisedTrueCopySha256']);
    });
  });
});
