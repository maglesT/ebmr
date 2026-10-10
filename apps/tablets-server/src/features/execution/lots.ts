/**
 * Lots from the register of this installation (tablets 0801, tab.lot_facts): the sandbox's TEST- lots (tab.sandbox_lot;
 * DI-05) or, in GMP, the site's material lots (site.material_lot at the batch's site: RELEASED only while the lot's state
 * is a usable one, its retest and expiry instants, and whether the identity rule of the batch's markets holds). The
 * browser sends a lot as a code; its material, status, expiry, retest date and identity test are read here, inside the
 * command, and handed to the block as the facts at the moment of use (PR-18). The engine refuses anything but a
 * released lot of the right material within its dates, with no operator override; the database compares the entry's lot
 * with the register again (EBMR-EXE-078).
 */
import type { LotView } from '@ebmr/api-contract';
import type { z } from 'zod';
import type { Db } from './runs.ts';

export interface LotFacts {
  lotCode: string;
  materialCode: string;
  materialName: string;
  status: string;
  expiresAtUs: bigint | null;
  retestAtUs: bigint | null;
  identityTested: boolean;
}

/** The lot `code` as batch `batchId` uses it now (without a batch: the lot route's read). */
export async function resolveLot(db: Db, code: string, batchId?: string): Promise<LotFacts | undefined> {
  const { rows } =
    batchId === undefined
      ? await db.query<{ l: Record<string, unknown> | null }>('select tab.resolve_lot($1) as l', [code])
      : await db.query<{ l: Record<string, unknown> | null }>('select tab.resolve_lot($1, $2::uuid) as l', [code, batchId]);
  const l = rows[0]?.l;
  if (!l) return undefined;
  const us = (v: unknown): bigint | null => (typeof v === 'string' && /^[0-9]+$/.test(v) ? BigInt(v) : null);
  return {
    lotCode: String(l['lotCode']),
    materialCode: String(l['materialCode']),
    materialName: String(l['materialName']),
    status: String(l['status']),
    expiresAtUs: us(l['expiresAtUs']),
    retestAtUs: us(l['retestAtUs']),
    identityTested: l['identityTested'] === true,
  };
}

/** The lot as the block's LOT_SCHEMA takes it (facts at the moment of use; instants as epoch microseconds text). */
export function lotForEngine(l: LotFacts): Record<string, unknown> {
  return {
    id: l.lotCode,
    material: l.materialCode,
    status: l.status,
    ...(l.expiresAtUs !== null ? { expiresAtUs: l.expiresAtUs.toString() } : {}),
    ...(l.retestAtUs !== null ? { retestAtUs: l.retestAtUs.toString() } : {}),
    identityTested: l.identityTested,
  };
}

export function lotView(l: LotFacts, formatInstant: (us: bigint) => { text: string }): z.infer<typeof LotView> {
  return {
    lotCode: l.lotCode,
    material: { code: l.materialCode, name: l.materialName },
    status: l.status,
    expiry: l.expiresAtUs === null ? null : formatInstant(l.expiresAtUs).text,
    retest: l.retestAtUs === null ? null : formatInstant(l.retestAtUs).text,
    identityTested: l.identityTested,
  };
}
