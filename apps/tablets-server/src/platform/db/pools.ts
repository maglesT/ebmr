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
