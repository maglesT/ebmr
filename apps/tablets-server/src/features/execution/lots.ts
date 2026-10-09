/**
 * Test lots of the sandbox (tab.sandbox_lot; TEST- only, DI-05). The browser sends a lot as a code; its
 * material, status, expiry, retest date and identity test are read here, inside the command, and handed to
 * the block as the facts at the moment of use (PR-18). The engine refuses anything but a released lot of the
 * right material within its dates, with no operator override.
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

export async function resolveLot(db: Db, code: string): Promise<LotFacts | undefined> {
  const { rows } = await db.query<{ l: Record<string, unknown> | null }>('select tab.resolve_lot($1) as l', [code]);
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
