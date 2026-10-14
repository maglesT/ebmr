/**
 * The complete receipt record a purchased lot needs before it is issued (site services 0910; PR-17 clauses 3 and 4): QA's
 * signed approval of the manufacturer for the material, the receipt record (delivery, supplier, supplier batch,
 * manufacturer, two containers) and the examination of both containers by stores. Shared by the lot and quality worlds.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { withCommand } from '../../../kernel/src/db/command.ts';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import { signFor, type TestDatabase } from '../helpers.ts';

const again = (a: SeededActor): SeededActor => ({ ...a, correlationId: randomUUID() });

/** QA proposes and approves (MANUFACTURER_APPROVED) `manufacturerCode` for the material at SITE-1 unless it is approved already; returns the row id or null. */
export async function approveManufacturer(db: TestDatabase, qa: SeededActor, materialCode: string, manufacturerCode = 'MFR-1'): Promise<string | null> {
  const { rows } = await db.app.query<{ ok: boolean }>("select site.manufacturer_approved('SITE-1', $1, $2) as ok", [materialCode, manufacturerCode]);
  if (rows[0]?.ok) return null;
  const id = await withCommand(db.app, again(qa), async (c) =>
    (await c.query<{ id: string }>('select site.propose_approved_manufacturer($1::jsonb) as id', [
      JSON.stringify({ materialCode, manufacturerCode, manufacturerName: `Manufacturer ${manufacturerCode}`, basis: 'Supplier qualification file QF-2026-001 and on-site audit' }),
    ])).rows[0]?.id ?? '',
  );
  const sig = await signFor(db, qa, { type: 'approved_manufacturer', id }, 'MANUFACTURER_APPROVED', 'PROPOSED');
  await withCommand(db.app, again(qa), (c) => c.query('select site.approve_manufacturer($1, $2)', [id, sig]));
  return id;
}

/** The receipt record of a lot received with site.receive_lot and the examination of its two containers. */
export async function completeReceipt(
  db: TestDatabase,
  cast: { qa: SeededActor; warehouse: SeededActor },
  lotId: string,
  materialCode: string,
  manufacturerCode = 'MFR-1',
): Promise<void> {
  await approveManufacturer(db, cast.qa, materialCode, manufacturerCode);
  const { rows } = await db.app.query<{ s: string | null; code: string }>('select supplier_lot as s, lot_code as code from site.material_lot where id = $1', [lotId]);
  const supplierLot = rows[0]?.s ?? `S-${rows[0]?.code ?? lotId.slice(0, 8)}`;
  const deliveryId = `D-${randomBytes(6).toString('hex').toUpperCase()}`;
  await withCommand(db.app, again(cast.warehouse), (c) =>
    c.query('select site.record_lot_receipt($1, $2::jsonb)', [lotId, JSON.stringify({ deliveryId, supplierCode: 'SUP-1', supplierLot, manufacturerCode, containers: '2' })]),
  );
  await withCommand(db.app, again(cast.warehouse), (c) =>
    c.query('select site.record_receipt_examination($1, $2::jsonb)', [lotId, JSON.stringify({ containersExamined: '2', outcome: 'ACCEPTABLE' })]),
  );
}
