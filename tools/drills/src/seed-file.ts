/**
 * The DEMO-ONLY keys directory of a demo or E2E installation (apps/tablets-server/src/cli/setup.ts): the seed with its
 * people's credentials and the HMAC seal key. The drills read them to sign a drill's restore event in a restored copy.
 */
import { readFileSync } from 'node:fs';
import { esig } from '@ebmr/kernel';
import type { SiteSeed } from '@ebmr/test-kit';

export function seedOf(file: string): SiteSeed {
  const s = JSON.parse(readFileSync(file, 'utf8')) as SiteSeed;
  if (s.installation !== 'GMP' || !Array.isArray(s.personas) || !s.bootstrap) throw new Error(`${file} is not the seed of a GMP installation`);
  return s;
}

export function sealKeyOf(file: string): esig.SealKeyProvider {
  const k = JSON.parse(readFileSync(file, 'utf8')) as { keyId?: unknown; algorithm?: unknown; secret?: unknown };
  if (typeof k.keyId !== 'string' || k.algorithm !== 'HMAC-SHA256' || typeof k.secret !== 'string') throw new Error(`${file} is not an HMAC-SHA256 seal key file`);
  return esig.hmacSealKey(k.keyId, Buffer.from(k.secret, 'base64'));
}
