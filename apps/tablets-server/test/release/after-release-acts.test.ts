/**
 * The after-release acts' records as the server names them before the ceremony (Phase 4 slice 5a; contract ns/release.ts
 * RELEASE_ACT RECONFIRM, RECALL, REJECT_AFTER_RELEASE and DISPOSAL; recipe-core 0840): the aggregate id of each act is
 * the one the database's content provider reads (recipe.release_suspension_content, recipe.disposal_content), so the
 * person signs the record the act then writes. The sequence of a decision and the witness's record are read from the
 * database when the act runs (proven over HTTP in after-release-routes.test.ts); this file checks the ids themselves.
 */
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ReleaseActInput, SignableAction } from '@ebmr/api-contract';
import { disposalDetailsSha256, releaseActAggregateId } from '../../src/features/release/signables.ts';

type ReleaseAct = Extract<SignableAction, { kind: 'RELEASE_ACT' }>;
const lotId = randomUUID();
const act = (a: ReleaseAct['act'], input: ReleaseActInput): ReleaseAct => ({ kind: 'RELEASE_ACT', act: a, lotId, input });
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

describe('after-release act records (L-19, PR-46)', () => {
  it('[L-19][PR-46] a disposal\'s record is the lot and the SHA-256 of its details as entered, trimmed, one per line, in the order the database hashes them', () => {
    const input: ReleaseActInput = { disposalRoute: 'RETURN', disposalQuantity: ' 120', returnTo: 'SUPPLIER', disposalReference: ' RMA-7 ', text: ' back to the supplier ' };
    const expected = sha(['RETURN', '120', 'SUPPLIER', 'RMA-7', '', 'back to the supplier'].join('\n'));
    expect(disposalDetailsSha256(input)).toBe(expected);
    expect(releaseActAggregateId(act('DISPOSAL', input))).toBe(`${lotId}/${expected}`);
    // Every detail is part of the record: another quantity or reference is another record.
    expect(disposalDetailsSha256({ ...input, disposalQuantity: '121' })).not.toBe(expected);
    expect(disposalDetailsSha256({ ...input, reprocessingRef: 'RPR-1' })).not.toBe(expected);
    expect(disposalDetailsSha256({ disposalRoute: 'WITNESSED_DESTRUCTION', disposalQuantity: '5' })).toBe(sha(['WITNESSED_DESTRUCTION', '5', '', '', '', ''].join('\n')));
    expect(disposalDetailsSha256({})).toBe(sha(['', '', '', '', '', ''].join('\n')));
  });

  it('[PR-46] the witness signs the recorded destruction\'s own record (its id as given), never a new disposal record', () => {
    const disposalId = randomUUID();
    expect(releaseActAggregateId(act('DISPOSAL', { disposalId }))).toBe(disposalId);
  });

  it('[L-19] a re-confirmation, recall or rejection after release names the lot, the market and the act; the sequence is the database\'s', () => {
    expect(releaseActAggregateId(act('RECONFIRM', { market: 'US', expectedEpoch: 'e', text: 't' }))).toBe(`${lotId}/US/RECONFIRM`);
    expect(releaseActAggregateId(act('RECALL', { market: 'IN', reason: { code: 'COMPLAINT', text: 'x' } }))).toBe(`${lotId}/IN/RECALL`);
    expect(releaseActAggregateId(act('REJECT_AFTER_RELEASE', { market: 'EU', reason: { code: 'OOS', text: 'x' } }))).toBe(`${lotId}/EU/REJECT_AFTER_RELEASE`);
    expect(releaseActAggregateId(act('RECALL', {}))).toBe(`${lotId}//RECALL`);
  });
});
