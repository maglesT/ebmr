/**
 * DEMO-ONLY seed of the sandbox (module C3): TEST- lots for the dc-mini template's materials, registered by the
 * master-data steward persona through tab.register_sandbox_lot (MASTERDATA.CHANGE; audited, insert-only). One
 * quarantined lot shows the engine's hard block (PR-18). Never run on a production installation.
 */
import type pg from 'pg';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import type { FeatureSeedContext } from '../types.ts';

const DAY_US = 86_400_000_000n;

export interface SeedLot {
  lotCode: string;
  materialCode: string;
  materialName: string;
  status: string;
  identityTested: boolean;
  /** Expiry and retest, in days from the database time of the seed. */
  expiresInDays?: number;
  retestInDays?: number;
}

export const DEMO_LOTS: readonly SeedLot[] = [
  { lotCode: 'TEST-L26-0101', materialCode: 'MAT-PCM', materialName: 'Paracetamol, direct-compression grade', status: 'RELEASED', identityTested: true, expiresInDays: 730, retestInDays: 365 },
  { lotCode: 'TEST-L26-0102', materialCode: 'MAT-MCC', materialName: 'Microcrystalline cellulose PH 102', status: 'RELEASED', identityTested: true, expiresInDays: 730, retestInDays: 365 },
  { lotCode: 'TEST-L26-0103', materialCode: 'MAT-MGS', materialName: 'Magnesium stearate', status: 'RELEASED', identityTested: true, expiresInDays: 730, retestInDays: 365 },
  { lotCode: 'TEST-L26-0199', materialCode: 'MAT-PCM', materialName: 'Paracetamol, direct-compression grade', status: 'QUARANTINE', identityTested: false, expiresInDays: 730 },
];

/** Registers test lots as `actor` (a MASTERDATA.CHANGE holder), with dates relative to the database time. */
export async function registerLots(pool: pg.Pool, actor: ActorContext, lots: readonly SeedLot[]): Promise<void> {
  await withCommand(pool, actor, async (c) => {
    const { rows } = await c.query<{ us: string }>('select tab.now_micros() as us');
    const now = BigInt(rows[0]?.us ?? '0');
    for (const l of lots) {
      await c.query('select tab.register_sandbox_lot($1::jsonb)', [
        JSON.stringify({
          lotCode: l.lotCode,
          materialCode: l.materialCode,
          materialName: l.materialName,
          status: l.status,
          identityTested: l.identityTested,
          ...(l.expiresInDays !== undefined ? { expiresAtUs: (now + BigInt(l.expiresInDays) * DAY_US).toString() } : {}),
          ...(l.retestInDays !== undefined ? { retestAtUs: (now + BigInt(l.retestInDays) * DAY_US).toString() } : {}),
        }),
      ]);
    }
  });
}

export async function seed(ctx: FeatureSeedContext): Promise<void> {
  if (ctx.installation !== 'SANDBOX') return;
  ctx.log(`registering ${DEMO_LOTS.length} TEST- lots`);
  await registerLots(ctx.pools.app, await ctx.actorFor('steward'), DEMO_LOTS);
}
