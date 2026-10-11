-- Tablets server, Phase 3 slice 5b: TB-08@1 and TB-20's reusable residue held by the database (tablets spec B.2 TB-08,
-- TB-20; outline 5.2.9 cases 2 and 3; C-07; controls PR-47, IN-19, IN-18, PR-57, PR-46, INV-33, INV-25; ADR 0012: the
-- rules hold when the application's own database credentials are used directly).
--
--   1. tab.tb08_entry_problem / tab.tb08_state_check (trigger zt_tab_tb08 after update on recipe.execution_state): a new
--      ADDITION entry at a TB-08 step holds exactly what tb-08.ts builds from its command (container, gross, tare, net =
--      gross - tare in the weighing's unit, the source facts, the step's case, the authorisation and its signer when
--      named, the person), leaves the step needing its second person, comes from a stage the configuration allows
--      (TB08-SOURCE-TYPE), and meets recipe-core's addition rules read at the row's time (recipe.addition_problem,
--      recipe-core 0622: the facts are the database's, case, product, chained, age from the configured instant, sources,
--      unit, remaining, the MBR percentage, the per-use authorisation where tb-08.ts perUseRequired applies). The accepted
--      addition is written to recipe.source_addition in the same transaction (the genealogy edge; the remaining-quantity
--      guard of recipe-core 0621 runs on it). EBMR-RPR-031.
--   2. tab.tb08_computed_problem: a new value of the item a TB-08 step computes (configuration addedItem; C-07) is the
--      exact sum of the nets of the step's ADDITION entries in the item's unit, source BLOCK naming those entries
--      (TB08-ADDED-COMPUTED). EBMR-RPR-032.
--   3. recipe.granulation_block_item (CREATE OR REPLACE from tablets 0912, the latest): TB-08's addedItem is a block
--      value its block judges (item 2), not a weighing total.
--   4. recipe.residue_source_problem (CREATE OR REPLACE from recipe-core 0621): reusable residue of this edition is a
--      container its batch's TB-20 sort result names under REUSABLE_RESIDUE; only such a container is reserved for
--      reprocessing (recipe.reserve_residue).
--   5. tab.coating_mbr_problem (CREATE OR REPLACE from tablets 0912, the latest): besides its gates, an inspection step
--      that keeps reusable residue needs a TB-08 step in the MBR to use it (TB20-RESIDUE; "the reusable category exists
--      only if the MBR has a matching TB-08 step").
--
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- PR-47, IN-19, INV-33 (header, item 1): why a new TB-08 entry of row p_new of batch p_batch (after p_old, command
-- p_command, MBR p_content) is not what its block builds and accepts; records each accepted addition. NULL when all are.
create function tab.tb08_entry_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb, p_command jsonb) returns text
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  e0        jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  k         text;
  e         jsonb;
  c         jsonb := case when jsonb_typeof(p_command -> 'entry') = 'object' then p_command -> 'entry' else '{}'::jsonb end;
  v_node    jsonb;
  v_cfg     jsonb;
  v_net     numeric;
  v_want    jsonb;
  v_problem text;
  v_auth    boolean;
begin
  for k, e in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
               where not (e0 ? x.key) order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_node := recipe.step_node(p_content, p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step');
    if v_node -> 'block' ->> 'type' is distinct from 'TB-08' then
      continue;
    end if;
    if e ->> 'kind' is distinct from 'ADDITION' then
      return format('stores entry %s (%s) at TB-08 step %s, which records additions only (TB08-ENTRY)', k, e ->> 'kind', e ->> 'stepKey');
    end if;
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    v_net := case when (c ->> 'gross') ~ '^[0-9]+(\.[0-9]+)?$' and (c ->> 'tare') ~ '^[0-9]+(\.[0-9]+)?$' then (c ->> 'gross')::numeric - (c ->> 'tare')::numeric end;
    if v_net is null or v_net <= 0 then
      return format('stores entry %s, an addition whose net (gross - tare) is not positive (TB08-NET)', k);
    end if;
    v_want := jsonb_strip_nulls(jsonb_build_object('container', c -> 'container', 'gross', c -> 'gross', 'tare', c -> 'tare',
                                                   'net', jsonb_build_object('value', v_net::text, 'unit', c -> 'unit'), 'source', c -> 'source',
                                                   'case', v_node -> 'reprocessing' -> 'case', 'authorisation', c -> 'authorisation',
                                                   'authorisedBy', c -> 'authorisedBy', 'addedBy', e -> 'enteredBy'));
    if (e -> 'data') is distinct from v_want then
      return format('stores entry %s (ADDITION) with data %s, where its block writes %s', k, e -> 'data', v_want);
    end if;
    if (p_new -> 'steps' -> (e ->> 'stepKey') -> 'verificationRequired') is distinct from 'true'::jsonb then
      return format('stores entry %s, a weighing keyed by hand, and its step does not require the second person (PR-14)', k);
    end if;
    if jsonb_typeof(v_cfg -> 'sourceStages') = 'array'
       and not exists (select 1 from jsonb_array_elements_text(v_cfg -> 'sourceStages') s where s = c -> 'source' ->> 'stage') then
      return format('stores entry %s, an addition of material filled at stage %s, which is no source type the MBR allows here (TB08-SOURCE-TYPE)', k, coalesce(c -> 'source' ->> 'stage', '(none)'));
    end if;
    -- tb-08.ts perUseRequired: off only for a recovery step that carries its prior authorisation.
    v_auth := not ((v_cfg -> 'perUseAuthorisation') = 'false'::jsonb and v_node -> 'reprocessing' ->> 'case' = 'RECOVERY'
                   and jsonb_typeof(v_cfg -> 'priorAuthorisation') = 'object');
    v_problem := recipe.addition_problem(p_batch, p_content, p_new, k, e, c, v_net, c ->> 'unit',
                                         case when v_cfg ->> 'ageFrom' = 'MANUFACTURE' then 'MANUFACTURE' else 'GENERATION' end, v_auth, 'TB08');
    if v_problem is not null then
      return format('stores entry %s: %s', k, v_problem);
    end if;
    perform recipe.record_source_addition(p_batch, k, e, 'TB-08@1', v_net);
  end loop;
  return null;
end
$$;

-- C-07, INV-25 (header, item 2): why a new value of a TB-08 step's added-material item in row p_new is not the sum of
-- its additions, or NULL.
create function tab.tb08_computed_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  k       text;
  p       jsonb;
  v_node  jsonb;
  v_unit  text;
  v_ids   jsonb;
  v_sum   numeric;
begin
  for k, p in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'points') = 'object' then p_new -> 'points' else '{}'::jsonb end) x
               where not coalesce((p_old -> 'points') ? x.key, false) order by x.key loop
    v_node := tab.gran_node(p_content, p_new, p ->> 'stepKey');
    if v_node -> 'block' ->> 'type' is distinct from 'TB-08' or v_node -> 'config' ->> 'addedItem' is distinct from p ->> 'item' then
      continue;
    end if;
    select q ->> 'unit' into v_unit from jsonb_array_elements(case when jsonb_typeof(p_content -> 'parameters') = 'array' then p_content -> 'parameters' else '[]'::jsonb end) q
     where q ->> 'id' = p ->> 'item' limit 1;
    select coalesce(jsonb_agg(x ->> 'id' order by (x ->> 'recordedSeq')::numeric), '[]'::jsonb),
           sum(recipe.rpr_mass((x -> 'data' -> 'net' ->> 'value')::numeric, x -> 'data' -> 'net' ->> 'unit', v_unit))
      into v_ids, v_sum
      from jsonb_array_elements(tab.gran_prior(p_new, p ->> 'stepKey', 'Infinity'::numeric, 'ADDITION')) x;
    if p ->> 'kind' is distinct from 'VALUE' or (p -> 'source') is distinct from jsonb_build_object('mode', 'BLOCK', 'entries', v_ids)
       or (p -> 'value') is distinct from jsonb_build_object('kind', 'DECIMAL', 'value', trim_scale(coalesce(v_sum, 0))::text, 'unit', v_unit) then
      return format('stores value %s of %s at step %s that is not the net its additions add (%s %s; TB08-ADDED-COMPUTED)', k, p ->> 'item', p ->> 'stepKey',
                    coalesce(trim_scale(v_sum)::text, '0'), coalesce(v_unit, '?'));
    end if;
  end loop;
  return null;
end
$$;

create function tab.tb08_state_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
  v_code    text;
begin
  v_content := recipe.batch_mbr_content(new.batch_id);
  if not exists (select 1 from jsonb_path_query(coalesce(v_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p
                  where p -> 'block' ->> 'type' = 'TB-08') then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_problem := tab.tb08_entry_problem(new.batch_id, v_content, old.state, new.state, r.command);
  v_code := 'EBMR-RPR-031';
  if v_problem is null then
    v_problem := tab.tb08_computed_problem(v_content, old.state, new.state);
    v_code := 'EBMR-RPR-032';
  end if;
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: a rework or recovery addition takes only material its records allow, from the database''s facts, under the quality unit''s prior authorisation, and its block computes what it added (PR-47, IN-19, INV-33, C-07). [%s]',
                       case when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem, v_code);
  end if;
  return null;
end
$$;

create trigger zt_tab_tb08 after update on recipe.execution_state
  for each row execute function tab.tb08_state_check();

-- As tablets 0912, with TB-08's added-material item (item 3).
create or replace function recipe.granulation_block_item(p_content jsonb, p_state jsonb, p_point jsonb) returns boolean
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(n -> 'block' ->> 'type' = 'TB-04' and n -> 'config' -> 'endPoint' ->> 'item' = p_point ->> 'item'
                  or n -> 'block' ->> 'type' = 'TB-07' and (n -> 'config' -> 'blendTime' ->> 'item' = p_point ->> 'item'
                                                            or n -> 'config' -> 'lubrication' ->> 'item' = p_point ->> 'item')
                  or n -> 'block' ->> 'type' = 'TB-18' and (n -> 'config' ->> 'part' = 'CORES' and n -> 'config' ->> 'coreItem' = p_point ->> 'item'
                                                            or n -> 'config' ->> 'part' = 'COATING' and n -> 'config' ->> 'gainItem' = p_point ->> 'item')
                  or n -> 'block' ->> 'type' = 'TB-08' and n -> 'config' ->> 'addedItem' = p_point ->> 'item', false)
    from (select recipe.step_node(p_content, p_state -> 'steps' -> (p_point ->> 'stepKey') ->> 'step') as n) s
$$;

-- As recipe-core 0621, for this edition (item 4): a container named reusable residue by a TB-20 sort result of its batch.
create or replace function recipe.residue_source_problem(p_container uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, tab, pg_temp as $$
declare
  o       plant.output_container;
  v_state jsonb;
begin
  select * into o from plant.output_container where id = p_container;
  if not found then
    return 'it is no output container';
  end if;
  select st.state into v_state from recipe.execution_state st where st.batch_id = o.batch_id;
  if not exists (select 1 from jsonb_array_elements(tab.coat_rejects(recipe.batch_mbr_content(o.batch_id), v_state)) x
                  where x ->> 'container' = o.id::text and x ->> 'category' = 'REUSABLE_RESIDUE') then
    return 'no inspection step (TB-20) of its batch put reusable residue into it';
  end if;
  return null;
end
$$;

-- As tablets 0912, with the reusable residue of an inspection step only beside a TB-08 step (item 5).
create or replace function tab.coating_mbr_problem(p_content jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, tab, pg_temp as $$
declare
  p      jsonb;
  v_next jsonb;
  v_g    jsonb;
begin
  for p in select x from jsonb_path_query(coalesce(p_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') x
            where x -> 'block' ->> 'type' in ('TB-19', 'TB-20') loop
    if p -> 'block' ->> 'type' = 'TB-19' then
      v_next := tab.coat_next_node(p_content, p ->> 'id');
      if v_next ->> 'kind' is distinct from 'holdPoint' or v_next ->> 'role' is distinct from coalesce(tab.coat_cfg(p) ->> 'gateRole', 'QA')
         or not exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(v_next -> 'dispositions') = 'array' then v_next -> 'dispositions' else '[]'::jsonb end) d
                         where d not in ('APPROVED', 'APPROVED_WITH_CONDITIONS', 'CONTINUE', 'RELEASED', 'ACCEPTED')) then
        return format('printing step %s is not followed by a QA hold point of its gate role that can reject the printed tablets (TB19-NO-GATE)', p ->> 'id');
      end if;
    else
      select x into v_g from jsonb_path_query(coalesce(p_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase" && @.id == $id)',
                                              jsonb_build_object('id', tab.coat_cfg(p) ->> 'destructionStep')) x limit 1;
      -- Review 3d finding 2: the destruction step runs after the inspection on every path that runs it (a later step of
      -- the inspection's own sequence) and is never skipped.
      if v_g -> 'block' ->> 'type' is distinct from 'G-23' or (tab.coat_cfg(v_g) -> 'witness') = 'false'::jsonb
         or v_g -> 'signatures' -> 'check' ->> 'meaning' is distinct from 'WITNESSED' or (tab.coat_cfg(v_g) -> 'skippable') = 'true'::jsonb
         or not tab.coat_later_in_sequence(p_content, p ->> 'id', v_g ->> 'id') then
        return format('inspection step %s names no witnessed, unskippable G-23 step after it in its sequence for its rejects (TB20-DESTRUCTION)', p ->> 'id');
      end if;
      if (tab.coat_cfg(p) -> 'reusableResidue') = 'true'::jsonb
         and not exists (select 1 from jsonb_path_query(coalesce(p_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') t
                          where t -> 'block' ->> 'type' = 'TB-08') then
        return format('inspection step %s keeps reusable residue, and the MBR has no rework addition step (TB-08) to use it (TB20-RESIDUE)', p ->> 'id');
      end if;
    end if;
  end loop;
  return null;
end
$$;

revoke all on function tab.tb08_entry_problem(uuid, jsonb, jsonb, jsonb, jsonb), tab.tb08_computed_problem(jsonb, jsonb, jsonb), tab.tb08_state_check() from public;

reset role;
