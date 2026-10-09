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
 *    soon as it can be (review finding P52). The watermark is written beside the uploads, one write at a time (the
 *    last one writes what the server holds by then): the next batch is sent without waiting for the write, so a
 *    reading queued behind another one never waits for the gateway's disk. A flush settles once its uploads have
 *    ended and the watermark writes they started have finished (written, or failed and alarmed). What the server
 *    holds is recorded on the journal's basis when the request went out (its chain, and the logins' adoptions of the
 *    server's head asked for by then): an answer that arrives once a login has asked for its adoption is dropped, and
 *    the journal drops, under its lock, a write whose basis a login has since replaced, so a write that waited behind a
 *    hung one never overtakes the login, and is not a failure (decision X33). Each batch first takes a challenge the
 *    server's database issues; each reading's wait is measured after it arrives and signed with the gateway key
 *    together with the challenge and the reading id, so the database counts everything after the signing itself
 *    (DI-28, review finding P53);
 *  - waitForAck, a capture waiting for its reading: true once the server has acknowledged the reading (an upload's
 *    answer, or a login whose head covers it), false when it has not within the capture's wait. The answer comes
 *    once the watermark write that records the acknowledgement has finished, but never after the wait ends: a disk
 *    slower than that neither turns an acknowledged reading into false nor holds the answer longer (decision X28);
 *  - heartbeat every few seconds with the instruments' states and the reason a connected one is not ready (a gap
 *    over 10 s shows the scale OFFLINE), and at once when the gateway's ability to deliver changes, at most one such
 *    heartbeat per READINESS_HEARTBEAT_GAP_MS (a flapping state is reported, not flooded). The heartbeat's journal
 *    counts carry what the server acknowledged (deliveredSeq) beside the written watermark (ackedSeq), which stays
 *    behind while it cannot be written, so the server's reconciliation by counts (DI-31) is not blind then. A login
 *    under way never holds a heartbeat up once the gateway has had a session: while a new login gets no answer (the
 *    server can hold it up in its database), heartbeats go on with the last login's token, which the server still
 *    receives though it no longer records them, so it does not take the gateway for silent; a login the server refuses,
 *    or that fails here, ends that (review P50, decision X31). One login at a time.
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
import type { Journal, WatermarkBasis } from './journal.ts';

/** The shortest time between two heartbeats sent because readiness changed (review finding P51). */
export const READINESS_HEARTBEAT_GAP_MS = 500;

const noop = (): void => undefined;

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

/** A capture waiting to learn whether the server holds its reading (Uplink.waitForAck). */
interface AckWaiter {
  chainId: string | null;
  seq: bigint;
  /** The server holds the reading: answer true once `written` has settled, or when the wait ends. */
  acknowledged: (written: Promise<void>) => void;
  /** Answer now: true if the server acknowledged the reading, false if not. */
  finish: () => void;
}

export class Uplink {
  token: string | null = null;
  /**
   * The token of the last login, kept after the server asks for a new login until a login succeeds, is refused or
   * fails here: heartbeats go out with it meanwhile (heartbeat; review P50, decision X31).
   */
  private lastToken: string | null = null;
  /** The login under way (ensureLogin), if any. */
  private loggingIn: Promise<boolean> | null = null;
  login: LoginResponse | null = null;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  /** The watermark write in progress (one at a time), and whether another one is to follow it. */
  private watermarkWriting: Promise<void> | null = null;
  private watermarkAgain = false;
  private stopped = false;
  private loginBackoff = 500;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly ackWaiters = new Set<AckWaiter>();
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
   * watermark could not be written, or its write is under way), with the journal's basis when the server was asked
   * (its chain; a login's adoption since makes it stale); null while the watermark is the truth.
   */
  private serverHolds: { basis: WatermarkBasis; seq: bigint } | null = null;
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

  /**
   * Logs in and adopts the server's chain. Throws on refusal. A login the server refused, or that failed here (e.g. the
   * watermark could not be written), ends the heartbeats with the previous session's token (lastToken); one that got
   * no answer from the server does not (heartbeat).
   */
  async logIn(): Promise<LoginResponse> {
    try {
      const login = await this.logInOnce();
      this.lastToken = login.token;
      return login;
    } catch (error) {
      if (!(error instanceof UplinkError && error.status === 0)) this.lastToken = null;
      throw error;
    }
  }

  private async logInOnce(): Promise<LoginResponse> {
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
    // A head that is a reading of this journal's chain says the server holds it and every one before it (an upload's
    // answer may have been lost): the captures waiting for those readings are told at once, not after the write below.
    const head = BigInt(login.head.seq);
    const covers = journal.chainId === login.chainId && head > 0n && journal.all()[Number(head) - 1]?.hash === login.head.hash;
    // The server's head is written as the watermark here; if that write fails the login fails (no heartbeat).
    const adopting = journal.adoptServerChain(login.chainId, login.head);
    if (covers) this.notifyAcks(login.chainId, head, adopting.then(noop, noop));
    const outcome = await adopting;
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
    for (const w of [...this.ackWaiters]) w.finish();
    await this.flushing?.catch(() => undefined);
    await this.watermarkWriting?.catch(() => undefined);
    await this.heartbeating?.catch(() => undefined);
    // A heartbeat no longer waits for a login under way (heartbeat), so the login is waited for here, as it was.
    await this.loggingIn;
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

  /** Logs in unless logged in, one login at a time (a call during one gets its outcome). Never rejects. */
  private ensureLogin(): Promise<boolean> {
    if (this.token) return Promise.resolve(true);
    this.loggingIn ??= this.tryLogin().finally(() => {
      this.loggingIn = null;
    });
    return this.loggingIn;
  }

  private async tryLogin(): Promise<boolean> {
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

  /**
   * Whether the server holds reading `seq` of chain `chainId` (the current chain unless named), answered at most `ms`
   * after the call. True once the server has acknowledged it (an upload's answer, or a login whose head covers it);
   * the answer then waits for the watermark write that records the acknowledgement to finish (written, or failed and
   * alarmed), but only until `ms` has passed: a slower disk makes it answer true before the watermark is on disk. False
   * when the server has not acknowledged it within `ms` (or the uplink stops first). The uploads never wait for a
   * watermark write (deliver), so the disk is not inside the wait for the server's answer; a new login during the wait
   * is, since the login writes the watermark before anything is uploaded (P51).
   */
  waitForAck(seq: bigint, ms: number, chainId: string | null = this.options.journal.chainId): Promise<boolean> {
    if (chainId !== null && chainId === this.options.journal.chainId && this.deliveredSeq() >= seq) return Promise.resolve(true);
    return new Promise((resolve) => {
      let acked = false;
      const finish = () => {
        clearTimeout(timer);
        this.ackWaiters.delete(waiter);
        resolve(acked);
      };
      const waiter: AckWaiter = {
        chainId,
        seq,
        acknowledged: (written) => {
          if (acked) return;
          acked = true;
          void written.then(finish, finish);
        },
        finish,
      };
      const timer = setTimeout(finish, ms);
      this.ackWaiters.add(waiter);
    });
  }

  /**
   * The server holds reading `seq` of chain `chainId` and every one before it: the captures waiting for those readings
   * answer true once `written` (the watermark write that records it) has settled, or when their wait ends.
   */
  private notifyAcks(chainId: string, seq: bigint, written: Promise<void>): void {
    for (const w of [...this.ackWaiters]) if (w.chainId === chainId && w.seq <= seq) w.acknowledged(written);
  }

  /** The last reading of the current chain the server holds, as it last said (the watermark unless that is behind). */
  deliveredSeq(): bigint {
    const held = this.serverHolds;
    const journal = this.options.journal;
    return held !== null && held.basis.chainId === journal.chainId ? held.seq : journal.ackedSeq;
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

  /**
   * The server holds the chain up to `seq` (its acknowledgement, or its head), as it said when asked on `basis` (the
   * journal's basis when the request went out, so the chain of the readings it was about): remember it
   * (deliveredSeq), start the watermark write and tell the captures waiting for these readings (they answer once the
   * write has settled, or when their wait ends). Resolves when the write has settled; never rejects. An answer that
   * arrives after a login's adoption of the server's head was asked for, to a request sent before it, is dropped here:
   * nothing is remembered, written or answered for it, so the next batch starts after the login's head, not after what
   * the server said before the login (decision X33).
   */
  private serverHoldsUpTo(basis: WatermarkBasis | null, seq: bigint): Promise<void> {
    if (basis === null || !this.options.journal.isCurrent(basis)) return Promise.resolve();
    this.serverHolds = { basis, seq };
    const written = this.recordWatermark();
    this.notifyAcks(basis.chainId, seq, written);
    return written;
  }

  /**
   * Writes the watermark to what the server holds, one write at a time: a request during a write runs one more after
   * it, which writes what the server holds by then. Resolves once a write that began after this call has settled
   * (written, or failed and alarmed); never rejects.
   */
  private recordWatermark(): Promise<void> {
    if (this.watermarkWriting) {
      this.watermarkAgain = true;
      return this.watermarkWriting;
    }
    this.watermarkWriting = (async () => {
      try {
        do {
          this.watermarkAgain = false;
          await this.writeWatermark();
        } while (this.watermarkAgain);
      } finally {
        this.watermarkWriting = null;
      }
    })();
    return this.watermarkWriting;
  }

  /**
   * Writes the watermark to what the server holds. A failure keeps it in memory (deliveredSeq), is alarmed once and
   * makes the gateway not ready; the next flush tries again. What the server said before a login's adoption was asked
   * for (a write that waited behind a hung one, say) is stale by the time the journal takes it: it is dropped, not
   * written and not a failure, and a failure recorded before it stands; the login writes the server's head and resets
   * what is known once that write succeeds (decision X33). Never rejects.
   */
  private async writeWatermark(): Promise<void> {
    const journal = this.options.journal;
    const held = this.serverHolds;
    if (held === null) return;
    if (held.basis.chainId !== journal.chainId || held.seq === journal.ackedSeq) {
      this.serverHolds = null;
      this.setWatermarkFailure(null, journal.ackedSeq);
      return;
    }
    const hash = held.seq === 0n ? genesisHash(held.basis.chainId) : journal.all()[Number(held.seq) - 1]?.hash;
    let outcome: 'ACKNOWLEDGED' | 'CONTINUE' | 'DIVERGED' | 'STALE';
    try {
      if (hash === undefined) throw new Error(`the journal holds no reading ${held.seq.toString()}`);
      // The journal checks the basis under its lock, where the write is made: the check above is only a shortcut.
      if (held.seq > journal.ackedSeq) outcome = await journal.acknowledge(held.basis, held.seq, hash);
      else outcome = await journal.reconcile(held.basis, { seq: held.seq.toString(), hash });
    } catch (error) {
      this.setWatermarkFailure(error instanceof Error ? error.message : String(error), held.seq);
      return;
    }
    if (this.serverHolds === held) this.serverHolds = null;
    if (outcome !== 'STALE') this.setWatermarkFailure(null, held.seq);
  }

  /**
   * Sends the readings the server does not hold, in order (single flight; a call during a flight runs one more pass),
   * and writes the watermark if it is behind. Settles once the uploads have ended and the watermark writes they started
   * have settled; the next pass does not wait for those writes. Never rejects: a failure is alarmed, and what is not
   * delivered or not recorded is tried again in the next pass.
   */
  flush(): Promise<void> {
    return this.send().then(() => this.watermarkWriting ?? undefined);
  }

  /** The uploads of flush(), single flight. Never rejects. */
  private send(): Promise<void> {
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
    // A watermark left behind (its write failed) is written again, beside the uploads (P52).
    if (this.serverHolds !== null) void this.recordWatermark();
    for (;;) {
      // The basis of what the server's answer will say: taken with the batch, so it names the batch's chain.
      const basis = journal.basis();
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
          // Kept in memory even when the watermark cannot be written, so the next batch starts after it. The next batch
          // does not wait for the watermark write: a reading queued behind these is not held up by the disk.
          void this.serverHoldsUpTo(basis, BigInt(last.seq));
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
    // DI-30, PR-20 (review P50, decision X31): a login under way never holds up a heartbeat once this gateway has had a
    // session. The server can hold a login up in its database (the gateway account's row, which any command of that
    // account keeps), while the gateway must log in again after a server restart or when its session ends. Until the
    // login succeeds, the heartbeat goes out with the last login's token: the server still receives it (a receipt
    // counts whatever the session's state, tablets 0350), so the gateway is not taken for silent meanwhile. A login the
    // server refused, or that failed here, ends that (lastToken), so a gateway that cannot deliver still falls silent
    // (P51). Before its first login the heartbeat waits for it.
    const loggingIn = this.ensureLogin();
    if (this.token === null && this.lastToken === null && !(await loggingIn)) return;
    const token = this.token ?? this.lastToken;
    if (token === null) return;
    const journal = this.options.journal;
    // The basis of what the server's answer will say (its head), taken before the request goes out.
    const basis = journal.basis();
    const body: HeartbeatRequest = {
      ...this.options.heartbeatBody(),
      gatewayTimeUs: this.options.clock.wallUs().toString(),
      journal: { lastSeq: journal.lastSeq().toString(), ackedSeq: journal.ackedSeq.toString(), deliveredSeq: this.deliveredSeq().toString() },
    };
    let res: HeartbeatResponse;
    try {
      res = await this.post('/gw/v1/heartbeat', body, HeartbeatResponse, token);
    } catch (error) {
      // Only the current session's token is dropped; an answer to a heartbeat sent with an older one changes nothing.
      if (error instanceof UplinkError && error.relogin && this.token === token) {
        this.dropToken();
        void this.ensureLogin();
      }
      return;
    }
    // Reconciliation by counts (DI-31): the server holds fewer readings than acknowledged (e.g. restored from a
    // backup): the watermark moves back to its head (a head that is not a reading of this journal diverges it) and
    // the journal sends the rest again. When the watermark cannot be moved, the server's head is kept in memory. Both
    // rest on the basis taken before the request: a login whose adoption of the server's head was asked for meanwhile
    // (or another chain) makes them stale, and they are dropped (serverHoldsUpTo, or the journal under its lock; X33).
    const delivered = this.deliveredSeq();
    if (basis !== null && this.login && journal.chainId === this.login.chainId && BigInt(res.head.seq) < delivered) {
      this.alarm({ kind: 'UPLINK_FAILED', message: `the server holds readings up to ${res.head.seq}, fewer than the ${delivered.toString()} it acknowledged; sending them again`, details: { serverSeq: res.head.seq } });
      const s = BigInt(res.head.seq);
      const ours = s === 0n ? genesisHash(journal.chainId) : journal.all()[Number(s) - 1]?.hash;
      if (ours === res.head.hash) await this.serverHoldsUpTo(basis, s);
      else await journal.reconcile(basis, res.head);
    }
    if (this.undelivered().length > 0 || this.serverHolds !== null) void this.flush();
  }
}

/** A fresh API token (32 random bytes, base64url). */
export function newApiToken(): string {
  return randomBytes(32).toString('base64url');
}
