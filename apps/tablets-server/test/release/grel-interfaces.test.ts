/**
 * Slice 3-0 interfaces (recipe-core 0780, tablets 1160): G-REL answers its fixed shape for any lot and market, the
 * edition's items come through the registered hook (Tablets: tab.grel_edition_items), and only the owner registers a
 * hook. As the application role.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeOf } from '../execution/db-guards-support.ts';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;

beforeAll(async () => {
  gmp = await startServer('GMP');
}, 300_000);

afterAll(async () => {
  await gmp.close();
});

describe('G-REL interfaces (slice 3-0)', () => {
  it('[meta] G-REL answers the fixed item shape; a lot that is no finished lot gets one RED edition item; only IN, US and EU are evaluated', async () => {
    const { rows } = await gmp.db.app.query<{ g: { ready: boolean; epoch: string; items: { id: string; group: string; status: string; problem: string | null; evidence: unknown[]; since_review: boolean }[] } }>(
      "select recipe.grel_evaluate($1, 'IN') as g",
      [randomUUID()],
    );
    const g = rows[0]!.g;
    expect(g.ready).toBe(false);
    expect(typeof g.epoch).toBe('string');
    for (const i of g.items) {
      expect(['GREEN', 'RED', 'NA']).toContain(i.status);
      expect(Array.isArray(i.evidence)).toBe(true);
      expect(typeof i.since_review).toBe('boolean');
      expect(i.status === 'RED').toBe(i.problem !== null);
    }
    expect(g.items.find((i) => i.id === 'E.EDITION')).toMatchObject({ group: '10', status: 'RED', problem: 'the lot is no finished lot of a packaging batch' });
    expect(await codeOf(gmp.db.app.query("select recipe.grel_evaluate($1, 'UK')", [randomUUID()]))).toBe('EBMR-REL-002');
  });

  it('[meta] the Tablets hook is registered and answers an array; the application role cannot register or replace a hook', async () => {
    const hooks = await gmp.db.app.query<{ edition: string; function_name: string }>('select edition, function_name from recipe.grel_edition_hook');
    expect(hooks.rows).toEqual([{ edition: 'TABLETS', function_name: 'tab.grel_edition_items(uuid,text)' }]);
    const { rows } = await gmp.db.app.query<{ r: unknown }>("select tab.grel_edition_items($1, 'IN') as r", [randomUUID()]);
    expect(Array.isArray(rows[0]!.r)).toBe(true);
    expect(await codeOf(gmp.db.app.query("select recipe.register_grel_edition_hook('INJECTABLES', 'tab.grel_edition_items(uuid, text)')"))).toMatch(/permission denied/);
    expect(await codeOf(gmp.db.app.query("insert into recipe.grel_edition_hook (edition, function_name) values ('INJECTABLES', 'tab.grel_edition_items(uuid,text)')"))).toMatch(/permission denied/);
    expect(await codeOf(gmp.db.app.query("update recipe.grel_edition_hook set function_name = 'public.x(uuid,text)'"))).toMatch(/permission denied/);
  });
});
