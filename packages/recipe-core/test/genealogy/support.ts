/**
 * Test world for the genealogy, the mock recall and the deviation queries (Phase 6 slice 6d; recipe-core 1010 to 1012,
 * site services 0960, 0961).
 *
 * Fixtures, not proofs: batches (their register allocation and execution row), lot consumption, output containers,
 * merges, bulk issues, reprocessing links and additions are written by the superuser with triggers off, because each
 * event's own act and its guard are proven where the event is built (Phase 3 and 4 tests); the genealogy only reads the
 * rows those acts leave. Proven for real here: finished lots (site.create_finished_lot), returned goods and QC's signed
 * assessment, the chemical recovery act, the shipments the ERP/WMS adapter sends (through the shipping interlock), the
 * deviations and their links, the mock recall and its AP sign-off.
 */
import { createHash, randomUUID } from 'node:crypto';
import { withCommand } from '../../../kernel/src/db/command.ts';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import { signFor } from '../../../kernel/test/records/helpers.ts';
import type { TestDatabase } from '../../../kernel/test/support/db.ts';
import { signerActor } from '../../../site-services/test/helpers.ts';
import { ErpWorld } from '../../../site-services/test/erp-wms/support.ts';

export const TAG = randomUUID().slice(0, 4).toUpperCase();
let serial = 0;
export const unique = (prefix: string): string => `${prefix}${TAG}${(serial++).toString().padStart(3, '0')}`;

export type Kind = 'LOT' | 'BATCH' | 'CONTAINER' | 'SHIPMENT';
export interface Row {
  node_kind: Kind;
  node_id: string;
  parent_kind: Kind | null;
  parent_id: string | null;
  edge_kind: string | null;
  depth: number;
}
export interface Batch {
  id: string;
  number: string;
  productCode: string;
}
export interface Lot {
  id: string;
  code: string;
}

/** The error message of a rejected promise ('' when it resolved). */
export async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export class GenealogyWorld {
  /** id -> a readable name for the assertions. */
  readonly names = new Map<string, string>();
  ap!: SeededActor;
  operator!: SeededActor;

  private constructor(
    readonly db: TestDatabase,
    readonly erp: ErpWorld,
  ) {}

  static async create(db: TestDatabase): Promise<GenealogyWorld> {
    const w = new GenealogyWorld(db, await ErpWorld.create(db));
    w.ap = await signerActor(db, 'AUTHORISED_PERSON');
    w.operator = await signerActor(db, 'OPERATOR');
    return w;
  }

  get cast() {
    return this.erp.cast;
  }

  name(id: string, n: string): string {
    this.names.set(id, n);
    return id;
  }

  async run<T>(actor: SeededActor, sql: string, params: unknown[] = []): Promise<T> {
    return withCommand(this.db.app, { ...actor, correlationId: randomUUID(), reasonCode: 'TEST', reasonText: 'genealogy test' }, async (c) =>
      (await c.query<{ r: T }>(sql, params)).rows[0]?.r as T);
  }

  /** Superuser writes with triggers off (fixtures only). */
  async fixture(sql: string, params: unknown[] = []): Promise<void> {
    const c = await this.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query(sql, params);
      await c.query('commit');
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
  }

  async now(): Promise<string> {
    return (await this.db.admin.query<{ t: string }>("select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as t")).rows[0]!.t;
  }

  /**
   * A batch of `productCode`: its family, planned batch, register allocation (a PACKAGING one under `parent`'s), its link,
   * and an execution row whose test package names the product (what recipe.batch_product reads).
   */
  async batch(n: string, productCode = 'GEN-500', parent?: Batch): Promise<Batch> {
    const id = randomUUID();
    const number = unique('B');
    const who = randomUUID();
    const hash = createHash('sha256').update(id).digest('hex');
    const allocationId = randomUUID();
    const parentAllocation = parent
      ? (await this.db.admin.query<{ a: string }>('select allocation_id::text as a from recipe.batch_allocation_link where batch_id = $1', [parent.id])).rows[0]!.a
      : null;
    await this.fixture(
      `with f as (insert into recipe.mbr_family (id, code, title, edition, record_kind, product_code, product_name, strength, dosage_form, batch_sizes,
                                                 created_by_person, created_by_account)
                  values (gen_random_uuid(), $2, 'Fixture family', 'tablets', $8, $3, 'Genealogy tablets', '500 mg', $2,
                          '[{"id": "BS-1", "quantity": {"value": "100", "unit": "kg"}}]', $4, $4) returning id),
            b as (insert into recipe.stub_batch (id, batch_number, family_id, markets, site, line, batch_size, created_by_person, created_by_account)
                  select $1, $5, f.id, array['IN'], 'SITE-1', 'LINE-1', 'BS-1', $4, $4 from f returning id),
            a as (insert into site.batch_number_allocation (id, batch_number, site_code, site_zone, product_code, product_name, edition, batch_kind,
                                                            parent_allocation_id, batch_size, batch_size_unit, source, external_reference,
                                                            allocated_by_person_id, allocated_by_account_id, correlation_id)
                  values ($6, $5, 'SITE-1', 'Asia/Kolkata', $3, 'Genealogy tablets', 'TABLETS', $8, $7, 100, 'kg', 'EXTERNAL', 'fixture', $4, $4, $4) returning id),
            l as (insert into recipe.batch_allocation_link (batch_id, allocation_id, batch_number, person_id, account_id, correlation_id)
                  select b.id, a.id, $5, $4, $4, $4 from b, a returning batch_id),
            p as (insert into recipe.test_package (package_hash, file_name, package, content, content_hash, family_id, family_code, product, version_id, version_number,
                                                   revision, version_state, exporter, exported_at_us, source, imported_by_person, imported_by_account, correlation_id)
                  values ($9, $9 || '.json', '{}', '{}', $9, gen_random_uuid(), 'FAM', jsonb_build_object('code', $3::text, 'name', 'Genealogy tablets', 'strength', '500 mg', 'dosageForm', 'TABLET'),
                          gen_random_uuid(), '1', 1, 'APPROVED', '{}', 0, '{}', $4, $4, $4) returning package_hash)
       insert into recipe.batch_execution (id, batch_number, package_hash, content_hash, installation, purpose, engine_version, registry_fingerprint, policy,
                                           policy_hash, issue_request, market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person,
                                           issued_by_account, correlation_id)
       select $1, $5, p.package_hash, $9, 'SANDBOX', 'SANDBOX_TEST_RUN', '1', $9, '{}', $9, '{}', '{IN}', 'BS', 'SITE-1', 'Asia/Kolkata', 0, $4, $4, $4 from p, l`,
      [id, unique('FAM-'), productCode, who, number, allocationId, parentAllocation, parent ? 'PACKAGING' : 'PROCESSING', hash],
    );
    this.name(id, n);
    return { id, number, productCode };
  }

  /** A received material lot (fixture; its receipt is proven in site services). */
  async materialLot(n: string, kind = 'API', materialCode = 'API-1', unit = 'kg'): Promise<Lot> {
    const id = randomUUID();
    const code = unique('L');
    const who = randomUUID();
    await this.fixture(
      `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                      received_by_person, received_by_account, correlation_id)
       values ($1, 'SITE-1', $2, $3, 'Material ' || $3, $4, 1000, $5, '2030-01-01T00:00:00Z', $6, $6, $6)`,
      [id, code, materialCode, kind, unit, who],
    );
    this.name(id, n);
    return { id, code };
  }

  /** Batch `b` consumed `qty` of lot `l` (the CONSUMED edge; fixture). */
  async consume(l: Lot, b: Batch, qty = '10'): Promise<void> {
    const who = randomUUID();
    await this.fixture(
      `insert into site.lot_consumption (lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before, quantity_after,
                                         market_set, identity_basis, consumed_by_person, consumed_by_account, xact_id)
       select $1, gen_random_uuid(), $2, $3, 'TABLETS', l.material_code, $4::numeric, l.unit, 1000, 1000 - $4::numeric, '{IN}', 'INTERMEDIATE', $5, $5, 1
         from site.material_lot l where l.id = $1`,
      [l.id, b.id, b.number, qty, who],
    );
  }

  /** An output container of batch `b` (the OUTPUT edge; fixture). */
  async container(n: string, b: Batch): Promise<string> {
    const id = randomUUID();
    const who = randomUUID();
    await this.fixture(
      `insert into plant.output_container (id, label_code, batch_id, batch_number, product_code, strength, stage, quantity_unit, opened_by_person, opened_by_account)
       values ($1, $2, $3, $4, $5, '500 mg', 'COMPRESSION', 'kg', $6, $6)`,
      [id, `OC-${b.number}-${String(1000 + serial++)}`, b.id, b.number, b.productCode, who],
    );
    return this.name(id, n);
  }

  async merge(source: string, target: string): Promise<void> {
    await this.fixture('insert into plant.container_merge (source_id, target_id, person_id, account_id) values ($1, $2, gen_random_uuid(), gen_random_uuid())', [source, target]);
  }

  /** Bulk container `c` of `parent` issued to packaging order `order` (the BULK_ISSUE edge; fixture). */
  async bulkIssue(c: string, parent: Batch, order: Batch): Promise<void> {
    await this.fixture(
      `with ch as (insert into plant.container_charge (container_id, batch_id, stage, purpose, scanned_label, person_id, account_id)
                   select $1, $3, 'PACKAGING', 'PACK', o.label_code, gen_random_uuid(), gen_random_uuid() from plant.output_container o where o.id = $1 returning id)
       insert into recipe.packaging_bulk_issue (order_batch_id, parent_batch_id, container_id, charge_id, quantity, unit, person_id, account_id)
       select $3, $2, $1, ch.id, 25, 'kg', gen_random_uuid(), gen_random_uuid() from ch`,
      [c, parent.id, order.id],
    );
  }

  /** Whole-batch reprocessing: `child` reprocesses `parent` (the REPROCESSED edge; fixture). */
  async reprocessed(parent: Batch, child: Batch): Promise<void> {
    await this.fixture(
      `insert into recipe.batch_parent_link (child_batch_id, parent_batch_id, parent_batch_number, parent_containers, request_id)
       values ($1, $2, $3, '{}', gen_random_uuid())`,
      [child.id, parent.id, parent.number],
    );
  }

  /** An addition from `source` into `target` (REPROCESSING_ADDITION or RECOVERY_ADDITION; fixture). */
  async addition(source: Batch, target: Batch, c: string, caseCode: 'REPROCESSING_ADDITION' | 'RECOVERY'): Promise<void> {
    await this.fixture(
      `insert into recipe.source_addition (batch_id, batch_number, step_key, entry_id, block, container_id, case_code, net_quantity, unit, source_batch_id,
                                           source_batch_number, product_code, strength, source_generated_at, source_manufactured_at, added_by_person)
       values ($1, $2, 'blend@', 'EN-' || (1 + floor(random() * 1000000))::int, 'G-24@2', $3, $4, 5, 'kg', $5, $6, $7, '500 mg', now(), now(), gen_random_uuid())`,
      [target.id, target.number, c, caseCode, source.id, source.number, source.productCode],
    );
  }

  /** The finished lot of packaging batch `b`, posted as the edition's definer posts it (real). */
  async finishedLot(n: string, b: Batch, markets: string[] = ['IN'], quantity = '1000'): Promise<Lot> {
    const id = await withCommand(this.db.admin, { ...this.cast.warehouse, correlationId: randomUUID() }, async (c) =>
      (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
        JSON.stringify({ batchId: b.id, batchNumber: b.number, edition: 'TABLETS', siteCode: 'SITE-1', productCode: b.productCode, productName: `Product ${b.productCode}`,
                         strength: '500 mg', markets, quantity, unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
      ])).rows[0]!.id,
    );
    this.name(id, n);
    return { id, code: b.number };
  }

  /** The state the AP's manufacturer release leaves (recipe-core 0781): its decision row and the lot RELEASED (fixture). */
  async released(l: Lot): Promise<void> {
    await this.fixture(
      `insert into recipe.manufacturer_release_decision (lot_id, decision, signature_id, epoch, checklist, checklist_hash, content_hash, person_id, account_id, role_code, correlation_id)
       values ($1, 'RELEASED', gen_random_uuid(), repeat('0', 64), '{}', repeat('0', 64), 'fixture', $2, $3, 'AUTHORISED_PERSON', gen_random_uuid())`,
      [l.id, this.ap.personId, this.ap.accountId],
    );
    await this.fixture("update platform.aggregate_state set state = 'RELEASED' where aggregate_type = 'material_lot' and aggregate_id = $1", [l.id]);
  }

  /** A shipment the ERP/WMS adapter sends (its receiving command, the interlock and the distribution fields run for real). */
  async ship(l: Lot, consignee: string, quantity: string, over: Record<string, unknown> = {}): Promise<{ shipmentId: string; payload: Record<string, unknown> }> {
    const payload = {
      shipmentId: unique('SH'), lotNumber: l.code, consigneeCode: consignee, consigneeName: `Consignee ${consignee}`,
      consigneeAddress: `${consignee} Road, Pune`, quantity: { value: quantity, unit: 'units' }, shippedAt: '1790000000000000', ...over,
    };
    const r = await this.erp.inbound(this.erp.envelope('erp.shipment', payload));
    const shipmentId = (r.applied as { shipmentId: string }).shipmentId;
    this.name(shipmentId, `S:${String(payload.shipmentId)}`);
    return { shipmentId, payload };
  }

  /** Returned goods of finished lot `l`, QC's signed assessment choosing chemical recovery, and the recovery (all real). */
  async recover(n: string, l: Lot, quantity = '100'): Promise<{ returned: Lot; recovered: Lot }> {
    const g = await this.run<{ lotId: string; lotCode: string }>(this.cast.warehouse, 'select site.receive_returned_goods($1::jsonb) as r', [
      JSON.stringify({ originalLotId: l.id, quantity, reason: 'Recovered after a distributor complaint', returnedFrom: 'Distributor Pune' }),
    ]);
    const assessment = await this.run<string>(this.cast.qcHead, 'select site.record_returned_goods_assessment($1, $2::jsonb)::text as r', [
      g.lotId, JSON.stringify({ nature: 'Film-coated tablets', storage: 'Below 25 C', conditionHistory: 'Cartons intact, cold chain not needed', timeSinceIssue: '2 months', doubt: false, implicatesOtherBatches: false, disposition: 'CHEMICAL_RECOVERY' }),
    ]);
    const sig = await signFor(this.db, this.cast.qcHead, { type: 'returned_goods', id: g.lotId }, 'RETURNED_GOODS_ASSESSED', assessment);
    await this.run(this.cast.qcHead, 'select site.sign_returned_goods_assessment($1, $2)', [g.lotId, sig]);
    const rec = await this.run<{ lotId: string; lotCode: string }>(this.cast.warehouse, 'select site.record_chemical_recovery($1, $2::jsonb) as r', [
      g.lotId, JSON.stringify({ materialCode: 'API-REC', materialName: 'Recovered API', quantity: '40', unit: 'kg', expiresAt: '2029-01-01T00:00:00Z', processReference: 'SOP-REC-01 run 7' }),
    ]);
    this.name(g.lotId, `${n}-returned`);
    this.name(rec.lotId, `${n}-recovered`);
    return { returned: { id: g.lotId, code: g.lotCode }, recovered: { id: rec.lotId, code: rec.lotCode } };
  }

  async trace(kind: Kind, id: string, direction: 'FORWARD' | 'BACKWARD', asOf: string | null = null): Promise<Row[]> {
    return (await this.db.app.query<Row>('select * from recipe.genealogy($1, $2, $3, $4::timestamptz)', [kind, id, direction, asOf])).rows;
  }

  /** The trace's rows as readable "node <- parent (edge) @depth" lines, sorted. */
  lines(rows: Row[]): string[] {
    const n = (id: string | null) => (id === null ? '-' : (this.names.get(id) ?? id));
    return rows.map((r) => `${n(r.node_id)} <- ${n(r.parent_id)} (${r.edge_kind ?? '-'}) @${r.depth}`).sort();
  }

  /** The distinct node names of a trace, sorted. */
  nodes(rows: Row[]): string[] {
    return [...new Set(rows.map((r) => this.names.get(r.node_id) ?? r.node_id))].sort();
  }
}
