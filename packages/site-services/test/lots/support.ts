/**
 * Test world for the material-lot tests: the cast (warehouse, QC analyst, head of QC, QA, dispenser, witness,
 * administrator, operator), lot fixtures, the signing flow and batch fixtures.
 *
 * Batch records are issued only in the sandbox (recipe-core 0210) and their issue path is tested there; the
 * consumption tests need only the batch's id, number and market set, so a batch row is written as a fixture by the
 * superuser with triggers off (the kernel's time-traveller pattern), exactly as recipe.consume_lot reads it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { withCommand, type ActorContext } from '../../../kernel/src/db/command.ts';
import { decideRoleGrant, requestRoleGrant } from '../../../kernel/src/identity/admin.ts';
import { seedAdministration, seedServiceActor, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import {
  changeLotStatus,
  enableVendorRoute,
  proposeLotDecision,
  proposeVendorRoute,
  receiveLot,
  recordIdentityResult,
  reserveLot,
  type LotQaDecision,
  type LotReceipt,
  type MaterialKind,
  type ReceivedLot,
} from '../../src/index.ts';
import { signerActor, signFor, type TestDatabase } from '../helpers.ts';

/** The client a command runs on (the kernel's withCommand). */
type CommandClient = Parameters<Parameters<typeof withCommand>[2]>[0];

export interface Cast {
  warehouse: SeededActor;
  analyst: SeededActor;
  qcHead: SeededActor;
  qa: SeededActor;
  dispenser: SeededActor;
  witness: SeededActor;
  admin: SeededActor;
  operator: SeededActor;
  /** The ERP interface: posts the material master a receipt takes the kind, name and unit from (site services 0750). */
  erp: SeededActor;
  /** QA confirms a new or changed material master (ERP_MASTER_CONFIRMED, site services 0802). */
  qaMaster: SeededActor;
}

export async function seedCast(db: TestDatabase): Promise<Cast> {
  return {
    warehouse: await signerActor(db, 'WAREHOUSE_LABELLING'),
    analyst: await signerActor(db, 'QC_ANALYST'),
    qcHead: await signerActor(db, 'HEAD_OF_QC'),
    qa: await signerActor(db, 'QA_REVIEWER'),
    dispenser: await signerActor(db, 'DISPENSER'),
    witness: await signerActor(db, 'VERIFIER'),
    admin: await signerActor(db, 'SYSTEM_ADMINISTRATOR'),
    operator: await signerActor(db, 'OPERATOR'),
    erp: await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' }),
    qaMaster: await signerActor(db, 'QA_MBR_APPROVER'),
  };
}

/** The same person acting in a second role (a second grant on the same account). */
export async function withSecondRole(db: TestDatabase, actor: SeededActor, roleCode: string): Promise<SeededActor> {
  const { admin, owner } = await seedAdministration(db);
  const grantId = await withCommand(db.app, withReason(admin), (c) => requestRoleGrant(c, { accountId: actor.accountId, roleCode, scope: {}, reason: 'test: second role' }));
  await withCommand(db.app, withReason(owner), (c) => decideRoleGrant(c, grantId, true, 'approved for test'));
  return { ...actor, roleCode };
}

export const TAG = randomBytes(3).toString('hex').toUpperCase();
let serial = 0;
export const unique = (prefix: string): string => `${prefix}${TAG}${(serial++).toString().padStart(3, '0')}`;

/** A fresh correlation id and, when given, a reason. */
export function as<T extends ActorContext>(ctx: T, reason?: string): T {
  const out: T = { ...ctx, correlationId: randomUUID() };
  if (reason) return { ...out, reasonCode: 'TEST', reasonText: reason };
  delete out.reasonCode;
  delete out.reasonText;
  return out;
}

export class World {
  constructor(
    readonly db: TestDatabase,
    readonly cast: Cast,
  ) {}

  run<T>(actor: ActorContext, work: (c: CommandClient) => Promise<T>, reason?: string): Promise<T> {
    return withCommand(this.db.app, as(actor, reason), work);
  }

  async isoIn(seconds: number): Promise<string> {
    const { rows } = await this.db.app.query<{ t: string }>(
      "select to_char((clock_timestamp() + make_interval(secs => $1)) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as t",
      [seconds],
    );
    return rows[0]?.t ?? '';
  }

  /**
   * Receives a lot in QUARANTINE. Unless `results` is false, the material gets an approved specification with one
   * required ASSAY test (site services 0840) and the lot a passing, QC-approved RELEASE result of it (0841: a lot
   * without its required results is not released).
   */
  async receive(kind: MaterialKind, overrides: Partial<LotReceipt> = {}, results = true): Promise<ReceivedLot & { materialCode: string; lotCode: string }> {
    const materialCode = overrides.materialCode ?? unique(`M${kind.slice(0, 3)}`);
    const lotCode = overrides.lotCode ?? unique('L');
    // The ERP's material master first (a receipt takes the kind, name and unit from it; site services 0750).
    await this.material(materialCode, overrides.materialName ?? `Material ${materialCode}`, overrides.materialKind ?? kind, overrides.unit ?? 'kg');
    if (results) await this.specification(materialCode);
    const lot = await this.run(this.cast.warehouse, (c) =>
      receiveLot(c, {
        lotCode,
        materialCode,
        materialName: `Material ${materialCode}`,
        materialKind: kind,
        quantity: '10.000',
        unit: 'kg',
        expiresAt: '2030-01-01T00:00:00Z',
        ...overrides,
      }),
    );
    if (results) await this.passingResult(lot.lotId);
    return { ...lot, materialCode, lotCode };
  }

  /** An approved specification of the material (drafted by the analyst, approved by the head of QC) unless one is in effect. */
  async specification(materialCode: string, tests: Record<string, unknown>[] = [ASSAY_TEST]): Promise<string> {
    const { rows } = await this.db.app.query<{ id: string | null }>("select site.specification_in_effect('SITE-1', $1) as id", [materialCode]);
    if (rows[0]?.id) return rows[0].id;
    const draft = await this.run(this.cast.analyst, async (c) =>
      (await c.query<{ r: { specificationId: string } }>('select site.draft_specification($1::jsonb) as r', [
        JSON.stringify({ materialCode, title: `Specification of ${materialCode}`, monographReference: 'IP monograph (test)', tests }),
      ])).rows[0]?.r.specificationId ?? '',
    );
    const sig = await signFor(this.db, this.cast.qcHead, { type: 'specification', id: draft }, 'SPECIFICATION_APPROVED', 'DRAFT');
    await this.run(this.cast.qcHead, (c) => c.query('select site.approve_specification($1, $2)', [draft, sig]));
    return draft;
  }

  /** A passing ASSAY RELEASE result recorded by the analyst and approved by the head of QC. */
  async passingResult(lotId: string, testCode = 'ASSAY', value = '99.5'): Promise<string> {
    const id = await this.run(this.cast.analyst, async (c) =>
      (await c.query<{ r: { resultId: string } }>('select site.record_lot_test_result($1, $2::jsonb) as r', [lotId, JSON.stringify({ testCode, purpose: 'RELEASE', value })])).rows[0]?.r
        .resultId ?? '',
    );
    const sig = await signFor(this.db, this.cast.qcHead, { type: 'lot_test_result', id }, 'QC_RESULT_APPROVED', 'RECORDED');
    await this.run(this.cast.qcHead, (c) => c.query('select site.approve_lot_test_result($1, $2)', [id, sig]));
    return id;
  }

  /** Posts a material master version as the ERP interface; QA confirms it when it does not take effect on its own (site services 0802). */
  async material(materialCode: string, materialName: string, materialKind: MaterialKind, unit = 'kg', maxRetestMonths: number | null = 24): Promise<void> {
    const id = await this.run(this.cast.erp, async (c) =>
      (await c.query<{ id: string }>('select site.erp_receive_material($1::jsonb) as id', [
        JSON.stringify({ materialCode, materialName, materialKind, unit, ...(maxRetestMonths ? { maxRetestMonths } : {}), erpReference: `ERP-${materialCode}` }),
      ])).rows[0]?.id ?? '',
    );
    const { rows } = await this.db.app.query<{ s: string }>("select site.erp_master_state('MATERIAL', $1) as s", [id]);
    if (rows[0]?.s !== 'PENDING') return;
    const sig = await signFor(this.db, this.cast.qaMaster, { type: 'erp_master', id: `MATERIAL/${id}` }, 'ERP_MASTER_CONFIRMED', 'PENDING');
    await this.run(this.cast.qaMaster, (c) => c.query("select site.confirm_erp_master('MATERIAL', $1, $2)", [id, sig]));
  }

  async version(lotId: string): Promise<string> {
    const { rows } = await this.db.app.query<{ v: string }>("select version::text as v from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = $1", [lotId]);
    return rows[0]?.v ?? '';
  }

  async state(lotId: string): Promise<string> {
    const { rows } = await this.db.app.query<{ s: string }>("select state as s from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = $1", [lotId]);
    return rows[0]?.s ?? '';
  }

  sign(signer: SeededActor, lotId: string, meaning: string, expectedState: string): Promise<string> {
    return signFor(this.db, signer, { type: 'material_lot', id: lotId }, meaning, expectedState);
  }

  /** QA proposes `event` (sql/0800) and `signer` signs MATERIAL_LOT_STATUS_DECIDED over the content that names it. */
  async decide(signer: SeededActor, lotId: string, event: LotQaDecision, expectedState: string): Promise<string> {
    await this.run(signer, (c) => proposeLotDecision(c, lotId, event));
    return this.sign(signer, lotId, 'MATERIAL_LOT_STATUS_DECIDED', expectedState);
  }

  async identity(lotId: string, result: 'PASS' | 'FAIL' = 'PASS'): Promise<string> {
    return this.run(this.cast.analyst, (c) => recordIdentityResult(c, lotId, result, 'STP-ID-IR-01', `AR-${unique('T')}`));
  }

  /** Released by the head of QC on the identity-tested route (identity result recorded first). */
  async releasedLot(kind: MaterialKind = 'API', overrides: Partial<LotReceipt> = {}): Promise<ReceivedLot & { materialCode: string; lotCode: string }> {
    const lot = await this.receive(kind, overrides);
    await this.identity(lot.lotId);
    const sig = await this.sign(this.cast.qcHead, lot.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    await this.run(this.cast.qcHead, async (c) => changeLotStatus(c, lot.lotId, 'RELEASE', await this.version(lot.lotId), sig, 'IDENTITY_TESTED'));
    return lot;
  }

  /** QA enables the vendor-history route for an excipient: justification, signature, enablement. */
  async enableVendorHistory(materialCode: string): Promise<string> {
    const routeId = await this.run(this.cast.qa, (c) =>
      proposeVendorRoute(c, materialCode, 'Trend of 30 consecutive supplier certificates against in-house full tests: all within limits, Cpk 1.8', 'QA-STAT-2026-014'),
    );
    const sig = await signFor(this.db, this.cast.qa, { type: 'vendor_route', id: routeId }, 'VENDOR_ROUTE_ENABLED', 'PROPOSED');
    await this.run(this.cast.qa, (c) => enableVendorRoute(c, routeId, sig));
    return routeId;
  }

  async reserve(lotId: string, batch: Batch, quantity: string, expiresInSeconds = 3600): Promise<string> {
    const expiresAt = await this.isoIn(expiresInSeconds);
    return this.run(this.cast.warehouse, (c) =>
      reserveLot(c, { lotId, batchId: batch.id, batchNumber: batch.number, edition: 'TABLETS', quantity, unit: 'kg', expiresAt }),
    );
  }

  /** Consumption through the batch-side definer, as the dispensing block will call it. */
  consume(batch: Batch, reservationId: string, materialCode: string, quantity: string, actor: ActorContext = this.cast.dispenser): Promise<Record<string, unknown>> {
    return this.run(actor, async (c) => {
      const { rows } = await c.query<{ r: Record<string, unknown> }>('select recipe.consume_lot($1, $2, $3, $4::numeric, $5) as r', [batch.id, reservationId, materialCode, quantity, 'kg']);
      return rows[0]?.r ?? {};
    });
  }

  /** Rewrites a row as the superuser with triggers off (moves a lot's dates or a reservation's expiry into the past). */
  async timeTravel(sql: string, params: unknown[]): Promise<void> {
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

  /** A batch record and its stored execution state in `status` (recipe.consume_lot consumes only into a running batch). */
  async batch(markets: string[], status = 'IN_PROGRESS'): Promise<Batch> {
    const b: Batch = { id: randomUUID(), number: unique('B'), markets };
    const hex = (ch: string) => ch.repeat(64);
    await this.timeTravel(
      `with x as (insert into recipe.batch_execution (id, batch_number, package_hash, content_hash, installation, purpose, engine_version, registry_fingerprint,
                                           policy, policy_hash, issue_request, market_set, batch_size, site_code, site_zone, issued_at_us,
                                           issued_by_person, issued_by_account, correlation_id)
       values ($1, $2, $3, $3, 'SANDBOX', 'SANDBOX_TEST_RUN', 'fixture', $3, '{}', $3, '{}', $4, 'BS-1', 'SITE-1', 'Asia/Kolkata', 0, $5, $5, $5) returning id)
       insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status)
       select x.id, jsonb_build_object('status', $6::text), 1, $3, 1, $3, $6 from x`,
      [b.id, b.number, hex('a'), markets, randomUUID(), status],
    );
    return b;
  }
}

/** The one test of the fixtures' specifications: ASSAY 98.0 to 102.0 % by STP-AS-01 (IP 2022), 1 kg sampled. */
export const ASSAY_TEST = {
  testCode: 'ASSAY', methodReference: 'STP-AS-01', unit: '%', lowerLimit: '98.0', upperLimit: '102.0', required: true, pharmacopoeia: 'IP', edition: '2022',
  sampleQuantity: '0.010', sampleUnit: 'kg',
};

export interface Batch {
  id: string;
  number: string;
  markets: string[];
}

/** The error message of a rejected promise ('' when it resolved). */
export async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
