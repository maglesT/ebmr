/**
 * What the load driver measures (slice 7d): every request by actor and route (latency, status, refusal code), the
 * timed operations (a review opening, a signed act with its attempts, an analytics run and its flag views), the
 * server process's resources over time (RSS, open file handles), the database's (connections, size) and the server's
 * log lines at error level. Durations are wall-clock milliseconds of the driver (process.hrtime), never GMP values.
 */
import type { AnyRoute } from '@ebmr/api-contract';

export interface RequestStat {
  actor: string;
  route: string;
  method: string;
  /** COMMAND: a mutating route; READ: a read. */
  kind: 'COMMAND' | 'READ';
  count: number;
  errors: number;
  /** Latencies in ms (each request), kept for the percentiles. */
  ms: number[];
  statuses: Record<string, number>;
}

export interface Operation {
  name: string;
  ms: number;
  ok: boolean;
  detail: Record<string, unknown>;
}

export interface ResourceSample {
  atMs: number;
  rssBytes: number | null;
  openFiles: number | null;
  dbConnections: number;
  dbBytes: number;
  seriesRows: number;
  inboundMessages: number;
}

export const elapsedMs = (t0: bigint): number => Number(process.hrtime.bigint() - t0) / 1e6;

export class Recorder {
  readonly requests = new Map<string, RequestStat>();
  readonly operations: Operation[] = [];
  readonly resources: ResourceSample[] = [];
  readonly errors: string[] = [];
  private readonly started = process.hrtime.bigint();
  /** While false (set-up), requests are not counted toward the SLOs. */
  measuring = false;

  sinceStartMs(): number {
    return elapsedMs(this.started);
  }

  request(actor: string, route: AnyRoute, t0: bigint, status: number, code: string | null): void {
    if (!this.measuring) return;
    const key = `${actor}|${route.id}`;
    let s = this.requests.get(key);
    if (!s) {
      s = { actor, route: route.id, method: route.method, kind: route.mutating ? 'COMMAND' : 'READ', count: 0, errors: 0, ms: [], statuses: {} };
      this.requests.set(key, s);
    }
    s.count += 1;
    s.ms.push(elapsedMs(t0));
    const k = code ? `${String(status)} ${code}` : String(status);
    s.statuses[k] = (s.statuses[k] ?? 0) + 1;
    if (status === 0 || status >= 500) {
      s.errors += 1;
      if (this.errors.length < 50) this.errors.push(`${actor} ${route.id}: ${k}`);
    }
  }

  operation(name: string, t0: bigint, ok: boolean, detail: Record<string, unknown> = {}): Operation {
    const op = { name, ms: elapsedMs(t0), ok, detail };
    this.operations.push(op);
    return op;
  }
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? null;
}

const round = (x: number | null): number | null => (x === null ? null : Math.round(x * 10) / 10);

export interface RouteSummary {
  actor: string;
  route: string;
  kind: 'COMMAND' | 'READ';
  count: number;
  errors: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  statuses: Record<string, number>;
}

export function summariseRequests(r: Recorder): RouteSummary[] {
  return [...r.requests.values()]
    .map((s) => ({ actor: s.actor, route: s.route, kind: s.kind, count: s.count, errors: s.errors, p50: round(percentile(s.ms, 50)), p95: round(percentile(s.ms, 95)), p99: round(percentile(s.ms, 99)), max: round(s.ms.length ? Math.max(...s.ms) : null), statuses: s.statuses }))
    .sort((a, b) => a.actor.localeCompare(b.actor) || a.route.localeCompare(b.route));
}

/** The latencies of every command (or read) of the given actors, for the overall percentiles. */
export function latencies(r: Recorder, kind: 'COMMAND' | 'READ', actors?: readonly string[]): number[] {
  return [...r.requests.values()].filter((s) => s.kind === kind && (!actors || actors.includes(s.actor))).flatMap((s) => s.ms);
}
