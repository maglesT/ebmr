/**
 * DEMO-ONLY seed of the GMP installation (Phase 3 slice 6): the demo site's master data, lots and devices, and the
 * GB-T-01 material. Called from seed.ts; owned by slice 6c from 6a-0 on (empty until then). Never run on a production
 * installation.
 */
import type { FeatureSeedContext } from '../types.ts';

export async function seedGmp(ctx: FeatureSeedContext): Promise<void> {
  if (ctx.installation !== 'GMP') return;
  await Promise.resolve();
}
