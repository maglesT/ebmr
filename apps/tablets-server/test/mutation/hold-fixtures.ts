/**
 * Fixtures for the hold-selection kill tests: batches, plant units, output containers with their open and close times,
 * merges and in-process checks, written by the superuser in a transaction with session_replication_role = replica (the
 * caller sets it, begins and rolls back). Times are given as intervals before now ('30 minutes') or as an instant.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export interface HoldFixtures {
  batch(): Promise<string>;
  unit(code: string): Promise<void>;
  /** A container opened `opened` ago and closed `closed` ago, at the instant `closed` when it is one, or still open. */
  container(batch: string, unit: string, opened: string, closed: string | { at: string } | null): Promise<string>;
  merge(source: string, target: string): Promise<void>;
  check(batch: string, unit: string, stream: string | null, result: string, when: string | { at: string }): Promise<void>;
  /** The instant `ago` before now, as text. */
  ago(ago: string): Promise<string>;
}

export function holdFixtures(c: PoolClient, siteCode: string): HoldFixtures {
  let n = 0;
  const tag = randomUUID().slice(0, 8);
  return {
    async batch() {
      const id = randomUUID();
      const hash = createHash('sha256').update(id).digest('hex');
      await c.query(
        `insert into recipe.test_package (package_hash, file_name, package, content, content_hash, family_id, family_code, product, version_id, version_number,
                                          revision, version_state, exporter, exported_at_us, source, imported_by_person, imported_by_account, correlation_id)
         values ($1, $1 || '.json', '{}', '{}', $1, gen_random_uuid(), 'FAM', '{"code": "P1", "strength": "1 mg"}', gen_random_uuid(), '1', 1, 'APPROVED', '{}', 0, '{}',
                 gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
        [hash],
      );
      await c.query(
        `insert into recipe.batch_execution (id, batch_number, package_hash, content_hash, installation, purpose, engine_version, registry_fingerprint, policy,
                                             policy_hash, issue_request, market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person,
                                             issued_by_account, correlation_id)
         values ($1, $2, $3, $3, 'SANDBOX', 'SANDBOX_TEST_RUN', '1', $3, '{}', $3, '{}', '{IN}', 'BS', $4, 'Asia/Kolkata', 0, gen_random_uuid(),
                 gen_random_uuid(), gen_random_uuid())`,
        [id, `TEST-HOLD-${id.slice(0, 8)}`, hash, siteCode],
      );
      return id;
    },
    async unit(code) {
      await c.query("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ($1, 'Unit', 'X', 'PROCESS', gen_random_uuid())", [code]);
    },
    async container(batch, unit, opened, closed) {
      const id = randomUUID();
      await c.query(
        `insert into plant.output_container (id, label_code, batch_id, batch_number, product_code, strength, stage, press_code, quantity_unit, opened_at, opened_by_person, opened_by_account)
         values ($1, $2, $3, 'B', 'P1', '1 mg', 'PACKING', $4, 'units', clock_timestamp() - $5::interval, gen_random_uuid(), gen_random_uuid())`,
        [id, `OC-H${tag}-${String(++n).padStart(4, '0')}`, batch, unit, opened],
      );
      if (closed !== null) {
        await c.query(
          "insert into plant.container_close (container_id, net_quantity, person_id, account_id, basis, weighing, closed_at) values ($1, 1, gen_random_uuid(), gen_random_uuid(), 'WEIGHED', '{}', coalesce($2::timestamptz, clock_timestamp() - $3::interval))",
          [id, typeof closed === 'string' ? null : closed.at, typeof closed === 'string' ? closed : null],
        );
      }
      return id;
    },
    async merge(source, target) {
      await c.query('insert into plant.container_merge (source_id, target_id, person_id, account_id) values ($1, $2, gen_random_uuid(), gen_random_uuid())', [source, target]);
    },
    async check(batch, unit, stream, result, when) {
      await c.query(
        "insert into plant.ipc_check (batch_id, press_code, stream, result, reference, person_id, account_id, recorded_at) values ($1, $2, $3, $4, 'fixture', gen_random_uuid(), gen_random_uuid(), coalesce($5::timestamptz, clock_timestamp() - $6::interval))",
        [batch, unit, stream, result, typeof when === 'string' ? null : when.at, typeof when === 'string' ? when : null],
      );
    },
    async ago(ago) {
      return (await c.query<{ t: string }>('select (clock_timestamp() - $1::interval)::text as t', [ago])).rows[0]?.t as string;
    },
  };
}
