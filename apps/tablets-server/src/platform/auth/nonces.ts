/**
 * Device-proof nonces (DI-20; plan section 5): random, HMAC-minted, single use, 60 s. The database stores only
 * the HMAC (tab.device_nonce), so a nonce can neither be forged from the table nor used twice.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type pg from 'pg';

export const NONCE_TTL_SECONDS = 60;

export function nonceHmac(nonceKey: string, nonce: string): string {
  return createHmac('sha256', nonceKey).update(nonce, 'utf8').digest('hex');
}

export async function mintNonce(pool: pg.Pool, nonceKey: string): Promise<{ nonce: string; expiresInSeconds: number }> {
  const nonce = randomBytes(24).toString('base64url');
  await pool.query('select tab.mint_device_nonce($1, $2)', [nonceHmac(nonceKey, nonce), NONCE_TTL_SECONDS]);
  return { nonce, expiresInSeconds: NONCE_TTL_SECONDS };
}

/** True when the nonce was minted here, unused and unexpired; it is used up either way. */
export async function consumeNonce(pool: pg.Pool, nonceKey: string, nonce: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>('select tab.consume_device_nonce($1) as ok', [nonceHmac(nonceKey, nonce)]);
  return rows[0]?.ok === true;
}
