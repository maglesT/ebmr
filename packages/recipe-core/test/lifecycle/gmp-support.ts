/**
 * Shared set-up of GMP batch tests: the ERP production order a GMP issue names (slice 5a, D-S5-4; recipe-core 0602).
 * The ERP interface posts it through site.erp_receive_order, with the MBR's BOM for the chosen batch size.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withCommand, type ActorContext } from '../../../kernel/src/db/command.ts';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import type { TestDatabase } from '../../../kernel/test/support/db.ts';
import type { MbrContent } from '../../src/flow/model.ts';

export interface OrderOverrides {
  orderNo?: string;
  siteCode?: string;
  productCode?: string;
  strength?: string;
  batchSize?: string;
  batchSizeUnit?: string;
  bom?: { materialCode: string; quantity: string; unit: string }[];
}

/** The BOM of `content` for its batch size `sizeId`, as the ERP gives it (the MBR quantities are for the first size). */
export function bomFor(content: MbrContent, sizeId: string): { materialCode: string; quantity: string; unit: string }[] {
  const ref = content.header.batchSizes[0];
  const size = content.header.batchSizes.find((s) => s.id === sizeId);
  if (!ref || !size) throw new Error(`no batch size ${sizeId}`);
  if (ref.quantity.value !== size.quantity.value) throw new Error('bomFor scales only the reference size in these tests');
  return content.bom.map((b) => ({ materialCode: b.material, quantity: b.quantity.value, unit: b.quantity.unit }));
}

/** Posts an ERP order for a batch of `content` at batch size `sizeId` (site SITE-1) as `erp` on `pool`; returns its number. */
export async function postOrder(pool: pg.Pool, erp: ActorContext, content: MbrContent, sizeId: string, over: OrderOverrides = {}): Promise<string> {
  const size = content.header.batchSizes.find((s) => s.id === sizeId);
  if (!size) throw new Error(`no batch size ${sizeId}`);
  const orderNo = over.orderNo ?? `PO-${randomUUID().slice(0, 8).toUpperCase()}`;
  await withCommand(pool, { ...erp, correlationId: randomUUID() }, (c) =>
    c.query('select site.erp_receive_order($1::jsonb)', [
      JSON.stringify({
        orderNo,
        siteCode: over.siteCode ?? 'SITE-1',
        productCode: over.productCode ?? content.header.product.code,
        strength: over.strength ?? content.header.product.strength,
        batchSize: over.batchSize ?? size.quantity.value,
        batchSizeUnit: over.batchSizeUnit ?? size.quantity.unit,
        bom: over.bom ?? bomFor(content, sizeId),
        erpReference: `ERP-${orderNo}`,
      }),
    ]),
  );
  return orderNo;
}

/** Posts an ERP order for a batch of `content` at batch size `sizeId` (site SITE-1) as `erp`; returns its number. */
export function gmpOrderFor(db: TestDatabase, erp: SeededActor, content: MbrContent, sizeId: string, over: OrderOverrides = {}): Promise<string> {
  return postOrder(db.app, erp, content, sizeId, over);
}

/** The MBR content of family `familyId`'s latest version (its latest revision), read as the superuser. */
export async function familyContent(db: TestDatabase, familyId: string): Promise<MbrContent> {
  const { rows } = await db.admin.query<{ content: MbrContent }>(
    `select c.content from recipe.mbr_content c join recipe.mbr_version v on v.id = c.version_id
      where v.family_id = $1 order by v.version_number desc, c.revision desc limit 1`,
    [familyId],
  );
  const content = rows[0]?.content;
  if (!content) throw new Error(`family ${familyId} has no content`);
  return content;
}

/**
 * An ERP order for a batch of family `familyId` at size `sizeId`, from its latest content. A family without content, or
 * a size it does not approve, gets an order number the ERP never posted (the tests of those refusals reach them first).
 */
export async function familyOrder(db: TestDatabase, erp: SeededActor, familyId: string, sizeId: string, over: OrderOverrides = {}): Promise<string> {
  const content = await familyContent(db, familyId).catch(() => null);
  if (!content || !content.header.batchSizes.some((s) => s.id === sizeId)) return `PO-NONE-${randomUUID().slice(0, 8).toUpperCase()}`;
  return gmpOrderFor(db, erp, content, sizeId, over);
}
