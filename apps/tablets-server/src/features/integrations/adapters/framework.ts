/**
 * The adapter worker framework (Phase 6 slice 6a; DI-31, DI-20; D-P6a-1, D-P6a-0-5, D-P6a-B-7): one worker per adapter
 * instance (one feed of one source system, D-P6a-0-7), the single base of every system's adapter (ERP/WMS in
 * ./erp-wms; QMS, LIMS, LMS and CMMS as a FeedAdapterSpec in ./qms, ./lims, ./lms, ./cmms; started with the server by
 * ./start.ts). Builder A's worker merged with builder B's pull worker (defect P6a-I1): B's source reason, page loop
 * and receive-by-message-type map on A's checks, health and blocking. It is application code (decision 0008 "Other"):
 * every rule it relies on is the database's.
 *
 * The feed protocol (the simulators of apps/simulators serve it; a real system is mapped onto it at deployment):
 *   GET <base>/feed?after=N&limit=M     {messages: [envelope, ...], head}   the source's messages after sequence N
 *   GET <base>/heartbeat                200 while the source's data is current; 503 when its synchronisation stopped
 *   GET <base>/reconciliation?from&to   ReconciliationSubmission over [from, to) of source time
 *
 * One cycle (AdapterWorker.cycle):
 *   1. the heartbeat (200 while the source's own synchronisation runs);
 *   2. pages of the feed after the worker's cursor (the highest sequence number handled; at start, the database's), up to
 *      maxPages a cycle, until the worker is caught up, a page is empty or the cursor no longer moves;
 *   3. per message, in the order received: the envelope checked (InboundEnvelope), its hash checked against the payload
 *      as received, the payload checked with the contract's schema, then the system's receiving command in one database
 *      command (platform.accept_inbound_detail and the domain command, whole or not at all), carrying the source's
 *      reason (reason code INBOUND_MESSAGE and a text naming the message type, record id and system, D-P6a-B-7): a
 *      receiving command that updates an audited row (an LMS withdrawal) is refused by the audit trail without one. A refusal of a known class
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

/** The source's reason a receiving command carries (D-P6a-B-7; the audit trail refuses an update without one). */
export function sourceReason(e: Pick<InboundEnvelope, 'messageType' | 'sourceRecordId' | 'sourceSystem'>): { reasonCode: string; reasonText: string } {
  return { reasonCode: 'INBOUND_MESSAGE', reasonText: `${e.messageType} ${e.sourceRecordId} from the ${e.sourceSystem}` };
}

export interface AdapterDefinition {
  /** The registered adapter's code (iam.integration_adapter). */
  code: string;
  system: SourceSystem;
  contract: SystemContract;
  /** The mirror data classes this feed keeps fresh (its heartbeat records their synchronisation). */
  mirrorClasses: readonly string[];
  /** The system's receiving command for one checked envelope, inside the worker's command transaction (which carries
   *  the source's reason). */
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
  /** The items the feed delivered this cycle (all pages). */
  received: number;
  /** The same as `received` (the name builder B's reports used). */
  fetched: number;
  accepted: number;
  duplicates: number;
  /** Refusals recorded this cycle, by class. */
  refused: Partial<Record<ErrorClass, number>>;
  outcomes: MessageOutcome[];
  /** Set when the cycle stopped early: TRANSPORT (retried later) or UNCLASSIFIED (the worker is blocked on it). */
  stoppedBy: { kind: 'TRANSPORT' | 'UNCLASSIFIED'; error: string } | null;
  /** stoppedBy's error, or null. */
  stopped: string | null;
  /** The mirror data classes were synchronised this cycle. */
  synced: boolean;
  /** The cursor after the cycle. */
  after: string;
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
  private readonly maxPages: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<CycleReport> | null = null;
  private notBefore = 0;
  /** Keys this worker recorded as refused, with their hash (a resend of one is not recorded twice). */
  private readonly refusedKeys = new Map<string, string>();
  readonly healthState: AdapterHealth;

  constructor(pool: pg.Pool, def: AdapterDefinition, feed: FeedClient, openActor: () => Promise<ActorContext>, opts: { pageSize?: number; maxPages?: number } = {}) {
    this.pool = pool;
    this.def = def;
    this.feed = feed;
    this.openActor = openActor;
    this.pageSize = opts.pageSize ?? 100;
    this.maxPages = opts.maxPages ?? 10;
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

  /** Runs `work` as the adapter in one database command (`reason`: the source's reason of a receiving command). */
  async command<T>(work: (client: pg.PoolClient) => Promise<T>, reason?: { reasonCode: string; reasonText: string }): Promise<T> {
    return withCommand(this.pool, { ...(await this.session()), correlationId: randomUUID(), ...(reason ?? {}) }, work);
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
    const report: CycleReport = {
      heartbeat: false, caughtUp: false, received: 0, fetched: 0, accepted: 0, duplicates: 0, refused: {}, outcomes: [], stoppedBy: null, stopped: null, synced: false, after: '0',
    };
    this.healthState.state = 'RUNNING';
    try {
      this.cursor ??= await this.databaseCursor();
      report.heartbeat = await this.feed.heartbeat();
      for (let pageNo = 0; pageNo < this.maxPages; pageNo++) {
        const before: bigint = this.cursor;
        const page = await this.feed.page(before, this.pageSize);
        this.healthState.head = page.head;
        report.received += page.messages.length;
        report.fetched = report.received;
        for (const m of page.messages) {
          const outcome = await this.handle(m);
          report.outcomes.push(outcome);
          if (outcome.result === 'ACCEPTED') report.accepted += 1;
          else if (outcome.result === 'DUPLICATE') report.duplicates += 1;
          else if (outcome.errorClass) report.refused[outcome.errorClass] = (report.refused[outcome.errorClass] ?? 0) + 1;
          const seq = outcome.sequenceNo ? BigInt(outcome.sequenceNo) : null;
          if (seq !== null && seq > this.cursor) this.cursor = seq;
        }
        // The mirror is fresh only when the source's synchronisation runs (heartbeat) AND this worker holds everything
        // the source has published (caught up): a feed gap or a backlog lets the mirror age and fail closed.
        report.caughtUp = /^(0|[1-9][0-9]{0,17})$/.test(page.head) && this.cursor >= BigInt(page.head);
        // Another page only while it can bring something: not caught up, and this page moved the cursor.
        if (report.caughtUp || page.messages.length === 0 || this.cursor <= before) break;
      }
      if (report.heartbeat && report.caughtUp && this.def.mirrorClasses.length > 0) {
        await this.command(async (c) => {
          for (const cls of this.def.mirrorClasses) await c.query('select platform.record_mirror_sync($1)', [cls]);
        });
        report.synced = true;
      }
      this.healthState.state = 'IDLE';
      this.healthState.attempts = 0;
      this.healthState.lastError = null;
      this.notBefore = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = error instanceof UnclassifiedFailure ? 'UNCLASSIFIED' : 'TRANSPORT';
      report.stoppedBy = { kind, error: message };
      report.stopped = message;
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
    report.after = this.healthState.cursor;
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
      const r = await this.command((c) => this.def.receive(c, e), sourceReason(e));
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

  /** Runs a cycle now and then every `intervalMs` (a failed cycle waits for its back-off). */
  start(intervalMs: number, log?: { warn(obj: object, msg: string): void }): void {
    if (this.timer) return;
    const tick = (): void => {
      if (!this.timer || this.running || performance.now() < this.notBefore) return;
      this.running = this.cycle().finally(() => {
        this.running = null;
      });
      this.running.then(
        (r) => {
          if (r.stoppedBy && log) log.warn({ adapter: this.def.code, ...r.stoppedBy, attempt: this.healthState.attempts }, 'the integration adapter will retry');
        },
        (error: unknown) => log?.warn({ adapter: this.def.code, err: error instanceof Error ? error.message : String(error) }, 'the integration adapter cycle failed; it will retry'),
      );
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
    tick();
  }

  /** True while the worker runs cycles (between start and stop). */
  isStarted(): boolean {
    return this.timer !== null;
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

// ---------------------------------------------------------------------------------------------------------------
// Systems that are a mapping of message types onto receiving commands (QMS, LIMS, LMS, CMMS)
// ---------------------------------------------------------------------------------------------------------------

export type FeedSystem = 'QMS' | 'LIMS' | 'LMS' | 'CMMS';

/** A system whose adapter is only a map of message types to receiving commands of the database (builder B's four). */
export interface FeedAdapterSpec {
  system: FeedSystem;
  contract: SystemContract;
  /** The simulator's or system's path prefix, e.g. 'lms': the feed base is <root>/<prefix>/v1. */
  prefix: string;
  /** Receiving command per message type (a SECURITY DEFINER that calls platform.accept_inbound_detail and applies the
   *  payload in the same transaction). */
  receive: Readonly<Record<string, string>>;
  /** Mirror data classes the system feeds (kernel 1180 platform.mirror_data_class). */
  mirrorClasses: readonly string[];
}

/** The definition of a spec'd system's adapter registered as `code`. */
export function feedAdapterDefinition(code: string, spec: FeedAdapterSpec): AdapterDefinition {
  return {
    code,
    system: spec.system,
    contract: spec.contract,
    mirrorClasses: spec.mirrorClasses,
    async receive(client, envelope) {
      const fn = spec.receive[envelope.messageType];
      // A type the contract and the database know but this adapter has no command for is refused as the database
      // refuses an unknown type (EBMR-INT-004, MALFORMED), never accepted without being applied.
      if (!fn) throw Object.assign(new Error(`EBMR-INT-004 ${spec.system} message type ${envelope.messageType} has no receiving command here`), { code: 'P0001' });
      const { rows } = await client.query<{ r: Partial<ReceiveResult> | null }>(`select ${fn}($1::jsonb) as r`, [JSON.stringify(envelope)]);
      const r = rows[0]?.r;
      return {
        messageId: r?.messageId ?? '',
        outcome: r?.outcome === 'DUPLICATE' ? 'DUPLICATE' : 'ACCEPTED',
        sequenceStatus: r?.sequenceStatus ?? '',
        alarmId: r?.alarmId ?? null,
      };
    },
  };
}

/** The worker of a spec'd system's feed at `endpoint` (<root>/<prefix>/v1), registered as adapter `code`. */
export function feedWorker(
  pool: pg.Pool,
  code: string,
  spec: FeedAdapterSpec,
  openActor: () => Promise<ActorContext>,
  opts: { endpoint: string; timeoutMs?: number; fetchFn?: FetchFn; pageSize?: number },
): AdapterWorker {
  const fetchOpts = { ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}) };
  return new AdapterWorker(pool, feedAdapterDefinition(code, spec), httpFeedClient(opts.endpoint, fetchOpts), openActor, opts.pageSize ? { pageSize: opts.pageSize } : {});
}
