/**
 * The OPC UA equipment simulator (Phase 6 slice 6b, builder A; plan "Slice 6b", "Gateway and simulator"; D-P6b-1,
 * D-P6b-2): one OPC UA server (node-opcua) publishing the units of a Tablets line under the eBMR's tag map
 * (`urn:ebmr:process:tags:v1`, node ids from the released tag names: integration-sdk systems/opcua.ts), with
 * SignAndEncrypt endpoints only (Basic256Sha256, Aes128_Sha256_RsaOaep, Aes256_Sha256_RsaPss). Each unit's values come
 * from the process model of the JSON-lines simulators (../process/model.ts), so both stand-ins tell the same story.
 *
 * Address space per unit (code, kind): `<code>/<tag>` the measured value of every tag of the kind (Double; counters
 * UInt32) with its source timestamp and status; `<code>/<tag>/setpoint` for the setpoint tags (Double, writable; the
 * model refuses what a controller would); `<code>/recipe.version` (String); `<code>/_alarms/active` (String, the limit
 * alarms active now as `CODE|tag;...`); `<code>/_events` (String, one JSON value per alarm transition or equipment event,
 * D-P6b-A-3). And `_endpoint/location`: the room or line the server reports (DI-20).
 *
 * Faults (POST /api/fault {fault, on}; the console at GET /):
 *   FEED_GAP            no value changes at all while on (the gateway alarms a feed gap)
 *   STALE_VALUE         the values freeze: each is re-published once with status UncertainLastUsableValue and its old
 *                       source time (the gateway alarms a stale value; nothing enters the record as GOOD)
 *   OUT_OF_ORDER        one sample per unit with a source time one second before the last (refused into the series, alarmed)
 *   LINK_CUT            every client's secure channel is cut mid-transfer (one shot; the gateway reconnects)
 *   WRONG_BATCH         an event naming a unit this endpoint does not serve (one shot; the gateway refuses it)
 *   RECIPE_MISMATCH     recipe.version reports another version than the one loaded
 *   DRIFT               the measured values drift (the process model's DRIFT)
 *   EXCURSION           the profile's excursion tag (the press: main compression force) above its limit: a limit alarm
 *   REJECT_BURST        the press raises a REJECT_BURST occurrence (an Alarms-and-Conditions alarm, not a tag reading);
 *                       cleared when switched off
 *   RELOCATED           `_endpoint/location` reports another room (DI-20: the eBMR refuses the session)
 *   CERTIFICATE_CHANGE  the server restarts with a new certificate on the same port (DI-20: the gateway refuses it)
 * SIMULATOR, DEMO-ONLY. No kernel or database import (dependency rule gateway-and-simulators-no-db).
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import {
  DataType,
  MessageSecurityMode,
  OPCUACertificateManager,
  OPCUAServer,
  SecurityPolicy,
  StatusCodes,
  Variant,
  type Namespace,
  type UAVariable,
} from 'node-opcua';
import { OPCUA_NAMESPACE_URI, RECIPE_VERSION_TAG, type EquipmentAlarmV1, type EquipmentEventV1 } from '@ebmr/integration-sdk/adapter';
import { tagsOf, type EquipmentKind } from '@ebmr/integration-sdk/process';
import { realClock, type SimClock } from '../scale/model.ts';
import { ProcessModel } from '../process/model.ts';

export const OPCUA_FAULTS = [
  'FEED_GAP', 'STALE_VALUE', 'OUT_OF_ORDER', 'LINK_CUT', 'WRONG_BATCH', 'RECIPE_MISMATCH', 'DRIFT', 'EXCURSION', 'REJECT_BURST', 'RELOCATED', 'CERTIFICATE_CHANGE',
] as const;
export type OpcuaFault = (typeof OPCUA_FAULTS)[number];
const ONE_SHOT: readonly OpcuaFault[] = ['OUT_OF_ORDER', 'LINK_CUT', 'WRONG_BATCH', 'CERTIFICATE_CHANGE'];

/** The units of the default Tablets line: one of every kind the plan lists. */
export const DEFAULT_UNITS: readonly { code: string; kind: EquipmentKind }[] = [
  { code: 'PRESS-01', kind: 'PRESS' }, { code: 'COATER-01', kind: 'COATER' }, { code: 'GRAN-01', kind: 'GRANULATOR' }, { code: 'FBD-01', kind: 'DRYER' },
  { code: 'BLEND-01', kind: 'BLENDER' }, { code: 'RC-01', kind: 'ROLLER_COMPACTOR' }, { code: 'BLISTER-01', kind: 'BLISTER_MACHINE' },
  { code: 'BOTTLE-01', kind: 'BOTTLE_LINE' }, { code: 'CARTON-01', kind: 'CARTONER' },
];

export interface OpcuaSimOptions {
  /** OPC UA port (0: any free port). */
  port: number;
  /** Console and fault control (null: none). */
  http: { host: string; port: number } | null;
  /** Where the server keeps its PKI (its certificate; a new one after CERTIFICATE_CHANGE). */
  pkiDir: string;
  units?: readonly { code: string; kind: EquipmentKind }[];
  /** The room or line the server reports on `_endpoint/location`. */
  location: string;
  recipeVersion?: string;
  seed?: number;
  /** How often the values are published (ms). */
  tickMs?: number;
  /** The process model's clock (durations). */
  clock?: SimClock;
  /** The wall clock of the source timestamps (default the system clock). */
  wallMs?: () => number;
  hostname?: string;
}

interface Unit {
  code: string;
  kind: EquipmentKind;
  model: ProcessModel;
  values: Map<string, UAVariable>;
  setpoints: Map<string, UAVariable>;
  recipe: UAVariable;
  alarms: UAVariable;
  events: UAVariable;
  /** Last published sample per tag: value text and source time (ms). */
  last: Map<string, { text: string; atMs: number }>;
}

const UNCERTAIN_LAST_USABLE = StatusCodes.UncertainLastUsableValue;

export class OpcuaSimulator {
  readonly faults = new Set<OpcuaFault>();
  server: OPCUAServer | null = null;
  endpointUrl = '';
  thumbprint = '';
  port = 0;
  httpPort: number | null = null;
  /** What was published (for the soak's reconciliation): samples per unit|tag, events and alarm transitions. */
  readonly published = { samples: 0, events: 0, alarms: 0 };
  private units: Unit[] = [];
  private location!: UAVariable;
  private tick: NodeJS.Timeout | null = null;
  private http: HttpServer | null = null;
  private readonly clock: SimClock;
  private certGeneration = 0;
  private burst: string | null = null;
  private lastMs = 0;

  constructor(readonly options: OpcuaSimOptions) {
    this.clock = options.clock ?? realClock;
  }

  get unitList(): readonly { code: string; kind: EquipmentKind }[] {
    return this.options.units ?? DEFAULT_UNITS;
  }

  async start(): Promise<void> {
    await this.startServer();
    if (this.options.http) await this.startHttp(this.options.http);
    this.tick = setInterval(() => this.publish(), this.options.tickMs ?? 200);
  }

  async close(): Promise<void> {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
    await this.server?.shutdown(0).catch(() => undefined);
    this.server = null;
  }

  // -------------------------------------------------------------------------------------------------------------

  private async startServer(): Promise<void> {
    const pki = join(this.options.pkiDir, `gen-${this.certGeneration.toString()}`);
    mkdirSync(pki, { recursive: true });
    const serverCertificateManager = new OPCUACertificateManager({ rootFolder: pki, automaticallyAcceptUnknownCertificate: true });
    await serverCertificateManager.initialize();
    const server = new OPCUAServer({
      port: this.port || this.options.port,
      hostname: this.options.hostname ?? '127.0.0.1',
      resourcePath: '/ebmr',
      serverCertificateManager,
      securityModes: [MessageSecurityMode.SignAndEncrypt],
      securityPolicies: [SecurityPolicy.Basic256Sha256, SecurityPolicy.Aes128_Sha256_RsaOaep, SecurityPolicy.Aes256_Sha256_RsaPss],
      allowAnonymous: true,
      buildInfo: { productName: 'eBMR OPC UA equipment simulator (DEMO-ONLY)', buildNumber: '1' },
    });
    await server.initialize();
    const space = server.engine.addressSpace;
    if (!space) throw new Error('the server has no address space');
    const ns = space.registerNamespace(OPCUA_NAMESPACE_URI);
    const objects = space.rootFolder.objects;
    const previous = new Map(this.units.map((u) => [u.code, u]));
    const endpoint = ns.addFolder(objects, { browseName: '_endpoint', nodeId: 's=_endpoint' });
    this.location = ns.addVariable({ componentOf: endpoint, browseName: 'location', nodeId: 's=_endpoint/location', dataType: 'String', minimumSamplingInterval: 100 });
    this.units = this.unitList.map((u, i) => this.addUnit(ns, objects, u.code, u.kind, previous.get(u.code)?.model ?? new ProcessModel({ equipment: u.kind, serial: u.code, seed: (this.options.seed ?? 42) + i, running: true, clock: this.clock })));
    this.setText(this.location, this.faults.has('RELOCATED') ? `${this.options.location}-ELSEWHERE` : this.options.location);
    await server.start();
    this.server = server;
    this.port = server.endpoints[0]?.port ?? this.options.port;
    this.endpointUrl = `opc.tcp://${this.options.hostname ?? '127.0.0.1'}:${this.port.toString()}/ebmr`;
    const der = server.getCertificate();
    this.thumbprint = createHash('sha256').update(der).digest('hex');
  }

  private addUnit(ns: Namespace, objects: Parameters<Namespace['addFolder']>[0], code: string, kind: EquipmentKind, model: ProcessModel): Unit {
    const folder = ns.addFolder(objects, { browseName: code, nodeId: `s=${code}` });
    const unit: Unit = { code, kind, model, values: new Map(), setpoints: new Map(), recipe: null as unknown as UAVariable, alarms: null as unknown as UAVariable, events: null as unknown as UAVariable, last: new Map() };
    for (const t of tagsOf(kind)) {
      unit.values.set(t.tag, ns.addVariable({ componentOf: folder, browseName: t.tag, nodeId: `s=${code}/${t.tag}`, dataType: t.counter ? 'UInt32' : 'Double', minimumSamplingInterval: 50 }));
      if (t.setpoint) {
        const sp = ns.addVariable({ componentOf: folder, browseName: `${t.tag}/setpoint`, nodeId: `s=${code}/${t.tag}/setpoint`, dataType: 'Double', minimumSamplingInterval: 50, accessLevel: 'CurrentRead | CurrentWrite', userAccessLevel: 'CurrentRead | CurrentWrite' });
        sp.bindVariable({
          get: () => new Variant({ dataType: DataType.Double, value: Number(model.sample().setpoints.find((s) => s.tag === t.tag)?.value ?? '0') }),
          set: (v: Variant) => {
            const text = typeof v.value === 'number' ? String(v.value) : '';
            const r = model.write(t.tag, text);
            return r.ok ? StatusCodes.Good : StatusCodes.BadOutOfRange;
          },
        }, true);
        unit.setpoints.set(t.tag, sp);
      }
    }
    unit.recipe = ns.addVariable({ componentOf: folder, browseName: RECIPE_VERSION_TAG, nodeId: `s=${code}/${RECIPE_VERSION_TAG}`, dataType: 'String', minimumSamplingInterval: 100 });
    unit.alarms = ns.addVariable({ componentOf: folder, browseName: '_alarms/active', nodeId: `s=${code}/_alarms/active`, dataType: 'String', minimumSamplingInterval: 50 });
    unit.events = ns.addVariable({ componentOf: folder, browseName: '_events', nodeId: `s=${code}/_events`, dataType: 'String', minimumSamplingInterval: 0 });
    this.setText(unit.recipe, this.recipeOf());
    this.setText(unit.alarms, '-');
    this.setText(unit.events, '');
    return unit;
  }

  private recipeOf(): string {
    const v = this.options.recipeVersion ?? 'RCP-1';
    return this.faults.has('RECIPE_MISMATCH') ? `${v}-OTHER` : v;
  }

  private setText(v: UAVariable, text: string, atMs = this.now()): void {
    v.setValueFromSource(new Variant({ dataType: DataType.String, value: text }), StatusCodes.Good, new Date(atMs));
  }

  /** A strictly increasing wall time (ms) for source timestamps: two publications never share one. */
  private now(): number {
    const t = this.options.wallMs?.() ?? Date.now();
    this.lastMs = t > this.lastMs ? t : this.lastMs + 1;
    return this.lastMs;
  }

  /** One tick: every unit's values, active alarms and recipe version, unless the feed is in a gap. */
  publish(): void {
    if (!this.server || this.faults.has('FEED_GAP')) return;
    for (const u of this.units) {
      const s = u.model.sample();
      for (const v of s.values) {
        const node = u.values.get(v.tag);
        const spec = tagsOf(u.kind).find((t) => t.tag === v.tag);
        if (!node || !spec) continue;
        const prev = u.last.get(v.tag);
        if (this.faults.has('STALE_VALUE')) {
          // Frozen: the last value once more with an UNCERTAIN status and its old source time.
          if (prev && node.readValue().statusCode !== UNCERTAIN_LAST_USABLE) {
            node.setValueFromSource(node.readValue().value, UNCERTAIN_LAST_USABLE, new Date(prev.atMs));
            this.published.samples += 1;
          }
          continue;
        }
        if (prev && prev.text === v.value && node.readValue().statusCode === StatusCodes.Good) continue;
        const at = this.now();
        node.setValueFromSource(new Variant({ dataType: spec.counter ? DataType.UInt32 : DataType.Double, value: Number(v.value) }), StatusCodes.Good, new Date(at));
        u.last.set(v.tag, { text: v.value, atMs: at });
        this.published.samples += 1;
      }
      const active = s.alarms.map((a) => `${a.code}|${a.tag}`).join(';') || '-';
      if (u.alarms.readValue().value.value !== active) this.setText(u.alarms, active);
      const recipe = this.recipeOf();
      if (u.recipe.readValue().value.value !== recipe) this.setText(u.recipe, recipe);
    }
  }

  /** Publishes an alarm transition or an equipment event on the unit's `_events` node. */
  emitOn(unitCode: string, body: { alarm: EquipmentAlarmV1 } | { event: EquipmentEventV1 }): void {
    const u = this.units.find((x) => x.code === unitCode);
    if (!u) throw new Error(`${unitCode} is not a unit of this simulator`);
    this.setText(u.events, JSON.stringify(body));
    if ('alarm' in body) this.published.alarms += 1;
    else this.published.events += 1;
  }

  /** The microseconds of a simulator time, as text. */
  private us(ms: number): string {
    return (BigInt(ms) * 1000n).toString();
  }

  async setFault(fault: OpcuaFault, on: boolean): Promise<void> {
    if (on) this.faults.add(fault);
    else this.faults.delete(fault);
    const first = this.units[0];
    switch (fault) {
      case 'DRIFT':
        for (const u of this.units) u.model.setFault('DRIFT', on);
        break;
      case 'EXCURSION':
        for (const u of this.units) u.model.setFault('ALARM', on);
        break;
      case 'STALE_VALUE':
        if (!on) for (const u of this.units) u.last.clear();
        break;
      case 'RELOCATED':
        this.setText(this.location, on ? `${this.options.location}-ELSEWHERE` : this.options.location);
        break;
      case 'RECIPE_MISMATCH':
        for (const u of this.units) this.setText(u.recipe, this.recipeOf());
        break;
      case 'OUT_OF_ORDER':
        for (const u of this.units) {
          const [tag, prev] = [...u.last.entries()][0] ?? [];
          const node = tag ? u.values.get(tag) : undefined;
          const spec = tag ? tagsOf(u.kind).find((t) => t.tag === tag) : undefined;
          if (node && prev && spec) {
            node.setValueFromSource(new Variant({ dataType: spec.counter ? DataType.UInt32 : DataType.Double, value: Number(prev.text) + (spec.counter ? 1 : 0.5) }), StatusCodes.Good, new Date(prev.atMs - 1000));
            this.published.samples += 1;
          }
        }
        break;
      case 'LINK_CUT':
        this.cutLinks();
        break;
      case 'WRONG_BATCH':
        if (first) {
          const at = this.now();
          this.emitOn(first.code, { event: { equipmentCode: `${first.code}-X`, eventId: `wrong-${at.toString()}`, kind: 'STATE_CHANGED', state: 'RUNNING', recipeVersion: null, message: 'State of a unit this endpoint does not serve', occurredAt: this.us(at) } });
        }
        break;
      case 'REJECT_BURST': {
        const press = this.units.find((u) => u.kind === 'PRESS');
        if (press) {
          const at = this.now();
          if (on) this.burst = `burst-${randomBytes(4).toString('hex')}`;
          if (this.burst) {
            this.emitOn(press.code, {
              alarm: {
                subjectKind: 'EQUIPMENT', subjectCode: press.code, occurrenceId: this.burst, transition: on ? 'RAISED' : 'CLEARED', alarmCode: 'REJECT_BURST', severity: '700',
                tag: null, value: null, limit: null, limitKind: null, message: on ? 'Checkweigher reject burst: 12 rejects in 30 s' : 'Reject burst over', occurredAt: this.us(at),
              },
            });
          }
          if (!on) this.burst = null;
        }
        break;
      }
      case 'CERTIFICATE_CHANGE':
        await this.changeCertificate();
        break;
      default:
        break;
    }
    if (ONE_SHOT.includes(fault)) this.faults.delete(fault);
  }

  /** Cuts every client's channel without closing the server (LINK_CUT). */
  private cutLinks(): void {
    for (const ep of this.server?.endpoints ?? []) {
      for (const ch of ep.getChannels()) {
        const c = ch as unknown as { abruptlyInterrupt?: () => void; transport?: { _socket?: { destroy(): void } } };
        if (c.abruptlyInterrupt) c.abruptlyInterrupt();
        else c.transport?._socket?.destroy();
      }
    }
  }

  private async changeCertificate(): Promise<void> {
    const old = this.server;
    this.server = null;
    await old?.shutdown(0).catch(() => undefined);
    const previousPki = join(this.options.pkiDir, `gen-${this.certGeneration.toString()}`);
    this.certGeneration += 1;
    await this.startServer();
    rmSync(previousPki, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------------------------------------------

  state(): unknown {
    return {
      endpointUrl: this.endpointUrl, certificateThumbprint: this.thumbprint, location: this.options.location, faults: [...this.faults].sort(), published: this.published,
      units: this.units.map((u) => ({ code: u.code, kind: u.kind, recipe: u.recipe.readValue().value.value as string, alarms: u.alarms.readValue().value.value as string })),
    };
  }

  private async startHttp(addr: { host: string; port: number }): Promise<void> {
    const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0).toString()};`);
    this.http = createServer((req, res) => {
      const send = (status: number, body: unknown, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type });
        res.end(type === 'application/json' ? JSON.stringify(body) : String(body));
      };
      if (req.method === 'GET' && req.url === '/api/state') return send(200, this.state());
      if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
        const rows = OPCUA_FAULTS.map((f) => `<tr><td>${f}</td><td>${this.faults.has(f) ? 'ON' : 'off'}</td></tr>`).join('');
        return send(200, `<!doctype html><title>OPC UA simulator (DEMO-ONLY)</title><h1>OPC UA equipment simulator</h1><p>${esc(this.endpointUrl)}</p><p>certificate ${esc(this.thumbprint)}</p><table>${rows}</table><p>POST /api/fault {"fault": "...", "on": true}</p>`, 'text/html');
      }
      if (req.method === 'POST' && req.url === '/api/fault') {
        let text = '';
        req.on('data', (c: Buffer) => {
          text += c.toString('utf8');
          if (text.length > 4096) req.destroy();
        });
        req.on('end', () => {
          let body: { fault?: unknown; on?: unknown } = {};
          try {
            body = JSON.parse(text) as typeof body;
          } catch {
            return send(400, { error: 'the body is not JSON' });
          }
          if (typeof body.fault !== 'string' || !(OPCUA_FAULTS as readonly string[]).includes(body.fault) || typeof body.on !== 'boolean') {
            return send(400, { error: `fault must be one of ${OPCUA_FAULTS.join(', ')} and on a boolean` });
          }
          void this.setFault(body.fault as OpcuaFault, body.on).then(
            () => send(200, this.state()),
            (e: unknown) => send(500, { error: e instanceof Error ? e.message : String(e) }),
          );
        });
        return undefined;
      }
      return send(404, { error: 'not found' });
    });
    await new Promise<void>((resolve) => this.http?.listen(addr.port, addr.host, () => resolve()));
    const a = this.http.address();
    this.httpPort = a && typeof a === 'object' ? a.port : null;
  }
}

export async function startOpcuaSimulator(options: OpcuaSimOptions): Promise<OpcuaSimulator> {
  const sim = new OpcuaSimulator(options);
  await sim.start();
  return sim;
}
