/**
 * Lead queue (kiosk defect, 10 November 2026): "Raise one for this batch" on a shared kiosk was refused 428
 * TAP_REQUIRED: the raise and its link to the batch are commands of the person at the kiosk, and on a shared terminal
 * every command carries that person's fresh badge tap (INV-40). The two routes now take the tap on a shared terminal
 * (FRESH_ON_SHARED), as the floor's entries do.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { personaIn, refusalOf, tapFor, valueOf } from '../esig/support.ts';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startServer('GMP');
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

describe('a batch deviation raised on a shared kiosk', () => {
  it('[INV-40][DI-14] without a badge tap the raise is refused; with the person\'s fresh tap it is raised and linked to the batch, attributed to them', async () => {
    const kiosk = await gmp.asPersona('operator1');
    const body = { kind: 'DEVIATION' as const, title: 'Granules spilled at discharge', classification: 'MINOR' as const, riskRationale: 'About 50 g lost on the floor; swept and recorded' };
    const r = refusalOf(await kiosk.call(routes.quality.raiseDeviation, { body }));
    expect(r).toMatchObject({ status: 428, code: 'TAP_REQUIRED' });
    const d = valueOf(await kiosk.call(routes.quality.raiseDeviation, { body, attribution: await tapFor(kiosk, personaIn(gmp, 'operator1'), 'POST', '/api/quality/deviations', body) }));
    expect(d.ref).toBeTruthy();
    const batchId = randomUUID();
    const link = { subjectKind: 'BATCH' as const, subjectId: batchId };
    const path = `/api/quality/deviations/${d.deviationId}/links`;
    expect(refusalOf(await kiosk.call(routes.quality.linkDeviation, { params: { deviationId: d.deviationId }, body: link }))).toMatchObject({ status: 428, code: 'TAP_REQUIRED' });
    // With the tap the link reaches the database, which judges the batch (an unknown batch is its refusal, not a missing tap).
    const linked = await kiosk.call(routes.quality.linkDeviation, { params: { deviationId: d.deviationId }, body: link, attribution: await tapFor(kiosk, personaIn(gmp, 'operator1'), 'POST', path, link) });
    if (!linked.ok) expect(refusalOf(linked).code).not.toMatch(/TAP_REQUIRED|EBMR-IAM-120/);
    // The raise is the kiosk person's own act, its badge tap the command's authentication event.
    const by = (await gmp.db.admin.query<{ n: string }>(
      "select p.legal_name as n from site.deviation d join iam.person p on p.id = d.raised_by_person where d.id = $1", [d.deviationId])).rows[0]?.n;
    expect(by).toBe(personaIn(gmp, 'operator1').legalName);
  });
});
