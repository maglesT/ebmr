/**
 * Process state of the devices feature, shared by the browser routes and the gateway listener of one server:
 *  - the API token each gateway handed over at its last login (the server presents it to the gateway API; the
 *    server never holds the gateway's own credential);
 *  - ingestion notices, so a capture can answer as soon as its reading row exists;
 *  - the live-display hub: one upstream SSE per scale, fanned out to the browsers watching it (display only).
 */
import { EventEmitter } from 'node:events';
import { CaptureResponse, LiveSample, type CaptureRequest } from '@ebmr/integration-sdk/scale';
import type { AppContext } from '../../platform/context.ts';

export interface GatewayLink {
  gatewayCode: string;
  apiToken: string;
}

export class DevicesRuntime {
  readonly links = new Map<string, GatewayLink>();
  readonly ingested = new EventEmitter();
  readonly live: LiveHub;

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
