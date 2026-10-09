/**
 * Signature invalidation, rule by rule (SQL mutation group "signature-invalidation":
 * esig.content_changed, esig.on_signed_content_change and esig.signature_guard in kernel 0220).
 * These tests close the gaps the SQL mutation run (tools/sql-mutation) found in the module tests of
 * test/esig: the recorded evidence of an invalidation (which content hash superseded the signature),
 * the change kinds the module tests never exercised (deleting a row of signed content, moving a row
 * to another record), the change filter that keeps the change log accurate (INV-03 involvement),
 * the fail-closed refusal of an unregistered table, and the transaction scope of the signing marker.
 *
 * Controls: DI-37 (signature-record linking, invalidation on change); invariants INV-03 (a verifier
 * never entered data in the record), INV-09 (a signature is valid only while its content hash is
 * unchanged; a change supersedes it in the same transaction) and INV-10 (signatures are inserted only
 * by the signing function).
 *
 * A second module ("si_step": a step and its readings) is registered the way a later module would:
 * the step's name is its signed content column, every column of a reading is registered as signed
 * content (content_columns NULL), and the provider hashes the step name and the reading values, not
 * the free-text reading note. Readings can be deleted and moved between steps.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, withCommand } from '../../src/db/command.ts';
import { contentForSigning, createChallenge, sign, signatureState } from '../../src/esig/signing.ts';
import { endPool, openPool } from '../harness/pools.ts';
import type { SeededActor } from '../identity/seed.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';
import {
  asSuperuserTransaction,
  challengeFor,
  cmd,
  correctStub,
  createStub,
  dbCount,
  ensureSealKey,
  expectRefused,
  run,
  signatureAuth,
  signStub,
  testActor,
  testSealKey,
} from '../esig/helpers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
  await db.admin.query(`
    create schema si_mod authorization ebmr_owner;
    set role ebmr_owner;
    grant usage on schema si_mod to ebmr_app;
    create table si_mod.step (id uuid primary key default gen_random_uuid(), name text not null, remark text);
    create table si_mod.reading (id uuid primary key default gen_random_uuid(), step_id uuid not null references si_mod.step (id),
                                 value text not null, note text);
    grant select, insert, update on si_mod.step to ebmr_app;
    grant select, insert, update, delete on si_mod.reading to ebmr_app;
    select kernel.register_audited_table('si_mod.step', 'si_step', 'id', false);
    select kernel.register_audited_table('si_mod.reading', 'si_step', 'step_id', false);
    create function si_mod.step_content(p_id text) returns jsonb language sql stable set search_path = pg_catalog, si_mod, pg_temp as $f$
      select coalesce((select jsonb_build_object('exists', true, 'content_version', 1, 'state', null,
               'content', jsonb_build_object('name', s.name, 'readings',
                 coalesce((select jsonb_agg(r.value order by r.value) from si_mod.reading r where r.step_id = s.id), '[]'::jsonb)))
             from si_mod.step s where s.id::text = p_id), '{"exists": false}'::jsonb)
    $f$;
    select esig.register_content_provider('si_step', 'si_mod.step_content(text)', 'mutation test step with readings');
    select esig.register_signed_table('si_mod.step', 'si_step', 'id', array['name']);
    select esig.register_signed_table('si_mod.reading', 'si_step', 'step_id');
    reset role;`);
});

afterAll(async () => {
  await db.drop();
});

const REASON = { reasonCode: 'ENTRY_ERROR', reasonText: 'transcription error corrected' };

/** A step of the test module with one reading per value; returns the step ID and the reading IDs. */
async function createStep(actor: SeededActor, name: string, readings: { value: string; note?: string }[]): Promise<{ stepId: string; readingIds: string[] }> {
  return run(db, actor, async (c) => {
    const s = await c.query<{ id: string }>('insert into si_mod.step (name) values ($1) returning id', [name]);
    const stepId = s.rows[0]?.id ?? '';
    const readingIds: string[] = [];
    for (const r of readings) {
      const q = await c.query<{ id: string }>('insert into si_mod.reading (step_id, value, note) values ($1, $2, $3) returning id', [stepId, r.value, r.note ?? null]);
      readingIds.push(q.rows[0]?.id ?? '');
    }
    return { stepId, readingIds };
  });
}

const signStep = (actor: SeededActor, stepId: string) => signStub(db, actor, stepId, { meaning: 'PERFORMED', aggregateType: 'si_step', expectedState: null });

async function hashOf(aggregateType: string, aggregateId: string): Promise<string> {
  const c = await contentForSigning(db.app, aggregateType, aggregateId);
  expect(c.exists).toBe(true);
  return c.contentHash ?? '';
}

interface ChangeRow { id: string; table_name: string; operation: string; person_id: string | null }

async function changesOf(aggregateRef: string): Promise<ChangeRow[]> {
  const { rows } = await db.admin.query<ChangeRow>(
    'select c.id::text as id, c.table_name, c.operation, c.person_id from esig.content_change c where c.aggregate_ref = $1 order by c.id', [aggregateRef]);
  return rows;
}

interface InvalidationRow { signature_id: string; previous_content_hash: string; current_content_hash: string | null; change_id: string; person_id: string | null }

async function invalidationOf(signatureId: string): Promise<InvalidationRow | undefined> {
  const { rows } = await db.admin.query<InvalidationRow>(
    `select signature_id, previous_content_hash, current_content_hash, change_id::text, person_id
     from esig.signature_invalidation where signature_id = $1`, [signatureId]);
  return rows[0];
}

async function signedHash(signatureId: string): Promise<string> {
  const { rows } = await db.admin.query<{ h: string }>('select content_hash as h from esig.signature where id = $1', [signatureId]);
  return rows[0]?.h ?? '';
}

describe('esig.content_changed: what a superseding change records (DI-37, INV-09)', () => {
  it('[DI-37][INV-09] every signature a change supersedes records the signed hash, the content hash the record has after the change, and that change', async () => {
    const op = await testActor(db, { legalName: 'Asha Performer' });
    const verifier = await testActor(db, { roleCode: 'VERIFIER' });
    const id = await createStub(db, op);
    const performed = await signStub(db, op, id, { meaning: 'PERFORMED' });
    const verified = await signStub(db, verifier, id, { meaning: 'VERIFIED' });
    const before = await hashOf('esig_stub', id);
    await correctStub(db, op, id, '12.530');
    const after = await hashOf('esig_stub', id);
    expect(after).not.toBe(before);

    const changes = await changesOf(`esig_stub:${id}`);
    const correction = changes.at(-1);
    expect(correction).toMatchObject({ table_name: 'esig.stub_signable', operation: 'UPDATE', person_id: op.personId });
    for (const s of [performed, verified]) {
      expect(await signedHash(s.signatureId)).toBe(before);
      // The invalidation names the hash that was signed and the hash of the record as changed, never an empty one.
      expect(await invalidationOf(s.signatureId)).toEqual({
        signature_id: s.signatureId, previous_content_hash: before, current_content_hash: after, change_id: correction?.id, person_id: op.personId,
      });
    }
    // The audit trail of the record carries the same evidence for each superseded signature.
    const { rows } = await db.admin.query<{ d: Record<string, unknown> }>(
      `select payload -> 'body' -> 'details' as d from kernel.audit_event
       where chain_key = $1 and action = 'BUSINESS' and payload -> 'body' ->> 'message' like '%superseded by a change%' order by seq`, [`esig_stub:${id}`]);
    expect(rows.map((r) => [r.d['signature_id'], r.d['previous_content_hash'], r.d['current_content_hash'], r.d['change_table'], r.d['change_operation']]))
      .toEqual([
        [performed.signatureId, before, after, 'esig.stub_signable', 'UPDATE'],
        [verified.signatureId, before, after, 'esig.stub_signable', 'UPDATE'],
      ]);
  });

  it('[DI-37][INV-09] a change to a registered row that leaves the signed content hash unchanged is logged but supersedes nothing', async () => {
    const op = await testActor(db);
    const { stepId, readingIds } = await createStep(op, 'Blend 10 min', [{ value: '10.0', note: 'first reading' }]);
    const sig = await signStep(op, stepId);
    const before = await hashOf('si_step', stepId);
    const logged = (await changesOf(`si_step:${stepId}`)).length;
    // The note is a registered column of the reading (every column is), but the provider does not hash it.
    await run(db, op, (c) => c.query("update si_mod.reading set note = 'reading taken at the scale display' where id = $1", [readingIds[0]]), REASON);
    expect(await hashOf('si_step', stepId)).toBe(before);
    const changes = await changesOf(`si_step:${stepId}`);
    expect(changes).toHaveLength(logged + 1);
    expect(changes.at(-1)).toMatchObject({ table_name: 'si_mod.reading', operation: 'UPDATE', person_id: op.personId });
    // The content that was signed is unchanged: the signature stays valid and no invalidation exists.
    expect(await invalidationOf(sig.signatureId)).toBeUndefined();
    expect(await signatureState(db.app, sig.signatureId)).toMatchObject({ status: 'VALID', valid: true });
    // A real change afterwards still supersedes it, with the hash of the record as changed.
    await run(db, op, (c) => c.query("update si_mod.reading set value = '10.4' where id = $1", [readingIds[0]]), REASON);
    expect(await invalidationOf(sig.signatureId)).toMatchObject({ previous_content_hash: before, current_content_hash: await hashOf('si_step', stepId) });
  });
});

describe('esig.on_signed_content_change: every kind of change reaches the invalidation (DI-37, INV-09)', () => {
  it('[DI-37][INV-09] deleting a row of signed content supersedes the signatures of its record, logged as a deletion', async () => {
    const op = await testActor(db);
    const { stepId, readingIds } = await createStep(op, 'Granulate', [{ value: '4.1' }, { value: '4.3' }]);
    const sig = await signStep(op, stepId);
    const before = await hashOf('si_step', stepId);
    await run(db, op, (c) => c.query('delete from si_mod.reading where id = $1', [readingIds[1]]), REASON);
    const after = await hashOf('si_step', stepId);
    expect(after).not.toBe(before);
    expect(await signatureState(db.app, sig.signatureId)).toMatchObject({ status: 'SUPERSEDED_BY_CHANGE', valid: false });
    const deletion = (await changesOf(`si_step:${stepId}`)).at(-1);
    expect(deletion).toMatchObject({ table_name: 'si_mod.reading', operation: 'DELETE', person_id: op.personId });
    expect(await invalidationOf(sig.signatureId)).toMatchObject({ previous_content_hash: before, current_content_hash: after, change_id: deletion?.id });
  });

  it('[DI-37][INV-09] moving a row of signed content to another record supersedes the signatures of both records', async () => {
    const op = await testActor(db);
    const a = await createStep(op, 'Dry step A', [{ value: '2.0' }]);
    const b = await createStep(op, 'Dry step B', [{ value: '3.0' }]);
    const sigA = await signStep(op, a.stepId);
    const sigB = await signStep(op, b.stepId);
    const logA = (await changesOf(`si_step:${a.stepId}`)).length;
    const logB = (await changesOf(`si_step:${b.stepId}`)).length;
    await run(db, op, (c) => c.query('update si_mod.reading set step_id = $2 where id = $1', [a.readingIds[0], b.stepId]), REASON);
    for (const [sig, step] of [[sigA, a.stepId], [sigB, b.stepId]] as const) {
      expect(await signatureState(db.app, sig.signatureId), step).toMatchObject({ status: 'SUPERSEDED_BY_CHANGE', valid: false });
      expect((await invalidationOf(sig.signatureId))?.current_content_hash).toBe(await hashOf('si_step', step));
    }
    // Both records log the move as a change by the person who made it.
    for (const [step, logged] of [[a.stepId, logA], [b.stepId, logB]] as const) {
      const changes = await changesOf(`si_step:${step}`);
      expect(changes).toHaveLength(logged + 1);
      expect(changes.at(-1)).toMatchObject({ table_name: 'si_mod.reading', operation: 'UPDATE', person_id: op.personId });
    }
  });

  it('[DI-37][INV-03] an update that changes no signed content column records no content change, so the person does not count as having entered data', async () => {
    const op = await testActor(db, { legalName: 'Ravi Performer' });
    const verifier = await testActor(db, { roleCode: 'VERIFIER', legalName: 'Meera Verifier' });
    const id = await createStub(db, op);
    const ref = `esig_stub:${id}`;
    await signStub(db, op, id, { meaning: 'PERFORMED' });
    const verified = await signStub(db, verifier, id, { meaning: 'VERIFIED' });
    expect(await changesOf(ref)).toEqual([expect.objectContaining({ operation: 'INSERT', person_id: op.personId })]);
    // The verifier completes the entry with the signature (a state change, no content column), then
    // saves the entry without changing it: neither is a content change.
    await run(db, verifier, (c) => c.query('select esig.stub_complete($1, $2)', [id, verified.signatureId]));
    await run(db, verifier, (c) => c.query("update esig.stub_signable set value = '12.503', unit = 'kg' where id = $1", [id]), REASON);
    expect(await changesOf(ref)).toEqual([expect.objectContaining({ operation: 'INSERT', person_id: op.personId })]);
    expect(await signatureState(db.app, verified.signatureId)).toMatchObject({ status: 'VALID', valid: true });
    // A real correction by the performer supersedes both; the verifier, who never entered data, verifies again.
    await correctStub(db, op, id, '12.530');
    expect((await changesOf(ref)).map((c) => [c.operation, c.person_id])).toEqual([['INSERT', op.personId], ['UPDATE', op.personId]]);
    await signStub(db, op, id, { meaning: 'PERFORMED' });
    const again = await signStub(db, verifier, id, { meaning: 'VERIFIED' });
    expect(await signatureState(db.app, again.signatureId)).toMatchObject({ status: 'VALID', valid: true });
    expect(await dbCount(db, "select 1 from esig.invariant_violations() where invariant = 'INV-03' and signature_id = any ($1::uuid[])",
      [[verified.signatureId, again.signatureId]])).toBe(0);
  });

  it('[DI-37][INV-09] the invalidation trigger on a table that is not registered as signed refuses the change (fail closed)', async () => {
    const op = await testActor(db);
    const { stepId } = await createStep(op, 'Compress', [{ value: '1.0' }]);
    await asSuperuserTransaction(db, async (c) => {
      await c.query('set local role ebmr_owner');
      await c.query('create table si_mod.unregistered (id uuid primary key default gen_random_uuid(), value text)');
      await c.query(`create trigger esig_signed_si_mod_unregistered after insert or update or delete on si_mod.unregistered
                     for each row execute function esig.on_signed_content_change()`);
      await c.query('savepoint s');
      await expectRefused(c.query("insert into si_mod.unregistered (value) values ('x')"), 'EBMR-ESIG-006',
        /si_mod\.unregistered is not registered as a signed table/);
      await c.query('rollback to savepoint s');
      // A signed table whose registration was lost: its changes are refused, never let through unlogged.
      await c.query('reset role');
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(await cmd(db, op)))]);
      await c.query("delete from esig.signed_table where table_name = 'si_mod.reading'::regclass");
      await expectRefused(c.query("insert into si_mod.reading (step_id, value) values ($1, '1.1')", [stepId]), 'EBMR-ESIG-006',
        /si_mod\.reading is not registered as a signed table/);
    });
  });
});

describe('esig.signature_guard: the signing marker (INV-10)', () => {
  it('[INV-10] the signing marker is transaction-local: it is consumed by the one signature row and leaves the connection\'s own settings as they were', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    // One pooled connection, used before by someone else who left a session-level value behind.
    const pool = openPool({ connectionString: urlFor(db.name, { name: 'ebmr_app', password: 'ebmr_app' }), max: 1 });
    try {
      const pid = async () => (await pool.query<{ p: number }>('select pg_backend_pid() as p')).rows[0]?.p;
      const marker = async (c: pg.Pool | pg.PoolClient) =>
        (await c.query<{ v: string | null }>("select current_setting('esig.signing_challenge', true) as v")).rows[0]?.v;
      const connection = await pid();
      const foreign = `left-by-an-earlier-command-${randomUUID()}`;
      await pool.query("select set_config('esig.signing_challenge', $1, false)", [foreign]);

      const content = await contentForSigning(pool, 'esig_stub', id);
      const ch = await withCommand(pool, await cmd(db, op), (c) => createChallenge(c, {
        aggregateType: 'esig_stub', aggregateId: id, contentVersion: content.contentVersion ?? '1', meaning: 'PERFORMED',
        clientContentHash: content.contentHash ?? '',
      }));
      const ev = await signatureAuth(db, op, op, ch.challengeId);
      const signed = await withCommand(pool, await cmd(db, op), async (c) => {
        const r = await sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState: 'OPEN' }, testSealKey);
        // Inside the signing transaction the marker is consumed by the signature row.
        expect(await marker(c)).toBe('');
        return r;
      });
      expect(await signatureState(db.app, signed.signatureId)).toMatchObject({ status: 'VALID', valid: true });
      // After the commit the connection is exactly as it was: the kernel wrote no session-level setting.
      expect(await pid()).toBe(connection);
      expect(await marker(pool)).toBe(foreign);
    } finally {
      await endPool(pool);
    }
  });
});

describe('esig.signature_guard: the authentication a signature row names (INV-10, kernel 1112)', () => {
  /** A signature row with exactly what the challenge names; the authentication event, method and components are the caller's. */
  const FROM_CHALLENGE = `
    insert into esig.signature (aggregate_type, aggregate_id, aggregate_ref, content_version, content_hash, meaning_code, meaning_version,
                                meaning_title, meaning_text, signer_person, signer_account, signer_login, signer_legal_name, signer_role_code,
                                signer_role_name, session_id, session_person, cosignature, device_id, auth_event_id, auth_method,
                                components_used, components_required, authority_evaluation_id, challenge_id, correlation_id, site_zone,
                                utc_offset, manifestation, manifestation_text)
    select c.aggregate_type, c.aggregate_id, c.aggregate_ref, c.content_version, c.content_hash, c.meaning_code, c.meaning_version,
           t.title, t.meaning_text, c.signer_person, c.signer_account, 'login', 'A. Name', 'ROLE', 'Role',
           c.session_id, c.session_person, c.cosignature, c.device_id, e.id, coalesce($3, e.method), coalesce($4::text[], e.components),
           'ALL', gen_random_uuid(), c.id, gen_random_uuid(), 'Asia/Kolkata', '+00:00', '{}'::jsonb, ''
      from esig.challenge c join esig.meaning_type t on t.code = c.meaning_code and t.version = c.meaning_version
      join iam.auth_event e on e.id = $2::uuid
     where c.id = $1`;
  const AUTHENTICATION =
    'EBMR-ESIG-066 INV-10: a signature consumes, in its own transaction, an authentication event of its signer made for its challenge on its terminal';

  it('[INV-10][DI-37] with the marker forged, a row naming its challenge exactly is taken only with the authentication event consumed for it in the same transaction, recorded with that event\'s method and components; an event consumed in an earlier transaction, or one not consumed while another was, is refused (EBMR-ESIG-066)', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    // Three authentications of the signer for this challenge on its terminal.
    const consumedEarlier = await signatureAuth(db, op, op, ch.challengeId);
    const notConsumed = await signatureAuth(db, op, op, ch.challengeId);
    const consumedNow = await signatureAuth(db, op, op, ch.challengeId);
    const CONSUME = "select iam.consume_auth_event($1, $2, $3, interval '5 minutes')";
    // Owner-level code consumed one for a signature in an earlier transaction, which committed without a signature.
    await withCommand(db.admin, await cmd(db, op), (c) => c.query(CONSUME, [consumedEarlier, op.personId, ch.challengeId]));
    const ctx = toDbContext(await cmd(db, op));
    await asSuperuserTransaction(db, async (c) => {
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(ctx)]);
      await c.query('set local role ebmr_owner');
      await c.query(CONSUME, [consumedNow, op.personId, ch.challengeId]);
      const attempt = async (authEvent: string, method: string | null = null, components: string[] | null = null): Promise<string> => {
        await c.query('savepoint a');
        try {
          await c.query("select set_config('esig.signing_challenge', $1, true)", [ch.challengeId]);
          const { rowCount } = await c.query(FROM_CHALLENGE, [ch.challengeId, authEvent, method, components]);
          return rowCount === 1 ? 'accepted' : `inserted ${rowCount ?? 0} rows`;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        } finally {
          await c.query('rollback to savepoint a');
        }
      };
      // The event consumed now, recorded with another method or other components than it has.
      expect(await attempt(consumedNow, 'BADGE_PIN')).toBe(AUTHENTICATION);
      expect(await attempt(consumedNow, null, ['PASSWORD'])).toBe(AUTHENTICATION);
      // An event made for the challenge but consumed in another transaction.
      expect(await attempt(consumedEarlier)).toBe(AUTHENTICATION);
      // An event made for the challenge and never consumed, while another one was consumed in this transaction.
      expect(await attempt(notConsumed)).toBe(AUTHENTICATION);
      // The event consumed now, recorded as it is: the row is taken (the seal check at the commit is not reached here).
      expect(await attempt(consumedNow)).toBe('accepted');
    });
    expect(await dbCount(db, 'select 1 from esig.signature where challenge_id = $1', [ch.challengeId])).toBe(0);
  });
});
