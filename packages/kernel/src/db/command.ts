/**
 * Every GMP write runs inside a command: one transaction that first declares who is acting
 * (kernel.begin_command) and why. Without that declaration the database refuses GMP writes
 * (INV-07), so application code cannot forget it.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export type CommandSource = 'UI' | 'API' | 'INTEGRATION' | 'SYSTEM';

export interface ActorContext {
  personId: string;
  accountId: string;
  roleCode: string;
  sessionId: string;
  source: CommandSource;
  siteZone: string;
  legalName?: string;
  deviceId?: string;
  authEventId?: string;
  reasonCode?: string;
  reasonText?: string;
  correlationId?: string;
  /**
   * The number of the approved configuration change record a configuration change is made under (DI-09, kernel 1195).
   * The database refuses a write to a configuration table without it (EBMR-CFG-001).
   */
  changeRecord?: string;
}

export function toDbContext(ctx: ActorContext): Record<string, string> {
  const out: Record<string, string> = {
    person_id: ctx.personId,
    account_id: ctx.accountId,
    role_code: ctx.roleCode,
    session_id: ctx.sessionId,
    source: ctx.source,
    site_zone: ctx.siteZone,
    correlation_id: ctx.correlationId ?? randomUUID(),
  };
  if (ctx.legalName) out['legal_name'] = ctx.legalName;
  if (ctx.deviceId) out['device_id'] = ctx.deviceId;
  if (ctx.authEventId) out['auth_event_id'] = ctx.authEventId;
  if (ctx.reasonCode) out['reason_code'] = ctx.reasonCode;
  if (ctx.reasonText) out['reason_text'] = ctx.reasonText;
  if (ctx.changeRecord) out['change_record'] = ctx.changeRecord;
  return out;
}

/**
 * Phase B slice 3 (PL-08): on the platform build the database refuses a write whose master item has no fact recorded in
 * the writing transaction, with SQLSTATE EBM01 and the item as detail (md.require_active). The server registers, per
 * pool, how it reads such an item through the master view; the read returns the statement that records the fact
 * (md.record_fact), and the command runs again from the start with every fact read so far recorded first. Nothing of
 * the refused attempt stays (it rolled back). A pool without a resolver gets the refusal as it is.
 */
export type FactRecorder = (client: pg.PoolClient) => Promise<void>;
export type FactResolver = (detail: string) => Promise<FactRecorder>;
export const FACT_NEEDED = 'EBM01';
/** At most this many master items per command (each needs one more attempt). */
const MAX_FACTS = 32;
const factResolvers = new WeakMap<pg.Pool, FactResolver>();

/** The detail of an EBM01 refusal, looking through `cause` (a command helper wraps the database's error). */
function factNeeded(error: unknown): string | null {
  for (let e: unknown = error, depth = 0; e !== null && typeof e === 'object' && depth < 4; e = (e as { cause?: unknown }).cause, depth += 1) {
    const { code, detail } = e as { code?: unknown; detail?: unknown };
    if (code === FACT_NEEDED && typeof detail === 'string') return detail;
  }
  return null;
}

export function registerFactResolver(pool: pg.Pool, resolver: FactResolver): void {
  factResolvers.set(pool, resolver);
}

/** Run `work` in one transaction under the given actor. Rolls back on any error. */
export async function withCommand<T>(pool: pg.Pool, ctx: ActorContext, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const recorders: FactRecorder[] = [];
  const context = JSON.stringify(toDbContext(ctx));
  for (;;) {
    const client = await pool.connect();
    let needed: string | null;
    try {
      await client.query('begin');
      await client.query('select kernel.begin_command($1::jsonb)', [context]);
      for (const record of recorders) await record(client);
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      needed = factNeeded(error);
      if (needed === null || !factResolvers.has(pool) || recorders.length >= MAX_FACTS) throw error;
    } finally {
      client.release();
    }
    recorders.push(await (factResolvers.get(pool) as FactResolver)(needed));
  }
}
