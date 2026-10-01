/**
 * Process state of the devices feature, shared by the browser routes and the gateway listener of one server:
 *  - the API token each gateway handed over at its last login (the server presents it to the gateway API; the
 *    server never holds the gateway's own credential);
 *  - ingestion notices, so a capture can answer as soon as its reading row exists;
 *  - whether the server reaches each gateway's API, recorded in the database (tab.record_gateway_api_contact,
 *    tablets 0320; review finding P51): a capture that cannot reach it marks the gateway's scales OFFLINE there, so
 *    the manual two-person path opens once the mark has been seen for 10 seconds with no answer from the API (tablets
 *    0340, 0350); while it is so marked, each heartbeat of the gateway has the server probe GET /v1/health with its
 *    API token, and an answer marks it reachable again. Every answer of a probe is first recorded on its own, outside
 *    any command (tab.record_gateway_api_answer, tablets 0350), so a monitor command that is held up cannot hide it;
 *    an answer that cannot be recorded within the receipts pool's limits is lost and logged at warn with the gateway
 *    code (recordApiAnswer; decision X32);
 *  - three pools for the gateway's reports, apart from the pool of the browser routes and keeping their connections
 *    (tablets 0350, round 4 of P50; follow-up rounds 2 and 4): the receipts pool (receipts()) for what goes on record
 *    before any statement that can wait on a lock (each heartbeat's receipt read together with the session behind its
 *    token and the site's time zone, and each answer of the gateway's API), which waits at most
 *    RECEIPT_ACQUIRE_TIMEOUT_MS for a connection and ends each statement within RECEIPT_STATEMENT_TIMEOUT_MS; the watch's
 *    pool (one connection, the same limits) for the listener's ticks; both log in with the listener's own role
 *    (EBMR_DB_LISTENER_URL; kernel 0980), which alone may write receipts, answers and ticks, and both open all their
 *    connections when the listener starts (startWatch), so no receipt waits for a connection to be opened. And the
 *    reports pool (reports(), the application role) for the heartbeats' commands and the unbinding of a token, which
 *    ends each wait for a connection and each statement within REPORT_STATEMENT_TIMEOUT_MS (each one, not a command as
 *    a whole). A receipt or an answer not written within its limits is not on record and is counted lost by the watch
 *    (watch.ts), so the database vouches for no window that holds it and the manual path stays shut (decisions X32,
 *    X37). A kept connection that fails while idle is dropped and logged at warn (idleFailed); the receipts and watch
 *    pools open a new one at once (rewarm), the reports pool when it next needs one. Only tokens this process handed
 *    out at a login use the receipts pool freely; a heartbeat with any other token (a gateway after a restart, or one
 *    made up) takes its turn, UNVERIFIED_RECEIPTS_AT_ONCE at a time, so requests nobody authenticated never hold its
 *    connections;
 *  - the listener's watch (startWatch, watch.ts): every heartbeat and every answer of the gateway's API is an arrival
 *    of the current epoch, and a tick every LISTENER_TICK_MS tells the database whether everything that arrived was
 *    put on record; the gate counts a scale silent, or a report unanswered, only over a window of clean ticks (tablets
 *    0350 item 6). A tick that fails, or one that reports something lost, is logged at warn once until the ticks are
 *    clean again;
 *  - the heartbeats' commands, one per gateway at a time (inTurn): the listener answers every heartbeat within
 *    HEARTBEAT_ANSWER_MS, below the gateway's longest interval, and a command held up goes on in the background, so
 *    however its waits add up the gateway's next heartbeat leaves on time; it is received when its receipt is written
 *    within the receipts pool's limits. A probe of the API does not wait for the monitor's command, which a
 *    transaction of the application role can hold up, so the next heartbeat probes again;
 *  - the gateway API monitor: the service identity in whose command every such observation is recorded (tablets
 *    0340, round 3 of P50/P51; DI-14, DI-17). The database takes the observation only from a validated actor in the
 *    role GATEWAY_API_MONITOR, which holds GATEWAY.API_CONTACT_RECORD and nothing else, so each change is attributed
 *    to the server's own identity in the audit trail. The identity is the TEST-SRV-MONITOR entry of the DEMO-ONLY
 *    service-keys file (EBMR_SERVICE_KEYS_FILE), as the sweeper's is; without it nothing is recorded, and a gateway
 *    whose API cannot be reached keeps its scales as their heartbeats say (the capture is refused, and so is a weight
 *    keyed by hand beside a scale shown online: the stricter outcome);
 *  - the live-display hub: one upstream SSE per scale, fanned out to the browsers watching it (display only).
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { identity, type ActorContext } from '@ebmr/kernel';
import { CaptureResponse, GatewayHealth, LiveSample, type CaptureRequest } from '@ebmr/integration-sdk/scale';
import type { AppContext } from '../../platform/context.ts';
import { withActorCommand } from '../../platform/db/commands.ts';
import { ListenerWatch, type Arrival, type TickOutcome } from './watch.ts';

export interface GatewayLink {
  gatewayCode: string;
  apiToken: string;
}

/**
 * Every wait for a connection of the reports pool, and every statement on it, ends within this time (a heartbeat's
 * command held up in the database, its session's row or its room's row held by another transaction, fails). The
 * waits of one command add up (a connection, kernel.begin_command, tab.record_heartbeat, the commit), so this bounds
 * how long a command runs in the background, not when the heartbeat is answered: that is HEARTBEAT_ANSWER_MS.
 */
export const REPORT_STATEMENT_TIMEOUT_MS = 4000;

/**
 * Every heartbeat is answered within this time of its arrival (decision X29): recorded (200), refused, or 503
 * HEARTBEAT_PENDING while its command (or its session's end) goes on in the background. The site gateway sends its
 * heartbeats one at a time, the next only after the answer, at most 5 s apart (its heartbeatMs, at most 5000), and
 * the database counts a scale silent only when no heartbeat naming it was received for 10 s (tablets 0350); an answer
 * due below that interval keeps the gateway's next heartbeat on time whatever holds up this one.
 */
export const HEARTBEAT_ANSWER_MS = 3000;

/**
 * The receipts pool (receipts(); decision X30): the longest wait for a connection, and the longest statement. A
 * heartbeat is received within their sum of its arrival or not at all, and their sum is not above HEARTBEAT_ANSWER_MS,
 * so two receipts of a gateway that sends every 5 s are at most 8 s apart as long as each is written within these
 * limits. One that is not (the statement held past its limit, say by a loaded database, or no connection to be had)
 * is not received; the watch counts it lost, so the database vouches for no window that holds it and the gate refuses
 * a weight keyed by hand instead of counting the scale silent (tablets 0350 item 6; decisions X32, X37).
 */
export const RECEIPT_ACQUIRE_TIMEOUT_MS = 1000;
export const RECEIPT_STATEMENT_TIMEOUT_MS = 2000;
/** Connections of the receipts pool, and of the reports pool. */
export const RECEIPTS_POOL_MAX = 4;
export const REPORTS_POOL_MAX = 4;
/** Connections of the watch's pool (the listener's ticks). */
export const WATCH_POOL_MAX = 1;

/**
 * How many heartbeats with a bearer token this process did not hand out (a gateway's token from before a restart, or
 * one made up) may use the receipts pool at a time (decision X30); the others wait their turn until their answer is
 * due. So requests nobody has authenticated hold at most this many of its connections.
 */
export const UNVERIFIED_RECEIPTS_AT_ONCE = 1;
/** The most tokens handed out at a login this process keeps as its own (the oldest is dropped first). */
export const ISSUED_TOKENS_KEPT = 64;

/**
 * The listener's first step for every heartbeat, one statement on the receipts pool: the receipt (tablets 0350), the
 * session behind the token (tab.resolve_gateway_session) and the site policy site.zone (DI-27). None of it takes a lock
 * another transaction can hold.
 */
const RECEIPT_SQL = "select tab.record_heartbeat_receipt($1, $2::jsonb) as r, tab.resolve_gateway_session($1) as s, iam.policy_text('site.zone') as zone";

/** A heartbeat as the receipts pool received it. */
export interface HeartbeatReceipt {
  /** Whether it went on record (a token of a session of an ACTIVE gateway key, whatever the session's state). */
  received: boolean;
  /** Whether the database asks the server to probe the gateway's API (it counts the API unreachable). */
  probeApi: boolean;
  /** The session behind the token as tab.resolve_gateway_session reports it (null: unknown, unbound, key revoked). */
  session: Record<string, unknown> | null;
  /** The site policy site.zone as read in the same statement. */
  policyZone: string | null;
}

/** A heartbeat's command was not run: a newer heartbeat of the same gateway took its turn while it waited. */
export class TurnTaken extends Error {
  constructor() {
    super('a newer heartbeat of this gateway took the turn of this one');
  }
}

/**
 * At most `size` pieces of work at a time; the others wait in order, each until its `signal` (the answer's deadline)
 * aborts, when it leaves the queue with the signal's reason.
 */
class Lane {
  private running = 0;
  private readonly waiting: { start: () => void }[] = [];

  constructor(private readonly size: number) {}

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    if (this.running < this.size) this.running += 1;
    else await this.turn(signal);
    try {
      return await work();
    } finally {
      // The place passes to the next in line, if any, without being given up in between.
      const next = this.waiting.shift();
      if (next) next.start();
      else this.running -= 1;
    }
  }

  private turn(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const reason = (): Error => (signal.reason instanceof Error ? signal.reason : new Error('the answer is due'));
      if (signal.aborted) {
        reject(reason());
        return;
      }
      const entry = {
        start: () => {
          signal.removeEventListener('abort', leave);
          resolve();
        },
      };
      const leave = (): void => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(reason());
      };
      signal.addEventListener('abort', leave, { once: true });
      this.waiting.push(entry);
    });
  }
}

/** A heartbeat's command waiting for, or holding, its gateway's turn. */
interface Turn {
  signal: AbortSignal;
  start(): Promise<void>;
  drop(reason: Error): void;
}

/** The SERVER terminal of the gateway API monitor identity (test-kit personas: TEST-gw-monitor). */
export const MONITOR_TERMINAL = 'TEST-SRV-MONITOR';
/** The monitor's own role (tablets 0340): GATEWAY.API_CONTACT_RECORD only; the kernel checks the account holds it (EBMR-IAM-108). */
export const MONITOR_ROLE = 'GATEWAY_API_MONITOR';

export interface MonitorCredentials {
  loginName: string;
  serviceKey: string;
  fingerprint: string;
}

interface ServiceEntry {
  terminal: string;
  loginName: string;
  serviceKey: string;
  fingerprint?: string | null;
  terminalKey?: { fingerprint?: string } | null;
}

/** The gateway API monitor's credentials from the service-keys file (null without a file or a usable entry). */
export function monitorCredentials(file: string | null): MonitorCredentials | null {
  if (!file) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { services?: ServiceEntry[] };
  const e = (parsed.services ?? []).find((s) => s.terminal === MONITOR_TERMINAL);
  const fingerprint = e?.terminalKey?.fingerprint ?? e?.fingerprint ?? null;
  if (!e || !fingerprint) return null;
  return { loginName: e.loginName, serviceKey: e.serviceKey, fingerprint };
}

/**
 * Opens a SERVICE_KEY session of the monitor identity on its SERVER terminal and returns its SYSTEM actor in the
 * monitor's own role (MONITOR_ROLE). As the sweeper's (execution/sweeper.ts): the zone is the site policy's as the
 * server holds it (refused once the policy changed, DI-27), and the legal name the one its person holds (DI-14).
 */
export async function openMonitorActor(app: AppContext, c: MonitorCredentials): Promise<ActorContext & { deviceId: string }> {
  const siteZone = app.siteZone.current();
  const ev = await identity.authenticate(app.pools.authn, { method: 'SERVICE_KEY', identifier: c.loginName, secret: c.serviceKey, deviceFingerprint: c.fingerprint, purpose: 'LOGIN' });
  const s = await identity.openSession(app.pools.app, ev.authEventId, c.fingerprint);
  const { rows } = await app.pools.app.query<{ person_id: string; account_id: string; legal_name: string }>(
    'select a.person_id, a.id as account_id, p.legal_name from iam.account a join iam.person p on p.id = a.person_id where a.login_name = $1',
    [c.loginName],
  );
  const who = rows[0];
  if (!who) throw new Error(`the gateway API monitor account ${c.loginName} does not exist`);
  return { personId: who.person_id, accountId: who.account_id, roleCode: MONITOR_ROLE, sessionId: s.sessionId, deviceId: s.deviceId, source: 'SYSTEM', siteZone, legalName: who.legal_name };
}

/**
 * A pool at `url` (the application role's or the listener's login) that keeps its connections (at most `max`), waits at
 * most `acquireMs` for one and ends every statement within `statementMs`. A connection that fails while idle is dropped
 * from the pool and handed to `idleFailed`, which logs it (and has the listener's pools open another).
 */
function keptPool(url: string, max: number, acquireMs: number, statementMs: number, idleFailed: (error: Error) => void): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: acquireMs,
    options: `-c statement_timeout=${statementMs}`,
  });
  pool.on('error', idleFailed);
  return pool;
}

/**
 * Opens `max` connections of `pool` (taking its idle ones and opening the rest) and gives them back, so a kept pool
 * holds them all; rejects with the first failure, after giving back the ones it got.
 */
async function openAll(pool: pg.Pool, max: number): Promise<void> {
  const got = await Promise.allSettled(Array.from({ length: max }, () => pool.connect()));
  for (const g of got) if (g.status === 'fulfilled') g.value.release();
  const failed = got.find((g): g is PromiseRejectedResult => g.status === 'rejected');
  if (failed) throw failed.reason;
}

/** The message and, for a database error, the SQLSTATE of `error`, as the devices runtime logs them. */
function errorFields(error: unknown): { err: string; code?: string } {
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined;
  return { err: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) };
}

/** The warning logged when a connection of the gateway's report pools failed while idle (DevicesRuntime.idleFailed). */
export const IDLE_CONNECTION_LOST_LOG = "a kept connection of the gateway reports' pools failed while idle and was dropped; the listener's pools open another at once, the reports pool when it next needs one, which fails while no connection of the database is free to it";

/** The warning logged when a pool of the listener's login could not open all its connections again (DevicesRuntime.rewarm). */
export const REWARM_FAILED_LOG = "a pool of the gateway listener's login could not open all its connections again; it tries again when the next one fails";

/** The warning logged when the listener's tick failed (watch.ts): the database vouches for no window until ticks are clean again. */
export const TICK_FAILED_LOG = "the gateway listener's tick was not recorded: the database vouches for no window, so no weight is keyed by hand beside the gateway's scales until its ticks have been clean for 10 seconds";

/** The warning logged when a tick reports that something the listener received was not put on record (watch.ts). */
export const EVIDENCE_LOST_LOG = "the gateway listener received something it could not put on record (a heartbeat's receipt or an answer of the gateway's API): no weight is keyed by hand beside the gateway's scales until its ticks have been clean for 10 seconds";

/** The warning logged when an answer of a gateway's API to the server's probe was not recorded (DevicesRuntime.recordApiAnswer). */
export const API_ANSWER_NOT_RECORDED_LOG = "the gateway's API answered the server's probe, but the answer was not recorded: a report that the API cannot be reached counts as unanswered until a later answer is recorded";

export class DevicesRuntime {
  readonly links = new Map<string, GatewayLink>();
  readonly ingested = new EventEmitter();
  readonly live: LiveHub;
  private readonly probing = new Map<string, Promise<void>>();
  /** Per gateway: the monitor's command being recorded, and the latest observation waiting for its turn. */
  private readonly recording = new Map<string, { pending: { reachable: boolean; detail: string } | null; done: Promise<void> }>();
  /** Per gateway: whether a heartbeat's command is running, and the latest heartbeat waiting for its turn (inTurn). */
  private readonly beating = new Map<string, { next: Turn | null }>();
  /** Per session: its token being unbound and the session ended (endGatewaySession). */
  private readonly ending = new Map<string, Promise<void>>();
  /** SHA-256 of the bearer tokens this process handed out at a gateway login and has not found dead since. */
  readonly issued = new Set<string>();
  /** Receipts for any other token, one at a time (UNVERIFIED_RECEIPTS_AT_ONCE). */
  private readonly unverified = new Lane(UNVERIFIED_RECEIPTS_AT_ONCE);
  private monitor: Promise<(ActorContext & { deviceId: string }) | null> | null = null;
  private reportsPool: pg.Pool | null = null;
  private receiptsPool: pg.Pool | null = null;
  private watchPool: pg.Pool | null = null;
  private watch: ListenerWatch | null = null;
  private watching: Promise<ListenerWatch> | null = null;
  private rewarming: Promise<void> | null = null;
  /** Whether the last tick logged a failure or a loss (logged once until the ticks are clean again). */
  private tickTrouble = false;
  private closed = false;

  constructor(readonly app: AppContext) {
    this.ingested.setMaxListeners(0);
    this.live = new LiveHub(this);
  }

  /** The gateway API URL (EBMR_GATEWAY_URL); one gateway per sandbox server in Phase 2. */
  get gatewayUrl(): string {
    return this.app.config.gatewayUrl.replace(/\/+$/, '');
  }

  link(gatewayCode: string): GatewayLink | undefined {
    return this.links.get(gatewayCode);
  }

  /**
   * The reports pool (tablets 0350): the heartbeats' commands and the unbinding of a token. The application role
   * (EBMR_DB_APP_URL), opened on first use and apart from the browser routes' pool, so requests that wait there never
   * keep a report out; it keeps its connections (a writer who takes every free connection of the database cannot keep
   * the next report out either), and each wait for a connection and each statement ends within
   * REPORT_STATEMENT_TIMEOUT_MS. Throws once the runtime is closed.
   */
  reports(): pg.Pool {
    if (this.closed) throw new Error('the devices runtime is closed');
    this.reportsPool ??= keptPool(this.app.config.appUrl, REPORTS_POOL_MAX, REPORT_STATEMENT_TIMEOUT_MS, REPORT_STATEMENT_TIMEOUT_MS, (e) => this.idleFailed('reports', e));
    return this.reportsPool;
  }

  /**
   * The receipts pool (follow-up rounds 2 and 4 of P50): what goes on record before anything can wait, a heartbeat's
   * receipt (receiveHeartbeat) and an answer of a gateway's API (recordApiAnswer), under the listener's own login
   * (EBMR_DB_LISTENER_URL; kernel 0980), which alone may write them. A wait for a connection ends within
   * RECEIPT_ACQUIRE_TIMEOUT_MS and a statement within RECEIPT_STATEMENT_TIMEOUT_MS, and no command runs on it. Its
   * connections are opened when the listener starts (startWatch) and opened again at once when one is lost. Throws once
   * the runtime is closed.
   */
  receipts(): pg.Pool {
    if (this.closed) throw new Error('the devices runtime is closed');
    this.receiptsPool ??= keptPool(this.app.config.listenerUrl, RECEIPTS_POOL_MAX, RECEIPT_ACQUIRE_TIMEOUT_MS, RECEIPT_STATEMENT_TIMEOUT_MS, (e) => this.idleFailed('receipts', e));
    return this.receiptsPool;
  }

  /** The watch's pool: one connection of the listener's own login for its ticks, with the receipts pool's limits. */
  private ticks(): pg.Pool {
    if (this.closed) throw new Error('the devices runtime is closed');
    this.watchPool ??= keptPool(this.app.config.listenerUrl, WATCH_POOL_MAX, RECEIPT_ACQUIRE_TIMEOUT_MS, RECEIPT_STATEMENT_TIMEOUT_MS, (e) => this.idleFailed('watch', e));
    return this.watchPool;
  }

  /**
   * Starts the listener's watch once (tablets 0350 item 6; decision X37): opens every connection of the receipts pool
   * and of the watch's pool, then writes the first tick and ticks every LISTENER_TICK_MS until close(). Rejects when a
   * connection or the first tick cannot be had (and ends those pools), so the listener does not start without them; a
   * later call starts again. The gateway listener calls it before it listens.
   */
  startWatch(): Promise<ListenerWatch> {
    this.watching ??= (async () => {
      if (this.closed) throw new Error('the devices runtime is closed');
      await openAll(this.receipts(), RECEIPTS_POOL_MAX);
      await openAll(this.ticks(), WATCH_POOL_MAX);
      const watch = new ListenerWatch(this.ticks(), (outcome) => this.tickDone(outcome));
      await watch.start();
      this.watch = watch;
      return watch;
    })().catch(async (error: unknown) => {
      // Nothing half-open is kept: a later start opens the listener's pools afresh.
      const pools = [this.receiptsPool, this.watchPool].filter((p): p is pg.Pool => p !== null);
      this.receiptsPool = null;
      this.watchPool = null;
      await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
      this.watching = null;
      throw error;
    });
    return this.watching;
  }

  /** Something the listener received that must go on record, as an arrival of the watch's current epoch (null: no watch). */
  arrived(): Arrival | null {
    return this.watch?.arrived() ?? null;
  }

  /** Logs a tick that failed or reported a loss, once until a clean tick (TICK_FAILED_LOG, EVIDENCE_LOST_LOG). */
  private tickDone(outcome: TickOutcome): void {
    if (outcome.ok && outcome.clean !== false) {
      this.tickTrouble = false;
      return;
    }
    if (this.tickTrouble) return;
    this.tickTrouble = true;
    if (outcome.ok) this.app.log.warn({ gatewayCodes: [...this.links.keys()] }, EVIDENCE_LOST_LOG);
    else this.app.log.warn({ gatewayCodes: [...this.links.keys()], ...errorFields(outcome.error) }, TICK_FAILED_LOG);
  }

  /**
   * A kept connection of pool `pool` failed while idle (the database ended it, or the network): pg-pool has dropped it.
   * Logged at warn with the gateways whose reports the pool carries. The receipts and watch pools open a new connection
   * at once (rewarm), so no receipt waits for one to be opened; the reports pool opens one when it next needs it, which
   * fails while no connection of the database is free to the application role (decision X21).
   */
  private idleFailed(pool: 'receipts' | 'reports' | 'watch', error: Error): void {
    this.app.log.warn({ pool, gatewayCodes: [...this.links.keys()], ...errorFields(error) }, IDLE_CONNECTION_LOST_LOG);
    if (pool !== 'reports' && this.watching) setImmediate(() => void this.rewarm());
  }

  /** Opens the listener's pools' connections again, one attempt at a time; a failure is logged at warn (REWARM_FAILED_LOG). */
  private rewarm(): Promise<void> {
    this.rewarming ??= (async () => {
      try {
        if (this.closed) return;
        await openAll(this.receipts(), RECEIPTS_POOL_MAX);
        await openAll(this.ticks(), WATCH_POOL_MAX);
      } catch (error) {
        if (!this.closed) this.app.log.warn({ gatewayCodes: [...this.links.keys()], ...errorFields(error) }, REWARM_FAILED_LOG);
      } finally {
        this.rewarming = null;
      }
    })();
    return this.rewarming;
  }

  /** Notes that this process handed out the bearer token whose SHA-256 is `hash` at a gateway login. */
  tokenIssued(hash: string): void {
    this.issued.add(hash);
    for (const oldest of this.issued) {
      if (this.issued.size <= ISSUED_TOKENS_KEPT) break;
      this.issued.delete(oldest);
    }
  }

  /**
   * DI-30, PR-20 (tablets 0350): puts heartbeat `heartbeat`, sent with the bearer token whose SHA-256 is `hash`, on
   * record as received, in one statement on the receipts pool that also reads the session behind the token and the
   * site's time zone. A token this process handed out is received at once; any other waits for its turn in the lane of
   * unverified tokens until `signal` (the answer's deadline) aborts, when it rejects with the signal's reason. A token
   * whose session is not live is no longer counted as handed out. `arrival` (the watch's, for this heartbeat) is settled
   * on record once the statement ended, lost when it failed or never ran.
   */
  async receiveHeartbeat(hash: string, heartbeat: unknown, signal: AbortSignal, arrival: Arrival | null = null): Promise<HeartbeatReceipt> {
    const receive = () =>
      this.receipts().query<{ r: { received?: boolean; probeApi?: boolean } | null; s: Record<string, unknown> | null; zone: string | null }>(RECEIPT_SQL, [
        hash,
        JSON.stringify(heartbeat),
      ]);
    if (arrival) arrival.started = true;
    const receiving = this.issued.has(hash) ? receive() : this.unverified.run(signal, receive);
    // The watch counts the heartbeat on record once its statement ended, lost when it failed or never ran (tablets 0350, 6).
    receiving.then(
      () => arrival?.settle(true),
      () => arrival?.settle(false),
    );
    const { rows } = await receiving;
    const row = rows[0];
    const session = row?.s ?? null;
    if (session?.['state'] !== 'ACTIVE') this.issued.delete(hash);
    return { received: row?.r?.received === true, probeApi: row?.r?.probeApi === true, session, policyZone: row?.zone ?? null };
  }

  /**
   * Runs `command`, a heartbeat's command of gateway `gatewayCode`, once no other heartbeat command of that gateway is
   * running: one at a time, and only the latest heartbeat waits for its turn. A waiting one is dropped, without running,
   * when a newer one takes its place (TurnTaken) or when its answer is due before its turn comes (`signal` aborts; the
   * signal's reason). A command that has started runs to its end whatever the deadline (its waits and statements on the
   * reports pool end within REPORT_STATEMENT_TIMEOUT_MS each), so a command held up never piles up connections.
   */
  inTurn<T>(gatewayCode: string, signal: AbortSignal, command: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const turn: Turn = {
        signal,
        start: () => {
          const running = Promise.resolve().then(command);
          running.then(resolve, reject);
          return running.then(
            () => undefined,
            () => undefined,
          );
        },
        drop: reject,
      };
      if (this.closed) {
        reject(new Error('the devices runtime is closed'));
        return;
      }
      const slot = this.beating.get(gatewayCode);
      if (slot) {
        slot.next?.drop(new TurnTaken());
        slot.next = turn;
        return;
      }
      const own: { next: Turn | null } = { next: turn };
      this.beating.set(gatewayCode, own);
      void (async () => {
        try {
          for (let t = own.next; t; t = own.next) {
            own.next = null;
            if (t.signal.aborted) t.drop(t.signal.reason instanceof Error ? t.signal.reason : new Error('the answer is due'));
            else if (this.closed) t.drop(new Error('the devices runtime is closed'));
            else await t.start();
          }
        } finally {
          this.beating.delete(gatewayCode);
        }
      })();
    });
  }

  /**
   * A gateway must log in again (this process has no API token for it): unbinds its bearer token (SHA-256 `hash`) on
   * the reports pool and then ends its session `sessionId` on the application pool, as the kernel's session end always
   * runs (a session that cannot be ended is left to its timeouts, as before). Once per session at a time: a heartbeat
   * with the same token meanwhile waits for the same work.
   */
  endGatewaySession(hash: string, sessionId: string): Promise<void> {
    let ending = this.ending.get(sessionId);
    if (!ending) {
      ending = (async () => {
        await this.reports().query('select tab.unbind_gateway_session($1)', [hash]);
        this.issued.delete(hash);
        await identity.endSession(this.app.pools.app, sessionId).catch(() => undefined);
      })().finally(() => this.ending.delete(sessionId));
      this.ending.set(sessionId, ending);
    }
    return ending;
  }

  /**
   * Records, outside any command and before any statement that can wait on a lock, that the API of gateway
   * `gatewayCode` answered a probe (tab.record_gateway_api_answer, tablets 0350), on the receipts pool: while it is
   * marked unreachable, an answer after the mark keeps the manual path shut even when the monitor's command that marks
   * it reachable again is held up. Only within the receipts pool's limits: an answer that is not recorded (no
   * connection within RECEIPT_ACQUIRE_TIMEOUT_MS, the statement not ended within RECEIPT_STATEMENT_TIMEOUT_MS, no
   * ACTIVE key of the gateway) is lost, and logged at warn with the gateway code (decision X32), never silent; lost to
   * the database (not the no-key case), it is an arrival of the watch that did not settle on record, so the database
   * vouches for no window that holds it and the report cannot open the manual path meanwhile (decision X37). Never
   * rejects.
   */
  async recordApiAnswer(gatewayCode: string, detail: string): Promise<void> {
    // An arrival of the watch (tablets 0350, 6): an answer that is lost keeps the database from vouching for its window.
    const arrival = this.arrived();
    if (arrival) arrival.started = true;
    try {
      const { rows } = await this.receipts().query<{ recorded: boolean | null }>('select tab.record_gateway_api_answer($1, $2) as recorded', [gatewayCode, detail.slice(0, 500)]);
      // No ACTIVE key: no scale of the gateway reaches the gate, so nothing is lost for it.
      arrival?.settle(true);
      if (rows[0]?.recorded === true) return;
      this.app.log.warn({ gatewayCode, err: 'tab.record_gateway_api_answer found no ACTIVE key of the gateway' }, API_ANSWER_NOT_RECORDED_LOG);
    } catch (error) {
      arrival?.settle(false);
      this.app.log.warn({ gatewayCode, ...errorFields(error) }, API_ANSWER_NOT_RECORDED_LOG);
    }
  }

  /** Resolves when the reading is ingested (or at once when `exists` says it already is), or after `ms`. */
  waitForIngest(readingId: string, ms: number, exists: () => Promise<boolean>): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.ingested.off(readingId, onIngested);
        resolve(v);
      };
      const onIngested = () => finish(true);
      const timer = setTimeout(() => {
        void exists().then(finish, () => finish(false));
      }, ms);
      this.ingested.on(readingId, onIngested);
      void exists().then((v) => (v ? finish(true) : undefined), () => undefined);
    });
  }

  /**
   * Whether the gateway API monitor identity is configured (the TEST-SRV-MONITOR entry of the service-keys file). A
   * file that cannot be read counts as none.
   */
  monitorConfigured(): boolean {
    try {
      return monitorCredentials(this.app.config.serviceKeysFile) !== null;
    } catch {
      return false;
    }
  }

  /** The monitor's actor, its session opened once and shared (null when no identity is configured or it cannot log in). */
  private monitorActor(): Promise<(ActorContext & { deviceId: string }) | null> {
    if (this.closed) return Promise.resolve(null);
    this.monitor ??= (async () => {
      let creds: MonitorCredentials | null;
      try {
        creds = monitorCredentials(this.app.config.serviceKeysFile);
      } catch {
        creds = null;
      }
      return creds ? openMonitorActor(this.app, creds) : null;
    })().catch(() => {
      this.monitor = null; // the next observation tries to log in again
      return null;
    });
    return this.monitor;
  }

  /** Forgets the monitor's session `actor` (ending it) so the next observation opens a new one, unless that has happened already. */
  private async dropMonitor(actor: ActorContext): Promise<void> {
    const current = this.monitor;
    if (current && (await current) === actor && this.monitor === current) this.monitor = null;
    await identity.endSession(this.app.pools.app, actor.sessionId).catch(() => undefined);
  }

  /**
   * Records in the database whether the server reached the API of gateway `gatewayCode` (DI-30; tablets 0320), in a
   * command of the gateway API monitor (tablets 0340), queued behind the one being recorded (recordLatest); a command
   * that fails (a lapsed or locked session) is tried once more with a new session. Never rejects: a failure to record
   * leaves the database's last state, which the next contact or probe records again.
   */
  recordApiContact(gatewayCode: string, reachable: boolean, detail: string): Promise<void> {
    return this.recordLatest(gatewayCode, reachable, detail);
  }

  /**
   * The monitor's commands for gateway `gatewayCode`, one at a time: while one is being recorded, only the latest
   * observation waits for its turn (a newer one replaces it). So a command held up by another transaction never piles
   * up connections, never holds up a probe (probeApi does not wait for it), and what lands last is what was observed
   * last. Resolves when the observation, or a newer one, has been tried. Never rejects.
   */
  private recordLatest(gatewayCode: string, reachable: boolean, detail: string): Promise<void> {
    const queued = this.recording.get(gatewayCode);
    if (queued) {
      queued.pending = { reachable, detail };
      return queued.done;
    }
    const state: { pending: { reachable: boolean; detail: string } | null; done: Promise<void> } = { pending: { reachable, detail }, done: Promise.resolve() };
    state.done = (async () => {
      for (let next = state.pending; next; next = state.pending) {
        state.pending = null;
        await this.writeApiContact(gatewayCode, next.reachable, next.detail);
      }
    })().finally(() => this.recording.delete(gatewayCode));
    this.recording.set(gatewayCode, state);
    return state.done;
  }

  /** One observation, in a command of the monitor (tried once more with a new session when it fails). Never rejects. */
  private async writeApiContact(gatewayCode: string, reachable: boolean, detail: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const actor = await this.monitorActor();
      if (!actor) return;
      try {
        await withActorCommand(this.app.pools.app, { ...actor, correlationId: randomUUID() }, (client) =>
          client.query('select tab.record_gateway_api_contact($1, $2, $3)', [gatewayCode, reachable, detail.slice(0, 500)]),
        );
        return;
      } catch {
        await this.dropMonitor(actor);
      }
    }
  }

  /** Ends the monitor's session (server shutdown); nothing is recorded afterwards. */
  async close(): Promise<void> {
    this.closed = true;
    const actor = await (this.monitor ?? Promise.resolve(null));
    this.monitor = null;
    if (actor) await identity.endSession(this.app.pools.app, actor.sessionId).catch(() => undefined);
    for (const slot of this.beating.values()) {
      slot.next?.drop(new Error('the devices runtime is closed'));
      slot.next = null;
    }
    // The watch stops ticking first: the database vouches for no window after its last tick.
    const watch = await (this.watching ?? Promise.resolve(null)).catch(() => null);
    await watch?.stop();
    await this.rewarming;
    // Ending a pool waits for the commands still running on it (each statement ends within its pool's limit).
    const pools = [this.reportsPool, this.receiptsPool, this.watchPool].filter((p): p is pg.Pool => p !== null);
    this.reportsPool = null;
    this.receiptsPool = null;
    this.watchPool = null;
    await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
  }

  /**
   * Checks that the gateway's API answers GET /v1/health for this server's API token and names this gateway, and
   * records the outcome (one probe per gateway at a time). The database asks for it with every heartbeat it receives
   * while it counts the API unreachable (tab.record_heartbeat_receipt probeApi, tablets 0350): a capture is refused
   * while the scale is OFFLINE, so it cannot show recovery. The probe ends once the health check and the answer are
   * recorded (recordApiAnswer); it does not wait for the monitor's command (recordLatest), so the next heartbeat can
   * probe again even while that command is held up.
   */
  probeApi(gatewayCode: string): Promise<void> {
    const running = this.probing.get(gatewayCode);
    if (running) return running;
    const probe = (async () => {
      const problem = await this.healthProblem(gatewayCode);
      if (problem === null) await this.recordApiAnswer(gatewayCode, 'GET /v1/health answered for this server');
      void this.recordLatest(gatewayCode, problem === null, problem ?? 'GET /v1/health answered for this server');
    })().finally(() => this.probing.delete(gatewayCode));
    this.probing.set(gatewayCode, probe);
    return probe;
  }

  private async healthProblem(gatewayCode: string): Promise<string | null> {
    const link = this.link(gatewayCode);
    if (!link) return `gateway ${gatewayCode} has not logged in to this server`;
    let res: Response;
    try {
      res = await fetch(`${this.gatewayUrl}/v1/health`, { headers: { authorization: `Bearer ${link.apiToken}` }, signal: AbortSignal.timeout(5000) });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) return `the gateway answered GET /v1/health with ${res.status}`;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return `the gateway answered GET /v1/health ${res.status} without JSON`;
    }
    const parsed = GatewayHealth.safeParse(json);
    if (!parsed.success) return 'the gateway\'s answer to GET /v1/health is not in the expected form';
    if (parsed.data.gatewayCode !== gatewayCode) return `the API at ${this.gatewayUrl} is gateway ${parsed.data.gatewayCode}, not ${gatewayCode}`;
    return null;
  }

  /** Asks the gateway for a stable reading (POST /v1/devices/:code/capture). */
  async capture(gatewayCode: string, deviceCode: string, request: CaptureRequest): Promise<CaptureResponse | { unreachable: string }> {
    const link = this.link(gatewayCode);
    if (!link) return { unreachable: `gateway ${gatewayCode} has not logged in to this server` };
    let res: Response;
    try {
      res = await fetch(`${this.gatewayUrl}/v1/devices/${encodeURIComponent(deviceCode)}/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${link.apiToken}` },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout((request.timeoutMs ?? 10_000) + 10_000),
      });
    } catch (error) {
      return { unreachable: error instanceof Error ? error.message : String(error) };
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { unreachable: `the gateway answered ${res.status} without JSON` };
    }
    const parsed = CaptureResponse.safeParse(json);
    if (!parsed.success) return { unreachable: `the gateway answered ${res.status}: ${text.slice(0, 200)}` };
    return parsed.data;
  }
}

const runtimes = new WeakMap<AppContext, DevicesRuntime>();

export function runtimeOf(app: AppContext): DevicesRuntime {
  let r = runtimes.get(app);
  if (!r) {
    r = new DevicesRuntime(app);
    runtimes.set(app, r);
  }
  return r;
}

type Listener = (sample: LiveSample) => void;

/**
 * One upstream live stream per scale while at least one browser watches it. When the gateway cannot be reached
 * the watchers get an OFFLINE sample every 2 s and the hub keeps retrying. Samples are validated and passed on
 * as they are; nothing here is recorded.
 */
export class LiveHub {
  private readonly watchers = new Map<string, Set<Listener>>();
  private readonly upstreams = new Map<string, AbortController>();

  constructor(private readonly runtime: DevicesRuntime) {}

  subscribe(gatewayCode: string, deviceCode: string, listener: Listener): () => void {
    let set = this.watchers.get(deviceCode);
    if (!set) {
      set = new Set();
      this.watchers.set(deviceCode, set);
    }
    set.add(listener);
    if (!this.upstreams.has(deviceCode)) this.start(gatewayCode, deviceCode);
    return () => {
      const s = this.watchers.get(deviceCode);
      s?.delete(listener);
      if (s && s.size === 0) {
        this.watchers.delete(deviceCode);
        this.upstreams.get(deviceCode)?.abort();
        this.upstreams.delete(deviceCode);
      }
    };
  }

  close(): void {
    for (const c of this.upstreams.values()) c.abort();
    this.upstreams.clear();
    this.watchers.clear();
  }

  private emit(deviceCode: string, sample: LiveSample): void {
    for (const l of this.watchers.get(deviceCode) ?? []) l(sample);
  }

  private start(gatewayCode: string, deviceCode: string): void {
    const controller = new AbortController();
    this.upstreams.set(deviceCode, controller);
    const offline: LiveSample = { deviceCode, value: null, unit: null, stable: false, status: 'OFFLINE' };
    const loop = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        const link = this.runtime.link(gatewayCode);
        if (link) {
          try {
            const res = await fetch(`${this.runtime.gatewayUrl}/v1/devices/${encodeURIComponent(deviceCode)}/live`, {
              headers: { accept: 'text/event-stream', authorization: `Bearer ${link.apiToken}` },
              signal: controller.signal,
            });
            if (res.ok && res.body) {
              await this.pump(res.body, deviceCode, controller.signal);
            }
          } catch {
            // falls through to the offline sample and a retry
          }
        }
        if (controller.signal.aborted) return;
        this.emit(deviceCode, offline);
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    void loop();
  }

  private async pump(body: ReadableStream<Uint8Array>, deviceCode: string, signal: AbortSignal): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    const reader = body.getReader();
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const data = event
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('');
          if (!data) continue;
          try {
            const parsed = LiveSample.safeParse(JSON.parse(data));
            if (parsed.success && parsed.data.deviceCode === deviceCode) this.emit(deviceCode, parsed.data);
          } catch {
            // a malformed display sample is dropped (display only)
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
