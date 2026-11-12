/**
 * Lead queue (kiosk defect, 10 November 2026): "Raise one for this batch" on a shared kiosk was refused 428
 * TAP_REQUIRED: the raise and its link to the batch are commands of the person at the kiosk, and on a shared terminal
 * every command carries that person's fresh badge tap (INV-40). The two routes now take the tap on a shared terminal
 * (FRESH_ON_SHARED), as the floor's entries do.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { personaIn, refusalOf, tapFor, valueOf } from '../esig/support.ts';
import { gmpBatch } from '../support/gmp-batch.ts';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startServer('GMP');
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

describe('a batch deviation raised on a shared kiosk', () => {
  it('[INV-40][DI-14] without a badge tap the raise is refused; with the person\'s fresh tap it is raised and linked to a real batch, attributed to them', async () => {
    const kiosk = await gmp.asPersona('operator1');
    const body = { kind: 'DEVIATION' as const, title: 'Granules spilled at discharge', classification: 'MINOR' as const, riskRationale: 'About 50 g lost on the floor; swept and recorded' };
    const r = refusalOf(await kiosk.call(routes.quality.raiseDeviation, { body }));
    expect(r).toMatchObject({ status: 428, code: 'TAP_REQUIRED' });
    const d = valueOf(await kiosk.call(routes.quality.raiseDeviation, { body, attribution: await tapFor(kiosk, personaIn(gmp, 'operator1'), 'POST', '/api/quality/deviations', body) }));
    expect(d.ref).toBeTruthy();
    const batch = await gmpBatch(gmp);
    const link = { subjectKind: 'BATCH' as const, subjectId: batch.id };
    const path = `/api/quality/deviations/${d.deviationId}/links`;
    expect(refusalOf(await kiosk.call(routes.quality.linkDeviation, { params: { deviationId: d.deviationId }, body: link }))).toMatchObject({ status: 428, code: 'TAP_REQUIRED' });
    // With the tap the link to a real GMP batch succeeds, and one link row joins the deviation to that batch.
    valueOf(await kiosk.call(routes.quality.linkDeviation, { params: { deviationId: d.deviationId }, body: link, attribution: await tapFor(kiosk, personaIn(gmp, 'operator1'), 'POST', path, link) }));
    const linkedTo = (await gmp.db.admin.query<{ n: string }>(
      "select count(*)::text as n from site.deviation_link l where l.deviation_id = $1 and l.subject_kind = 'BATCH' and l.subject_id = $2", [d.deviationId, batch.id])).rows[0]?.n;
    expect(linkedTo).toBe('1');
    // The raise is the kiosk person's own act, its badge tap the command's authentication event.
    const by = (await gmp.db.admin.query<{ n: string }>(
      "select p.legal_name as n from site.deviation d join iam.person p on p.id = d.raised_by_person where d.id = $1", [d.deviationId])).rows[0]?.n;
    expect(by).toBe(personaIn(gmp, 'operator1').legalName);
  });
});
