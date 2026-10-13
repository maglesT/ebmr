/**
 * DI-37 (signature-record linking and invalidation on change) and INV-09 (a signature is valid
 * only while its content hash is unchanged; a change invalidates it in the same transaction).
 *
 * A permitted change to signed content marks every affected signature SUPERSEDED_BY_CHANGE through
 * an insert-only invalidation row written by the change's own transaction (a trigger on every
 * registered signed table, so no application path can forget it). The signature row never changes,
 * the element shows as unsigned, and signing again is required. The history stays in the audit trail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, withCommand } from '../../src/db/command.ts';
import { contentForSigning, recordSignatures, resigningRequired, signatureState } from '../../src/esig/signing.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import {
  asSuperuserTransaction,
  challengeFor,
  cmd,
  correctStub,
  createStub,
  dbCount,
  ensureSealKey,
  expectPermissionDenied,
  expectRefused,
  run,
  signatureAuth,
  signStub,
  signWith,
  testActor,
} from './helpers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
});

afterAll(async () => {
  await db.drop();
});

describe('a permitted change supersedes the signature (DI-37)', () => {
  it('[DI-37][INV-09] correct a signed value: the signature shows as superseded, the element is unsigned and re-signing is required', async () => {
    const op = await testActor(db, { legalName: 'Asha Performer' });
    const verifier = await testActor(db, { roleCode: 'VERIFIER' });
    const id = await createStub(db, op);
    const performed = await signStub(db, op, id, { meaning: 'PERFORMED' });
    const verified = await signStub(db, verifier, id, { meaning: 'VERIFIED' });
    const before = (await db.admin.query('select * from esig.signature where id = $1', [performed.signatureId])).rows[0] as Record<string, unknown>;
    await correctStub(db, op, id, '12.530');
    for (const s of [performed, verified]) {
      const st = await signatureState(db.app, s.signatureId);
      expect(st.status).toBe('SUPERSEDED_BY_CHANGE');
      expect(st.valid).toBe(false);
      expect(st.invalidation).toMatchObject({ reason: 'SUPERSEDED_BY_CHANGE', person_id: op.personId });
    }
    const shown = await recordSignatures(db.app, 'esig_stub', id);
    expect(shown.map((s) => [s.meaningCode, s.status, s.valid])).toEqual([
      ['PERFORMED', 'SUPERSEDED_BY_CHANGE', false],
      ['VERIFIED', 'SUPERSEDED_BY_CHANGE', false],
    ]);
    const required = await resigningRequired(db.app, 'esig_stub', id);
    expect(required.map((r) => [r.meaningCode, r.previousSigner])).toEqual([['PERFORMED', op.personId], ['VERIFIED', verifier.personId]]);
    // The signature row itself is untouched (insert-only); the invalidation is a separate row.
    const after = (await db.admin.query('select * from esig.signature where id = $1', [performed.signatureId])).rows[0] as Record<string, unknown>;
    expect(after).toEqual(before);
    // The history is in the audit trail: signed, superseded (record chain) and the invalidation rows (signature chain).
    const { rows } = await db.admin.query<{ msg: string }>(
      `select payload -> 'body' ->> 'message' as msg from kernel.audit_event where chain_key = $1 and action = 'BUSINESS' order by seq`, [`esig_stub:${id}`]);
    expect(rows.map((r) => r.msg.split(' ')[0])).toEqual(['signed', 'signed', 'signature', 'signature']);
    expect(rows[2]?.msg).toMatch(/superseded by a change to the signed content/);
    expect(await dbCount(db, "select 1 from kernel.audit_event where chain_key = $1 and table_name = 'esig.signature_invalidation'", [`esig_signature:esig_stub:${id}`])).toBe(2);
    // Signing again: the performer re-signs the corrected content; the corrector-performer still cannot verify it.
    await signStub(db, op, id, { meaning: 'PERFORMED' });
    await signStub(db, verifier, id, { meaning: 'VERIFIED' });
    expect(await resigningRequired(db.app, 'esig_stub', id)).toEqual([]);
    expect((await recordSignatures(db.app, 'esig_stub', id)).filter((s) => s.valid).map((s) => s.meaningCode)).toEqual(['PERFORMED', 'VERIFIED']);
  });

  it('[INV-09] the invalidation happens in the same transaction as the change, and rolls back with it', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const sig = await signStub(db, op, id, { meaning: 'PERFORMED' });
    const client = await db.app.connect();
    try {
      await client.query('begin');
      const ctx = await cmd(db, op, { reasonCode: 'ENTRY_ERROR', reasonText: 'typo' });
      await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
      await client.query("update esig.stub_signable set value = '99' where id = $1", [id]);
      expect((await signatureState(client, sig.signatureId)).status).toBe('SUPERSEDED_BY_CHANGE');
      await client.query('rollback');
    } finally {
      client.release();
    }
    expect((await signatureState(db.app, sig.signatureId)).status).toBe('VALID');
  });

  it('[INV-09] a change that leaves the signed content unchanged does not supersede the signature', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const sig = await signStub(db, op, id, { meaning: 'PERFORMED' });
    await correctStub(db, op, id, '12.503'); // the same value
    expect((await signatureState(db.app, sig.signatureId)).status).toBe('VALID');
  });

  it('[INV-09] a change that commits between the challenge and the signing makes the signing fail', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId);
    await correctStub(db, op, id, '13.000');
    await expectRefused(signWith(db, op, ch.challengeId, ev), 'EBMR-ESIG-012');
  });

  it('[DI-37][INV-09] the mechanism is generic: another module registers its tables and provider, and a change in any of them supersedes', async () => {
    // A two-table record (a step and its readings) standing in for a later module's aggregate.
    await db.admin.query(`
      create schema b2_mod authorization ebmr_owner;
      set role ebmr_owner;
      grant usage on schema b2_mod to ebmr_app;
      create table b2_mod.step (id uuid primary key default gen_random_uuid(), name text not null, version bigint not null default 1);
      create table b2_mod.reading (id uuid primary key default gen_random_uuid(), step_id uuid not null references b2_mod.step (id), value text not null);
      grant select, insert, update on b2_mod.step, b2_mod.reading to ebmr_app;
      select kernel.register_audited_table('b2_mod.step', 'b2_step', 'id', false);
      select kernel.register_audited_table('b2_mod.reading', 'b2_step', 'step_id', true);
      create function b2_mod.step_content(p_id text) returns jsonb language sql stable set search_path = pg_catalog, b2_mod, pg_temp as $f$
        select coalesce((select jsonb_build_object('exists', true, 'content_version', s.version, 'state', null,
                   'content', jsonb_build_object('name', s.name, 'readings',
                     coalesce((select jsonb_agg(r.value order by r.value) from b2_mod.reading r where r.step_id = s.id), '[]'::jsonb)))
                 from b2_mod.step s where s.id::text = p_id), '{"exists": false}'::jsonb)
      $f$;
      select esig.register_content_provider('b2_step', 'b2_mod.step_content(text)', 'test module step');
      select esig.register_signed_table('b2_mod.step', 'b2_step', 'id', array['name']);
      select esig.register_signed_table('b2_mod.reading', 'b2_step', 'step_id');
      reset role;`);
    const op = await testActor(db);
    const stepId = await run(db, op, async (c) => {
      const r = await c.query<{ id: string }>("insert into b2_mod.step (name) values ('Blend 10 min') returning id");
      await c.query("insert into b2_mod.reading (step_id, value) values ($1, '10.0')", [r.rows[0]?.id]);
      return r.rows[0]?.id ?? '';
    });
    expect((await contentForSigning(db.app, 'b2_step', stepId)).exists).toBe(true);
    const sig = await signStub(db, op, stepId, { meaning: 'PERFORMED', aggregateType: 'b2_step', expectedState: null });
    // A new reading (child table) changes the signed content: superseded in that transaction.
    await run(db, op, (c) => c.query("insert into b2_mod.reading (step_id, value) values ($1, '10.2')", [stepId]));
    expect((await signatureState(db.app, sig.signatureId)).status).toBe('SUPERSEDED_BY_CHANGE');
  });
});

describe('INV-09 bypass', () => {
  it('[INV-09] nobody can remove an invalidation or revive a superseded signature', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const sig = await signStub(db, op, id, { meaning: 'PERFORMED' });
    await correctStub(db, op, id, '12.600');
    await expectPermissionDenied(db.app.query('delete from esig.signature_invalidation where signature_id = $1', [sig.signatureId]));
    await expectPermissionDenied(db.app.query('update esig.signature_invalidation set reason = null where signature_id = $1', [sig.signatureId]));
    await asSuperuserTransaction(db, async (c) => {
      await c.query('set local role ebmr_owner');
      await c.query('savepoint s');
      await expectRefused(c.query('delete from esig.signature_invalidation where signature_id = $1', [sig.signatureId]), 'EBMR-AUDIT-004');
      await c.query('rollback to savepoint s');
      await expectRefused(c.query('truncate esig.signature_invalidation'), 'EBMR-AUDIT-004');
      await c.query('rollback to savepoint s');
      await expectRefused(c.query('truncate esig.stub_signable cascade'), 'EBMR-ESIG-007');
    });
    // Changing the value back does not revive the old signature: signing again is required.
    await correctStub(db, op, id, '12.503');
    expect((await signatureState(db.app, sig.signatureId)).status).toBe('SUPERSEDED_BY_CHANGE');
    // The application role cannot write the state or content version of a signed entry directly.
    await expectPermissionDenied(withCommand(db.app, await cmd(db, op, { reasonCode: 'X' }), (c) =>
      c.query("update esig.stub_signable set state = 'COMPLETED' where id = $1", [id])));
    await expectPermissionDenied(withCommand(db.app, await cmd(db, op, { reasonCode: 'X' }), (c) =>
      c.query('update esig.stub_signable set content_version = 1 where id = $1', [id])));
  });

  it('[INV-09][IN-10] a disabled invalidation trigger stops all signing, and a change made behind it is detected', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const sig = await signStub(db, op, id, { meaning: 'PERFORMED' });
    const other = await createStub(db, op);
    await db.admin.query('alter table esig.stub_signable disable trigger esig_signed_esig_stub_signable');
    try {
      await expectRefused(challengeFor(db, op, other, { meaning: 'PERFORMED' }), 'EBMR-ESIG-008');
      // A superuser changes signed content behind the mechanism (every trigger off for the session).
      const c = await db.admin.connect();
      try {
        await c.query('set session_replication_role = replica');
        await c.query("update esig.stub_signable set value = '1.0' where id = $1", [id]);
      } finally {
        await c.query('set session_replication_role = origin');
        c.release();
      }
      const problems = await db.app.query<{ signature_id: string | null; problem: string }>('select * from esig.verify_signatures()');
      expect(problems.rows.some((p) => p.signature_id === null && p.problem.startsWith('CHANGE_TRIGGER_MISSING'))).toBe(true);
      expect(problems.rows.some((p) => p.signature_id === sig.signatureId && p.problem.startsWith('CONTENT_CHANGED_WITHOUT_INVALIDATION'))).toBe(true);
      const inv = await db.app.query<{ invariant: string; signature_id: string }>("select * from esig.invariant_violations() where invariant = 'INV-09'");
      expect(inv.rows.map((r) => r.signature_id)).toContain(sig.signatureId);
      expect((await signatureState(db.app, sig.signatureId)).status).toBe('CONTENT_MISMATCH');
    } finally {
      await db.admin.query('alter table esig.stub_signable enable trigger esig_signed_esig_stub_signable');
    }
  });
});
