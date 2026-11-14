-- Injectables I-6, INV-36 (lead rulings, 14 November 2026): a batch whose master has a sterilising filter integrity step
-- is not certified or released unless the step is completed with a passing integrity result before use and a passing
-- result after use, the post-use result recorded after the step's other entries, on every market. Binding clause:
-- Schedule M Part II 6.11.2.7 (the filter's integrity verified before use and confirmed immediately after use, by a
-- suitable method, with the results in the batch record). The housing, the redundant train and the serial train
-- (Annex 1 8.87, 8.91, 8.92, "should" clauses) are a write-up, not built (lead ruling).
-- The item keys on no block code: it reads a role and marks from each batch's master snapshot (recipe.batch_mbr_content,
-- its blockDefinitions; recipe.library_definition, 1810), so a firm's own QA-approved filter block gates release the same
-- way (decision 0026):
--   * the test: a step whose block definition has the role STERILE_FILTER_INTEGRITY;
--   * its results: the NUMBER fields marked `preUseIntegrity: true` and `postUseIntegrity: true` (recipe-core library
--     check LIB-STERILE-FILTER: at least one of each, critical, with a limit slot, the post-use ones in sections after
--     the pre-use ones), each judged against the step's limit for its slot (recipe.limit_reading, 0305).
-- The catalogue block INJ-STERILE-FILTER carries the role and the marks, set by its v1 edit in place (lead ruling).
--
-- Handbook: modules/injectables.md
--
--   injectables.grel_sterile_filter(batches)  new: the release item E.STERILE_FILTER (group 10) over the processing batch
--       and the packaging order of the lot. Fails closed:
--       NA      no step of the batches has the role (a step NOT_APPLICABLE does not count).
--       RED     such a step is not COMPLETED; or it has no passing pre-use or no passing post-use result (also when its
--               definition marks no such field); or a result is not within its limit (a value the
--               database cannot judge, or a missing limit, does not pass; a dispositioned failure stays RED); or a
--               post-use result is recorded (recordedSeq) before another data entry of the step that holds no post-use
--               result, so the post-use test was not done after the filtration. A timer's start and stop are not data
--               entries here: the simulator and the kiosk's nominal run stop a step's timers after its last section.
--       GREEN   otherwise.
--
--   injectables.grel_edition_items(lot, market)  CREATE OR REPLACE from 3040: the same items, and E.STERILE_FILTER after
--       E.GAS_FILTER. A RED item keeps the lot NOT_READY, so the manufacturer release is refused with EBMR-REL-020
--       naming the item (recipe-core 0781, 0823), and the release view shows its problem.
--
-- PL/pgSQL, SECURITY DEFINER, search_path pinned with pg_temp last (ADR 0016).

set local role ebmr_owner;

-- E.STERILE_FILTER (header).
create function injectables.grel_sterile_filter(p_batches uuid[]) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, injectables, tab, recipe, pg_temp as $$
declare
  v_title   text := 'Sterilising filter integrity passed before and after use (INV-36)';
  v_ran     boolean := false;
  v_probs   jsonb := '[]'::jsonb;
  v_ev      jsonb := '[]'::jsonb;
  v_content jsonb;
  v_state   jsonb;
  v_def     jsonb;
  v_node    jsonb;
  v_fields  jsonb;
  v_spec    jsonb;
  v_reading jsonb;
  v_value   text;
  v_pass    text[];
  v_post    jsonb;
  v_first   numeric;
  v_last    numeric;
  b         uuid;
  k         text;
  s         jsonb;
  e         jsonb;
  f         jsonb;
  m         text;
begin
  foreach b in array coalesce(p_batches, '{}'::uuid[]) loop
    v_content := recipe.batch_mbr_content(b);
    select st.state into v_state from recipe.execution_state st where st.batch_id = b;
    for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(v_state -> 'steps') = 'object' then v_state -> 'steps' else '{}'::jsonb end) x order by x.key loop
      v_node := recipe.step_node(v_content, s ->> 'step');
      v_def := recipe.library_definition(v_content, v_node -> 'block');
      if jsonb_typeof(v_def -> 'roles') is distinct from 'array' or not (v_def -> 'roles' ? 'STERILE_FILTER_INTEGRITY') or s ->> 'status' = 'NOT_APPLICABLE' then
        continue;
      end if;
      v_ran := true;
      v_ev := v_ev || tab.grel_batch_ev(b);
      if s ->> 'status' is distinct from 'COMPLETED' then
        v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the sterilising filter integrity test %s is %s, not COMPLETED', k, coalesce(s ->> 'status', 'of no status')), tab.grel_batch_ev(b)));
        continue;
      end if;
      -- The marked result fields, with their sections: [{section, field, mark}].
      select coalesce(jsonb_agg(jsonb_build_object('section', sec ->> 'id', 'field', fl, 'mark', mk.mark)), '[]'::jsonb) into v_fields
        from jsonb_array_elements(case when jsonb_typeof(v_def -> 'sections') = 'array' then v_def -> 'sections' else '[]'::jsonb end) sec,
             jsonb_array_elements(case when jsonb_typeof(sec -> 'fields') = 'array' then sec -> 'fields' else '[]'::jsonb end) fl,
             (values ('preUseIntegrity'), ('postUseIntegrity')) mk (mark)
       where fl ->> 'type' = 'NUMBER' and fl -> mk.mark = 'true'::jsonb;
      v_pass := '{}'::text[];
      v_post := '[]'::jsonb;
      for e in select x from jsonb_array_elements(tab.grel_entries(b, k, null)) x loop
        for f in select x from jsonb_array_elements(v_fields) x where x ->> 'section' = e ->> 'kind' loop
          v_value := e -> 'data' ->> (f -> 'field' ->> 'id');
          if v_value is null then
            continue;
          end if;
          if f ->> 'mark' = 'postUseIntegrity' then
            v_post := v_post || jsonb_build_array(e -> 'recordedSeq');
          end if;
          v_spec := v_node -> 'config' -> 'limits' -> (f -> 'field' ->> 'limitSlot');
          v_reading := case when v_spec is not null then recipe.limit_reading(v_spec, v_value) end;
          if v_reading is null or v_reading ->> 'breached' is not null then
            v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the sterilising filter''s %s integrity result %s %s of %s does not pass its limit',
                                                     case f ->> 'mark' when 'preUseIntegrity' then 'pre-use' else 'post-use' end, v_value, coalesce(f -> 'field' ->> 'unit', ''), k), tab.grel_batch_ev(b)));
          else
            v_pass := v_pass || (f ->> 'mark');
          end if;
        end loop;
      end loop;
      foreach m in array array['preUseIntegrity', 'postUseIntegrity'] loop
        -- A definition that marks no such field has no passing result either (fails closed).
        if not (m = any (v_pass)) then
          v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the sterilising filter integrity test %s has no passing %s result', k, case m when 'preUseIntegrity' then 'pre-use' else 'post-use' end), tab.grel_batch_ev(b)));
        end if;
      end loop;
      -- Immediately after use: every post-use result is recorded after every other data entry of the step.
      select min((x #>> '{}')::numeric) into v_first from jsonb_array_elements(v_post) x where jsonb_typeof(x) = 'number';
      select max((x ->> 'recordedSeq')::numeric) into v_last
        from jsonb_array_elements(tab.grel_entries(b, k, null)) x
       where x ->> 'kind' not in ('TIMER_START', 'TIMER_STOP')
         and not exists (select 1 from jsonb_array_elements(v_fields) y
                          where y ->> 'mark' = 'postUseIntegrity' and y ->> 'section' = x ->> 'kind' and x -> 'data' ->> (y -> 'field' ->> 'id') is not null);
      if v_first is not null and v_last is not null and v_first < v_last then
        v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the sterilising filter''s post-use integrity result of %s is recorded before the step''s other entries, not after use', k), tab.grel_batch_ev(b)));
      end if;
    end loop;
  end loop;
  if not v_ran then
    return tab.grel_item_of('E.STERILE_FILTER', '10', v_title, null, null, true);
  end if;
  return tab.grel_item_of('E.STERILE_FILTER', '10', v_title, v_probs, v_ev);
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
    injectables.grel_sterile_filter(v_both),
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

revoke all on function injectables.grel_sterile_filter(uuid[]), injectables.grel_edition_items(uuid, text) from public;

reset role;
