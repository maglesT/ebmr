/**
 * Review reproducer F44: the sample record's edit guard (platform.stub_record_edit_guard, kernel
 * 0551) allows an UPDATE when a plain, unlocked SELECT of platform.aggregate_state shows DRAFT, and
 * the SUBMIT guard (platform.guard_sample_record_has_body, 0551, run by platform.transition, 0550)
 * reads platform.stub_record with a plain MVCC read. platform.transition locks only the
 * aggregate_state row (FOR UPDATE); the edit never touches that row. Neither side takes a lock the
 * other conflicts with before it evaluates its guard (write skew), although outline 5.2 requires
 * guards to run with the relevant rows locked.
 *
 * The two commands need two different sessions: kernel.begin_command locks the actor's iam.session
 * row (0190), so two commands of the SAME session are serialised whole. Two authors (or one person
 * on two workstations) are the realistic case, so the test uses two MBR_AUTHOR actors.
 *
 * Scenario 1 (has_body guard bypass, the finding's order):
 *   A: begin; begin_command(author A, reason); update stub_record set body = '' where id = R
 *      -> the edit guard sees DRAFT and passes; A stays open.
 *   B: begin; begin_command(author B); platform.transition(... R, 'SUBMIT', 1)
 *      -> has_body reads the committed (non-empty) body and passes. (B may then wait on the audit
 *         chain head of sample_record:R that A holds, but only after the guard has passed.)
 *   A: commit. B: completes, commit.
 *   Unsafe result: R is SUBMITTED with an empty body; EBMR-PLAT-068 never fired.
 *
 * Scenario 2 (content change after submission, reverse order):
 *   B: begin; begin_command(author B); platform.transition(... R2, 'SUBMIT', 1) -> done, B open.
 *   A: begin; begin_command(author A, reason); update stub_record set body = 'changed' where id = R2
 *      -> the edit guard reads the committed state DRAFT and passes.
 *   B: commit. A: completes, commit.
 *   Unsafe result: R2 is SUBMITTED and its body is not the body that was submitted; EBMR-PLAT-074
 *   never fired.
 *
 * Safe behaviour asserted (ADR-0012, INV-04, outline 5.2): in both races the guard that must
 * refuse does refuse (the loser waits for the winner's lock and then sees the committed data), so a
 * SUBMITTED record never has an empty body, and a SUBMITTED record's content is exactly what was
 * submitted. Any refusal must be a business refusal (EBMR-PLAT-068 / EBMR-PLAT-074), not a setup
 * mistake.
 *
 * Positive controls: sequentially, SUBMIT of an empty body is refused with EBMR-PLAT-068 and an edit
 * after SUBMIT is refused with EBMR-PLAT-074, so the guards and the actors are set up correctly and
 * only the interleaving changes the outcome.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import { createAggregateState, transition } from '../../src/state/engine.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';

let db: TestDatabase;
let authorA: ActorContext;
let authorB: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  // Real AUTHORITY hook (identity module): MBR_AUTHOR holds SAMPLE_RECORD.SUBMIT (kernel 0700).
  authorA = await seededTestActor(db, { roleCode: 'MBR_AUTHOR', legalName: 'A. Editor' });
  authorB = await seededTestActor(db, { roleCode: 'MBR_AUTHOR', legalName: 'B. Submitter' });
});

afterAll(async () => {
  await db.drop();
});

const editCtx = (): ActorContext => ({ ...authorA, reasonCode: 'REWORK', reasonText: 'edit of the draft', correlationId: randomUUID() });
const submitCtx = (): ActorContext => ({ ...authorB, correlationId: randomUUID() });

async function newRecord(body: string): Promise<string> {
  return withCommand(db.app, submitCtx(), async (c) => {
    const { rows } = await c.query<{ id: string }>('insert into platform.stub_record (title, body) values ($1, $2) returning id', ['Sample SOP', body]);
    const id = rows[0]?.id ?? '';
    await createAggregateState(c, 'sample_record', { aggregateType: 'sample_record', aggregateId: id });
    return id;
  });
}

async function snapshot(id: string): Promise<{ state: string; version: string; body: string }> {
  const { rows } = await db.admin.query<{ state: string; version: string; body: string }>(
    `select s.state, s.version::text as version, r.body
       from platform.stub_record r join platform.aggregate_state s on s.aggregate_type = 'sample_record' and s.aggregate_id = r.id
      where r.id = $1`,
    [id],
  );
  return rows[0] ?? { state: '?', version: '?', body: '?' };
}

/** Opens a command (begin + kernel.begin_command) on its own connection and leaves it open. */
async function openCommand(ctx: ActorContext): Promise<{ client: pg.PoolClient; pid: number }> {
  const client = await db.app.connect();
  await client.query('begin');
  await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
  const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
  return { client, pid: rows[0]?.pid ?? -1 };
}

async function close(client: pg.PoolClient, commit: boolean): Promise<string | null> {
  try {
    await client.query(commit ? 'commit' : 'rollback');
    return null;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    return (e as Error).message;
  } finally {
    client.release();
  }
}

type Outcome = { ok: true } | { ok: false; error: string };
const settle = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(
    () => ({ ok: true }) as const,
    (e: unknown) => ({ ok: false, error: (e as Error).message }) as const,
  );

/** Waits until the statement on `pid` is waiting for a lock, or until it has finished. */
async function blockedOrDone(pid: number, pending: Promise<Outcome>): Promise<{ status: string; waitingOn: string | null }> {
  let done = false;
  void pending.then(() => {
    done = true;
  });
  for (let i = 0; i < 200 && !done; i++) {
    const { rows } = await db.admin.query<{ wait_event_type: string | null; query: string }>(
      'select wait_event_type, query from pg_stat_activity where pid = $1',
      [pid],
    );
    if (rows[0]?.wait_event_type === 'Lock') {
      const { rows: locks } = await db.admin.query<{ what: string }>(
        `select string_agg(l.locktype || coalesce(':' || l.relation::regclass::text, '') || ':' || l.mode, ', ') as what
           from pg_locks l where l.pid = $1 and not l.granted`,
        [pid],
      );
      return { status: 'blocked', waitingOn: locks[0]?.what ?? null };
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return { status: done ? 'done' : 'timeout', waitingOn: null };
}

describe('F44 the edit guard and the SUBMIT guard of the sample record run without locking each other', () => {
  it('[INV-04] concurrent edit and SUBMIT: a SUBMITTED record never has an empty body and never changes after submission', async () => {
    // Positive controls (sequential): both guards work and the actors can edit and submit.
    const empty = await newRecord('   ');
    await expect(
      withCommand(db.app, submitCtx(), (c) => transition(c, { machine: 'sample_record', aggregateType: 'sample_record', aggregateId: empty, event: 'SUBMIT', expectedVersion: 1 })),
    ).rejects.toThrow('EBMR-PLAT-068 SUBMIT refused in state DRAFT: sample_record.has_body: the record body is empty');
    const seq = await newRecord('Version 1 text');
    await withCommand(db.app, editCtx(), (c) => c.query("update platform.stub_record set body = 'Version 1 text, edited' where id = $1", [seq]));
    await withCommand(db.app, submitCtx(), (c) => transition(c, { machine: 'sample_record', aggregateType: 'sample_record', aggregateId: seq, event: 'SUBMIT', expectedVersion: 1 }));
    await expect(
      withCommand(db.app, editCtx(), (c) => c.query("update platform.stub_record set body = 'changed after submit' where id = $1", [seq])),
    ).rejects.toThrow('EBMR-PLAT-074');
    expect(await snapshot(seq)).toEqual({ state: 'SUBMITTED', version: '2', body: 'Version 1 text, edited' });

    // ---- Scenario 1: A empties the body (open), B submits, A commits, B commits. ----
    const r1 = await newRecord('Version 1 text');
    const s1: Record<string, unknown> = {};
    {
      const a = await openCommand(editCtx());
      const b = await openCommand(submitCtx());
      try {
        s1['editA'] = await settle(a.client.query("update platform.stub_record set body = '' where id = $1", [r1]));
        const submit = settle(b.client.query("select platform.transition('sample_record', 'sample_record', $1, 'SUBMIT', 1, '{}'::jsonb)", [r1]));
        s1['submitB_before_commitA'] = await blockedOrDone(b.pid, submit);
        s1['commitA'] = await close(a.client, (s1['editA'] as Outcome).ok);
        s1['submitB'] = await submit;
        s1['commitB'] = await close(b.client, (s1['submitB'] as Outcome).ok);
      } catch (e) {
        s1['unexpected'] = (e as Error).message;
        await close(a.client, false).catch(() => undefined);
        await close(b.client, false).catch(() => undefined);
      }
    }
    s1['final'] = await snapshot(r1);

    // ---- Scenario 2: B submits (open), A edits, B commits, A commits. ----
    const r2 = await newRecord('Version 1 text');
    const s2: Record<string, unknown> = {};
    {
      const b = await openCommand(submitCtx());
      const a = await openCommand(editCtx());
      try {
        s2['submitB'] = await settle(b.client.query("select platform.transition('sample_record', 'sample_record', $1, 'SUBMIT', 1, '{}'::jsonb)", [r2]));
        const edit = settle(a.client.query("update platform.stub_record set body = 'changed after submission' where id = $1", [r2]));
        s2['editA_before_commitB'] = await blockedOrDone(a.pid, edit);
        s2['commitB'] = await close(b.client, (s2['submitB'] as Outcome).ok);
        s2['editA'] = await edit;
        s2['commitA'] = await close(a.client, (s2['editA'] as Outcome).ok);
      } catch (e) {
        s2['unexpected'] = (e as Error).message;
        await close(b.client, false).catch(() => undefined);
        await close(a.client, false).catch(() => undefined);
      }
    }
    s2['final'] = await snapshot(r2);

    const evidence = JSON.stringify({ scenario1: s1, scenario2: s2 });
    expect(s1['unexpected'], evidence).toBeUndefined();
    expect(s2['unexpected'], evidence).toBeUndefined();
    // Any refusal is the business refusal of the guard that must fire, not a setup mistake.
    for (const o of [s1['editA'], s1['submitB'], s2['submitB'], s2['editA']] as Outcome[]) {
      if (!o.ok) expect(o.error, evidence).toMatch(/EBMR-PLAT-06[68]|EBMR-PLAT-074/);
    }

    const f1 = s1['final'] as { state: string; body: string };
    const f2 = s2['final'] as { state: string; body: string };
    const violations: string[] = [];
    if (f1.state === 'SUBMITTED' && f1.body.trim() === '') {
      violations.push('scenario 1: record SUBMITTED with an empty body (sample_record.has_body bypassed, EBMR-PLAT-068 never fired)');
    }
    if (f2.state === 'SUBMITTED' && f2.body !== 'Version 1 text') {
      violations.push(`scenario 2: record SUBMITTED but its content changed after submission to "${f2.body}" (EBMR-PLAT-074 never fired)`);
    }
    expect(violations, evidence).toEqual([]);
  });
});
