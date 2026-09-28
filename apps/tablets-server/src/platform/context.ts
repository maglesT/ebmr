/**
 * What every feature module receives: configuration, pools, the read database, the guidance catalogue, the
 * signable-action registry and the ports (plan sections 3-6). Built once by buildApp.
 */
import type { Kysely } from 'kysely';
import type { esig } from '@ebmr/kernel';
import type { DemoDeviceView, Instant } from '@ebmr/api-contract';
import type { ServerConfig } from '../config.ts';
import type { DeviceIdentityProvider } from './auth/device-proof.ts';
import type { Pools } from './db/pools.ts';
import type { ReadDatabase } from './db/read.ts';
import type { GuidanceCatalogue } from './http/guidance.ts';
import type { DeviceReadingPort, SignableActionRegistry } from './ports.ts';

export interface DemoState {
  /** EBMR_DEMO=1 and the database carries the tab.demo_installation marker (decision D6). */
  enabled: boolean;
  devices: DemoDeviceView[];
}

export interface AppContext {
  config: ServerConfig;
  installation: 'GMP' | 'SANDBOX';
  pools: Pools;
  readDb: Kysely<ReadDatabase>;
  guidance: GuidanceCatalogue;
  signables: SignableActionRegistry;
  devices: DeviceIdentityProvider;
  deviceReadings: DeviceReadingPort;
  sealKey: esig.SealKeyProvider | null;
  demo: DemoState;
  formatInstant(us: bigint | string): Instant;
  /** Every route bound on this server (the coverage test reads it). */
  boundRoutes: Map<string, { method: string; path: string; installation: 'GMP' | 'SANDBOX' }>;
}
