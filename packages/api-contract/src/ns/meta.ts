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
} as const;
