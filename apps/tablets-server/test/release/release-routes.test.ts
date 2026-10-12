/**
 * The release routes and RELEASE_ACT over HTTP (Phase 4 slice 3a; contract ns/release.ts; recipe-core 0781, 0782): the
 * release queue and a finished lot's checklist (G-REL for IN, the Tablets hook's items included), the acknowledgement of
 * a since-review item, and the manufacturer release and rejection signed through the ceremony by the seed's AP; the
 * database decides and a refusal signs nothing. The finished lot is posted as the edition's definer posts it (its
 * packaging-order path is tablets 1150's); its batch is a real GMP batch, issued and not reviewed.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { refusalOf, valueOf } from '../esig/support.ts';
import { actorOf, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import type { TestBrowser } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

let w: GmpBatchWorld;
let ap: TestBrowser;
let qa: TestBrowser;
let batchId: string;
let lotId: string;

beforeAll(async () => {
  w = await startGmpBatchWorld();
  const issuer = await w.gmp.asPersona('issuer');
  [ap, qa] = await Promise.all([w.gmp.asPersona('qcuAuthoriser'), w.gmp.asPersona('qaInvestigator')]);
  batchId = await w.issued(issuer);
  const number = (await w.gmp.db.admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [batchId])).rows[0]!.n;
  const stores = await actorOf(w.gmp, 'stores');
  lotId = await withCommand(w.gmp.db.admin, { ...stores, correlationId: randomUUID() }, async (c) =>
    (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
      JSON.stringify({ batchId, batchNumber: number, edition: 'TABLETS', siteCode: 'SITE-1', productCode: w.content.header.product.code, productName: 'Release route product',
                       strength: '500 mg', markets: ['IN'], quantity: '1000', unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
    ])).rows[0]!.id,
  );
}, 600_000);
afterAll(async () => {
  await w?.close();
});

const codeOf = (r: Awaited<ReturnType<typeof signAction>>): string => (r.ok ? 'ok' : (refusalOf(r)?.code ?? 'refused'));

describe('release over HTTP (outline 5.2.6, 5.2.7, 7.3 release cockpit)', () => {
  it('[meta] the queue and the lot\'s checklist: NOT_READY with the reasons, the Tablets stub\'s groups 4 and 9 RED, the PR-53 switch off, the gates; G-REL per market', async () => {
    const queue = valueOf(await ap.call(routes.release.queue, { query: {} }));
    expect(queue.lots.find((l) => l.lotId === lotId)).toMatchObject({ batchId, lotStatus: 'QUARANTINE', state: 'NOT_READY', markets: ['IN'] });
    expect(valueOf(await ap.call(routes.release.queue, { query: { state: 'RELEASED' } })).lots.map((l) => l.lotId)).not.toContain(lotId);
    const view = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
    expect(view).toMatchObject({ state: 'NOT_READY', decision: null, openInvestigationPath: false, signable: { aggregateType: 'manufacturer_release', release: `${lotId}/RELEASE`, reject: `${lotId}/REJECT` } });
    const red = view.grel.items.filter((i) => i.status === 'RED').map((i) => i.id);
    expect(red).toEqual(expect.arrayContaining(['G1.REVIEW_1', 'G3.LIMS', 'G4.RECONCILIATION', 'G9.PACK_EXAMINATION']));
    expect(view.gates.release.ready).toBe(false);
    expect(view.gates.release.problems.join(' ')).toMatch(/G-REL item G1.REVIEW_1 is RED/);
    expect(view.gates.reject).toEqual({ ready: true, problems: [] });
    const us = valueOf(await ap.call(routes.release.grel, { params: { lotId }, query: { market: 'US' } }));
    expect(us).toMatchObject({ lotId, market: 'US', ready: false });
    // Only items that changed after the QA review are acknowledged.
    const ack = await ap.call(routes.release.acknowledge, { params: { lotId }, body: { market: 'IN', itemId: 'G1.REVIEW_1', epoch: view.grel.epoch } });
    expect(refusalOf(ack)?.why ?? JSON.stringify(ack)).toMatch(/EBMR-REL-051|no item that changed after the QA review/);
  });

  it('[IN-05] the AP\'s release of a NOT_READY lot is refused and signs nothing; the act needs its epoch; the later acts are not built yet; the AP rejects with a reason and the lot leaves quarantine REJECTED', async () => {
    let view = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
    const epoch = view.grel.epoch;
    const release = { kind: 'RELEASE_ACT' as const, act: 'MANUFACTURER_RELEASE' as const, lotId, input: { expectedEpoch: epoch } };
    expect(codeOf(await signAction(w.gmp, ap, 'qcuAuthoriser', release))).toMatch(/EBMR-REL-020|refused/);
    expect(codeOf(await signAction(w.gmp, ap, 'qcuAuthoriser', { ...release, input: {} }))).toBe('EBMR-API-ACT-INPUT');
    expect(codeOf(await signAction(w.gmp, ap, 'qcuAuthoriser', { kind: 'RELEASE_ACT', act: 'US_DISPOSE', lotId, input: {} }))).not.toBe('ok');
    // QA cannot decide the manufacturer release.
    const reject = { kind: 'RELEASE_ACT' as const, act: 'MANUFACTURER_REJECT' as const, lotId, input: { expectedEpoch: epoch, reason: { code: 'NOT_TESTED', text: 'The lot was never tested; rejected for destruction' } } };
    expect(codeOf(await signAction(w.gmp, qa, 'qaInvestigator', reject))).not.toBe('ok');
    view = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
    expect(view).toMatchObject({ state: 'NOT_READY', lotStatus: 'QUARANTINE', decision: null });
    valueOf(await signAction(w.gmp, ap, 'qcuAuthoriser', reject));
    view = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
    expect(view).toMatchObject({ state: 'REJECTED', lotStatus: 'REJECTED', decision: { decision: 'REJECTED', reason: 'The lot was never tested; rejected for destruction', delegationId: null, epoch } });
    expect(view.decision?.by.role).toBe('AUTHORISED_PERSON');
    expect(view.gates.release.problems).toEqual([expect.stringMatching(/is REJECTED/)]);
  });
});
