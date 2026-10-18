/**
 * The closed batch records (recipe-core 1240; Phase 7 slice 7b-2; DI-08 clause 2, DI-44 clause 1): a GMP batch record
 * whose execution ended is a closed record, read through the reporting path with the chains of its archive package:
 * the batch record, its review, its contingency forms and the signature chains of its parts. Batches, status events and
 * signatures are fixtures written by the superuser with triggers off (each act is proven where it is built).
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/** A GMP batch (fixture) and, with `to`, its first status change to that status. */
async function batch(to: string | null): Promise<string> {
  const id = randomUUID();
  const who = randomUUID();
  await fixture(
    `insert into recipe.batch_execution (id, batch_number, content_hash, installation, purpose, engine_version, registry_fingerprint, policy, policy_hash, issue_request,
                                         market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person, issued_by_account, correlation_id,
                                         control_recipe_id, issue_signature_id)
     values ($1, $2, $3, 'GMP', 'GMP_BATCH', '1', $3, '{}', $3, '{}', '{IN}', 'BS-1', 'SITE-1', 'Asia/Kolkata', 0, $4, $4, $4, gen_random_uuid(), gen_random_uuid())`,
    [id, `B-${id.slice(0, 8)}`, HASH, who],
  );
  if (to) {
    await fixture(
      `with c as (insert into recipe.execution_command (batch_id, seq, kind, command_id, command_type, command, command_hash, actor_person, actor_account, actor_role, source,
                                                     session_id, device_class, now_us, accepted, state_version, state_hash, events_hash, event_count, prev_row_hash, row_hash, correlation_id)
                  values ($1, 5, 'COMMAND', $2, 'SIGN_OFF_STAGE', '{}', $3, $4, $4, 'HEAD_OF_PRODUCTION', 'UI', $4, 'PERSONAL', 1790000000000000, true, 1, $3, $3, 1, $3, $3, $4)
                  returning batch_id, seq)
       insert into recipe.execution_event (batch_id, row_seq, idx, event_type, event)
       select c.batch_id, c.seq, 0, 'BATCH_STATUS_CHANGED', jsonb_build_object('from', 'IN_PROGRESS', 'to', $5::text) from c`,
      [id, randomUUID(), HASH, who, to],
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

describe('the closed batch records (recipe-core 1240)', () => {
  it('[DI-08][DI-44] a GMP batch whose execution ended is a closed record with the chains of its archive package and the signature chains of its parts; a running batch is not', async () => {
    const complete = await batch('EXECUTION_COMPLETE');
    const aborted = await batch('ABORTED');
    const running = await batch(null);
    const other = await batch('EXECUTION_COMPLETE');
    await signature('batch_step', `${complete}:STAGE-1/STEP-2`);
    await signature('batch_issue', complete);
    await signature('batch_audit_review', `${complete}/1`);
    await signature('batch_step', `${other}:STAGE-1/STEP-2`);
    await signature('output_container', randomUUID());
    // A batch whose id merely starts like this one's is not its part.
    await signature('batch_step', `${complete}0:STEP-1`);
    const closed = await closedBatches();
    expect([...closed.keys()].sort()).toEqual(expect.arrayContaining([complete, aborted, other].sort()));
    expect(closed.has(running)).toBe(false);
    expect(closed.get(complete)).toEqual([
      `batch:${complete}`, `batch_review:${complete}`, `form_reconciliation:${complete}`,
      ...[`esig_signature:batch_audit_review:${complete}/1`, `esig_signature:batch_issue:${complete}`, `esig_signature:batch_step:${complete}:STAGE-1/STEP-2`].sort(),
    ]);
    expect(closed.get(aborted)).toEqual([`batch:${aborted}`, `batch_review:${aborted}`, `form_reconciliation:${aborted}`]);
    // The sample key is the seeded SHA-256 of the record (kernel 1335), the same through the reporting path.
    const { rows } = await db.admin.query<{ sample_key: string }>("select sample_key from report.readability_sample_rows_v1('s', clock_timestamp(), 1000) where record_id = $1", [complete]);
    expect(rows[0]?.sample_key).toBe(createHash('sha256').update(`s:batch:${complete}`).digest('hex'));
  });
});
