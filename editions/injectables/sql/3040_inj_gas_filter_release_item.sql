-- Injectables I-6 B5 (lead ruling on #245, 13 November 2026; ST-28): a batch that applied a nitrogen overlay is not
-- certified or released without a passing post-use integrity result of the overlay's gas filter, on every market.
-- The integrity of a critical gas filter is confirmed after use (Schedule M Part II 6.11.2.7; EU GMP Annex 1 8.88).
-- Whether an overlay is applied is an answer at run time (INJ-COMPOUND, field preparation.nitrogen), so no master
-- rule can require the INJ-GAS-FILTER step; this release item reads the answer and the result where they are stored.
--
-- Handbook: modules/injectables.md
--
--   injectables.grel_gas_filter(batches)  new: the release item E.GAS_FILTER (group 10) over the processing batch and
--       the packaging order of the lot.
--       NA      no INJ-COMPOUND step of the batches has a preparation entry answering 'Applied' to the nitrogen overlay.
--       RED     an overlay was applied, and the batches have no INJ-GAS-FILTER step (the master has none, or none ran);
--               or an INJ-GAS-FILTER step that ran is not COMPLETED; or it has no post-use result; or a result is not
--               within its limit as the database judges it (recipe.limit_reading against the step's limit in the
--               master's snapshot, 0305; a value it cannot judge, or a missing limit, does not pass). A failing result
--               stays RED after its exception is dispositioned: the lead's ruling asks a passing result.
--       GREEN   otherwise, with the gas-filter steps as evidence.
--     The answer and the result are read from the execution state (recipe.execution_state), as every edition item.
--   injectables.grel_edition_items(lot, market)  CREATE OR REPLACE from 3000: the same items, and E.GAS_FILTER after
--       E.PACK_EXAMINATION. A RED item keeps the lot NOT_READY, so the manufacturer release is refused with
--       EBMR-REL-020 naming the item (recipe-core 0781, 0823), and the release view shows its problem.
--
-- PL/pgSQL, SECURITY DEFINER, search_path pinned with pg_temp last (ADR 0016).

set local role ebmr_owner;

-- E.GAS_FILTER (header).
create function injectables.grel_gas_filter(p_batches uuid[]) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, injectables, tab, recipe, pg_temp as $$
declare
  v_title   text := 'Overlay gas filter integrity passed after use (ST-28)';
  v_applied boolean := false;
  v_ran     boolean := false;
  v_probs   jsonb := '[]'::jsonb;
  v_ev      jsonb := '[]'::jsonb;
  v_content jsonb;
  v_def     jsonb;
  v_node    jsonb;
  v_spec    jsonb;
  v_reading jsonb;
  v_results integer;
  b         uuid;
  k         text;
  s         jsonb;
  e         jsonb;
begin
  -- The overlay: any preparation entry of a compounding step that answered 'Applied' (fails closed: one is enough).
  foreach b in array coalesce(p_batches, '{}'::uuid[]) loop
    for k, s in select g.step_key, g.step from tab.grel_steps(b, 'LIB-INJ-COMPOUND') g loop
      if exists (select 1 from jsonb_array_elements(tab.grel_entries(b, k, 'preparation')) x where x -> 'data' ->> 'nitrogen' = 'Applied') then
        v_applied := true;
      end if;
    end loop;
  end loop;
  if not v_applied then
    return tab.grel_item_of('E.GAS_FILTER', '10', v_title, null, null, true);
  end if;
  foreach b in array p_batches loop
    v_content := recipe.batch_mbr_content(b);
    for k, s in select g.step_key, g.step from tab.grel_steps(b, 'LIB-INJ-GAS-FILTER') g where g.step ->> 'status' is distinct from 'NOT_APPLICABLE' loop
      v_ran := true;
      v_ev := v_ev || tab.grel_batch_ev(b);
      if s ->> 'status' is distinct from 'COMPLETED' then
        v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the overlay gas filter''s post-use integrity test %s is %s, not COMPLETED', k, coalesce(s ->> 'status', 'of no status')), tab.grel_batch_ev(b)));
        continue;
      end if;
      v_node := recipe.step_node(v_content, s ->> 'step');
      v_def := recipe.library_definition(v_content, v_node -> 'block');
      v_spec := v_node -> 'config' -> 'limits' -> (
        select f ->> 'limitSlot' from jsonb_array_elements(coalesce(v_def -> 'sections', '[]'::jsonb)) sec, jsonb_array_elements(coalesce(sec -> 'fields', '[]'::jsonb)) f
         where f ->> 'id' = 'gasFilterPost' limit 1);
      v_results := 0;
      for e in select x from jsonb_array_elements(tab.grel_entries(b, k, 'gasFilter')) x loop
        if e -> 'data' ->> 'gasFilterPost' is null then
          continue;
        end if;
        v_results := v_results + 1;
        v_reading := case when v_spec is not null then recipe.limit_reading(v_spec, e -> 'data' ->> 'gasFilterPost') end;
        if v_reading is null or v_reading ->> 'breached' is not null then
          v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the overlay gas filter''s post-use integrity result %s bar of %s does not pass its limit', e -> 'data' ->> 'gasFilterPost', k), tab.grel_batch_ev(b)));
        end if;
      end loop;
      if v_results = 0 then
        v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the overlay gas filter''s post-use integrity test %s has no result', k), tab.grel_batch_ev(b)));
      end if;
    end loop;
  end loop;
  if not v_ran then
    v_probs := jsonb_build_array(tab.grel_problem('a nitrogen overlay was applied and no post-use integrity test of its gas filter (INJ-GAS-FILTER) ran', tab.grel_batch_ev(p_batches[1])));
  end if;
  return tab.grel_item_of('E.GAS_FILTER', '10', v_title, v_probs, v_ev);
end
$$;

create or replace function injectables.grel_edition_items(p_lot uuid, p_market text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, injectables, tab, recipe, site, pg_temp as $$
declare
  f        site.finished_lot;
  v_parent uuid;
  v_both   uuid[];
  v_rev    timestamptz;
  v_items  jsonb;
begin
  select * into f from site.finished_lot x where x.lot_id = p_lot;
  if f.lot_id is null or f.edition <> 'INJECTABLES' then
    return jsonb_build_array(recipe.grel_item('E.EDITION', '10', 'Edition items', 'the lot is no finished lot of an injectables packaging order'));
  end if;
  v_parent := recipe.packaging_parent_of(f.batch_id);
  v_both := array_remove(array[f.batch_id, v_parent], null);
  v_rev := recipe.release_review_time(p_lot);
  v_items := jsonb_build_array(
    tab.grel_recon_printed(f.batch_id, v_parent),
    tab.grel_recon_yield(f.batch_id, v_parent),
    injectables.grel_pack_examination(f.batch_id),
    injectables.grel_gas_filter(v_both),
    tab.grel_held_containers(v_both),
    tab.grel_container_release(f.batch_id),
    tab.grel_rule_sets(v_both),
    tab.grel_whole_batch_parents(v_both));
  return (select jsonb_agg(i || jsonb_build_object('since_review', tab.grel_changed_since(v_rev,
            case i ->> 'id' when 'E.PACK_EXAMINATION' then array[f.batch_id] when 'E.CONTAINER_RELEASE' then '{}'::uuid[] when 'E.WHOLE_BATCH_PARENTS' then '{}'::uuid[] else v_both end,
            i -> 'evidence')) order by n)
            from jsonb_array_elements(v_items) with ordinality x (i, n));
end
$$;

revoke all on function injectables.grel_gas_filter(uuid[]), injectables.grel_edition_items(uuid, text) from public;

reset role;
