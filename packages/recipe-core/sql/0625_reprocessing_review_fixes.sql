-- Recipe core, Phase 3 slice 5b review fixes (controls INV-33, PR-57, IN-19, PR-47; ADR 0012: the rules hold when the
-- application's own database credentials are used directly).
--
--   1. (HIGH) recipe.batches_receiving_from (from 0621): the forward trace of a batch also finds the whole-batch
--      reprocessing children linked to it (recipe.batch_parent_link, 0624), beside the batches its material was added to.
--   2. (HIGH) recipe.recovered_expiry_cap (from 0621): a whole-batch child's expiry is capped at each parent's expiry too
--      (its manufacturing month plus the product master's shelf life, less one: recipe.source_batch_expiry), beside the
--      earliest expiry among the material added (tablets 1022 prints through it).
--   3. recipe.reprocessing_request_problem (from 0624): a parent is a batch whose execution is complete or aborted (never
--      one still running: the non-conformance is the concluded investigation linked to it; batch disposition is Phase 4),
--      is not itself a reprocessing child (no chaining), and is named by no other authorised or used request.
--   4. recipe.source_container_charge_check (from 0622): takes the container's advisory lock that an addition takes
--      (recipe.source_container:<id>), so a charge or merge and a partial take never race past each other.
--   5. recipe.reprocessing_step_start (new, insert-only, audited) and recipe.reprocessing_start_take: a STEP authorisation
--      serves one start; recipe.g24v2_check (from 0622) records which authorisation a start took
--      (G24-AUTHORISATION-USED when every signed one of the step is used).
--
-- Messages as before (EBMR-RPR-030, 041, 052). CREATE OR REPLACE keeps owners and grants. Applied as a new migration
-- because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- 1 (header).
create or replace function recipe.batches_receiving_from(p_batch uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(jsonb_agg(t.j order by t.at, t.k), '[]'::jsonb)
    from (select a.recorded_at as at, a.id::text as k,
                 jsonb_build_object('batchId', a.batch_id, 'batchNumber', a.batch_number, 'stepKey', a.step_key, 'entry', a.entry_id,
                                    'container', a.container_id, 'quantity', trim_scale(a.net_quantity)::text, 'unit', a.unit, 'case', a.case_code) as j
            from recipe.source_addition a where a.source_batch_id = p_batch
          union all
          select l.recorded_at, l.child_batch_id::text,
                 jsonb_build_object('batchId', l.child_batch_id, 'batchNumber', sb.batch_number, 'case', 'WHOLE_BATCH', 'containers', to_jsonb(l.parent_containers))
            from recipe.batch_parent_link l join recipe.stub_batch sb on sb.id = l.child_batch_id where l.parent_batch_id = p_batch) t
$$;

-- 2 (header).
create or replace function recipe.recovered_expiry_cap(p_batch uuid) returns timestamptz
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select (min(x.d)::timestamp at time zone 'UTC')
    from (select a.source_expiry as d from recipe.source_addition a where a.batch_id = p_batch
          union all
          select recipe.source_batch_expiry(l.parent_batch_id) from recipe.batch_parent_link l where l.child_batch_id = p_batch) x
   where x.d is not null
$$;

-- 3 (header).
create or replace function recipe.reprocessing_request_problem(p_request uuid, p_family uuid, p_site text, p_issuer uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  q       recipe.reprocessing_request;
  s       recipe.reprocessing_request_signature;
  f       recipe.mbr_family;
  v_pm    jsonb;
  v_par   uuid;
  x       recipe.batch_execution;
  v_prob  text;
begin
  select * into q from recipe.reprocessing_request where id = p_request;
  if q.id is null then
    return 'it names no reprocessing request';
  end if;
  select * into s from recipe.reprocessing_request_signature where request_id = q.id;
  if s.request_id is null then
    return 'the quality-control unit has not authorised the reprocessing (no REPROCESSING_AUTHORISED signature)';
  end if;
  if q.family_id is distinct from p_family or q.site_code is distinct from p_site then
    return 'the request is for another reprocessing master or site';
  end if;
  select * into f from recipe.mbr_family where id = p_family;
  if f.record_kind is distinct from 'REPROCESSING' then
    return format('family %s is no reprocessing master (record kind REPROCESSING)', f.code);
  end if;
  v_pm := site.product_master_of(f.product_code, f.strength);
  if v_pm is null or (v_pm -> 'reprocessingPermitted') is distinct from 'true'::jsonb then
    return format('the product master does not permit reprocessing of %s %s (product-level disable; D-S5-5)', f.product_code, f.strength);
  end if;
  foreach v_par in array q.parent_batch_ids loop
    select * into x from recipe.batch_execution where id = v_par;
    if x.id is null or x.purpose <> 'GMP_BATCH' then
      return format('parent %s is no issued GMP batch', v_par);
    end if;
    if (recipe.batch_product(v_par) ->> 'code') is distinct from f.product_code or (recipe.batch_product(v_par) ->> 'strength') is distinct from f.strength
       or (select sb.site from recipe.stub_batch sb where sb.id = v_par) is distinct from p_site then
      return format('parent %s is not of %s %s at site %s', x.batch_number, f.product_code, f.strength, p_site);
    end if;
    -- Review finding 3: a parent is finished and non-conforming material, never a batch still running, never itself a
    -- reprocessing child (no chaining), and never named by another authorised or used request.
    if coalesce((select st.status from recipe.execution_state st where st.batch_id = v_par), '(none)') not in ('EXECUTION_COMPLETE', 'ABORTED') then
      return format('parent %s is %s: only a batch whose execution is complete or aborted is reprocessed as a whole', x.batch_number,
                    coalesce((select st.status from recipe.execution_state st where st.batch_id = v_par), 'not executed'));
    end if;
    if exists (select 1 from recipe.batch_parent_link l where l.child_batch_id = v_par) then
      return format('parent %s is itself a reprocessed batch: chained reprocessing is blocked', x.batch_number);
    end if;
    if exists (select 1 from recipe.reprocessing_request o
                where o.id <> q.id and v_par = any (o.parent_batch_ids)
                  and (exists (select 1 from recipe.reprocessing_request_signature os where os.request_id = o.id)
                       or exists (select 1 from recipe.batch_parent_link l where l.request_id = o.id))) then
      return format('parent %s is named by another authorised reprocessing request', x.batch_number);
    end if;
    v_prob := site.deviation_ref_problem(q.investigation_ref, 'REPROCESSING', v_par);
    if v_prob is not null then
      return format('the investigation %s does not stand for parent %s: %s', q.investigation_ref, x.batch_number, v_prob);
    end if;
  end loop;
  v_prob := site.evidence_document_problem(q.risk_evaluation_id, p_site);
  if v_prob is not null then
    return format('the risk evaluation %s', v_prob);
  end if;
  if s.signer_person = p_issuer then
    return 'the reprocessing is authorised by the person who plans the batch; the quality-control unit authorises it, not the issuer';
  end if;
  if exists (select 1 from recipe.batch_parent_link l where l.request_id = q.id) then
    return 'the request was used for a batch already; each reprocessing is authorised once';
  end if;
  return null;
end
$$;


-- 4 (header).
create or replace function recipe.source_container_charge_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  v_ids uuid[] := case when tg_table_name = 'container_merge' then array[(to_jsonb(new) ->> 'source_id')::uuid, (to_jsonb(new) ->> 'target_id')::uuid]
                       else array[(to_jsonb(new) ->> 'container_id')::uuid] end;
  v_id  uuid;
begin
  -- The lock of a partial take (0621 recipe.source_addition_remaining_check), in a fixed order.
  foreach v_id in array (select array_agg(i order by i) from unnest(v_ids) i) loop
    perform pg_advisory_xact_lock(hashtext('recipe.source_container:' || v_id::text));
  end loop;
  if exists (select 1 from recipe.residue_reservation r where r.container_id = any (v_ids))
     or exists (select 1 from recipe.source_addition a where a.container_id = any (v_ids)) then
    raise exception using errcode = 'P0001',
      message = format('This container cannot be %s: it is reserved for reprocessing or an addition took from it, so what it holds is the reprocessing register''s (PR-47, INV-33). [EBMR-RPR-041]',
                       case when tg_table_name = 'container_merge' then 'merged' else 'charged or packed' end);
  end if;
  return new;
end
$$;

-- 5 (header).
create table recipe.reprocessing_step_start (
  authorisation_id  uuid primary key references recipe.reprocessing_authorisation (id),
  batch_id          uuid not null references recipe.batch_execution (id),
  step_key          text not null check (btrim(step_key) <> ''),
  started_by        text not null,
  recorded_at       timestamptz not null default clock_timestamp()
);
revoke all on recipe.reprocessing_step_start from public;
create trigger aa_insert_only before update or delete on recipe.reprocessing_step_start for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.reprocessing_step_start for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('recipe.reprocessing_step_start', array['recorded_at']);
select kernel.register_audited_table('recipe.reprocessing_step_start', 'reprocessing_authorisation', 'authorisation_id', true);
grant select on recipe.reprocessing_step_start to ebmr_app;

-- PR-47 (header, 5): takes an unused signed STEP authorisation of step p_step (case p_case) of batch p_batch, not signed by
-- p_starter, for the start of instance p_key; NULL when taken, else why none can be.
create function recipe.reprocessing_start_take(p_batch uuid, p_step text, p_case text, p_starter text, p_key text) returns text
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('recipe.reprocessing_step:' || p_batch::text || ':' || coalesce(p_step, '')));
  if not exists (select 1 from recipe.reprocessing_authorisation a join recipe.reprocessing_authorisation_signature s on s.authorisation_id = a.id
                  where a.batch_id = p_batch and a.step_id = p_step and a.scope = 'STEP' and a.case_code = p_case) then
    return format('starts reprocessing step %s without the quality unit''s signed authorisation of this step of this batch and its case (G24-NOT-AUTHORISED)', p_step);
  end if;
  if not exists (select 1 from recipe.reprocessing_authorisation a join recipe.reprocessing_authorisation_signature s on s.authorisation_id = a.id
                  where a.batch_id = p_batch and a.step_id = p_step and a.scope = 'STEP' and a.case_code = p_case and s.signer_person::text is distinct from p_starter) then
    return format('starts reprocessing step %s authorised only by the person who starts it (G24-SELF-AUTHORISED)', p_step);
  end if;
  select a.id into v_id
    from recipe.reprocessing_authorisation a join recipe.reprocessing_authorisation_signature s on s.authorisation_id = a.id
   where a.batch_id = p_batch and a.step_id = p_step and a.scope = 'STEP' and a.case_code = p_case and s.signer_person::text is distinct from p_starter
     and not exists (select 1 from recipe.reprocessing_step_start u where u.authorisation_id = a.id)
   order by s.recorded_at, a.id limit 1;
  if v_id is null then
    return format('starts reprocessing step %s again: each signed authorisation of the step allows one start, and every one was used (G24-AUTHORISATION-USED)', p_step);
  end if;
  insert into recipe.reprocessing_step_start (authorisation_id, batch_id, step_key, started_by) values (v_id, p_batch, p_key, coalesce(p_starter, '(none)'));
  return null;
end
$$;

create or replace function recipe.g24v2_check() returns trigger
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
      v_problem := recipe.reprocessing_start_take(new.batch_id, v_node ->> 'id', v_node -> 'reprocessing' ->> 'case', r.command -> 'actor' ->> 'id', v_inst ->> 'key');
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


revoke all on function recipe.reprocessing_start_take(uuid, text, text, text, text) from public;

reset role;
