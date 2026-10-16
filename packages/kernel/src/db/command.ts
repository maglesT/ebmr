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

/** Run `work` in one transaction under the given actor. Rolls back on any error. */
export async function withCommand<T>(pool: pg.Pool, ctx: ActorContext, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
