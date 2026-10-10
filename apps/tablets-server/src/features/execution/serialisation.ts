/**
 * The server's side of the serialisation L3 contract (Phase 3 slice 4a, G-21, K-21, L-53, PR-42; integration-sdk
 * serialisation): the server is the client of the site's L3 system (the stub in apps/simulators until the Phase 6
 * adapter). Unit serials never enter the record: a pool is recorded with its id and the count of serials issued, events
 * with their counts per state, a report with its counts, unexplained count and hash (tablets 0952). Every call fails
 * closed: an L3 answer out of contract, an L3 error or an unreachable L3 system records nothing and throws.
 *
 * The report hash is the L3 system's over its canonical report, which names every serial; the record keeps no serials,
 * so the server checks the report's own consistency (every serial in a state or counted unexplained, the issued count
 * the record's) and records the hash as the reference to that report.
 */
import type pg from 'pg';
import {
  L3_POOLS_PATH,
  l3PoolEventsPath,
  l3PoolReportPath,
  PoolReport,
  PoolRequest,
  PoolResponse,
  SERIAL_STATES,
  SerialEventsRequest,
  SerialEventsResponse,
  serialTransitionAllowed,
  type SerialEvent,
  type SerialState,
} from '@ebmr/integration-sdk/serialisation';
import type { z } from 'zod';

export class L3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`L3 ${code}: ${message} (PR-42; the record is unchanged)`);
  }
}

export interface L3Client {
  requestPool(request: PoolRequest): Promise<PoolResponse>;
  sendEvents(poolId: string, events: readonly SerialEvent[]): Promise<void>;
  report(poolId: string): Promise<PoolReport>;
}

/** An HTTP client of the L3 system at `baseUrl` (no trailing slash). */
export function httpL3Client(baseUrl: string, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): L3Client {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const call = async <S extends z.ZodType>(method: 'GET' | 'POST', path: string, body: unknown, schema: S): Promise<z.infer<S>> => {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
      });
    } catch (error) {
      throw new L3Error(503, 'UNREACHABLE', error instanceof Error ? error.message : String(error));
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const e = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      throw new L3Error(res.status, typeof e?.code === 'string' ? e.code : 'L3_ERROR', typeof e?.message === 'string' ? e.message : `answered ${res.status}`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new L3Error(502, 'PROTOCOL', `the answer to ${method} ${path} is not in the contract's form`);
    return parsed.data;
  };
  return {
    requestPool: (request) => call('POST', L3_POOLS_PATH, PoolRequest.parse(request), PoolResponse),
    sendEvents: async (poolId, events) => {
      await call('POST', l3PoolEventsPath(poolId), SerialEventsRequest.parse({ events }), SerialEventsResponse);
    },
    report: (poolId) => call('GET', l3PoolReportPath(poolId), undefined, PoolReport),
  };
}

/**
 * The L3 client of the configured base URL (config EBMR_L3_URL). Without one the serialisation is off and every call
 * is refused (fails closed, PR-42): no pool is requested and nothing is recorded.
 */
export function configuredL3Client(l3Url: string | null, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): L3Client {
  if (l3Url !== null) return httpL3Client(l3Url, opts);
  const off = (): Promise<never> =>
    Promise.reject(new L3Error(503, 'NOT_CONFIGURED', 'no serialisation L3 system is configured for this server (EBMR_L3_URL), so no serial pool can be requested'));
  return { requestPool: off, sendEvents: off, report: off };
}

/**
 * Requests the pool of G-21 step `stepKey` of batch `batchId` for `market` (a batch market: EU or US) and records it, in
 * the caller's command (`client`). The request's packaging order, L3 market and GTIN are the record's.
 */
export async function requestSerialPool(client: pg.ClientBase, l3: L3Client, p: { batchId: string; stepKey: string; market: string; quantity: string }): Promise<{ poolId: string; quantity: string }> {
  const req = (await client.query<{ r: PoolRequest }>('select tab.serial_pool_request($1, $2, $3, $4) as r', [p.batchId, p.stepKey, p.market, p.quantity])).rows[0]?.r;
  if (!req) throw new Error('tab.serial_pool_request returned nothing');
  const answer = await l3.requestPool(req);
  const issued = BigInt(new Set(answer.serials).size).toString();
  await client.query('select tab.record_serial_pool($1, $2, $3, $4, $5::jsonb)', [p.batchId, p.stepKey, p.market, p.quantity, JSON.stringify({ poolId: answer.poolId, issued, issuedAt: answer.issuedAt })]);
  return { poolId: answer.poolId, quantity: issued };
}

/** A serial event as the server sends it, with the state the serial leaves (null: issued, no state yet). */
export interface SerialChange extends SerialEvent {
  from: SerialState | null;
}

/**
 * Sends serial events of pool `poolId` to the L3 system and records their counts per state change (review 4a MEDIUM 3:
 * the database derives the states the pool's serials hold from them and holds every report to them). A change the L3
 * contract does not allow is refused before anything is sent.
 */
export async function sendSerialEvents(client: pg.ClientBase, l3: L3Client, poolId: string, events: readonly SerialChange[]): Promise<void> {
  const counts: Record<string, string> = {};
  for (const e of events) {
    if (!serialTransitionAllowed(e.from, e.state)) throw new L3Error(400, 'TRANSITION', `${e.serial} cannot go from ${e.from ?? 'issued'} to ${e.state}`);
    const k = `${e.from ?? 'NONE'}>${e.state}`;
    counts[k] = (BigInt(counts[k] ?? '0') + 1n).toString();
  }
  // Recorded first, in the caller's command: a refusal by the L3 system rolls the record back with it.
  await client.query('select tab.record_serial_events($1, $2::jsonb)', [poolId, JSON.stringify(counts)]);
  await l3.sendEvents(poolId, events.map(({ serial, state, at }) => ({ serial, state, at })));
}

/** Fetches the L3 report of pool `poolId`, checks its consistency and records it; returns the SERIAL_RECONCILIATION entry it gives. */
export async function fetchSerialReport(client: pg.ClientBase, l3: L3Client, poolId: string): Promise<Record<string, unknown>> {
  const report = await l3.report(poolId);
  if (report.poolId !== poolId) throw new L3Error(502, 'PROTOCOL', `the report names pool ${report.poolId}, not ${poolId}`);
  const stated = SERIAL_STATES.reduce((a, s) => a + BigInt(report.counts[s]), 0n) + BigInt(report.unexplained);
  if (stated !== BigInt(report.counts.issued)) throw new L3Error(502, 'PROTOCOL', `the report's counts do not add up to the ${report.counts.issued} serials issued`);
  const r = (await client.query<{ r: Record<string, unknown> }>('select tab.record_serial_report($1, $2::jsonb) as r', [poolId, JSON.stringify(report)])).rows[0]?.r;
  if (!r) throw new Error('tab.record_serial_report returned nothing');
  return r;
}
