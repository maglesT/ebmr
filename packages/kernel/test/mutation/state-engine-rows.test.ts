/**
 * The state engine's rows, whoever writes them, rule by rule (SQL mutation group "state-engine-rows":
 * platform.guard_state_row and platform.state_row_history_check, kernel 0550 and 1110; defect D11 of the Phase 2 exit).
 * These tests close the gaps the SQL mutation run found in test/platform/state-machine.test.ts: each condition of the
 * guards is broken alone by owner-level code that forges the engine flag (the table owner, every trigger on), and the
 * refusal is asserted by its whole message, since a later rule (another check of the same code, the commit-time check,
 * a foreign key or a unique index) would refuse the same row with another one.
 *
 * A helper machine of the sample record's aggregate type, published here as a migration would publish it, gives
 * transitions the sample record's machine does not have: its version 1 has three ways out of DRAFT (the sample record's
 * own SUBMIT among them) and a step that stays in LOST, its version 2 adds a step from DRAFT straight to DONE. Rows the product never writes even with the flag forged (a
 * history whose latest row names another machine or machine version than its state row) are arranged by the superuser
 * with every trigger off (asTimeTraveller), only to show what the guards then refuse.
 *
 * Controls: DI-34 (guarded life-cycle transitions), DI-17 (each action through its own authority check).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createAggregateState } from '../../src/state/engine.ts';
import { asTimeTraveller } from '../identity/helpers.ts';
import { asOwner, grantPermission, installStubHooks, testActor } from '../platform/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
let author: ActorContext;
const MACHINE = `mut_rows_${randomBytes(3).toString('hex')}`;
/** Aggregates of MACHINE pinned to its version 1 (created before version 2 is published), handed out one per use. */
const pinnedToV1: string[] = [];

const definition = (version: number) => ({
  machine: MACHINE,
  version,
  aggregate_type: 'sample_record',
  description: 'helper machine of the state-engine-rows mutation tests',
  create_permission: 'sample_record.submit',
  initial: 'DRAFT',
  states: ['DONE', 'DRAFT', 'KEPT', 'LOST', 'SUBMITTED'],
  final_states: ['DONE'],
  transitions: [
    { from: 'DRAFT', event: 'LOSE', to: 'LOST', guards: [], signature: null, permission: 'sample_record.submit' },
    { from: 'DRAFT', event: 'KEEP', to: 'KEPT', guards: [], signature: null, permission: 'sample_record.submit' },
    // The sample record's own first step, published for this machine too.
    { from: 'DRAFT', event: 'SUBMIT', to: 'SUBMITTED', guards: [], signature: null, permission: 'sample_record.submit' },
    { from: 'SUBMITTED', event: 'FINISH', to: 'DONE', guards: [], signature: null, permission: 'sample_record.submit' },
    { from: 'LOST', event: 'RELOSE', to: 'LOST', guards: [], signature: null, permission: 'sample_record.submit' },
    { from: 'LOST', event: 'FINISH', to: 'DONE', guards: [], signature: null, permission: 'sample_record.submit' },
    { from: 'KEPT', event: 'FINISH', to: 'DONE', guards: [], signature: null, permission: 'sample_record.submit' },
    ...(version === 2 ? [{ from: 'DRAFT', event: 'SKIP', to: 'DONE', guards: [], signature: null, permission: 'sample_record.submit' }] : []),
  ],
});

const create = (machine: string): Promise<string> =>
  withCommand(db.app, author, async (c) => {
    const id = randomUUID();
    await createAggregateState(c, machine, { aggregateType: 'sample_record', aggregateId: id });
    return id;
  });

beforeAll(async () => {
  db = await createTestDatabase();
  await installStubHooks(db);
  await grantPermission(db, 'MBR_AUTHOR', 'sample_record.submit');
  author = await testActor(db, { roleCode: 'MBR_AUTHOR' });
  await asOwner(db, `select platform.publish_machine_version('${JSON.stringify(definition(1))}'::jsonb)`);
  for (let i = 0; i < 8; i += 1) pinnedToV1.push(await create(MACHINE));
  await asOwner(db, `select platform.publish_machine_version('${JSON.stringify(definition(2))}'::jsonb)`);
}, 120_000);

afterAll(async () => {
  await db.drop();
});

/** Owner-level code with the engine flag forged, every trigger on, in one command. */
const forged = (work: (c: pg.PoolClient) => Promise<unknown>) =>
  withCommand(db.admin, { ...author, reasonCode: 'BYPASS', reasonText: 'forged engine flag' }, async (c) => {
    await c.query('set local role ebmr_owner');
    await c.query("select set_config('platform.state_engine', 'on', true)");
    await work(c);
  });

/** The message `p` is refused with ('accepted' when it is not). */
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'accepted';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

interface Row {
  machine?: string;
  machineVersion?: number;
  aggregateType?: string;
  from: string | null;
  event: string | null;
  to: string;
  fromVersion: number | null;
  toVersion: number;
  permission?: string | null;
  meaning?: string | null;
  signatureId?: string | null;
}
const HISTORY = `insert into platform.state_history (aggregate_type, aggregate_id, machine_code, machine_version, from_state, event, to_state, from_version,
                                                     to_version, permission_code, signature_meaning, signature_id, person_id, account_id, role_code, correlation_id)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'p', 'a', 'r', gen_random_uuid())`;
const historyParams = (id: string, r: Row) => [
  r.aggregateType ?? 'sample_record', id, r.machine ?? 'sample_record', r.machineVersion ?? 1, r.from, r.event, r.to, r.fromVersion, r.toVersion,
  r.permission === undefined ? 'sample_record.submit' : r.permission, r.meaning ?? null, r.signatureId ?? null,
];
const insertHistory = (c: pg.PoolClient, id: string, r: Row) => c.query(HISTORY, historyParams(id, r));
const setState = (c: pg.PoolClient, id: string, state: string, version: number) =>
  c.query("update platform.aggregate_state set state = $2, version = $3 where aggregate_type = 'sample_record' and aggregate_id = $1", [id, state, version]);
const historyRow = (id: string, what: string) => `EBMR-PLAT-077 the history row of sample_record:${id} ${what}`;
const notPublished = (machine = 'sample_record', version = 1) => `is not a published transition of ${machine} v${version}`;
const START = 'EBMR-PLAT-072 a new aggregate starts at version 1 in the initial state of a published machine version that governs its aggregate type';

describe('a state row (platform.guard_state_row on platform.aggregate_state)', () => {
  it('[DI-34][DI-17] a state row is never deleted, whatever the flag: the refusal is the deletion\'s own (EBMR-PLAT-072)', async () => {
    const id = await create('sample_record');
    expect(await outcome(forged((c) => c.query("delete from platform.aggregate_state where aggregate_type = 'sample_record' and aggregate_id = $1", [id])))).toBe(
      'EBMR-PLAT-072 aggregate state rows are never deleted',
    );
  });

  it('[DI-34][DI-17] a new state row is refused for each reason alone: a machine version that is not published, a version other than 1, a state other than the initial one (EBMR-PLAT-072)', async () => {
    const insert = (machineVersion: number, state: string, version: number) =>
      outcome(
        forged((c) =>
          c.query(
            "insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version) values ('sample_record', $1, 'sample_record', $2, $3, $4)",
            [randomUUID(), machineVersion, state, version],
          ),
        ),
      );
    expect(await insert(99, 'DRAFT', 1)).toBe(START);
    expect(await insert(1, 'DRAFT', 2)).toBe(START);
    expect(await insert(1, 'SUBMITTED', 1)).toBe(START);
  });

  it('[DI-34][DI-17] a state row\'s change is refused for each reason alone, along a published transition: another aggregate type, another aggregate, another machine, another machine version, a version jump; and a change not published for its own machine and version (EBMR-PLAT-072)', async () => {
    const NOT = 'EBMR-PLAT-072 DRAFT -> SUBMITTED is not a published transition of sample_record v1';
    const change = (set: string, values: unknown[] = []) =>
      create('sample_record').then((id) =>
        outcome(forged((c) => c.query(`update platform.aggregate_state set state = 'SUBMITTED', ${set} where aggregate_type = 'sample_record' and aggregate_id = $1`, [id, ...values]))),
      );
    expect(await change("version = 2, aggregate_type = 'batch'")).toBe(NOT);
    expect(await change('version = 2, aggregate_id = $2', [randomUUID()])).toBe(NOT);
    expect(await change('version = 2, machine_code = $2', [MACHINE])).toBe(NOT);
    expect(await change('version = 2, machine_version = 2')).toBe(NOT);
    expect(await change('version = 3')).toBe(NOT);
    // DRAFT -> LOST is published for another machine only; DRAFT -> DONE for another version of the aggregate's machine only.
    const id = await create('sample_record');
    expect(await outcome(forged((c) => setState(c, id, 'LOST', 2)))).toBe('EBMR-PLAT-072 DRAFT -> LOST is not a published transition of sample_record v1');
    const v1 = pinnedToV1.pop() ?? '';
    expect(await outcome(forged((c) => setState(c, v1, 'DONE', 2)))).toBe(`EBMR-PLAT-072 DRAFT -> DONE is not a published transition of ${MACHINE} v1`);
    // CHECKED is the target of a published transition, but not from DRAFT.
    expect(await outcome(forged((c) => setState(c, id, 'CHECKED', 2)))).toBe('EBMR-PLAT-072 DRAFT -> CHECKED is not a published transition of sample_record v1');
  });
});

describe('a history row that creates an aggregate (platform.guard_state_row on platform.state_history)', () => {
  const creation: Row = { from: null, event: null, to: 'DRAFT', fromVersion: null, toVersion: 1 };

  it('[DI-34][DI-17] it starts a published version of a machine that governs its type, at version 1 in the initial state; each refused alone (EBMR-PLAT-077)', async () => {
    const id = randomUUID();
    const start = (r: Row) => outcome(forged((c) => insertHistory(c, id, r)));
    expect(await start({ ...creation, machineVersion: 99 })).toBe(historyRow(id, 'that creates it in DRAFT at version 1 does not start a published version of sample_record v99 (none at version 1)'));
    expect(await start({ ...creation, aggregateType: 'batch' })).toBe(
      `EBMR-PLAT-077 the history row of batch:${id} that creates it in DRAFT at version 1 does not start a published version of sample_record v1 (DRAFT at version 1)`,
    );
    expect(await start({ ...creation, toVersion: 2 })).toBe(historyRow(id, 'that creates it in DRAFT at version 2 does not start a published version of sample_record v1 (DRAFT at version 1)'));
  });

  it('[DI-34][DI-17] it records the version\'s create permission and no signature; each refused alone (EBMR-PLAT-077)', async () => {
    const id = randomUUID();
    const NOT = historyRow(id, 'that creates it in DRAFT at version 1 does not record what the published transition requires (permission sample_record.submit, signature none)');
    const start = (r: Row) => outcome(forged((c) => insertHistory(c, id, r)));
    expect(await start({ ...creation, permission: null })).toBe(NOT);
    expect(await start({ ...creation, meaning: 'APPROVED' })).toBe(NOT);
    expect(await start({ ...creation, signatureId: randomUUID() })).toBe(NOT);
  });

  it('[DI-34][DI-17] it is the aggregate\'s first history row (EBMR-PLAT-077), refused before the unique version would refuse it', async () => {
    const id = await create('sample_record');
    expect(await outcome(forged((c) => insertHistory(c, id, creation)))).toBe(
      historyRow(id, 'that creates it in DRAFT at version 1 does not continue its latest history row (DRAFT at version 1)'),
    );
  });
});

describe('a history row that records a transition (platform.guard_state_row on platform.state_history)', () => {
  it('[DI-34][DI-17] it is a transition published for the machine and version it names: one of another machine, or of another version of its own machine, is refused (EBMR-PLAT-077)', async () => {
    const id = await create('sample_record');
    expect(await outcome(forged((c) => insertHistory(c, id, { from: 'DRAFT', event: 'LOSE', to: 'LOST', fromVersion: 1, toVersion: 2 })))).toBe(
      historyRow(id, `DRAFT -LOSE-> LOST at version 2 ${notPublished()}`),
    );
    const v1 = pinnedToV1.pop() ?? '';
    expect(await outcome(forged((c) => insertHistory(c, v1, { machine: MACHINE, from: 'DRAFT', event: 'SKIP', to: 'DONE', fromVersion: 1, toVersion: 2 })))).toBe(
      historyRow(v1, `DRAFT -SKIP-> DONE at version 2 ${notPublished(MACHINE, 1)}`),
    );
    // An event published from DRAFT, to another state.
    expect(await outcome(forged((c) => insertHistory(c, v1, { machine: MACHINE, from: 'DRAFT', event: 'LOSE', to: 'KEPT', fromVersion: 1, toVersion: 2 })))).toBe(
      historyRow(v1, `DRAFT -LOSE-> KEPT at version 2 ${notPublished(MACHINE, 1)}`),
    );
  });

  it('[DI-34][DI-17] it records the published permission and signature meaning, and a signature id exactly when one is needed; each refused alone (EBMR-PLAT-077)', async () => {
    const draft = await create('sample_record');
    const submit: Row = { from: 'DRAFT', event: 'SUBMIT', to: 'SUBMITTED', fromVersion: 1, toVersion: 2 };
    const NOT_SUBMIT = historyRow(draft, 'DRAFT -SUBMIT-> SUBMITTED at version 2 does not record what the published transition requires (permission sample_record.submit, signature none)');
    expect(await outcome(forged((c) => insertHistory(c, draft, { ...submit, permission: 'sample_record.check' })))).toBe(NOT_SUBMIT);
    expect(await outcome(forged((c) => insertHistory(c, draft, { ...submit, signatureId: randomUUID() })))).toBe(NOT_SUBMIT);
    // A record in SUBMITTED (arranged with the flag forged, both rows as the engine writes them): CHECK needs CHECKED.
    const submitted = await create('sample_record');
    await forged(async (c) => {
      await setState(c, submitted, 'SUBMITTED', 2);
      await insertHistory(c, submitted, submit);
    });
    const check: Row = { from: 'SUBMITTED', event: 'CHECK', to: 'CHECKED', fromVersion: 2, toVersion: 3, permission: 'sample_record.check', meaning: 'CHECKED', signatureId: randomUUID() };
    const NOT_CHECK = historyRow(submitted, 'SUBMITTED -CHECK-> CHECKED at version 3 does not record what the published transition requires (permission sample_record.check, signature CHECKED)');
    expect(await outcome(forged((c) => insertHistory(c, submitted, { ...check, meaning: 'APPROVED' })))).toBe(NOT_CHECK);
    expect(await outcome(forged((c) => insertHistory(c, submitted, { ...check, signatureId: null })))).toBe(NOT_CHECK);
  });

  it('[DI-34][DI-17] it continues the latest history row: none at all, another version, another machine, another machine version; each refused alone (EBMR-PLAT-077)', async () => {
    const none = randomUUID();
    expect(await outcome(forged((c) => insertHistory(c, none, { from: 'DRAFT', event: 'SUBMIT', to: 'SUBMITTED', fromVersion: 1, toVersion: 2 })))).toBe(
      historyRow(none, 'DRAFT -SUBMIT-> SUBMITTED at version 2 does not continue its latest history row (none)'),
    );
    const draft = await create('sample_record');
    expect(await outcome(forged((c) => insertHistory(c, draft, { from: 'DRAFT', event: 'SUBMIT', to: 'SUBMITTED', fromVersion: 5, toVersion: 6 })))).toBe(
      historyRow(draft, 'DRAFT -SUBMIT-> SUBMITTED at version 6 does not continue its latest history row (DRAFT at version 1)'),
    );
    // A transition of the helper machine for a record of the sample record's machine.
    expect(await outcome(forged((c) => insertHistory(c, draft, { machine: MACHINE, from: 'DRAFT', event: 'LOSE', to: 'LOST', fromVersion: 1, toVersion: 2 })))).toBe(
      historyRow(draft, 'DRAFT -LOSE-> LOST at version 2 does not continue its latest history row (DRAFT at version 1)'),
    );
    // A transition of version 2 for a record pinned to version 1.
    const v1 = pinnedToV1.pop() ?? '';
    expect(await outcome(forged((c) => insertHistory(c, v1, { machine: MACHINE, machineVersion: 2, from: 'DRAFT', event: 'SKIP', to: 'DONE', fromVersion: 1, toVersion: 2 })))).toBe(
      historyRow(v1, 'DRAFT -SKIP-> DONE at version 2 does not continue its latest history row (DRAFT at version 1)'),
    );
  });

  it('[DI-34][DI-17] it is what the state row records: another state, another version, another machine or machine version than the state row; each refused alone (EBMR-PLAT-077)', async () => {
    const v1 = pinnedToV1.pop() ?? '';
    // The state row moved DRAFT -> LOST; the history row says DRAFT -KEEP-> KEPT.
    expect(
      await outcome(
        forged(async (c) => {
          await setState(c, v1, 'LOST', 2);
          await insertHistory(c, v1, { machine: MACHINE, from: 'DRAFT', event: 'KEEP', to: 'KEPT', fromVersion: 1, toVersion: 2 });
        }),
      ),
    ).toBe(historyRow(v1, `DRAFT -KEEP-> KEPT at version 2 differs from its state row (LOST at version 2, ${MACHINE} v1)`));
    // The state row moved twice (DRAFT -> LOST -> LOST); the history row records the first move only.
    expect(
      await outcome(
        forged(async (c) => {
          await setState(c, v1, 'LOST', 2);
          await setState(c, v1, 'LOST', 3);
          await insertHistory(c, v1, { machine: MACHINE, from: 'DRAFT', event: 'LOSE', to: 'LOST', fromVersion: 1, toVersion: 2 });
        }),
      ),
    ).toBe(historyRow(v1, `DRAFT -LOSE-> LOST at version 2 differs from its state row (LOST at version 3, ${MACHINE} v1)`));
    // Arranged by the superuser, triggers off: a record of the sample record's machine whose history names the helper
    // machine (the state row moves DRAFT -> SUBMITTED, published for both), and one pinned to version 1 whose history
    // names version 2.
    const other = await create('sample_record');
    await asTimeTraveller(db, "update platform.state_history set machine_code = $2 where aggregate_type = 'sample_record' and aggregate_id = $1", [other, MACHINE]);
    expect(
      await outcome(
        forged(async (c) => {
          await setState(c, other, 'SUBMITTED', 2);
          await insertHistory(c, other, { machine: MACHINE, from: 'DRAFT', event: 'SUBMIT', to: 'SUBMITTED', fromVersion: 1, toVersion: 2 });
        }),
      ),
    ).toBe(historyRow(other, 'DRAFT -SUBMIT-> SUBMITTED at version 2 differs from its state row (SUBMITTED at version 2, sample_record v1)'));
    const pinned = pinnedToV1.pop() ?? '';
    await asTimeTraveller(db, "update platform.state_history set machine_version = 2 where aggregate_type = 'sample_record' and aggregate_id = $1", [pinned]);
    expect(
      await outcome(
        forged(async (c) => {
          await setState(c, pinned, 'LOST', 2);
          await insertHistory(c, pinned, { machine: MACHINE, machineVersion: 2, from: 'DRAFT', event: 'LOSE', to: 'LOST', fromVersion: 1, toVersion: 2 });
        }),
      ),
    ).toBe(historyRow(pinned, `DRAFT -LOSE-> LOST at version 2 differs from its state row (LOST at version 2, ${MACHINE} v1)`));
  });
});

describe('a state row commits only with its history row (platform.state_row_history_check, at commit)', () => {
  const NOT = (id: string, state: string, history: string) =>
    `EBMR-PLAT-078 the state row of sample_record:${id} (${state}) is not its latest history row (${history}): a state changes only together with its history row, through platform.transition`;

  it('[DI-34][DI-17] the state row and its latest history row agree in state, version, machine and machine version; each disagreement alone is refused at commit (EBMR-PLAT-078)', async () => {
    // State: the history's latest row is LOST at version 2, the state row moves to LOST at version 3 (a published step).
    const v1 = pinnedToV1.pop() ?? '';
    await forged(async (c) => {
      await setState(c, v1, 'LOST', 2);
      await insertHistory(c, v1, { machine: MACHINE, from: 'DRAFT', event: 'LOSE', to: 'LOST', fromVersion: 1, toVersion: 2 });
    });
    expect(await outcome(forged((c) => setState(c, v1, 'LOST', 3)))).toBe(NOT(v1, `LOST at version 3, ${MACHINE} v1`, `LOST at version 2, ${MACHINE} v1`));
    // Arranged (triggers off): a third history row KEPT at version 3; the state row then moves LOST -> LOST at version 3.
    await asTimeTraveller(db, HISTORY, historyParams(v1, { machine: MACHINE, from: 'LOST', event: 'RELOSE', to: 'KEPT', fromVersion: 2, toVersion: 3 }));
    expect(await outcome(forged((c) => setState(c, v1, 'LOST', 3)))).toBe(NOT(v1, `LOST at version 3, ${MACHINE} v1`, `KEPT at version 3, ${MACHINE} v1`));
    // Arranged: that row names the sample record's machine; then version 2 of the helper machine.
    await asTimeTraveller(db, "update platform.state_history set to_state = 'LOST', machine_code = 'sample_record' where aggregate_type = 'sample_record' and aggregate_id = $1 and to_version = 3", [v1]);
    expect(await outcome(forged((c) => setState(c, v1, 'LOST', 3)))).toBe(NOT(v1, `LOST at version 3, ${MACHINE} v1`, 'LOST at version 3, sample_record v1'));
    await asTimeTraveller(db, "update platform.state_history set machine_code = $2, machine_version = 2 where aggregate_type = 'sample_record' and aggregate_id = $1 and to_version = 3", [v1, MACHINE]);
    expect(await outcome(forged((c) => setState(c, v1, 'LOST', 3)))).toBe(NOT(v1, `LOST at version 3, ${MACHINE} v1`, `LOST at version 3, ${MACHINE} v2`));
    // In agreement it commits.
    await asTimeTraveller(db, "update platform.state_history set machine_version = 1 where aggregate_type = 'sample_record' and aggregate_id = $1 and to_version = 3", [v1]);
    expect(await outcome(forged((c) => setState(c, v1, 'LOST', 3)))).toBe('accepted');
  });
});
