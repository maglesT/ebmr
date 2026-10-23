/**
 * Database pools (plan section 2): the application pool (ebmr_app on GMP, ebmr_sandbox on the sandbox) and the
 * authentication service's pool (ebmr_authn on GMP, ebmr_sandbox on the sandbox). Reads use Kysely over the
 * application pool; every write goes through kernel and recipe definer functions inside commands.
 *
 * No query of these pools carries text no record can hold: buildApp guards them (refuseUnstorableParameters; review F33).
 */
import pg from 'pg';
import { unstorableText, UnstorableTextError } from '@ebmr/expr';
import type { identity } from '@ebmr/kernel';

export interface Pools {
  app: pg.Pool;
  authn: identity.AuthnDb;
  close(): Promise<void>;
}

/**
 * The first parameter of a query that holds text no record can hold, named by its position, or null. A string is
 * checked, and every string and member name inside an array or plain object (node-postgres sends an array as an array
 * literal, an object as JSON); a Buffer, a Date or any other value is not text.
 */
export function unstorableParameter(values: readonly unknown[]): string | null {
  const walk = (v: unknown): string | null => {
    if (typeof v === 'string') return unstorableText(v);
    if (Array.isArray(v)) {
      for (const x of v) {
        const p = walk(x);
        if (p !== null) return p;
      }
      return null;
    }
    if (v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const p = unstorableText(k) ?? walk(x);
        if (p !== null) return p;
      }
    }
    return null;
  };
  for (const [i, v] of values.entries()) {
    const p = walk(v);
    if (p !== null) return `parameter $${i + 1} holds ${p}`;
  }
  return null;
}

const GUARDED = Symbol('ebmr.unstorable-parameters-refused');
const guardedPools = new WeakSet<pg.Pool>();

/**
 * Every client of `pool` refuses, before the driver encodes anything, a query whose parameters hold text no record can
 * hold (review F33). node-postgres writes a text parameter as UTF-8, and UTF-8 encoding silently writes U+FFFD for a
 * UTF-16 surrogate without its other half: the database would store a character nobody sent and could not tell. It
 * refuses U+0000 itself (22021), but as an error without an EBMR code. The refusal is an UnstorableTextError, which the
 * error mapper answers 400 INVALID_INPUT. The contract refuses such text in every request first (storableText); this is
 * the server's last line, for text that reaches a query some other way. A client is guarded when the pool hands it
 * out ('acquire'), so the clients a pool opened before this call are guarded too; guarding a pool twice changes nothing.
 */
export function refuseUnstorableParameters(pool: pg.Pool): void {
  if (guardedPools.has(pool)) return;
  guardedPools.add(pool);
  pool.on('acquire', (client) => {
    const marked = client as pg.PoolClient & { [GUARDED]?: true };
    if (marked[GUARDED]) return;
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    const guarded = (...args: unknown[]): unknown => {
      const [config, second] = args;
      const values = Array.isArray(second) ? second : config !== null && typeof config === 'object' && Array.isArray((config as { values?: unknown }).values) ? (config as { values: unknown[] }).values : [];
      const problem = unstorableParameter(values);
      if (problem === null) return query(...args);
      const error = new UnstorableTextError(`the query was not sent: its ${problem}, which no record can hold`);
      const callback = args.find((a): a is (e: Error) => void => typeof a === 'function');
      if (callback !== undefined) {
        process.nextTick(() => callback(error));
        return undefined;
      }
      return Promise.reject(error);
    };
    Object.defineProperty(client, 'query', { value: guarded, writable: true, configurable: true });
    marked[GUARDED] = true;
  });
}

const SURVIVING = Symbol('ebmr.connection-loss-survived');
const survivingPools = new WeakSet<pg.Pool>();

/**
 * Requirement R3.12 (hosted-demo trials): a lost database connection (PostgreSQL restarted or the backend terminated,
 * 57P01; the network dropped) never ends the server. node-postgres reports such a loss as an 'error' event: on the pool
 * for an idle connection, on the client itself for a connection handed out and between queries. An 'error' event with
 * no listener throws, and the process ended with "Unhandled 'error' event" until someone restarted it. With these
 * listeners the loss is logged; the pool drops the dead connection (on release, since the client is no longer
 * queryable) and opens a new one for the next request, so the server recovers on its own once the database is back.
 * A query that was running when the connection died still fails, and its request is answered as an error. Clients
 * opened before the call get their listener when next handed out; calling it twice for a pool changes nothing.
 */
export function surviveConnectionLoss(pool: pg.Pool, lost: (error: Error) => void): void {
  if (survivingPools.has(pool)) return;
  survivingPools.add(pool);
  // The pool re-emits an idle client's error: reported once, by the client's own listener when it has one.
  pool.on('error', (error, client) => {
    if (!(client as pg.PoolClient & { [SURVIVING]?: true } | undefined)?.[SURVIVING]) lost(error);
  });
  const listen = (client: pg.PoolClient): void => {
    const marked = client as pg.PoolClient & { [SURVIVING]?: true };
    if (marked[SURVIVING]) return;
    marked[SURVIVING] = true;
    client.on('error', (error) => lost(error));
  };
  pool.on('connect', listen);
  pool.on('acquire', listen);
}

/** The warning logged when a database connection was lost (surviveConnectionLoss). */
export const CONNECTION_LOST_LOG = 'a database connection was lost (the database restarted or ended the session); the pool opens a new one for the next request';

export function createPools(appUrl: string, authnUrl: string, opts: { appMax?: number; authnMax?: number } = {}): Pools {
  const app = new pg.Pool({ connectionString: appUrl, max: opts.appMax ?? 10 });
  const authnPool = new pg.Pool({ connectionString: authnUrl, max: opts.authnMax ?? 4 });
  return {
    app,
    authn: { pool: authnPool },
    async close() {
      await Promise.all([app.end(), authnPool.end()]);
    },
  };
}
