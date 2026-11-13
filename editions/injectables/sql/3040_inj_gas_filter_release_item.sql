-- Injectables I-6 B5 (lead rulings on #245 and on the B5 report, 13 November 2026; ST-28): a batch that applied a
-- nitrogen overlay is not certified or released without a passing post-use integrity result of the overlay's gas
-- filter, on every market (Schedule M Part II 6.11.2.7; EU GMP Annex 1 8.88). The item keys on no block code, so a
-- firm's own QA-approved compounding and gas-filter blocks gate release the same way. It reads marks and a role from
-- each batch's master snapshot (recipe.batch_mbr_content, its blockDefinitions; recipe.library_definition, 1810):
--   * the overlay: a field marked `gasOverlayApplied` (a CHOICE field names the option that records an applied overlay,
--     a YES_NO field is marked true) whose recorded value in an entry of its section equals the mark;
--   * the test: a step whose block definition has the role GAS_FILTER_INTEGRITY; its result is the NUMBER field marked
--     `postUseIntegrity: true` (recipe-core library check LIB-GAS-FILTER: exactly one, critical, with a limit slot),
--     judged against the step's limit for that slot (recipe.limit_reading, 0305).
-- The catalogue blocks carry the marks and the role (INJ-COMPOUND's nitrogen option 'Applied'; INJ-GAS-FILTER's role
-- and its gasFilterPost field), set by their v1 edit in place.
--
-- Handbook: modules/injectables.md
--
--   injectables.grel_gas_filter(batches)  new: the release item E.GAS_FILTER (group 10) over the processing batch and the
--       packaging order of the lot. Fails closed:
--       NA      no entry of the batches records an applied overlay by a marked field.
--       RED     an overlay was applied and no GAS_FILTER_INTEGRITY step ran; or such a step is not COMPLETED; or its
--               definition marks no result field; or it has no result; or a result is not within its limit (a value the
--               database cannot judge, or a missing limit, does not pass; a dispositioned failure stays RED).
--       GREEN   otherwise.
--
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
  v_state   jsonb;
  v_def     jsonb;
  v_node    jsonb;
  v_field   jsonb;
  v_spec    jsonb;
  v_reading jsonb;
  v_results integer;
  b         uuid;
  k         text;
  s         jsonb;
  e         jsonb;
begin
  -- The overlay: an entry whose section has a field marked gasOverlayApplied holding the marked value (one is enough).
  foreach b in array coalesce(p_batches, '{}'::uuid[]) loop
    v_content := recipe.batch_mbr_content(b);
    select st.state into v_state from recipe.execution_state st where st.batch_id = b;
    for e in select x.value from jsonb_each(case when jsonb_typeof(v_state -> 'entries') = 'object' then v_state -> 'entries' else '{}'::jsonb end) x loop
      v_def := recipe.library_definition(v_content, recipe.step_node(v_content, v_state -> 'steps' -> (e ->> 'stepKey') ->> 'step') -> 'block');
      if exists (select 1
                   from jsonb_array_elements(case when jsonb_typeof(v_def -> 'sections') = 'array' then v_def -> 'sections' else '[]'::jsonb end) sec,
                        jsonb_array_elements(case when jsonb_typeof(sec -> 'fields') = 'array' then sec -> 'fields' else '[]'::jsonb end) f
                  where sec ->> 'id' = e ->> 'kind' and f ? 'gasOverlayApplied' and e -> 'data' -> (f ->> 'id') = f -> 'gasOverlayApplied') then
        v_applied := true;
      end if;
    end loop;
  end loop;
  if not v_applied then
    return tab.grel_item_of('E.GAS_FILTER', '10', v_title, null, null, true);
  end if;
  foreach b in array p_batches loop
    v_content := recipe.batch_mbr_content(b);
    select st.state into v_state from recipe.execution_state st where st.batch_id = b;
    for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(v_state -> 'steps') = 'object' then v_state -> 'steps' else '{}'::jsonb end) x order by x.key loop
      v_node := recipe.step_node(v_content, s ->> 'step');
      v_def := recipe.library_definition(v_content, v_node -> 'block');
      if jsonb_typeof(v_def -> 'roles') is distinct from 'array' or not (v_def -> 'roles' ? 'GAS_FILTER_INTEGRITY') or s ->> 'status' = 'NOT_APPLICABLE' then
        continue;
      end if;
      v_ran := true;
      v_ev := v_ev || tab.grel_batch_ev(b);
      if s ->> 'status' is distinct from 'COMPLETED' then
        v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the overlay gas filter''s post-use integrity test %s is %s, not COMPLETED', k, coalesce(s ->> 'status', 'of no status')), tab.grel_batch_ev(b)));
        continue;
      end if;
      select jsonb_build_object('section', sec ->> 'id', 'field', f) into v_field
        from jsonb_array_elements(case when jsonb_typeof(v_def -> 'sections') = 'array' then v_def -> 'sections' else '[]'::jsonb end) sec,
             jsonb_array_elements(case when jsonb_typeof(sec -> 'fields') = 'array' then sec -> 'fields' else '[]'::jsonb end) f
       where f ->> 'type' = 'NUMBER' and f -> 'postUseIntegrity' = 'true'::jsonb
       limit 1;
      if v_field is null then
        v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the overlay gas filter''s post-use integrity test %s marks no result field', k), tab.grel_batch_ev(b)));
        continue;
      end if;
      v_spec := v_node -> 'config' -> 'limits' -> (v_field -> 'field' ->> 'limitSlot');
      v_results := 0;
      for e in select x from jsonb_array_elements(tab.grel_entries(b, k, v_field ->> 'section')) x loop
        if e -> 'data' ->> (v_field -> 'field' ->> 'id') is null then
          continue;
        end if;
        v_results := v_results + 1;
        v_reading := case when v_spec is not null then recipe.limit_reading(v_spec, e -> 'data' ->> (v_field -> 'field' ->> 'id')) end;
        if v_reading is null or v_reading ->> 'breached' is not null then
          v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the overlay gas filter''s post-use integrity result %s %s of %s does not pass its limit',
                                                   e -> 'data' ->> (v_field -> 'field' ->> 'id'), coalesce(v_field -> 'field' ->> 'unit', ''), k), tab.grel_batch_ev(b)));
        end if;
      end loop;
      if v_results = 0 then
        v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the overlay gas filter''s post-use integrity test %s has no result', k), tab.grel_batch_ev(b)));
      end if;
    end loop;
  end loop;
  if not v_ran then
    v_probs := jsonb_build_array(tab.grel_problem('a nitrogen overlay was applied and no post-use integrity test of its gas filter (a block with the role GAS_FILTER_INTEGRITY) ran', tab.grel_batch_ev(p_batches[1])));
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
