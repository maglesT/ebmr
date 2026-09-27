/**
 * Authority checks on the batch-number register (B7; DI-17, DI-18): every write needs its permission
 * in the site and product scope of the number, and administrators never define rules or allocate,
 * register, void or recover batch numbers.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileLedger } from '../../kernel/src/continuity/ledger.ts';
import { withProtectedNumbers } from '../../kernel/src/continuity/numbers.ts';
import { withCommand, type ActorContext } from '../../kernel/src/db/command.ts';
import {
  allocateBatchNumber,
  defineBatchNumberRule,
  recoverBatchNumber,
  registerExternalBatchNumber,
  voidBatchNumber,
  type AllocationRequest,
} from '../src/index.ts';
import { createTestDatabase, scopedTestActor, tempDir, tempLedger, testActor, type TestDatabase } from './helpers.ts';

const ZONE = 'Asia/Kolkata';
// The seeded devices are at SITE-1; PLANT2 is another site of the same installation.
const HOME = 'SITE-1';
const OTHER = 'PLANT2';
const dir = tempDir('site-authz');

let db: TestDatabase;
let ledger: FileLedger;
let steward: ActorContext;
let issuer: ActorContext;
let admin: ActorContext;
let operator: ActorContext;
const tag = randomBytes(2).toString('hex').toUpperCase();
const request = (siteCode: string, productCode: string): AllocationRequest => ({
  siteCode,
  productCode,
  productName: `Product ${productCode}`,
  edition: 'TABLETS',
  batchSize: '1000',
  batchSizeUnit: '{tbl}',
});
const again = (ctx: ActorContext): ActorContext => ({ ...ctx, correlationId: randomUUID() });
const allocate = (ctx: ActorContext, req: AllocationRequest) => withProtectedNumbers(db.app, again(ctx), ledger, (c) => allocateBatchNumber(c, req));

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = tempLedger('site-authz', dir.path);
  steward = await testActor(db, { roleCode: 'MASTER_DATA_STEWARD' });
  issuer = await testActor(db, { roleCode: 'BATCH_ISSUER' });
  admin = await testActor(db, { roleCode: 'SYSTEM_ADMINISTRATOR' });
  operator = await testActor(db, { roleCode: 'OPERATOR' });
  const rule = (ruleCode: string, siteCode: string, productCode: string) =>
    withCommand(db.app, again(steward), (c) =>
      defineBatchNumberRule(c, { ruleCode, siteCode, productCode, batchKind: 'PROCESSING', format: `${productCode}{SEQ:4}`, siteZone: ZONE, reason: 'SOP-QA-017', blockSize: 5 }),
    );
  await rule(`AZ-H1-${tag}`, HOME, `H1${tag}`);
  await rule(`AZ-H2-${tag}`, HOME, `H2${tag}`);
  await rule(`AZ-O1-${tag}`, OTHER, `O1${tag}`);
});
afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

describe('batch-number register authority', () => {
  it('[DI-18] a system administrator cannot define a numbering rule, or allocate, register, void or recover a batch number', async () => {
    const mine = await allocate(issuer, request(HOME, `H1${tag}`));
    const refused = 'EBMR-IAM-042';
    await expect(
      withCommand(db.app, again(admin), (c) =>
        defineBatchNumberRule(c, { ruleCode: `AZ-ADM-${tag}`, siteCode: HOME, batchKind: 'PROCESSING', format: 'ADM{SEQ:4}', siteZone: ZONE, reason: 'x' }),
      ),
    ).rejects.toThrow(refused);
    await expect(allocate(admin, request(HOME, `H1${tag}`))).rejects.toThrow(refused);
    await expect(withCommand(db.app, again(admin), (c) => registerExternalBatchNumber(c, { ...request(HOME, `H1${tag}`), batchNumber: `ADM-${tag}`, siteZone: ZONE }))).rejects.toThrow(
      refused,
    );
    await expect(withCommand(db.app, again(admin), (c) => voidBatchNumber(c, mine.allocationId, 'ORDER_CANCELLED', 'x'))).rejects.toThrow(refused);
    await expect(
      withCommand(db.app, again(admin), (c) =>
        recoverBatchNumber(c, { ...request(HOME, `H1${tag}`), restoreEventId: randomUUID(), ruleCode: `AZ-H1-${tag}`, serial: '9', batchNumber: `ADM-R-${tag}`, evidenceReference: 'x' }),
      ),
    ).rejects.toThrow(refused);
  });

  it('[DI-17] an operator cannot define a numbering rule, or allocate, register, void or recover a batch number; a service account registers but cannot allocate', async () => {
    const mine = await allocate(issuer, request(HOME, `H1${tag}`));
    await expect(
      withCommand(db.app, again(operator), (c) =>
        defineBatchNumberRule(c, { ruleCode: `AZ-OP-${tag}`, siteCode: HOME, batchKind: 'PROCESSING', format: 'OP{SEQ:4}', siteZone: ZONE, reason: 'x' }),
      ),
    ).rejects.toThrow(/EBMR-IAM-040 .*BATCH_NUMBER\.RULE_DEFINE/);
    await expect(allocate(operator, request(HOME, `H1${tag}`))).rejects.toThrow(/EBMR-IAM-040 .*BATCH_NUMBER\.ALLOCATE/);
    await expect(
      withCommand(db.app, again(operator), (c) => registerExternalBatchNumber(c, { ...request(HOME, `H1${tag}`), batchNumber: `OP-${tag}`, siteZone: ZONE })),
    ).rejects.toThrow(/EBMR-IAM-040 .*BATCH_NUMBER\.REGISTER_EXTERNAL/);
    await expect(withCommand(db.app, again(operator), (c) => voidBatchNumber(c, mine.allocationId, 'ORDER_CANCELLED', 'x'))).rejects.toThrow(
      /EBMR-IAM-040 .*BATCH_NUMBER\.VOID/,
    );
    await expect(
      withCommand(db.app, again(operator), (c) =>
        recoverBatchNumber(c, { ...request(HOME, `H1${tag}`), restoreEventId: randomUUID(), ruleCode: `AZ-H1-${tag}`, serial: '9', batchNumber: `OP-R-${tag}`, evidenceReference: 'x' }),
      ),
    ).rejects.toThrow(/EBMR-IAM-040 .*BATCH_NUMBER\.RECOVER/);

    const erp = await testActor(db, { source: 'INTEGRATION', legalName: 'ERP interface' });
    await expect(
      withCommand(db.app, again(erp), (c) => registerExternalBatchNumber(c, { ...request(HOME, `H1${tag}`), batchNumber: `ERP-${tag}`, siteZone: ZONE })),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/);
    await expect(allocate(erp, request(HOME, `H1${tag}`))).rejects.toThrow(/EBMR-IAM-040 .*BATCH_NUMBER\.ALLOCATE/);
  });

  it('[DI-17] batch numbers are authorised in their site and product scope: a site-limited issuer acts at its own site only, a product-limited issuer on its own product only', async () => {
    const atHome = await scopedTestActor(db, 'BATCH_ISSUER', { site: HOME });
    expect((await allocate(atHome, request(HOME, `H1${tag}`))).batchNumber).toMatch(new RegExp(`^H1${tag}\\d{4}$`));
    await expect(allocate(atHome, request(OTHER, `O1${tag}`))).rejects.toThrow(/EBMR-IAM-040 .*BATCH_NUMBER\.ALLOCATE .*PLANT2/);
    await expect(
      withCommand(db.app, again(atHome), (c) => registerExternalBatchNumber(c, { ...request(OTHER, `O1${tag}`), batchNumber: `O-EXT-${tag}`, siteZone: ZONE })),
    ).rejects.toThrow(/EBMR-IAM-040 .*BATCH_NUMBER\.REGISTER_EXTERNAL/);
    const elsewhere = await allocate(issuer, request(OTHER, `O1${tag}`));
    await expect(withCommand(db.app, again(atHome), (c) => voidBatchNumber(c, elsewhere.allocationId, 'ORDER_CANCELLED', 'wrong site'))).rejects.toThrow(
      /EBMR-IAM-040 .*BATCH_NUMBER\.VOID/,
    );

    // A grant limited to one product covers numbers of that product only. (The write-ahead block the
    // unrestricted issuer reserved above is used, so no ceiling reservation is needed here.)
    const oneProduct = await scopedTestActor(db, 'BATCH_ISSUER', { site: HOME, product: `H1${tag}` });
    await expect(allocate(oneProduct, request(HOME, `H2${tag}`))).rejects.toThrow(/EBMR-IAM-040 .*BATCH_NUMBER\.ALLOCATE/);
    expect((await allocate(oneProduct, request(HOME, `H1${tag}`))).batchNumber).toMatch(new RegExp(`^H1${tag}\\d{4}$`));
  });
});
