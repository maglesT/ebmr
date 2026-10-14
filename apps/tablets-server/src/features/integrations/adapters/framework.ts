/**
 * The adapter worker base (Phase 6 slice 6a, builder A; DI-31, DI-20; D-P6a-1, D-P6a-0-5): one worker per adapter
 * instance (one feed of one source system, D-P6a-0-7), shared by every system (ERP/WMS here; QMS, LIMS, LMS and CMMS
 * by builder B). It is application code (decision 0008 "Other"): every rule it relies on is the database's.
 *
 * The feed protocol (the simulators of apps/simulators serve it; a real system is mapped onto it at deployment):
 *   GET <base>/feed?after=N&limit=M     {messages: [envelope, ...], head}   the source's messages after sequence N
 *   GET <base>/heartbeat                200 while the source's data is current; 503 when its synchronisation stopped
 *   GET <base>/reconciliation?from&to   ReconciliationSubmission over [from, to) of source time
 *
 * One cycle (AdapterWorker.cycle):
 *   1. the heartbeat (200 while the source's own synchronisation runs);
 *   2. a page of the feed after the worker's cursor (the highest sequence number handled; at start, the database's);
 *   3. per message, in the order received: the envelope checked (InboundEnvelope), its hash checked against the payload
 *      as received, the payload checked with the contract's schema, then the system's receiving command in one database
 *      command (platform.accept_inbound_detail and the domain command, whole or not at all). A refusal of a known class
 *      is recorded in its own command (platform.record_inbound_refusal, which raises the alarm) and the cursor moves on;
 *      a TRANSPORT failure (the source or the database unreachable, a cut answer, a late answer) ends the cycle without
 *      moving the cursor, and the next cycle retries after retryDelayMs(attempt) (1 s doubling to 5 min, never given up);
 *      an unclassified failure stops the worker on that message (health BLOCKED, retried with back-off, never skipped);
 *   4. when the heartbeat answered and the worker is caught up (its cursor reached the source's head),
 *      platform.record_mirror_sync for each mirror data class the adapter keeps: a source whose synchronisation stopped,
 *      a feed gap or a backlog lets the mirror age past its bound and fail closed (EBMR-INT-010);
 *   5. the system's after-cycle work (the ERP's outbound delivery, the WMS's move questions), also when the feed failed.
 * Acknowledgment follows the commit (ACK_RULE): the feed protocol acknowledges by the cursor (the next page is asked
 * after the highest sequence handled), so a crash before the next page only causes a resend, which de-duplicates.
 *
 * Reconciliation (AdapterWorker.reconcile): the source's count and checksum of a closed period of source time,
 * submitted with platform.record_reconciliation; a message the eBMR neither accepted nor recorded as refused shows as a
 * RECONCILIATION_MISMATCH alarm (no silent loss).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  classifyFailure,
  InboundEnvelope,
  payloadSchema,
  rawPayloadHash,
  ReconciliationSubmission,
  retryDelayMs,
  type ErrorClass,
  type SourceSystem,
  type SystemContract,
} from '@ebmr/integration-sdk/adapter';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import type pg from 'pg';
import type { AppContext } from '../../../platform/context.ts';

// ---------------------------------------------------------------------------------------------------------------
// The feed client
// ---------------------------------------------------------------------------------------------------------------

export interface FeedPage {
  messages: unknown[];
  head: string;
}

export interface FeedClient {
  page(after: bigint, limit: number): Promise<FeedPage>;
  heartbeat(): Promise<boolean>;
  reconciliation(fromUs: bigint, toUs: bigint): Promise<ReconciliationSubmission>;
}

/** A failure to reach the source (or a cut or late answer): always TRANSPORT. */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** GET/POST JSON with a timeout; every failure to complete the exchange is a TransportError. */
export async function exchange(fetchFn: FetchFn, url: string, timeoutMs: number, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: init.method ?? 'GET',
      ...(init.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
      signal: ac.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        // A cut answer or garbage in place of the protocol's JSON: the exchange did not complete.
        throw new TransportError(`${url}: the answer is not complete JSON (${text.length.toString()} bytes)`);
      }
    }
    return { status: res.status, body };
  } catch (error) {
    if (error instanceof TransportError) throw error;
    throw new TransportError(`${url}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** The feed client of the protocol above, over HTTP. */
export function httpFeedClient(baseUrl: string, opts: { timeoutMs?: number; fetchFn?: FetchFn } = {}): FeedClient {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch);
  const timeoutMs = opts.timeoutMs ?? 2000;
  const base = baseUrl.replace(/\/$/, '');
  return {
    async page(after, limit) {
      const r = await exchange(fetchFn, `${base}/feed?after=${after.toString()}&limit=${limit.toString()}`, timeoutMs);
      const b = r.body as Partial<FeedPage> | null;
      if (r.status !== 200 || !b || !Array.isArray(b.messages) || typeof b.head !== 'string') {
        throw new TransportError(`${base}/feed answered ${r.status.toString()} without a page`);
      }
      return { messages: b.messages, head: b.head };
    },
    async heartbeat() {
      try {
        const r = await exchange(fetchFn, `${base}/heartbeat`, timeoutMs);
        return r.status === 200;
      } catch {
        return false;
      }
    },
    async reconciliation(fromUs, toUs) {
      const r = await exchange(fetchFn, `${base}/reconciliation?from=${fromUs.toString()}&to=${toUs.toString()}`, timeoutMs);
      const parsed = ReconciliationSubmission.safeParse(r.body);
      if (r.status !== 200 || !parsed.success) throw new TransportError(`${base}/reconciliation answered ${r.status.toString()} without a report`);
      return parsed.data;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The adapter's identity
// ---------------------------------------------------------------------------------------------------------------

export interface AdapterCredentials {
  loginName: string;
  serviceKey: string;
  fingerprint: string;
}

/**
 * Opens a SERVICE_KEY session of the adapter's INTEGRATION account on its SERVER terminal (the device it is
 * registered with, kernel 1180) and returns its actor in `roleCode`, with source INTEGRATION. The legal name is the
 * person's as the database holds it (the kernel refuses any other, DI-14).
 */
export async function openAdapterActor(app: Pick<AppContext, 'pools' | 'siteZone'>, c: AdapterCredentials, roleCode: string): Promise<ActorContext & { deviceId: string }> {
  const siteZone = app.siteZone.current();
  const ev = await identity.authenticate(app.pools.authn, { method: 'SERVICE_KEY', identifier: c.loginName, secret: c.serviceKey, deviceFingerprint: c.fingerprint, purpose: 'LOGIN' });
  const s = await identity.openSession(app.pools.app, ev.authEventId, c.fingerprint);
  const { rows } = await app.pools.app.query<{ person_id: string; account_id: string; legal_name: string }>(
    'select a.person_id, a.id as account_id, p.legal_name from iam.account a join iam.person p on p.id = a.person_id where a.login_name = $1',
    [c.loginName],
  );
  const who = rows[0];
  if (!who) throw new Error(`the adapter account ${c.loginName} does not exist`);
  return { personId: who.person_id, accountId: who.account_id, roleCode, sessionId: s.sessionId, deviceId: s.deviceId, source: 'INTEGRATION', siteZone, legalName: who.legal_name };
}

/** One adapter's entry of the service-keys file (EBMR_SERVICE_KEYS_FILE): its terminal, account, key and endpoint. */
export interface AdapterServiceEntry extends AdapterCredentials {
  endpoint: string;
}

/** The entry of terminal `terminal` in the service-keys file, when it names an endpoint (null otherwise). */
export function adapterEntry(file: string | null, terminal: string): AdapterServiceEntry | null {
  if (!file) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { services?: { terminal: string; loginName: string; serviceKey: string; fingerprint?: string | null; terminalKey?: { fingerprint?: string } | null; endpoint?: string }[] };
  const e = (parsed.services ?? []).find((s) => s.terminal === terminal);
  const fingerprint = e?.terminalKey?.fingerprint ?? e?.fingerprint ?? null;
  if (!e || !fingerprint || !e.endpoint) return null;
  return { loginName: e.loginName, serviceKey: e.serviceKey, fingerprint, endpoint: e.endpoint };
}

// ---------------------------------------------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------------------------------------------

export interface ReceiveResult {
  messageId: string;
  outcome: 'ACCEPTED' | 'DUPLICATE';
  sequenceStatus: string;
  alarmId: string | null;
  applied?: unknown;
}

export interface AdapterDefinition {
  /** The registered adapter's code (iam.integration_adapter). */
  code: string;
  system: SourceSystem;
  contract: SystemContract;
  /** The mirror data classes this feed keeps fresh (its heartbeat records their synchronisation). */
  mirrorClasses: readonly string[];
  /** The system's receiving command for one checked envelope, inside the worker's command transaction. */
  receive(client: pg.PoolClient, envelope: InboundEnvelope): Promise<ReceiveResult>;
  /** Work after each cycle (outbound delivery, questions the source asks); runs as the adapter. */
  afterCycle?(worker: AdapterWorker): Promise<void>;
}

export interface MessageOutcome {
  sequenceNo: string | null;
  idempotencyKey: string | null;
  result: 'ACCEPTED' | 'DUPLICATE' | 'REFUSED';
  errorClass?: ErrorClass;
  code?: string;
  detail?: string;
}

export interface CycleReport {
  heartbeat: boolean;
  /** The worker holds every message the source published (its cursor reached the source's head). */
  caughtUp: boolean;
  received: number;
  outcomes: MessageOutcome[];
  /** Set when the cycle stopped early: TRANSPORT (retried later) or UNCLASSIFIED (the worker is blocked on it). */
  stoppedBy: { kind: 'TRANSPORT' | 'UNCLASSIFIED'; error: string } | null;
  /** The after-cycle work's failure, if any (retried next cycle). */
  afterCycleError?: string;
}

export interface AdapterHealth {
  code: string;
  system: SourceSystem;
  state: 'IDLE' | 'RUNNING' | 'RETRYING' | 'BLOCKED';
  cursor: string;
  head: string | null;
  /** Cycles run since the worker started. */
  cycles: number;
  attempts: number;
  lastError: string | null;
  accepted: number;
  duplicates: number;
  refused: number;
}

const ebmrCodeOf = (message: string): string | undefined => /\b(EBMR-[A-Z]+-\d{3})\b/.exec(message)?.[1];
const sqlStateOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof (error).code === 'string' ? (error as { code: string }).code : undefined;

/** Converts a received item into the JSON the database records for a refusal (a non-object as a JSON string of it). */
const asRecordable = (m: unknown): unknown => (typeof m === 'object' && m !== null && !Array.isArray(m) ? m : JSON.stringify(m ?? null));

export class AdapterWorker {
  readonly def: AdapterDefinition;
  readonly feed: FeedClient;
  private readonly pool: pg.Pool;
  private readonly openActor: () => Promise<ActorContext>;
  private actor: ActorContext | null = null;
  private cursor: bigint | null = null;
  private readonly pageSize: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<CycleReport> | null = null;
  private notBefore = 0;
  /** Keys this worker recorded as refused, with their hash (a resend of one is not recorded twice). */
  private readonly refusedKeys = new Map<string, string>();
  readonly healthState: AdapterHealth;

  constructor(pool: pg.Pool, def: AdapterDefinition, feed: FeedClient, openActor: () => Promise<ActorContext>, opts: { pageSize?: number } = {}) {
    this.pool = pool;
    this.def = def;
    this.feed = feed;
    this.openActor = openActor;
    this.pageSize = opts.pageSize ?? 100;
    this.healthState = { code: def.code, system: def.system, state: 'IDLE', cursor: '0', head: null, cycles: 0, attempts: 0, lastError: null, accepted: 0, duplicates: 0, refused: 0 };
  }

  health(): AdapterHealth {
    return { ...this.healthState };
  }

  /** The adapter's session (opened once, reopened after a failure). */
  async session(): Promise<ActorContext> {
    this.actor ??= await this.openActor();
    return this.actor;
  }

  /** Runs `work` as the adapter in one database command. */
  async command<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return withCommand(this.pool, { ...(await this.session()), correlationId: randomUUID() }, work);
  }

  /** The highest sequence number the database holds for this adapter (accepted or recorded as refused). */
  async databaseCursor(): Promise<bigint> {
    const { rows } = await this.pool.query<{ n: string | null }>(
      `select greatest((select max(sequence_no) from platform.inbound_message where adapter_code = $1),
                       (select max(sequence_no) from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED'))::text as n`,
      [this.def.code],
    );
    return BigInt(rows[0]?.n ?? '0');
  }

  /** One cycle (header). Never throws for a source or database failure: the report says what stopped it. */
  async cycle(): Promise<CycleReport> {
    const report: CycleReport = { heartbeat: false, caughtUp: false, received: 0, outcomes: [], stoppedBy: null };
    this.healthState.state = 'RUNNING';
    try {
      this.cursor ??= await this.databaseCursor();
      report.heartbeat = await this.feed.heartbeat();
      const page = await this.feed.page(this.cursor, this.pageSize);
      this.healthState.head = page.head;
      report.received = page.messages.length;
      for (const m of page.messages) {
        const outcome = await this.handle(m);
        report.outcomes.push(outcome);
        const seq = outcome.sequenceNo ? BigInt(outcome.sequenceNo) : null;
        if (seq !== null && seq > this.cursor) this.cursor = seq;
      }
      // The mirror is fresh only when the source's synchronisation runs (heartbeat) AND this worker holds everything the
      // source has published (caught up): a feed gap or a backlog lets the mirror age and fail closed.
      report.caughtUp = /^(0|[1-9][0-9]{0,17})$/.test(page.head) && this.cursor >= BigInt(page.head);
      if (report.heartbeat && report.caughtUp && this.def.mirrorClasses.length > 0) {
        await this.command(async (c) => {
          for (const cls of this.def.mirrorClasses) await c.query('select platform.record_mirror_sync($1)', [cls]);
        });
      }
      this.healthState.state = 'IDLE';
      this.healthState.attempts = 0;
      this.healthState.lastError = null;
      this.notBefore = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = error instanceof UnclassifiedFailure ? 'UNCLASSIFIED' : 'TRANSPORT';
      report.stoppedBy = { kind, error: message };
      this.actor = null; // a lapsed or broken session is reopened next time
      this.healthState.attempts += 1;
      this.healthState.state = kind === 'UNCLASSIFIED' ? 'BLOCKED' : 'RETRYING';
      this.healthState.lastError = message;
      this.notBefore = performance.now() + retryDelayMs(this.healthState.attempts);
    }
    // The system's own work runs whatever happened to the feed (an ERP whose feed is cut may still take deliveries).
    if (this.def.afterCycle) {
      try {
        await this.def.afterCycle(this);
      } catch (error) {
        report.afterCycleError = error instanceof Error ? error.message : String(error);
        this.actor = null;
        this.healthState.lastError = report.afterCycleError;
      }
    }
    this.healthState.cursor = (this.cursor ?? 0n).toString();
    this.healthState.cycles += 1;
    return report;
  }

  /** One received item: checked, received or refused (header, step 3). Throws for TRANSPORT and unclassified failures. */
  private async handle(m: unknown): Promise<MessageOutcome> {
    const loose = (typeof m === 'object' && m !== null ? m : {}) as Record<string, unknown>;
    const seqText = typeof loose['sequenceNo'] === 'string' && /^[1-9][0-9]{0,17}$/.test(loose['sequenceNo']) ? loose['sequenceNo'] : null;
    const keyText = typeof loose['idempotencyKey'] === 'string' ? loose['idempotencyKey'] : null;
    const env = InboundEnvelope.safeParse(m);
    if (!env.success) {
      return this.refuse(m, seqText, keyText, 'MALFORMED', undefined, `the envelope does not match the contract: ${env.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    const e = env.data;
    // A message this worker already refused, sent again unchanged (the source never saw the cursor move): handled.
    if (this.refusedKeys.get(e.idempotencyKey) === e.payloadHash) {
      return { sequenceNo: e.sequenceNo, idempotencyKey: e.idempotencyKey, result: 'DUPLICATE' };
    }
    if (rawPayloadHash(JSON.stringify(e.payload)) !== e.payloadHash) {
      return this.refuse(m, e.sequenceNo, e.idempotencyKey, 'MALFORMED', undefined, 'the payload hash is not the SHA-256 of the payload as received');
    }
    const schema = payloadSchema(this.def.contract, e);
    if (schema) {
      const p = schema.safeParse(e.payload);
      if (!p.success) {
        return this.refuse(m, e.sequenceNo, e.idempotencyKey, 'MALFORMED', undefined,
          `the ${e.messageType} v${e.schemaVersion} payload does not match the contract: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      }
    }
    // An unknown type or version is left to the database, which refuses it (EBMR-INT-004) and so names it.
    try {
      const r = await this.command((c) => this.def.receive(c, e));
      if (r.outcome === 'ACCEPTED') this.healthState.accepted += 1;
      else this.healthState.duplicates += 1;
      return { sequenceNo: e.sequenceNo, idempotencyKey: e.idempotencyKey, result: r.outcome };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = ebmrCodeOf(message);
      const cls = classifyFailure({ ebmrCode: code, sqlState: sqlStateOf(error), network: error instanceof TransportError }, this.def.contract.refusalCodes);
      if (cls === 'TRANSPORT') throw new TransportError(message);
      if (!cls) throw new UnclassifiedFailure(`${e.messageType} ${e.idempotencyKey}: ${message}`);
      return this.refuse(m, e.sequenceNo, e.idempotencyKey, cls, code, message);
    }
  }

  /** Records a refusal with its alarm in its own command (D-P6a-0-5); the source is told by the cursor moving on. */
  private async refuse(m: unknown, seq: string | null, key: string | null, cls: Exclude<ErrorClass, 'TRANSPORT'>, code: string | undefined, detail: string): Promise<MessageOutcome> {
    try {
      await this.command((c) => c.query('select platform.record_inbound_refusal($1::jsonb, $2, $3)', [JSON.stringify(asRecordable(m)), cls, detail.slice(0, 2000)]));
    } catch (error) {
      throw new TransportError(`the refusal could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.healthState.refused += 1;
    const hash = typeof (m as { payloadHash?: unknown } | null)?.payloadHash === 'string' ? (m as { payloadHash: string }).payloadHash : null;
    if (key && hash) this.refusedKeys.set(key, hash);
    return { sequenceNo: seq, idempotencyKey: key, result: 'REFUSED', errorClass: cls, ...(code ? { code } : {}), detail };
  }

  /** Submits the source's reconciliation of [fromUs, toUs) of source time; returns the report id and whether it matched. */
  async reconcile(fromUs: bigint, toUs: bigint): Promise<{ reportId: string; matched: boolean }> {
    const submission = await this.feed.reconciliation(fromUs, toUs);
    return this.command(async (c) => {
      const { rows } = await c.query<{ id: string }>('select platform.record_reconciliation($1::jsonb) as id', [JSON.stringify(submission)]);
      const id = rows[0]?.id ?? '';
      const m = await c.query<{ matched: boolean }>('select matched from platform.reconciliation_report where id = $1', [id]);
      return { reportId: id, matched: m.rows[0]?.matched ?? false };
    });
  }

  /** Runs cycles every `intervalMs` (a failed cycle waits for its back-off). */
  start(intervalMs: number, log?: { warn(obj: object, msg: string): void }): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running || performance.now() < this.notBefore) return;
      this.running = this.cycle().finally(() => {
        this.running = null;
      });
      void this.running.then((r) => {
        if (r.stoppedBy && log) log.warn({ adapter: this.def.code, ...r.stoppedBy, attempt: this.healthState.attempts }, 'the integration adapter will retry');
      });
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running.catch(() => undefined);
    if (this.actor) await identity.endSession(this.pool, this.actor.sessionId).catch(() => undefined);
    this.actor = null;
  }
}

/** A failure no class covers: the worker stops on it (never skips it) until it is understood (errors.ts). */
export class UnclassifiedFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnclassifiedFailure';
  }
}
