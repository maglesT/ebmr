/**
 * The release gate of a bottle line's checks (SQL mutation group "packaging-bottle", tablets 0987, tab.packline_pass_check):
 * a passing check of the unit of a TB-23 or TB-24 step of the batch is recorded only from a passing check or challenge
 * entry of that step, of that block, for that unit and stream, once. A unit no such step runs is not held to the rule.
 * This rule exists only in the database (the engine records entries; the check row is the plant's).
 *
 * The batch, its MBR content and its engine state are written by the superuser with session_replication_role = replica
 * in a transaction that is always rolled back, with this one trigger enabled ALWAYS, so the check row meets the rule
 * alone. Each case below breaks exactly one condition of the rule.
 *
 * Controls: PR-37, IN-22.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startServer('GMP');
}, 180_000);
afterAll(async () => {
  await gmp?.close();
});

const phase = (id: string, type: string, unit: string) => ({ kind: 'phase', id, name: id, block: { type, version: '1' }, config: { unit } });
const CONTENT = { procedure: { kind: 'sequence', id: 'root', children: [phase('P23', 'TB-23', 'LINE-1'), phase('P24', 'TB-24', 'CART-1')] } };
const entry = (stepKey: string, kind: string, data: Record<string, unknown>) => ({ stepKey, kind, data });
const STATE = {
  steps: { K23: { step: 'P23' }, K24: { step: 'P24' } },
  entries: {
    'EN-1': entry('K23', 'CHECK', { result: 'PASS', stream: 'S1' }),
    'EN-2': entry('K23', 'CHALLENGE', { result: 'PASS', device: 'MD' }),
    'EN-3': entry('K23', 'CHECK', { result: 'FAIL', stream: 'S1' }),
  },
};

async function withBatch<T>(work: (c: PoolClient, batch: string) => Promise<T>): Promise<T> {
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query("set local session_replication_role = 'replica'");
    await c.query('alter table plant.ipc_check enable always trigger aa_tab_packline_pass');
    const id = randomUUID();
    const hash = createHash('sha256').update(id).digest('hex');
    await c.query(
      `insert into recipe.test_package (package_hash, file_name, package, content, content_hash, family_id, family_code, product, version_id, version_number,
                                        revision, version_state, exporter, exported_at_us, source, imported_by_person, imported_by_account, correlation_id)
       values ($1, $1 || '.json', '{}', $2::jsonb, $1, gen_random_uuid(), 'FAM', '{"code": "P1"}', gen_random_uuid(), '1', 1, 'APPROVED', '{}', 0, '{}',
               gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
      [hash, JSON.stringify(CONTENT)],
    );
    await c.query(
      `insert into recipe.batch_execution (id, batch_number, package_hash, content_hash, installation, purpose, engine_version, registry_fingerprint, policy,
                                           policy_hash, issue_request, market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person,
                                           issued_by_account, correlation_id)
       values ($1, $2, $3, $3, 'SANDBOX', 'SANDBOX_TEST_RUN', '1', $3, '{}', $3, '{}', '{IN}', 'BS', 'SITE-1', 'Asia/Kolkata', 0, gen_random_uuid(),
               gen_random_uuid(), gen_random_uuid())`,
      [id, `TEST-PACK-${id.slice(0, 8)}`, hash],
    );
    await c.query(
      "insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status) values ($1, $2::jsonb, 1, $3, 3, $3, 'IN_PROGRESS')",
      [id, JSON.stringify(STATE), hash],
    );
    return await work(c, id);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** Records a check row; '' when accepted, else the refusal's code. */
async function check(c: PoolClient, batch: string, unit: string, stream: string | null, result: string, reference: string): Promise<string> {
  await c.query('savepoint s');
  try {
    await c.query(
      'insert into plant.ipc_check (batch_id, press_code, stream, result, reference, person_id, account_id) values ($1, $2, $3, $4, $5, gen_random_uuid(), gen_random_uuid())',
      [batch, unit, stream, result, reference],
    );
    await c.query('release savepoint s');
    return '';
  } catch (e) {
    await c.query('rollback to savepoint s');
    return /EBMR-[A-Z]+-\d{3}/.exec(e instanceof Error ? e.message : String(e))?.[0] ?? String(e);
  }
}

describe('a passing check of a bottle line unit rests on a passing entry of its step (tablets 0987)', () => {
  it('[PR-37][IN-22] a passing check or challenge entry vouches for its unit and stream; a unit no TB-23 or TB-24 step runs is not held to the rule; failures need no entry', async () => {
    await withBatch(async (c, b) => {
      expect(await check(c, b, 'LINE-1', 'S1', 'PASS', 'TB23:K23:EN-1')).toBe('');
      expect(await check(c, b, 'LINE-1', 'D.MD', 'PASS', 'TB23:K23:EN-2')).toBe('');
      expect(await check(c, b, 'PRESS-9', 'S1', 'PASS', 'operator says so')).toBe('');
      expect(await check(c, b, 'LINE-1', 'S1', 'FAIL', 'operator says so')).toBe('');
    });
  });

  it('[PR-37][IN-22] refused, each for one reason: another block, another step, another unit, a failing entry, another stream, a malformed or unknown reference, the same reference twice', async () => {
    await withBatch(async (c, b) => {
      const refused = 'EBMR-TAB-382';
      expect(await check(c, b, 'LINE-1', 'S1', 'PASS', 'TB24:K23:EN-1')).toBe(refused);
      expect(await check(c, b, 'CART-1', 'S1', 'PASS', 'TB24:K24:EN-1')).toBe(refused);
      expect(await check(c, b, 'CART-1', 'S1', 'PASS', 'TB23:K23:EN-1')).toBe(refused);
      expect(await check(c, b, 'LINE-1', 'S1', 'PASS', 'TB23:K23:EN-3')).toBe(refused);
      expect(await check(c, b, 'LINE-1', 'S2', 'PASS', 'TB23:K23:EN-1')).toBe(refused);
      expect(await check(c, b, 'LINE-1', 'MD', 'PASS', 'TB23:K23:EN-2')).toBe(refused);
      expect(await check(c, b, 'LINE-1', 'S1', 'PASS', 'TB23:K23:EN-99')).toBe(refused);
      expect(await check(c, b, 'LINE-1', 'S1', 'PASS', 'operator says so')).toBe(refused);
      expect(await check(c, b, 'LINE-1', 'S1', 'PASS', 'TB23:K23:EN-1')).toBe('');
      expect(await check(c, b, 'LINE-1', 'S1', 'PASS', 'TB23:K23:EN-1')).toBe(refused);
    });
  });
});
