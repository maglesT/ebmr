/**
 * Reads of the quality screens (Phase 3 slice 6a): deviation-lite records by state, kind or batch; the QC extra-testing
 * decision of a batch; the ERP stub's orders, the masters in effect and the versions waiting for QA's confirmation; the
 * material lots of the site. Read-only;
 * every write is a database command (index.ts) and every signed act a signable action (signables.ts).
 */
import type { DeviationView, ErpOrderView, ErpPendingView, ExtraTestingView, LotSummaryView } from '@ebmr/api-contract';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;

export async function deviationIds(db: Db, q: { state?: string | undefined; kind?: string | undefined; batchId?: string | undefined }): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select d.id from site.deviation d
      where ($1::text is null or site.deviation_state(d.id) = $1) and ($2::text is null or d.kind = $2)
        and ($3::uuid is null or exists (select 1 from site.deviation_link l where l.deviation_id = d.id and l.batch_id = $3))
      order by d.raised_at desc, d.id limit 500`,
    [q.state ?? null, q.kind ?? null, q.batchId ?? null],
  );
  return rows.map((r) => r.id);
}

export async function extraTesting(app: AppContext, db: Db, batchId: string): Promise<ExtraTestingView> {
  const { rows } = await db.query<{ r: { decision: 'NONE_REQUIRED' | 'EXTRA_TESTS'; tests: string[]; signatureId: string; decidedAt: string } | null; us: string | null }>(
    `select site.qc_extra_testing_decision_of($1) as r,
            (select ${usOf('d.decided_at')} from site.qc_extra_testing_decision d where d.batch_id = $1 order by d.decided_at desc, d.id desc limit 1) as us`,
    [batchId],
  );
  const r = rows[0];
  return {
    batchId,
    decision: r?.r && r.us ? { decision: r.r.decision, tests: r.r.tests, signatureId: r.r.signatureId, decidedAt: app.formatInstant(r.us) } : null,
  };
}

export async function erpOrders(app: AppContext, db: Db): Promise<ErpOrderView[]> {
  const { rows } = await db.query<{ order_no: string; site_code: string; product_code: string; strength: string; batch_size: string; batch_size_unit: string; bom: ErpOrderView['bom']; erp_reference: string; us: string }>(
    `select o.order_no, o.site_code, o.product_code, o.strength, trim_scale(o.batch_size)::text as batch_size, o.batch_size_unit, o.bom, o.erp_reference, ${usOf('o.received_at')} as us
       from site.erp_production_order o order by o.received_at desc, o.id limit 500`,
  );
  return rows.map((r) => ({
    orderNo: r.order_no,
    siteCode: r.site_code,
    productCode: r.product_code,
    strength: r.strength,
    batchSize: r.batch_size,
    batchSizeUnit: r.batch_size_unit,
    bom: r.bom.map((b) => ({ materialCode: b.materialCode, quantity: b.quantity, unit: b.unit })),
    erpReference: r.erp_reference,
    receivedAt: app.formatInstant(r.us),
  }));
}

export async function erpProducts(db: Db) {
  const { rows } = await db.query<{ product_code: string; strength: string; product_name: string; reprocessing_permitted: boolean | null; beta_lactam: boolean; shelf_life_months: number; erp_reference: string; attrs: { dosageForm?: string } | null }>(
    // The versions in effect (site-services 0802): a version waiting for QA's confirmation is listed by erpPending.
    `select * from (select distinct on (x.master_key) p.product_code, p.strength, p.product_name, p.reprocessing_permitted, p.beta_lactam, p.shelf_life_months, p.erp_reference,
                           (select e.attributes from site.master_entry e where e.version_id = p.id) as attrs
                      from site.erp_master_effect x join site.erp_product p on p.id = x.version_id
                     where x.master_kind = 'PRODUCT' order by x.master_key, x.effective_at desc, x.id desc) e
      order by e.product_code, e.strength`,
  );
  return rows.map((r) => ({
    productCode: r.product_code,
    strength: r.strength,
    productName: r.product_name,
    ...(r.reprocessing_permitted !== null ? { reprocessingPermitted: r.reprocessing_permitted } : {}),
    betaLactam: r.beta_lactam,
    shelfLifeMonths: r.shelf_life_months,
    erpReference: r.erp_reference,
    ...(r.attrs?.dosageForm !== undefined ? { dosageForm: r.attrs.dosageForm } : {}),
  }));
}

export async function erpMaterials(db: Db) {
  const { rows } = await db.query<{ material_code: string; material_name: string; material_kind: 'API' | 'EXCIPIENT' | 'PRIMARY_PACKAGING' | 'PRINTED_PACKAGING' | 'INTERMEDIATE' | 'FINISHED'; unit: string; max_retest_months: number | null; erp_reference: string; attrs: { grade?: string; pharmacopoeia?: string } | null }>(
    // The versions in effect (site-services 0802): a version waiting for QA's confirmation is listed by erpPending.
    `select distinct on (x.master_key) m.material_code, m.material_name, m.material_kind, m.unit, m.max_retest_months, m.erp_reference,
            (select e.attributes from site.master_entry e where e.version_id = m.id) as attrs
       from site.erp_master_effect x join site.erp_material m on m.id = x.version_id
      where x.master_kind = 'MATERIAL' order by x.master_key, x.effective_at desc, x.id desc`,
  );
  return rows.map((r) => ({
    materialCode: r.material_code,
    materialName: r.material_name,
    materialKind: r.material_kind,
    unit: r.unit,
    ...(r.max_retest_months !== null ? { maxRetestMonths: r.max_retest_months } : {}),
    erpReference: r.erp_reference,
    ...(r.attrs?.grade !== undefined ? { grade: r.attrs.grade } : {}),
    ...(r.attrs?.pharmacopoeia !== undefined ? { pharmacopoeia: r.attrs.pharmacopoeia } : {}),
  }));
}

/** The received master versions not yet in effect, with the values in effect beside them (site-services 0802). */
export async function erpPending(app: AppContext, db: Db): Promise<ErpPendingView[]> {
  const { rows } = await db.query<{ v: Omit<ErpPendingView, 'receivedAt'> & { receivedAt: string }; us: string }>(
    `select x.v, ${usOf("(x.v ->> 'receivedAt')::timestamptz")} as us from jsonb_array_elements(site.erp_master_pending()) x(v)`,
  );
  return rows.map(({ v, us }) => ({
    masterKind: v.masterKind,
    key: v.key,
    versionId: v.versionId,
    erpReference: v.erpReference,
    receivedAt: app.formatInstant(us),
    values: v.values,
    inEffect: v.inEffect,
  }));
}

export async function lots(app: AppContext, db: Db, q: { materialCode?: string | undefined; status?: string | undefined; lotId?: string | undefined }): Promise<LotSummaryView[]> {
  const { rows } = await db.query<{
    id: string; lot_code: string; material_code: string; material_name: string; material_kind: string; state: string | null; version: string | null; qty: string | null; unit: string;
    supplier: string | null; supplier_lot: string | null; expiry_us: string | null; retest_us: string | null; received_us: string;
  }>(
    `select l.id, l.lot_code, l.material_code, l.material_name, l.material_kind, s.state, s.version::text as version,
            trim_scale(coalesce(site.lot_quantity(l.id), l.received_quantity))::text as qty, l.unit, l.supplier, l.supplier_lot,
            ${usOf('l.expires_at')} as expiry_us, ${usOf('site.lot_retest_at(l.id)')} as retest_us, ${usOf('l.received_at')} as received_us
       from site.material_lot l
       left join platform.aggregate_state s on s.aggregate_type = 'material_lot' and s.aggregate_id = l.id
      where ($1::text is null or l.material_code = $1) and ($2::text is null or s.state = $2) and ($3::uuid is null or l.id = $3)
      order by l.received_at desc, l.id limit 500`,
    [q.materialCode ?? null, q.status ?? null, q.lotId ?? null],
  );
  return rows.map((r) => ({
    lotId: r.id,
    lotCode: r.lot_code,
    material: { code: r.material_code, name: r.material_name, kind: r.material_kind },
    status: r.state ?? 'UNKNOWN',
    version: r.version ?? '0',
    quantity: r.qty ?? '0',
    unit: r.unit,
    supplier: r.supplier,
    supplierLot: r.supplier_lot,
    expiry: r.expiry_us ? app.formatInstant(r.expiry_us) : null,
    retest: r.retest_us ? app.formatInstant(r.retest_us) : null,
    receivedAt: app.formatInstant(r.received_us),
  }));
}

export type { DeviationView };
