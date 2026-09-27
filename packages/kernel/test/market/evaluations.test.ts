/**
 * INV-29: every rule evaluation stores value, governing market, predicate branch and rule-table
 * version; only market.record_evaluation (via market.evaluate_stub_scope in Phase 1) writes them,
 * and not even the table owner can store a result the rule table does not give.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext } from '../../src/db/command.ts';
import { evaluateStubScope, type StoredEvaluation } from '../../src/market/repository.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asApp, publishSeedTables, seedStubWorld, testActor, type StubWorld } from './helpers.ts';

let db: TestDatabase;
let world: StubWorld;
let tablets: string;
let evaluation: StoredEvaluation;
beforeAll(async () => {
  db = await createTestDatabase();
  tablets = (await publishSeedTables(db)).get('tablets') ?? '';
  world = await seedStubWorld(db);
  evaluation = await asApp(db, (c) =>
    evaluateStubScope(c, { key: 'tablets.compression.ipcSampleMaxInterval', scope: { kind: 'PRODUCT', id: world.batch.tabletAll }, resolutionPoint: 'BATCH_ISSUE', asOf: '2026-02-01' }),
  );
});
afterAll(async () => {
  await db.drop();
});

/** Run raw SQL as the owner-equivalent superuser inside a declared command (for bypass attempts). */
async function asAdmin(sql: string, params: unknown[] = [], reasonCode?: string): Promise<void> {
  const client = await db.admin.connect();
  try {
    await client.query('begin');
    const ctx = toDbContext(await testActor(db, reasonCode ? { reasonCode } : {}));
    await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(ctx)]);
    await client.query(sql, params);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

describe('what an evaluation stores', () => {
  it('[INV-29][IN-52] value, governing market, predicate branch, rule-table version, inputs and their hash are stored', async () => {
    const { rows } = await db.app.query<{
      resolved_value: string;
      governing_markets: string[];
      predicate_branch: Record<string, unknown>;
      table_version_id: string;
      table_version: number;
      inputs: Record<string, unknown>;
      hash: string;
      text: string;
      recorded_at: Date;
    }>(
      "select resolved_value, governing_markets, predicate_branch, table_version_id, table_version, inputs, encode(inputs_hash, 'hex') as hash, inputs::text as text, recorded_at from market.evaluation where id = $1",
      [evaluation.id],
    );
    const e = rows[0];
    expect(e?.resolved_value).toBe('30');
    expect(e?.governing_markets).toEqual(['IN']);
    expect(e?.predicate_branch).toEqual({ IN: {} });
    expect(e?.table_version_id).toBe(tablets);
    expect(e?.table_version).toBe(1);
    expect(e?.inputs).toMatchObject({ key: 'tablets.compression.ipcSampleMaxInterval', asOf: '2026-02-01', marketSet: ['EU', 'IN', 'US'], resolutionPoint: 'BATCH_ISSUE' });
    expect(e?.hash).toBe(createHash('sha256').update(e?.text ?? '').digest('hex'));
    expect(e?.recorded_at).toBeInstanceOf(Date);
  });

  it('[INV-29] each evaluation writes an audit event in the subject chain in the same transaction', async () => {
    const { rows } = await db.app.query<{ action: string; record_id: string }>(
      'select action, record_id from kernel.audit_event where chain_key = $1 and table_name = $2',
      [`market_evaluation:${world.batch.tabletAll}`, 'market.evaluation'],
    );
    expect(rows).toContainEqual({ action: 'INSERT', record_id: evaluation.id });
  });

  it('[INV-29] an evaluation cannot be recorded without a declared actor', async () => {
    await expect(
      db.app.query('select market.evaluate_stub_scope($1::jsonb)', [
        JSON.stringify({ key: 'tablets.compression.ipcSampleMaxInterval', scope: { kind: 'PRODUCT', id: world.batch.tabletIn }, resolutionPoint: 'EXECUTION', asOf: '2026-02-01' }),
      ]),
    ).rejects.toThrow('EBMR-IAM-001'); // the authority check (DI-17) needs a declared actor before anything else
  });
});

describe('INV-29 bypass attempts', () => {
  it('[INV-29] the application role cannot insert, change or delete evaluation rows directly', async () => {
    await expect(
      asApp(db, (c) =>
        c.query(
          `insert into market.evaluation (subject_type, subject_id, resolution_point, scope_kind, scope_id, key, table_version_id, as_of, market_set, market_derivation, predicates)
           values ('BATCH', $1, 'RELEASE', 'PRODUCT', $1, 'tablets.compression.ipcSampleMaxInterval', $2, '2026-02-01', '{IN}', '[]', '{}')`,
          [world.batch.tabletIn, tablets],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(asApp(db, (c) => c.query(`update market.evaluation set resolved_value = '"60"' where id = $1`, [evaluation.id]), { reasonCode: 'X' })).rejects.toThrow(/permission denied/);
    await expect(asApp(db, (c) => c.query('delete from market.evaluation where id = $1', [evaluation.id]), { reasonCode: 'X' })).rejects.toThrow(/permission denied/);
    await expect(asApp(db, (c) => c.query('truncate market.evaluation'))).rejects.toThrow(/permission denied/);
  });

  it('[INV-29] the application role cannot call the internal writer with a market set of its choosing', async () => {
    await expect(
      asApp(db, (c) =>
        c.query('select market.record_evaluation($1::jsonb)', [
          JSON.stringify({ key: 'tablets.compression.ipcSampleMaxInterval', scope: { kind: 'PRODUCT', id: world.batch.tabletAll }, resolutionPoint: 'RELEASE', asOf: '2026-02-01', markets: ['IN'] }),
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('[INV-29] even the table owner cannot store a value the rule table does not give', async () => {
    const fabricated = { ...evaluation.resolution, value: '45' };
    await expect(
      asAdmin(
        `insert into market.evaluation (subject_type, subject_id, resolution_point, scope_kind, scope_id, key, table_version_id, as_of, market_set, market_derivation, predicates, resolution)
         values ('BATCH', $1, 'RELEASE', 'PRODUCT', $1, 'tablets.compression.ipcSampleMaxInterval', $2, '2026-02-01', '{IN,US,EU}', '[]', '{}', $3)`,
        [world.batch.tabletAll, tablets, JSON.stringify(fabricated)],
      ),
    ).rejects.toThrow('EBMR-MKT-053');
    await expect(
      asAdmin(
        `insert into market.evaluation (subject_type, subject_id, resolution_point, scope_kind, scope_id, key, table_version_id, as_of, market_set, market_derivation, predicates, effective_value)
         values ('BATCH', $1, 'RELEASE', 'PRODUCT', $1, 'tablets.compression.ipcSampleMaxInterval', $2, '2026-02-01', '{IN,US,EU}', '[]', '{}', '"45"')`,
        [world.batch.tabletAll, tablets],
      ),
    ).rejects.toThrow('EBMR-MKT-053');
  });

  it('[INV-29][INV-28] even the table owner cannot store an evaluation for a market set without India', async () => {
    await expect(
      asAdmin(
        `insert into market.evaluation (subject_type, subject_id, resolution_point, scope_kind, scope_id, key, table_version_id, as_of, market_set, market_derivation, predicates)
         values ('BATCH', $1, 'RELEASE', 'PRODUCT', $1, 'tablets.compression.ipcSampleMaxInterval', $2, '2026-02-01', '{US,EU}', '[]', '{}')`,
        [randomUUID(), tablets],
      ),
    ).rejects.toThrow('EBMR-MKT-001');
  });

  it('[INV-29] stored evaluations are insert-only even for the table owner', async () => {
    await expect(asAdmin(`update market.evaluation set resolved_value = '"60"' where id = $1`, [evaluation.id], 'CORRECTION')).rejects.toThrow('EBMR-AUDIT-004');
    await expect(asAdmin('delete from market.evaluation where id = $1', [evaluation.id], 'CORRECTION')).rejects.toThrow('EBMR-AUDIT-004');
    await expect(db.admin.query('truncate market.evaluation')).rejects.toThrow('EBMR-AUDIT-004');
  });

  it('[INV-29] an evaluation pinned to version 1 stays reproducible: re-resolving its stored inputs gives the stored result', async () => {
    const { rows } = await db.app.query<{ same: boolean }>(
      `select market.resolve(e.table_version_id, e.key, e.market_set, e.predicates, e.as_of, e.stated) = e.resolution as same
         from market.evaluation e where e.id = $1`,
      [evaluation.id],
    );
    expect(rows[0]?.same).toBe(true);
  });
});
