/**
 * Shared support for the slice 6a builder-B adapter tests (QMS, LIMS, LMS, CMMS) in the kernel, site-services and
 * recipe-core packages: a registered adapter identity per system, envelopes as the SDK builds them, the mirror mode
 * and freshness switches, and the refusal recording the worker does after a refused command (D-P6a-0-5).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import type { TestDatabase } from '../support/db.ts';
import { seedAdministration, seedServiceActor, withReason, type SeededActor } from '../identity/seed.ts';

export type SourceSystem = 'QMS' | 'LIMS' | 'LMS' | 'CMMS';

export interface TestAdapter {
  system: SourceSystem;
  code: string;
  id: string;
  actor: SeededActor;
  /** The next sequence number of this adapter's feed. */
  seq: number;
}

export const ctxOf = (a: SeededActor, extra: Partial<ActorContext> = {}): ActorContext => {
  const { seed: _seed, ...c } = a;
  void _seed;
  return { ...c, correlationId: randomUUID(), ...extra };
};

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** An INTEGRATION account on its own SERVER device, registered for `system` by the device administrator. */
export async function registerAdapter(db: TestDatabase, system: SourceSystem): Promise<TestAdapter> {
  const { admin } = await seedAdministration(db);
  const actor = await seedServiceActor(db, { kind: 'INTEGRATION', name: `${system} adapter ${randomBytes(2).toString('hex')}` });
  const code = `${system}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const id = await withCommand(db.app, withReason(admin), async (c) =>
    (await c.query<{ id: string }>('select iam.register_integration_adapter($1, $2, $3, $4, $5) as id', [code, system, actor.accountId, actor.deviceId, `test ${system} adapter`])).rows[0]!.id,
  );
  return { system, code, id, actor, seq: 0 };
}

export interface EnvelopeOptions {
  sourceRecordId?: string;
  sourceTimestamp?: string;
  sequenceNo?: string;
  idempotencyKey?: string;
}

/** The envelope the adapter worker sends (the payload hash is of the payload's JSON text, as the simulators send it). */
export function envelopeFor(a: TestAdapter, messageType: string, payload: unknown, o: EnvelopeOptions = {}): Record<string, unknown> {
  a.seq += 1;
  return {
    sourceSystem: a.system,
    messageType,
    sourceRecordId: o.sourceRecordId ?? `R-${randomBytes(4).toString('hex')}`,
    sourceTimestamp: o.sourceTimestamp ?? nowUs(),
    sequenceNo: o.sequenceNo ?? a.seq.toString(),
    idempotencyKey: o.idempotencyKey ?? `k-${randomUUID()}`,
    schemaVersion: '1',
    payloadHash: sha256(JSON.stringify(payload)),
    payload,
  };
}

let lastUs = 0n;
/** A strictly increasing source timestamp (epoch microseconds as text) for test messages. */
export function nowUs(): string {
  const t = BigInt(Date.now()) * 1000n;
  lastUs = t > lastUs ? t : lastUs + 1n;
  return lastUs.toString();
}

/**
 * The reason an adapter's receiving command carries (D-P6a-B-7): the source's, naming the message, so a withdrawal or
 * a correction the message causes is audited with it (EBMR-AUDIT-002); the adapter worker sends the same.
 */
export function inboundReason(envelope: unknown): { reasonCode: string; reasonText: string } {
  const e = (envelope ?? {}) as Record<string, unknown>;
  return { reasonCode: 'INBOUND_MESSAGE', reasonText: `${String(e['messageType'])} ${String(e['sourceRecordId'])} from the ${String(e['sourceSystem'])}` };
}

/** Runs the adapter's receiving command; on a refusal the worker records it in its own command (kernel 1180). */
export async function receive(db: TestDatabase, a: TestAdapter, fn: string, envelope: unknown): Promise<Record<string, unknown>> {
  return withCommand(db.app, ctxOf(a.actor, inboundReason(envelope)), async (c) => (await c.query<{ r: Record<string, unknown> }>(`select ${fn}($1::jsonb) as r`, [JSON.stringify(envelope)])).rows[0]!.r);
}

export async function recordRefusal(db: TestDatabase, a: TestAdapter, envelope: unknown, errorClass: string, detail: string): Promise<string> {
  return withCommand(db.app, ctxOf(a.actor), async (c) =>
    (await c.query<{ id: string }>('select platform.record_inbound_refusal($1::jsonb, $2, $3) as id', [JSON.stringify(envelope), errorClass, detail])).rows[0]!.id,
  );
}

export async function setMirrorMode(db: TestDatabase, dataClass: string, mode: 'STAND_IN' | 'MIRROR'): Promise<void> {
  const { owner } = await seedAdministration(db);
  await withCommand(db.app, withReason(owner), (c) => c.query('select platform.set_setting($1, $2)', [`integration.mode.${dataClass.toLowerCase()}`, mode]));
}

export async function syncMirror(db: TestDatabase, a: TestAdapter, dataClass: string): Promise<void> {
  await withCommand(db.app, ctxOf(a.actor), (c) => c.query('select platform.record_mirror_sync($1)', [dataClass]));
}

/** The heartbeat stops while the data stays: the last synchronisation moved into the past (as the kernel tests do). */
export async function ageMirror(db: TestDatabase, dataClass: string, seconds: number): Promise<void> {
  await db.admin.query(`update platform.mirror_sync set last_synced_at = last_synced_at - make_interval(secs => $2) where data_class = $1`, [dataClass, seconds]);
}

export async function count(db: TestDatabase, sql: string, params: unknown[] = []): Promise<number> {
  return Number((await db.admin.query<{ n: string }>(sql, params)).rows[0]?.n ?? -1);
}
