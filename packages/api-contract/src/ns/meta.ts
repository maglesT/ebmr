/** Namespace `meta` (C0): what this server is. The SPA hard-fails when X-Ebmr-Installation differs from it. */
import { z } from 'zod';
import { InstallationKind, Instant, Watermark } from '../common.ts';
import { defineRoute } from '../route.ts';

export const MetaView = z.strictObject({
  installation: InstallationKind,
  edition: z.literal('tablets'),
  /** Server package version. */
  version: z.string(),
  /** TEST, NOT GMP on the sandbox; null on GMP. */
  watermark: Watermark.nullable(),
  site: z.strictObject({ code: z.string(), zone: z.string() }),
  /** Database time when the response was made (display countdowns use it with performance.now()). */
  serverTime: Instant,
  /** The demo device picker is available (EBMR_DEMO=1 and a demo database). */
  demo: z.boolean(),
  publicOrigin: z.string(),
  /** Link to the other installation's SPA (GMP -> sandbox), when configured. */
  otherInstallationUrl: z.string().nullable(),
  /** Phase 7 slice 7g-4: the installation awaits its first-run set-up (no administrator yet); the SPA shows the wizard. */
  setupRequired: z.boolean(),
  /**
   * Declutter D1/D2: the server refuses the disconnected functions (410 DISCONNECTED; the platform build, or a server
   * started with EBMR_DISCONNECT=1), so the SPA leaves their screens off.
   */
  disconnected: z.boolean(),
  /**
   * Platform slice 2: the server has a Deviations link (DEVIATIONS_DATABASE_URL). A batch's deviation is then linked by
   * its Deviations number and its status read from Deviations; the batch-only deviation screens are off.
   */
  deviationsLinked: z.boolean().optional(),
});
export type MetaView = z.infer<typeof MetaView>;

export const meta = {
  get: defineRoute({
    id: 'meta.get',
    method: 'GET',
    path: '/api/meta',
    installation: 'ANY',
    auth: 'NONE',
    mutating: false,
    summary: 'Installation kind, watermark, site, server time and demo flag',
    response: MetaView,
  }),
  /** Phase 7 slice 7g-4 (decision 0025): the OpenAPI document of this contract, for the API reference page. */
  openapi: defineRoute({
    id: 'meta.openapi',
    method: 'GET',
    path: '/api/meta/openapi',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'The OpenAPI document of the API contract (the developers\' API reference page)',
    response: z.record(z.string(), z.unknown()),
  }),
} as const;
