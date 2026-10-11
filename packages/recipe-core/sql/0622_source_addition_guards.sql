-- Recipe core, Phase 3 slice 5b (reprocessing and recovery, outline 5.2.9 cases 2 and 3; tablets spec TB-08; D-S5-7,
-- D-S5-8; controls PR-47, IN-18, IN-19, PR-57, INV-33; ADR 0012: the rules hold when the application's own database
-- credentials are used directly). Part 3: an addition entry stands on the database's facts, and the addition and its
-- genealogy edge are written in the entry's own transaction.
--
--   * recipe.addition_problem: the rules of an ADDITION entry (blocks/generic/reprocessing.ts additionProblems, which
--     G-24@2 and TB-08@1 apply), read at the row's own time from the registers of 0621, never from what was sent:
--       - the step is a recovery or reprocessing-addition step (NO-ADDITION);
--       - the container is a closed output container of a batch record (AD-HOC), and the source facts the entry carries
--         are exactly recipe.source_container_facts read now (SOURCE-FACTS: a product, a manufacture instant, a
--         recovered flag or a remaining quantity of the caller's is refused);
--       - its status is the step's case: reserved residue for a reprocessing addition, QA-released material for a
--         recovery (SOURCE-STATUS); never of the receiving batch (OWN-BATCH); of the batch's product and strength
--         (OTHER-PRODUCT); never of a batch that itself contains recovered material (CHAINED); not older than the MBR's
--         maximum age from the step's reference instant (TOO-OLD); from at most the MBR's number of source batches
--         (TOO-MANY-SOURCES); in the container's unit (UNIT) and never more than it holds (OVER-REMAINING); the step's
--         cumulative net within the MBR's percentage of the standard batch size (the MBR's first; TOO-MUCH);
--       - the per-use authorisation, where it applies, is a signed USE authorisation of this batch, step, container and
--         case, its signer is the authorisedBy the entry carries, not the person who adds, and no other addition used it
--         (NOT-AUTHORISED, SELF-AUTHORISED, AUTHORISATION-USED);
--   * recipe.record_source_addition: the recipe.source_addition row of an accepted entry (the remaining-quantity guard of
--     0621 runs on it);
--   * recipe.g24v2_check (trigger zr_g24v2 after update on recipe.execution_state): a G-24@2 step other than a validated
--     re-treatment starts only on a signed STEP authorisation of this batch, step and case given by someone other than
--     the person who starts it (it takes no start data, 0623); every new G-24@2 ADDITION holds exactly what the block builds (container, net, source, case,
--     authorisation, authorisedBy, addedBy), leaves its step needing the second person, meets recipe.addition_problem,
--     and is recorded. Refused rows: EBMR-RPR-030;
--   * recipe.source_container_charge_check (triggers ab_rpr_charge, ab_rpr_merge before insert on plant.container_charge
--     and plant.container_merge): a container reserved for reprocessing, or one an addition took from, is never charged,
--     packed or merged (its quantity is the register's, EBMR-RPR-041).
--
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- A quantity in unit p_from as unit p_to (kg and g only; NULL otherwise).
create function recipe.rpr_mass(p_value numeric, p_from text, p_to text) returns numeric
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p_from = p_to then p_value
              when p_from = 'g' and p_to = 'kg' then p_value / 1000
              when p_from = 'kg' and p_to = 'g' then p_value * 1000 end
$$;

-- PR-47, IN-19, INV-33 (header): why entry p_key (record p_e, command entry p_c) of row p_new of batch p_batch (MBR
-- p_content) is not an addition its block may make, with the net p_net in unit p_unit, the age counted from p_age_from
-- (GENERATION or MANUFACTURE) and the per-use authorisation required when p_auth_required; codes prefixed p_prefix
-- (G24 or TB08). NULL when it is.
create function recipe.addition_problem(p_batch uuid, p_content jsonb, p_new jsonb, p_key text, p_e jsonb, p_c jsonb, p_net numeric, p_unit text,
                                        p_age_from text, p_auth_required boolean, p_prefix text) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  e1        jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  v_now_us  numeric := recipe.micros_of(p_new -> 'lastRecordedUs');
  v_node    jsonb := recipe.step_node(p_content, p_new -> 'steps' -> (p_e ->> 'stepKey') ->> 'step');
  v_rp      jsonb := v_node -> 'reprocessing';
  v_facts   jsonb;
  v_auth    jsonb;
  v_prod    jsonb := recipe.batch_product(p_batch);
  v_size    jsonb := p_content -> 'header' -> 'batchSizes' -> 0 -> 'quantity';
  v_from    numeric;
  v_total   numeric;
  v_n       bigint;
begin
  if (v_rp ->> 'case') is distinct from 'REPROCESSING_ADDITION' and (v_rp ->> 'case') is distinct from 'RECOVERY' then
    return format('an addition at step %s, which is no recovery or reprocessing-addition step (%s-NO-ADDITION)', p_e ->> 'stepKey', p_prefix);
  end if;
  if coalesce(p_c ->> 'container', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return format('an addition that names no output container: ad-hoc material is never added (%s-AD-HOC)', p_prefix);
  end if;
  v_facts := recipe.source_container_facts((p_c ->> 'container')::uuid, p_batch);
  if v_facts is null then
    return format('an addition from %s, which is no closed output container of a batch record: ad-hoc material is never added (%s-AD-HOC)', p_c ->> 'container', p_prefix);
  end if;
  if (p_c -> 'source') is distinct from v_facts then
    return format('an addition whose source facts are not the database''s for container %s (%s; %s-SOURCE-FACTS)', p_c ->> 'container', v_facts, p_prefix);
  end if;
  if (v_facts ->> 'case') is distinct from (v_rp ->> 'case') then
    return format('an addition from container %s, which is %s, at a %s step (%s-SOURCE-STATUS)', p_c ->> 'container',
                  case v_facts ->> 'case' when 'REPROCESSING_ADDITION' then 'residue reserved for reprocessing' when 'RECOVERY' then 'material released by QA'
                       else 'neither residue reserved for reprocessing nor material released by QA' end,
                  lower(replace(v_rp ->> 'case', '_', ' ')), p_prefix);
  end if;
  if (v_facts ->> 'sourceBatchId')::uuid = p_batch then
    return format('an addition from container %s of the receiving batch itself (%s-OWN-BATCH)', p_c ->> 'container', p_prefix);
  end if;
  if (v_facts ->> 'product') is distinct from (v_prod ->> 'code') or (v_facts ->> 'strength') is distinct from (v_prod ->> 'strength') then
    return format('an addition of %s %s to a batch of %s %s (%s-OTHER-PRODUCT)', v_facts ->> 'product', v_facts ->> 'strength', v_prod ->> 'code', v_prod ->> 'strength', p_prefix);
  end if;
  if (v_facts -> 'containsRecovered') = 'true'::jsonb then
    return format('an addition from a batch that itself contains recovered material: chained recovery is blocked (%s-CHAINED)', p_prefix);
  end if;
  v_from := (v_facts ->> case when p_age_from = 'MANUFACTURE' then 'manufacturedAtUs' else 'generatedAtUs' end)::numeric;
  if recipe.duration_us(v_rp -> 'maxAge') is null or v_now_us is null or v_now_us - v_from > recipe.duration_us(v_rp -> 'maxAge') then
    return format('an addition of material older than the MBR''s maximum of %s %s at the row''s time (%s-TOO-OLD)', v_rp -> 'maxAge' ->> 'value', v_rp -> 'maxAge' ->> 'unit', p_prefix);
  end if;
  select count(distinct x.value -> 'data' -> 'source' ->> 'sourceBatchId') into v_n
    from jsonb_each(e1) x where x.value ->> 'stepKey' = p_e ->> 'stepKey' and x.value ->> 'kind' = 'ADDITION';
  if jsonb_typeof(v_rp -> 'maxSourceBatches') is distinct from 'number' or v_n > (v_rp ->> 'maxSourceBatches')::numeric then
    return format('an addition that brings the source batches of its step to %s, above the MBR''s %s (%s-TOO-MANY-SOURCES)', v_n, coalesce(v_rp ->> 'maxSourceBatches', 'none'), p_prefix);
  end if;
  if p_unit is distinct from (v_facts ->> 'unit') then
    return format('an addition in %s from a container counted in %s (%s-UNIT)', coalesce(p_unit, '(none)'), v_facts ->> 'unit', p_prefix);
  end if;
  if p_net is null or p_net <= 0 or p_net > (v_facts ->> 'remaining')::numeric then
    return format('an addition of %s %s from container %s, which holds %s (%s-OVER-REMAINING)', coalesce(trim_scale(p_net)::text, '(none)'), p_unit, p_c ->> 'container', v_facts ->> 'remaining', p_prefix);
  end if;
  select sum(recipe.rpr_mass((x.value -> 'data' -> 'net' ->> 'value')::numeric, x.value -> 'data' -> 'net' ->> 'unit', v_size ->> 'unit')) into v_total
    from jsonb_each(e1) x where x.value ->> 'stepKey' = p_e ->> 'stepKey' and x.value ->> 'kind' = 'ADDITION';
  if jsonb_typeof(v_rp -> 'maxPercent') is distinct from 'string' or v_total is null
     or v_total * 100 > (v_size ->> 'value')::numeric * (v_rp ->> 'maxPercent')::numeric then
    return format('an addition that brings the material added at its step to %s %s, above %s %% of the standard batch size %s %s (%s-TOO-MUCH)',
                  coalesce(trim_scale(v_total)::text, '(not comparable)'), v_size ->> 'unit', coalesce(v_rp ->> 'maxPercent', '(none)'), v_size ->> 'value', v_size ->> 'unit', p_prefix);
  end if;
  if p_c ->> 'authorisation' is null then
    if p_auth_required then
      return format('an addition without the quality unit''s prior authorisation of this use (%s-NOT-AUTHORISED)', p_prefix);
    end if;
    if p_c ? 'authorisedBy' then
      return format('an addition that names a signer without an authorisation (%s-NOT-AUTHORISED)', p_prefix);
    end if;
    return null;
  end if;
  v_auth := case when (p_c ->> 'authorisation') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then recipe.reprocessing_authorisation_facts((p_c ->> 'authorisation')::uuid) end;
  if v_auth is null or (v_auth ->> 'batchId')::uuid is distinct from p_batch or v_auth ->> 'scope' is distinct from 'USE'
     or v_auth ->> 'step' is distinct from v_node ->> 'id' or v_auth ->> 'container' is distinct from p_c ->> 'container'
     or v_auth ->> 'case' is distinct from v_rp ->> 'case' then
    return format('an addition under %s, which is no signed authorisation of this use (this batch, step, container and case) (%s-NOT-AUTHORISED)', p_c ->> 'authorisation', p_prefix);
  end if;
  if (p_c -> 'authorisedBy') is distinct from (v_auth -> 'signedBy') then
    return format('an addition naming %s as its authoriser, where %s signed the authorisation (%s-NOT-AUTHORISED)', coalesce(p_c ->> 'authorisedBy', '(none)'), v_auth ->> 'signedBy', p_prefix);
  end if;
  if (v_auth -> 'signedBy') = (p_e -> 'enteredBy') then
    return format('an addition authorised by the person who adds the material (%s-SELF-AUTHORISED)', p_prefix);
  end if;
  if exists (select 1 from recipe.source_addition a where a.authorisation_id = (p_c ->> 'authorisation')::uuid)
     or exists (select 1 from jsonb_each(e1) x where x.key <> p_key and x.value ->> 'kind' = 'ADDITION' and x.value -> 'data' ->> 'authorisation' = p_c ->> 'authorisation') then
    return format('an addition under authorisation %s, which another addition used (%s-AUTHORISATION-USED)', p_c ->> 'authorisation', p_prefix);
  end if;
  return null;
end
$$;

-- INV-33, PR-57: records accepted addition entry p_key (record p_e) of batch p_batch at block p_block with net p_net.
create function recipe.record_source_addition(p_batch uuid, p_key text, p_e jsonb, p_block text, p_net numeric) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  d  jsonb := p_e -> 'data';
  s  jsonb := p_e -> 'data' -> 'source';
  sb recipe.batch_execution;
begin
  select * into sb from recipe.batch_execution where id = (s ->> 'sourceBatchId')::uuid;
  insert into recipe.source_addition (batch_id, batch_number, step_key, entry_id, block, container_id, case_code, net_quantity, unit, source_batch_id,
                                      source_batch_number, product_code, strength, source_generated_at, source_manufactured_at, source_expiry,
                                      authorisation_id, added_by_person)
  values (p_batch, (select b.batch_number from recipe.batch_execution b where b.id = p_batch), p_e ->> 'stepKey', p_key, p_block,
          (d ->> 'container')::uuid, d ->> 'case', p_net, s ->> 'unit', sb.id, sb.batch_number, s ->> 'product', s ->> 'strength',
          to_timestamp((s ->> 'generatedAtUs')::numeric / 1000000), to_timestamp((s ->> 'manufacturedAtUs')::numeric / 1000000),
          case when s ? 'expiry' then to_date(s ->> 'expiry', 'YYYY-MM') end,
          (d ->> 'authorisation')::uuid, (p_e ->> 'enteredBy')::uuid);
end
$$;

-- PR-47 (header): why the start of reprocessing step p_step (MBR node id, case p_case) of batch p_batch by person
-- p_starter has no signed authorisation of the quality unit for it, or NULL.
create function recipe.reprocessing_start_problem(p_batch uuid, p_step text, p_case text, p_starter text) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if not exists (select 1 from recipe.reprocessing_authorisation a join recipe.reprocessing_authorisation_signature s on s.authorisation_id = a.id
                  where a.batch_id = p_batch and a.step_id = p_step and a.scope = 'STEP' and a.case_code = p_case) then
    return format('starts reprocessing step %s without the quality unit''s signed authorisation of this step of this batch and its case (G24-NOT-AUTHORISED)', p_step);
  end if;
  if not exists (select 1 from recipe.reprocessing_authorisation a join recipe.reprocessing_authorisation_signature s on s.authorisation_id = a.id
                  where a.batch_id = p_batch and a.step_id = p_step and a.scope = 'STEP' and a.case_code = p_case and s.signer_person::text is distinct from p_starter) then
    return format('starts reprocessing step %s authorised only by the person who starts it (G24-SELF-AUTHORISED)', p_step);
  end if;
  return null;
end
$$;

-- The row trigger of G-24@2 (header).
create function recipe.g24v2_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0        jsonb := case when jsonb_typeof(old.state -> 'entries') = 'object' then old.state -> 'entries' else '{}'::jsonb end;
  r         recipe.execution_command;
  v_content jsonb;
  v_node    jsonb;
  v_c       jsonb;
  v_want    jsonb;
  v_inst    jsonb;
  v_problem text;
  k         text;
  e         jsonb;
begin
  v_content := recipe.batch_mbr_content(new.batch_id);
  if not exists (select 1 from jsonb_path_query(coalesce(v_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p
                  where p -> 'block' ->> 'type' = 'G-24' and p -> 'block' ->> 'version' = '2') then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  -- The start of a G-24@2 step (other than a validated re-treatment) stands on a signed STEP authorisation.
  if r.command ->> 'type' = 'START_STEP' then
    v_inst := recipe.step_instance_of(new.state, r.command);
    v_node := recipe.step_node(v_content, r.command ->> 'step');
    if v_inst ->> 'status' = 'IN_PROGRESS' and (recipe.step_instance_of(old.state, r.command) ->> 'status') is distinct from 'IN_PROGRESS'
       and v_node -> 'block' ->> 'type' = 'G-24' and v_node -> 'block' ->> 'version' = '2'
       and (v_node -> 'reprocessing' ->> 'case') is distinct from 'VALIDATED_RETREATMENT' then
      v_problem := recipe.reprocessing_start_problem(new.batch_id, v_node ->> 'id', v_node -> 'reprocessing' ->> 'case', r.command -> 'actor' ->> 'id');
    end if;
  end if;
  for k, e in select x.key, x.value from jsonb_each(case when v_problem is null and jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) x
               where not (e0 ? x.key) and x.value ->> 'kind' in ('ADDITION', 'START_DATA') order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_node := recipe.step_node(v_content, new.state -> 'steps' -> (e ->> 'stepKey') ->> 'step');
    if v_node -> 'block' ->> 'type' is distinct from 'G-24' or v_node -> 'block' ->> 'version' is distinct from '2' then
      continue;
    end if;
    if e ->> 'kind' = 'START_DATA' then
      v_problem := format('stores start data %s at G-24@2 step %s, which takes none: it starts on the quality unit''s signed authorisation (G24-NOT-AUTHORISED)', k, e ->> 'stepKey');
    else
      v_c := case when jsonb_typeof(r.command -> 'entry') = 'object' then r.command -> 'entry' else '{}'::jsonb end;
      v_want := jsonb_strip_nulls(jsonb_build_object('container', v_c -> 'container',
                                                     'net', jsonb_build_object('value', v_c -> 'quantity' -> 'value', 'unit', v_c -> 'quantity' -> 'unit'),
                                                     'source', v_c -> 'source', 'case', v_node -> 'reprocessing' -> 'case',
                                                     'authorisation', v_c -> 'authorisation', 'authorisedBy', v_c -> 'authorisedBy', 'addedBy', e -> 'enteredBy'));
      if (e -> 'data') is distinct from v_want then
        v_problem := format('stores entry %s (ADDITION) of step %s with data %s, where its block writes %s', k, e ->> 'stepKey', e -> 'data', v_want);
      elsif (new.state -> 'steps' -> (e ->> 'stepKey') -> 'verificationRequired') is distinct from 'true'::jsonb then
        v_problem := format('stores entry %s (ADDITION), which needs a second person''s check of its step, and the step does not require it (PR-14)', k);
      else
        v_problem := recipe.addition_problem(new.batch_id, v_content, new.state, k, e, v_c,
                                             case when (v_c -> 'quantity' ->> 'value') ~ '^[0-9]+(\.[0-9]+)?$' then (v_c -> 'quantity' ->> 'value')::numeric end,
                                             v_c -> 'quantity' ->> 'unit', 'GENERATION', true, 'G24');
      end if;
      if v_problem is null then
        perform recipe.record_source_addition(new.batch_id, k, e, 'G-24@2', (v_c -> 'quantity' ->> 'value')::numeric);
      end if;
    end if;
    exit when v_problem is not null;
  end loop;
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: a reprocessing step adds only material its records allow, from the database''s facts, under the quality unit''s prior authorisation (PR-47, IN-19, INV-33). [EBMR-RPR-030]',
                       case when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create trigger zr_g24v2 after update on recipe.execution_state
  for each row execute function recipe.g24v2_check();

-- PR-47, INV-33 (header): a container reserved for reprocessing or taken from by an addition is never charged, packed or
-- merged.
create function recipe.source_container_charge_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  v_ids uuid[] := case when tg_table_name = 'container_merge' then array[(to_jsonb(new) ->> 'source_id')::uuid, (to_jsonb(new) ->> 'target_id')::uuid]
                       else array[(to_jsonb(new) ->> 'container_id')::uuid] end;
begin
  if exists (select 1 from recipe.residue_reservation r where r.container_id = any (v_ids))
     or exists (select 1 from recipe.source_addition a where a.container_id = any (v_ids)) then
    raise exception using errcode = 'P0001',
      message = format('This container cannot be %s: it is reserved for reprocessing or an addition took from it, so what it holds is the reprocessing register''s (PR-47, INV-33). [EBMR-RPR-041]',
                       case when tg_table_name = 'container_merge' then 'merged' else 'charged or packed' end);
  end if;
  return new;
end
$$;

create trigger ab_rpr_charge before insert on plant.container_charge for each row execute function recipe.source_container_charge_check();
create trigger ab_rpr_merge before insert on plant.container_merge for each row execute function recipe.source_container_charge_check();

revoke all on function recipe.rpr_mass(numeric, text, text),
  recipe.addition_problem(uuid, jsonb, jsonb, text, jsonb, jsonb, numeric, text, text, boolean, text),
  recipe.record_source_addition(uuid, text, jsonb, text, numeric), recipe.reprocessing_start_problem(uuid, text, text, text),
  recipe.g24v2_check(), recipe.source_container_charge_check() from public;

reset role;
