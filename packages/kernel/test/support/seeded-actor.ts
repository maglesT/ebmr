/**
 * Real identities for tests of every module. kernel.validate_actor_context (identity module, 0190)
 * refuses unknown persons, accounts and sessions, so each call seeds a fresh person with an active
 * account, an approved role grant, a registered device and an open session.
 *
 * Source SYSTEM or INTEGRATION seeds a service identity (roleCode SERVICE_ACCOUNT). Other overrides
 * that are not part of the identity (site zone, reason, correlation id) are applied on top.
 */
import type { ActorContext } from '../../src/db/command.ts';
import { seedActor, seedServiceActor } from '../identity/seed.ts';
import type { TestDatabase } from './db.ts';

export async function seededTestActor(db: TestDatabase, overrides: Partial<ActorContext> = {}): Promise<ActorContext> {
  const { roleCode, source, legalName, personId, accountId, sessionId, deviceId, ...rest } = overrides;
  if (personId !== undefined || accountId !== undefined || sessionId !== undefined || deviceId !== undefined) {
    throw new Error('seededTestActor: identity fields cannot be overridden; spread an existing actor instead');
  }
  const service = source === 'SYSTEM' || source === 'INTEGRATION' || roleCode === 'SERVICE_ACCOUNT' || roleCode === 'SYSTEM';
  const base = service
    ? await seedServiceActor(db, {
        source: source === 'INTEGRATION' ? 'INTEGRATION' : 'SYSTEM',
        ...(source === 'INTEGRATION' ? { kind: 'INTEGRATION' as const } : {}),
        ...(legalName ? { name: legalName } : {}),
      })
    : await seedActor(db, {
        ...(roleCode ? { roleCode } : {}),
        ...(legalName ? { legalName } : {}),
        ...(source === 'UI' || source === 'API' ? { source } : {}),
      });
  const { seed: _seed, ...ctx } = base;
  void _seed;
  return { ...ctx, ...rest };
}
