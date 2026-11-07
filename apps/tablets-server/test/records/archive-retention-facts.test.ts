/**
 * The retention facts of a batch (Phase 4 slice 6b, archive/facts.ts; Phase 6 mutation triage T13). The database's
 * retention engine dates a batch record from the inputs it is given and stores them as given (kernel 0420, 1172): it does
 * not read the batch. So the mapping from the batch's record to those inputs (its market set, licence form, outcome, the
 * abort or cancellation date and the EU state) is made only here, and a wrong mapping would date the record too early
 * (a market dropped loses that market's rules, DI-47). Proved on batchFacts with a stand-in for the database client.
 */
import { describe, expect, it } from 'vitest';
import { records } from '@ebmr/kernel';
import { batchFacts, licenceFormOf } from '../../src/features/archive/facts.ts';

const BATCH = '0b6b8f8e-6a43-4f3b-9d8c-6d1f5f6f0a01';

interface Row {
  batch_number: string;
  status: string | null;
  manufacture_date: string;
  markets: string[] | null;
  expiry_date: string | null;
  abort_date: string | null;
  eu_certified: string | null;
  eu_rejected: string | null;
  licence_form: string | null;
  packed_from: string[] | null;
  packed_into: string[] | null;
  retest_labelled: boolean | null;
  distribution_date: string | null;
}

const base: Row = {
  batch_number: 'B-0001', status: 'EXECUTION_COMPLETE', manufacture_date: '2026-03-02', markets: ['IN'], expiry_date: '2028-02-29', abort_date: null,
  eu_certified: null, eu_rejected: null, licence_form: '25', packed_from: null, packed_into: null,
  retest_labelled: false, distribution_date: null,
};

const factsOf = async (over: Partial<Row>) => {
  const row = { ...base, ...over };
  const f = await batchFacts({ query: () => Promise.resolve({ rows: [row] }) } as never, BATCH);
  if (!f) throw new Error('no facts');
  return f;
};

describe('the retention facts of a batch (archive/facts.ts; T13)', () => {
  it('[DI-47][IN-08] every market of the batch\'s market set reaches the retention inputs, an unknown market does not, and a batch without a market set is India\'s', async () => {
    expect((await factsOf({ markets: ['IN', 'US', 'EU', 'XX'] })).retention.markets).toEqual(['IN', 'US', 'EU']);
    expect((await factsOf({ markets: ['US'] })).retention.markets).toEqual(['US']);
    expect((await factsOf({ markets: ['EU', 'IN'] })).retention.markets).toEqual(['EU', 'IN']);
    expect((await factsOf({ markets: ['IN'] })).retention.markets).toEqual(['IN']);
    expect((await factsOf({ markets: null })).retention.markets).toEqual(['IN']);
  });

  it('[IN-08] the licence form is the recorded basis\'s: Form 25 or 25A, Form 28 or 28A, otherwise none', async () => {
    expect([licenceFormOf('25'), licenceFormOf('25A'), licenceFormOf('28'), licenceFormOf('28A'), licenceFormOf('27'), licenceFormOf(null), licenceFormOf(undefined)])
      .toEqual(['FORM_25', 'FORM_25', 'FORM_28', 'FORM_28', null, null, null]);
    expect((await factsOf({ licence_form: '25A' })).retention.licenceForm).toBe('FORM_25');
    expect((await factsOf({ licence_form: '28A' })).retention.licenceForm).toBe('FORM_28');
    expect((await factsOf({ licence_form: null })).retention.licenceForm).toBeNull();
  });

  it('[DI-47][IN-08] the outcome is the batch\'s status: an aborted or cancelled batch carries its abort or cancellation date (its issue date when none is recorded); a completed or running one carries none', async () => {
    const aborted = await factsOf({ status: 'ABORTED', abort_date: '2026-03-05' });
    expect([aborted.retention.outcome, aborted.retention.abortCancelDate]).toEqual(['ABORTED', '2026-03-05']);
    const cancelled = await factsOf({ status: 'CANCELLED', abort_date: null });
    expect([cancelled.retention.outcome, cancelled.retention.abortCancelDate]).toEqual(['CANCELLED', '2026-03-02']);
    const complete = await factsOf({ status: 'EXECUTION_COMPLETE', abort_date: '2026-03-05' });
    expect([complete.retention.outcome, complete.retention.abortCancelDate]).toEqual(['COMPLETED', null]);
    const running = await factsOf({ status: 'IN_PROGRESS', abort_date: '2026-03-05' });
    expect([running.retention.outcome, running.retention.abortCancelDate]).toEqual(['IN_PROGRESS', null]);
    const issued = await factsOf({ status: null });
    expect([issued.status, issued.retention.outcome, issued.retention.abortCancelDate]).toEqual(['ISSUED', 'IN_PROGRESS', null]);
  });

  it('[DI-47] an EU batch carries its QP certification date, else the date it was finally rejected, else stays pending (its retention open); a batch outside the EU carries no EU state', async () => {
    expect((await factsOf({ markets: ['IN', 'EU'], eu_certified: '2026-04-01', eu_rejected: '2026-03-20' })).retention.eu).toEqual({ state: 'CERTIFIED', date: '2026-04-01' });
    expect((await factsOf({ markets: ['IN', 'EU'], eu_rejected: '2026-03-20' })).retention.eu).toEqual({ state: 'FINALLY_REJECTED', date: '2026-03-20' });
    expect((await factsOf({ markets: ['EU'] })).retention.eu).toEqual({ state: 'PENDING' });
    expect((await factsOf({ markets: ['IN', 'US'], eu_certified: '2026-04-01' })).retention.eu).toBeNull();
  });

  it('[DI-47] the batch supports the packaging batches packed from it and depends on the processing batches it was packed from, never on itself', async () => {
    const f = await factsOf({ packed_into: ['pack-1', BATCH], packed_from: [BATCH, 'proc-1'] });
    expect([f.supports, f.dependsOn]).toEqual([['pack-1'], ['proc-1']]);
    const none = await factsOf({});
    expect([none.supports, none.dependsOn]).toEqual([[], []]);
  });

  it('[AS-24] a batch whose lot carries a retest date is retest-labelled and carries the date of its latest shipment; one without carries neither flag nor date in its inputs', async () => {
    const api = await factsOf({ retest_labelled: true, distribution_date: '2026-07-01' });
    expect([api.retention.retestLabelled, api.retention.distributionDate]).toEqual([true, '2026-07-01']);
    const unshipped = await factsOf({ retest_labelled: true });
    expect([unshipped.retention.retestLabelled, unshipped.retention.distributionDate]).toEqual([true, undefined]);
    const tablet = await factsOf({ retest_labelled: false, distribution_date: '2026-07-01' });
    expect(tablet.retention.retestLabelled).toBeUndefined();
    expect(Object.keys(records.batchRetentionInputs(tablet.retention))).not.toContain('distributionDate');
  });
});
