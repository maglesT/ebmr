/**
 * Feature `meta` (C0): GET /api/meta, what this server is. The SPA reads it first and then hard-fails on any
 * response whose X-Ebmr-Installation differs (DI-05).
 */
import { routes } from '@ebmr/api-contract';
import { sandbox } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { dbNowUs } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';

export const SERVER_VERSION = '0.1.0';

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  bindRoutes(scope, app, routes.meta, {
    get: async () => ({
      installation: app.installation,
      edition: 'tablets' as const,
      version: SERVER_VERSION,
      watermark: sandbox.watermarkFor(app.installation),
      site: { code: app.config.siteCode, zone: app.siteZone.current() },
      serverTime: app.formatInstant(await dbNowUs(app.pools.app)),
      demo: app.demo.enabled,
      publicOrigin: app.config.publicOrigin,
      otherInstallationUrl: app.config.otherInstallationUrl,
    }),
  });
  return Promise.resolve();
}
