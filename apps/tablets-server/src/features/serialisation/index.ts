/**
 * Feature `serialisation` (Phase 6 slice 6c, GMP): serialisation L3/L4 (contract ns/serialisation.ts; tablets 0952,
 * 1231; PR-42; defaults D-P6c-12 to D-P6c-14).
 *
 *  - The serial query asks the L3 system live (GET /l3/v1/serials/:serial) and answers with the record's lot and expiry
 *    for the serial's pool (tab.serial_lookup; a read, as every read it needs a session); an L3 lot, expiry, GTIN or packaging order that differs is
 *    listed as a problem, never shown as the answer (D-P6c-13). With no L3 configured (EBMR_L3_URL unset) the query is
 *    refused: serialisation is off (fails closed).
 *  - The pools of a packaging order (tab.batch_pools_view): reports, aggregations, decommissioning tasks, the L3 mirror's
 *    freshness and the release problem.
 *  - QA rejects a pool: the L3 system opens a decommissioning task (POST /l3/v1/pools/:poolId/reject); the OPEN task it
 *    answers is recorded (tab.record_pool_rejection, QA.FLOOR_APPROVE) and keeps release red until the L3 reports it DONE
 *    through its adapter (D-P6c-14). One command: QA's permission and the pool are checked before the L3 is asked.
 * Every rule is the database's.
 */
import { routes, type BatchPoolsView, type SerialLookupView } from '@ebmr/api-contract';
import { DecommissionTask, l3PoolRejectPath, l3SerialPath, SerialQueryAnswer } from '@ebmr/integration-sdk/serialisation';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { z } from 'zod';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import type { GuidanceEntry } from '../../platform/http/guidance.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';

type Db = Pick<pg.Pool, 'query'>;

export const guidance: Readonly<Record<string, GuidanceEntry>> = {
  'EBMR-L3-*': {
    status: 422,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The serialisation record refused this.',
    whatYouCanDo: ['Read the reason below.', 'Check the L3 adapter on the integration health page.'],
    whoCanHelp: ['QA', 'The L3 system owner'],
    controls: ['PR-42', 'DI-31'],
  },
  'EBMR-L3-110': {
    status: 409,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The L3 system names a pool for this serial that no record of this site holds.',
    whatYouCanDo: ['Report the serial to QA: it may be a counterfeit or a serial of another site.'],
    whoCanHelp: ['QA', 'The L3 system owner'],
    controls: ['PR-42'],
  },
  'L3-UNAVAILABLE': {
    status: 503,
    kind: 'NOT_ALLOWED',
    whatHappened: 'The L3 serialisation system did not answer, so nothing was asked or recorded.',
    whatYouCanDo: ['Try again when the L3 system answers.'],
    whoCanHelp: ['The L3 system owner', 'The system administrator (integrations)'],
    controls: ['PR-42'],
    retryable: true,
  },
};

/** The L3 system's answer, or a refusal naming what failed (fails closed). */
async function askL3<S extends z.ZodType>(base: string | null, method: 'GET' | 'POST', path: string, body: unknown, schema: S): Promise<z.infer<S>> {
  const fail = (status: number, why: string) =>
    refusal(status, { code: 'L3-UNAVAILABLE', kind: 'NOT_ALLOWED', whatHappened: 'The L3 serialisation system did not give an answer the eBMR can use. Nothing was recorded.', why, controls: ['PR-42'], whatYouCanDo: ['Try again when the L3 system answers.'], whoCanHelp: ['The L3 system owner'] }, true);
  if (base === null) throw fail(503, 'no serialisation L3 system is configured for this server (EBMR_L3_URL)');
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw fail(503, `the L3 system is unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.status === 404) {
    const e = (json as { error?: { message?: unknown } } | null)?.error;
    throw refusal(404, { code: 'L3-UNKNOWN', kind: 'INVALID_INPUT', whatHappened: 'The L3 system does not know this.', why: typeof e?.message === 'string' ? e.message.slice(0, 300) : 'not found', controls: ['PR-42'], whatYouCanDo: ['Check the serial or pool and try again.'], whoCanHelp: ['QA'] });
  }
  if (!res.ok) throw fail(502, `the L3 system answered ${String(res.status)}`);
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw fail(502, `the L3 answer to ${method} ${path} is not in the contract's form`);
  return parsed.data;
}

const mirrorOf = (v: { mode: string; stale: boolean; ageSeconds: number | null; boundSeconds: number }): SerialLookupView['mirror'] => ({
  mode: v.mode === 'MIRROR' ? 'MIRROR' : 'STAND_IN', stale: v.stale, ageSeconds: v.ageSeconds, boundSeconds: v.boundSeconds,
});

async function pools(db: Db, batchId: string): Promise<BatchPoolsView> {
  const v = (await db.query<{ v: BatchPoolsView | null }>('select tab.batch_pools_view($1) as v', [batchId])).rows[0]?.v;
  if (!v) throw refusal(404, { code: 'EBMR-L3-106', kind: 'INVALID_INPUT', whatHappened: 'There is no batch with this id.', why: `Batch ${batchId} does not exist.`, whatYouCanDo: ['Open the packaging order from its batch.'] });
  return { ...v, mirror: mirrorOf(v.mirror) };
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  const base = app.config.l3Url;
  bindRoutes(scope, app, routes.serialisation, {
    serial: async ({ params, requireSession }) => {
      requireSession();
      const answer = await askL3(base, 'GET', l3SerialPath(params.serial), undefined, SerialQueryAnswer);
      const view = (await pool.query<{ r: Omit<SerialLookupView, 'mirror'> }>('select tab.serial_lookup($1::jsonb) as r', [JSON.stringify(answer)])).rows[0]?.r as Omit<SerialLookupView, 'mirror'>;
      const f = (await pool.query<{ v: BatchPoolsView['mirror'] }>("select tab.batch_pools_view($1) -> 'mirror' as v", [view.batchId])).rows[0]?.v;
      return { ...view, mirror: mirrorOf(f ?? { mode: 'STAND_IN', stale: false, ageSeconds: null, boundSeconds: 3600 }) };
    },
    batchPools: async ({ params, requireSession }) => {
      requireSession();
      return pools(pool, params.batchId);
    },
    rejectPool: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const sp = (await pool.query<{ batch_id: string }>('select batch_id from tab.serial_pool where pool_id = $1', [params.poolId])).rows[0];
      if (!sp) throw refusal(404, { code: 'EBMR-L3-106', kind: 'INVALID_INPUT', whatHappened: 'There is no serial pool with this id.', why: `Pool ${params.poolId} is not a pool of this site.`, whatYouCanDo: ['Open the pool from its packaging order.'] });
      // One command (one attributed act): QA's right and the pool first, then the L3 is asked, then its OPEN task is
      // recorded. A refusal or a failed L3 call rolls everything back; the L3 answers the same open task to a retry.
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select tab.assert_pool_rejection($1)', [params.poolId]);
        const task = await askL3(base, 'POST', l3PoolRejectPath(params.poolId), { reason: body.reason }, DecommissionTask);
        return (await c.query<{ r: { batchId: string } }>('select tab.record_pool_rejection($1, $2, $3::jsonb) as r', [params.poolId, body.reason, JSON.stringify(task)])).rows[0]?.r ?? null;
      });
      return pools(pool, sp.batch_id);
    },
  });
  return Promise.resolve();
}
