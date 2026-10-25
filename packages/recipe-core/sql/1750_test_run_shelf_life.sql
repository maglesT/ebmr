-- Recipe core: a sandbox test run of a packaging master takes the shelf life its printed-materials step states when the
-- sandbox has no product master for it (Phase 7 slice 7r, decision D-7r-1; found by the R4 browser run of a company's
-- own product, Demotab's packaging master; controls PR-43, IN-16, DI-05).
--
-- Handbook: modules/recipe-core.md
--
-- The record's coding of a packaging order (tab.g21_expected_coding, tablets 1230) is its batch data or else the
-- database's expiry, recipe.batch_expiry (0893), from the product master in effect when the batch was made. The
-- sandbox has no product master: its products are never fed by the ERP and the steward registers only test lots there.
-- So no test run of a packaging master with a coded item could record its start, middle and end coding specimens on the
-- screens (EBMR-LBL-034), and none could reach EXECUTION_COMPLETE: a company's own packaging master (D-7o-3) could not
-- get its SANDBOX_RUN evidence (DI-04).
--
-- recipe.batch_shelf_life (0893, CREATE OR REPLACE; its body carried) adds one last source, for a test run only (a batch
-- that runs a test package, on the sandbox installation) and only when no product master version is found: the shelf
-- life the run's own master states on its printed-materials step (G-21 shelfLifeMonths, the value the GMP batch data
-- must equal the product master's, tablets 1201), with no stability reference and marked tentative. A GMP batch is never
-- dated from it (it has no test package; the installation is GMP): its expiry stays the product master's (PR-43). A
-- master whose G-21 step states no shelf life gives none, as before.

set local role ebmr_owner;

create or replace function recipe.batch_shelf_life(p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  b    recipe.batch_execution;
  v_p  jsonb := recipe.batch_product(p_batch);
  v    site.erp_product;
  s    site.shelf_life_stability;
  v_m  jsonb;
begin
  select * into b from recipe.batch_execution where id = p_batch;
  if b.id is null or v_p is null then
    return null;
  end if;
  v := site.erp_product_effective_at(v_p ->> 'code', v_p ->> 'strength', b.issued_at);
  if v.id is null then
    select p.* into v from site.erp_master_effect x join site.erp_product p on p.id = x.version_id
     where x.master_kind = 'PRODUCT' and x.master_key = site.erp_product_key(v_p ->> 'code', v_p ->> 'strength')
     order by x.effective_at, x.id limit 1;
  end if;
  if v.id is null then
    -- D-7r-1: a sandbox test run without a product master: the shelf life its own master's G-21 step states.
    if b.package_hash is null or kernel.installation_kind() <> 'SANDBOX' then
      return null;
    end if;
    select x.m into v_m
      from jsonb_path_query(recipe.batch_mbr_content(p_batch) -> 'procedure', 'lax $.** ? (@.kind == "phase" && @.block.type == "G-21").config.shelfLifeMonths') x(m)
     where jsonb_typeof(x.m) = 'number' and (x.m #>> '{}') ~ '^[1-9][0-9]{0,2}$'
     limit 1;
    if v_m is null then
      return null;
    end if;
    return jsonb_build_object('versionId', null, 'shelfLifeMonths', (v_m #>> '{}')::integer, 'stabilityReference', null, 'tentative', true);
  end if;
  s := site.shelf_life_basis_of(v.product_code, v.strength, v.shelf_life_months);
  return jsonb_build_object('versionId', v.id, 'shelfLifeMonths', v.shelf_life_months, 'stabilityReference', s.stability_reference,
                            'tentative', coalesce(s.tentative, false));
end
$$;

reset role;
