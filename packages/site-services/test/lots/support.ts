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
  proposeVendorRoute,
  receiveLot,
  recordIdentityResult,
  reserveLot,
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

  async receive(kind: MaterialKind, overrides: Partial<LotReceipt> = {}): Promise<ReceivedLot & { materialCode: string; lotCode: string }> {
    const materialCode = overrides.materialCode ?? unique(`M${kind.slice(0, 3)}`);
    const lotCode = overrides.lotCode ?? unique('L');
    // The ERP's material master first (a receipt takes the kind, name and unit from it; site services 0750).
    await this.material(materialCode, overrides.materialName ?? `Material ${materialCode}`, overrides.materialKind ?? kind, overrides.unit ?? 'kg');
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
    return { ...lot, materialCode, lotCode };
  }

  /** Posts a material master version as the ERP interface (the latest version wins). */
  async material(materialCode: string, materialName: string, materialKind: MaterialKind, unit = 'kg', maxRetestMonths: number | null = 24): Promise<void> {
    await this.run(this.cast.erp, (c) =>
      c.query('select site.erp_receive_material($1::jsonb)', [
        JSON.stringify({ materialCode, materialName, materialKind, unit, ...(maxRetestMonths ? { maxRetestMonths } : {}), erpReference: `ERP-${materialCode}` }),
      ]),
    );
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

  async batch(markets: string[]): Promise<Batch> {
    const b: Batch = { id: randomUUID(), number: unique('B'), markets };
    const hex = (ch: string) => ch.repeat(64);
    await this.timeTravel(
      `insert into recipe.batch_execution (id, batch_number, package_hash, content_hash, installation, purpose, engine_version, registry_fingerprint,
                                           policy, policy_hash, issue_request, market_set, batch_size, site_code, site_zone, issued_at_us,
                                           issued_by_person, issued_by_account, correlation_id)
       values ($1, $2, $3, $3, 'SANDBOX', 'SANDBOX_TEST_RUN', 'fixture', $3, '{}', $3, '{}', $4, 'BS-1', 'SITE-1', 'Asia/Kolkata', 0, $5, $5, $5)`,
      [b.id, b.number, hex('a'), markets, randomUUID()],
    );
    return b;
  }
}

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
