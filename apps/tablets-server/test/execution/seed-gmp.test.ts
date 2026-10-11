/**
 * The DEMO-ONLY GMP seed (Phase 3 slice 6c): the set-up CLI's GMP installation carries the shop-floor personas and the
 * site gateway's identity (backlog 3b), the ERP catalogue, and the GB-T-01 lots received, tested in LIMS-lite with a
 * second-person approval and released, each act under its own signature in the database.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ADMIN_URL, dropDatabase, type SiteSeed } from '@ebmr/test-kit';
import { setupInstallation } from '../../src/cli/setup.ts';
import { GBT01_LOTS } from '../../src/features/execution/seed-gb-t-01.ts';

const database = `ebmr_seed6c_e2e_${randomBytes(4).toString('hex')}`;
const dir = mkdtempSync(join(tmpdir(), 'ebmr-seed-gmp-'));
let seed: SiteSeed;
let pool: pg.Pool;

beforeAll(async () => {
  seed = await setupInstallation({ installation: 'GMP', database, keysDir: join(dir, 'keys'), exchangeDir: join(dir, 'exchange'), personaSets: 1, recreate: true, log: () => undefined });
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
}, 900_000);

afterAll(async () => {
  await pool?.end();
  await dropDatabase(database);
  rmSync(dir, { recursive: true, force: true });
});

describe('the GMP demo seed (slice 6c)', () => {
  it('[DI-17] seeds the GMP shop floor (operators, verifier, supervisor, QA, head of production, warehouse) and the site gateway in its own role only', () => {
    expect(seed.personas.map((p) => p.key)).toEqual(expect.arrayContaining(['operator2', 'verifier1', 'supervisor1', 'qa1', 'head1', 'warehouse1']));
    expect(seed.services.map((s) => `${s.key}:${s.roleCode}:${s.terminal}`)).toEqual(['erpInterface:ERP_INTERFACE:SRV-ERP-01', 'gateway:SITE_GATEWAY:GW-01']);
  });

  it('[PR-19][IN-24] the GB-T-01 lots are released on the identity-tested route after a QC-approved, passing result; the active\'s assay comes from its LIMS results; the ERP orders are open', async () => {
    const { rows } = await pool.query<{ lot_code: string; state: string; route: string | null }>(
      `select l.lot_code, s.state, site.lot_release_route(l.id) as route
         from site.material_lot l join platform.aggregate_state s on s.aggregate_type = 'material_lot' and s.aggregate_id = l.id
        where l.lot_code like 'GBT-%' order by l.lot_code`,
    );
    expect(rows.map((r) => r.lot_code)).toEqual(GBT01_LOTS.map((l) => l.lotCode).sort());
    expect(new Set(rows.map((r) => `${r.state}:${r.route ?? ''}`))).toEqual(new Set(['RELEASED:IDENTITY_TESTED']));
    const approvals = await pool.query<{ n: string }>(
      "select count(*)::text as n from site.lot_test_approval a join site.lot_test_result r on r.id = a.result_id join site.material_lot l on l.id = r.lot_id where l.lot_code like 'GBT-%'",
    );
    expect(approvals.rows[0]?.n).toBe(String(GBT01_LOTS.reduce((n, l) => n + l.results.length, 0)));
    const assay = await pool.query<{ basis: string; assay: string; water: string }>(
      "select r.basis, r.assay::text as assay, r.water::text as water from tab.lot_assay_result r join site.material_lot l on l.id = r.material_lot_id where l.lot_code = 'GBT-API-001'",
    );
    expect(assay.rows).toEqual([{ basis: 'ANHYDROUS_WATER', assay: '99.2', water: '0.8' }]);
    const orders = await pool.query<{ o: string }>("select order_no as o from site.erp_production_order where product_code = 'GBT01-250' order by order_no");
    expect(orders.rows.map((r) => r.o)).toEqual(['PO-GBT01-0001', 'PO-GBT01-0002']);
  });
});
