/**
 * TB-01 potency-adjusted dispensing, the database's own arithmetic (SQL mutation group "tablets-dispensing", tablets
 * 0842): the rounding to the balance's readability, the as-is assay a result gives, and the potency calculation's
 * refusals and boundaries (lots 1 to 3 and the MBR's maximum, the one-lot and shared allocations, the compensating
 * excipient at the edges of its approved range and at zero). These functions are immutable and are called directly on
 * the GMP template, with the block's configuration and the MBR content as data.
 *
 * Controls: PR-19, PR-04, DI-33; invariant INV-25.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startServer('GMP');
}, 180_000);
afterAll(async () => {
  await gmp?.close();
});

type Json = Record<string, unknown>;
const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await gmp.db.admin.query<{ r: T }>(sql, params)).rows[0]?.r as T;
async function refusal(sql: string, params: unknown[]): Promise<string> {
  try {
    await gmp.db.admin.query(sql, params);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return '(not refused)';
}

describe('tab.tb01_round', () => {
  const round = (n: string, d: string, step: string, mode: string) => one<string>('select tab.tb01_round($1::numeric, $2::numeric, $3::numeric, $4)::text as r', [n, d, step, mode]);

  it('[INV-25][PR-19] UP rounds a remainder up and an exact multiple not at all; HALF_UP rounds half away from zero', async () => {
    expect(await round('7', '1', '1', 'UP')).toBe('7');
    expect(await round('7.2', '1', '1', 'UP')).toBe('8');
    expect(await round('7', '4', '0.5', 'UP')).toBe('2.0');
    expect(await round('7.4', '1', '1', 'HALF_UP')).toBe('7');
    expect(await round('7.5', '1', '1', 'HALF_UP')).toBe('8');
    expect(await round('-7.5', '1', '1', 'HALF_UP')).toBe('-8');
    expect(await round('-7.2', '1', '1', 'UP')).toBe('-8');
  });

  it('[INV-25] a denominator or step that is not positive is refused with its own message', async () => {
    for (const [d, step] of [['0', '1'], ['-1', '1'], ['1', '0'], ['1', '-0.1']]) {
      expect(await refusal("select tab.tb01_round(1, $1::numeric, $2::numeric, 'UP')", [d, step])).toBe('tab.tb01_round: a positive denominator and step');
    }
  });
});

describe('tab.tb01_as_is', () => {
  const asIs = (a: Json) => one<{ p_value: string | null; p_problem: string | null }>('select row_to_json(x) as r from tab.tb01_as_is($1::jsonb) x', [JSON.stringify(a)]);

  it('[PR-19] each basis needs its own results, and with them gives the as-is assay', async () => {
    expect((await asIs({ basis: 'ANHYDROUS_WATER', assay: '99' })).p_problem).toBe('the water result its basis needs is missing');
    expect(Number((await asIs({ basis: 'ANHYDROUS_WATER', assay: '100', water: '2' })).p_value)).toBe(98);
    expect((await asIs({ basis: 'DRIED_LOD', assay: '99' })).p_problem).toBe('the loss on drying result its basis needs is missing');
    expect(Number((await asIs({ basis: 'DRIED_LOD', assay: '100', lod: '1' })).p_value)).toBe(99);
    expect((await asIs({ basis: 'ANHYDROUS_SOLVENT_FREE', assay: '99', water: '1' })).p_problem).toBe('the solvents result its basis needs is missing');
    expect(Number((await asIs({ basis: 'ANHYDROUS_SOLVENT_FREE', assay: '100', water: '1', solvents: '1' })).p_value)).toBe(98);
  });

  it('[PR-19] a usable as-is assay is above 0 and at most 200 %', async () => {
    expect(Number((await asIs({ basis: 'AS_IS', assay: '200' })).p_value)).toBe(200);
    expect(Number((await asIs({ basis: 'AS_IS', assay: '0.001' })).p_value)).toBe(0.001);
    for (const a of ['200.001', '0', '-1']) expect((await asIs({ basis: 'AS_IS', assay: a })).p_problem).toMatch(/is not a usable assay/);
    expect((await asIs({ basis: 'AS_IS' })).p_problem).toMatch(/is not a usable assay/);
  });
});

describe('tab.tb01_calculation', () => {
  const CONTENT = { bom: [{ id: 'api', quantity: { value: '100', unit: 'g' } }, { id: 'mcc', quantity: { value: '25', unit: 'g' } }] };
  const ACTIVE = { standardIs: 'FORM', basis: 'AS_IS', bomLine: 'api' };
  const cfg = (over: Json = {}, active: Json = {}, comp: Json = { mode: 'NONE' }) => ({ readability: '0.001', active: { ...ACTIVE, ...active }, compensation: comp, ...over });
  const lot = (id: string, assay = '100', extra: Json = {}) => ({ lot: { id }, assay: { basis: 'AS_IS', assay }, ...extra });
  const calc = (c: Json, lots: unknown, content: Json = CONTENT) =>
    one<{ problem?: string; data?: { results: { target: string }[]; excipient?: { target: string } } }>('select tab.tb01_calculation($1::jsonb, $2::jsonb, $3::jsonb) as r', [
      JSON.stringify(c), JSON.stringify(content), JSON.stringify(lots),
    ]);

  it('[PR-19] the configuration states its standard and assay basis, and a complete compensation or none', async () => {
    expect((await calc(cfg({}, { basis: null }), [lot('L1')])).problem).toMatch(/states no standard basis/);
    expect((await calc(cfg({}, { standardIs: 'SALT' }), [lot('L1')])).problem).toMatch(/states no standard basis/);
    expect((await calc(cfg({}, {}, {}), [lot('L1')])).problem).toMatch(/TB01-EXCIPIENT-RANGE/);
    expect((await calc(cfg({}, {}, { mode: 'EXCIPIENT', min: '0', bomLine: 'mcc' }), [lot('L1')])).problem).toMatch(/TB01-EXCIPIENT-RANGE/);
    expect((await calc(cfg({}, {}, { mode: 'EXCIPIENT', min: '0', max: '100' }), [lot('L1')])).problem).toMatch(/TB01-EXCIPIENT-RANGE/);
    expect((await calc(cfg({ readability: '0' }), [lot('L1')])).problem).toMatch(/TB01-READABILITY/);
    expect((await calc(cfg({ readability: null }), [lot('L1')])).problem).toMatch(/TB01-READABILITY/);
  });

  it('[PR-19][INV-25] the salt-to-base factor applies to a base standard with its form only', async () => {
    const form = { molarMassForm: '2', baseMoieties: '1', molarMassBase: '1' };
    expect((await calc(cfg({}, { standardIs: 'BASE', form }), [lot('L1')])).data?.results[0]?.target).toBe('200.000');
    // A FORM standard ignores a form given with it.
    expect((await calc(cfg({}, { form }), [lot('L1')])).data?.results[0]?.target).toBe('100.000');
  });

  it('[PR-19][PR-04] 1 to 3 lots and at most the MBR\'s maximum; a numeric maximum only', async () => {
    expect((await calc(cfg(), [])).problem).toMatch(/across 0 lots/);
    const four = ['A', 'B', 'C', 'D'].map((x) => lot(x, '100', { baseEquivalent: '25' }));
    expect((await calc(cfg(), four)).problem).toMatch(/across 4 lots, where the MBR allows 1 to 3/);
    const three = ['A', 'B', 'C'].map((x, i) => lot(x, '100', { baseEquivalent: ['50', '25', '25'][i] }));
    expect((await calc(cfg(), three)).data).toBeDefined();
    expect((await calc(cfg({}, { maxLots: 3 }), three)).data).toBeDefined();
    expect((await calc(cfg({}, { maxLots: 2 }), three)).problem).toMatch(/across 3 lots, where the MBR allows 1 to 2/);
    expect((await calc(cfg({}, { maxLots: '2' }), three)).data).toBeDefined();
  });

  it('[PR-19][INV-25] one lot carries the whole need; shared lots each a positive share, adding up to the need', async () => {
    expect((await calc(cfg(), [lot('L1', '100', { baseEquivalent: '100' })])).data).toBeDefined();
    expect((await calc(cfg(), [lot('L1', '100', { baseEquivalent: '99' })])).problem).toMatch(/TB01-ALLOCATION/);
    expect((await calc(cfg(), [lot('A'), lot('B', '100', { baseEquivalent: '100' })])).problem).toMatch(/gives lot 1 no positive base-equivalent share/);
    expect((await calc(cfg(), [lot('A', '100', { baseEquivalent: '0' }), lot('B', '100', { baseEquivalent: '100' })])).problem).toMatch(/gives lot 1 no positive/);
    expect((await calc(cfg(), [lot('A', '100', { baseEquivalent: '60' }), lot('B', '100', { baseEquivalent: '30' })])).problem).toMatch(/add up to 90, not to the 100/);
    expect((await calc(cfg(), [lot('A', '100', { baseEquivalent: '60' }), lot('B', '100', { baseEquivalent: '40' })])).data).toBeDefined();
  });

  it('[PR-19][INV-25] the compensating excipient: at zero and at the edges of its range accepted, below zero or outside refused', async () => {
    const comp = (min: string, max: string) => ({ mode: 'EXCIPIENT', min, max, bomLine: 'mcc' });
    // Assay 80 %: 125 g of the active for 100 g; the excipient drops by 25 g, from 25 g to exactly 0.
    expect((await calc(cfg({}, {}, comp('0', '100')), [lot('L1', '80')])).data?.excipient?.target).toBe('0.000');
    expect((await calc(cfg({}, {}, comp('-10', '100')), [lot('L1', '50')])).problem).toMatch(/below zero \(TB01-EXCIPIENT-NEGATIVE\)/);
    // Assay 100 %: the excipient stays at its standard 25 g, the edges of a range 25 to 25 included.
    expect((await calc(cfg({}, {}, comp('25', '25')), [lot('L1', '100')])).data?.excipient?.target).toBe('25.000');
    expect((await calc(cfg({}, {}, comp('25.001', '30')), [lot('L1', '100')])).problem).toMatch(/outside its approved range/);
    expect((await calc(cfg({}, {}, comp('20', '24.999')), [lot('L1', '100')])).problem).toMatch(/outside its approved range/);
  });
});

describe('the lot TB-01 proposes and the facts it reads (tablets 1000)', () => {
  /**
   * Lots of material MAT-F at SITE-1 (and one at SITE-2) and a planned batch for India at SITE-1, written by the
   * superuser with session_replication_role = replica in a transaction that is always rolled back: what is under test
   * is how the readers choose among them.
   */
  async function withLots<T>(work: (c: PoolClient, ids: Record<string, string>) => Promise<T>): Promise<T> {
    const c = await gmp.db.admin.connect();
    const ids: Record<string, string> = {};
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      ids['B'] =
        (
          await c.query<{ id: string }>(
            `insert into recipe.stub_batch (batch_number, family_id, markets, site, line, batch_size, created_by_person, created_by_account)
             values ('B-FEFO-1', gen_random_uuid(), '{IN}', 'SITE-1', 'L1', 'BS', gen_random_uuid(), gen_random_uuid()) returning id`,
          )
        ).rows[0]?.id ?? '';
      ids['B2'] =
        (
          await c.query<{ id: string }>(
            `insert into recipe.stub_batch (batch_number, family_id, markets, site, line, batch_size, created_by_person, created_by_account)
             values ('B-FEFO-2', gen_random_uuid(), '{IN}', 'SITE-1', 'L1', 'BS', gen_random_uuid(), gen_random_uuid()) returning id`,
          )
        ).rows[0]?.id ?? '';
      const lot = async (code: string, opts: { site?: string; expires: string; retest?: string; state?: string; identity?: string[]; material?: string }) => {
        const id =
          (
            await c.query<{ id: string }>(
              `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, retest_at, expires_at,
                                              received_by_person, received_by_account, correlation_id)
               values (gen_random_uuid(), $1, $2, $3, 'Paracetamol', 'API', 10, 'kg', $4, $5, gen_random_uuid(), gen_random_uuid(), gen_random_uuid()) returning id`,
              [opts.site ?? 'SITE-1', code, opts.material ?? 'MAT-F', opts.retest ?? null, opts.expires],
            )
          ).rows[0]?.id ?? '';
        await c.query(
          "insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version) values ('material_lot', $1, 'material_lot', 1, $2, 2)",
          [id, opts.state ?? 'RELEASED'],
        );
        for (const r of opts.identity ?? ['PASS']) {
          await c.query(
            "insert into site.lot_identity_result (lot_id, result, method_reference, test_reference, recorded_by_person, recorded_by_account) values ($1, $2, 'STP-ID', 'AR-1', gen_random_uuid(), gen_random_uuid())",
            [id, r],
          );
        }
        ids[code] = id;
        return id;
      };
      const reserve = (lotId: string, batch: string) =>
        c.query(
          `insert into site.lot_reservation (lot_id, batch_id, batch_number, edition, quantity, unit, expires_at, lot_state_version, reserved_by_person, reserved_by_account)
           values ($1, $2, 'B-X', 'TABLETS', 10, 'kg', clock_timestamp() + interval '1 day', 2, gen_random_uuid(), gen_random_uuid())`,
          [lotId, batch],
        );
      await lot('L-EXCL', { expires: '2027-01-01T00:00:00Z' });
      await lot('L-ELSEWHERE', { site: 'SITE-2', expires: '2027-02-01T00:00:00Z' });
      await lot('L-EXPIRED', { expires: '2026-01-01T00:00:00Z' });
      await lot('L-RETEST', { expires: '2027-03-01T00:00:00Z', retest: '2026-01-01T00:00:00Z' });
      await lot('L-QUAR', { expires: '2027-04-01T00:00:00Z', state: 'QUARANTINE' });
      await lot('L-FAILED', { expires: '2027-05-01T00:00:00Z', identity: ['PASS', 'FAIL'] });
      await lot('L-UNTESTED', { expires: '2027-05-15T00:00:00Z', identity: [] });
      await reserve(await lot('L-TAKEN', { expires: '2027-06-01T00:00:00Z' }), randomUUID());
      await reserve(await lot('L-OWN', { expires: '2027-07-01T00:00:00Z', retest: '2027-06-15T00:00:00Z' }), ids['B'] ?? '');
      await lot('L-OK', { expires: '2028-01-01T00:00:00Z' });
      await lot('L-OTHERMAT', { expires: '2026-12-01T00:00:00Z', material: 'MAT-G' });
      return await work(c, ids);
    } finally {
      await c.query('rollback');
      c.release();
    }
  }
  const first = async (c: PoolClient, batch: string, exclude: string[], now: string): Promise<string | null | undefined> =>
    (await c.query<{ r: string | null }>("select tab.tb01_first_expiring($1, 'MAT-F', $2, $3::timestamptz) as r", [batch, exclude, now])).rows[0]?.r;

  it('[PR-18][IN-24][INV-13] FEFO: the first-expiring lot of the material at the batch\'s site, released, within its dates, identity-tested, and available or reserved for this batch', async () => {
    await withLots(async (c, ids) => {
      const b = ids['B'] ?? '';
      const now = '2026-06-01T00:00:00Z';
      expect(await first(c, b, [], now)).toBe('L-EXCL');
      expect(await first(c, b, ['L-EXCL'], now)).toBe('L-OWN');
      // At the very instant of its retest the lot is no longer proposed; nor at the instant of its expiry.
      expect(await first(c, b, ['L-EXCL'], '2027-06-15T00:00:00Z')).toBe('L-OK');
      expect(await first(c, b, ['L-EXCL', 'L-OWN'], '2027-01-01T00:00:00Z')).toBe('L-OK');
      expect(await first(c, b, [], '2027-01-01T00:00:00Z')).toBe('L-OWN');
      expect(await first(c, b, [], '2026-12-31T23:59:59.999999Z')).toBe('L-EXCL');
      // The batch's open reservation of a lot with at least the quantity left (10 kg reserved), in the lot's unit.
      const reservation = async (value: string, unit: string): Promise<{ quantity: string; unit: string } | null> =>
        (await c.query<{ r: { quantity: string; unit: string } | null }>('select tab.tb01_reservation_for($1, $2, $3::numeric, $4) as r', [b, 'L-OWN', value, unit])).rows[0]?.r ?? null;
      expect(await reservation('10', 'kg')).toMatchObject({ quantity: '10', unit: 'kg' });
      expect(await reservation('10000', 'g')).toMatchObject({ unit: 'kg' });
      expect(await reservation('10.001', 'kg')).toBeNull();
      expect(await reservation('0', 'kg')).toBeNull();
      expect(await reservation('-1', 'kg')).toBeNull();
      // Another batch has no reservation on L-OWN: it is not available to it.
      expect(await first(c, ids['B2'] ?? '', ['L-EXCL'], now)).toBe('L-OK');
    });
  });

  it('[IN-24][PR-18] the facts of a lot: found by its code (at the batch\'s site when a batch is named), identity-tested only with a passing and no failing result', async () => {
    await withLots(async (c, ids) => {
      const facts = async (code: string, batch: string | null) =>
        (await c.query<{ r: Json | null }>('select tab.lot_facts($1, $2) as r', [code, batch])).rows[0]?.r;
      expect(await facts('L-OK', null)).toMatchObject({ lotCode: 'L-OK', status: 'RELEASED', identityTested: true });
      expect(await facts('L-FAILED', null)).toMatchObject({ identityTested: false });
      expect(await facts('L-UNTESTED', null)).toMatchObject({ identityTested: false });
      expect(await facts('L-QUAR', null)).toMatchObject({ status: 'QUARANTINE' });
      expect(await facts('NO-SUCH-LOT', null)).toBeNull();
      // The same code at two sites: without a batch the code names no one lot; with the batch, its site's lot.
      await c.query(
        `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at, received_by_person, received_by_account, correlation_id)
         values (gen_random_uuid(), 'SITE-2', 'L-OK', 'MAT-F', 'Paracetamol', 'API', 1, 'kg', '2030-01-01', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
      );
      expect(await facts('L-OK', null)).toBeNull();
      expect(await facts('L-OK', ids['B'] ?? '')).toMatchObject({ lotCode: 'L-OK', identityTested: true, expiresAtUs: String(Date.UTC(2028, 0, 1) * 1000) });
      expect(await facts('L-FAILED', ids['B'] ?? '')).toMatchObject({ identityTested: false });
    });
  });
});

describe('FEFO in the sandbox: the registered test lots (tablets 1000)', () => {
  let sbx: TestServer;
  beforeAll(async () => {
    sbx = await startServer('SANDBOX');
  }, 180_000);
  afterAll(async () => {
    await sbx?.close();
  });

  it('[PR-18][IN-24] a released test lot within its dates (its expiry and retest instants excluded), identity-tested unless every market of the batch is India or the markets are unknown', async () => {
    const c = await sbx.db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      const batch = async (markets: string[]): Promise<string> =>
        (
          await c.query<{ id: string }>(
            `insert into recipe.stub_batch (batch_number, family_id, markets, site, line, batch_size, created_by_person, created_by_account)
             values ($1, gen_random_uuid(), $2, 'SITE-1', 'L1', 'BS', gen_random_uuid(), gen_random_uuid()) returning id`,
            [`TEST-FEFO-${randomUUID().slice(0, 6)}`, markets],
          )
        ).rows[0]?.id ?? '';
      const lot = (code: string, status: string, expires: string | null, retest: string | null, tested: boolean) =>
        c.query(
          `insert into tab.sandbox_lot (lot_code, material_code, material_name, status, expires_at, retest_at, identity_tested, registered_by_person, registered_by_account, correlation_id)
           values ($1, 'MAT-S', 'Paracetamol', $2, $3, $4, $5, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
          [code, status, expires, retest, tested],
        );
      await lot('TEST-S-QUAR', 'QUARANTINE', '2026-07-01T00:00:00Z', null, true);
      await lot('TEST-S-UNTESTED', 'RELEASED', '2026-08-01T00:00:00Z', null, false);
      await lot('TEST-S-RETEST', 'RELEASED', '2026-09-01T00:00:00Z', '2026-06-15T00:00:00Z', true);
      await lot('TEST-S-OK', 'RELEASED', '2027-01-01T00:00:00Z', null, true);
      const first = async (b: string, now: string, exclude: string[] = []): Promise<string | null | undefined> =>
        (await c.query<{ r: string | null }>("select tab.tb01_first_expiring($1, 'MAT-S', $2, $3::timestamptz) as r", [b, exclude, now])).rows[0]?.r;
      const india = await batch(['IN']);
      const exportBatch = await batch(['IN', 'US']);
      const now = '2026-06-01T00:00:00Z';
      // Not the quarantined lot; the untested lot only for India alone or unknown markets.
      expect(await first(india, now)).toBe('TEST-S-UNTESTED');
      expect(await first(randomUUID(), now)).toBe('TEST-S-UNTESTED');
      expect(await first(exportBatch, now)).toBe('TEST-S-RETEST');
      // The retest instant and the expiry instant themselves are outside the lot's dates.
      expect(await first(exportBatch, '2026-06-15T00:00:00Z')).toBe('TEST-S-OK');
      expect(await first(exportBatch, '2026-06-14T23:59:59.999999Z')).toBe('TEST-S-RETEST');
      expect(await first(india, '2026-08-01T00:00:00Z', ['TEST-S-RETEST'])).toBe('TEST-S-OK');
      expect(await first(india, '2026-07-31T23:59:59.999999Z', ['TEST-S-RETEST'])).toBe('TEST-S-UNTESTED');
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});
