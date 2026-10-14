/**
 * Test world for the ERP/WMS adapter's database side (site services 0910 to 0913; kernel 1180, 1181): the lot world's
 * cast with its ERP interface identity registered as the ERP_WMS integration adapter (DI-20), an envelope builder and
 * the adapter's receive-or-record-refusal cycle exactly as the worker runs it (kernel 1180's acknowledgment rule: the
 * receiving command, and on a refusal the refusal recorded in its own command).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { seedAdministration, seedServiceActor, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { acknowledgeGaps } from '../../../kernel/test/integrations/support.ts';
import type { TestDatabase } from '../helpers.ts';
import { seedCast, World } from '../lots/support.ts';

export const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Registers `actor` (an INTEGRATION account on its SERVER device) as an adapter of `system`; returns its code. */
export async function registerAdapter(db: TestDatabase, actor: SeededActor, system: string, prefix = 'ERPWMS'): Promise<string> {
  const { admin } = await seedAdministration(db);
  const code = `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;
  await withCommand(db.app, withReason(admin), (c) =>
    c.query('select iam.register_integration_adapter($1, $2, $3, $4, $5)', [code, system, actor.accountId, actor.deviceId, `test adapter ${code}`]),
  );
  return code;
}

export interface Received {
  messageId: string;
  outcome: 'ACCEPTED' | 'DUPLICATE';
  sequenceStatus: string;
  alarmId: string | null;
  applied: Record<string, unknown> | null;
}

export type Delivery = { ok: true; result: Received } | { ok: false; code: string; message: string; refusalId: string };

export class ErpWorld extends World {
  adapterCode = '';
  /** The ERP_WMS adapter's identity: an INTEGRATION account holding ERP_WMS_INTERFACE (site services 0914). */
  adapter!: SeededActor;
  private seq = 0;

  static async create(db: TestDatabase): Promise<ErpWorld> {
    const w = new ErpWorld(db, await seedCast(db));
    w.adapter = await integrationActor(db, 'ERP/WMS adapter', 'ERP_WMS_INTERFACE');
    w.adapterCode = await registerAdapter(db, w.adapter, 'ERP_WMS');
    return w;
  }

  /** An envelope of the next sequence number (or `over`), with a fresh key and the payload's hash. */
  envelope(messageType: string, payload: Record<string, unknown>, over: Record<string, unknown> = {}): Record<string, unknown> {
    this.seq += 1;
    return {
      sourceSystem: 'ERP_WMS',
      messageType,
      sourceRecordId: `REC-${this.seq.toString()}`,
      sourceTimestamp: (1_800_000_000_000_000n + BigInt(this.seq) * 1_000_000n).toString(),
      sequenceNo: this.seq.toString(),
      idempotencyKey: `k-${randomUUID()}`,
      schemaVersion: '1',
      payloadHash: sha(JSON.stringify(payload)),
      payload,
      ...over,
    };
  }

  /** Moves the sequence on (the next envelope takes `n` numbers later). */
  skip(n: number): void {
    this.seq += n;
  }

  /** The adapter's receiving command (site.erp_wms_receive) as the ERP_WMS adapter (or `actor`). */
  async inbound(env: unknown, actor: SeededActor = this.adapter): Promise<Received> {
    return withCommand(this.db.app, { ...actor, correlationId: randomUUID() }, async (c) =>
      (await c.query<{ r: Received }>('select site.erp_wms_receive($1::jsonb) as r', [JSON.stringify(env)])).rows[0]?.r as Received);
  }

  /** The worker's cycle: receive; on a refusal, record it with its class in a new command (D-P6a-0-5). */
  async deliver(env: Record<string, unknown>, errorClass: string): Promise<Delivery> {
    try {
      return { ok: true, result: await this.inbound(env) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(message)?.[1] ?? 'UNKNOWN';
      const refusalId = await withCommand(this.db.app, { ...this.adapter, correlationId: randomUUID() }, async (c) =>
        (await c.query<{ id: string }>('select platform.record_inbound_refusal($1::jsonb, $2, $3) as id', [JSON.stringify(env), errorClass, message])).rows[0]?.id ?? '');
      return { ok: false, code, message, refusalId };
    }
  }

  async count(sql: string, params: unknown[] = []): Promise<number> {
    return Number((await this.db.admin.query<{ n: string }>(sql, params)).rows[0]?.n ?? -1);
  }

  messages(): Promise<number> {
    return this.count('select count(*) as n from platform.inbound_message where adapter_code = $1', [this.adapterCode]);
  }

  alarms(kind?: string): Promise<number> {
    return kind
      ? this.count('select count(*) as n from platform.integration_alarm where adapter_code = $1 and kind = $2', [this.adapterCode, kind])
      : this.count('select count(*) as n from platform.integration_alarm where adapter_code = $1', [this.adapterCode]);
  }

  /** Sets a platform setting as the seeded system owner, with a reason. */
  async setting(key: string, value: string): Promise<void> {
    const { owner } = await seedAdministration(this.db);
    await withCommand(this.db.app, withReason(owner), (c) => c.query('select platform.set_setting($1, $2)', [key, value]));
  }

  /** The ERP_WMS adapter's mirror synchronisation (heartbeat) of `dataClass`, caught up, the tests' gaps acknowledged (kernel 1182). */
  async sync(dataClass: string): Promise<void> {
    await acknowledgeGaps(this.db, this.adapterCode);
    const head = this.seq.toString(); // the test source's head: the last number it published
    await withCommand(this.db.app, { ...this.adapter, correlationId: randomUUID() }, (c) => c.query('select platform.record_mirror_sync($1, $2)', [dataClass, head]));
  }
}

/** A goods receipt payload of `materialCode` with one supplier batch per entry ([supplierLot, manufacturer, containers, kg]). */
export function goodsReceipt(deliveryId: string, materialCode: string, batches: [string, string, string, string][], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deliveryId,
    materialCode,
    supplierCode: 'SUP-1',
    receivedAt: '1800000000000000',
    supplierBatches: batches.map(([supplierLot, manufacturerCode, containers, kg]) => ({
      supplierLot, manufacturerCode, containers, quantity: { value: kg, unit: 'kg' }, expiryDate: '2030-06-30',
    })),
    ...over,
  };
}

export const integrationActor = (db: TestDatabase, name: string, roleCode = 'SERVICE_ACCOUNT'): Promise<SeededActor> =>
  seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode, name });
