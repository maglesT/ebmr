/**
 * Which press output a failed detector challenge or tooling inspection holds (SQL mutation group "tablets-compression",
 * tablets 0871, tab.hold_press_output): every container of this batch and this press whose open interval reaches into
 * (since, the failed check], and every container one of them was merged into; never a container closed at or before
 * `since`, of another press or of another batch. The selection exists only in the database.
 *
 * The batch, its containers (with their open and close times), a merge and a passing check after `since` are written by
 * the superuser with session_replication_role = replica in a transaction that is always rolled back; the function runs
 * in operator1's command. The passing check makes plant.record_ipc_check's own interval start after `since`, so the
 * containers before it are held by this function's selection alone.
 *
 * Controls: IN-36, IN-35, PR-22; invariant INV-24.
 */
import { createHash, randomUUID } from 'node:crypto';
import { toDbContext } from '@ebmr/kernel';
import { freshTap, openPersonaSession } from '@ebmr/test-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startServer('GMP');
}, 180_000);
afterAll(async () => {
  await gmp?.close();
});

describe('a failed challenge or tooling check holds the press output since the last pass (tablets 0871)', () => {
  it('[IN-36][IN-35][INV-24] this batch and press, open into (since, check], and the containers they were merged into; nothing closed at since or before', async () => {
    const session = await openPersonaSession(gmp.db, gmp.seed, 'operator1');
    const actor = { ...session, authEventId: await freshTap(gmp.db, gmp.seed, 'operator1'), reasonCode: 'TEST', reasonText: 'hold selection kill test' };
    const c = await gmp.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(actor))]);
      await c.query("set local session_replication_role = 'replica'");
      const batch = async (): Promise<string> => {
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
          [id, `TEST-HOLD-${id.slice(0, 8)}`, hash, gmp.seed.siteCode],
        );
        return id;
      };
      const B = await batch();
      const B2 = await batch();
      const press = `PR-HOLD-${randomUUID().slice(0, 6).toUpperCase()}`;
      const other = `${press}-2`;
      for (const p of [press, other]) {
        await c.query("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ($1, 'Press', 'X', 'PROCESS', gen_random_uuid())", [p]);
      }
      const since = (await c.query<{ t: string }>("select (clock_timestamp() - interval '1 hour')::text as t")).rows[0]?.t as string;
      let n = 0;
      const tag = randomUUID().slice(0, 8);
      /** A container opened `opened` ago, closed `closed` ago (or at `since`, or still open). */
      const container = async (b: string, p: string, opened: string, closed: string | 'SINCE' | null): Promise<string> => {
        const id = randomUUID();
        await c.query(
          `insert into plant.output_container (id, label_code, batch_id, batch_number, product_code, strength, stage, press_code, quantity_unit, opened_at, opened_by_person, opened_by_account)
           values ($1, $2, $3, 'B', 'P1', '1 mg', 'COMPRESSION', $4, 'kg', clock_timestamp() - $5::interval, gen_random_uuid(), gen_random_uuid())`,
          [id, `OC-H${tag}-${String(++n).padStart(4, '0')}`, b, p, opened],
        );
        if (closed !== null) {
          await c.query(
            "insert into plant.container_close (container_id, net_quantity, person_id, account_id, closed_at) values ($1, 1, gen_random_uuid(), gen_random_uuid(), case when $2 = 'SINCE' then $3::timestamptz else clock_timestamp() - $2::interval end)",
            [id, closed, since],
          );
        }
        return id;
      };
      const before = await container(B, press, '3 hours', '2 hours');
      const atSince = await container(B, press, '3 hours', 'SINCE');
      const after = await container(B, press, '3 hours', '30 minutes');
      const open = await container(B, press, '50 minutes', null);
      const otherPress = await container(B, other, '3 hours', '30 minutes');
      const otherBatch = await container(B2, press, '3 hours', '30 minutes');
      const target = await container(B, other, '3 hours', '2 hours');
      const untouched = await container(B, other, '3 hours', '2 hours');
      await c.query('insert into plant.container_merge (source_id, target_id, person_id, account_id) values ($1, $2, gen_random_uuid(), gen_random_uuid())', [after, target]);
      await c.query("insert into plant.ipc_check (batch_id, press_code, result, reference, person_id, account_id, recorded_at) values ($1, $2, 'PASS', 'pass', gen_random_uuid(), gen_random_uuid(), clock_timestamp() - interval '10 minutes')", [B, press]);

      const r = (await c.query<{ r: { ipcCheckId: string } }>('select tab.hold_press_output($1, $2, $3::timestamptz, $4) as r', [B, press, since, 'challenge failed'])).rows[0]?.r;
      expect((await c.query<{ result: string }>('select result from plant.ipc_check where id = $1', [r?.ipcCheckId])).rows[0]?.result).toBe('FAIL');
      const held = (await c.query<{ id: string; via: string | null }>('select container_id::text as id, via_container_id::text as via from plant.container_hold where ipc_check_id = $1', [r?.ipcCheckId])).rows;
      expect(held.map((h) => h.id).sort()).toEqual([after, open, target].sort());
      expect(held.find((h) => h.id === target)?.via).toBe(after);
      for (const id of [before, atSince, otherPress, otherBatch, untouched]) expect(held.map((h) => h.id)).not.toContain(id);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});
