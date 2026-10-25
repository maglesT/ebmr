/**
 * Phase 7 slice 7r (D-7r-5; tablets 1701): the plant unit a packaging master configures (TB-23's bottle line, TB-24's
 * cartoner, config `unit`) is the sandbox's own TEST- unit of that code in a test run. The sandbox's DEMO-ONLY plant
 * labels every unit TEST- (DI-05) and a test run runs the GMP master itself (DI-04), so before 1701 the configured CTN-03
 * was no unit of the sandbox and the first checkweigher challenge of a cold-form master's test run was refused
 * (EBMR-CNT-023): no packaging master with TB-23 or TB-24 could complete its SANDBOX_RUN. GMP reads the configured code
 * as it is; every guard keeps its rule on the unit it now reads.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { valueOf } from '../esig/support.ts';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
let sbx: TestServer;

beforeAll(async () => {
  [gmp, sbx] = await Promise.all([startServer('GMP'), startServer('SANDBOX')]);
}, 300_000);

afterAll(async () => {
  await Promise.all([gmp?.close(), sbx?.close()]);
});

const one = async (s: TestServer, sql: string, params: unknown[]): Promise<string | null> => (await s.db.admin.query<{ r: string | null }>(sql, params)).rows[0]?.r ?? null;

async function defineUnit(s: TestServer, tag: string, code: string): Promise<void> {
  const steward = await s.asPersona('steward');
  valueOf(await steward.call(routes.plant.defineArea, { body: { code: `PL-${tag}`, kind: 'LINE', name: `Line PL-${tag}` } }));
  valueOf(await steward.call(routes.plant.defineEquipmentClass, { body: { code: `EQC-CTN-${tag}`, kind: 'PROCESS', description: 'Cartoner with checkweigher', cleanHold: '72 hours', dirtyHold: '48 hours' } }));
  valueOf(await steward.call(routes.plant.defineEquipment, { body: { code, name: 'Cartoner with checkweigher', classCode: `EQC-CTN-${tag}`, areaCode: `PL-${tag}` } }));
}

describe('the unit a packaging master configures, on each installation (slice 7r, D-7r-5)', () => {
  it('[DI-04][DI-05][PR-22][PR-37] on the sandbox, a configured unit code that is no sandbox unit reads as its TEST- unit, which the plant knows; an unknown code stays unknown and refused (EBMR-CNT-023)', async () => {
    const tag = randomBytes(3).toString('hex').toUpperCase();
    await defineUnit(sbx, tag, `TEST-CTN-${tag}`);
    // The defect: the configured code itself is no unit of the sandbox's plant.
    expect(await one(sbx, 'select plant.press_unit_problem($1) as r', [`CTN-${tag}`])).not.toBeNull();
    expect(await one(sbx, 'select tab.configured_unit($1) as r', [`CTN-${tag}`])).toBe(`TEST-CTN-${tag}`);
    expect(await one(sbx, 'select plant.press_unit_problem(tab.configured_unit($1)) as r', [`CTN-${tag}`])).toBeNull();
    expect(await one(sbx, 'select tab.packline_unit($1::jsonb) as r', [JSON.stringify({ config: { unit: `CTN-${tag}` } })])).toBe(`TEST-CTN-${tag}`);
    // A code that is a sandbox unit, and one with no TEST- unit, read as they are: the plant's rule still refuses the latter.
    expect(await one(sbx, 'select tab.configured_unit($1) as r', [`TEST-CTN-${tag}`])).toBe(`TEST-CTN-${tag}`);
    expect(await one(sbx, 'select tab.configured_unit($1) as r', [`ZZ-${tag}`])).toBe(`ZZ-${tag}`);
    expect(await one(sbx, 'select plant.press_unit_problem(tab.configured_unit($1)) as r', [`ZZ-${tag}`])).not.toBeNull();
    expect(await one(sbx, 'select tab.configured_unit(null) as r', [])).toBeNull();
  });

  it('[DI-05][PR-22] on GMP the configured code is read as it is', async () => {
    const tag = randomBytes(3).toString('hex').toUpperCase();
    await defineUnit(gmp, tag, `CTN-${tag}`);
    expect(await one(gmp, 'select tab.configured_unit($1) as r', [`CTN-${tag}`])).toBe(`CTN-${tag}`);
    expect(await one(gmp, 'select tab.configured_unit($1) as r', [`ZZ-${tag}`])).toBe(`ZZ-${tag}`);
    expect(await one(gmp, "select tab.configured_unit($1) as r where kernel.installation_kind() = 'GMP'", [`CTN-${tag}`])).toBe(`CTN-${tag}`);
  });

  it('[PR-37][PR-22] the checks, holds, overdue checks and line clearance of TB-23 and TB-24 read the configured unit through it', async () => {
    for (const fn of ['tab.packline_apply_holds', 'tab.packline_pass_check', 'tab.packline_line_problem', 'tab.record_ipc_overdue']) {
      const def = (await one(sbx, `select string_agg(pg_get_functiondef(p.oid), ' ') as r from pg_proc p where p.oid::regproc::text = $1 or p.proname = split_part($1, '.', 2) and p.pronamespace = 'tab'::regnamespace`, [fn])) ?? '';
      expect(def, fn).toContain('tab.packline_unit(');
      expect(def, fn).not.toMatch(/'config' ->> 'unit'/);
    }
    const pass = (await one(sbx, "select pg_get_functiondef('tab.ipc_pass_check()'::regprocedure) as r", [])) ?? '';
    expect(pass).toContain("tab.configured_unit(p -> 'config' ->> 'unit') = new.press_code");
  });
});
