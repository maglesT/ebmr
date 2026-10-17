/**
 * Support of the Phase 6 exit demo specs (`pnpm demo:phase6-exit`): the demo section of the stack state (global-setup.ts),
 * simulator control over HTTP, and waiting for a condition in the database (never a fixed time).
 */
import { readFileSync } from 'node:fs';
import type { DatabaseHandle } from '@ebmr/test-kit';
import type { DemoState } from './global-setup.ts';

type Json = Record<string, unknown>;

export function demoState(): DemoState {
  const file = process.env['EBMR_E2E_STATE'];
  if (!file) throw new Error('EBMR_E2E_STATE is not set: run the demo through playwright.demo.config.ts');
  return (JSON.parse(readFileSync(file, 'utf8')) as { demo: DemoState }).demo;
}

/** A request to a simulator; answers the status and the body. */
export async function sim<T = Json>(origin: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${origin}${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as T };
}

/** Switches a simulator fault on or off (POST /api/fault). */
export async function fault(origin: string, name: string, on: boolean): Promise<void> {
  const r = await sim(origin, 'POST', '/api/fault', { fault: name, on });
  if (r.status !== 200) throw new Error(`fault ${name} ${String(on)}: ${String(r.status)} ${JSON.stringify(r.body)}`);
}

/** Polls `probe` until it answers a value `done` accepts; throws with the last value after `timeoutMs`. */
export async function until<T>(what: string, probe: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let last: T = await probe();
  while (!done(last)) {
    if (performance.now() > deadline) throw new Error(`waited too long for ${what}: last ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 500));
    last = await probe();
  }
  return last;
}

/** One value of a superuser query (`select ... as r`). */
export async function one<T>(db: DatabaseHandle, sql: string, params: unknown[] = []): Promise<T> {
  return (await db.admin.query<{ r: T }>(sql, params)).rows[0]?.r as T;
}
