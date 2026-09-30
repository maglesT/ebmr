/**
 * Process state of the devices feature, shared by the browser routes and the gateway listener of one server:
 *  - the API token each gateway handed over at its last login (the server presents it to the gateway API; the
 *    server never holds the gateway's own credential);
 *  - ingestion notices, so a capture can answer as soon as its reading row exists;
 *  - whether the server reaches each gateway's API, recorded in the database (tab.record_gateway_api_contact,
 *    tablets 0320; review finding P51): a capture that cannot reach it marks the gateway's scales OFFLINE there, so
 *    the manual two-person path opens once the mark has stood for 10 seconds (tablets 0340); while it is so marked,
 *    each heartbeat of the gateway has the server probe GET /v1/health with its API token, and an answer marks it
 *    reachable again;
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
import { identity, type ActorContext } from '@ebmr/kernel';
import { CaptureResponse, GatewayHealth, LiveSample, type CaptureRequest } from '@ebmr/integration-sdk/scale';
import type { AppContext } from '../../platform/context.ts';
import { withActorCommand } from '../../platform/db/commands.ts';

export interface GatewayLink {
  gatewayCode: string;
  apiToken: string;
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

export class DevicesRuntime {
  readonly links = new Map<string, GatewayLink>();
  readonly ingested = new EventEmitter();
  readonly live: LiveHub;
  private readonly probing = new Map<string, Promise<void>>();
  private monitor: Promise<(ActorContext & { deviceId: string }) | null> | null = null;
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
   * command of the gateway API monitor (tablets 0340). A command that fails (a lapsed or locked session) is tried once
   * more with a new session. Never rejects: a failure to record leaves the database's last state, which the next
   * contact or probe records again.
   */
  async recordApiContact(gatewayCode: string, reachable: boolean, detail: string): Promise<void> {
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
  }

  /**
   * Checks that the gateway's API answers GET /v1/health for this server's API token and names this gateway, and
   * records the outcome (one probe per gateway at a time). The database asks for it (tab.record_heartbeat probeApi)
   * while it counts the API unreachable: a capture is refused while the scale is OFFLINE, so it cannot show recovery.
   */
  probeApi(gatewayCode: string): Promise<void> {
    const running = this.probing.get(gatewayCode);
    if (running) return running;
    const probe = (async () => {
      const problem = await this.healthProblem(gatewayCode);
      await this.recordApiContact(gatewayCode, problem === null, problem ?? 'GET /v1/health answered for this server');
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
