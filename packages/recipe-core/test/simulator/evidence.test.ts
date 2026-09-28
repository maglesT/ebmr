import { describe, expect, it } from 'vitest';
import { deltaVerification, evidenceHolds, verifyMbr } from '../../src/simulator/evidence.ts';
import { clone, context, findPhase, loadFixture } from '../flow/support.ts';

describe('static verification evidence (DI-04, static part)', () => {
  const mbr = loadFixture('tablet-blister-packaging');
  const { evidence } = verifyMbr(mbr, context());

  it('[DI-04] a complete MBR yields VERIFIED evidence bound to its content hash', () => {
    expect(evidence).toMatchObject({ kind: 'FULL', verdict: 'VERIFIED', reasons: [], validator: { errors: 0, passed: true }, simulation: { passed: true, exactPaths: '4', boundHit: false } });
    expect(evidenceHolds(mbr, evidence)).toBe(true);
  });

  it('[DI-04] any edit to the content voids the evidence (the MBR cannot become effective on it)', () => {
    const edited = clone(mbr);
    edited.header.title = `${mbr.header.title} (rev)`;
    expect(evidenceHolds(edited, evidence)).toBe(false);
  });

  it('[DI-04] altered evidence does not hold', () => {
    expect(evidenceHolds(mbr, { ...evidence, verdict: 'VERIFIED', reasons: ['x'] })).toBe(false);
  });

  it('[DI-04] an MBR with a failing gate or a failing simulation gets NOT_VERIFIED evidence with the reasons', () => {
    const broken = clone(mbr);
    delete findPhase(broken, 'p-foil-issue').signatures.check;
    const r = verifyMbr(broken, context());
    expect(r.evidence.verdict).toBe('NOT_VERIFIED');
    expect(r.evidence.reasons).toEqual([expect.stringMatching(/needs a checker who is not the performer/)]);
    expect(evidenceHolds(broken, r.evidence)).toBe(false);
  });

  it('[DI-04] delta verification: a value-only change reuses the path evidence and reruns the boundary vectors of the changed items', () => {
    const next = clone(mbr);
    const y = next.yieldCheckpoints.find((x) => x.id === 'Y-BULK');
    const low = y?.limits?.ranges[0]?.low;
    if (!low) throw new Error('fixture changed');
    low.value = '99.5';
    const r = deltaVerification(mbr, evidence, next, context());
    if ('refused' in r) throw new Error(r.refused);
    expect(r.diff.classification).toBe('VALUE_ONLY');
    expect(r.evidence).toMatchObject({ kind: 'DELTA', verdict: 'VERIFIED', basis: { contentHash: evidence.contentHash, evidenceHash: evidence.evidenceHash, changedSubjects: ['Y-BULK'] } });
    expect(r.simulation.paths.enumerated).toBe(0);
    expect(new Set(r.simulation.limits.map((v) => v.subject))).toEqual(new Set(['Y-BULK']));
    expect(evidenceHolds(next, r.evidence)).toBe(true);
  });

  it('[DI-04] delta verification is refused for a structural change or without valid predecessor evidence', () => {
    const next = clone(mbr);
    findPhase(next, 'p-leak').name = 'Leak test (renamed)';
    const r = deltaVerification(mbr, evidence, next, context());
    expect('refused' in r && r.refused).toMatch(/structural; a full verification is required/);
    const value = clone(mbr);
    const t = value.timeConstraints[0];
    if (t?.max) t.max.value = '7';
    const r2 = deltaVerification(mbr, { ...evidence, contentHash: '0'.repeat(64) }, value, context());
    expect('refused' in r2 && r2.refused).toMatch(/no valid verification evidence/);
  });
});
