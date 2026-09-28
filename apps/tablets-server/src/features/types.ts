/**
 * What a feature module's index.ts exports (plan section 3; module C0): its Fastify plugin, and optionally its
 * guidance entries, a seed for demo and E2E installations, its signable actions and the scale-reading port.
 * The list of features is fixed in features/index.ts; each module owns its own folder.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { ActorContext, identity } from '@ebmr/kernel';
import type { AppContext } from '../platform/context.ts';
import type { GuidanceEntry } from '../platform/http/guidance.ts';
import type { DeviceReadingPort, SignableActionRegistry } from '../platform/ports.ts';

export type FeaturePlugin = (scope: FastifyInstance, app: AppContext) => Promise<void>;

/** What the set-up CLI gives a feature's seed (demo and E2E databases only; never production). */
export interface FeatureSeedContext {
  installation: 'GMP' | 'SANDBOX';
  database: string;
  /** Superuser, application and authentication pools of the database being seeded. */
  pools: { admin: pg.Pool; app: pg.Pool; authn: identity.AuthnDb };
  /** A persona of the seeded catalogue (e.g. 'steward', 'issuer', 'operator1'). */
  persona(key: string): { personId: string; accountId: string; legalName: string; loginName: string; roleCode: string };
  /** A fresh session of a persona on its home terminal, as an ActorContext (office personas only). */
  actorFor(key: string): Promise<ActorContext>;
  /** The installation's system administrator, for configuration (SYSTEM.CONFIGURE). */
  adminActor(): Promise<ActorContext>;
  exchangeDir: string;
  log(message: string): void;
}

export interface FeatureModule {
  plugin: FeaturePlugin;
  guidance?: Readonly<Record<string, GuidanceEntry>>;
  seed?: (ctx: FeatureSeedContext) => Promise<void>;
  registerSignableActions?: (registry: SignableActionRegistry, app: AppContext) => void;
  deviceReadingPort?: (app: AppContext) => DeviceReadingPort;
  /** Sandbox: the site gateway's uplink listener, started by main.ts when EBMR_GATEWAY_LISTEN is set (C5). */
  startGatewayListener?: (app: AppContext, listen: { host: string; port: number }) => Promise<{ close(): Promise<void> }>;
}

export interface FeatureEntry {
  name: string;
  /** Installations the plugin is registered on (routes are further gated by their own installation). */
  installations: readonly ('GMP' | 'SANDBOX')[];
  module: FeatureModule;
}
