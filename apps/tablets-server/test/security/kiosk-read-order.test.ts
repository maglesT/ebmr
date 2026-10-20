/**
 * Decision D-P7R-18 (gap F2 of the hosted demo's report): on a shop-floor kiosk, a read that runs as the person's own
 * command (a logged read) answered "tap your badge" (428, EBMR-IAM-120) before the permission refusal, so an operator
 * opening the QP packages or the inspection workspace was first asked to tap and only then refused. The permission
 * check now comes first: a role that holds none of the read's permissions is refused for want of a right (EBMR-IAM-040)
 * without a tap; a role that may read it is still asked for the fresh badge tap of INV-40 (the kernel's per-command
 * attribution is unchanged), and an office session keeps the database's own refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result } from '@ebmr/api-contract';
import { refusalOf, startSigningServer } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';

let gmp: TestServer;
let operator: TestBrowser;
let stores: TestBrowser;
const answer = (r: Result<unknown>): string => (r.ok ? 'OK' : `${String(r.error.kind === 'REFUSAL' ? r.error.status : '')} ${refusalOf(r)?.code ?? JSON.stringify(r.error)}`);

beforeAll(async () => {
  gmp = await startSigningServer('GMP');
  operator = await gmp.asPersona('operator1');
  stores = await gmp.asPersona('stores');
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

describe('kiosk reads: the permission before the badge tap (D-P7R-18)', () => {
  it('[DI-17][INV-40] an operator on a kiosk is refused the inspection workspace, the QP packages, the evidence export file, the contract giver\'s batches and analytics for want of a right, not asked to tap first', async () => {
    expect(operator.terminal).toMatch(/^KIOSK-/);
    expect(answer(await operator.call(routes.archive.inspection))).toBe('422 EBMR-IAM-040');
    expect(answer(await operator.call(routes.qpPackage.readerPackages))).toBe('422 EBMR-IAM-040');
    expect(answer(await operator.call(routes.archive.exportFile, { params: { exportId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e' } }))).toBe('422 EBMR-IAM-040');
    expect(answer(await operator.call(routes.contractGiver.batches))).toBe('422 EBMR-IAM-040');
    expect(answer(await operator.call(routes.analytics.catalog))).toBe('422 EBMR-IAM-040');
  }, 120_000);

  it('[INV-40][DI-14] a read the operator\'s role may make still needs the fresh badge tap on the kiosk (the kernel\'s per-command attribution is unchanged)', async () => {
    // OPERATOR holds RECORD.READ, the India allocation register's permission (recipe-core 0913).
    expect(answer(await operator.call(routes.india.allocationRegister, { query: {} }))).toBe('428 EBMR-IAM-120');
  }, 60_000);

  it('[DI-17] on an office PC a role without the right gets the database\'s own refusal, as before', async () => {
    expect(stores.terminal).not.toMatch(/^KIOSK-/);
    const r = await stores.call(routes.archive.inspection);
    expect(answer(r)).toBe('422 EBMR-IAM-040');
    expect(refusalOf(r)?.why).toMatch(/lacks permission ARCHIVE\.INSPECT/);
  }, 60_000);
});
