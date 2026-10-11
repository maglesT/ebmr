/**
 * The aggregate ids the quality acts sign (slice 6a): the server writes them exactly as the database does
 * (site.qc_extra_testing_aggregate_id 0733, site.lot_retest_aggregate_id 0762), or the precheck refuses to sign. Pure; the
 * ceremony itself is proven in routes.test.ts. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import { extraTestingAggregateId, lotRetestAggregateId, qualityActHandler } from '../../src/features/quality/signables.ts';

const LOT = '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
const R1 = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const R2 = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';

describe('signed aggregate ids of the quality acts', () => {
  it('[DI-37][DI-35] the extra-testing decision binds the batch, the decision and the tests distinct and sorted by code point, joined by +', () => {
    expect(extraTestingAggregateId('B-1', 'EXTRA_TESTS', ['LOD', 'ASSAY', 'LOD', 'Dissolution'])).toBe('B-1/EXTRA_TESTS/ASSAY+Dissolution+LOD');
    expect(extraTestingAggregateId('B-1', 'EXTRA_TESTS', ['b', 'a', 'B'])).toBe('B-1/EXTRA_TESTS/B+a+b');
    expect(extraTestingAggregateId('B-1', 'NO_EXTRA_TESTS', [])).toBe('B-1/NO_EXTRA_TESTS/');
    expect(extraTestingAggregateId('B-1', 'X', ['T2', 'T1'])).toBe(extraTestingAggregateId('B-1', 'X', ['T1', 'T2']));
  });

  it('[DI-37][DI-35] the retest binds the lot, the new instant in UTC with microseconds, and the result ids lower-cased, distinct and sorted', () => {
    expect(lotRetestAggregateId(LOT, '2027-09-30T00:00:00+05:30', [R2, R1.toUpperCase(), R1])).toBe(`${LOT}/2027-09-29T18:30:00.000000Z/${R1}+${R2}`);
    expect(lotRetestAggregateId(LOT, '2027-06-30T00:00:00.123Z', [R1])).toBe(`${LOT}/2027-06-30T00:00:00.123000Z/${R1}`);
    expect(lotRetestAggregateId(LOT, '2027-06-30T00:00Z', [])).toBe(`${LOT}/2027-06-30T00:00:00.000000Z/`);
    // Text that is not an instant is kept as written (the precheck then refuses it: it never matches the database's id).
    expect(lotRetestAggregateId(LOT, 'next year', [R1])).toBe(`${LOT}/next year/${R1}`);
  });
});

describe('what a quality act signs and the input it carries (mutation follow-up)', () => {
  const handler = qualityActHandler({} as never);
  const act = (a: string, input: Record<string, unknown> = {}, subjectId = LOT) => ({ kind: 'QUALITY_ACT', act: a, subjectId, input }) as never;
  /** A client that must not be reached: the refusals below come before any query. */
  const noDb = { query: () => Promise.reject(new Error('no query expected')) } as never;
  const why = async (a: never) => {
    const r = (await handler.dryRun(noDb, {} as never, a)) as { accepted: boolean; refusal?: { code: string; why: string; controls: string[] } };
    return r.accepted ? 'accepted' : `${r.refusal?.code ?? ''}: ${r.refusal?.why ?? ''} [${(r.refusal?.controls ?? []).join(',')}]`;
  };

  it('[DI-37] each act names its aggregate and meaning; the extra-testing decision and the retest bind their input', () => {
    expect(handler.describe(act('DEVIATION_CONCLUDE'))).toEqual({ aggregateType: 'deviation', aggregateId: LOT, meaning: 'DEVIATION_CONCLUDED' });
    expect(handler.describe(act('DEVIATION_CLOSE'))).toEqual({ aggregateType: 'deviation', aggregateId: LOT, meaning: 'DEVIATION_CLOSED' });
    expect(handler.describe(act('LOT_RESULT_APPROVE'))).toEqual({ aggregateType: 'lot_test_result', aggregateId: LOT, meaning: 'QC_RESULT_APPROVED' });
    expect(handler.describe(act('QC_EXTRA_TESTING_DECISION', { decision: 'EXTRA_TESTS', tests: ['B', 'A'] }, 'B-1'))).toEqual({ aggregateType: 'qc_extra_testing', aggregateId: 'B-1/EXTRA_TESTS/A+B', meaning: 'QC_EXTRA_TESTING_DECIDED' });
    expect(handler.describe(act('QC_EXTRA_TESTING_DECISION', {}, 'B-1')).aggregateId).toBe('B-1//');
    expect(handler.describe(act('LOT_RETEST', { retestAt: '2027-06-30T00:00Z', results: [R1] }))).toEqual({ aggregateType: 'lot_retest', aggregateId: `${LOT}/2027-06-30T00:00:00.000000Z/${R1}`, meaning: 'LOT_RETEST_APPROVED' });
    expect(handler.describe(act('LOT_RETEST')).aggregateId).toBe(`${LOT}//`);
  });

  it('[DI-37] an act carrying input it does not use, or missing what it needs, is refused before anything is signed; a malformed retest likewise', async () => {
    expect(await why(act('DEVIATION_CLOSE', { decision: 'X' }))).toBe('EBMR-API-ACT-INPUT: DEVIATION_CLOSE takes no decision. [DI-37]');
    expect(await why(act('QC_EXTRA_TESTING_DECISION', { tests: [] }))).toBe('EBMR-API-ACT-INPUT: QC_EXTRA_TESTING_DECISION needs decision. [DI-37]');
    expect(await why(act('QC_EXTRA_TESTING_DECISION', { tests: [], retestAt: 'x' }))).toBe('EBMR-API-ACT-INPUT: QC_EXTRA_TESTING_DECISION needs decision and takes no retestAt. [DI-37]');
    expect(await why(act('LOT_RETEST', { results: [] }))).toBe('EBMR-API-ACT-INPUT: LOT_RETEST needs retestAt. [DI-37]');
    expect(await why(act('LOT_RETEST', {}))).toBe('EBMR-API-ACT-INPUT: LOT_RETEST needs retestAt, results. [DI-37]');
    expect(await why(act('LOT_RETEST', { retestAt: 'next year', results: [R1] }))).toMatch(/^EBMR-API-ACT-INPUT: The new retest date is an instant with its zone/);
    expect(await why(act('LOT_RETEST', { retestAt: '2027-06-30T00:00Z', results: ['nope'] }))).toMatch(/^EBMR-API-ACT-INPUT: The new retest date/);
    expect(await why(act('LOT_RETEST', { retestAt: '2027-06-30T00:00Z', results: [R1] }, 'not-a-uuid'))).toMatch(/^EBMR-API-ACT-INPUT: The new retest date/);
  });
});
