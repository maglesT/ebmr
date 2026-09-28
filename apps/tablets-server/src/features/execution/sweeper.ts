/**
 * The time sweeper of the sandbox (module C3; INV-20; Phase 2 apps plan section 7): every 15 s the in-process
 * service identity TEST-sweeper (a SERVICE account on the SERVER terminal TEST-SRV-SWEEPER, source SYSTEM)
 * evaluates the time constraints of every running test batch at the database time. A batch another command
 * holds is skipped (FOR UPDATE SKIP LOCKED) and swept next time; a SWEEP row is appended only when the sweep
 * produced events (a warning, a breach). A breach is never waiting for this job: every command sweeps first.
 *
 * The identity comes from the DEMO-ONLY service-keys file (EBMR_SERVICE_KEYS_FILE; the entry on terminal
 * TEST-SRV-SWEEPER, its service key and its terminal key's fingerprint). Without the file the sweeper does not
 * start (commands still sweep).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { identity, type ActorContext } from '@ebmr/kernel';
import { execution } from '@ebmr/recipe-core';
import type { AppContext } from '../../platform/context.ts';
import { withActorCommand } from '../../platform/db/commands.ts';
import { runCache, runContext } from './runs.ts';

export const SWEEP_INTERVAL_MS = 15_000;
export const SWEEPER_TERMINAL = 'TEST-SRV-SWEEPER';

interface ServiceEntry {
  terminal: string;
  loginName: string;
  serviceKey: string;
  fingerprint?: string | null;
  terminalKey?: { fingerprint?: string } | null;
}

/** The sweeper's credentials from the service-keys file (null when there is no usable entry). */
export function sweeperCredentials(file: string | null): { loginName: string; serviceKey: string; fingerprint: string } | null {
  if (!file) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { services?: ServiceEntry[] };
  const e = (parsed.services ?? []).find((s) => s.terminal === SWEEPER_TERMINAL);
  const fingerprint = e?.terminalKey?.fingerprint ?? e?.fingerprint ?? null;
  if (!e || !fingerprint) return null;
  return { loginName: e.loginName, serviceKey: e.serviceKey, fingerprint };
}

export interface SweepResult {
  runs: number;
  swept: number;
  skipped: number;
  events: number;
  failures: { runId: string; error: string }[];
}

/** One sweep of every running test batch, as `actor` (a SYSTEM service session). */
export async function sweepAll(app: AppContext, actor: ActorContext): Promise<SweepResult> {
  const { rows } = await app.pools.app.query<{ id: string }>(
    "select b.id from recipe.batch_execution b join recipe.execution_state s on s.batch_id = b.id where s.status in ('ISSUED', 'IN_PROGRESS', 'ON_HOLD') order by b.issued_at",
  );
  const result: SweepResult = { runs: rows.length, swept: 0, skipped: 0, events: 0, failures: [] };
  for (const r of rows) {
    try {
      const run = await runContext(app.pools.app, r.id);
      const outcome = await withActorCommand(app.pools.app, { ...actor, correlationId: randomUUID() }, async (client) => {
        const tx = await execution.ExecutionTx.tryOpen(client, run.def, r.id);
        if (!tx) return null;
        const events = await tx.sweep();
        return { events: events.length, state: tx.state };
      });
      if (outcome === null) {
        result.skipped += 1;
        continue;
      }
      result.swept += 1;
      result.events += outcome.events;
      runCache(app).set(r.id, { def: run.def, state: outcome.state });
    } catch (e) {
      result.failures.push({ runId: r.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

/**
 * Opens a SERVICE_KEY session of the sweeper identity on its SERVER terminal and returns its SYSTEM actor. The
 * zone is the site policy's (ServerConfig.siteZone): the kernel refuses any other (EBMR-IAM-118, DI-27).
 */
export async function openSweeperActor(app: AppContext, c: { loginName: string; serviceKey: string; fingerprint: string }): Promise<ActorContext & { deviceId: string }> {
  const ev = await identity.authenticate(app.pools.authn, { method: 'SERVICE_KEY', identifier: c.loginName, secret: c.serviceKey, deviceFingerprint: c.fingerprint, purpose: 'LOGIN' });
  const s = await identity.openSession(app.pools.app, ev.authEventId, c.fingerprint);
  const { rows } = await app.pools.app.query<{ person_id: string; account_id: string }>('select a.person_id, a.id as account_id from iam.account a where a.login_name = $1', [c.loginName]);
  const who = rows[0];
  if (!who) throw new Error(`the sweeper account ${c.loginName} does not exist`);
  return { personId: who.person_id, accountId: who.account_id, roleCode: 'SERVICE_ACCOUNT', sessionId: s.sessionId, deviceId: s.deviceId, source: 'SYSTEM', siteZone: app.config.siteZone, legalName: 'TEST-sweeper' };
}

/** Starts the 15 s sweeper; returns its stop function (null when no identity is configured). */
export function startSweeper(app: AppContext, log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void }): { stop(): Promise<void> } | null {
  let creds: ReturnType<typeof sweeperCredentials>;
  try {
    creds = sweeperCredentials(app.config.serviceKeysFile);
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'the sweeper identity file cannot be read; the sweeper does not start');
    return null;
  }
  if (!creds) return null;
  const c = creds;
  let actor: (ActorContext & { deviceId: string }) | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  const session = async (): Promise<ActorContext> => {
    actor ??= await openSweeperActor(app, c);
    return actor;
  };

  const tick = (): void => {
    if (running || stopped) return;
    running = (async () => {
      try {
        const r = await sweepAll(app, await session());
        if (r.failures.length > 0) {
          log.warn({ failures: r.failures.length, first: r.failures[0]?.error }, 'the sweeper could not sweep every test run');
          actor = null; // a lapsed session is reopened next time
        } else if (r.events > 0) {
          log.info({ swept: r.swept, events: r.events }, 'time sweep recorded events');
        }
      } catch (e) {
        actor = null;
        log.warn({ err: e instanceof Error ? e.message : String(e) }, 'the sweeper failed; it retries at the next interval');
      } finally {
        running = null;
      }
    })();
  };
  const timer = setInterval(tick, SWEEP_INTERVAL_MS);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (running) await running;
      if (actor) await identity.endSession(app.pools.app, actor.sessionId).catch(() => undefined);
    },
  };
}
