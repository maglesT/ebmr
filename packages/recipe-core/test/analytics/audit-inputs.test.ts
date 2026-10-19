/**
 * The audit-trail inputs of slice 6A-4 (kernel 1260, recipe-core 1150; decision 0016 item 8; draft controls DI-53,
 * DI-51; D-6A-4-1, D-6A-4-2, D-6A-4-8): report.audit_fact_v1 gives one row per audit event of a person with who, what,
 * where and when, whether it is a correction and, for a batch record's entry, its item, step, attempt, failure and
 * claimed time, and never an old or new value; report.manual_digit_v1 gives only the last digit of each manual entry;
 * report.auth_fact_v1 gives logins, failed logins and lockouts with terminal and time. All three are on the analytics
 * role's allow-list only: the application and reporting roles cannot read them, and the segregation check stays clean.
 *
 * TEST FIXTURE: the batch record, its command rows and their audit events are written as the database owner with
 * triggers off, shaped as the execution writers and kernel.append_audit_event write them (the floor flow and the audit
 * trigger are proven by the engine, execution and audit tests); so are the authentication rows.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../../kernel/src/db/command.ts';
import { segregationProblems } from '../../../kernel/src/sandbox/provision.ts';
import { seedActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { ensureFixtureChangeRecord, underChange } from '../../../kernel/test/support/change-record.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../../../kernel/test/support/db.ts';

let db: TestDatabase;
const P = randomUUID();
const A = randomUUID();
const SERVICE = randomUUID();
const SERVICE_PERSON = randomUUID();
const DEVICE = randomUUID();
const B = randomUUID();
const ids: Record<string, string> = {};
let configTable = '';
let zone = 'UTC';
// Mutation triage at the Phase 7 exit (D-P7-1 item 4): a second GMP batch with no deviation link, a sandbox batch, a
// batch for the window's boundary, and the events each filter of the views must leave out (keys in `more`).
const B2 = randomUUID();
const SBX = randomUUID();
const B4 = randomUUID();
const more: Record<string, string> = {};
const NIL = '00000000-0000-0000-0000-000000000000';

const us = (iso: string): string => (BigInt(Date.parse(iso)) * 1000n).toString();

async function as<T extends pg.QueryResultRow>(user: { name: string; password: string }, text: string, values: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: urlFor(db.name, user) });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}
const ANALYTICS = { name: 'ebmr_analytics', password: 'ebmr_analytics' };
const REPORT = { name: 'ebmr_report', password: 'ebmr_report' };

/** TEST FIXTURE: rows written as the database owner with triggers off. */
async function fixture(statements: [string, unknown[]][]): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    for (const [sql, params] of statements) await c.query(sql, params);
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}

const actor = (person: string, account: string, reason: string | null = null) => ({
  actor: { person_id: person, account_id: account, role_code: 'OPERATOR', session_id: randomUUID(), device_id: DEVICE, auth_event_id: null, legal_name: 'Asha Operator' },
  source: 'UI', reason_code: reason, reason_text: reason ? 'typing error, corrected against the balance printout' : null,
});

/** One audit event as kernel.append_audit_event writes it (its id kept under `key`). */
async function auditEvent(key: string, e: { chain: string; action: string; table: string | null; record: string | null; correlation: string; at: string; payload: Record<string, unknown> }): Promise<void> {
  const { rows } = await db.admin.query<{ s: string }>('select coalesce(max(seq), 0) + 1 as s from kernel.audit_event where chain_key = $1', [e.chain]);
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const r = await c.query<{ id: string }>(
      `insert into kernel.audit_event (chain_key, seq, prev_hash, hash, recorded_at, correlation_id, action, table_name, record_id, payload)
       values ($1, $2, '\\x00', '\\x01', $3, $4, $5, $6, $7, $8::jsonb) returning id::text`,
      [e.chain, rows[0]!.s, e.at, e.correlation, e.action, e.table, e.record, JSON.stringify({ chain_key: e.chain, action: e.action, table: e.table, record_id: e.record, ...e.payload })],
    );
    await c.query('commit');
    ids[key] = r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** One execution command row of batch B and its audit event. */
async function command(key: string, seq: number, type: string, at: string, body: Record<string, unknown>, reason: string | null = null): Promise<void> {
  const correlation = randomUUID();
  await fixture([[
    `insert into recipe.execution_command (batch_id, seq, kind, command_id, command_type, command, command_hash, actor_person, actor_account, actor_role, source, session_id,
                                           device_id, device_class, now_us, accepted, state_version, state_hash, events_hash, event_count, prev_row_hash, row_hash, correlation_id, recorded_at)
     values ($1, $2::bigint, $3, $4, $5, $6::jsonb, repeat('a', 64), $7, $8, 'OPERATOR', 'UI', gen_random_uuid(), $9, 'SHARED', $10, true, $2::integer, repeat('b', 64), repeat('c', 64), 1,
             repeat('d', 64), repeat('e', 64), $11, $12)`,
    [B, seq, seq === 1 ? 'ISSUE' : 'COMMAND', `cmd-${randomUUID()}`, type, JSON.stringify({ type, ...body }), P, A, DEVICE, us(at), correlation, at],
  ]]);
  await auditEvent(key, { chain: `batch:${B}`, action: 'INSERT', table: 'recipe.execution_command', record: B, correlation, at, payload: { ...actor(P, A, reason), body: { row_hash: 'f'.repeat(64) } } });
}

/** TEST FIXTURE: one execution command row of `batch` (recorded at `commandAt`) and its audit event (at `eventAt`, key in `more`). */
async function commandOn(batch: string, key: string, seq: number, type: string, commandAt: string, eventAt: string, body: Record<string, unknown>, correlation: string = randomUUID()): Promise<void> {
  await fixture([[
    `insert into recipe.execution_command (batch_id, seq, kind, command_id, command_type, command, command_hash, actor_person, actor_account, actor_role, source, session_id,
                                           device_id, device_class, now_us, accepted, state_version, state_hash, events_hash, event_count, prev_row_hash, row_hash, correlation_id, recorded_at)
     values ($1, $2::bigint, $3, $4, $5, $6::jsonb, repeat('a', 64), $7, $8, 'OPERATOR', 'UI', gen_random_uuid(), $9, 'SHARED', $10, true, $2::integer, repeat('b', 64), repeat('c', 64), 1,
             repeat('d', 64), repeat('e', 64), $11, $12)`,
    [batch, seq, seq === 1 ? 'ISSUE' : 'COMMAND', `cmd-${randomUUID()}`, type, JSON.stringify({ type, ...body }), P, A, DEVICE, us(commandAt), correlation, commandAt],
  ]]);
  await auditEvent(key, { chain: `batch:${batch}`, action: 'INSERT', table: 'recipe.execution_command', record: batch, correlation, at: eventAt, payload: { ...actor(P, A), body: { row_hash: 'f'.repeat(64) } } });
  more[key] = ids[key]!;
  delete ids[key];
}

/** TEST FIXTURE: a batch execution row (GMP, or a sandbox test run) as the issue writes it. */
const batchRow = (id: string, gmp: boolean): [string, (string | null)[]] => [
  `insert into recipe.batch_execution (id, batch_number, content_hash, installation, purpose, engine_version, registry_fingerprint, policy, policy_hash, issue_request,
                                       market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person, issued_by_account, correlation_id,
                                       control_recipe_id, issue_signature_id, package_hash)
   values ($1, $2, repeat('a', 64), $3, $4, 'test', repeat('b', 64), '{}', repeat('c', 64), '{}', array['IN'], 'BS-1', 'SITE-1', 'Asia/Kolkata',
           1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $5::uuid, $5::uuid, $6)`,
  [id, `AT-${randomUUID().slice(0, 8).toUpperCase()}`, gmp ? 'GMP' : 'SANDBOX', gmp ? 'GMP_BATCH' : 'SANDBOX_TEST_RUN', gmp ? randomUUID() : null, gmp ? null : 'f'.repeat(64)],
];

const point = (o: { item: string; step: string; attempt: number; seq: number; value: string; failed: boolean; at: string; occurred?: string; supersedes?: string }) => ({
  id: `pt-${String(o.seq)}`, item: o.item, stepKey: o.step, step: o.step, frames: [], attempt: o.attempt, version: o.supersedes ? 2 : 1, kind: 'VALUE',
  value: { kind: 'DECIMAL', value: o.value, unit: 'kp' }, source: { mode: 'MANUAL' }, enteredBy: P, recordedAt: { $u: us(o.at) }, recordedSeq: o.seq,
  ...(o.occurred ? { occurredAt: { us: { $u: us(o.occurred) }, trust: 'USER_CLAIMED' } } : {}), timeBasis: 'RECORDED_AT', status: 'VALID',
  ...(o.supersedes ? { supersedes: o.supersedes } : {}), failed: o.failed, flags: [], exceptions: [],
});

beforeAll(async () => {
  db = await createTestDatabase();
  zone = (await db.admin.query<{ z: string }>("select coalesce(kernel.site_zone(), 'UTC') as z")).rows[0]!.z;
  configTable = (await db.admin.query<{ t: string }>('select table_name::text as t from platform.config_area order by code limit 1')).rows[0]!.t;
  const t0 = new Date(Date.now() - 3 * 86_400_000);
  const at = (min: number): string => new Date(t0.getTime() + min * 60_000).toISOString();
  await fixture([
    ["insert into iam.device (id, code, device_class, site_code, key_fingerprint, description, registered_by_person) values ($1, 'TAB-FX-01', 'SHARED', 'SITE-1', repeat('9', 64), 'fixture terminal', gen_random_uuid())", [DEVICE]],
    [`insert into recipe.batch_execution (id, batch_number, content_hash, installation, purpose, engine_version, registry_fingerprint, policy, policy_hash, issue_request,
                                          market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person, issued_by_account, correlation_id,
                                          control_recipe_id, issue_signature_id)
      values ($1, $2, repeat('a', 64), 'GMP', 'GMP_BATCH', 'test', repeat('b', 64), '{}', repeat('c', 64), '{}', array['IN'], 'BS-1', 'SITE-1', 'Asia/Kolkata',
              1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`, [B, `AT-${randomUUID().slice(0, 6).toUpperCase()}`]],
    [`insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status)
      values ($1, $2::jsonb, 4, repeat('a', 64), 4, repeat('b', 64), 'IN_PROGRESS')`, [B, JSON.stringify({ points: {
      'pt-2': point({ item: 'hardness', step: 'compression', attempt: 1, seq: 2, value: '6.531', failed: true, at: at(10), occurred: at(-20) }),
      'pt-3': point({ item: 'hardness', step: 'compression', attempt: 2, seq: 3, value: '7.257', failed: false, at: at(12) }),
      'pt-4': point({ item: 'hardness', step: 'compression', attempt: 2, seq: 4, value: '7.309', failed: false, at: at(14), supersedes: 'pt-3' }),
    } })]],
    ["insert into site.deviation_link (deviation_id, subject_kind, subject_id, subject_ref, batch_id, batch_number, edition, linked_by_person, linked_by_account) values (gen_random_uuid(), 'BATCH', $1, 'x', $1, 'AT-1', 'TABLETS', gen_random_uuid(), gen_random_uuid())", [B]],
  ]);
  await command('issue', 1, 'ISSUE', at(0), {});
  await command('first', 2, 'RECORD_DATA', at(10), { item: 'hardness', step: 'compression' });
  await command('second', 3, 'RECORD_DATA', at(12), { item: 'hardness', step: 'compression' });
  await command('correction', 4, 'CORRECT_ENTRY', at(14), { point: 'pt-3' }, 'TYPO');
  // A configuration change (an update with values in its body) by the person, and two events that are left out: one of
  // the release (the nil person) and one without a person.
  await auditEvent('config', { chain: 'config_area:X', action: 'UPDATE', table: configTable, record: 'X', correlation: randomUUID(), at: at(20),
    payload: { ...actor(P, A, 'CONFIG_CHANGE'), body: { old: { limit_text: 'OLD-SECRET-111' }, new: { limit_text: 'NEW-SECRET-222', note: 'NEW-SECRET-333' } } } });
  const nil = '00000000-0000-0000-0000-000000000000';
  await auditEvent('release', { chain: 'config_area:X', action: 'INSERT', table: configTable, record: 'X', correlation: randomUUID(), at: at(21), payload: { ...actor(nil, nil), body: { new: { a: 1 } } } });
  // Authentication facts: a login, a failed login and a lockout of the human account; a service account's login is left out.
  await fixture([
    [`insert into iam.auth_event (id, person_id, account_id, device_id, device_class, method, components, purpose, recorded_at)
      values (gen_random_uuid(), $1, $2, $3, 'SHARED', 'PASSWORD', array['PASSWORD'], 'LOGIN', $4), (gen_random_uuid(), $6, $5, $3, 'SHARED', 'SERVICE_KEY', array['KEY'], 'LOGIN', $4)`,
     [P, A, DEVICE, at(1), SERVICE, SERVICE_PERSON]],
    ["insert into iam.authn_attempt (attempted_at, method, purpose, account_id, device_id, outcome, reason) values ($1, 'PASSWORD', 'LOGIN', $2, $3, 'FAILURE', 'BAD_SECRET')", [at(2), A, DEVICE]],
    ["insert into iam.account_lock_event (account_id, event, reason, recorded_at) values ($1, 'LOCKED', 'five failures', $2)", [A, at(3)]],
  ]);
  await fixture([
    [`insert into iam.account (id, person_id, login_name, kind, status) values ($1, $2, 'asha.fx', 'HUMAN', 'ACTIVE'), ($3, $4, 'erp.fx', 'SERVICE', 'ACTIVE')`, [A, P, SERVICE, SERVICE_PERSON]],
  ]);
  // Mutation triage (D-P7-1 item 4): the authentication rows each branch leaves out: another purpose, a success, an
  // unlock, the service account's failure and lockout, and events older than 26 weeks.
  const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
  await fixture([
    [`insert into iam.auth_event (id, person_id, account_id, device_id, device_class, method, components, purpose, recorded_at)
      values (gen_random_uuid(), $1, $2, $3, 'SHARED', 'PASSWORD', array['PASSWORD'], 'COMMAND', $4), (gen_random_uuid(), $1, $2, $3, 'SHARED', 'PASSWORD', array['PASSWORD'], 'LOGIN', $5)`,
     [P, A, DEVICE, at(4), old]],
    [`insert into iam.authn_attempt (attempted_at, method, purpose, account_id, device_id, outcome, reason)
      values ($1, 'PASSWORD', 'LOGIN', $2, $3, 'SUCCESS', 'OK'), ($1, 'PASSWORD', 'COMMAND', $2, $3, 'FAILURE', 'BAD_SECRET'),
             ($1, 'SERVICE_KEY', 'LOGIN', $4, $3, 'FAILURE', 'BAD_SECRET'), ($5, 'PASSWORD', 'LOGIN', $2, $3, 'FAILURE', 'BAD_SECRET')`, [at(5), A, DEVICE, SERVICE, old]],
    [`insert into iam.account_lock_event (account_id, event, reason, recorded_at) values ($1, 'UNLOCKED', 'unlocked by the administrator', $3),
             ($2, 'LOCKED', 'five failures', $3), ($1, 'LOCKED', 'five failures', $4)`, [A, SERVICE, at(6), old]],
  ]);
  // A second GMP batch (no deviation linked): a point whose recorded sequence is not a number, a device entry, a branch
  // point with a failure flag, and in its issue correlation an earlier audit event of another table on the same record.
  const pointOf = (id: string, seq: unknown, over: Record<string, unknown>) => ({ ...point({ item: 'weight', step: 'blending', attempt: 1, seq: 0, value: '5.551', failed: false, at: at(30) }), id, recordedSeq: seq, ...over });
  await fixture([
    batchRow(B2, true), batchRow(SBX, false),
    [`insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status)
      values ($1, $2::jsonb, 3, repeat('a', 64), 3, repeat('b', 64), 'IN_PROGRESS'), ($3, $4::jsonb, 1, repeat('a', 64), 1, repeat('b', 64), 'IN_PROGRESS')`, [B2, JSON.stringify({ points: {
      'q-1': pointOf('q-1', 'x', {}),
      'q-2': pointOf('q-2', 2, { source: { mode: 'DEVICE' } }),
      'q-3': pointOf('q-3', 3, { kind: 'BRANCH', value: { kind: 'TEXT', value: 'B' }, failed: true }),
    } }), SBX, JSON.stringify({ points: { 's-1': pointOf('s-1', 1, { value: { kind: 'DECIMAL', value: '3.142', unit: 'kp' } }) } })]],
  ]);
  const issueCorrelation = randomUUID();
  await auditEvent('b2Row', { chain: `batch:${B2}`, action: 'INSERT', table: 'recipe.batch_execution', record: B2, correlation: issueCorrelation, at: at(29), payload: { ...actor(P, A), body: { new: { id: B2 } } } });
  more['b2Row'] = ids['b2Row']!;
  delete ids['b2Row'];
  await commandOn(B2, 'b2Issue', 1, 'ISSUE', at(30), at(30), {}, issueCorrelation);
  await commandOn(B2, 'b2Device', 2, 'RECORD_DATA', at(31), at(31), { item: 'weight' });
  await commandOn(B2, 'b2Branch', 3, 'RECORD_DATA', at(32), at(32), { item: 'weight' });
  // A command row recorded more than an hour before the 26 weeks, whose audit event is recent: not paired.
  await commandOn(B2, 'b2Early', 4, 'RECORD_DATA', new Date(Date.now() - (182 * 24 + 2) * 3_600_000).toISOString(), at(33), {});
  // A void of batch B that names its point and records none: its item comes from the point it names.
  await commandOn(B, 'void', 5, 'VOID_ATTEMPT', at(34), at(34), { point: 'pt-2' });
  await commandOn(SBX, 'sandbox', 1, 'RECORD_DATA', at(35), at(35), {});
  // A person's insert of configuration (values in its body): no changed fields.
  await auditEvent('configInsert', { chain: 'config_area:Y', action: 'INSERT', table: configTable, record: 'Y', correlation: randomUUID(), at: at(36), payload: { ...actor(P, A), body: { new: { limit_text: 'NEW-SECRET-444' } } } });
  more['configInsert'] = ids['configInsert']!;
  delete ids['configInsert'];
}, 600_000);

afterAll(async () => {
  await db?.drop();
});

const AUDIT_COLUMNS = ['event_id', 'chain_key', 'recorded_at', 'recorded_local', 'claimed_at', 'person_id', 'account_id', 'role', 'terminal', 'action', 'command_type', 'table_name', 'field',
  'is_correction', 'reason_code', 'batch_id', 'step', 'attempt', 'failed', 'deviation_linked', 'config_area', 'read_at', 'data_as_of'];

describe('the audit-trail inputs (kernel 1260, recipe-core 1150)', () => {
  it('[DI-51][DI-53] the audit fact view exports no old or new value', async () => {
    const cols = await db.admin.query<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'report' and table_name = 'audit_fact_v1' order by ordinal_position");
    expect(cols.rows.map((r) => r.c)).toEqual(AUDIT_COLUMNS);
    const rows = await as<Record<string, unknown>>(ANALYTICS, 'select * from report.audit_fact_v1 where event_id = any($1::text[]) order by event_id::bigint', [Object.values(ids)]);
    const text = JSON.stringify(rows);
    // Neither the values of the configuration change nor the recorded values of the entries leave the database.
    for (const secret of ['OLD-SECRET-111', 'NEW-SECRET-222', 'NEW-SECRET-333', '6.531', '7.257', '7.309', 'typing error', 'row_hash']) expect(text, secret).not.toContain(secret);
    // Only which fields changed.
    expect(rows.find((r) => r['event_id'] === ids['config'])).toMatchObject({ action: 'UPDATE', table_name: configTable, field: 'limit_text, note', is_correction: true, reason_code: 'CONFIG_CHANGE' });
    const digits = await db.admin.query<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'report' and table_name = 'manual_digit_v1' order by ordinal_position");
    expect(digits.rows.map((r) => r.c)).toEqual(['event_id', 'chain_key', 'person_id', 'batch_id', 'step', 'item', 'recorded_at', 'recorded_local', 'terminal_digit', 'read_at', 'data_as_of']);
  });

  it('[DI-53] the audit facts give each entry of a person with who, where, when, its item, step, attempt, failure, claimed time and correction, and leave the release out', async () => {
    const rows = await as<Record<string, unknown>>(ANALYTICS,
      `select event_id, chain_key, to_char(recorded_at at time zone $2, 'YYYY-MM-DD"T"HH24:MI:SS') = recorded_local as local_ok, claimed_at is not null as claimed, person_id::text, account_id::text,
              role, terminal, action, command_type, table_name, field, is_correction, reason_code, batch_id::text, step, attempt, failed, deviation_linked, config_area
         from report.audit_fact_v1 where event_id = any($1::text[]) order by event_id::bigint`, [Object.values(ids), zone]);
    const common = { chain_key: `batch:${B}`, local_ok: true, person_id: P, account_id: A, role: 'OPERATOR', terminal: 'TAB-FX-01', action: 'INSERT', table_name: 'recipe.execution_command',
                     batch_id: B, deviation_linked: true, config_area: null };
    expect(rows.slice(0, 4)).toEqual([
      { ...common, event_id: ids['issue'], claimed: false, command_type: 'ISSUE', field: null, is_correction: false, reason_code: null, step: null, attempt: null, failed: null },
      { ...common, event_id: ids['first'], claimed: true, command_type: 'RECORD_DATA', field: 'hardness', is_correction: false, reason_code: null, step: 'compression', attempt: 1, failed: true },
      { ...common, event_id: ids['second'], claimed: false, command_type: 'RECORD_DATA', field: 'hardness', is_correction: false, reason_code: null, step: 'compression', attempt: 2, failed: false },
      { ...common, event_id: ids['correction'], claimed: false, command_type: 'CORRECT_ENTRY', field: 'hardness', is_correction: true, reason_code: 'TYPO', step: 'compression', attempt: 2, failed: false },
    ]);
    // The configuration change names its area; the release's own event is not a person's and is left out.
    expect(rows[4]).toMatchObject({ event_id: ids['config'], batch_id: null, config_area: expect.stringMatching(/^[A-Z][A-Z0-9_]+$/) as unknown, deviation_linked: false });
    expect(rows).toHaveLength(5);
    // The claimed time of the late entry is its occurredAt.
    const [late] = await as<{ lag: number }>(ANALYTICS, 'select extract(epoch from recorded_at - claimed_at)::integer as lag from report.audit_fact_v1 where event_id = $1', [ids['first']]);
    expect(late!.lag).toBe(30 * 60);
    // Only the last digit of each manual entry, tied to its audit entry.
    const digits = await as<{ event_id: string; person_id: string; item: string; step: string; terminal_digit: number }>(ANALYTICS,
      'select event_id, person_id::text, item, step, terminal_digit from report.manual_digit_v1 where batch_id = $1 order by event_id::bigint', [B]);
    expect(digits).toEqual([
      { event_id: ids['first'], person_id: P, item: 'hardness', step: 'compression', terminal_digit: 1 },
      { event_id: ids['second'], person_id: P, item: 'hardness', step: 'compression', terminal_digit: 7 },
      { event_id: ids['correction'], person_id: P, item: 'hardness', step: 'compression', terminal_digit: 9 },
    ]);
  });

  it('[DI-53] the authentication facts give logins, failed logins and lockouts of human accounts with terminal and time, and nothing secret', async () => {
    const cols = await db.admin.query<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'report' and table_name = 'auth_fact_v1' order by ordinal_position");
    expect(cols.rows.map((r) => r.c)).toEqual(['event_ref', 'account_id', 'person_id', 'terminal', 'kind', 'at', 'at_local', 'read_at', 'data_as_of']);
    const rows = await as<{ kind: string; terminal: string | null; person_id: string; ref: boolean; local_ok: boolean }>(ANALYTICS,
      `select kind, terminal, person_id::text, event_ref ~ '^(auth_event|authn_attempt|account_lock_event):' as ref,
              to_char(at at time zone $2, 'YYYY-MM-DD"T"HH24:MI:SS') = at_local as local_ok
         from report.auth_fact_v1 where account_id = any($1::uuid[]) order by at`, [[A, SERVICE], zone]);
    expect(rows).toEqual([
      { kind: 'LOGIN', terminal: 'TAB-FX-01', person_id: P, ref: true, local_ok: true },
      { kind: 'FAILED', terminal: 'TAB-FX-01', person_id: P, ref: true, local_ok: true },
      { kind: 'LOCKOUT', terminal: null, person_id: P, ref: true, local_ok: true },
    ]);
  });

  it('[DI-53][DI-51] only the analytics role reads the audit and authentication facts: the application and reporting roles are refused, and the segregation check stays clean', async () => {
    for (const view of ['report.audit_fact_v1', 'report.manual_digit_v1', 'report.auth_fact_v1']) {
      await expect(db.app.query(`select count(*) from ${view}`), view).rejects.toThrow(/permission denied/);
      await expect(as(REPORT, `select count(*) from ${view}`), view).rejects.toThrow(/permission denied/);
      await expect(as(ANALYTICS, `select count(*) from ${view}`), view).resolves.toBeDefined();
    }
    const { rows } = await db.admin.query<{ name: string; owner_slice: string }>("select name, owner_slice from analytics.input_catalog_v1 where owner_slice = '6A-4' order by name");
    expect(rows).toEqual([
      { name: 'report.audit_fact_v1', owner_slice: '6A-4' }, { name: 'report.auth_fact_v1', owner_slice: '6A-4' }, { name: 'report.manual_digit_v1', owner_slice: '6A-4' },
    ]);
    // They are not in the report catalogue (the dashboards' documented export lists only catalogued views).
    const { rows: catalogued } = await db.admin.query("select view_name from report.view_registry where view_name in ('audit_fact_v1', 'manual_digit_v1', 'auth_fact_v1')");
    expect(catalogued).toEqual([]);
    expect(await segregationProblems(db.app)).toEqual([]);
  });
});

describe('the audit-trail inputs leave out what they do not describe (mutation triage at the Phase 7 exit, D-P7-1 item 4)', () => {
  it('[DI-53][DI-51] the audit facts pair each command with its own audit event, take a named point for an entry that records none, and leave out sandbox batches', async () => {
    const rows = await as<Record<string, unknown>>(ANALYTICS,
      `select event_id, command_type, table_name, field, is_correction, batch_id::text, step, attempt, failed, deviation_linked
         from report.audit_fact_v1 where event_id = any($1::text[]) order by event_id::bigint`, [Object.values(more)]);
    const none = { field: null, is_correction: false, step: null, attempt: null, failed: null, deviation_linked: false };
    const exec = 'recipe.execution_command';
    expect(rows).toEqual([
      // In the issue's correlation an earlier event of another table on the same record is not taken for the command's.
      { event_id: more['b2Row'], command_type: null, table_name: 'recipe.batch_execution', batch_id: B2, ...none },
      { event_id: more['b2Issue'], command_type: 'ISSUE', table_name: exec, batch_id: B2, ...none },
      // A device entry, and a branch point whose failure flag is not a value's: no failure.
      { event_id: more['b2Device'], command_type: 'RECORD_DATA', table_name: exec, batch_id: B2, ...none, field: 'weight', step: 'blending', attempt: 1, failed: false },
      { event_id: more['b2Branch'], command_type: 'RECORD_DATA', table_name: exec, batch_id: B2, ...none, field: 'weight', step: 'blending', attempt: 1 },
      // A command row recorded more than an hour before the window is not paired with a later event.
      { event_id: more['b2Early'], command_type: null, table_name: exec, batch_id: B2, ...none },
      // A void names the point it voids: its item, step, attempt and failure.
      { event_id: more['void'], command_type: 'VOID_ATTEMPT', table_name: exec, batch_id: B, field: 'hardness', is_correction: true, step: 'compression', attempt: 1, failed: true, deviation_linked: true },
      // A person's insert of configuration names no changed fields; the sandbox batch's command is not there.
      { event_id: more['configInsert'], command_type: null, table_name: configTable, batch_id: null, ...none },
    ]);
    expect(JSON.stringify(rows)).not.toContain('NEW-SECRET-444');
    // Only GMP batch records' manual entries with a decimal or count value give a digit, each once.
    const digits = await as<{ batch_id: string; n: number }>(ANALYTICS, 'select batch_id::text, count(*)::int as n from report.manual_digit_v1 where batch_id = any($1::uuid[]) group by batch_id order by 1', [[B, B2, SBX]]);
    expect(digits).toEqual([{ batch_id: B, n: 3 }]);
  });

  it('[DI-53] the audit facts given by event (as a flag names them) pair the command and its point as the full view does', async () => {
    const { rows } = await db.admin.query<Record<string, unknown>>(
      "select event_id, command_type, field, step, attempt, failed from report.audit_facts('-infinity', $1::bigint[]) order by event_id::bigint", [[ids['first']]]);
    expect(rows).toEqual([{ event_id: ids['first'], command_type: 'RECORD_DATA', field: 'hardness', step: 'compression', attempt: 1, failed: true }]);
    const { rows: two } = await db.admin.query<Record<string, unknown>>(
      "select event_id, command_type, field from report.audit_facts('-infinity', $1::bigint[]) order by event_id::bigint", [[more['void'], more['b2Device']]]);
    expect(two).toEqual([
      { event_id: more['b2Device'], command_type: 'RECORD_DATA', field: 'weight' },
      { event_id: more['void'], command_type: 'VOID_ATTEMPT', field: 'hardness' },
    ]);
  });

  it('[DI-53] the 26 weeks of the audit, manual-entry and authentication facts include their first instant', async () => {
    const pts = JSON.stringify({ points: {
      'b-1': { ...point({ item: 'thickness', step: 'compression', attempt: 1, seq: 1, value: '2.468', failed: false, at: new Date().toISOString() }), id: 'b-1', recordedAt: { $u: '@@U0@@' } },
      'b-2': { ...point({ item: 'thickness', step: 'compression', attempt: 1, seq: 2, value: '1.235', failed: false, at: new Date().toISOString() }), id: 'b-2', recordedAt: { $u: '@@U1@@' } },
    } });
    const [batchSql, batchParams] = batchRow(B4, true);
    const lit = (v: string | null | undefined): string => (v == null ? 'null' : `'${v.replace(/'/g, "''")}'`);
    const batchInsert = batchSql.replace(/\$(\d)(::uuid)?/g, (_m, n: string, cast: string | undefined) => lit(batchParams[Number(n) - 1]) + (cast ?? ''));
    const commandRow = (seq: number, atSql: string, corr: string): string => `
      insert into recipe.execution_command (batch_id, seq, kind, command_id, command_type, command, command_hash, actor_person, actor_account, actor_role, source, session_id,
                                            device_id, device_class, now_us, accepted, state_version, state_hash, events_hash, event_count, prev_row_hash, row_hash, correlation_id, recorded_at)
      values ('${B4}', ${String(seq)}, '${seq === 1 ? 'ISSUE' : 'COMMAND'}', 'cmd-${randomUUID()}', 'RECORD_DATA', '{"type": "RECORD_DATA"}', repeat('a', 64), '${P}', '${A}', 'OPERATOR', 'UI', gen_random_uuid(),
              '${DEVICE}', 'SHARED', '1', true, ${String(seq)}, repeat('b', 64), repeat('c', 64), 1, repeat('d', 64), repeat('e', 64), '${corr}', ${atSql});`;
    const event = (seq: number, corr: string): string => `
      insert into kernel.audit_event (chain_key, seq, prev_hash, hash, recorded_at, correlation_id, action, table_name, record_id, payload)
      values ('batch:${B4}', ${String(seq)}, '\\x00', '\\x01', s, '${corr}', 'INSERT', 'recipe.execution_command', '${B4}',
              jsonb_build_object('chain_key', 'batch:${B4}', 'action', 'INSERT', 'table', 'recipe.execution_command', 'record_id', '${B4}', 'source', 'UI',
                                 'actor', jsonb_build_object('person_id', '${P}', 'account_id', '${A}', 'role_code', 'OPERATOR', 'device_id', '${DEVICE}')));`;
    const [c1, c2] = [randomUUID(), randomUUID()];
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      // TEST FIXTURE in one statement, so the window's first instant (statement time less 182 days) is known exactly.
      await c.query(`do $$
        declare
          s  timestamptz := pg_catalog.statement_timestamp() - interval '182 days';
          u  text := ((extract(epoch from s) * 1000000)::bigint)::text;
          u1 text := ((extract(epoch from s) * 1000000)::bigint - 1)::text;
        begin
          insert into iam.auth_event (id, person_id, account_id, device_id, device_class, method, components, purpose, recorded_at)
          values (gen_random_uuid(), '${P}', '${A}', '${DEVICE}', 'SHARED', 'PASSWORD', array['PASSWORD'], 'LOGIN', s);
          insert into iam.authn_attempt (attempted_at, method, purpose, account_id, device_id, outcome, reason) values (s, 'PASSWORD', 'LOGIN', '${A}', '${DEVICE}', 'FAILURE', 'BAD_SECRET');
          insert into iam.account_lock_event (account_id, event, reason, recorded_at) values ('${A}', 'LOCKED', 'five failures', s);
          ${batchInsert};
          insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status)
          values ('${B4}', pg_catalog.replace(pg_catalog.replace('${pts}', '@@U0@@', u), '@@U1@@', u1)::jsonb, 2, repeat('a', 64), 2, repeat('b', 64), 'IN_PROGRESS');
          -- The first command row an hour before the window's first instant, its event at that instant; the second
          -- entry's point is recorded a microsecond before the window.
          ${commandRow(1, "s - interval '1 hour'", c1)}
          ${commandRow(2, 's', c2)}
          ${event(1, c1)}
          ${event(2, c2)}
          create temporary table boundary_auth as select kind from report.auth_fact_v1 where account_id = '${A}' and at = s;
          create temporary table boundary_audit as select command_type, field from report.audit_fact_v1 where batch_id = '${B4}';
          create temporary table boundary_digit as select item, terminal_digit from report.manual_digit_v1 where batch_id = '${B4}';
        end $$`);
      const auth = await c.query<{ kind: string }>('select kind from boundary_auth order by kind');
      const audit = await c.query<{ command_type: string; field: string }>('select command_type, field from boundary_audit order by field');
      const digit = await c.query<{ item: string; terminal_digit: number }>('select item, terminal_digit from boundary_digit');
      await c.query('rollback');
      expect(auth.rows.map((r) => r.kind)).toEqual(['FAILED', 'LOCKOUT', 'LOGIN']);
      expect(audit.rows).toEqual([{ command_type: 'RECORD_DATA', field: 'thickness' }, { command_type: 'RECORD_DATA', field: 'thickness' }]);
      expect(digit.rows).toEqual([{ item: 'thickness', terminal_digit: 8 }]);
    } finally {
      c.release();
    }
  });
});

describe('the restricted audit-trail flags and the entries behind them (kernel 1261, recipe-core 1151; mutation triage at the Phase 7 exit)', () => {
  const RELEASE = `jsonb_build_object(
    'person_id', '${NIL}', 'account_id', '${NIL}', 'role_code', 'SOFTWARE_RELEASE', 'session_id', '${NIL}', 'source', 'SYSTEM',
    'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Test fixture (audit flags)', 'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'test fixture')`;
  const RUNTIME = { package: '@ebmr/analytics 0.1.0', commit: '0a1b2c3', node: '22.20.0', libraries: {} };
  const INPUTS = [{ view: 'report.audit_fact_v1', version: 1, filter: null, data_as_of: '2026-10-12T04:40:00Z', rows: 3, sha256: 'a'.repeat(64) }];
  const again = <T extends ActorContext>(ctx: T): T => ({ ...ctx, correlationId: randomUUID() });
  let qa: SeededActor;
  let diLead: SeededActor;
  const flags: Record<string, string> = {};

  const beginRun = async (): Promise<string> =>
    (await as<{ id: string }>(ANALYTICS, "select analytics.begin_run('ATA.RULES', 1, null, 'ON_DEMAND', $1::jsonb, $2::jsonb) as id", [JSON.stringify(INPUTS), JSON.stringify(RUNTIME)]))[0]!.id;
  const flag = async (run: string, kind: string, ref: string, rule: string, evidence: { kind: string; ref: string }[]): Promise<string> =>
    (await as<{ id: string }>(ANALYTICS, "select analytics.record_flag($1, null, $2, $3, $4, 'ATTENTION', $5::jsonb) as id",
      [run, kind, ref, rule, JSON.stringify([{ code: rule, text: 'test reason', evidence }])]))[0]!.id;
  const asPerson = <T extends pg.QueryResultRow>(ctx: ActorContext, sql: string, params: unknown[] = []): Promise<T[]> =>
    withCommand(db.app, again(ctx), async (c) => (await c.query<T>(sql, params)).rows);

  beforeAll(async () => {
    await ensureFixtureChangeRecord(db);
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query(`select kernel.set_actor_context(${RELEASE})`);
      await c.query(`insert into iam.role_permission (role_code, permission_code) values
        ('QA_REVIEWER', 'ANALYTICS.VIEW'), ('QA_REVIEWER', 'ANALYTICS.DISPOSITION'), ('CSV_DI_LEAD', 'ANALYTICS.DISPOSITION'), ('CSV_DI_LEAD', 'ANALYTICS.DI_REVIEW')
        on conflict do nothing`);
      await c.query('select kernel.set_actor_context(null)');
      await c.query('commit');
    } finally {
      c.release();
    }
    [qa, diLead] = await Promise.all([seedActor(db, { roleCode: 'QA_REVIEWER' }), seedActor(db, { roleCode: 'CSV_DI_LEAD' })]);
    await withCommand(db.admin, again(underChange(qa)), (c) =>
      c.query(`insert into analytics.method_version (method, version, status, title, intended_use, acceptance, parameters, parameters_sha256, code_identity, validation_ref)
               values ('ATA.RULES', 1, 'EFFECTIVE', 'Test method', 'advisory test', '{"within": "1e-9"}', '{}', $1, '@ebmr/analytics 0.1.0', 'VAL-TEST-1')`, ['a'.repeat(64)]));
    // A finished run: two flags about persons, each naming its own entries (and one evidence of another kind that
    // carries an event number), and an unrestricted flag of the same method naming an entry.
    const done = await beginRun();
    flags['first'] = await flag(done, 'PERSON', P, 'LATE_ENTRY', [{ kind: 'AUDIT_EVENT', ref: `batch:${B}#${ids['first']!}` }, { kind: 'BATCH_NOTE', ref: `batch:${B}#${ids['second']!}` }]);
    flags['config'] = await flag(done, 'PERSON', randomUUID(), 'OFF_HOURS_CONFIG', [{ kind: 'AUDIT_EVENT', ref: `config_area:X#${ids['config']!}` }]);
    flags['batch'] = await flag(done, 'BATCH', B, 'MANY_CORRECTIONS', [{ kind: 'AUDIT_EVENT', ref: `batch:${B}#${ids['issue']!}` }]);
    await as(ANALYTICS, 'select analytics.finish_run($1, $2, $3)', [done, 'b'.repeat(64), '{"flags": 3}']);
    // A failed run's flag about a person.
    const failed = await beginRun();
    flags['failed'] = await flag(failed, 'PERSON', P, 'CORRECTION_AFTER_FAIL', [{ kind: 'AUDIT_EVENT', ref: `batch:${B}#${ids['correction']!}` }]);
    await as(ANALYTICS, 'select analytics.fail_run($1, $2)', [failed, 'the runner stopped']);
  }, 600_000);

  it('[DI-53] the flags about persons are those of finished runs of the audit-trail methods, restricted, in the period, with the current verdict of their key', async () => {
    const list = async (from = "'-infinity'", to = "'infinity'") =>
      (await asPerson<{ flag_id: string; raised_count: number; verdict: string | null }>(diLead, `select flag_id::text, raised_count, verdict from analytics.audit_flags(${from}, ${to})`));
    const all = await list();
    expect(all.map((f) => f.flag_id).sort()).toEqual([flags['first'], flags['config']].sort());
    expect(all.map((f) => f.raised_count)).toEqual([1, 1]);
    // The period's first instant is in it, its last is not.
    const { rows } = await db.admin.query<{ at: string }>('select raised_at::text as at from analytics.flag where id = $1', [flags['first']]);
    const at = rows[0]!.at;
    expect((await list(`'${at}'`, `'${at}'::timestamptz + interval '1 microsecond'`)).map((f) => f.flag_id)).toContain(flags['first']);
    expect((await list(`'${at}'::timestamptz - interval '1 hour'`, `'${at}'`)).map((f) => f.flag_id)).not.toContain(flags['first']);
    expect(await list(`'${at}'`, `'${at}'`)).toEqual([]);
    for (const [from, to] of [['null', 'now()'], ['now()', 'null'], ['now()', "now() - interval '1 second'"]]) {
      await expect(list(from, to), `${from} ${to}`).rejects.toThrow(/EBMR-ANA-011/);
    }
    // A superseded verdict is not the key's verdict: the superseding one is.
    const [d1] = await asPerson<{ id: string }>(diLead, "select analytics.record_disposition($1, 'FALSE_ALARM', 'documented shift-change entry', null, null, null) as id", [flags['config']]);
    await asPerson(diLead, "select analytics.record_disposition($1, 'TRUE_SIGNAL', 'the change was not on the shift plan', null, $2, 'new evidence from the shift plan')", [flags['config'], d1!.id]);
    expect((await list()).find((f) => f.flag_id === flags['config'])!.verdict).toBe('TRUE_SIGNAL');
  });

  it('[DI-53] the entries behind a flag are its own audit events only, of a restricted flag of a finished run, and need ANALYTICS.DI_REVIEW', async () => {
    const entries = async (ctx: ActorContext, f: string) =>
      (await asPerson<{ event_id: string; command_type: string | null; field: string | null }>(ctx, 'select event_id, command_type, field from analytics.audit_flag_entries($1)', [f]));
    expect(await entries(diLead, flags['first']!)).toEqual([{ event_id: ids['first'], command_type: 'RECORD_DATA', field: 'hardness' }]);
    expect((await entries(diLead, flags['config']!)).map((e) => e.event_id)).toEqual([ids['config']]);
    expect(await entries(diLead, flags['batch']!)).toEqual([]);
    expect(await entries(diLead, flags['failed']!)).toEqual([]);
    await expect(entries(qa, flags['first']!)).rejects.toThrow(/EBMR-ANA-007/);
    await expect(asPerson(qa, "select * from analytics.audit_flags('-infinity', 'infinity')")).rejects.toThrow(/EBMR-ANA-007/);
  });
});
