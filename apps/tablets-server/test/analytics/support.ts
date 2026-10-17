/**
 * Test support of slice 6A-1: a probe method implementation the runner can run (it reads two catalogued inputs and
 * writes one output and one flag per run, or fails on purpose), method versions made EFFECTIVE as a release writes them
 * (the HTTP route that a person uses is proven in routes.test.ts), and direct calls as the analytics role.
 */
import pg from 'pg';
import { defaultParameters, type FlagDraft, type MethodId, type OutputDraft, type Parameters } from '@ebmr/analytics';
import { codeIdentity, parametersSha256 } from '../../src/analytics/catalog.ts';
import { implementation, type MethodImplementation } from '../../src/analytics/implementation.ts';
import type { TestServer } from '../support/harness.ts';

const RELEASE = `jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Test fixture (analytics)',
  'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'test fixture')`;

/** Statements as the software release (what a migration does), in one transaction. */
export async function asRelease(server: Pick<TestServer, 'db'>, statements: { text: string; values?: unknown[] }[]): Promise<void> {
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query(`select kernel.set_actor_context(${RELEASE})`);
    for (const s of statements) await c.query(s.text, s.values ?? []);
    await c.query('select kernel.set_actor_context(null)');
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

/** Writes a method version as the release (parameters hashed and code identity named as the server would). */
export async function releaseMethodVersion(
  server: Pick<TestServer, 'db'>,
  method: string,
  version: number,
  over: { parameters?: Parameters; parametersSha256?: string; codeIdentity?: string; status?: 'EFFECTIVE' | 'RETIRED' } = {},
): Promise<void> {
  const parameters = over.parameters ?? defaultParameters(method as MethodId);
  await asRelease(server, [{
    text: `insert into analytics.method_version (method, version, status, title, intended_use, acceptance, parameters, parameters_sha256, code_identity, validation_ref)
           values ($1, $2, $3, 'Probe', 'advisory probe of the runner', '{"within": "1e-9"}', $4::jsonb, $5, $6, 'VAL-PROBE-1')`,
    values: [method, version, over.status ?? 'EFFECTIVE', JSON.stringify(parameters), over.parametersSha256 ?? parametersSha256(parameters), over.codeIdentity ?? codeIdentity('development')],
  }]);
}

export interface ProbeInput {
  batches: number;
  values: number;
  numbers: string[];
}

/**
 * A probe implementation of `id` version 1: reads report.batch_fact_v1 and report.cpp_value_v1, gives one GROUP output
 * with the row counts and one flag about it; with `fail` it throws inside the method.
 */
export function probe(id: 'SPC.IMR' | 'DRIFT.TREND' = 'SPC.IMR', opts: { fail?: boolean } = {}): MethodImplementation {
  return implementation<ProbeInput, Parameters>({
    id,
    versions: [1],
    inputs: [{ view: 'report.batch_fact_v1', version: 1, filter: null }, { view: 'report.cpp_value_v1', version: 1, filter: null }],
    assemble: (rows) => ({
      batches: rows['report.batch_fact_v1']?.length ?? 0,
      values: rows['report.cpp_value_v1']?.length ?? 0,
      numbers: (rows['report.batch_fact_v1'] ?? []).map((r) => String(r['batch_number'])),
    }),
    method: {
      id,
      versions: [1],
      run: (input) => {
        if (opts.fail) throw new Error('probe failure on purpose');
        const output: OutputDraft = { subjectKind: 'GROUP', subjectRef: 'ALL', kind: 'CONTROL_CHART', values: { batches: input.batches, values: input.values, mean: 7.123456789012345 }, reasons: [] };
        const flag: FlagDraft = { subjectKind: 'GROUP', subjectRef: 'ALL', rule: 'NELSON_1', severity: 'INFO', reasons: [{ code: 'PROBE', text: `probe over ${input.batches} batch(es)` }] };
        return { outputs: [output], flags: [flag], skipped: [] };
      },
    },
  });
}

/** One query as ebmr_analytics (waits while the role's connection limit is reached). */
export async function asAnalytics<T extends pg.QueryResultRow>(server: Pick<TestServer, 'database'>, text: string, values: unknown[] = []): Promise<T[]> {
  const admin = new URL(process.env['EBMR_PG_ADMIN_URL'] ?? 'postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres');
  const url = `postgres://ebmr_analytics:ebmr_analytics@${admin.hostname}:${admin.port || '5432'}/${server.database}`;
  for (let i = 0; ; i += 1) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
    } catch (e) {
      await client.end().catch(() => undefined);
      if ((e as { code?: string }).code === '53300' && i < 40) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw e;
    }
    try {
      return (await client.query<T>(text, values)).rows;
    } finally {
      await client.end();
    }
  }
}

/** A finished run of `method` v1 (already EFFECTIVE) with one flag about `kind` `ref`, written as the analytics role. */
export async function flagAs(server: Pick<TestServer, 'database'>, method: string, kind: 'BATCH' | 'PERSON' | 'GROUP', ref: string): Promise<{ run: string; flag: string }> {
  const inputs = [{ view: 'report.batch_fact_v1', version: 1, filter: null, data_as_of: '2026-10-12T04:40:00Z', rows: 0, sha256: 'a'.repeat(64) }];
  const runtime = { package: '@ebmr/analytics 0.1.0', commit: 'test', node: process.version, libraries: {} };
  const [r] = await asAnalytics<{ id: string }>(server, "select analytics.begin_run($1, 1, null, 'ON_DEMAND', $2::jsonb, $3::jsonb)::text as id", [method, JSON.stringify(inputs), JSON.stringify(runtime)]);
  const [f] = await asAnalytics<{ id: string }>(server,
    "select analytics.record_flag($1, null, $2, $3, 'NELSON_2', 'ATTENTION', '[{\"code\": \"NELSON_2\", \"text\": \"nine points in a row above the centre\"}]')::text as id",
    [r!.id, kind, ref]);
  await asAnalytics(server, "select analytics.finish_run($1, $2, '{}')", [r!.id, 'b'.repeat(64)]);
  return { run: r!.id, flag: f!.id };
}

/**
 * TEST FIXTURE: a GMP batch record row written as the database owner with triggers off (no control recipe, signature
 * or record behind it): enough for the batch views to list it. Returns its id.
 */
export async function fixtureBatch(server: Pick<TestServer, 'db'>, batchNumber: string): Promise<string> {
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const { rows } = await c.query<{ id: string }>(
      `insert into recipe.batch_execution (id, batch_number, content_hash, installation, purpose, engine_version, registry_fingerprint, policy, policy_hash, issue_request,
                                           market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person, issued_by_account, correlation_id,
                                           control_recipe_id, issue_signature_id)
       values (gen_random_uuid(), $1, repeat('a', 64), 'GMP', 'GMP_BATCH', 'test', repeat('b', 64), '{}', repeat('c', 64), '{}', array['IN'], 'BS-1', 'SITE-1', 'Asia/Kolkata',
               (extract(epoch from clock_timestamp()) * 1000000)::bigint, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())
       returning id::text`,
      [batchNumber],
    );
    await c.query('commit');
    return rows[0]!.id;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
