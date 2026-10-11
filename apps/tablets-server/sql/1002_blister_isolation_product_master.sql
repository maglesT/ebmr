-- Tablets: TB-21 isolation reads beta-lactam from the ERP product master too (Phase 3 slice 5a step 4; site services
-- 0732 site.product_master_of; slice 5 plan D-S5-5; backlog slice 4b low; IN-38 (d)).
--
-- tab.blister_isolation_problem, replaced from its latest definition (0972) with one change: the product is beta-lactam
-- when the TB-21 configuration says so OR the product master of the batch's product and strength says so. The master
-- adds to the MBR step's flag and never removes it (D-S5-5). Nothing else changes. CREATE OR REPLACE keeps the owner
-- and grants.

set local role ebmr_owner;

-- As 0972_blister_guards.sql; beta-lactam also from the product master (header).
create or replace function tab.blister_isolation_problem(p_batch uuid, p_cfg jsonb, p_machine text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, plant, recipe, pg_temp as $$
declare
  v_potent boolean := (p_cfg -> 'product' -> 'potent') = 'true'::jsonb
                      or exists (select 1 from plant.product p where p.code = recipe.batch_product(p_batch) ->> 'code' and p.highly_potent);
  v_area   uuid := (select q.area_id from plant.equipment q where q.code = p_machine);
  v_beta   boolean := (p_cfg -> 'product' -> 'betaLactam') = 'true'::jsonb
                      or coalesce((site.product_master_of(recipe.batch_product(p_batch) ->> 'code', recipe.batch_product(p_batch) ->> 'strength') ->> 'betaLactam')::boolean, false);
begin
  if (p_cfg -> 'product' -> 'uncoated') = 'true'::jsonb and (v_potent or v_beta)
     and (v_area is null or not tab.line_isolated(v_area)) then
    return format('the product is an uncoated %s product and the line of machine %s is not flagged isolated (TB21-ISOLATION; IN-38)',
                  case when v_potent then 'potent' else 'beta-lactam' end, left(coalesce(p_machine, '(none)'), 64));
  end if;
  return null;
end
$$;

reset role;
