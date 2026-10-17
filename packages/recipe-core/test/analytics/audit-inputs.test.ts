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
import { segregationProblems } from '../../../kernel/src/sandbox/provision.ts';
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
}, 600_000);

afterAll(async () => {
  await db?.drop();
});

const AUDIT_COLUMNS = ['event_id', 'chain_key', 'recorded_at', 'recorded_local', 'claimed_at', 'person_id', 'account_id', 'role', 'terminal', 'action', 'command_type', 'table_name', 'field',
  'is_correction', 'reason_code', 'batch_id', 'step', 'attempt', 'failed', 'deviation_linked', 'config_area', 'read_at', 'data_as_of'];

describe('the audit-trail inputs (kernel 1260, recipe-core 1150)', () => {
  it('[DI-51] the audit fact view exports no old or new value', async () => {
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
