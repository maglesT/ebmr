/**
 * Device-proof nonces (DI-20; plan section 5): random, HMAC-minted, single use, 60 s. The database stores only
 * the HMAC (tab.device_nonce), so a nonce can neither be forged from the table nor used twice.
 *
 * A browser terminal's nonce is bound to the public key that asked for it (decision 0004 X25): its HMAC covers that
 * key's fingerprint too, so it is found again only by a proof signed with the same key. A nonce asked for under one
 * key is refused for a proof by another, and the gateway's login nonce (POST /gw/v1/nonce, bound to no key) is refused
 * for a browser proof, as a browser nonce is for the gateway's login.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type pg from 'pg';

export const NONCE_TTL_SECONDS = 60;

/**
 * The HMAC stored for a nonce. `boundTo` is the fingerprint of the browser terminal key it is bound to, or null for
 * the gateway's login nonce. A nonce is base64url (no '|'), so the two forms never meet.
 */
export function nonceHmac(nonceKey: string, nonce: string, boundTo: string | null): string {
  const text = boundTo === null ? nonce : `browser-device-key|${boundTo}|${nonce}`;
  return createHmac('sha256', nonceKey).update(text, 'utf8').digest('hex');
}

export async function mintNonce(pool: pg.Pool, nonceKey: string, boundTo: string | null): Promise<{ nonce: string; expiresInSeconds: number }> {
  const nonce = randomBytes(24).toString('base64url');
  await pool.query('select tab.mint_device_nonce($1, $2)', [nonceHmac(nonceKey, nonce, boundTo), NONCE_TTL_SECONDS]);
  return { nonce, expiresInSeconds: NONCE_TTL_SECONDS };
}

/**
 * True when the nonce was minted here for the same key (`boundTo`), unused and unexpired; it is used up either way.
 * A nonce minted for another key is not found (and stays usable by the key it was minted for).
 */
export async function consumeNonce(pool: pg.Pool, nonceKey: string, nonce: string, boundTo: string | null): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>('select tab.consume_device_nonce($1) as ok', [nonceHmac(nonceKey, nonce, boundTo)]);
  return rows[0]?.ok === true;
}
