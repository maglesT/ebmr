/**
 * The uplink to the server's gateway listener (DI-28, DI-31):
 *  - login: a fresh nonce, an Ed25519 proof over it with the gateway key, the SERVICE_KEY of the gateway's
 *    INTEGRATION identity, and the API token the server will present to this gateway; the answer names the chain
 *    (enrolment) and the server's head, which the journal adopts (a watermark that cannot be written then fails the
 *    login, so no heartbeat is sent and the server shows the scales OFFLINE);
 *  - flush: the readings the server does not hold yet, in sequence, in batches, idempotent by reading id; the
 *    watermark moves only on the server's acknowledgement; a refusal stops the flush and is alarmed; failures back
 *    off. A flush never rejects. When the watermark cannot be written, what the server acknowledged is kept in
 *    memory: later readings are still delivered, each once, nothing is sent again, and the watermark is written as
 *    soon as it can be (review finding P52). Each batch first takes a challenge the server's database issues; each
 *    reading's wait is measured after it arrives and signed with the gateway key together with the challenge and the
 *    reading id, so the database counts everything after the signing itself (DI-28, review finding P53);
 *  - heartbeat every few seconds with the instruments' states and the reason a connected one is not ready (a gap
 *    over 10 s shows the scale OFFLINE), and at once when the gateway's ability to deliver changes, at most one such
 *    heartbeat per READINESS_HEARTBEAT_GAP_MS (a flapping state is reported, not flooded). The heartbeat's journal
 *    counts carry what the server acknowledged (deliveredSeq) beside the written watermark (ackedSeq), which stays
 *    behind while it cannot be written, so the server's reconciliation by counts (DI-31) is not blind then.
 * deliveryProblem() says why a reading captured now would not reach the server: the server refuses the oldest
 * reading it does not hold (every later one queues behind it), the watermark cannot be written, the last upload
 * failed, or readings journalled before this login are not delivered yet (after a restart the gateway does not know
 * whether the server accepts them). The gateway then reports its instruments not ready (review finding P51).
 */
import { randomBytes, sign } from 'node:crypto';
import {
  ChallengeResponse,
  GatewayWireError,
  HeartbeatResponse,
  LoginResponse,
  NonceResponse,
  UplinkResponse,
  genesisHash,
  loginProofMessage,
  uploadWaitMessage,
  type HeartbeatRequest,
  type ScaleReading,
  type UplinkItem,
} from '@ebmr/integration-sdk/scale';
import type { GatewayClock } from './clock.ts';
import type { GatewayConfig } from './config.ts';
import type { Journal } from './journal.ts';

/** The shortest time between two heartbeats sent because readiness changed (review finding P51). */
export const READINESS_HEARTBEAT_GAP_MS = 500;

export interface UplinkAlarm {
  kind: 'LOGIN_FAILED' | 'READING_REFUSED' | 'INSTALLATION_MISMATCH' | 'UPLINK_FAILED' | 'ACK_WRITE_FAILED';
  message: string;
  details: Record<string, string>;
}

export class UplinkError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly relogin: boolean,
  ) {
    super(message);
    this.name = 'UplinkError';
  }
}

export interface UplinkOptions {
  config: GatewayConfig;
  journal: Journal;
  clock: GatewayClock;
  /** The token the server presents to the gateway API (handed over at every login). */
  apiToken: string;
  /** Monotonic capture time of readings taken in this process (for their waiting time). */
  capturedAt: Map<string, bigint>;
  onAlarm?: (alarm: UplinkAlarm) => void;
  onLogin?: (login: LoginResponse) => void;
  log?: (message: string) => void;
  /** Heartbeat body (the instruments' states). */
  heartbeatBody: () => Omit<HeartbeatRequest, 'gatewayTimeUs' | 'journal'>;
}

export class Uplink {
  token: string | null = null;
  login: LoginResponse | null = null;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  private stopped = false;
  private loginBackoff = 500;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly ackWaiters = new Set<{ seq: bigint; resolve: (ok: boolean) => void }>();
  private started = false;
  private heartbeating: Promise<void> | null = null;
  private heartbeatAgain = false;
  /** When the last heartbeat was sent (performance.now(); network pacing, not GMP time). */
  private lastHeartbeatAt = Number.NEGATIVE_INFINITY;
  /** A readiness heartbeat waiting for READINESS_HEARTBEAT_GAP_MS to pass since the last one. */
  private readinessTimer: NodeJS.Timeout | null = null;
  lastRefusal: { readingId: string; code: string; message: string } | null = null;
  private refusedAtUs: bigint | null = null;
  /**
   * The last reading of the chain the server holds, as it last said, while the watermark on disk says otherwise (the
   * watermark could not be written); null while the watermark is the truth.
   */
  private serverHolds: { chainId: string; seq: bigint } | null = null;
  /** Why the watermark on disk is not what the server holds (null while it is). */
  watermarkFailure: string | null = null;
  /** Why the last upload failed (null once one succeeds, and at login). */
  uploadFailure: string | null = null;
  /** The last reading journalled before this login that the server did not hold then (null: none left). */
  private backlogUpTo: bigint | null = null;

  constructor(private readonly options: UplinkOptions) {}

  private get base(): string {
    return this.options.config.uplink;
  }

  private alarm(a: UplinkAlarm): void {
    this.options.onAlarm?.(a);
  }

  private async post<T>(path: string, body: unknown, parse: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, bearer: string | null): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new UplinkError(0, 'UNREACHABLE', `the server's gateway listener cannot be reached: ${error instanceof Error ? error.message : String(error)}`, false);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new UplinkError(res.status, 'PROTOCOL', `the listener answered ${res.status} without JSON`, false);
    }
    if (!res.ok) {
      const e = GatewayWireError.safeParse(json);
      if (e.success) throw new UplinkError(res.status, e.data.error.code, e.data.error.message, e.data.error.relogin);
      throw new UplinkError(res.status, 'PROTOCOL', `the listener answered ${res.status}`, res.status === 401);
    }
    const parsed = parse.safeParse(json);
    if (!parsed.success) throw new UplinkError(res.status, 'PROTOCOL', `the listener's answer to ${path} is not in the expected form`, false);
    return parsed.data;
  }

  /** Logs in and adopts the server's chain. Throws on refusal. */
  async logIn(): Promise<LoginResponse> {
    const { config, journal } = this.options;
    const { nonce } = await this.post('/gw/v1/nonce', {}, NonceResponse, null);
    const sig = sign(null, loginProofMessage(nonce, config.gatewayCode, config.loginName, config.publicKeySpki), config.privateKey).toString('base64');
    const login = await this.post(
      '/gw/v1/session',
      { gatewayCode: config.gatewayCode, loginName: config.loginName, serviceKey: config.serviceKey, spki: config.publicKeySpki, nonce, sig, apiToken: this.options.apiToken },
      LoginResponse,
      null,
    );
    if (login.installation !== config.installation) {
      this.alarm({ kind: 'INSTALLATION_MISMATCH', message: `the server is a ${login.installation} installation; this gateway is configured for ${config.installation}`, details: {} });
      throw new UplinkError(403, 'INSTALLATION_MISMATCH', 'installation kinds differ', false);
    }
    // The server's head is written as the watermark here; if that write fails the login fails (no heartbeat).
    const outcome = await journal.adoptServerChain(login.chainId, login.head);
    this.serverHolds = null;
    this.watermarkFailure = null;
    this.uploadFailure = null;
    // Readings journalled before this login that the server does not hold: whether it accepts them is not known
    // until they are offered, so nothing is captured behind them before that (a restarted gateway knows no refusal).
    this.backlogUpTo = outcome !== 'DIVERGED' && journal.lastSeq() > journal.ackedSeq ? journal.lastSeq() : null;
    this.token = login.token;
    this.login = login;
    this.options.log?.(`logged in to ${this.base} (chain ${login.chainId}, server head ${login.head.seq}, journal ${outcome})`);
    this.options.onLogin?.(login);
    this.readinessChanged();
    return login;
  }

  /** Starts login retries and the heartbeat loop. */
  start(): void {
    this.stopped = false;
    this.started = true;
    void this.ensureLogin();
    this.heartbeatTimer = setInterval(() => void this.heartbeatNow(), this.options.config.heartbeatMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.readinessTimer) clearTimeout(this.readinessTimer);
    this.readinessTimer = null;
    for (const w of this.ackWaiters) w.resolve(false);
    this.ackWaiters.clear();
    await this.flushing?.catch(() => undefined);
    await this.heartbeating?.catch(() => undefined);
  }

  /**
   * The gateway's ability to capture or deliver may have changed: with the loops running, a heartbeat goes out now
   * instead of at the next period, so the server's scale status follows within a round trip; but at most one such
   * heartbeat per READINESS_HEARTBEAT_GAP_MS since the last heartbeat: changes within that time are coalesced into
   * one heartbeat at its end, which reports the state as it is then.
   */
  readinessChanged(): void {
    // Only while logged in: without a session no heartbeat goes out (the server shows the scales OFFLINE anyway),
    // and a poke must not start extra login attempts.
    if (!this.started || this.stopped || this.token === null || this.readinessTimer !== null) return;
    const wait = this.lastHeartbeatAt + READINESS_HEARTBEAT_GAP_MS - performance.now();
    if (wait <= 0) {
      void this.heartbeatNow();
      return;
    }
    this.readinessTimer = setTimeout(() => {
      this.readinessTimer = null;
      if (!this.stopped) void this.heartbeatNow();
    }, Math.ceil(wait));
  }

  /** One heartbeat at a time; a request during one runs one more after it. Never rejects. */
  private heartbeatNow(): Promise<void> {
    if (this.heartbeating) {
      this.heartbeatAgain = true;
      return this.heartbeating;
    }
    this.heartbeating = (async () => {
      try {
        do {
          this.heartbeatAgain = false;
          this.lastHeartbeatAt = performance.now();
          await this.heartbeat().catch(() => undefined);
        } while (this.heartbeatAgain && !this.stopped);
      } finally {
        this.heartbeating = null;
      }
    })();
    return this.heartbeating;
  }

  private async ensureLogin(): Promise<boolean> {
    if (this.token) return true;
    try {
      await this.logIn();
      this.loginBackoff = 500;
      void this.flush();
      return true;
    } catch (error) {
      const e = error instanceof UplinkError ? error : null;
      this.alarm({ kind: 'LOGIN_FAILED', message: `login refused or failed: ${error instanceof Error ? error.message : String(error)}`, details: { code: e?.code ?? 'ERROR' } });
      if (!this.stopped && !this.retryTimer) {
        const wait = this.loginBackoff;
        this.loginBackoff = Math.min(10_000, this.loginBackoff * 2);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.ensureLogin();
        }, wait);
      }
      return false;
    }
  }

  private dropToken(): void {
    this.token = null;
    this.login = null;
  }

  /** Resolves true once the server has acknowledged reading `seq`, false after `ms`. */
  waitForAck(seq: bigint, ms: number): Promise<boolean> {
    if (this.deliveredSeq() >= seq) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = {
        seq,
        resolve: (ok: boolean) => {
          clearTimeout(timer);
          this.ackWaiters.delete(waiter);
          resolve(ok);
        },
      };
      const timer = setTimeout(() => waiter.resolve(false), ms);
      this.ackWaiters.add(waiter);
    });
  }

  private notifyAcks(): void {
    const delivered = this.deliveredSeq();
    for (const w of [...this.ackWaiters]) if (delivered >= w.seq) w.resolve(true);
  }

  /** The last reading of the current chain the server holds, as it last said (the watermark unless that is behind). */
  deliveredSeq(): bigint {
    const held = this.serverHolds;
    const journal = this.options.journal;
    return held !== null && held.chainId === journal.chainId ? held.seq : journal.ackedSeq;
  }

  /** The readings of the current chain the server does not hold yet, in sequence. */
  undelivered(): ScaleReading[] {
    return this.options.journal.all().slice(Number(this.deliveredSeq()));
  }

  /**
   * The server's refusal of the oldest reading it does not hold, while that reading is still the oldest: every later
   * reading of every instrument queues behind it, so nothing can be delivered (null when the chain is not blocked).
   */
  refusedHead(): { readingId: string; code: string; message: string } | null {
    const oldest = this.undelivered()[0];
    return this.lastRefusal !== null && oldest !== undefined && oldest.readingId === this.lastRefusal.readingId ? this.lastRefusal : null;
  }

  /**
   * Why a reading journalled now would not be delivered to the server, or not recorded as delivered (null when it
   * would be). The gateway reports its instruments not ready while this is not null (review finding P51).
   */
  deliveryProblem(): string | null {
    const refused = this.refusedHead();
    if (refused) return `the server refuses reading ${refused.readingId} (${refused.code}), so no later reading can be delivered; see the gateway alarms`;
    if (this.watermarkFailure !== null) {
      return `the server's acknowledgement cannot be recorded on the gateway's disk (${this.watermarkFailure}); nothing more is captured until it can`;
    }
    if (this.uploadFailure !== null) return `the last upload to the server failed (${this.uploadFailure}); nothing more is captured until an upload succeeds`;
    if (this.backlogUpTo !== null) {
      if (this.deliveredSeq() >= this.backlogUpTo) this.backlogUpTo = null;
      else return `readings journalled before the gateway logged in (up to ${this.backlogUpTo.toString()}) are not delivered to the server yet`;
    }
    return null;
  }

  /** Records a (possibly new) reason the watermark is behind; alarms once per episode; null when it is written. */
  private setWatermarkFailure(reason: string | null, seq: bigint): void {
    const was = this.watermarkFailure;
    this.watermarkFailure = reason;
    if (reason !== null && was === null) {
      this.alarm({
        kind: 'ACK_WRITE_FAILED',
        message: `the server holds readings up to ${seq.toString()}, but the watermark could not be recorded (${reason}); captures stop until it can`,
        details: { seq: seq.toString() },
      });
    }
    if ((reason === null) !== (was === null)) this.readinessChanged();
  }

  private setUploadFailure(reason: string | null): void {
    const was = this.uploadFailure;
    this.uploadFailure = reason;
    if ((reason === null) !== (was === null)) this.readinessChanged();
  }

  /** The server holds the chain up to `seq` (its acknowledgement, or its head): remember it and write the watermark. */
  private async serverHoldsUpTo(seq: bigint): Promise<void> {
    const chainId = this.options.journal.chainId;
    if (!chainId) return;
    this.serverHolds = { chainId, seq };
    await this.writeWatermark();
  }

  /**
   * Writes the watermark to what the server holds. A failure keeps it in memory (deliveredSeq), is alarmed once and
   * makes the gateway not ready; the next flush tries again.
   */
  private async writeWatermark(): Promise<void> {
    const journal = this.options.journal;
    const held = this.serverHolds;
    if (held === null) return;
    if (held.chainId !== journal.chainId || held.seq === journal.ackedSeq) {
      this.serverHolds = null;
      this.setWatermarkFailure(null, journal.ackedSeq);
      return;
    }
    const hash = held.seq === 0n ? genesisHash(held.chainId) : journal.all()[Number(held.seq) - 1]?.hash;
    try {
      if (hash === undefined) throw new Error(`the journal holds no reading ${held.seq.toString()}`);
      if (held.seq > journal.ackedSeq) await journal.acknowledge(held.seq, hash);
      else await journal.adoptServerChain(held.chainId, { seq: held.seq.toString(), hash });
    } catch (error) {
      this.setWatermarkFailure(error instanceof Error ? error.message : String(error), held.seq);
      return;
    }
    if (this.serverHolds === held) this.serverHolds = null;
    this.setWatermarkFailure(null, held.seq);
  }

  /**
   * Sends the readings the server does not hold, in order (single flight; a call during a flight runs one more pass),
   * and writes the watermark if it is behind. Never rejects: a failure is alarmed, and what is not delivered or not
   * recorded is tried again in the next pass.
   */
  flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      try {
        do {
          this.flushAgain = false;
          await this.flushOnce();
        } while (this.flushAgain && !this.stopped);
      } catch (error) {
        this.alarm({ kind: 'UPLINK_FAILED', message: `the upload stopped: ${error instanceof Error ? error.message : String(error)}`, details: {} });
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  private delayOf(r: ScaleReading): string | null {
    const at = this.options.capturedAt.get(r.readingId);
    if (at === undefined) return null;
    const d = this.options.clock.monoUs() - at;
    return (d < 0n ? 0n : d).toString();
  }

  /**
   * DI-28 (P53): an upload item whose wait is measured now, after the challenge arrived, and signed with the gateway
   * key over the challenge and the reading id (null wait, null signature: unknown after a restart).
   */
  private itemFor(reading: ScaleReading, challengeId: string): UplinkItem {
    const delayUs = this.delayOf(reading);
    const waitSig = delayUs === null ? null : sign(null, uploadWaitMessage(challengeId, reading.readingId, delayUs), this.options.config.privateKey).toString('base64');
    return { reading, delayUs, waitSig };
  }

  /** One pass; a pass that changes whether the gateway can deliver sends a heartbeat at once (either way). */
  private async flushOnce(): Promise<void> {
    const ready = this.deliveryProblem() === null;
    try {
      await this.deliver();
    } finally {
      if ((this.deliveryProblem() === null) !== ready) this.readinessChanged();
    }
  }

  private async deliver(): Promise<void> {
    const journal = this.options.journal;
    // Readings already journalled are delivered even after a failed append (they were written whole and synced).
    if (!journal.uploadable) return;
    if (!(await this.ensureLogin())) return;
    await this.writeWatermark();
    for (;;) {
      const batch = this.undelivered().slice(0, 50);
      if (batch.length === 0) return;
      // A refused reading is offered again only after 30 s (the alarm is already raised; no alarm storm).
      if (this.lastRefusal?.readingId === batch[0]?.readingId && this.refusedAtUs !== null && this.options.clock.monoUs() - this.refusedAtUs < 30_000_000n) return;
      let res: UplinkResponse;
      try {
        // DI-28 (P53): a fresh challenge for this batch; the waits are measured and signed only once it has arrived.
        const { challengeId } = await this.post('/gw/v1/challenge', {}, ChallengeResponse, this.token);
        res = await this.post('/gw/v1/readings', { challengeId, items: batch.map((reading) => this.itemFor(reading, challengeId)) }, UplinkResponse, this.token);
      } catch (error) {
        if (error instanceof UplinkError && error.relogin) this.dropToken();
        const message = error instanceof Error ? error.message : String(error);
        this.alarm({ kind: 'UPLINK_FAILED', message: `readings not uploaded: ${message}`, details: {} });
        this.setUploadFailure(message);
        return;
      }
      this.setUploadFailure(null);
      const last = res.results.at(-1);
      if (last) {
        const reading = batch.find((r) => r.readingId === last.readingId);
        if (reading && reading.seq === last.seq) {
          for (const r of res.results) this.options.capturedAt.delete(r.readingId);
          // Kept in memory even when the watermark cannot be written, so the next batch starts after it.
          await this.serverHoldsUpTo(BigInt(last.seq));
          this.notifyAcks();
        }
      }
      if (res.refused) {
        this.lastRefusal = res.refused;
        this.refusedAtUs = this.options.clock.monoUs();
        this.alarm({ kind: 'READING_REFUSED', message: `the server refused reading ${res.refused.readingId}: ${res.refused.code} ${res.refused.message}`, details: res.refused });
        return;
      }
      if (res.results.length < batch.length) return;
    }
  }

  async heartbeat(): Promise<void> {
    if (!(await this.ensureLogin())) return;
    const journal = this.options.journal;
    const body: HeartbeatRequest = {
      ...this.options.heartbeatBody(),
      gatewayTimeUs: this.options.clock.wallUs().toString(),
      journal: { lastSeq: journal.lastSeq().toString(), ackedSeq: journal.ackedSeq.toString(), deliveredSeq: this.deliveredSeq().toString() },
    };
    let res: HeartbeatResponse;
    try {
      res = await this.post('/gw/v1/heartbeat', body, HeartbeatResponse, this.token);
    } catch (error) {
      if (error instanceof UplinkError && error.relogin) {
        this.dropToken();
        void this.ensureLogin();
      }
      return;
    }
    // Reconciliation by counts (DI-31): the server holds fewer readings than acknowledged (e.g. restored from a
    // backup): the watermark moves back to its head (a head that is not a reading of this journal diverges it) and
    // the journal sends the rest again. When the watermark cannot be moved, the server's head is kept in memory.
    const delivered = this.deliveredSeq();
    if (this.login && journal.chainId === this.login.chainId && BigInt(res.head.seq) < delivered) {
      this.alarm({ kind: 'UPLINK_FAILED', message: `the server holds readings up to ${res.head.seq}, fewer than the ${delivered.toString()} it acknowledged; sending them again`, details: { serverSeq: res.head.seq } });
      const s = BigInt(res.head.seq);
      const ours = s === 0n ? genesisHash(journal.chainId) : journal.all()[Number(s) - 1]?.hash;
      if (ours === res.head.hash) await this.serverHoldsUpTo(s);
      else await journal.adoptServerChain(this.login.chainId, res.head);
    }
    if (this.undelivered().length > 0 || this.serverHolds !== null) void this.flush();
  }
}

/** A fresh API token (32 random bytes, base64url). */
export function newApiToken(): string {
  return randomBytes(32).toString('base64url');
}
