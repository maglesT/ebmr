/**
 * Test world for the slice 5a quality tests (deviation-lite, evidence documents, ERP product master, QC decision): the
 * cast, GMP batch and container fixtures and the signing flow.
 *
 * A GMP batch is planned and issued through recipe-core (its own tests); these tests need only what the batch side's
 * subject resolver (recipe-core 0600) reads: a family, a planned batch, its register allocation and the link between
 * them. The fixture writes them as the superuser with triggers off (the kernel's time-traveller pattern).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { withCommand, type ActorContext } from '../../../kernel/src/db/command.ts';
import { seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { confirmErpMaster, erpMasterAggregateId, type ErpMasterKind } from '../../src/index.ts';
import { signerActor, signFor, type TestDatabase } from '../helpers.ts';

type CommandClient = Parameters<Parameters<typeof withCommand>[2]>[0];

export interface QualityCast {
  operator: SeededActor;
  analyst: SeededActor;
  qcHead: SeededActor;
  qcHead2: SeededActor;
  qa: SeededActor;
  qa2: SeededActor;
  qa3: SeededActor;
  admin: SeededActor;
  erp: SeededActor;
  warehouse: SeededActor;
  /** QA confirming ERP master changes (ERP_MASTER_CONFIRMED, site services 0802), and a second one. */
  qaMaster: SeededActor;
  qaMaster2: SeededActor;
  /** A service identity holding INTERFACE.WRITE (SERVICE_ACCOUNT): not the ERP. */
  service: SeededActor;
}

export async function seedQualityCast(db: TestDatabase): Promise<QualityCast> {
  return {
    operator: await signerActor(db, 'OPERATOR'),
    analyst: await signerActor(db, 'QC_ANALYST'),
    qcHead: await signerActor(db, 'HEAD_OF_QC'),
    qcHead2: await signerActor(db, 'HEAD_OF_QC'),
    qa: await signerActor(db, 'QA_REVIEWER'),
    qa2: await signerActor(db, 'QA_REVIEWER'),
    qa3: await signerActor(db, 'QA_REVIEWER'),
    admin: await signerActor(db, 'SYSTEM_ADMINISTRATOR'),
    erp: await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' }),
    warehouse: await signerActor(db, 'WAREHOUSE_LABELLING'),
    qaMaster: await signerActor(db, 'QA_MBR_APPROVER'),
    qaMaster2: await signerActor(db, 'QA_MBR_APPROVER'),
    service: await seedServiceActor(db, { roleCode: 'SERVICE_ACCOUNT', name: 'Backup service' }),
  };
}

export const TAG = randomBytes(3).toString('hex').toUpperCase();
let serial = 0;
export const unique = (prefix: string): string => `${prefix}${TAG}${(serial++).toString().padStart(3, '0')}`;

export interface GmpBatch {
  id: string;
  number: string;
  site: string;
  productCode: string;
  strength: string;
}

const specTest = (testCode: string, method: string, limits: Record<string, string>, required: boolean) => ({
  testCode, methodReference: method, unit: '%', ...limits, required, pharmacopoeia: 'IP', edition: '2022', sampleQuantity: '0.010', sampleUnit: 'kg',
});
/** The fixtures' specification tests: ASSAY 98.0 to 102.0 % (required), WATER at most 0.5 % (not required). */
export const SPEC_TESTS: Record<string, unknown>[] = [
  specTest('ASSAY', 'STP-AS-01', { lowerLimit: '98.0', upperLimit: '102.0' }, true),
  specTest('WATER', 'STP-KF-01', { upperLimit: '0.5' }, false),
];

export class QualityWorld {
  constructor(
    readonly db: TestDatabase,
    readonly cast: QualityCast,
  ) {}

  run<T>(actor: ActorContext, work: (c: CommandClient) => Promise<T>, reason?: string): Promise<T> {
    const ctx: ActorContext = { ...actor, correlationId: randomUUID() };
    return withCommand(this.db.app, reason ? { ...ctx, reasonCode: 'TEST', reasonText: reason } : ctx, work);
  }

  async sql<T>(actor: ActorContext, text: string, params: unknown[] = []): Promise<T> {
    return this.run(actor, async (c) => ((await c.query(text, params)).rows[0] as { r: T } | undefined)?.r as T);
  }

  sign(signer: SeededActor, aggregate: { type: string; id: string }, meaning: string, expectedState: string | null): Promise<string> {
    return signFor(this.db, signer, aggregate, meaning, expectedState);
  }

  /** Superuser writes with triggers off (fixtures only). */
  async fixture(sql: string, params: unknown[]): Promise<void> {
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

  /** A planned GMP batch with its register allocation (what recipe.site_subject_identity reads). */
  async gmpBatch(site = 'SITE-1', productCode = 'PARA-500', strength = '500 mg'): Promise<GmpBatch> {
    const id = randomUUID();
    const familyId = randomUUID();
    const allocationId = randomUUID();
    const number = unique('B');
    const who = randomUUID();
    await this.fixture(
      `with f as (insert into recipe.mbr_family (id, code, title, edition, record_kind, product_code, product_name, strength, dosage_form, batch_sizes,
                                                 created_by_person, created_by_account)
                  values ($2, $3, 'Fixture family', 'tablets', 'PROCESSING', $5, 'Paracetamol tablets', $6, $3,
                          '[{"id": "BS-1", "quantity": {"value": "100", "unit": "kg"}}]', $7, $7) returning id),
            b as (insert into recipe.stub_batch (id, batch_number, family_id, markets, site, line, batch_size, created_by_person, created_by_account)
                  select $1, $4, f.id, array['IN'], $8, 'LINE-1', 'BS-1', $7, $7 from f returning id),
            a as (insert into site.batch_number_allocation (id, batch_number, site_code, site_zone, product_code, product_name, edition, batch_kind,
                                                            batch_size, batch_size_unit, source, external_reference, allocated_by_person_id,
                                                            allocated_by_account_id, correlation_id)
                  values ($9, $4, $8, 'Asia/Kolkata', $5, 'Paracetamol tablets', 'TABLETS', 'PROCESSING', 100, 'kg', 'EXTERNAL', 'fixture', $7, $7, $7) returning id)
       insert into recipe.batch_allocation_link (batch_id, allocation_id, batch_number, person_id, account_id, correlation_id)
       select b.id, a.id, $4, $7, $7, $7 from b, a`,
      [id, familyId, unique('FAM-'), number, productCode, strength, who, site, allocationId],
    );
    return { id, number, site, productCode, strength };
  }

  /** Posts a material master version as the ERP interface; QA confirms it when it does not take effect on its own (site services 0802). */
  async material(materialCode: string, materialKind = 'EXCIPIENT', unit = 'kg', maxRetestMonths: number | null = 24, materialName = `Material ${materialCode}`): Promise<void> {
    const id = await this.sql<string>(this.cast.erp, 'select site.erp_receive_material($1::jsonb) as r', [
      JSON.stringify({ materialCode, materialName, materialKind, unit, ...(maxRetestMonths ? { maxRetestMonths } : {}), erpReference: `ERP-${materialCode}` }),
    ]);
    if ((await this.masterState('MATERIAL', id)) === 'PENDING') await this.confirm('MATERIAL', id);
  }

  /** PENDING, EFFECTIVE or SUPERSEDED (site services 0802). */
  async masterState(kind: ErpMasterKind, versionId: string): Promise<string> {
    return (await this.db.app.query<{ s: string }>('select site.erp_master_state($1, $2) as s', [kind, versionId])).rows[0]?.s ?? '';
  }

  /** QA's ERP_MASTER_CONFIRMED signature on the version, and the confirmation (site services 0802). */
  async confirm(kind: ErpMasterKind, versionId: string, signer: SeededActor = this.cast.qaMaster): Promise<string> {
    const sig = await this.sign(signer, { type: 'erp_master', id: erpMasterAggregateId(kind, versionId) }, 'ERP_MASTER_CONFIRMED', 'PENDING');
    await this.run(signer, (c) => confirmErpMaster(c, kind, versionId, sig));
    return sig;
  }

  /** A lot received in QUARANTINE at SITE-1 (the material master posted first). */
  async lot(over: { materialCode?: string; materialKind?: string; quantity?: string; retestAt?: string; expiresAt?: string; maxRetestMonths?: number | null } = {}): Promise<{ lotId: string; lotCode: string; materialCode: string }> {
    const materialCode = over.materialCode ?? unique('M');
    const lotCode = unique('L');
    await this.material(materialCode, over.materialKind ?? 'EXCIPIENT', 'kg', over.maxRetestMonths === undefined ? 24 : over.maxRetestMonths);
    await this.specification(materialCode);
    const r = await this.sql<{ lot_id: string }>(this.cast.warehouse, 'select site.receive_lot($1::jsonb) as r', [
      JSON.stringify({ lotCode, materialCode, quantity: over.quantity ?? '5', expiresAt: over.expiresAt ?? '2030-01-01T00:00:00Z', ...(over.retestAt ? { retestAt: over.retestAt } : {}) }),
    ]);
    return { lotId: r.lot_id, lotCode, materialCode };
  }

  /**
   * An approved specification of the material unless one is in effect (site services 0840): `tests`, by default ASSAY
   * 98.0 to 102.0 % (required) and WATER at most 0.5 % (not required), drafted by the analyst, approved by the head of QC.
   */
  async specification(materialCode: string, tests: Record<string, unknown>[] = SPEC_TESTS, site = 'SITE-1'): Promise<string> {
    const { rows } = await this.db.app.query<{ id: string | null }>('select site.specification_in_effect($1, $2) as id', [site, materialCode]);
    if (rows[0]?.id && tests === SPEC_TESTS) return rows[0].id;
    const draft = await this.sql<{ specificationId: string }>(this.cast.analyst, 'select site.draft_specification($1::jsonb) as r', [
      JSON.stringify({ materialCode, title: `Specification of ${materialCode}`, monographReference: 'IP monograph (test)', tests }),
    ]);
    const sig = await this.sign(this.cast.qcHead, { type: 'specification', id: draft.specificationId }, 'SPECIFICATION_APPROVED', 'DRAFT');
    await this.sql(this.cast.qcHead, 'select site.approve_specification($1, $2)', [draft.specificationId, sig]);
    return draft.specificationId;
  }

  /** Posts a product master entry as the ERP interface (a specification of a finished product names its product code). */
  async product(productCode: string, strength = '500 mg'): Promise<void> {
    await this.sql(this.cast.erp, 'select site.erp_receive_product($1::jsonb)', [
      JSON.stringify({ productCode, strength, productName: `Product ${productCode}`, betaLactam: false, shelfLifeMonths: 24, erpReference: `ERP-${productCode}` }),
    ]);
  }

  /** An output container of batch `b` (what the resolver reads for a CONTAINER). */
  async container(b: GmpBatch): Promise<{ id: string; label: string }> {
    const id = randomUUID();
    const label = `OC-${b.number}-${String(1000 + serial++)}`;
    const who = randomUUID();
    await this.fixture(
      `insert into plant.output_container (id, label_code, batch_id, batch_number, product_code, strength, stage, quantity_unit, opened_by_person, opened_by_account)
       values ($1, $2, $3, $4, $5, $6, 'GRANULATION', 'kg', $7, $7)`,
      [id, label, b.id, b.number, b.productCode, b.strength, who],
    );
    return { id, label };
  }
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
