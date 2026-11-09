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
import { cachedOpenApiDocument } from '../../platform/openapi.ts';

/** True once the installation has its first administrator and process owner (kernel 1375, iam.is_bootstrapped). */
export async function isBootstrapped(app: Pick<AppContext, 'pools'>): Promise<boolean> {
  const { rows } = await app.pools.app.query<{ b: boolean }>('select iam.is_bootstrapped() as b');
  return rows[0]?.b === true;
}

/** The site code the first-run set-up recorded (kernel 1375), or null (an installation set up by the CLI). */
async function recordedSiteCode(app: Pick<AppContext, 'pools'>): Promise<string | null> {
  const { rows } = await app.pools.app.query<{ code: string }>('select site_code as code from iam.installation_site');
  return rows[0]?.code ?? null;
}

export const SERVER_VERSION = '1.0.0-rc.1';

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  bindRoutes(scope, app, routes.meta, {
    get: async () => ({
      installation: app.installation,
      edition: 'tablets' as const,
      version: SERVER_VERSION,
      watermark: sandbox.watermarkFor(app.installation),
      site: { code: (await recordedSiteCode(app)) ?? app.config.siteCode, zone: app.siteZone.current() },
      serverTime: app.formatInstant(await dbNowUs(app.pools.app)),
      demo: app.demo.enabled,
      publicOrigin: app.config.publicOrigin,
      otherInstallationUrl: app.config.otherInstallationUrl,
      // Phase 7 slice 7g-4: no administrator yet (kernel 1375): the SPA shows the first-run set-up.
      setupRequired: !(await isBootstrapped(app)),
      // Declutter D1/D2: bind.ts refuses the disconnected functions here (410 DISCONNECTED).
      disconnected: app.platform.build || app.config.disconnect,
      // MEDHANTA slice 2: deviations are linked by number and read from the Deviations product.
      deviationsLinked: app.platform.deviations !== null,
    }),
    // Phase 7 slice 7g-4 (decision 0025): the developers' API reference page.
    openapi: async ({ requireSession }) => {
      requireSession();
      return cachedOpenApiDocument();
    },
  });
  return Promise.resolve();
}
