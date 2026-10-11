/**
 * The aggregate ids the quality acts sign (slice 6a): the server writes them exactly as the database does
 * (site.qc_extra_testing_aggregate_id 0733, site.lot_retest_aggregate_id 0762), or the precheck refuses to sign. Pure; the
 * ceremony itself is proven in routes.test.ts. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import { extraTestingAggregateId, lotRetestAggregateId } from '../../src/features/quality/signables.ts';

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
