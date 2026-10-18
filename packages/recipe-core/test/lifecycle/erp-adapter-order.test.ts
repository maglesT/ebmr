/**
 * The ERP order BOM against the MBR BOM at GMP issue, re-tested through the ERP/WMS adapter (Phase 6 slice 6a, builder
 * A; outline 5.2.2 "PLANNED -> ISSUED: the ERP order BOM matches the MBR BOM"; recipe-core 0602; site services 0913).
 * The order arrives as an inbound message of the registered ERP_WMS adapter (DI-31: provenance kept) and is applied by
 * site.erp_receive_order; a GMP batch is planned against it only when its product, strength, size and BOM match the
 * pinned MBR. As the application role through real identities.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, seedAdministration, seedServiceActor, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { describeTestInterfaces, testInterface } from '../../../kernel/test/support/validation.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as execution from '../../src/execution/index.ts';
import type * as lc from '../../src/lifecycle/index.ts';
import { bomFor } from './gmp-support.ts';
import { cell, seedCast, uniqueContent, World } from './support.ts';

let db: TestDatabase;
let w: World;
let steward: SeededActor;
let adapter: SeededActor;
const dir = tempDir('erp-adapter-order');
const ledger = tempLedger('erp-adapter-order', dir.path);
const SITE = 'SITE-1';
const BS = 'BS-200K';
let seq = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  adapter = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_WMS_INTERFACE', name: 'ERP/WMS adapter' });
  const { admin } = await seedAdministration(db);
  const code = `ERP-${randomBytes(3).toString('hex').toUpperCase()}`;
  // Slice 7c (DI-06, kernel 1350): a GMP installation exchanges messages only with a described interface.
  await describeTestInterfaces(db, [testInterface(code, 'ERP_WMS')]);
  await withCommand(db.app, withReason(admin), (c) =>
    c.query("select iam.register_integration_adapter($1, 'ERP_WMS', $2, $3, 'ERP feed (test)')", [code, adapter.accountId, adapter.deviceId]));
}, 300_000);

afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

type Json = Record<string, unknown>;
function without(content: unknown, types: readonly string[]): unknown {
  if (Array.isArray(content)) {
    return content.filter((x) => !(x && typeof x === 'object' && types.includes(String(((x as Json)['block'] as Json | undefined)?.['type'])))).map((x) => without(x, types));
  }
  if (content && typeof content === 'object') return Object.fromEntries(Object.entries(content).map(([k, v]) => [k, without(v, types)]));
  return content;
}

async function effective(): Promise<{ familyId: string; content: MbrContent }> {
  const m = uniqueContent('tablet-granulation-compression');
  m.header.product = { ...m.header.product, code: m.header.product.code.toUpperCase() };
  const content = without(m, ['G-09', 'G-10']) as MbrContent;
  const v = await w.approvedVersion(content);
  const auth: lc.MarketAuthorisationDefinition = { versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, 'L1', BS)], regulatoryBasis: 'IN: registration on file' };
  await w.authorise(auth);
  await w.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `G-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'G{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
  );
  return { familyId: v.familyId, content };
}

/** The ERP feed delivers a production order (erp.production_order v1) through the adapter's receiving command. */
async function orderThroughAdapter(content: MbrContent, bom: { materialCode: string; quantity: string; unit: string }[]): Promise<{ orderNo: string; messageId: string }> {
  const size = content.header.batchSizes.find((s) => s.id === BS);
  if (!size) throw new Error('no batch size');
  const orderNo = `PO-${randomUUID().slice(0, 8).toUpperCase()}`;
  const payload = {
    orderNumber: orderNo, productCode: content.header.product.code, strength: content.header.product.strength,
    plannedQuantity: { value: size.quantity.value, unit: size.quantity.unit },
    bom: bom.map((b) => ({ materialCode: b.materialCode, quantity: { value: b.quantity, unit: b.unit } })), plannedStart: '1800000000000000',
  };
  seq += 1;
  const env = {
    sourceSystem: 'ERP_WMS', messageType: 'erp.production_order', sourceRecordId: orderNo, sourceTimestamp: '1800000000000000', sequenceNo: seq.toString(),
    idempotencyKey: `erp-${orderNo}`, schemaVersion: '1', payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), payload,
  };
  const r = await withCommand(db.app, { ...adapter, correlationId: randomUUID() }, async (c) =>
    (await c.query<{ r: { messageId: string; outcome: string } }>('select site.erp_wms_receive($1::jsonb) as r', [JSON.stringify(env)])).rows[0]?.r);
  expect(r?.outcome).toBe('ACCEPTED');
  return { orderNo, messageId: r?.messageId ?? '' };
}

const plan = (familyId: string, erpOrder: string) =>
  cmd(db, w.cast.issuer).then((ctx) =>
    withProtectedNumbers(db.app, ctx, ledger, (c) => execution.prepareGmpIssue(c, randomUUID(), { familyId, markets: ['IN'], site: SITE, line: 'L1', batchSize: BS, erpOrder })));

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e))?.[1] ?? String(e);
  }
}

describe('the ERP order BOM at GMP issue, through the ERP/WMS adapter (outline 5.2.2; D-S5-4)', () => {
  it('[PR-17][DI-31] an ERP order received through the adapter plans a GMP batch only when its BOM matches the MBR BOM; the order keeps its inbound message', async () => {
    const { familyId, content } = await effective();
    const bom = bomFor(content, BS);
    const first = bom[0];
    if (!first) throw new Error('the fixture has a BOM');
    // A BOM that differs from the MBR's (a line missing, another quantity) blocks the issue.
    const missing = await orderThroughAdapter(content, bom.slice(1));
    expect(await codeOf(plan(familyId, missing.orderNo))).toBe('EBMR-EXE-605');
    const other = await orderThroughAdapter(content, [{ ...first, quantity: `${first.quantity}1` }, ...bom.slice(1)]);
    expect(await codeOf(plan(familyId, other.orderNo))).toBe('EBMR-EXE-605');
    // The matching order plans the batch; the order row and its message name the same source record.
    const good = await orderThroughAdapter(content, bom);
    const planned = await plan(familyId, good.orderNo);
    expect(planned.erpOrder).toBe(good.orderNo);
    const { rows } = await db.app.query('select o.erp_reference, m.source_record_id, m.message_type from site.erp_production_order o join platform.inbound_message m on m.source_record_id = o.erp_reference where o.order_no = $1 and m.id = $2', [good.orderNo, good.messageId]);
    expect(rows).toEqual([{ erp_reference: good.orderNo, source_record_id: good.orderNo, message_type: 'erp.production_order' }]);
  });
});
