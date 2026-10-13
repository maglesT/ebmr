/**
 * Recipe-core 0931 (Phase 4 slice 7b, performance re-measure): recipe.audit_review_events reads the review window's end once
 * (its CTE materialized), so an audit-trail review of a long record no longer takes minutes; the function stays a hardened
 * definer and gives the same events as its own query evaluated with the window read beforehand.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';

let w: GmpBatchWorld;
let batchId: string;

beforeAll(async () => {
  w = await startGmpBatchWorld();
  batchId = await w.issued(await w.gmp.asPersona('issuer'));
}, 600_000);
afterAll(async () => {
  await w?.close();
});

describe('the audit-trail review\'s event list (recipe-core 0931)', () => {
  it('[INV-48][DI-25] reads the window\'s end once and stays a hardened definer owned by the owner, executable by the application role only', async () => {
    const { rows } = await w.gmp.db.admin.query<{ def: string; owner: string; config: string[] | null; definer: boolean; app: boolean; pub: boolean }>(
      `select pg_get_functiondef(p.oid) as def, pg_get_userbyid(p.proowner) as owner, p.proconfig as config, p.prosecdef as definer,
              has_function_privilege('ebmr_app', p.oid, 'EXECUTE') as app,
              coalesce(exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'), p.proacl is null) as pub
         from pg_proc p where p.oid = 'recipe.audit_review_events(uuid, jsonb)'::regprocedure`,
    );
    const f = rows[0];
    expect(f?.def).toMatch(/done as materialized \(select recipe\.review_execution_end/);
    expect(f?.owner).toBe('ebmr_owner');
    expect(f?.definer).toBe(true);
    expect(f?.config?.find((c) => c.startsWith('search_path='))).toMatch(/, pg_temp$/);
    expect(f?.app).toBe(true);
    expect(f?.pub).toBe(false);
  });

  it('[INV-48][DI-25] gives the events of the record\'s scope exactly as its query with the window read first', async () => {
    const got = await w.gmp.db.admin.query<{ k: string }>("select chain_key || '#' || seq || '#' || critical || '#' || linked as k from recipe.audit_review_events($1, null) order by 1", [batchId]);
    const want = await w.gmp.db.admin.query<{ k: string }>(
      `with sc as (select * from recipe.audit_review_scope_chains($1)),
            done as materialized (select recipe.review_execution_end($1) as t, (select min(b.issued_at) from recipe.batch_execution b where b.id = any (recipe.review_batches($1))) as issued)
       select e.chain_key || '#' || e.seq || '#' || ((sc.window_from is not null and e.recorded_at < done.issued) or (sc.window_from is null and sc.kind not in ('BATCH', 'PACKAGING_ORDER') and e.recorded_at > done.t))
              || '#' || (sc.kind not in ('BATCH', 'PACKAGING_ORDER')) as k
         from sc cross join done join kernel.audit_event e on e.chain_key = sc.chain_key
        where sc.window_from is null or (e.recorded_at >= sc.window_from and e.recorded_at <= sc.window_to)
        order by 1`,
      [batchId],
    );
    expect(got.rows.length).toBeGreaterThan(0);
    expect(got.rows).toEqual(want.rows);
  });
});
