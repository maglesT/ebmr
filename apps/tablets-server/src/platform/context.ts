/**
 * What every feature module receives: configuration, the server's log, pools, the read database, the guidance
 * catalogue, the signable-action registry and the ports (plan sections 3-6). Built once by buildApp.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';
import type { esig } from '@ebmr/kernel';
import type { DemoDeviceView, Instant } from '@ebmr/api-contract';
import type { ServerConfig } from '../config.ts';
import type { DeviceIdentityProvider } from './auth/device-proof.ts';
import type { Pools } from './db/pools.ts';
import type { ReadDatabase } from './db/read.ts';
import type { GuidanceCatalogue } from './http/guidance.ts';
import type { OperationsRuntime } from './operations.ts';
import type { DeviceReadingPort, SignableActionRegistry } from './ports.ts';
import type { SiteZoneGuard } from './site-zone.ts';

export interface DemoState {
  /** EBMR_DEMO=1 and the database carries the tab.demo_installation marker (decision D6). */
  enabled: boolean;
  devices: DemoDeviceView[];
}

export interface AppContext {
  config: ServerConfig;
  installation: 'GMP' | 'SANDBOX';
  /**
   * The server's own log (the Fastify instance's), for work outside any request: a report of the gateway's that the
   * devices runtime could not record, a connection of its pools lost while idle (features/devices/runtime.ts).
   */
  log: FastifyBaseLogger;
  pools: Pools;
  readDb: Kysely<ReadDatabase>;
  guidance: GuidanceCatalogue;
  signables: SignableActionRegistry;
  devices: DeviceIdentityProvider;
  deviceReadings: DeviceReadingPort;
  sealKey: esig.SealKeyProvider | null;
  demo: DemoState;
  /**
   * The site's time zone while the server runs (DI-27): the zone read at start-up, refused once the site policy
   * site.zone was found to name another (SITE_ZONE_CHANGED until a restart). Everything that declares or shows the
   * zone takes it from here (requests, the gateway listener, the sweeper, meta), never from config.siteZone.
   */
  siteZone: SiteZoneGuard;
  /** The {us, text} form of a GMP instant in the site's time zone; refuses after a change of the zone (DI-27). */
  formatInstant(us: bigint | string): Instant;
  /** Every route bound on this server (the coverage test reads it). */
  boundRoutes: Map<string, { method: string; path: string; installation: 'GMP' | 'SANDBOX' }>;
  /**
   * Phase 7 slice 7g-4: the background workers the operations screens start and stop, and the maintenance state of a demo
   * load or reset (platform/operations.ts). The seal key and the demo state above are replaced by the first-run set-up and
   * a demo load, which is why they are read from here at the time of use.
   */
  operations: OperationsRuntime;
}
