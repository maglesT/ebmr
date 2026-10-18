/**
 * The adapters started with the server (Phase 6 slice 6a; DI-31; D-P6a-5): one worker per configured adapter whose
 * system the site runs in MIRROR mode. An adapter is configured by its entry in the service-keys file
 * (EBMR_SERVICE_KEYS_FILE: its SERVER terminal, below, with the account's login, service key, terminal fingerprint and
 * the feed `endpoint`) and an ACTIVE registration of its account for its system (iam.integration_adapter). A STAND_IN
 * site starts none: its data is the built-in registers' and the database refuses a message for a STAND_IN data class.
 *
 * The mode is read once at start (switching a data class's mode is a configuration change, D-P6a-5; it takes effect
 * at the next start). A system is in MIRROR when any of its mirror data classes is; LIMS has no data class (D-P6a-B-6,
 * LIMS-lite stays the stand-in), so its adapter runs when any data class of the site is in MIRROR (D-P6a-I-2). The EMS
 * (slice 6b) has no data class either (a feed of room observations, D-P6b-B-8) and follows the LIMS rule: a site that
 * connects its external systems runs it, a STAND_IN site still starts no adapter at all. The OPC UA adapter (the
 * gateway's feed of native series, alarms, events and endpoint sessions) follows the same rule (D-P6b-L-1).
 * Phase 7 slice 7a (6jc-R9; DI-31): an adapter with `<code>.ca.pem`, `.cert.pem` and `.key.pem` in EBMR_ADAPTER_TLS_DIR
 * talks mutual TLS (./transport.ts); on a GMP installation an adapter whose base URL is off loopback without it does not
 * start (EBMR-INT-034) and its health shows BLOCKED with the refusal as its last error.
 * Workers stop (their cycle ends, their session is closed) when the server closes; their health shows on the
 * integrations routes (AdapterHealthView.worker).
 * Phase 7 slice 7g-4 (decision 0025): the operations screen starts, stops and restarts each worker (AdapterControl,
 * platform/operations.ts). A start reads the service-keys file and the registration again, so an adapter configured after
 * the server started can be started without a restart, and passes the same rules as at start-up: a MIRROR system, an
 * ACTIVE registration, and on a GMP installation the transport rule (EBMR-INT-034, shown as the refusal).
 */
import { adapterTransportProblem, type AdapterTls, type SourceSystem } from '@ebmr/integration-sdk/adapter';
import type pg from 'pg';
import type { AppContext } from '../../../platform/context.ts';
import type { AdapterControl, AdapterWorkerState } from '../../../platform/operations.ts';
import { CMMS_ADAPTER } from './cmms/index.ts';
import { EMS_ADAPTER } from './ems/index.ts';
import { ERP_WMS_ROLE, erpWmsWorker } from './erp-wms/index.ts';
import { adapterEntry, feedWorker, openAdapterActor, type AdapterHealth, type AdapterWorker } from './framework.ts';
import { L3_ADAPTER } from './l3/index.ts';
import { LIMS_ADAPTER } from './lims/index.ts';
import { LMS_ADAPTER } from './lms/index.ts';
import { OPCUA_ADAPTER } from './opcua/index.ts';
import { QMS_ADAPTER } from './qms/index.ts';
import { adapterTlsOf } from './transport.ts';

/** The role of the QMS, LIMS, LMS, CMMS and L3 adapters' accounts (D-P6a-B-10: SERVICE_ACCOUNT only). */
export const FEED_ADAPTER_ROLE = 'SERVICE_ACCOUNT';

type Make = (pool: pg.Pool, code: string, openActor: Parameters<typeof feedWorker>[3], endpoint: string, tls: AdapterTls | undefined) => AdapterWorker;
const t = (tls: AdapterTls | undefined): { tls?: AdapterTls } => (tls ? { tls } : {});

interface Slot {
  /** The adapter's SERVER terminal in the service-keys file. */
  terminal: string;
  system: SourceSystem;
  roleCode: string;
  make: Make;
}

/** Every adapter the server can start, by its terminal in the service-keys file. */
export const ADAPTER_SLOTS: readonly Slot[] = [
  { terminal: 'SRV-ERP-ADAPTER-01', system: 'ERP_WMS', roleCode: ERP_WMS_ROLE, make: (p, c, o, endpoint, tls) => erpWmsWorker(p, c, 'ERP', o, { endpoint, ...t(tls) }) },
  { terminal: 'SRV-WMS-ADAPTER-01', system: 'ERP_WMS', roleCode: ERP_WMS_ROLE, make: (p, c, o, endpoint, tls) => erpWmsWorker(p, c, 'WMS', o, { endpoint, ...t(tls) }) },
  { terminal: 'SRV-QMS-ADAPTER-01', system: 'QMS', roleCode: FEED_ADAPTER_ROLE, make: (p, c, o, endpoint, tls) => feedWorker(p, c, QMS_ADAPTER, o, { endpoint, ...t(tls) }) },
  { terminal: 'SRV-LIMS-ADAPTER-01', system: 'LIMS', roleCode: FEED_ADAPTER_ROLE, make: (p, c, o, endpoint, tls) => feedWorker(p, c, LIMS_ADAPTER, o, { endpoint, ...t(tls) }) },
  { terminal: 'SRV-LMS-ADAPTER-01', system: 'LMS', roleCode: FEED_ADAPTER_ROLE, make: (p, c, o, endpoint, tls) => feedWorker(p, c, LMS_ADAPTER, o, { endpoint, ...t(tls) }) },
  { terminal: 'SRV-CMMS-ADAPTER-01', system: 'CMMS', roleCode: FEED_ADAPTER_ROLE, make: (p, c, o, endpoint, tls) => feedWorker(p, c, CMMS_ADAPTER, o, { endpoint, ...t(tls) }) },
  // Slice 6b: no mirror data class; runs as LIMS does, when any data class of the site is in MIRROR (header).
  { terminal: 'SRV-EMS-ADAPTER-01', system: 'EMS', roleCode: FEED_ADAPTER_ROLE, make: (p, c, o, endpoint, tls) => feedWorker(p, c, EMS_ADAPTER, o, { endpoint, ...t(tls) }) },
  // Slice 6b: the gateway's OPC UA feed (series, alarms, events, endpoint sessions); the EMS rule (D-P6b-L-1).
  { terminal: 'SRV-OPCUA-ADAPTER-01', system: 'OPCUA', roleCode: FEED_ADAPTER_ROLE, make: (p, c, o, endpoint, tls) => feedWorker(p, c, OPCUA_ADAPTER, o, { endpoint, ...t(tls) }) },
  // Phase 6 slice 6c (PR-42): the serialisation L3 system's feed.
  { terminal: 'SRV-L3-ADAPTER-01', system: 'L3', roleCode: FEED_ADAPTER_ROLE, make: (p, c, o, endpoint, tls) => feedWorker(p, c, L3_ADAPTER, o, { endpoint, ...t(tls) }) },
];

/** The systems the site runs in MIRROR mode (see the header for LIMS and the EMS). */
export async function mirroredSystems(db: Pick<pg.Pool, 'query'>): Promise<Set<SourceSystem>> {
  const { rows } = await db.query<{ system: SourceSystem; mode: string | null }>(
    "select c.source_system as system, platform.mirror_freshness(c.code) ->> 'mode' as mode from platform.mirror_data_class c",
  );
  const out = new Set(rows.filter((r) => r.mode === 'MIRROR').map((r) => r.system));
  if (out.size > 0) {
    out.add('LIMS');
    out.add('EMS');
    out.add('OPCUA');
  }
  return out;
}

/** The running adapters of this server process. */
export interface AdapterRuntime {
  /** The workers running now. */
  readonly workers: readonly AdapterWorker[];
  /** The health of the worker of adapter `code` (BLOCKED, naming why, for one refused at start), or null when none runs. */
  health(code: string): AdapterHealth | null;
  /** The adapters refused at their last start because of their transport (EBMR-INT-034, slice 7a), with why. */
  readonly refusedAtStart: ReadonlyMap<string, string>;
  /** Start, stop and list the workers (the operations screen, slice 7g-4). */
  control: AdapterControl;
  stop(): Promise<void>;
}

type Log = { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };

interface Resolved {
  slot: Slot;
  entry: NonNullable<ReturnType<typeof adapterEntry>>;
}

/**
 * Starts every configured adapter of a MIRROR system (header). Never throws: a slot that cannot start is logged. The
 * runtime it returns starts and stops each one later (AdapterControl).
 */
export async function startAdapters(app: AppContext, log: Log, intervalMs = 5000): Promise<AdapterRuntime> {
  const workers = new Map<string, AdapterWorker>();
  const refused = new Map<string, AdapterHealth>();
  /** Why an adapter is not running when it was not started (STAND_IN, not configured), by code. */
  const notStarted = new Map<string, string>();

  /** The slot and service-keys entry of an ACTIVE adapter registration, read now; or why there is none. */
  const resolve = async (code: string): Promise<Resolved | string> => {
    const file = app.config.serviceKeysFile;
    const { rows } = await app.pools.app.query<{ system: SourceSystem; login: string }>(
      "select d.source_system as system, a.login_name as login from iam.integration_adapter d join iam.account a on a.id = d.account_id where d.code = $1 and d.status = 'ACTIVE'",
      [code],
    );
    const reg = rows[0];
    if (!reg) return `the adapter ${code} has no ACTIVE registration`;
    if (!file) return `the adapter ${code} is not configured on this server: no service-keys file (EBMR_SERVICE_KEYS_FILE)`;
    for (const slot of ADAPTER_SLOTS.filter((s) => s.system === reg.system)) {
      const entry = adapterEntry(file, slot.terminal);
      if (entry && entry.loginName === reg.login) return { slot, entry };
    }
    return `the adapter ${code} is not configured on this server: no entry of its account ${reg.login} with an endpoint in the service-keys file`;
  };

  /** Starts the worker of adapter `code` on `r`; the refusal, or null when it runs. */
  const launch = async (code: string, r: Resolved, mirrored: Set<SourceSystem>): Promise<string | null> => {
    if (!mirrored.has(r.slot.system)) {
      const why = `the site runs ${r.slot.system} as STAND_IN: its adapter does not start (D-P6a-5)`;
      notStarted.set(code, why);
      return why;
    }
    // Slice 7a (6jc-R9, DI-31): mutual TLS from EBMR_ADAPTER_TLS_DIR; a GMP installation starts no adapter off loopback
    // without it, and the health page names the refusal (EBMR-INT-034).
    let tls: AdapterTls | undefined;
    let problem: string | null;
    try {
      tls = adapterTlsOf(app.config.adapterTlsDir, code);
      problem = adapterTransportProblem(r.entry.endpoint, tls, app.installation);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
    if (problem !== null) {
      log.warn({ adapter: code, system: r.slot.system, endpoint: r.entry.endpoint, code: 'EBMR-INT-034' }, problem);
      refused.set(code, refusedHealth(code, r.slot.system, problem));
      return problem;
    }
    refused.delete(code);
    notStarted.delete(code);
    const entry = r.entry;
    const w = r.slot.make(app.pools.app, code, () => openAdapterActor(app, entry, r.slot.roleCode), entry.endpoint, tls);
    w.start(intervalMs, log);
    workers.set(code, w);
    log.info({ adapter: code, system: r.slot.system, endpoint: entry.endpoint, mutualTls: tls !== undefined }, 'integration adapter started');
    return null;
  };

  const file = app.config.serviceKeysFile;
  const mirrored = file ? await mirroredSystems(app.pools.app) : new Set<SourceSystem>();
  for (const slot of file ? ADAPTER_SLOTS : []) {
    try {
      const entry = adapterEntry(file, slot.terminal);
      if (!entry) continue;
      if (!mirrored.has(slot.system)) {
        log.info({ terminal: slot.terminal, system: slot.system }, 'the integration adapter does not start: the site runs its system as STAND_IN');
        continue;
      }
      const { rows } = await app.pools.app.query<{ code: string }>(
        "select d.code from iam.integration_adapter d join iam.account a on a.id = d.account_id where a.login_name = $1 and d.source_system = $2 and d.status = 'ACTIVE'",
        [entry.loginName, slot.system],
      );
      const code = rows[0]?.code;
      if (!code) {
        log.warn({ terminal: slot.terminal, system: slot.system, account: entry.loginName }, 'the adapter account is not registered as an active adapter of its system; it does not start');
        continue;
      }
      await launch(code, { slot, entry }, mirrored);
    } catch (e) {
      log.warn({ terminal: slot.terminal, err: e instanceof Error ? e.message : String(e) }, 'the integration adapter could not start');
    }
  }

  const stopOne = async (code: string): Promise<void> => {
    const w = workers.get(code);
    workers.delete(code);
    if (w) await w.stop();
  };
  const stopAll = async (): Promise<void> => {
    const all = [...workers.keys()];
    await Promise.all(all.map((c) => stopOne(c)));
  };

  const control: AdapterControl = {
    async list(): Promise<AdapterWorkerState[]> {
      const { rows } = await app.pools.app.query<{ code: string; system: SourceSystem }>(
        "select d.code, d.source_system as system from iam.integration_adapter d where d.status = 'ACTIVE' order by d.code collate \"C\"",
      );
      return rows.map((r) => {
        const w = workers.get(r.code);
        if (w) {
          const h = w.health();
          return { code: r.code, system: r.system, running: true, state: h.state, problem: h.lastError };
        }
        const why = refused.get(r.code)?.lastError ?? notStarted.get(r.code) ?? null;
        return { code: r.code, system: r.system, running: false, state: 'STOPPED', problem: why };
      });
    },
    async start(code: string): Promise<string | null> {
      if (workers.has(code)) return null;
      const r = await resolve(code);
      if (typeof r === 'string') {
        notStarted.set(code, r);
        return r;
      }
      return launch(code, r, await mirroredSystems(app.pools.app));
    },
    stop: stopOne,
    stopAll,
  };

  return {
    get workers() {
      return [...workers.values()];
    },
    health: (code) => workers.get(code)?.health() ?? (refused.has(code) ? { ...(refused.get(code) as AdapterHealth) } : null),
    get refusedAtStart() {
      return new Map([...refused].map(([c, h]) => [c, h.lastError ?? '']));
    },
    control,
    stop: stopAll,
  };
}

/** The health shown for an adapter refused at start: BLOCKED, never cycled, its last error the refusal. */
function refusedHealth(code: string, system: SourceSystem, problem: string): AdapterHealth {
  return { code, system, state: 'BLOCKED', cursor: '0', head: null, cycles: 0, attempts: 0, lastError: problem, accepted: 0, duplicates: 0, refused: 0 };
}
