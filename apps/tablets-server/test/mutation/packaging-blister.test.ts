/**
 * The release gate of the in-process checks (SQL mutation group "packaging-blister", tablets 0972, tab.ipc_pass_check):
 * a passing check that vouches for containers of a batch whose MBR runs a TB-11 scheduler, a roller compaction (TB-06),
 * a blister run (TB-21) or a leak test (TB-22) is recorded only from a passing check entry of such a step, for its unit
 * and stream, once. This rule exists only in the database (the engine records entries; the check row is the plant's).
 *
 * The batch, its MBR content and its engine state are written by the superuser with session_replication_role =
 * replica in a transaction that is always rolled back, with this one trigger enabled ALWAYS, so the check row meets the
 * rule alone.
 *
 * Controls: PR-29, IN-35, IN-38.
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

const phase = (id: string, type: string) => ({ kind: 'phase', id, name: id, block: { type, version: '1' }, config: {} });
const CONTENT = { procedure: { kind: 'sequence', id: 'root', children: [phase('P21', 'TB-21'), phase('P22', 'TB-22'), phase('P11', 'TB-11'), phase('P06', 'TB-06')] } };
const entry = (stepKey: string, kind: string, seq: number, data: Record<string, unknown>) => ({ stepKey, kind, recordedSeq: seq, data });
const STATE = {
  steps: { K21: { step: 'P21' }, K22: { step: 'P22' }, K11: { step: 'P11' }, K06: { step: 'P06' } },
  entries: {
    'EN-1': entry('K21', 'RUN_START', 1, { machine: 'BLI-1' }),
    'EN-2': entry('K21', 'DEFECT_CHECK', 2, { result: 'PASS' }),
    'EN-3': entry('K22', 'RUN_START', 3, { machine: 'BLI-1' }),
    'EN-4': entry('K22', 'LEAK_TEST', 4, { result: 'PASS', track: 'T1' }),
    'EN-5': entry('K11', 'RUN_START', 5, { press: 'PR-1' }),
    'EN-6': entry('K11', 'WEIGHT_CHECK', 6, { result: 'PASS', stream: 'L' }),
    'EN-7': entry('K06', 'RUN_START', 7, { press: 'PR-6' }),
    'EN-8': entry('K06', 'RIBBON_CHECK', 8, { result: 'PASS' }),
    'EN-9': entry('K06', 'SCREEN_CHECK', 9, { result: 'INTACT' }),
    'EN-10': entry('K21', 'DEFECT_CHECK', 10, { result: 'FAIL' }),
    'EN-11': entry('K11', 'WEIGHT_CHECK', 11, { result: 'FAIL', stream: 'L' }),
    'EN-12': entry('K22', 'LEAK_TEST', 12, { result: 'FAIL', track: 'T1' }),
    'EN-13': entry('K06', 'SCREEN_CHECK', 13, { result: 'DAMAGED' }),
  },
};

/** A batch running CONTENT in STATE (or the given ones), then `work`; everything rolled back. */
async function withBatch<T>(work: (c: PoolClient, batch: string) => Promise<T>, content: unknown = CONTENT): Promise<T> {
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query("set local session_replication_role = 'replica'");
    await c.query('alter table plant.ipc_check enable always trigger aa_tab_ipc_pass');
    const id = randomUUID();
    const hash = createHash('sha256').update(id).digest('hex');
    await c.query(
      `insert into recipe.test_package (package_hash, file_name, package, content, content_hash, family_id, family_code, product, version_id, version_number,
                                        revision, version_state, exporter, exported_at_us, source, imported_by_person, imported_by_account, correlation_id)
       values ($1, $1 || '.json', '{}', $2::jsonb, $1, gen_random_uuid(), 'FAM', '{"code": "P1"}', gen_random_uuid(), '1', 1, 'APPROVED', '{}', 0, '{}',
               gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
      [hash, JSON.stringify(content)],
    );
    await c.query(
      `insert into recipe.batch_execution (id, batch_number, package_hash, content_hash, installation, purpose, engine_version, registry_fingerprint, policy,
                                           policy_hash, issue_request, market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person,
                                           issued_by_account, correlation_id)
       values ($1, $2, $3, $3, 'SANDBOX', 'SANDBOX_TEST_RUN', '1', $3, '{}', $3, '{}', '{IN}', 'BS', 'SITE-1', 'Asia/Kolkata', 0, gen_random_uuid(),
               gen_random_uuid(), gen_random_uuid())`,
      [id, `TEST-PASS-${id.slice(0, 8)}`, hash],
    );
    await c.query(
      `insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status)
       values ($1, $2::jsonb, 1, $3, 13, $3, 'IN_PROGRESS')`,
      [id, JSON.stringify(STATE), hash],
    );
    return await work(c, id);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** Records a check row; '' when accepted, else the refusal's code. */
async function check(c: PoolClient, batch: string, press: string, stream: string | null, result: string, reference: string): Promise<string> {
  await c.query('savepoint s');
  try {
    await c.query(
      'insert into plant.ipc_check (batch_id, press_code, stream, result, reference, person_id, account_id) values ($1, $2, $3, $4, $5, gen_random_uuid(), gen_random_uuid())',
      [batch, press, stream, result, reference],
    );
    await c.query('release savepoint s');
    return '';
  } catch (e) {
    await c.query('rollback to savepoint s');
    return /EBMR-[A-Z]+-\d{3}/.exec(e instanceof Error ? e.message : String(e))?.[0] ?? String(e);
  }
}

describe('a passing in-process check rests on a passing check entry of its step, unit and stream, once (tablets 0972)', () => {
  it('[PR-29][IN-35][IN-38] the passing entries of TB-21, TB-22, TB-11 and TB-06 vouch for their own unit and stream', async () => {
    await withBatch(async (c, b) => {
      expect(await check(c, b, 'BLI-1', 'LINE', 'PASS', 'TB21:K21:EN-2')).toBe('');
      expect(await check(c, b, 'BLI-1', 'T1', 'PASS', 'TB22:K22:EN-4')).toBe('');
      expect(await check(c, b, 'PR-1', 'L', 'PASS', 'TB11:K11:EN-6')).toBe('');
      expect(await check(c, b, 'PR-6', 'RIBBON', 'PASS', 'TB06:K06:EN-8')).toBe('');
      expect(await check(c, b, 'PR-6', 'MILL', 'PASS', 'TB06:K06:EN-9')).toBe('');
      // A failing or missed check needs no entry.
      expect(await check(c, b, 'BLI-1', 'LINE', 'FAIL', 'anything')).toBe('');
      expect(await check(c, b, 'BLI-1', 'LINE', 'MISSED', 'anything')).toBe('');
    });
  });

  it('[PR-29][IN-35][IN-38] refused: a failing entry, another unit or stream, another step or block, an unknown entry, a malformed reference, the same reference twice', async () => {
    await withBatch(async (c, b) => {
      const refused = 'EBMR-TAB-302';
      expect(await check(c, b, 'BLI-1', 'LINE', 'PASS', 'TB21:K21:EN-10')).toBe(refused);
      expect(await check(c, b, 'BLI-1', 'T1', 'PASS', 'TB21:K21:EN-2')).toBe(refused);
      expect(await check(c, b, 'BLI-2', 'LINE', 'PASS', 'TB21:K21:EN-2')).toBe(refused);
      expect(await check(c, b, 'BLI-1', 'LINE', 'PASS', 'TB21:K22:EN-2')).toBe(refused);
      expect(await check(c, b, 'BLI-1', 'LINE', 'PASS', 'TB22:K21:EN-2')).toBe(refused);
      expect(await check(c, b, 'BLI-1', 'T2', 'PASS', 'TB22:K22:EN-4')).toBe(refused);
      expect(await check(c, b, 'BLI-1', 'T1', 'PASS', 'TB22:K22:EN-12')).toBe(refused);
      expect(await check(c, b, 'BLI-1', 'T1', 'PASS', 'TB22:K22:EN-3')).toBe(refused);
      expect(await check(c, b, 'PR-1', 'L', 'PASS', 'TB11:K11:EN-11')).toBe(refused);
      expect(await check(c, b, 'PR-1', 'R', 'PASS', 'TB11:K11:EN-6')).toBe(refused);
      expect(await check(c, b, 'PR-2', 'L', 'PASS', 'TB11:K11:EN-6')).toBe(refused);
      expect(await check(c, b, 'PR-6', 'MILL', 'PASS', 'TB06:K06:EN-8')).toBe(refused);
      expect(await check(c, b, 'PR-6', 'RIBBON', 'PASS', 'TB06:K06:EN-9')).toBe(refused);
      expect(await check(c, b, 'PR-6', 'MILL', 'PASS', 'TB06:K06:EN-13')).toBe(refused);
      expect(await check(c, b, 'PR-6', 'RIBBON', 'PASS', 'TB11:K06:EN-8')).toBe(refused);
      expect(await check(c, b, 'BLI-1', 'LINE', 'PASS', 'TB21:K21:EN-99')).toBe(refused);
      expect(await check(c, b, 'BLI-1', 'LINE', 'PASS', 'TB21:K21')).toBe(refused);
      expect(await check(c, b, 'BLI-1', 'LINE', 'PASS', 'operator says so')).toBe(refused);
      expect(await check(c, b, 'BLI-1', 'LINE', 'PASS', 'TB21:K21:EN-2')).toBe('');
      expect(await check(c, b, 'BLI-1', 'LINE', 'PASS', 'TB21:K21:EN-2')).toBe(refused);
    });
  });

  it('[PR-29] a batch whose MBR runs none of these blocks is not held to the rule', async () => {
    await withBatch(async (c, b) => {
      expect(await check(c, b, 'PR-1', 'L', 'PASS', 'operator says so')).toBe('');
    }, { procedure: { kind: 'sequence', id: 'root', children: [phase('P1', 'G-07')] } });
  });
});
