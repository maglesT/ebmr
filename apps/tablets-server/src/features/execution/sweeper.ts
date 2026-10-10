/**
 * The time sweeper of the sandbox (module C3; INV-20; Phase 2 apps plan section 7): every 15 s the in-process
 * service identity TEST-sweeper (a SERVICE account on the SERVER terminal TEST-SRV-SWEEPER, source SYSTEM)
 * evaluates the time constraints of every running test batch at the database time. A batch another command
 * holds is skipped (FOR UPDATE SKIP LOCKED) and swept next time; a SWEEP row is appended only when the sweep
 * produced events (a warning, a breach). A breach is never waiting for this job: every command sweeps first.
 * Whoever notices a breach first, the sweeper or a person's command or signing preparation, it is the system's
 * finding: the engine raises it as SYSTEM, and the database refuses a new time breach or clock regression raised
 * in anyone's name (recipe-core 0280, EBMR-EXE-045; DI-14, INV-03). What the database checks before it takes a
 * time fact as the system's (recipe-core 0299): the constraint of the pinned MBR, the whole record the engine
 * writes (title, facts, block; EBMR-EXE-046), and the time bookkeeping it rests on, which every row must keep at
 * the database clock (the last time seen, and each start or end at the row's own time, EBMR-EXE-025) and which
 * only the act that records it may add to (a step's start by its START_STEP, and so on, EBMR-EXE-026). It does not
 * re-run the token advance: a construct's start or end that an accepted command adds at its own time is taken as
 * recorded, and the replay verification (ADR 0010) checks it. Inside a person's row the database stores the
 * breach's first content version as the system's creation (an internal identity with a role code no account
 * holds), so that person is never logged as having changed it; anything it cannot prove stays that person's
 * change. This identity records a SWEEP row and stores what it finds under its own name; it is not the raiser of
 * what the sweep finds.
 *
 * The identity comes from the DEMO-ONLY service-keys file (EBMR_SERVICE_KEYS_FILE; the entry on terminal
 * TEST-SRV-SWEEPER, its service key and its terminal key's fingerprint). Without the file the sweeper does not
 * start (commands still sweep).
 *
 * The sweeper acts in the role EXECUTION_SWEEPER (recipe-core 0260), which holds EXECUTION.SWEEP and nothing else
 * and is only for SERVICE accounts (DI-17 least privilege). The kernel's SERVICE_ACCOUNT role cannot sweep, and the
 * sweeper holds none of its permissions (INTERFACE.WRITE and the other service rights). The site gateway acts in
 * its own role SITE_GATEWAY (tablets 0290), which is only for INTEGRATION accounts and never holds EXECUTION.SWEEP.
 *
 * With each sweep the same identity also records the overdue periodic IPC checks of TB-11 runs (recordIpcOverdue).
 * With each sweep the same identity records the interface losses of steps on process devices (recordInterfaceLosses,
 * slice 3a review backlog #7).
 *
 * Before every sweep the sweeper re-reads the site policy site.zone (AppContext.siteZone.check(), DI-27): after
 * a change while the server runs it sweeps nothing and opens no session until the server restarts (the guard
 * raises the operations alert once; the sweeper adds no warning of its own).
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
/** The sweeper's own role (recipe-core 0260): EXECUTION.SWEEP only; the kernel checks the account holds it (EBMR-IAM-108). */
export const SWEEPER_ROLE = 'EXECUTION_SWEEPER';

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
  /** Each running batch listed: the number of events its sweep produced, or SKIPPED when another command held it. */
  outcomes: Record<string, number | 'SKIPPED'>;
}

/** One sweep of every running test batch, as `actor` (a SYSTEM service session). */
export async function sweepAll(app: AppContext, actor: ActorContext): Promise<SweepResult> {
  const { rows } = await app.pools.app.query<{ id: string }>(
    "select b.id from recipe.batch_execution b join recipe.execution_state s on s.batch_id = b.id where s.status in ('ISSUED', 'IN_PROGRESS', 'ON_HOLD') order by b.issued_at",
  );
  const result: SweepResult = { runs: rows.length, swept: 0, skipped: 0, events: 0, failures: [], outcomes: {} };
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
        result.outcomes[r.id] = 'SKIPPED';
        continue;
      }
      result.swept += 1;
      result.events += outcome.events;
      result.outcomes[r.id] = outcome.events;
      runCache(app).set(r.id, { def: run.def, state: outcome.state });
    } catch (e) {
      result.failures.push({ runId: r.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

export interface InterfaceLoss {
  batchId: string;
  step: string;
  lastReceivedUs: string | null;
}

/**
 * Slice 3a review backlog #7 (DI-31, PR-14): records, as `actor` (the sweeper's SYSTEM service session, EXECUTION.SWEEP),
 * an interface loss for every step bound to a process device whose instance is in progress and whose device has sent
 * nothing for longer than the step's stale age, judged at database time (tablets 0870, tab.record_interface_losses); once
 * per loss. A step on a process device then closes only after an INTERFACE_LOSS entry answers each loss (tablets 0874),
 * which raises G-06's exception and two-person mode. Returns the losses recorded now.
 */
export async function recordInterfaceLosses(app: AppContext, actor: ActorContext): Promise<InterfaceLoss[]> {
  return withActorCommand(app.pools.app, { ...actor, correlationId: randomUUID() }, async (client) => {
    const { rows } = await client.query<{ r: { recorded: InterfaceLoss[] } }>('select tab.record_interface_losses() as r');
    return rows[0]?.r.recorded ?? [];
  });
}

export interface IpcOverdue {
  batchId: string;
  stepKey: string;
  stream: string;
  test: string;
  dueUs: string;
  /** Whether the MISSED hold was recorded with the alarm (recipe-core 0541 plant.record_missed_ipc_check for the sweeper). */
  held: boolean;
}

/**
 * Phase 3 slice 3c (TB-11, IN-35 (c)): records, as `actor` (the sweeper's SYSTEM service session, EXECUTION.SWEEP), an
 * alarm for every periodic IPC check of a running batch's TB-11 run that is overdue beyond its grace at database time
 * (tablets 0893, tab.record_ipc_overdue; once per check and due time), without waiting for an operator's entry, and with each
 * alarm the MISSED hold of the stream's containers (recipe-core 0541, EXECUTION.SWEEP only). IPC_CHECK_MISSED follows with
 * the run's next entry, which the database makes list the missed check. Returns the
 * alarms recorded now.
 */
export async function recordIpcOverdue(app: AppContext, actor: ActorContext): Promise<IpcOverdue[]> {
  return withActorCommand(app.pools.app, { ...actor, correlationId: randomUUID() }, async (client) => {
    const { rows } = await client.query<{ id: string }>("select b.id from recipe.batch_execution b join recipe.execution_state s on s.batch_id = b.id where s.status = 'IN_PROGRESS' order by b.issued_at");
    const out: IpcOverdue[] = [];
    for (const r of rows) {
      const res = await client.query<{ a: Omit<IpcOverdue, 'batchId'>[] }>('select tab.record_ipc_overdue($1) as a', [r.id]);
      for (const a of res.rows[0]?.a ?? []) out.push({ batchId: r.id, stepKey: a.stepKey, stream: a.stream, test: a.test, dueUs: a.dueUs, held: a.held });
    }
    return out;
  });
}

/**
 * Opens a SERVICE_KEY session of the sweeper identity on its SERVER terminal and returns its SYSTEM actor in the
 * sweeper's own role (SWEEPER_ROLE; the kernel refuses the context unless the account holds it, EBMR-IAM-108). The
 * zone is the site policy's as the server holds it (AppContext.siteZone.current(), which refuses once the policy
 * changed, before any authentication): the kernel refuses any other (EBMR-IAM-118, DI-27). The legal name is the
 * one the identity's person holds (iam.person), never a name assumed here: the kernel refuses a context naming
 * anyone else (EBMR-IAM-117, DI-14).
 */
export async function openSweeperActor(app: AppContext, c: { loginName: string; serviceKey: string; fingerprint: string }): Promise<ActorContext & { deviceId: string }> {
  const siteZone = app.siteZone.current();
  const ev = await identity.authenticate(app.pools.authn, { method: 'SERVICE_KEY', identifier: c.loginName, secret: c.serviceKey, deviceFingerprint: c.fingerprint, purpose: 'LOGIN' });
  const s = await identity.openSession(app.pools.app, ev.authEventId, c.fingerprint);
  const { rows } = await app.pools.app.query<{ person_id: string; account_id: string; legal_name: string }>(
    'select a.person_id, a.id as account_id, p.legal_name from iam.account a join iam.person p on p.id = a.person_id where a.login_name = $1',
    [c.loginName],
  );
  const who = rows[0];
  if (!who) throw new Error(`the sweeper account ${c.loginName} does not exist`);
  return { personId: who.person_id, accountId: who.account_id, roleCode: SWEEPER_ROLE, sessionId: s.sessionId, deviceId: s.deviceId, source: 'SYSTEM', siteZone, legalName: who.legal_name };
}

/**
 * Starts the 15 s sweeper (`options.intervalMs`: tests only); returns its stop function (null when no identity is
 * configured).
 */
export function startSweeper(
  app: AppContext,
  log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void },
  options: { intervalMs?: number } = {},
): { stop(): Promise<void> } | null {
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
        // DI-27: nothing is swept in the zone of before a change of the site policy (SITE_ZONE_CHANGED).
        await app.siteZone.check();
        const r = await sweepAll(app, await session());
        const losses = await recordInterfaceLosses(app, await session());
        if (losses.length > 0) log.warn({ losses: losses.length, first: losses[0] }, 'the link to a process device was lost; recorded as interface loss');
        const overdue = await recordIpcOverdue(app, await session());
        if (overdue.length > 0) log.warn({ overdue: overdue.length, first: overdue[0] }, 'a periodic in-process check is overdue; recorded as an alarm');
        if (r.failures.length > 0) {
          log.warn({ failures: r.failures.length, first: r.failures[0]?.error }, 'the sweeper could not sweep every test run');
          actor = null; // a lapsed session is reopened next time
        } else if (r.events > 0) {
          log.info({ swept: r.swept, events: r.events }, 'time sweep recorded events');
        }
      } catch (e) {
        if (app.siteZone.changedTo) return; // the guard raised the operations alert; nothing is swept until a restart
        actor = null;
        log.warn({ err: e instanceof Error ? e.message : String(e) }, 'the sweeper failed; it retries at the next interval');
      } finally {
        running = null;
      }
    })();
  };
  const timer = setInterval(tick, options.intervalMs ?? SWEEP_INTERVAL_MS);
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
