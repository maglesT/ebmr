/**
 * Policy versioning (build outline 3.5, 5.8; L-25) and INV-47: no policy loosening applies to a
 * batch issued before the loosening's effective date. Attacked through raw SQL (application role and
 * superuser) and through the functions.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext } from '../../src/db/command.ts';
import { applyPolicyTightening, batchPolicy, definePolicy, pinPoliciesForBatch, policyForBatch, setPolicyVersion, type PolicyVersion } from '../../src/market/policy.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asApp, testActor } from './helpers.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An instant relative to the database clock (the only authoritative clock, INV-16). */
async function dbInstant(offset: string): Promise<string> {
  const { rows } = await db.app.query<{ t: Date }>(`select clock_timestamp() + $1::interval as t`, [offset]);
  return (rows[0]?.t as Date).toISOString();
}

async function asAdmin(sql: string, params: unknown[] = [], reasonCode?: string): Promise<void> {
  const client = await db.admin.connect();
  try {
    await client.query('begin');
    await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(await testActor(db, reasonCode ? { reasonCode } : {})))]);
    await client.query(sql, params);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

let seq = 0;
async function newPolicy(positions: string[], defaultPosition: string): Promise<{ code: string; v1: PolicyVersion }> {
  seq += 1;
  const code = `S${seq}.test${randomUUID().slice(0, 6)}`;
  const v1 = await asApp(db, (c) => definePolicy(c, { code, title: `test policy ${seq}`, level: 'TENANT', positions, defaultPosition, controls: ['DI-09'] }));
  return { code, v1 };
}

describe('policies as versioned data', () => {
  it('[INV-47] a policy starts at its default position and each change is a numbered version with a direction', async () => {
    const { code, v1 } = await newPolicy(['OFF', 'ON'], 'ON');
    expect([v1.version, v1.position, v1.direction]).toEqual([1, 'ON', 'INITIAL']);
    const later = await dbInstant('1 hour');
    const v2 = await asApp(db, (c) => setPolicyVersion(c, code, 'OFF', { effectiveFrom: later, approvalId: randomUUID(), changeRef: 'CC-101' }));
    expect([v2.version, v2.direction]).toEqual([2, 'LOOSENING']);
    const later2 = await dbInstant('2 hours');
    const v3 = await asApp(db, (c) => setPolicyVersion(c, code, 'ON', { effectiveFrom: later2, changeRef: 'CC-102' }));
    expect([v3.version, v3.direction]).toEqual([3, 'TIGHTENING']);
  });

  it('[INV-47] policy_for_batch returns the version in force at the batch issue instant', async () => {
    const { code, v1 } = await newPolicy(['OFF', 'ON'], 'ON');
    const effective = await dbInstant('1 hour');
    const v2 = await asApp(db, (c) => setPolicyVersion(c, code, 'OFF', { effectiveFrom: effective, approvalId: randomUUID(), changeRef: 'CC-103' }));
    expect((await policyForBatch(db.app, code, await dbInstant('1 minute'))).id).toBe(v1.id);
    expect((await policyForBatch(db.app, code, await dbInstant('59 minutes'))).id).toBe(v1.id);
    expect((await policyForBatch(db.app, code, effective)).id).toBe(v2.id);
    await expect(policyForBatch(db.app, code, await dbInstant('-1 day'))).rejects.toThrow('EBMR-MKT-086');
  });

  it('[INV-47] a version can never take effect in the past, through the function or through raw SQL as the owner', async () => {
    const { code } = await newPolicy(['OFF', 'ON'], 'ON');
    const past = await dbInstant('-1 minute');
    await expect(asApp(db, (c) => setPolicyVersion(c, code, 'OFF', { effectiveFrom: past, approvalId: randomUUID(), changeRef: 'CC-104' }))).rejects.toThrow('EBMR-MKT-070');
    await expect(
      asAdmin(
        "insert into market.policy_version (policy_code, position, effective_from, approval_id, change_ref, reason) values ($1, 'OFF', $2, $3, 'CC-105', 'back-dated')",
        [code, past, randomUUID()],
      ),
    ).rejects.toThrow('EBMR-MKT-070');
  });

  it('[INV-47] a loosening needs an approval record and a change reference; a version cannot be slipped in before a scheduled one', async () => {
    const { code } = await newPolicy(['OFF', 'ON'], 'ON');
    await expect(asApp(db, (c) => setPolicyVersion(c, code, 'OFF', { changeRef: 'CC-106' }))).rejects.toThrow('EBMR-MKT-073');
    await expect(asApp(db, (c) => setPolicyVersion(c, code, 'OFF', { approvalId: randomUUID() }))).rejects.toThrow('EBMR-MKT-073');
    await expect(asApp(db, (c) => setPolicyVersion(c, code, 'MAYBE', { changeRef: 'CC-106' }))).rejects.toThrow('EBMR-MKT-071');
    await asApp(db, async (c) => setPolicyVersion(c, code, 'OFF', { effectiveFrom: await dbInstant('2 hours'), approvalId: randomUUID(), changeRef: 'CC-107' }));
    await expect(asApp(db, async (c) => setPolicyVersion(c, code, 'ON', { effectiveFrom: await dbInstant('1 hour'), changeRef: 'CC-108' }))).rejects.toThrow('EBMR-MKT-072');
  });
});

describe('INV-47: a loosening never reaches a batch issued before it took effect', () => {
  let code: string;
  let v1: PolicyVersion;
  let loosening: PolicyVersion;
  const early = randomUUID();
  const late = randomUUID();

  beforeAll(async () => {
    ({ code, v1 } = await newPolicy(['ONE_VERIFIER', 'TWO_PERSONS'], 'TWO_PERSONS'));
    loosening = await asApp(db, async (c) => setPolicyVersion(c, code, 'ONE_VERIFIER', { effectiveFrom: await dbInstant('2 seconds'), approvalId: randomUUID(), changeRef: 'CC-S5a' }));
    await asApp(db, (c) => pinPoliciesForBatch(c, early));
    await sleep(2300);
    await asApp(db, (c) => pinPoliciesForBatch(c, late));
  });

  it('[INV-47] batches pin the version in force at issue: the earlier batch keeps the stricter one, the later batch gets the loosening', async () => {
    expect(loosening.direction).toBe('LOOSENING');
    expect((await batchPolicy(db.app, early, code))?.versionId).toBe(v1.id);
    expect((await batchPolicy(db.app, late, code))?.versionId).toBe(loosening.id);
    const pin = await batchPolicy(db.app, early, code);
    expect((await policyForBatch(db.app, code, pin?.issueInstant ?? '')).id).toBe(v1.id);
  });

  it('[INV-47] bypass through the function: applying the loosening to the earlier batch is refused', async () => {
    await expect(asApp(db, (c) => applyPolicyTightening(c, early, code, loosening.id, 'CC-S5a'))).rejects.toThrow('EBMR-MKT-085');
    expect((await batchPolicy(db.app, early, code))?.position).toBe('TWO_PERSONS');
  });

  it('[INV-47] bypass through raw SQL as the application role: no write privilege on versions or pins', async () => {
    await expect(
      asApp(db, (c) =>
        c.query("insert into market.batch_policy_pin (batch_id, policy_code, policy_version_id, pin_kind, issue_instant, change_ref) values ($1, $2, $3, 'TIGHTENING', now(), 'x')", [
          early,
          code,
          loosening.id,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(asApp(db, (c) => c.query('update market.batch_policy_pin set policy_version_id = $1 where batch_id = $2', [loosening.id, early]), { reasonCode: 'X' })).rejects.toThrow(
      /permission denied/,
    );
    await expect(asApp(db, (c) => c.query("update market.policy_version set effective_from = '2000-01-01' where id = $1", [loosening.id]), { reasonCode: 'X' })).rejects.toThrow(
      /permission denied/,
    );
    await expect(asApp(db, (c) => c.query('delete from market.batch_policy_pin where batch_id = $1', [early]), { reasonCode: 'X' })).rejects.toThrow(/permission denied/);
  });

  it('[INV-47] bypass through raw SQL as the table owner: the pin trigger refuses the loosening and rows are insert-only', async () => {
    await expect(
      asAdmin("insert into market.batch_policy_pin (batch_id, policy_code, policy_version_id, pin_kind, change_ref) values ($1, $2, $3, 'TIGHTENING', 'CC-X')", [
        early,
        code,
        loosening.id,
      ]),
    ).rejects.toThrow('EBMR-MKT-085');
    const pin = await batchPolicy(db.app, early, code);
    await expect(
      asAdmin("insert into market.batch_policy_pin (batch_id, policy_code, policy_version_id, pin_kind, issue_instant) values ($1, $2, $3, 'ISSUE', $4)", [
        randomUUID(),
        code,
        loosening.id,
        pin?.issueInstant,
      ]),
    ).rejects.toThrow('EBMR-MKT-082');
    await expect(asAdmin('update market.batch_policy_pin set policy_version_id = $1 where batch_id = $2', [loosening.id, early], 'CORRECTION')).rejects.toThrow('EBMR-AUDIT-004');
    await expect(asAdmin('update market.policy_version set effective_from = $1 where id = $2', ['2000-01-01', loosening.id], 'CORRECTION')).rejects.toThrow('EBMR-AUDIT-004');
    expect((await batchPolicy(db.app, early, code))?.versionId).toBe(v1.id);
  });

  it('[INV-47] a tightening already in force may apply to a running batch at once; the same version cannot be applied twice', async () => {
    const tightening = await asApp(db, (c) => setPolicyVersion(c, code, 'TWO_PERSONS', { changeRef: 'CC-S5a-back' }));
    expect(tightening.direction).toBe('TIGHTENING');
    await asApp(db, (c) => applyPolicyTightening(c, late, code, tightening.id, 'CC-S5a-back', 'QA decision'));
    expect((await batchPolicy(db.app, late, code))).toMatchObject({ pinKind: 'TIGHTENING', position: 'TWO_PERSONS' });
    await expect(asApp(db, (c) => applyPolicyTightening(c, late, code, tightening.id, 'CC-S5a-back'))).rejects.toThrow('EBMR-MKT-085');
  });

  it('[INV-47] a batch is pinned once, at issue', async () => {
    await expect(asApp(db, (c) => pinPoliciesForBatch(c, early))).rejects.toThrow('EBMR-MKT-087');
  });
});
