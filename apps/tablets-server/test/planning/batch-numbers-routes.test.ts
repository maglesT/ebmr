/**
 * The batch-number register over HTTP (Phase 7 slice 7g, WP4; contract ns/planning.ts; decision 0025; site services
 * 0600): the issuer registers a number issued outside the system, voids a number with a reason code and text, and
 * re-enters a number issued in the window a completed restore skipped. A number is never given again, voided ones
 * included; every right (BATCH_NUMBER.*) and rule is the database's, and these tests prove the routes reach them.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { actorOfBrowser, refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';

const P = routes.planning;
let gmp: TestServer;
/** The database's refusal as the server answers it: its code, then why. */
const refused = (r: Result<unknown>): string => `${refusalOf(r)?.code ?? ''} ${refusalOf(r)?.why ?? ''}`;
let issuer: TestBrowser;
let stores: TestBrowser;

const number = () => `X${randomUUID().slice(0, 6).toUpperCase()}`;
const identity = { productCode: 'PCM-500', productName: 'Paracetamol tablets 500 mg', edition: 'TABLETS' as const, batchSize: '100000', batchSizeUnit: '{tbl}' };

beforeAll(async () => {
  gmp = await startSigningServer('GMP');
  [issuer, stores] = await Promise.all([gmp.asPersona('issuer'), gmp.asPersona('stores')]);
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

describe('the batch-number register (IN-18)', () => {
  it('[IN-18] the issuer registers an external number; it is listed with its reference; the same number again is refused; a person without the right is refused', async () => {
    const n = number();
    const body = { batchNumber: n, batchKind: 'PROCESSING' as const, externalReference: 'SAP-PO-4711', ...identity };
    expect(refusalOf(await stores.call(P.registerExternalBatchNumber, { body }))?.code).toBe('EBMR-IAM-040');
    const registered = valueOf(await issuer.call(P.registerExternalBatchNumber, { body }));
    expect(registered).toMatchObject({ batchNumber: n, source: 'EXTERNAL', externalReference: 'SAP-PO-4711', status: 'ALLOCATED', siteCode: 'SITE-1', productCode: 'PCM-500' });
    expect(valueOf(await issuer.call(P.batchNumbers)).numbers.find((x) => x.batchNumber === n)).toMatchObject({ allocationId: registered.allocationId, status: 'ALLOCATED' });
    expect(refused(await issuer.call(P.registerExternalBatchNumber, { body }))).toMatch(/EBMR-SITE-013 .* already in the allocation register/);
    // A packaging number names an allocated processing number of the site.
    expect(refused(await issuer.call(P.registerExternalBatchNumber, { body: { ...body, batchNumber: number(), batchKind: 'PACKAGING', parentBatchNumber: number() } }))).toMatch(/EBMR-SITE-014/);
  }, 120_000);

  it('[IN-18] a number is voided with a reason code and text; it stays in the register, voided, and is never given again; a second void and a person without the right are refused', async () => {
    const n = number();
    const { allocationId } = valueOf(await issuer.call(P.registerExternalBatchNumber, { body: { batchNumber: n, batchKind: 'PROCESSING', externalReference: 'SAP-PO-4712', ...identity } }));
    const params = { allocationId };
    const body = { reasonCode: 'ORDER_CANCELLED', reasonText: 'The ERP order was cancelled before issue' };
    expect((await issuer.call(P.voidBatchNumber, { params, body: { ...body, reasonCode: 'cancelled' } })).ok).toBe(false);
    expect(refusalOf(await stores.call(P.voidBatchNumber, { params, body }))?.code).toBe('EBMR-IAM-040');
    expect(valueOf(await issuer.call(P.voidBatchNumber, { params, body }))).toMatchObject({ batchNumber: n, status: 'VOIDED', voidReasonCode: 'ORDER_CANCELLED', voidReasonText: body.reasonText });
    expect(valueOf(await issuer.call(P.batchNumbers)).numbers.find((x) => x.allocationId === allocationId)?.status).toBe('VOIDED');
    expect(refused(await issuer.call(P.voidBatchNumber, { params, body }))).toMatch(/EBMR-SITE-015 .* already voided/);
    // Never given again: registering the voided number is refused.
    expect(refused(await issuer.call(P.registerExternalBatchNumber, { body: { batchNumber: n, batchKind: 'PROCESSING', externalReference: 'SAP-PO-4713', ...identity } }))).toMatch(/EBMR-SITE-013 .*never reused/);
    expect(refused(await issuer.call(P.voidBatchNumber, { params: { allocationId: randomUUID() }, body }))).toMatch(/EBMR-SITE-015 allocation .* does not exist/);
  }, 120_000);

  it('[IN-18] a recovery after a restore names a known numbering rule and a completed restore event whose skipped range holds the serial; otherwise it is refused and nothing is registered; a person without the right is refused', async () => {
    const n = number();
    const body = { restoreEventId: randomUUID(), ruleCode: `NO-${randomUUID().slice(0, 6)}`, serial: '7', batchNumber: n, evidenceReference: 'Paper BMR cover sheet PB-0193', ...identity };
    expect(refused(await issuer.call(P.recoverBatchNumber, { body }))).toMatch(/EBMR-SITE-016 unknown numbering rule/);
    // A rule of the site for the product (the master-data steward's, under its reason).
    const ruleCode = `R-${randomUUID().slice(0, 8).toUpperCase()}`;
    const steward = await gmp.asPersona('steward');
    await withCommand(gmp.db.app, await actorOfBrowser(gmp, steward, 'steward', { reasonCode: 'TEST', reasonText: 'Numbering SOP-QA-017 rev 3' }), (c) =>
      c.query('select site.define_batch_number_rule($1::jsonb)', [
        JSON.stringify({ rule_code: ruleCode, site_code: 'SITE-1', product_code: identity.productCode, batch_kind: 'PROCESSING', format: 'X{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
      ]),
    );
    expect(refusalOf(await stores.call(P.recoverBatchNumber, { body: { ...body, ruleCode } }))?.code).toBe('EBMR-IAM-040');
    expect(refused(await issuer.call(P.recoverBatchNumber, { body: { ...body, ruleCode } }))).toMatch(/EBMR-SITE-016 recovery needs a completed restore event/);
    expect(valueOf(await issuer.call(P.batchNumbers)).numbers.some((x) => x.batchNumber === n)).toBe(false);
  }, 120_000);

  it('[IN-18] the register lists the serials a rule skipped and never gave, with the numbers, the reason and the time (owner decision 13 November 2026, retest item 9c)', async () => {
    const steward = await gmp.asPersona('steward');
    const code = `RT-${randomUUID().slice(0, 6).toUpperCase()}`;
    valueOf(await steward.call(P.defineBatchNumberRule, { body: { ruleCode: code, batchKind: 'PROCESSING', format: 'RT{YY}{SEQ:4}', reason: 'Numbering SOP-QA-017 rev 4' } }));
    // Test arrangement: the database recorded that a server start retired serials 52 to 100 of the rule's counter.
    const c = await gmp.db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      await c.query("insert into continuity.sequence_bump (sequence_key, source_kind, reason, value_before, value_after, correlation_id) values ($1, 'COUNTER', 'SERVER_RESTART', 51, 100, gen_random_uuid())", [`site.batch_number:${code}`]);
      await c.query('commit');
    } finally {
      c.release();
    }
    const retired = (valueOf(await issuer.call(P.batchNumbers)).retired ?? []).filter((r) => r.ruleCode === code);
    expect(retired).toHaveLength(1);
    expect(retired[0]).toMatchObject({ firstSerial: '52', lastSerial: '100', reason: 'SERVER_RESTART' });
    expect(retired[0]?.firstNumber).toMatch(/^RT\d{2}0052$/);
    expect(retired[0]?.lastNumber).toMatch(/^RT\d{2}0100$/);
    expect(retired[0]?.recordedAt.text).toMatch(/\d{2}-[A-Z]{3}-\d{4}/);
  }, 120_000);
});
