/**
 * A lot's assay result for TB-01's potency calculation (SQL mutation group "lots-and-lims", tablets 1001,
 * tab.record_lot_assay): a result is an object naming its basis; it is recorded only for a registered test lot (sandbox) or
 * a material lot of the site (GMP); each value is a decimal written as text; the basis takes exactly the values it needs
 * and always the assay; a lot's first result carries no reason and a later one supersedes the lot's own current result
 * with a reason. The function runs in the master-data steward's command, as the owner, in a transaction that is always
 * rolled back; the test lots are written with session_replication_role = replica.
 *
 * Controls: PR-19, DI-33, DI-22; invariant INV-25.
 */
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { toDbContext } from '@ebmr/kernel';
import { openPersonaSession } from '@ebmr/test-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../support/harness.ts';

let sbx: TestServer;
let gmp: TestServer;
beforeAll(async () => {
  [sbx, gmp] = await Promise.all([startServer('SANDBOX'), startServer('GMP')]);
}, 180_000);
afterAll(async () => {
  await Promise.all([sbx?.close(), gmp?.close()]);
});

/** `work` in the steward's command on `server`, as the owner; rolled back. */
async function asSteward<T>(server: TestServer, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const actor = { ...(await openPersonaSession(server.db, server.seed, 'steward')), reasonCode: 'TEST', reasonText: 'assay result kill test' };
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(actor))]);
    return await work(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** One call under a savepoint: '' when recorded, else the refusal's message. */
async function record(c: PoolClient, lot: string, result: unknown, reason: string | null = null, site = 'SITE-1'): Promise<string> {
  await c.query('savepoint a');
  try {
    await c.query('select tab.record_lot_assay($1, $2, $3::jsonb, $4)', [lot, site, JSON.stringify(result), reason]);
    await c.query('release savepoint a');
    return '';
  } catch (e) {
    await c.query('rollback to savepoint a');
    return e instanceof Error ? e.message : String(e);
  }
}

describe('a lot assay result (tablets 1001)', () => {
  it('[PR-19][DI-33][INV-25] sandbox: a registered test lot; an object with a basis; decimals as text; exactly the values of the basis; first without a reason, then superseded with one, per lot', async () => {
    await asSteward(sbx, async (c) => {
      const tag = randomUUID().slice(0, 6).toUpperCase();
      const A = `TEST-A-${tag}`;
      const B = `TEST-B-${tag}`;
      await c.query("set local session_replication_role = 'replica'");
      for (const lot of [A, B]) {
        await c.query(
          "insert into tab.sandbox_lot (lot_code, material_code, material_name, status, identity_tested, registered_by_person, registered_by_account, correlation_id) values ($1, 'API-1', 'Paracetamol', 'RELEASED', true, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
          [lot],
        );
      }
      await c.query("set local session_replication_role = 'origin'");
      const ok = { basis: 'AS_IS', assay: '99.2', certificateRef: 'COA-1' };
      expect(await record(c, A, [ok])).toMatch(/states its basis, its values and its certificate reference .*\[EBMR-EXE-242\]/);
      expect(await record(c, `TEST-X-${tag}`, ok)).toMatch(/is not a registered test lot .*\[EBMR-EXE-242\]/);
      const basis = /states the basis it is reported on: .*\[EBMR-EXE-242\]/;
      expect(await record(c, A, { ...ok, basis: undefined })).toMatch(basis);
      expect(await record(c, A, { ...ok, basis: 'WET' })).toMatch(basis);
      const decimal = /The assay of an assay result is a decimal written as text.*\[EBMR-EXE-242\]/;
      expect(await record(c, A, { ...ok, assay: 99 })).toMatch(decimal);
      expect(await record(c, A, { ...ok, assay: '99.2%' })).toMatch(decimal);
      const exactly = /states exactly the values that basis needs .*\[EBMR-EXE-242\]/;
      expect(await record(c, A, { ...ok, water: '0.5' })).toMatch(exactly);
      expect(await record(c, A, { ...ok, basis: 'ANHYDROUS_WATER' })).toMatch(exactly);
      expect(await record(c, A, { ...ok, basis: 'DRIED_LOD' })).toMatch(exactly);
      expect(await record(c, A, { ...ok, lod: '0.5' })).toMatch(exactly);
      expect(await record(c, A, { ...ok, basis: 'ANHYDROUS_SOLVENT_FREE', water: '0.5' })).toMatch(exactly);
      expect(await record(c, A, { ...ok, solvents: '0.1' })).toMatch(exactly);
      expect(await record(c, A, { basis: 'AS_IS', certificateRef: 'COA-1' })).toMatch(exactly);
      // The supersede chain: first without a reason, then each later one with one; another lot starts its own.
      expect(await record(c, A, ok, 'why')).toMatch(/The lot has no result yet: a first result is recorded without a superseding reason .*\[EBMR-EXE-242\]/);
      expect(await record(c, A, ok)).toBe('');
      const current = /The lot has a current result: a new one supersedes it with your own reason.*\[EBMR-EXE-242\]/;
      expect(await record(c, A, { ...ok, assay: '99.4' })).toMatch(current);
      expect(await record(c, A, { ...ok, assay: '99.4' }, 'certificate corrected')).toBe('');
      expect(await record(c, A, { ...ok, assay: '99.5' })).toMatch(current);
      expect(await record(c, B, { ...ok, basis: 'ANHYDROUS_SOLVENT_FREE', water: '0.5', solvents: '0.1' })).toBe('');
      expect(await record(c, B, { ...ok, basis: 'DRIED_LOD', lod: '0.3' }, 'retested')).toBe('');
      const { rows } = await c.query<{ lot: string; assay: string; superseded: boolean }>(
        `select r.sandbox_lot_code as lot, r.assay::text as assay, exists (select 1 from tab.lot_assay_result n where n.supersedes = r.id) as superseded
           from tab.lot_assay_result r where r.sandbox_lot_code = any ($1) order by r.sandbox_lot_code, r.recorded_at, r.id`,
        [[A, B]],
      );
      expect(rows.filter((r) => !r.superseded).map((r) => [r.lot, r.assay])).toEqual([[A, '99.4'], [B, '99.2']]);
    });
  });

  it('[PR-19][DI-33] GMP: only a material lot of the site', async () => {
    await asSteward(gmp, async (c) => {
      expect(await record(c, `LOT-${randomUUID().slice(0, 6)}`, { basis: 'AS_IS', assayResultId: randomUUID() })).toMatch(/is not a material lot of site SITE-1 .*\[EBMR-EXE-242\]/);
    });
  });
});
