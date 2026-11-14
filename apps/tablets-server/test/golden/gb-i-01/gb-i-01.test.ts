/**
 * The golden batch GB-I-01 (Injectables I-6; README.md): an invented aseptically filled vial made from the Injectables
 * catalogue's blocks, from its approved master to a RELEASED finished lot for India, on the frozen golden clock: the
 * aseptic filling with its sterility sampling and two filled loads, the EM plates counted after incubation, QA's release
 * for packing, the packaging order with the finished-pack examination, the finished lot in quarantine; then QC's release
 * results, STERILITY made by the firm's validated rapid microbial method (the method of the QA-approved specification),
 * each approved by the head of QC; both records reviewed, G-REL for India GREEN or NA throughout, the authorised person's
 * release. Every output must equal expected.json: the worksheet's quantities (README.md, never changed to make a run
 * pass), and the states, exceptions, genealogy, signature counts and the hashes of the normalised true copies recorded
 * from the first reviewed run (D-S6-7).
 *
 * Set EBMR_GOLDEN_DUMP to a file path to write the run's outputs there (for a review of a changed run).
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startSigningServer } from '../../esig/support.ts';
import type { ExecServer } from '../../execution/support.ts';
import { FAKETIME_FILE, freezeAt, goldenClockAvailable } from '../clock.ts';
import { resultsOf, type BatchResults } from '../gb-t-01/results.ts';
import { lotFacts, type LotFacts } from '../gb-t-01/release-results.ts';
import { vendorNames } from '../vendor-identity.ts';
import { packAndRelease, PLAN, runBatch, setUpGbi01, SPEC_TESTS, type Gbi01Release, type Masters } from './scenario.ts';

type Json = Record<string, unknown>;
const expected = JSON.parse(readFileSync(new URL('./expected.json', import.meta.url), 'utf8')) as Json & {
  worksheet: { loads: string[]; lot: string; reserve: string; results: Record<string, string> };
  fromTheRun: { batch: Json; order: Json; lot: Json; release: Json };
};

describe.runIf(goldenClockAvailable)('GB-I-01, an aseptically filled vial from its master to a released lot, sterility by the validated rapid method', () => {
  let gmp: ExecServer;
  let masters: Masters;
  const run: { batch?: BatchResults; order?: BatchResults; lot?: LotFacts; rel?: Gbi01Release; loads?: string[] } = {};
  beforeAll(async () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-gbi01-'));
    gmp = Object.assign(await startSigningServer('GMP', { stub: false, env: { EBMR_NUMBER_LEDGER_FILE: join(ledgerDir, 'numbers.ledger.jsonl') } }), { exchangeDir: ledgerDir });
    vi.useFakeTimers({ toFake: ['performance'] });
    masters = await setUpGbi01(gmp);
  }, 1_800_000);
  afterAll(async () => {
    vi.useRealTimers();
    await gmp?.close();
    writeFileSync(FAKETIME_FILE, '+0s\n');
  });

  it('runs the batch, the packaging order, the release results and the release', async () => {
    // The next midnight UTC, or EBMR_GOLDEN_LATER_DAYS whole days after it (to show the hashes do not depend on the day).
    const later = Number(/^\d{1,4}$/.test(process.env['EBMR_GOLDEN_LATER_DAYS'] ?? '') ? process.env['EBMR_GOLDEN_LATER_DAYS'] : '0');
    const start = BigInt(Math.floor(Date.now() / 1000 / 86_400) + 1 + later) * 86_400n;
    freezeAt(start);
    const { batch, loads } = await runBatch(gmp, masters);
    const rel = await packAndRelease(gmp, masters, batch, loads);
    const numbers = [batch.batchNumber, rel.order.batchNumber];
    const w = { server: gmp };
    run.batch = await resultsOf(w, batch.batchId, numbers, start * 1_000_000n);
    run.order = await resultsOf(w, rel.order.batchId, numbers, start * 1_000_000n);
    run.lot = await lotFacts(w, rel.lotId, numbers);
    run.rel = rel;
    run.loads = loads;
    const dump = process.env['EBMR_GOLDEN_DUMP'];
    if (dump) writeFileSync(dump, JSON.stringify({ batch: run.batch, order: run.order, lot: run.lot, rel: { ...rel, order: rel.order.batchNumber } }, null, 1));
    expect(run.batch.states.batch).toBe('EXECUTION_COMPLETE');
    expect(run.order.states.batch).toBe('EXECUTION_COMPLETE');
  }, 3_600_000);

  const rel = (): Gbi01Release => {
    if (!run.rel) throw new Error('the scenario did not run');
    return run.rel;
  };
  const r = (k: 'batch' | 'order'): BatchResults => {
    const x = run[k];
    if (!x) throw new Error('the scenario did not run');
    return x;
  };

  it('[IN-33][ST-65] the STERILITY result carries the validated rapid microbial method of the QA-approved specification, as the lot\'s results show it (API view); a result sent with another method is refused (EBMR-SITE-412)', () => {
    const sterility = rel().results.find((x) => x.testCode === 'STERILITY');
    expect(sterility).toEqual({ testCode: 'STERILITY', methodReference: 'Validated rapid microbial method', value: '0', unit: '1', verdict: 'PASS', state: 'APPROVED' });
    // Every result's method is its specification test's, though none was sent with the result.
    expect(Object.fromEntries(rel().results.map((x) => [x.testCode, x.methodReference]))).toEqual(Object.fromEntries(SPEC_TESTS.map((t) => [t.testCode, t.methodReference])));
    expect(rel().otherMethod).toEqual(expected.fromTheRun.release['otherMethod']);
  });

  it('[IN-05][PR-45][ST-65] QC records sterility, endotoxin and particulate matter within the specification, and the head of QC, another person, approves each result', () => {
    expect(Object.fromEntries(rel().results.map((x) => [x.testCode, `${x.value} ${x.unit} ${x.verdict} ${x.state}`]))).toEqual(expected.worksheet.results);
    expect(rel().approvals).toEqual(SPEC_TESTS.map(() => ({ recordedBy: 'qcAnalyst', approvedBy: 'qcApprover' })));
  });

  it('[IN-05][INV-05][IN-17][PR-37] G-REL for India has every item GREEN or NA (none RED), the authorised person releases the lot, and it is RELEASED for India only', () => {
    const { ready } = rel();
    expect(Object.entries(ready.items).filter(([, s]) => s !== 'GREEN' && s !== 'NA')).toEqual([]);
    expect(ready).toEqual(expected.fromTheRun.release['ready']);
    expect({ decision: rel().decision, lotStatus: rel().lotStatus }).toEqual({ decision: 'RELEASED', lotStatus: 'RELEASED' });
    expect(run.lot).toEqual(expected.fromTheRun.lot);
  });

  it('fills, packs and posts the worksheet\'s quantities: two loads into the packaging order, the finished lot, the reserve sample', () => {
    expect(PLAN.loads).toEqual(expected.worksheet.loads);
    expect(r('batch').genealogy.containers).toEqual(expected.worksheet.loads.map((n) => `FILLED/- ${n}`));
    expect(run.lot?.quantity).toBe(`${expected.worksheet.lot} 1`);
    expect(run.lot?.samples).toEqual([`RESERVE ${expected.worksheet.reserve} 1`]);
  });

  it.each(['batch', 'order'] as const)('the %s record carries the manufacturer\'s identity only: no Batchwright and no Medhanta in its normalised true copy (decision 0020, D-P7-11)', (k) => {
    expect(vendorNames(r(k).trueCopy.normalised)).toEqual([]);
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
