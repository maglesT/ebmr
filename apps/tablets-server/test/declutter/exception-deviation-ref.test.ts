/**
 * Declutter slice D4 (docs/build-plan/declutter/plan.md section 2): full deviation records belong to the Deviations
 * product, so their routes answer 410 DISCONNECTED on a server started with EBMR_DISCONNECT=1 (and on the platform). A
 * batch exception keeps only its deviation reference (recipe-core 0440): the set-up CLI's review batch attaches a
 * deviation to each exception through the kept routes, the review register still shows each reference and groups by
 * it, and a grouped disposition still records, while the full record of that deviation is refused.
 *
 * Control: DI-17 (only the functions Batchwright offers are served; nothing on the batch path is lost).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result, type SignableAction } from '@ebmr/api-contract';
import { personaOf } from '@ebmr/test-kit';
import { setupInstallation } from '../../src/cli/setup.ts';
import type { ReviewBatchSeed } from '../../src/cli/review-batch.ts';
import { valueOf } from '../esig/support.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import { signAction } from '../support/signed-acts.ts';

const database = `ebmr_d4devref_e2e_${randomBytes(4).toString('hex')}`;
const dir = mkdtempSync(join(tmpdir(), 'ebmr-d4-devref-'));
let server: TestServer;
let batch: ReviewBatchSeed;

beforeAll(async () => {
  const keysDir = join(dir, 'keys');
  const seed = await setupInstallation({ installation: 'GMP', database, keysDir, exchangeDir: join(dir, 'exchange'), personaSets: 1, recreate: true, reviewBatch: true, log: () => undefined });
  batch = JSON.parse(readFileSync(join(keysDir, 'gmp-review-batch.json'), 'utf8')) as ReviewBatchSeed;
  server = await startServer('GMP', { prepared: { database, seed }, env: { EBMR_SEAL_KEY_FILE: join(keysDir, 'gmp-seal-key.json'), EBMR_DISCONNECT: '1' } });
}, 900_000);

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('[DI-17] a batch exception keeps its deviation reference where the deviation routes are disconnected (declutter D4)', () => {
  it('[DI-17] the review register shows each exception\'s deviation reference and a grouped disposition records; the full deviation record is served', async () => {
    const B = batch.batchId;
    const qa = await server.asPersona('qaInvestigator');
    const shown = valueOf(await qa.call(routes.review.register, { params: { batchId: B }, body: {} }));
    const refs = Object.fromEntries(shown.items.map((i) => [i.exceptionId, i.deviationRef]));
    expect(Object.keys(refs).sort()).toEqual(['EX-1', 'EX-2', 'EX-3']);
    for (const ref of Object.values(refs)) expect(ref).toMatch(/\S/);
    expect(refs['EX-1']).toBe(refs['EX-2']);
    expect(shown.items.every((i) => i.group === i.deviationRef)).toBe(true);

    // The batch's deviation list (record lock and release pages) stays, and so does the full record of each (G2).
    const listed = valueOf(await qa.call(routes.quality.deviations, { query: { batchId: B } })).deviations;
    expect(listed.map((d) => d.ref).sort()).toEqual([...new Set(Object.values(refs))].sort());
    for (const d of listed) expect(valueOf(await qa.call(routes.quality.deviation, { params: { deviationId: d.deviationId } })).ref).toBe(d.ref);

    // A grouped disposition over the shared reference still records.
    const head = await server.asPersona('head1');
    valueOf(await signAction(server, head, 'head1', { kind: 'REVIEW_ACT', act: 'PRODUCTION_APPROVE', batchId: B, input: {} }));
    const accept: SignableAction = {
      kind: 'REVIEW_ACT', act: 'DISPOSE_ITEM', batchId: B,
      input: { items: ['EX-1', 'EX-2'], disposition: 'ACCEPT', justification: 'Both alerts were corrected at the booth before any material was handled; no impact on the batch.' },
    };
    valueOf(await signAction(server, qa, 'qaInvestigator', accept));
    const after = valueOf(await qa.call(routes.review.register, { params: { batchId: B }, body: {} }));
    expect(after.items.filter((i) => i.reviewStatus === 'ACCEPTED').map((i) => [i.exceptionId, i.deviationRef]).sort()).toEqual([
      ['EX-1', refs['EX-1']],
      ['EX-2', refs['EX-2']],
    ]);
    const kept = await server.db.admin.query<{ ref: string }>(
      "select deviation_ref as ref from recipe.exception_register_act where batch_id = $1 and act = 'DEVIATION_LINKED' order by exception_id",
      [B],
    );
    expect(kept.rows.map((r) => r.ref)).toEqual([refs['EX-1'], refs['EX-2'], refs['EX-3']]);
  }, 300_000);

  it('[PR-49][PR-50][DI-17] with EBMR_DISCONNECT=1, QA investigates, concludes and closes each deviation linked to the batch on the deviation screens\' routes, and the batch\'s release checklist then has no blocking deviation (G2, owner report item 2)', async () => {
    const B = batch.batchId;
    const [inv, qa2] = await Promise.all([server.asPersona('qaInvestigator'), server.asPersona('qaApprover2')]);
    const qa1 = await loginOf(server, await grantedPerson(server, 'QA_SHOP_FLOOR', 'Meera Pillai (QA classifier)'));
    const owner = personaOf(server.seed, 'qaInvestigator').personId;
    const due = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 28)).toISOString().slice(0, 10);
    const ok = async (r: Promise<Result<unknown>>) => expect(((await r) as { ok: boolean }).ok).toBe(true);
    const before = valueOf(await inv.call(routes.quality.deviationRelease, { query: { subjectKind: 'BATCH', subjectId: B } }));
    expect(before.items.some((i) => i.blocking)).toBe(true);
    for (const d of valueOf(await inv.call(routes.quality.deviations, { query: { batchId: B } })).deviations) {
      const id = { deviationId: d.deviationId };
      // Classified by QA other than the initiator; that QA then neither concludes nor closes (INV-03).
      valueOf(await qa1.call(routes.quality.startInvestigation, { params: id, body: { classification: 'MINOR', riskRationale: 'Corrected at the booth before any material was handled', ownerPersonId: owner, dueDate: due } }));
      valueOf(await inv.call(routes.quality.recordFinding, { params: id, body: { assignableCause: true, cause: 'Booth readiness checked late', rootCauseCategory: 'METHOD' } }));
      for (const link of valueOf(await inv.call(routes.quality.deviationDetail, { params: id })).links) {
        valueOf(await inv.call(routes.quality.recordDeviationImpact, { params: id, body: { linkId: link.linkId, market: 'IN', impact: 'NONE', rationale: 'No material was handled before the correction' } }));
      }
      await ok(signAction(server, qa2, 'qaApprover2', { kind: 'QUALITY_ACT', act: 'DEVIATION_IMPACT_ASSESS', subjectId: d.deviationId, input: {} }));
      valueOf(
        await inv.call(routes.quality.recordDeviationClosureBasis, {
          params: id,
          body: { rootCauseMethod: 'Five whys with production', capaRefs: [], noCapaReason: 'A one-off finding corrected at once; the booth check already exists', notificationRequired: false, notificationRationale: 'No registered detail or licence condition is affected', otherBatches: [{ subjectKind: 'PRODUCT', ref: 'Batches dispensed at DISP-1 that day', included: false, reason: 'No other batch used the booth before the correction' }] },
        }),
      );
      await ok(signAction(server, qa2, 'qaApprover2', { kind: 'QUALITY_ACT', act: 'DEVIATION_CONCLUDE', subjectId: d.deviationId, input: {} }));
      await ok(signAction(server, qa2, 'qaApprover2', { kind: 'QUALITY_ACT', act: 'DEVIATION_CLOSE', subjectId: d.deviationId, input: {} }));
      expect(valueOf(await inv.call(routes.quality.deviation, { params: id })).state).toBe('CLOSED');
    }
    const after = valueOf(await inv.call(routes.quality.deviationRelease, { query: { subjectKind: 'BATCH', subjectId: B } }));
    expect(after.items.filter((i) => i.blocking)).toEqual([]);
  }, 300_000);
});
