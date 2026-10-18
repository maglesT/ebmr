/**
 * The closed batch records (recipe-core 1240; Phase 7 slice 7b-2; DI-08 clause 2, DI-44 clause 1): a GMP batch record
 * whose execution ended is a closed record, read through the reporting path with the chains of its archive package:
 * every chain keyed by the batch and the signature chains of its parts. Batches, status events, lock events and
 * signatures are fixtures written by the superuser with triggers off (each act is proven where it is built).
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { ExportWorld } from '../../../kernel/test/records/export-world.ts';
import { again } from '../../../kernel/test/records/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';

let db: TestDatabase;
const HASH = '0'.repeat(64);

async function fixture(sql: string, params: unknown[] = []): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(sql, params);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

/**
 * A GMP batch (fixture): its status changes in order (each a BATCH_STATUS_CHANGED event, a second later each), its
 * current status, and its record-lock events in order (recipe-core 0870).
 */
async function batch(opts: { moves?: string[]; status?: string; locks?: ('LOCKED' | 'AMENDMENT_OPENED' | 'AMENDMENT_CLOSED')[] } = {}): Promise<string> {
  const id = randomUUID();
  const who = randomUUID();
  await fixture(
    `insert into recipe.batch_execution (id, batch_number, content_hash, installation, purpose, engine_version, registry_fingerprint, policy, policy_hash, issue_request,
                                         market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person, issued_by_account, correlation_id,
                                         control_recipe_id, issue_signature_id)
     values ($1, $2, $3, 'GMP', 'GMP_BATCH', '1', $3, '{}', $3, '{}', '{IN}', 'BS-1', 'SITE-1', 'Asia/Kolkata', 0, $4, $4, $4, gen_random_uuid(), gen_random_uuid())`,
    [id, `B-${id.slice(0, 8)}`, HASH, who],
  );
  for (const [i, to] of (opts.moves ?? []).entries()) {
    await fixture(
      `with c as (insert into recipe.execution_command (batch_id, seq, kind, command_id, command_type, command, command_hash, actor_person, actor_account, actor_role, source,
                                                     session_id, device_class, now_us, accepted, state_version, state_hash, events_hash, event_count, prev_row_hash, row_hash, correlation_id)
                  values ($1, $6::bigint, 'COMMAND', $2, 'SIGN_OFF_STAGE', '{}', $3, $4, $4, 'HEAD_OF_PRODUCTION', 'UI', $4, 'PERSONAL', 1790000000000000 + $6::bigint * 1000000, true, 1, $3, $3, 1, $3, $3, $4)
                  returning batch_id, seq)
       insert into recipe.execution_event (batch_id, row_seq, idx, event_type, event)
       select c.batch_id, c.seq, 0, 'BATCH_STATUS_CHANGED', jsonb_build_object('from', 'IN_PROGRESS', 'to', $5::text) from c`,
      [id, randomUUID(), HASH, who, to, i + 5],
    );
  }
  const status = opts.status ?? opts.moves?.at(-1);
  if (status) {
    await fixture("insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status) values ($1, '{}', 1, $2, 1, $2, $3)", [id, HASH, status]);
  }
  for (const [i, event] of (opts.locks ?? []).entries()) {
    await fixture(
      `insert into recipe.record_lock_event (batch_id, seq, event, cause, amendment_id, person_id, account_id)
       values ($1, $2, $3, case when $3 = 'LOCKED' then 'BULK_RECONCILIATION_CLOSED' end, case when $3 <> 'LOCKED' then gen_random_uuid() end, $4, $4)`,
      [id, i + 1, event, who],
    );
  }
  return id;
}

/** A signature row of `type`:`aggregateId` (fixture). */
async function signature(type: string, aggregateId: string): Promise<void> {
  const who = randomUUID();
  const row = {
    id: randomUUID(), aggregate_type: type, aggregate_id: aggregateId, aggregate_ref: `${type}:${aggregateId}`, content_version: 1, content_hash: HASH,
    meaning_code: 'PERFORMED', meaning_version: 1, meaning_title: 'Performed', meaning_text: 'Performed', signer_person: who, signer_account: who, signer_login: 'x',
    signer_legal_name: 'X', signer_role_code: 'OPERATOR', signer_role_name: 'Operator', session_id: who, session_person: who, cosignature: false, device_id: who,
    auth_event_id: who, auth_method: 'PASSWORD', components_used: ['PASSWORD'], components_required: 'ALL', authority_evaluation_id: who, challenge_id: who,
    correlation_id: who, site_zone: 'Asia/Kolkata', utc_offset: '+05:30', manifestation: {}, manifestation_text: 'X',
  };
  await fixture("insert into esig.signature select * from jsonb_populate_record(null::esig.signature, $1::jsonb || jsonb_build_object('recorded_at', clock_timestamp()))", [JSON.stringify(row)]);
}

/** The closed records of type batch, as the reporting role reads them. */
async function closedBatches(): Promise<Map<string, string[]>> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local role ebmr_report');
    const { rows } = await c.query<{ record_id: string; chain_keys: string[] }>("select record_id, chain_keys from report.closed_record_v1 where record_type = 'batch'");
    await c.query('rollback');
    return new Map(rows.map((r) => [r.record_id, r.chain_keys]));
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  db = await createTestDatabase();
}, 300_000);

afterAll(async () => {
  await db?.drop();
});

const lockedAt = async (id: string): Promise<string> =>
  (await db.admin.query<{ t: string }>("select max(recorded_at)::text as t from recipe.record_lock_event where batch_id = $1 and event in ('LOCKED', 'AMENDMENT_CLOSED')", [id])).rows[0]!.t;

describe('the closed batch records (recipe-core 1240)', () => {
  it('[DI-08][DI-44] a batch record is closed when its record is locked now, or when it is aborted or cancelled now; a completed, reopened, running or amended record is not', async () => {
    const locked = await batch({ moves: ['EXECUTION_COMPLETE'], locks: ['LOCKED'] });
    const reLocked = await batch({ moves: ['EXECUTION_COMPLETE'], locks: ['LOCKED', 'AMENDMENT_OPENED', 'AMENDMENT_CLOSED'] });
    const underAmendment = await batch({ moves: ['EXECUTION_COMPLETE'], locks: ['LOCKED', 'AMENDMENT_OPENED'] });
    const completeOnly = await batch({ moves: ['EXECUTION_COMPLETE'] });
    const reopened = await batch({ moves: ['EXECUTION_COMPLETE', 'IN_PROGRESS'] });
    const aborted = await batch({ moves: ['EXECUTION_COMPLETE', 'IN_PROGRESS', 'ABORTED'] });
    const cancelled = await batch({ moves: ['CANCELLED'] });
    const running = await batch({ status: 'IN_PROGRESS' });
    const closed = await closedBatches();
    for (const id of [locked, reLocked, aborted, cancelled]) expect(closed.has(id), id).toBe(true);
    for (const id of [underAmendment, completeOnly, reopened, running]) expect(closed.has(id), id).toBe(false);
    // closed at its latest closing event: the lock, the closed amendment, the latest move to ABORTED.
    const at = async (id: string) => (await db.admin.query<{ t: string }>("select closed_at::text as t from report.closed_record_v1 where record_type = 'batch' and record_id = $1", [id])).rows[0]!.t;
    expect(await at(locked)).toBe(await lockedAt(locked));
    expect(await at(reLocked)).toBe(await lockedAt(reLocked));
    expect(await at(aborted)).toBe((await db.admin.query<{ t: string }>("select to_timestamp((1790000000000000 + 7 * 1000000)::numeric / 1000000)::text as t")).rows[0]!.t);
  });

  it('[DI-08][DI-44] a closed batch record\'s archive package is every chain keyed by the batch, its record lock and amendments included, and the signature chains of its parts, record-lock amendments included', async () => {
    const complete = await batch({ moves: ['EXECUTION_COMPLETE'], locks: ['LOCKED', 'AMENDMENT_OPENED', 'AMENDMENT_CLOSED'] });
    const other = await batch({ moves: ['EXECUTION_COMPLETE'], locks: ['LOCKED'] });
    await signature('batch_step', `${complete}:STAGE-1/STEP-2`);
    await signature('batch_issue', complete);
    await signature('batch_audit_review', `${complete}/1`);
    await signature('record_lock', `${complete}/1/OPEN/DEVIATION/${randomUUID()}`);
    await signature('batch_step', `${other}:STAGE-1/STEP-2`);
    await signature('output_container', randomUUID());
    await signature('batch_step', `${complete}0:STEP-1`);
    const closed = await closedBatches();
    const keys = closed.get(complete)!;
    const own = keys.filter((k) => !k.startsWith('esig_signature:'));
    expect(own[0]).toBe(`batch:${complete}`);
    expect(own).toEqual(expect.arrayContaining([`batch_review:${complete}`, `record_lock:${complete}`, `form_reconciliation:${complete}`]));
    const { rows } = await db.admin.query<{ t: string }>("select distinct aggregate_type as t from kernel.audited_table where aggregate_column = 'batch_id'");
    expect(own.map((k) => k.split(':')[0]).sort()).toEqual(rows.map((r) => r.t).sort());
    expect(keys.filter((k) => k.startsWith('esig_signature:'))).toEqual([
      `esig_signature:batch_audit_review:${complete}/1`, `esig_signature:batch_issue:${complete}`, `esig_signature:batch_step:${complete}:STAGE-1/STEP-2`,
      keys.find((k) => k.startsWith(`esig_signature:record_lock:${complete}/1/OPEN/`))!,
    ].sort());
    expect(keys.some((k) => k.startsWith('esig_signature:record_lock:'))).toBe(true);
    // The range lookup can use the index on esig.signature (sequential scans off: the test table is small).
    const c = await db.admin.connect();
    let plan: string;
    try {
      await c.query('begin');
      await c.query('set local enable_seqscan = off');
      plan = (await c.query<Record<string, string>>(`explain select 1 from esig.signature s where s.aggregate_type = any(array['batch_step', 'record_lock'])
                                                         and s.aggregate_id collate "C" >= $1 and s.aggregate_id collate "C" < $1 || '~'`, [complete])).rows.map((r) => Object.values(r)[0]).join('\n');
      await c.query('rollback');
    } finally {
      c.release();
    }
    expect(plan).toMatch(/signature_type_id_c/);
    const { rows: s } = await db.admin.query<{ sample_key: string }>("select sample_key from report.readability_sample_rows_v1('s', clock_timestamp(), 1000) where record_id = $1", [complete]);
    expect(s[0]?.sample_key).toBe(createHash('sha256').update(`s:batch:${complete}`).digest('hex'));
  });

  it('[DI-08][DI-44][IN-53] an export or a readability read of a closed batch holding controlled-substance rows needs CONTROLLED.READ with no site or product limit: a holder without it is refused, never served a partial copy', async () => {
    const w = await ExportWorld.create(db);
    try {
      const controlled = await batch({ moves: ['EXECUTION_COMPLETE'], locks: ['LOCKED'] });
      // The checkpoint row as the audit trail records it (the superuser under a stated actor; the act is proven in
      // recipe-core 1033's tests): the batch chain now holds a controlled table's row.
      const c = await db.admin.connect();
      try {
        await c.query('begin');
        await c.query(`select kernel.set_actor_context(jsonb_build_object('person_id', gen_random_uuid(), 'account_id', gen_random_uuid(), 'role_code', 'QA_SHOP_FLOOR',
                         'session_id', gen_random_uuid(), 'source', 'SYSTEM', 'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Fixture'))`);
        await c.query(`insert into recipe.controlled_checkpoint (batch_id, stage_key, material_code, unit, dispensed, consumed, in_process, returned, destroyed, difference,
                                                                recorded_by_person, recorded_by_account, correlation_id)
                       values ($1, 'STAGE-1', 'API-CTRL', 'kg', 1, 1, 0, 0, 0, 0, $2, $2, $2)`, [controlled, randomUUID()]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      } finally {
        c.release();
      }
      await expect(w.export()).rejects.toThrow(/EBMR-IAM-040 .*CONTROLLED\.READ/);
      const { rows } = await w.report.query<{ rank: number }>("select rank from report.readability_sample_rows_v1('c', clock_timestamp(), 1000) where record_id = $1", [controlled]);
      const now = await w.now();
      await expect(withCommand(db.app, again(w.lead), (c) => c.query('select records.readability_snapshot($1, $2::timestamptz, 1000, $3)', ['c', now, rows[0]!.rank]))).rejects.toThrow(/EBMR-IAM-040 .*CONTROLLED\.READ/);
      // With CONTROLLED.READ (granted to the lead's role here as a fixture) the read passes the gate.
      await fixture("insert into iam.role_permission (role_code, permission_code) values ('CSV_DI_LEAD', 'CONTROLLED.READ')");
      const r = await withCommand(db.app, again(w.lead), async (c) => (await c.query<{ r: { recordId: string } }>('select records.readability_snapshot($1, $2::timestamptz, 1000, $3) as r', ['c', now, rows[0]!.rank])).rows[0]!.r);
      expect(r.recordId).toBe(controlled);
    } finally {
      w.cleanUp();
    }
  });
});
