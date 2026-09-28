/**
 * The uplink to the server's gateway listener (DI-28, DI-31):
 *  - login: a fresh nonce, an Ed25519 proof over it with the gateway key, the SERVICE_KEY of the gateway's
 *    INTEGRATION identity, and the API token the server will present to this gateway; the answer names the chain
 *    (enrolment) and the server's head, which the journal adopts;
 *  - flush: unacknowledged readings in sequence, in batches, idempotent by reading id; the watermark moves only on
 *    the server's acknowledgement; a refusal stops the flush and is alarmed; failures back off;
 *  - heartbeat every few seconds with the instruments' states (a gap over 10 s shows the scale OFFLINE).
 */
import { randomBytes, sign } from 'node:crypto';
import {
  GatewayWireError,
  HeartbeatResponse,
  LoginResponse,
  NonceResponse,
  UplinkResponse,
  loginProofMessage,
  type HeartbeatRequest,
  type ScaleReading,
} from '@ebmr/integration-sdk/scale';
import type { GatewayClock } from './clock.ts';
import type { GatewayConfig } from './config.ts';
import type { Journal } from './journal.ts';

export interface UplinkAlarm {
  kind: 'LOGIN_FAILED' | 'READING_REFUSED' | 'INSTALLATION_MISMATCH' | 'UPLINK_FAILED';
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
  lastRefusal: { readingId: string; code: string; message: string } | null = null;
  private refusedAtUs: bigint | null = null;

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
    let json: unknown = null;
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
    const outcome = await journal.adoptServerChain(login.chainId, login.head);
    this.token = login.token;
    this.login = login;
    this.options.log?.(`logged in to ${this.base} (chain ${login.chainId}, server head ${login.head.seq}, journal ${outcome})`);
    this.options.onLogin?.(login);
    return login;
  }

  /** Starts login retries and the heartbeat loop. */
  start(): void {
    this.stopped = false;
    void this.ensureLogin();
    this.heartbeatTimer = setInterval(() => void this.heartbeat().catch(() => undefined), this.options.config.heartbeatMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const w of this.ackWaiters) w.resolve(false);
    this.ackWaiters.clear();
    await this.flushing?.catch(() => undefined);
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
    if (this.options.journal.ackedSeq >= seq) return Promise.resolve(true);
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
    for (const w of [...this.ackWaiters]) if (this.options.journal.ackedSeq >= w.seq) w.resolve(true);
  }

  /** Sends unacknowledged readings in order (single flight; a call during a flight runs one more pass). */
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

  private async flushOnce(): Promise<void> {
    const journal = this.options.journal;
    if (!journal.usable || !journal.chainId) return;
    if (!(await this.ensureLogin())) return;
    for (;;) {
      const batch = journal.pending().slice(0, 50);
      if (batch.length === 0) return;
      // A refused reading is offered again only after 30 s (the alarm is already raised; no alarm storm).
      if (this.lastRefusal?.readingId === batch[0]?.readingId && this.refusedAtUs !== null && this.options.clock.monoUs() - this.refusedAtUs < 30_000_000n) return;
      let res: UplinkResponse;
      try {
        res = await this.post('/gw/v1/readings', { items: batch.map((reading) => ({ reading, delayUs: this.delayOf(reading) })) }, UplinkResponse, this.token);
      } catch (error) {
        if (error instanceof UplinkError && error.relogin) this.dropToken();
        this.alarm({ kind: 'UPLINK_FAILED', message: `readings not uploaded: ${error instanceof Error ? error.message : String(error)}`, details: {} });
        return;
      }
      const last = res.results.at(-1);
      if (last) {
        const reading = batch.find((r) => r.readingId === last.readingId);
        if (reading && reading.seq === last.seq) {
          await journal.acknowledge(BigInt(last.seq), reading.hash);
          for (const r of res.results) this.options.capturedAt.delete(r.readingId);
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
      journal: { lastSeq: journal.lastSeq().toString(), ackedSeq: journal.ackedSeq.toString() },
    };
    try {
      await this.post('/gw/v1/heartbeat', body, HeartbeatResponse, this.token);
    } catch (error) {
      if (error instanceof UplinkError && error.relogin) {
        this.dropToken();
        void this.ensureLogin();
      }
      return;
    }
    if (journal.pending().length > 0) void this.flush();
  }
}

/** A fresh API token (32 random bytes, base64url). */
export function newApiToken(): string {
  return randomBytes(32).toString('base64url');
}
