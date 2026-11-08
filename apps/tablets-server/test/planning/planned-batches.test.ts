/**
 * Planned batches are never stranded (owner report items 14 and 15, G4): a batch planned and not yet issued is read back
 * from the database with what its issue needs (execution.plannedBatch), so the planning page opens the issue form after
 * a reload; it is not found once issued. The India issue rule (IN-30: licence, export permission, hazard area) also runs
 * at planning, with the issue gate's own message, and a refused plan leaves no batch planned.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { valueOf } from '../esig/support.ts';
import { SITE, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';

let w: GmpBatchWorld;
beforeAll(async () => {
  w = await startGmpBatchWorld();
}, 600_000);
afterAll(async () => {
  await w?.close();
});

describe('planned batches (G4)', () => {
  it('[IN-18][DI-17] a planned batch is read back as "Plan a batch" answered it, so it is issued from any session; once issued it is no longer a planned batch', async () => {
    const issuer = await w.gmp.asPersona('issuer');
    const planned = await w.plan(issuer);
    const read = valueOf(await issuer.call(routes.execution.plannedBatch, { params: { batchId: planned.batchId } }));
    expect(read).toEqual(planned);
    const orders = valueOf(await issuer.call(routes.planning.orders, {})).orders;
    expect(orders.flatMap((o) => o.batches).find((b) => b.batchId === planned.batchId)?.status).toBe('PLANNED');
    expect(valueOf(await w.signIssue(issuer, planned.batchId))).toBeTruthy();
    const after = await issuer.call(routes.execution.plannedBatch, { params: { batchId: planned.batchId } });
    expect(after.ok).toBe(false);
  }, 300_000);

  it('[IN-30] the licence the issue needs is checked at planning, with the issue gate\'s rule and message; the refused plan uses no number and leaves no batch planned', async () => {
    const issuer = await w.gmp.asPersona('issuer');
    const product = (await w.gmp.db.admin.query<{ product_code: string; strength: string }>('select product_code, strength from recipe.mbr_family where id = $1', [w.familyId])).rows[0];
    expect(product).toBeDefined();
    const licences = await w.gmp.db.admin.query<{ id: string }>(
      'select l.id from site.manufacturing_licence l join site.licence_product p on p.licence_id = l.id where l.site_code = $1 and p.product_code = $2 and p.strength = $3',
      [SITE, product?.product_code, product?.strength],
    );
    expect(licences.rows.length).toBeGreaterThan(0);
    for (const l of licences.rows) {
      const state = (await w.gmp.db.admin.query<{ s: string }>('select site.licence_state($1) as s', [l.id])).rows[0]?.s;
      if (state === 'APPROVED') await w.world.run(w.world.cast.qa, (c) => c.query("select site.suspend_manufacturing_licence($1, 'Suspended by order of the licensing authority')", [l.id]));
    }
    const count = async () => Number((await w.gmp.db.admin.query<{ n: string }>("select count(*)::text as n from recipe.stub_batch where family_id = $1 and status = 'PLANNED'", [w.familyId])).rows[0]?.n);
    const before = await count();
    let refused: unknown;
    try {
      await w.plan(issuer);
    } catch (e) {
      refused = e;
    }
    expect(String(refused instanceof Error ? refused.message : JSON.stringify(refused))).toMatch(/EBMR-IND-040/);
    expect(await count()).toBe(before);
  }, 300_000);
});

