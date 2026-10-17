/**
 * The golden batch GB-T-03, "connected" (Phase 6 slice 6j-b; D-P6-7; README.md): GB-T-02's direct-compression product
 * made, packed in serialised HDPE bottles and released for India and the US at a site whose ERP/WMS, LMS, CMMS and
 * serialisation L3/L4 systems feed the eBMR through its adapters as MIRROR data, with an OPC UA press behind the site
 * gateway; then a mock recall from its API lot to the consignees of the ERP's shipments, signed off by the AP. Every
 * output must equal expected.json: the hand worksheet's quantities, yields and serial counts (README.md, never changed to
 * make a run pass), and the states, exceptions, genealogy, signature counts, what each adapter landed and the hashes of
 * the normalised true copies and of the normalised mock recall, recorded from the first reviewed run (D-S6-7).
 *
 * Set EBMR_GOLDEN_DUMP to a file path to write the run's outputs there (for a review of a changed run).
 */
import type { RunReport } from '../../../src/analytics/runner.ts';
import { expectRunnerBeside } from '../analytics-check.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { Dec, sha256Hex } from '@ebmr/expr';
import { FAKETIME_FILE, freezeAt, goldenClockAvailable } from '../clock.ts';
import { setUpPlant } from '../gb-t-01/plant.ts';
import { normalise, resultsOf, type BatchResults } from '../gb-t-01/results.ts';
import { startGoldenWorld, type GoldenWorld } from '../gb-t-01/world.ts';
import { lotFacts, orderFacts, type LotFacts, type OrderFacts } from '../gb-t-01/release-results.ts';
import { BLEND, COMPRESSION } from '../gb-t-02/scenario.ts';
import { connect, GOLDEN_CLOCK_LIB, MIRRORED_CLASSES, type Connected } from './connected.ts';
import { ACK, connectPress, type PressFacts, type PressRig } from './opcua.ts';
import { BOTTLE_PLAN, CALIBRATED, LMS_TRAINING, packReleaseAndRecall, PERFORMERS, runBatch, SERIALS, setUpGbt03, type Gbt03Release } from './scenario.ts';

type Json = Record<string, unknown>;
const expected = JSON.parse(readFileSync(new URL('./expected.json', import.meta.url), 'utf8')) as Json & {
  worksheet: Json & { dispensing: Record<string, string>; blending: Record<string, string>; compression: Record<string, string>; bottling: Record<string, string>; serials: Record<string, string> };
  fromTheRun: { batch: Json; order: Json; lot: Json; release: Json; serialisation: Json; connected: Json; press: Json; recall: Json };
};

/** What the adapters landed: accepted messages by type, refusals and integration alarms, and each mirror's state. */
interface ConnectedFacts {
  accepted: Record<string, number>;
  refused: number;
  alarms: number;
  mirrors: Record<string, string>;
  lms: { qualifications: number; performers: number };
  cmms: { calibrations: number; workOrders: number };
}

async function connectedFacts(w: GoldenWorld, cx: Connected): Promise<ConnectedFacts> {
  const codes = Object.values(cx.adapters).map((a) => a.id.code);
  const q = async <T,>(sql: string, p: unknown[] = []): Promise<T> => (await w.server.db.admin.query<{ r: T }>(sql, p)).rows[0]?.r as T;
  const accepted = await q<Record<string, number>>(
    "select coalesce(jsonb_object_agg(message_type, n), '{}'::jsonb) as r from (select message_type, count(*)::int as n from platform.inbound_message where adapter_code = any ($1) group by 1 order by 1) x", [codes]);
  const mirrors: Record<string, string> = {};
  for (const cls of MIRRORED_CLASSES) {
    const f = await q<Json>('select platform.mirror_freshness($1) as r', [cls]);
    mirrors[cls] = `${String(f['mode'])} ${f['stale'] === true ? 'STALE' : 'FRESH'}`;
  }
  return {
    accepted: Object.fromEntries(Object.entries(accepted).sort(([a], [b]) => a.localeCompare(b))),
    refused: await q<number>("select count(*)::int as r from platform.inbound_exception where adapter_code = any ($1) and kind = 'REFUSED'", [codes]),
    alarms: await q<number>('select count(*)::int as r from platform.integration_alarm where adapter_code = any ($1)', [codes]),
    mirrors,
    lms: {
      qualifications: await q<number>("select count(*)::int as r from iam.person_qualification where source_code = 'LMS' and qualification_code = $1 and withdrawn_at is null", [LMS_TRAINING]),
      performers: Object.keys(PERFORMERS).length,
    },
    cmms: {
      calibrations: await q<number>("select count(*)::int as r from plant.calibration where reference like 'CMMS-CAL-%'"),
      workOrders: await q<number>("select count(distinct work_order)::int as r from plant.cmms_work_order where work_order like 'CMMS-WO-%'"),
    },
  };
}

/** `text` with each of the scenario's batch numbers replaced by its ordinal (results.ts normalise does the same). */
const numbered = (text: string, numbers: readonly string[]): string => numbers.reduce((t, b, i) => t.split(b).join(`<batch-${String(i + 1)}>`), text);

const SHOWN_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const SHOWN_DATE = /\b(\d{2})-(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-(\d{4})\b/g;

/**
 * `v` with the calendar date of each instant as shown at the site ("18-OCT-2026 08:15:13 +05:30 (Asia/Kolkata)") replaced
 * by its day from the run's start day (`startUs`, a UTC midnight): the start is the next midnight on the day the run
 * happens (D-S6-6), so the shown date is new on every day; the time, offset and zone are kept (D-P6j-b-7).
 */
const startDayShown = (v: unknown, startUs: bigint): unknown => {
  const startDay = startUs / 86_400_000_000n;
  const day = (_: string, d: string, m: string, y: string): string =>
    `<day+${String(BigInt(Date.UTC(Number(y), SHOWN_MONTHS.indexOf(m), Number(d)) / 86_400_000) - startDay)}>`;
  const walk = (x: unknown): unknown =>
    typeof x === 'string' ? x.replace(SHOWN_DATE, day) : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x as Json).map(([k, y]) => [k, walk(y)])) : x;
  return walk(v);
};

/** The mock recall as compared: its facts, and the SHA-256 of the whole view normalised as a true copy is. */
function recallFacts(recall: Json, start: bigint, numbers: readonly string[]): Json {
  const lots = (recall['lots'] as Json[] | undefined) ?? [];
  const consignees = (recall['consignees'] as Json[] | undefined) ?? [];
  // resultSha256 is the digest of the stored result with its identifiers, new on every run ("reproduces" checks it): left out.
  const view = Object.fromEntries(Object.entries(recall).filter(([k]) => k !== 'resultSha256'));
  const normalised = normalise(startDayShown(view, start), start, numbers, start);
  return {
    subjectRef: recall['subjectRef'], queryVersion: recall['queryVersion'], reproduces: recall['reproduces'], counts: recall['counts'],
    federation: recall['federation'], authorityInformed: recall['authorityInformed'],
    // A finished lot's code carries its batch number (with the year): by its ordinal, as in the normalised copy.
    lots: lots.map((l) => numbered(`${String(l['lotCode'] ?? l['lotId'])} ${String(l['delivered'])} ${String(l['returned'])} ${String(l['outstanding'])} ${String(l['unit'])}`, numbers)),
    consignees: consignees.map((c) => `${String(c['consigneeCode'])} ${JSON.stringify(c['markets'])}`),
    signedOffBy: (recall['signOff'] as { signedBy?: { role?: string } } | null)?.signedBy?.role ?? null,
    normalisedSha256: sha256Hex(normalised),
  };
}

describe.runIf(goldenClockAvailable && GOLDEN_CLOCK_LIB !== '')('GB-T-03, connected: mirrors, an OPC UA press, serialisation and a mock recall', () => {
  let w: GoldenWorld;
  let cx: Connected;
  let press: PressRig | undefined;
  const run: { batch?: BatchResults; order?: BatchResults; orderFacts?: OrderFacts; lot?: LotFacts; rel?: Gbt03Release; connected?: ConnectedFacts; press?: PressFacts; recall?: Json ; analytics?: RunReport[]; analyticsBatches?: string[] } = {};
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    w = await startGoldenWorld();
    await setUpPlant(w);
    cx = await connect(w);
    press = await connectPress(w);
  }, 1_800_000);
  afterAll(async () => {
    vi.useRealTimers();
    await press?.close();
    await cx?.close();
    await w?.close();
    writeFileSync(FAKETIME_FILE, '+0s\n');
  });

  it('runs the connected batch, the serialised bottle order, the release for India and the US, the shipments and the mock recall', async () => {
    const masters = await setUpGbt03(w, cx);
    const later = Number(/^\d{1,4}$/.test(process.env['EBMR_GOLDEN_LATER_DAYS'] ?? '') ? process.env['EBMR_GOLDEN_LATER_DAYS'] : '0');
    const start = BigInt(Math.floor(Date.now() / 1000 / 86_400) + 1 + later) * 86_400n;
    freezeAt(start);
    if (!press) throw new Error('the OPC UA press did not start');
    const { batch, bulk } = await runBatch(w, cx, masters, press);
    run.press = await press.facts(batch.batchId);
    const rel = await packReleaseAndRecall(w, cx, masters, batch, bulk);
    const numbers = [batch.batchNumber, rel.order.batchNumber];
    // The analytics runner, on all along, runs once more over the completed batches before their outputs are read.
    run.analytics = await w.analytics();
    run.analyticsBatches = [batch.batchId, rel.order.batchId];
    run.batch = await resultsOf(w, batch.batchId, numbers, start * 1_000_000n);
    run.order = await resultsOf(w, rel.order.batchId, numbers, start * 1_000_000n);
    run.orderFacts = await orderFacts(w, rel.order.batchId);
    run.lot = await lotFacts(w, rel.lot.lotId, numbers);
    run.rel = rel;
    run.connected = await connectedFacts(w, cx);
    run.recall = recallFacts(rel.recall, start * 1_000_000n, numbers);
    const dump = process.env['EBMR_GOLDEN_DUMP'];
    if (dump) {
      writeFileSync(dump, JSON.stringify({
        batch: run.batch, order: run.order, orderFacts: run.orderFacts, lot: run.lot, connected: run.connected, press: run.press, recall: run.recall,
        rel: { ...rel, order: rel.order.batchNumber, recall: rel.recall },
      }, null, 1));
    }
    expect(run.batch.states.batch).toBe('EXECUTION_COMPLETE');
    expect(run.order.states.batch).toBe('EXECUTION_COMPLETE');
  }, 3_600_000);

  it('[DI-51] the golden batches keep their exact outputs with the analytics runner on', async () => {
    // The exact outputs are this file's own assertions on this run; here, the runner ran over these very batches.
    if (!run.batch) throw new Error('the scenario did not run');
    await expectRunnerBeside(w, run.analytics, run.analyticsBatches ?? []);
  });

  const r = (k: 'batch' | 'order'): BatchResults => {
    const x = run[k];
    if (!x) throw new Error('the scenario did not run');
    return x;
  };
  const same = (a: string | string[] | undefined, b: string): boolean => Dec.parse(String(a)).eq(Dec.parse(b));
  const asShown = (v: string | string[] | undefined, shown: string): string => Dec.parse(String(v)).toFixed(shown.includes('.') ? shown.length - shown.indexOf('.') - 1 : 0, 'HALF_UP');

  it('[IN-17][PR-31] dispenses, blends and compresses the worksheet\'s quantities, with its yields', () => {
    const v = r('batch').values;
    const ws = expected.worksheet;
    for (const [item, net] of Object.entries(ws.dispensing)) expect(same(v[`${item}@p-disp-exc@`], net), item).toBe(true);
    expect(same(v['blendNet@p-blend-out@'], BLEND)).toBe(true);
    expect(asShown(v['dispRecon@p-disp-recon@'], ws.blending['dispRecon'] ?? '')).toBe(ws.blending['dispRecon']);
    expect(asShown(v['blendYield@p-blend-yield@'], ws.blending['blendYield'] ?? '')).toBe(ws.blending['blendYield']);
    const c = ws.compression;
    expect([v['compGood@p-comp-yield@'], v['compResidue@p-comp-yield@'], v['compRejects@p-comp-yield@']].map((x, i) => same(x, [COMPRESSION.good, COMPRESSION.residue, COMPRESSION.rejects][i] ?? ''))).toEqual([true, true, true]);
    for (const k of ['compT', 'compYield', 'compYieldAB', 'compAcc', 'coresNet']) {
      const key = k === 'coresNet' ? 'coresNet@p-comp-out@' : `${k}@p-comp-yield@`;
      expect(k === 'compT' || k === 'coresNet' ? same(v[key], c[k] ?? '') : asShown(v[key], c[k] ?? '') === c[k], k).toBe(true);
    }
  });

  it('[IN-17][PR-39][PR-37] packs the worksheet\'s bottles: labels and cartons reconciled with nothing unexplained, the packaging yield, the shippers', () => {
    const v = r('order').values;
    const b = expected.worksheet.bottling;
    expect(asShown(v['packYield@p-pk-yield@'], b['packYield'] ?? '')).toBe(b['packYield']);
    expect(same(v['tabletsIssued@p-pk-count@'], BOTTLE_PLAN.tabletsIssued)).toBe(true);
    expect(same(v['tabletsPacked@p-pk-count@'], BOTTLE_PLAN.tabletsPacked)).toBe(true);
    expect(run.orderFacts?.shipperPacks).toBe(b['packs']);
  });

  it('[PR-42][PR-39][DI-31] serialises the US cartons through the L3/L4 system: the worksheet\'s pool, commissioning, destruction, specimens and aggregations, the L3 report closing the step; a stale L3 mirror refuses the US release item and a synchronisation clears it', () => {
    const s = expected.worksheet.serials;
    expect(SERIALS).toEqual(s);
    expect(run.rel?.serial).toEqual(expected.fromTheRun.serialisation);
  });

  it('[DI-31][DI-20] the ERP/WMS, LMS, CMMS and L3 adapters landed every message of the scenario with nothing refused or alarmed, and each mirror is fresh at the end', () => {
    expect(run.connected?.cmms.calibrations).toBe(CALIBRATED.length);
    expect(run.connected).toEqual(expected.fromTheRun.connected);
  });

  it('[DI-20][DI-32][DI-49] the OPC UA press reports its enrolled endpoint\'s session and native series of the compression through the site gateway, and its reject-burst alarm is acknowledged with a comment in the batch\'s alarm log', () => {
    expect(run.press).toEqual(expected.fromTheRun.press);
    expect(run.press?.sessions.every((x) => x.endsWith('enrolled-certificate'))).toBe(true);
    expect(run.press?.alarmLog.some((x) => x.includes('REJECT_BURST') && x.includes(`acknowledged: ${ACK.actionTaken} / ${ACK.comment}`))).toBe(true);
  });

  it('[PR-45][IN-05][INV-05] the finished lot is released for India through G-REL green and the AP\'s signed release, and for the US by its quality-control unit', () => {
    // G-REL's items (its epoch is a digest of the evidence's identifiers, different on every run).
    expect({ decision: run.rel?.decision, grel: run.rel?.grel['items'], us: run.rel?.us, shipments: run.rel?.shipments }).toEqual(expected.fromTheRun.release);
    expect(run.lot).toEqual(expected.fromTheRun.lot);
  });

  it('[IN-29][PR-57] the mock recall from the API lot reaches the batch, the order, the finished lot and both consignees of the ERP\'s shipments, reproduces, and is signed off by the AP', () => {
    expect(run.recall).toEqual(expected.fromTheRun.recall);
  });

  it.each(['batch', 'order'] as const)('the %s ends in the expected states, exceptions, genealogy, signatures and true-copy hash', (k) => {
    const x = r(k);
    const want = expected.fromTheRun[k];
    const notCompleted = Object.entries(x.states.steps).filter(([, s]) => s !== 'COMPLETED').map(([s, st]) => `${s} ${st}`);
    expect({ batch: x.states.batch, stages: x.states.stages, containers: x.states.containers, notCompleted }).toEqual(want['states']);
    expect(x.genealogy.consumptions).toEqual(want['consumptions']);
    expect(x.genealogy.containers).toEqual(want['containers']);
    expect(x.exceptions.map((e) => `${e.type} ${e.severity} ${e.disposition ?? e.status}`)).toEqual(want['exceptions']);
    expect(x.signatures).toBe(want['signatures']);
    expect(x.trueCopy.sha256).toBe(want['normalisedTrueCopySha256']);
  });
});

