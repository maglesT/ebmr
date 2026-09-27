import { randomUUID } from 'node:crypto';
import type { ActorContext } from '../../src/db/command.ts';

export function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    personId: randomUUID(),
    accountId: randomUUID(),
    roleCode: 'OPERATOR',
    sessionId: randomUUID(),
    source: 'UI',
    siteZone: 'Asia/Kolkata',
    legalName: 'Test Operator',
    ...overrides,
  };
}
