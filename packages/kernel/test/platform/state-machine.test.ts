/**
 * State-machine engine (outline 5.2 introduction, 4.4 "Privileges"; ADR 0012 decision 2):
 * transitions run only through platform.transition, which locks the state row, checks the
 * optimistic version, the pinned machine version's transition table, permission, signature and
 * guards, and writes state, history, audit and outbox in one transaction.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KernelError } from '../../src/commands/errors.ts';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import { createAggregateState, getAggregateState, transition, type TransitionResult } from '../../src/state/engine.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asOwner, grantPermission, installStubHooks, stubSignature, testActor, withTriggersDisabled } from './helpers.ts';

let db: TestDatabase;
let author: ActorContext;
let checker: ActorContext;
let qa: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  await installStubHooks(db);
  await grantPermission(db, 'MBR_AUTHOR', 'sample_record.submit');
  await grantPermission(db, 'MBR_CHECKER', 'sample_record.check');
  await grantPermission(db, 'QA_REVIEWER', 'sample_record.approve', 'sample_record.retire', 'sample_record.check');
  author = await testActor(db, { roleCode: 'MBR_AUTHOR', legalName: 'A. Author' });
  checker = await testActor(db, { roleCode: 'MBR_CHECKER', legalName: 'C. Checker' });
  qa = await testActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Q. Approver' });
});
afterAll(async () => {
  await db.drop();
});

async function rows<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.app.query<T>(text, params)).rows;
}

async function newRecord(body = 'Content of the controlled record'): Promise<string> {
  return withCommand(db.app, author, async (c) => {
    const { rows: r } = await c.query<{ id: string }>('insert into platform.stub_record (title, body) values ($1, $2) returning id', ['Sample SOP', body]);
    const id = r[0]?.id ?? '';
    await createAggregateState(c, 'sample_record', { aggregateType: 'sample_record', aggregateId: id });
    return id;
  });
}

function fire(id: string, event: string, expectedVersion: number, actor: ActorContext, payload: Record<string, string> = {}): Promise<TransitionResult> {
  return withCommand(db.app, actor, (c) =>
    transition(c, { machine: 'sample_record', aggregateType: 'sample_record', aggregateId: id, event, expectedVersion, payload }),
  );
}

const sign = (meaning: string, id: string) => stubSignature(db, meaning, 'sample_record', id);

describe('transitions through the engine', () => {
  it('a record follows its machine with history, audit trail and outbox written in the same transaction', async () => {
    const id = await newRecord();
    expect(await getAggregateState(db.app, { aggregateType: 'sample_record', aggregateId: id })).toMatchObject({ state: 'DRAFT', version: 1, machineVersion: 1 });
    await fire(id, 'SUBMIT', 1, author);
    const checkSig = await sign('CHECKED', id);
    await fire(id, 'CHECK', 2, checker, { signature_id: checkSig });
    const approved = await fire(id, 'APPROVE', 3, qa, { signature_id: await sign('APPROVED', id) });
    expect(approved).toMatchObject({ from: 'CHECKED', event: 'APPROVE', to: 'APPROVED', newVersion: 4, machine: 'sample_record', machineVersion: 1 });

    const history = await rows<{ from_state: string | null; event: string | null; to_state: string; to_version: string; role_code: string; signature_id: string | null; permission_code: string | null }>(
      "select from_state, event, to_state, to_version::text, role_code, signature_id, permission_code from platform.state_history where aggregate_type = 'sample_record' and aggregate_id = $1 order by to_version",
      [id],
    );
    expect(history).toEqual([
      { from_state: null, event: null, to_state: 'DRAFT', to_version: '1', role_code: 'MBR_AUTHOR', signature_id: null, permission_code: null },
      { from_state: 'DRAFT', event: 'SUBMIT', to_state: 'SUBMITTED', to_version: '2', role_code: 'MBR_AUTHOR', signature_id: null, permission_code: 'sample_record.submit' },
      { from_state: 'SUBMITTED', event: 'CHECK', to_state: 'CHECKED', to_version: '3', role_code: 'MBR_CHECKER', signature_id: checkSig, permission_code: 'sample_record.check' },
      expect.objectContaining({ from_state: 'CHECKED', event: 'APPROVE', to_state: 'APPROVED', to_version: '4', role_code: 'QA_REVIEWER' }),
    ]);

    const business = await rows<{ message: string }>(
      "select payload -> 'body' ->> 'message' as message from kernel.audit_event where chain_key = $1 and action = 'BUSINESS' order by seq",
      [`sample_record:${id}`],
    );
    expect(business.map((b) => b.message)).toEqual([
      'created in state DRAFT (machine sample_record v1)',
      'SUBMIT: state DRAFT -> SUBMITTED (machine sample_record v1)',
      'CHECK: state SUBMITTED -> CHECKED (machine sample_record v1)',
      'APPROVE: state CHECKED -> APPROVED (machine sample_record v1)',
    ]);
    const updates = await rows<{ reason_code: string; reason_text: string; old: Record<string, unknown>; new: Record<string, unknown> }>(
      `select payload ->> 'reason_code' as reason_code, payload ->> 'reason_text' as reason_text, payload -> 'body' -> 'old' as old, payload -> 'body' -> 'new' as new
         from kernel.audit_event where chain_key = $1 and table_name = 'platform.aggregate_state' and action = 'UPDATE' order by seq`,
      [`state:${id}`],
    );
    expect(updates.map((u) => [u.reason_code, u.reason_text, u.old['state'], u.new['state']])).toEqual([
      ['STATE_TRANSITION', 'SUBMIT: DRAFT -> SUBMITTED', 'DRAFT', 'SUBMITTED'],
      ['STATE_TRANSITION', 'CHECK: SUBMITTED -> CHECKED', 'SUBMITTED', 'CHECKED'],
      ['STATE_TRANSITION', 'APPROVE: CHECKED -> APPROVED', 'CHECKED', 'APPROVED'],
    ]);
    const messages = await rows<{ topic: string; to: string | null }>(
      "select topic, payload ->> 'to' as to from platform.outbox where aggregate_type = 'sample_record' and aggregate_id = $1 order by id",
      [id],
    );
    expect(messages).toEqual([
      { topic: 'state.created', to: null },
      { topic: 'state.transitioned', to: 'SUBMITTED' },
      { topic: 'state.transitioned', to: 'CHECKED' },
      { topic: 'state.transitioned', to: 'APPROVED' },
    ]);
    // The command's own context is restored after the engine's system reason.
    await expect(
      withCommand(db.app, author, async (c) => {
        await transition(c, { machine: 'sample_record', aggregateType: 'sample_record', aggregateId: await newRecordIn(c), event: 'SUBMIT', expectedVersion: 1 });
        await c.query("update platform.stub_record set body = 'edited without reason' where title = 'never'");
        await c.query("insert into testgmp.sample (batch_id, value) values (gen_random_uuid(), 1)");
        await c.query('update testgmp.sample set value = 2 where value = 1');
      }),
    ).rejects.toThrow('EBMR-AUDIT-002');
  });

  it('an event that the current state does not allow is refused, e.g. jumping from DRAFT to APPROVED', async () => {
    const id = await newRecord();
    const refused = fire(id, 'APPROVE', 1, qa, { signature_id: await sign('APPROVED', id) });
    await expect(refused).rejects.toThrow('EBMR-PLAT-067 event APPROVE is not allowed in state DRAFT');
    await expect(refused).rejects.toSatisfy((e: unknown) => e instanceof KernelError && e.code === 'EBMR-PLAT-067');
    await expect(fire(id, 'NO_SUCH_EVENT', 1, qa)).rejects.toThrow('EBMR-PLAT-067');
    expect(await getAggregateState(db.app, { aggregateType: 'sample_record', aggregateId: id })).toMatchObject({ state: 'DRAFT', version: 1 });
  });

  it('a stale expected version is refused and reports the current state', async () => {
    const id = await newRecord();
    await fire(id, 'SUBMIT', 1, author);
    await expect(fire(id, 'RETURN', 1, checker)).rejects.toThrow('EBMR-PLAT-066 stale command: expected version 1, but');
  });

  it('concurrent transitions on one record: one wins, the other is refused as stale', async () => {
    const id = await newRecord();
    const results = await Promise.allSettled([fire(id, 'SUBMIT', 1, author), fire(id, 'SUBMIT', 1, author)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(String(rejected?.status === 'rejected' ? (rejected.reason as Error).message : '')).toContain('EBMR-PLAT-066');
    expect(await getAggregateState(db.app, { aggregateType: 'sample_record', aggregateId: id })).toMatchObject({ state: 'SUBMITTED', version: 2 });
  });

  it('guards run inside the transition: an empty record cannot be submitted, and RETURN needs a reason', async () => {
    const empty = await newRecord('   ');
    await expect(fire(empty, 'SUBMIT', 1, author)).rejects.toThrow('EBMR-PLAT-068 SUBMIT refused in state DRAFT: sample_record.has_body: the record body is empty');
    const id = await newRecord();
    await fire(id, 'SUBMIT', 1, author);
    await expect(fire(id, 'RETURN', 2, checker)).rejects.toThrow('platform.reason_given: a reason is required for this transition');
    const withReason = { ...checker, reasonCode: 'INCOMPLETE', reasonText: 'section 4 missing' };
    const result = await fire(id, 'RETURN', 2, withReason);
    expect(result.guardResults).toEqual([{ guard: 'platform.reason_given', passed: true, reason: null }]);
    const [h] = await rows<{ reason_code: string; reason_text: string; guard_results: unknown }>(
      "select reason_code, reason_text, guard_results from platform.state_history where aggregate_id = $1 and event = 'RETURN'",
      [id],
    );
    expect(h).toEqual({ reason_code: 'INCOMPLETE', reason_text: 'section 4 missing', guard_results: [{ guard: 'platform.reason_given', passed: true, reason: null }] });
    // The command's own reason is what the audit trail shows for the state change.
    const [u] = await rows<{ reason_code: string }>(
      "select payload ->> 'reason_code' as reason_code from kernel.audit_event where chain_key = $1 and action = 'UPDATE' order by seq desc limit 1",
      [`state:${id}`],
    );
    expect(u?.reason_code).toBe('INCOMPLETE');
    // Content can change only in DRAFT.
    await withCommand(db.app, { ...author, reasonCode: 'REWORK' }, (c) => c.query("update platform.stub_record set body = 'rewritten' where id = $1", [id]));
    await fire(id, 'SUBMIT', 3, author);
    await expect(
      withCommand(db.app, { ...author, reasonCode: 'SNEAKY' }, (c) => c.query("update platform.stub_record set body = 'changed after submit' where id = $1", [id])),
    ).rejects.toThrow('EBMR-PLAT-074');
  });

  it('the permission comes from the authority provider; without one every guarded transition is refused', async () => {
    const id = await newRecord();
    await expect(fire(id, 'SUBMIT', 1, checker)).rejects.toThrow('EBMR-PLAT-006 permission sample_record.submit denied: role MBR_CHECKER does not hold sample_record.submit');
    const { rows: hook } = await db.admin.query<{ f: string }>("select function_oid::text as f from platform.hook where name = 'AUTHORITY'");
    await db.admin.query("delete from platform.hook where name = 'AUTHORITY'");
    try {
      await expect(fire(id, 'SUBMIT', 1, author)).rejects.toThrow('EBMR-PLAT-005');
    } finally {
      await db.admin.query("select platform.register_hook('AUTHORITY', $1::regprocedure)", [hook[0]?.f]);
    }
    await expect(fire(id, 'SUBMIT', 1, author)).resolves.toMatchObject({ to: 'SUBMITTED' });
  });

  it('a transition that needs a signature is refused without a valid signature of that meaning for that record', async () => {
    const id = await newRecord();
    await fire(id, 'SUBMIT', 1, author);
    await expect(fire(id, 'CHECK', 2, checker)).rejects.toThrow('EBMR-PLAT-008 event CHECK needs a signature with meaning CHECKED');
    await expect(fire(id, 'CHECK', 2, checker, { signature_id: await sign('APPROVED', id) })).rejects.toThrow('EBMR-PLAT-008');
    const other = await newRecord();
    await expect(fire(id, 'CHECK', 2, checker, { signature_id: await sign('CHECKED', other) })).rejects.toThrow('EBMR-PLAT-008');
    const { rows: hook } = await db.admin.query<{ f: string }>("select function_oid::text as f from platform.hook where name = 'SIGNATURE'");
    await db.admin.query("delete from platform.hook where name = 'SIGNATURE'");
    try {
      await expect(fire(id, 'CHECK', 2, checker, { signature_id: await sign('CHECKED', id) })).rejects.toThrow('EBMR-PLAT-007');
    } finally {
      await db.admin.query("select platform.register_hook('SIGNATURE', $1::regprocedure)", [hook[0]?.f]);
    }
    const checkSig = await sign('CHECKED', id);
    await expect(fire(id, 'CHECK', 2, checker, { signature_id: checkSig })).resolves.toMatchObject({ to: 'CHECKED' });
    // A signature authorises one transition: after RETURN and a new SUBMIT, the old CHECKED signature cannot be replayed.
    await fire(id, 'RETURN', 3, { ...qa, reasonCode: 'REWORK' });
    await fire(id, 'SUBMIT', 4, author);
    await expect(fire(id, 'CHECK', 5, checker, { signature_id: checkSig })).rejects.toThrow('EBMR-PLAT-075');
  });

  it('final states accept no further events', async () => {
    const id = await newRecord();
    await fire(id, 'SUBMIT', 1, author);
    await fire(id, 'CHECK', 2, checker, { signature_id: await sign('CHECKED', id) });
    await fire(id, 'APPROVE', 3, qa, { signature_id: await sign('APPROVED', id) });
    await fire(id, 'RETIRE', 4, { ...qa, reasonCode: 'OBSOLETE' });
    for (const event of ['SUBMIT', 'RETURN', 'SUPERSEDE', 'RETIRE']) {
      await expect(fire(id, event, 5, { ...qa, reasonCode: 'X' })).rejects.toThrow('not allowed in state RETIRED');
    }
  });

  it('creating a state refuses unknown machines, the wrong aggregate type and a second state for the same record', async () => {
    const create = (machine: string, type: string, id: string) =>
      withCommand(db.app, author, (c) => createAggregateState(c, machine, { aggregateType: type, aggregateId: id }));
    await expect(create('no_such_machine', 'sample_record', randomUUID())).rejects.toThrow('EBMR-PLAT-060');
    await expect(create('sample_record', 'batch', randomUUID())).rejects.toThrow('EBMR-PLAT-065');
    const id = await newRecord();
    await expect(create('sample_record', 'sample_record', id)).rejects.toThrow('EBMR-PLAT-063');
    await expect(db.app.query("select platform.create_aggregate_state('sample_record', 'sample_record', gen_random_uuid())")).rejects.toThrow('EBMR-PLAT-001');
  });
});

describe('the engine cannot be bypassed', () => {
  it('the application role cannot write state or history rows directly', async () => {
    const id = await newRecord();
    const attempt = (text: string) => withCommand(db.app, { ...author, reasonCode: 'BYPASS' }, (c) => c.query(text, [id]));
    await expect(attempt("update platform.aggregate_state set state = 'APPROVED', version = version + 1 where aggregate_id = $1")).rejects.toThrow(/permission denied/);
    await expect(attempt('delete from platform.aggregate_state where aggregate_id = $1')).rejects.toThrow(/permission denied/);
    await expect(
      attempt(
        `insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version)
         values ('sample_record', gen_random_uuid(), 'sample_record', 1, 'APPROVED', 1) returning $1::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      attempt(
        `insert into platform.state_history (aggregate_type, aggregate_id, machine_code, machine_version, from_state, event, to_state, from_version, to_version,
                                             person_id, account_id, role_code, correlation_id)
         values ('sample_record', $1, 'sample_record', 1, 'DRAFT', 'APPROVE', 'APPROVED', 1, 2, 'p', 'a', 'r', gen_random_uuid())`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(attempt("update platform.machine_transition set to_state = 'APPROVED' where machine_code = 'sample_record' and $1::uuid is not null")).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.app.query("select platform.publish_machine_version('{}')")).rejects.toThrow(/permission denied/);
    await expect(db.app.query("select platform.register_guard('x.y', 'platform.guard_reason_given(text, uuid, jsonb, jsonb, jsonb)', 'x')")).rejects.toThrow(
      /permission denied/,
    );
    expect(await getAggregateState(db.app, { aggregateType: 'sample_record', aggregateId: id })).toMatchObject({ state: 'DRAFT', version: 1 });
  });

  it('owner-level code cannot bypass the engine: direct writes are refused, and only published transitions are possible', async () => {
    const id = await newRecord();
    const asSuperuser = (text: string, flag: boolean) =>
      withCommand(db.admin, { ...author, reasonCode: 'BYPASS' }, async (c) => {
        if (flag) await c.query("select set_config('platform.state_engine', 'on', true)");
        await c.query(text, [id]);
      });
    await expect(asSuperuser("update platform.aggregate_state set state = 'SUBMITTED', version = 2 where aggregate_id = $1", false)).rejects.toThrow(
      'EBMR-PLAT-072 aggregate_state rows change only through platform.transition',
    );
    // Even with the engine flag forged, the change must be a published transition.
    await expect(asSuperuser("update platform.aggregate_state set state = 'APPROVED', version = 2 where aggregate_id = $1", true)).rejects.toThrow(
      'EBMR-PLAT-072 DRAFT -> APPROVED is not a published transition',
    );
    await expect(asSuperuser("update platform.aggregate_state set state = 'SUBMITTED', version = 7 where aggregate_id = $1", true)).rejects.toThrow('EBMR-PLAT-072');
    await expect(asSuperuser('delete from platform.aggregate_state where aggregate_id = $1', true)).rejects.toThrow('EBMR-PLAT-072');
    await expect(db.admin.query('truncate platform.aggregate_state')).rejects.toThrow('EBMR-PLAT-002');
    expect(await rows('select * from platform.state_violations()')).toEqual([]);
  });

  it('temporary objects of the application role cannot hijack the catalog lookups of the engine', async () => {
    const id = await newRecord('   ');
    const [guard] = await rows<{ oid: string }>("select function_oid::oid::text as oid from platform.state_guard where code = 'sample_record.has_body'");
    // The application role normally cannot create temporary objects at all (kernel 0001). Grant it
    // here, on this test database only, to prove the second layer: pg_temp is last in every
    // engine function's search_path, so shadow catalogs are never consulted.
    await db.admin.query(`grant temporary on database ${db.name} to ebmr_app`);
    const client = await db.app.connect();
    try {
      await client.query('begin');
      await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(author))]);
      // Shadow pg_proc / pg_namespace in the session's temp schema so that the guard's name would
      // resolve to a temp function that always passes.
      await client.query("create function pg_temp.always_pass(text, uuid, jsonb, jsonb, jsonb) returns text language sql as 'select null::text'");
      await client.query('create temp table pg_namespace (oid oid, nspname name)');
      await client.query('create temp table pg_proc (oid oid, proname name, pronamespace oid)');
      await client.query("insert into pg_namespace values (1, 'pg_temp')");
      await client.query("insert into pg_proc values ($1::oid, 'always_pass', 1)", [guard?.oid]);
      await client.query('grant select on pg_temp.pg_proc, pg_temp.pg_namespace to public');
      await expect(
        client.query("select platform.transition('sample_record', 'sample_record', $1, 'SUBMIT', 1, '{}')", [id]),
      ).rejects.toThrow('EBMR-PLAT-068');
    } finally {
      await client.query('rollback');
      client.release();
      await db.admin.query(`revoke temporary on database ${db.name} from ebmr_app`);
    }
    expect(await getAggregateState(db.app, { aggregateType: 'sample_record', aggregateId: id })).toMatchObject({ state: 'DRAFT', version: 1 });
  });

  it('every platform function has a fixed search_path that searches pg_temp last', async () => {
    const offenders = await rows<{ fn: string; config: string | null }>(
      `select p.oid::regprocedure::text as fn, array_to_string(p.proconfig, ';') as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'platform'
          and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%' and c like '%pg_temp')`,
    );
    expect(offenders).toEqual([]);
    const definers = await rows<{ n: string }>(
      "select count(*)::text as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'platform' and p.prosecdef",
    );
    expect(Number(definers[0]?.n)).toBeGreaterThan(40);
  });

  it('a superuser rewrite with triggers disabled is detected by the invariant query', async () => {
    const id = await newRecord();
    await withTriggersDisabled(db, (c) => c.query("update platform.aggregate_state set state = 'APPROVED', version = 2 where aggregate_id = $1", [id]));
    try {
      const problems = await rows<{ aggregate_id: string; problem: string }>('select aggregate_id, problem from platform.state_violations()');
      expect(problems).toEqual([
        { aggregate_id: id, problem: 'state row (APPROVED, version 2) differs from the latest history row (DRAFT, version 1)' },
      ]);
    } finally {
      await withTriggersDisabled(db, (c) => c.query("update platform.aggregate_state set state = 'DRAFT', version = 1 where aggregate_id = $1", [id]));
    }
    expect(await rows('select * from platform.state_violations()')).toEqual([]);
  });
});

describe('machine versions', () => {
  it('aggregates pin their machine version, and a version in use is immutable', async () => {
    await newRecord();
    const [v] = await rows<{ used: boolean; hash: string }>(
      "select first_used_at is not null as used, definition_hash as hash from platform.machine_version where machine_code = 'sample_record' and version = 1",
    );
    expect(v?.used).toBe(true);
    await expect(
      db.admin.query("insert into platform.machine_transition (machine_code, machine_version, from_state, event, to_state) values ('sample_record', 1, 'DRAFT', 'APPROVE', 'APPROVED')"),
    ).rejects.toThrow('EBMR-PLAT-061');
    await expect(db.admin.query("update platform.machine_transition set to_state = 'APPROVED' where machine_code = 'sample_record'")).rejects.toThrow('EBMR-PLAT-061');
    await expect(db.admin.query("delete from platform.machine_transition where machine_code = 'sample_record'")).rejects.toThrow('EBMR-PLAT-061');
    await expect(db.admin.query("update platform.machine_version set states = array_append(states, 'X') where machine_code = 'sample_record'")).rejects.toThrow('EBMR-PLAT-061');
    await expect(db.admin.query("update platform.machine_version set first_used_at = null where machine_code = 'sample_record'")).rejects.toThrow('EBMR-PLAT-061');
    await expect(db.admin.query("delete from platform.machine_version where machine_code = 'sample_record'")).rejects.toThrow('EBMR-PLAT-061');
    expect(await rows('select * from platform.machine_integrity_violations()')).toEqual([]);
    // A superuser rewrite with triggers off no longer matches the sealed hash.
    await withTriggersDisabled(db, (c) =>
      c.query("update platform.machine_transition set to_state = 'APPROVED' where machine_code = 'sample_record' and from_state = 'DRAFT' and event = 'SUBMIT'"),
    );
    try {
      expect(await rows('select machine_code, version, problem from platform.machine_integrity_violations()')).toEqual([
        { machine_code: 'sample_record', version: 1, problem: 'transition rows no longer match the sealed definition hash' },
      ]);
    } finally {
      await withTriggersDisabled(db, (c) =>
        c.query("update platform.machine_transition set to_state = 'SUBMITTED' where machine_code = 'sample_record' and from_state = 'DRAFT' and event = 'SUBMIT'"),
      );
    }
    expect(await rows('select * from platform.machine_integrity_violations()')).toEqual([]);
  });

  it('publishing checks sequence, soundness, guards and the generator hash; new aggregates pin the newest version', async () => {
    const def = (version: number, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        machine: 'test_toggle',
        version,
        aggregate_type: 'test_toggle',
        description: 'test machine',
        initial: 'OFF',
        states: ['OFF', 'ON'],
        final_states: [],
        transitions: [
          { from: 'OFF', event: 'TURN_ON', to: 'ON', guards: [], signature: null, permission: null },
          { from: 'ON', event: 'TURN_OFF', to: 'OFF', guards: [], signature: null, permission: null },
        ],
        ...extra,
      });
    const publish = (json: string) => asOwner(db, `select platform.publish_machine_version('${json.replace(/'/g, "''")}'::jsonb)`);
    await expect(publish(def(2))).rejects.toThrow('EBMR-PLAT-062');
    await expect(
      publish(def(1, { transitions: [{ from: 'OFF', event: 'TURN_ON', to: 'ON', guards: ['no.such_guard'] }, { from: 'ON', event: 'TURN_OFF', to: 'OFF' }] })),
    ).rejects.toThrow('EBMR-PLAT-071');
    await expect(publish(def(1, { states: ['OFF', 'ON', 'LIMBO'] }))).rejects.toThrow('unreachable states LIMBO');
    await expect(publish(def(1, { transitions: [{ from: 'OFF', event: 'TURN_ON', to: 'ON' }] }))).rejects.toThrow('non-final states without transitions ON');
    await expect(publish(def(1, { definition_hash: '0'.repeat(64) }))).rejects.toThrow('generator hash');
    await expect(
      publish(def(1, { transitions: [{ from: 'OFF', event: 'TURN_ON', to: 'ON' }, { from: 'OFF', event: 'TURN_ON', to: 'OFF' }, { from: 'ON', event: 'TURN_OFF', to: 'OFF' }] })),
    ).rejects.toThrow('more than one transition');
    await publish(def(1));
    const first = randomUUID();
    await withCommand(db.app, author, (c) => createAggregateState(c, 'test_toggle', { aggregateType: 'test_toggle', aggregateId: first }));
    await publish(def(2, { states: ['OFF', 'ON', 'BROKEN'], final_states: ['BROKEN'], transitions: [
      { from: 'OFF', event: 'TURN_ON', to: 'ON' },
      { from: 'ON', event: 'TURN_OFF', to: 'OFF' },
      { from: 'ON', event: 'BREAK', to: 'BROKEN' },
    ] }));
    const second = randomUUID();
    await withCommand(db.app, author, (c) => createAggregateState(c, 'test_toggle', { aggregateType: 'test_toggle', aggregateId: second }));
    const toggle = (id: string, event: string) =>
      withCommand(db.app, author, (c) => transition(c, { machine: 'test_toggle', aggregateType: 'test_toggle', aggregateId: id, event, expectedVersion: 2 }));
    await withCommand(db.app, author, (c) => transition(c, { machine: 'test_toggle', aggregateType: 'test_toggle', aggregateId: first, event: 'TURN_ON', expectedVersion: 1 }));
    await withCommand(db.app, author, (c) => transition(c, { machine: 'test_toggle', aggregateType: 'test_toggle', aggregateId: second, event: 'TURN_ON', expectedVersion: 1 }));
    // The aggregate created under v1 keeps v1 semantics: BREAK does not exist there.
    await expect(toggle(first, 'BREAK')).rejects.toThrow('EBMR-PLAT-067 event BREAK is not allowed in state ON (machine test_toggle v1)');
    await expect(toggle(second, 'BREAK')).resolves.toMatchObject({ to: 'BROKEN', machineVersion: 2 });
    // An explicit older version can still be pinned when a caller must (e.g. a batch issued under it).
    const pinned = await withCommand(db.app, author, (c) => createAggregateState(c, 'test_toggle', { aggregateType: 'test_toggle', aggregateId: randomUUID() }, 1));
    expect(pinned.machineVersion).toBe(1);
    expect(await rows('select * from platform.machine_integrity_violations()')).toEqual([]);
    expect(await rows('select * from platform.state_violations()')).toEqual([]);
  });
});

/** Creates a record and its state inside an existing command. */
async function newRecordIn(c: pg.PoolClient): Promise<string> {
  const { rows: r } = await c.query<{ id: string }>("insert into platform.stub_record (title, body) values ('inline', 'x') returning id");
  const id = r[0]?.id ?? '';
  await createAggregateState(c, 'sample_record', { aggregateType: 'sample_record', aggregateId: id });
  return id;
}
