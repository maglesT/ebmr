/**
 * The GMP issue route refuses a US-market batch while the licence holder's 21 CFR 11.100(c) certification letter is not
 * on file (DI-15 proposed_modify, outline 5.5 R-20; finding 7g-5; recipe-core 1260): the issuer's ISSUED signature is
 * the issue, and the database's issue gate answers. An India-only batch is not asked; once the letter is recorded the
 * same US batch is issued. The database-level proof is packages/recipe-core/test/lifecycle/us-esig-certification.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { passwordActor } from '@ebmr/test-kit';
import { cell } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { refusalOf, valueOf } from '../esig/support.ts';
import type { TestBrowser } from '../support/harness.ts';
import { BATCH_SIZE, gmpContent, LINE, SITE, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';

let w: GmpBatchWorld;
let issuer: TestBrowser;
const HOLDER = 'Test Pharma Ltd'; // the holder of the licence the life-cycle world records for the product

beforeAll(async () => {
  w = await startGmpBatchWorld(gmpContent((m) => {
    (m['header'] as Record<string, unknown>)['marketSet'] = ['IN', 'US'];
  }));
  // The US authorisation brings the export permission, not the certification letter.
  w.world.autoUsCertification = false;
  await w.world.authorise({ versionId: w.versionId, market: 'US', kind: 'CURRENT', cells: [cell(SITE, LINE, BATCH_SIZE)], regulatoryBasis: 'US: registration on file' });
  issuer = await w.gmp.asPersona('issuer');
}, 600_000);
afterAll(async () => {
  await w?.close();
});

const statusOf = async (batchId: string) => (await w.gmp.db.admin.query<{ status: string }>('select status from recipe.stub_batch where id = $1', [batchId])).rows[0]?.status;

describe('the US e-signature certification at the GMP issue route (DI-15, recipe-core 1260)', () => {
  it('[DI-15] the issue of a US-market batch is refused while the licence holder has no 11.100(c) letter on file, an India-only batch is issued, and after the letter is recorded the US batch is issued', async () => {
    const us = await w.plan(issuer, ['IN', 'US']);
    const refused = refusalOf(await w.signIssue(issuer, us.batchId));
    expect(JSON.stringify(refused)).toMatch(/EBMR-IAM-170/);
    expect(JSON.stringify(refused)).toContain(HOLDER);
    expect(await statusOf(us.batchId)).toBe('PLANNED');

    const india = await w.plan(issuer, ['IN']);
    valueOf(await w.signIssue(issuer, india.batchId));
    expect(await statusOf(india.batchId)).toBe('ISSUED');

    const owner = w.gmp.seed.bootstrap.owner;
    const ownerActor = await passwordActor(w.gmp.db, owner, owner.fingerprint, { reasonCode: 'TEST', reasonText: 'the licence holder\'s letter is on file' });
    await withCommand(w.gmp.db.app, ownerActor, (c) => c.query("select iam.record_us_esig_certification($1, 'LTR-2026-07', date '2026-03-01')", [HOLDER]));
    valueOf(await w.signIssue(issuer, us.batchId));
    expect(await statusOf(us.batchId)).toBe('ISSUED');
  });
});
