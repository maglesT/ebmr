/**
 * Gateway test support: the scale simulator as a child process (the gateway never imports another app), a fake
 * server listener that checks readings exactly as the real one does (signature, hash, sequence, links) but keeps
 * them in memory, and a gateway configuration in a temporary directory.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HeartbeatRequest,
  LoginRequest,
  UplinkRequest,
  ed25519PublicKey,
  genesisHash,
  interpretWeightLine,
  loginProofMessage,
  readingProblem,
  uploadWaitMessage,
  type LoginResponse,
  type ScaleReading,
  type UplinkItem,
} from '@ebmr/integration-sdk/scale';
import { parseGatewayConfig, type GatewayConfig } from '../src/config.ts';

const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export interface SimProcess {
  tcpPort: number;
  httpPort: number;
  control(action: string, body?: Record<string, unknown>): Promise<unknown>;
  stop(): Promise<void>;
}

/** Starts apps/simulators/src/scale/main.ts (or another simulator entry, e.g. src/process/main.ts) on ephemeral loopback ports. */
export function startSimulator(env: Record<string, string> = {}, main = 'apps/simulators/src/scale/main.ts'): Promise<SimProcess> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', join(REPO, main)], {
      cwd: REPO,
      env: { ...process.env, EBMR_SIM_TCP: '127.0.0.1:0', EBMR_SIM_HTTP: '127.0.0.1:0', EBMR_SIM_SERIAL: 'SIM-0001', EBMR_SIM_SEED: '42', EBMR_SIM_SETTLE_MS: '300', EBMR_SIM_STABILITY_TIMEOUT_MS: '600', EBMR_SIM_SLOW_MS: '3000', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`simulator did not start: ${out}`)), 20_000);
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
      const m = /tcp port (\d+), console on http port (\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        const httpPort = Number(m[2]);
        resolvePromise({
          tcpPort: Number(m[1]),
          httpPort,
          async control(action, body = {}) {
            const res = await fetch(`http://127.0.0.1:${httpPort}/api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            return res.json();
          },
          stop: () =>
            new Promise<void>((r) => {
              if (child.exitCode !== null) return r();
              child.once('exit', () => r());
              child.kill('SIGTERM');
            }),
        });
      }
    });
    child.stderr?.on('data', (c: Buffer) => (out += c.toString()));
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (!/tcp port/.test(out)) reject(new Error(`simulator exited (${String(code)}): ${out}`));
    });
  });
}

export function gatewayKeys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKeyPkcs8: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKeySpki: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ebmr-gw-test-'));
}

export function configFor(opts: { simPort: number; uplink: string; journalDir: string; keys: ReturnType<typeof gatewayKeys>; captureTimeoutMs?: number; serial?: string }): GatewayConfig {
  return parseGatewayConfig(
    {
      gatewayCode: 'TEST-GW-01',
      installation: 'SANDBOX',
      listen: '127.0.0.1:0',
      uplink: opts.uplink,
      keyFile: 'unused',
      serviceKeysFile: 'unused',
      journalDir: opts.journalDir,
      devices: [{ code: 'TEST-BAL-01', driver: 'mt-sics', host: '127.0.0.1', port: opts.simPort, expectedSerial: opts.serial ?? 'SIM-0001', resolution: '0.001', unit: 'kg', room: 'DISP-1' }],
      heartbeatMs: 500,
      captureTimeoutMs: opts.captureTimeoutMs ?? 3000,
      livePollMs: 250,
    },
    JSON.stringify(opts.keys),
    JSON.stringify({ services: [{ terminal: 'TEST-GW-01', loginName: 'test-gw', serviceKey: 'gw-secret' }] }),
  );
}

/**
 * The server side of the uplink, in memory: one chain per "enrolment", readings accepted only in sequence with a
 * valid link, hash, signature and raw line; duplicates by reading id are idempotent. Every upload names a challenge
 * this server issued, and every known wait must carry the gateway's signature over challenge, reading id and wait
 * (DI-28, as tab.ingest_reading checks it: EBMR-DEV-053, -054, -055).
 */
export class FakeServer {
  readonly readings: ScaleReading[] = [];
  readonly refused: { readingId: string; code: string }[] = [];
  readonly heartbeats: HeartbeatRequest[] = [];
  readonly apiTokens: string[] = [];
  chainId = randomUUID();
  installation: 'GMP' | 'SANDBOX' = 'SANDBOX';
  instruments: LoginResponse['instruments'] = [{ deviceCode: 'TEST-BAL-01', serial: 'SIM-0001', unit: 'kg', resolution: '0.001', roomCode: 'DISP-1' }];
  /** Reject uploads (the listener is down) while true. */
  down = false;
  /** Refuse a new reading with the code this returns (a refusal the real listener would give, e.g. EBMR-DEV-048). */
  refuse: ((reading: ScaleReading) => string | null) | null = null;
  /** Answer uploads 500 while login and heartbeats still work (e.g. the ingest path is broken) while true. */
  uploadsDown = false;
  /** Readings received in upload requests, duplicates included (how much the gateway sent). */
  itemsReceived = 0;
  /** Answer a challenge request only after this many milliseconds (a slow server). */
  challengeDelayMs = 0;
  /** While set, a challenge request is answered only once this has settled (the test decides when). */
  challengeGate: Promise<void> | null = null;
  /** While true, the readings of an upload are stored but its answer is lost (the connection is cut instead). */
  loseUploadAnswers = false;
  /** While set, an upload takes at most this many of its readings (answered for those, nothing refused); the rest wait. */
  uploadTakes: number | null = null;
  /** While set, the readings of an upload are stored at once but the answer is sent only once this has settled. */
  uploadAnswerGate: Promise<void> | null = null;
  /** While set, a heartbeat is recorded and its answer (the head as it was then) sent only once this has settled. */
  heartbeatGate: Promise<void> | null = null;
  /** While set, a login (POST /gw/v1/session) is answered only once this has settled (held up in the server's database). */
  loginGate: Promise<void> | null = null;
  /** While true, a login's connection is cut before any answer (the gateway gets no answer). */
  cutLogins = false;
  /** While true, every login is refused (401 AUTH). */
  refuseLogins = false;
  /**
   * Routes this fake does not know (e.g. the process uplink, Phase 3 slice 3a): asked with the method, path, body,
   * whether the bearer token is a live session, and the request; null falls through to 404.
   */
  extra: ((method: string, path: string, body: unknown, live: boolean, req: IncomingMessage) => Promise<{ status: number; body: unknown } | null> | { status: number; body: unknown } | null) | null = null;
  /** Every heartbeat that reached the server, accepted or not: the SHA-256 of its token and when (performance.now()). */
  readonly heartbeatsReceived: { tokenHash: string; at: number }[] = [];
  /** The challenges issued (id to the time of issue, performance.now()). */
  readonly challenges = new Map<string, number>();
  /** Every upload item accepted by the schema, with the challenge of its upload and when the upload arrived. */
  readonly items: (UplinkItem & { challengeId: string; arrivedAt: number })[] = [];
  private tokens = new Set<string>();
  private nonces = new Set<string>();
  private server: Server | null = null;
  url = '';

  constructor(private readonly spki: string) {}

  head(): { seq: string; hash: string } {
    const last = this.readings.at(-1);
    return last ? { seq: last.seq, hash: last.hash } : { seq: '0', hash: genesisHash(this.chainId) };
  }

  /** The server ends every gateway session (e.g. it restarted): each token is then answered 401 SESSION, log in again. */
  endSessions(): void {
    this.tokens.clear();
  }

  /** The server is restored from a backup that holds the readings of its chain up to `seq` only. */
  restoreTo(seq: number): void {
    this.readings.length = Math.min(seq, this.readings.length);
  }

  /** A new enrolment: a new chain id, empty. */
  reenrol(): void {
    this.chainId = randomUUID();
    this.readings.length = 0;
    this.tokens.clear();
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', () => r()));
    const a = this.server.address();
    this.url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (this.down) return this.send(res, 503, { error: { code: 'DOWN', message: 'down', relogin: false } });
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const hash = createHash('sha256').update(bearer).digest('hex');
    switch (req.url) {
      case '/gw/v1/nonce': {
        const nonce = randomBytes(24).toString('base64url');
        this.nonces.add(nonce);
        return this.send(res, 200, { nonce });
      }
      case '/gw/v1/session': {
        if (this.refuseLogins) return this.send(res, 401, { error: { code: 'AUTH', message: 'refused', relogin: false } });
        if (this.cutLogins) {
          req.socket.destroy();
          return;
        }
        if (this.loginGate) await this.loginGate;
        const p = LoginRequest.safeParse(body);
        if (!p.success || !this.nonces.delete(p.data.nonce) || p.data.spki !== this.spki) return this.send(res, 401, { error: { code: 'AUTH', message: 'refused', relogin: false } });
        if (!verify(null, loginProofMessage(p.data.nonce, p.data.gatewayCode, p.data.loginName, p.data.spki), ed25519PublicKey(this.spki), Buffer.from(p.data.sig, 'base64'))) {
          return this.send(res, 401, { error: { code: 'KEY_PROOF', message: 'refused', relogin: false } });
        }
        const token = randomBytes(32).toString('base64url');
        this.tokens.add(createHash('sha256').update(token).digest('hex'));
        this.apiTokens.push(p.data.apiToken);
        const login: LoginResponse = {
          token,
          chainId: this.chainId,
          head: this.head(),
          installation: this.installation,
          serverTimeUs: '1790584618000000',
          instruments: this.instruments,
        };
        return this.send(res, 200, login);
      }
      case '/gw/v1/challenge': {
        if (!this.tokens.has(hash)) return this.send(res, 401, { error: { code: 'SESSION', message: 'log in', relogin: true } });
        if (this.challengeDelayMs > 0) await new Promise((r) => setTimeout(r, this.challengeDelayMs));
        if (this.challengeGate) await this.challengeGate;
        const challengeId = randomUUID();
        this.challenges.set(challengeId, performance.now());
        return this.send(res, 200, { challengeId });
      }
      case '/gw/v1/readings': {
        if (!this.tokens.has(hash)) return this.send(res, 401, { error: { code: 'SESSION', message: 'log in', relogin: true } });
        if (this.uploadsDown) return this.send(res, 500, { error: { code: 'INTERNAL', message: 'the readings could not be stored', relogin: false } });
        const p = UplinkRequest.safeParse(body);
        if (!p.success) return this.send(res, 400, { error: { code: 'SCHEMA', message: 'bad', relogin: false } });
        this.itemsReceived += p.data.items.length;
        const arrivedAt = performance.now();
        for (const item of p.data.items) this.items.push({ ...item, challengeId: p.data.challengeId, arrivedAt });
        const results: { readingId: string; seq: string; outcome: 'INGESTED' | 'DUPLICATE' }[] = [];
        let refused: { readingId: string; code: string; message: string } | null = null;
        for (const { reading, delayUs, waitSig } of p.data.items) {
          if (this.uploadTakes !== null && results.length >= this.uploadTakes) break;
          const waitCode =
            delayUs === null
              ? null
              : waitSig === null
                ? 'EBMR-DEV-053'
                : !this.challenges.has(p.data.challengeId)
                  ? 'EBMR-DEV-054'
                  : !verify(null, uploadWaitMessage(p.data.challengeId, reading.readingId, delayUs), ed25519PublicKey(this.spki), Buffer.from(waitSig, 'base64'))
                    ? 'EBMR-DEV-055'
                    : null;
          if (waitCode) {
            refused = { readingId: reading.readingId, code: waitCode, message: waitCode };
            this.refused.push({ readingId: reading.readingId, code: waitCode });
            break;
          }
          const existing = this.readings.find((r) => r.readingId === reading.readingId);
          if (existing) {
            if (existing.hash !== reading.hash) {
              refused = { readingId: reading.readingId, code: 'CONFLICT', message: 'different content' };
              break;
            }
            results.push({ readingId: reading.readingId, seq: reading.seq, outcome: 'DUPLICATE' });
            continue;
          }
          const head = this.head();
          const problem = readingProblem(reading, ed25519PublicKey(this.spki));
          const raw = interpretWeightLine(reading.raw);
          const code =
            this.refuse?.(reading) ??
            (problem
              ? problem.problem
              : reading.chainId !== this.chainId
                ? 'CHAIN'
                : BigInt(reading.seq) !== BigInt(head.seq) + 1n || reading.prevHash !== head.hash
                  ? 'SEQUENCE'
                  : raw.value !== reading.value || raw.status !== reading.status
                    ? 'RAW'
                    : null);
          if (code) {
            refused = { readingId: reading.readingId, code, message: code };
            this.refused.push({ readingId: reading.readingId, code });
            break;
          }
          this.readings.push(reading);
          results.push({ readingId: reading.readingId, seq: reading.seq, outcome: 'INGESTED' });
        }
        if (this.loseUploadAnswers) {
          req.socket.destroy();
          return;
        }
        const uploadHead = this.head();
        if (this.uploadAnswerGate) await this.uploadAnswerGate;
        return this.send(res, 200, { results, head: uploadHead, refused });
      }
      case '/gw/v1/heartbeat': {
        this.heartbeatsReceived.push({ tokenHash: hash, at: performance.now() });
        if (!this.tokens.has(hash)) return this.send(res, 401, { error: { code: 'SESSION', message: 'log in', relogin: true } });
        this.heartbeats.push(HeartbeatRequest.parse(body));
        const heartbeatHead = this.head();
        if (this.heartbeatGate) await this.heartbeatGate;
        return this.send(res, 200, { serverTimeUs: '1790584618000000', head: heartbeatHead });
      }
      default: {
        const answer = this.extra ? await this.extra(req.method ?? 'GET', req.url ?? '/', body, this.tokens.has(hash), req) : null;
        if (answer) return this.send(res, answer.status, answer.body);
        return this.send(res, 404, { error: { code: 'NOT_FOUND', message: 'not found', relogin: false } });
      }
    }
  }
}

export async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const start = performance.now();
  while (!(await predicate())) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
