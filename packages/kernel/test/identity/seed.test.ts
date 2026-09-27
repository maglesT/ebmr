import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seedActor, seedAdministration, seedServiceActor, withFreshAuth } from './seed.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

async function insertSample(ctx: Parameters<typeof withCommand>[1], batch = randomUUID()) {
  await withCommand(db.app, ctx, (c) => c.query('insert into testgmp.sample (batch_id, value) values ($1, 1)', [batch]));
  const { rows } = await db.app.query<{ payload: { actor: Record<string, string>; source: string } }>(
    'select payload from kernel.audit_event where chain_key = $1',
    [`batch:${batch}`],
  );
  return rows[0]?.payload;
}

describe('seeded identities', () => {
  it('[DI-14] the installation bootstrap yields an administrator and a process owner who can run commands', async () => {
    const { admin, owner } = await seedAdministration(db);
    expect(admin.personId).not.toBe(owner.personId);
    const { rows } = await db.app.query('select * from iam.directory_scan()');
    expect(rows).toEqual([]);
  });

  it('[DI-14] a seeded operator on a personal device runs a GMP command attributed to their person, account, session and device', async () => {
    const op = await seedActor(db);
    const p = await insertSample(op);
    expect(p?.actor['person_id']).toBe(op.personId);
    expect(p?.actor['account_id']).toBe(op.accountId);
    expect(p?.actor['session_id']).toBe(op.sessionId);
    expect(p?.actor['device_id']).toBe(op.deviceId);
    expect(p?.actor['legal_name']).toBe(op.legalName);
  });

  it('[DI-14][INV-40] a seeded operator on a shared device runs one command per fresh badge tap', async () => {
    const op = await seedActor(db, { deviceClass: 'SHARED' });
    const p = await insertSample(op);
    expect(p?.actor['auth_event_id']).toBe(op.authEventId);
    await expect(insertSample(op)).rejects.toThrow('EBMR-IAM-126');
    const again = await withFreshAuth(db, op);
    expect((await insertSample(again))?.actor['auth_event_id']).toBe(again.authEventId);
  });

  it('[DI-14] a seeded service account runs commands with source SYSTEM', async () => {
    const svc = await seedServiceActor(db);
    const p = await insertSample(svc);
    expect(p?.source).toBe('SYSTEM');
    expect(p?.actor['role_code']).toBe('SERVICE_ACCOUNT');
  });
});
