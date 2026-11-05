/**
 * The installation's rule tables (platform/rule-tables.ts): since injectables slice I-1 the set-up publishes the sterile
 * table with the kernel and tablets tables, so an injectables master or batch can resolve its sterile keys. The market
 * engine keeps each table to scopes of its edition (EBMR-MKT-054, kernel test in52).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INSTALLATION_RULE_TABLES, publishRuleTables } from '../../src/platform/rule-tables.ts';
import { stewardActor } from '../designer/support.ts';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;

beforeAll(async () => {
  gmp = await startServer('GMP');
}, 120_000);

afterAll(async () => {
  await gmp.close();
});

describe('the installation rule tables', () => {
  it('[IN-52] the set-up publishes the kernel, tablets and sterile tables, each once: a second run finds them published with the same content', async () => {
    expect(INSTALLATION_RULE_TABLES).toEqual(['kernel', 'tablets', 'sterile']);
    const actor = await stewardActor(gmp);
    const first = await publishRuleTables({ pools: { app: gmp.db.app } }, actor);
    expect(first.map((o) => [o.table, o.version, o.action])).toEqual([
      ['kernel', 1, 'PUBLISHED'],
      ['tablets', 1, 'PUBLISHED'],
      ['sterile', 1, 'PUBLISHED'],
    ]);
    const second = await publishRuleTables({ pools: { app: gmp.db.app } }, actor);
    expect(second.map((o) => o.action)).toEqual(['ALREADY_PUBLISHED', 'ALREADY_PUBLISHED', 'ALREADY_PUBLISHED']);
    const { rows } = await gmp.db.app.query<{ table_code: string }>("select table_code from market.rule_table_version where table_code = 'sterile'");
    expect(rows).toHaveLength(1);
  });
});
