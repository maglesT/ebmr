-- Recipe core: review acts after the slice 1 quick review (findings 4, 5 and 6; INV-48, PR-52, DI-26, DI-34, INV-30).
--
--   * Finding 4: recipe.record_audit_trail_review (from 0718) takes the high-water mark, the mark it starts from and the
--     report hash from the provider's content computed once, and refuses when that content is not the signed one
--     (EBMR-REV-013).
--   * Finding 5: a review cycle starts at its reopen (recipe.review_cycle_start). recipe.review_item_status (from 0712)
--     reads the QA acts of the current cycle only; the one-conclusion index of the register is replaced by that per-cycle
--     rule (recipe.dispose_review_items refuses an item concluded in the cycle, under the item's row lock; the unsigned
--     recipe.review_exception still refuses a second conclusion); a disposition's signed content (review_items, from
--     0712) names whether it belongs to the current cycle, and recipe.reopen_review (from 0718) supersedes the
--     dispositions of the closed cycle with the review signatures. Items are dispositioned again in the new cycle.
--   * Finding 6: on a GMP batch the unsigned recipe.review_exception (from 0713) refuses an escalation as well as an
--     acceptance (both are signed dispositions), and a query or an answer outside the QA review (EBMR-REV-065); the QA
--     review gate (recipe.review_gate_problems, from 0712) counts an escalated item as concluded only while its deviation
--     is linked to the batch; a critical item is escalated only after its detail was opened (recipe.dispose_review_items,
--     from 0718).

set local role ebmr_owner;

drop index recipe.exception_register_act_one_conclusion;

create function recipe.review_cycle_start(p_batch uuid) returns timestamptz
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce((select max(a.recorded_at) from recipe.batch_review_act a where a.batch_id = p_batch and a.act = 'REOPENED'), '-infinity'::timestamptz)
$$;

create or replace function recipe.review_item_status(p_batch uuid, p_exception text) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce((select case a.act when 'ACCEPTED_BY_QA' then 'ACCEPTED' else a.act end
                     from recipe.exception_register_act a
                    where a.batch_id = p_batch and a.exception_id = p_exception and a.act in ('QUERIED', 'RESPONDED', 'ACCEPTED_BY_QA', 'ESCALATED')
                      and a.recorded_at > recipe.review_cycle_start(p_batch)
                    order by a.id desc limit 1), 'OPEN')
$$;

create or replace function recipe.review_items_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  m     text[] := regexp_match(coalesce(p_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(ACCEPT|QUERY|ESCALATE)/([0-9a-f]{64})/([^/]+)$');
  b     recipe.batch_execution;
  v_ids text[];
  v_items jsonb;
begin
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into b from recipe.batch_execution where id = m[1]::uuid and purpose = 'GMP_BATCH';
  if b.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  v_ids := string_to_array(m[4], '+');
  select jsonb_agg(jsonb_build_object('id', r.exception_id, 'type', r.exception_type, 'severity', r.severity, 'critical', recipe.review_item_critical(r),
                                      'title', r.title, 'step', r.raising_step_key,
                                      'deviation', (select a.deviation_ref from recipe.exception_register_act a
                                                     where a.batch_id = r.batch_id and a.exception_id = r.exception_id and a.act = 'DEVIATION_LINKED'))
                   order by r.exception_id)
    into v_items
    from recipe.exception_register r where r.batch_id = b.id and r.exception_id = any (v_ids);
  if coalesce(jsonb_array_length(v_items), 0) <> cardinality(v_ids) then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object('exists', true, 'content_version', 1,
    'content', jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'disposition', m[2], 'text_sha256', m[3], 'items', v_items,
                                  'current', not exists (select 1 from recipe.review_item_disposition d
                                                          where d.aggregate_id = p_id and d.recorded_at <= recipe.review_cycle_start(b.id))),
    'state', recipe.batch_review_state(b.id), 'scope', plant.batch_scope(b.id));
end
$$;

create or replace function recipe.review_gate_problems(p_batch uuid, p_act text) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, site, pg_temp as $$
declare
  v_state text := recipe.batch_review_state(p_batch);
  v_out   text[] := '{}';
  r       recipe.exception_register;
  c       plant.output_container;
  v_st    text;
  l       recipe.batch_review_act;
begin
  perform recipe.review_batch(p_batch);
  case p_act
    when 'PRODUCTION_APPROVE' then
      if v_state is distinct from 'EXECUTION_COMPLETE' and v_state is distinct from 'ABORTED' then
        v_out := v_out || format('the record is %s; production approval follows EXECUTION_COMPLETE or ABORTED (PR-16, L-20)', coalesce(v_state, 'without a stored state'));
      end if;
      for r in select * from recipe.exception_register x where x.batch_id = p_batch order by x.exception_id loop
        if not exists (select 1 from recipe.exception_register_act a where a.batch_id = p_batch and a.exception_id = r.exception_id
                        and a.act in ('DISPOSITIONED', 'DEVIATION_LINKED')) then
          v_out := v_out || format('exception %s (%s) is neither dispositioned nor raised as a deviation (PR-52)', r.exception_id, r.title);
        end if;
      end loop;
      if v_state = 'ABORTED' then
        if not exists (select 1 from recipe.abort_checklist k where k.batch_id = p_batch) then
          v_out := v_out || 'the abort checklist is not recorded: materials, outputs, equipment, genealogy, contingency forms (L-20)'::text;
        end if;
        for c in select * from plant.output_container x where x.batch_id = p_batch order by x.label_code loop
          if plant.container_usable_problem(c.id) is null then
            v_out := v_out || format('output container %s of the aborted batch is still usable; QA holds or rejects it first (L-20)', c.label_code);
          end if;
        end loop;
      end if;
      v_out := v_out || recipe.free_text_problems(p_batch);
    when 'AUDIT_TRAIL_REVIEW' then
      if v_state is distinct from 'PRODUCTION_APPROVED' and v_state is distinct from 'QA_REVIEWED' then
        v_out := v_out || format('the record is %s; the audit-trail review follows the production approval (DI-25, S8)', coalesce(v_state, 'without a stored state'));
      elsif recipe.audit_review_covered(p_batch) then
        v_out := v_out || 'the audit trail is reviewed up to its last in-scope event; there is nothing to review (INV-48)'::text;
      end if;
    when 'QA_REVIEW' then
      if v_state is distinct from 'PRODUCTION_APPROVED' then
        v_out := v_out || format('the record is %s; QA review follows production approval and is given once per review cycle (INV-30, S8)', coalesce(v_state, 'without a stored state'));
      end if;
      for r in select * from recipe.exception_register x where x.batch_id = p_batch order by x.exception_id loop
        v_st := recipe.review_item_status(p_batch, r.exception_id);
        if v_st not in ('ACCEPTED', 'ESCALATED') then
          v_out := v_out || format('exception %s is not concluded in review (it is %s) (PR-52, DI-26)', r.exception_id, v_st);
        elsif v_st = 'ESCALATED' and site.deviation_ref_problem(
                (select a.deviation_ref from recipe.exception_register_act a where a.batch_id = p_batch and a.exception_id = r.exception_id
                    and a.act = 'ESCALATED' and a.recorded_at > recipe.review_cycle_start(p_batch) order by a.id desc limit 1), 'LINK', p_batch) is not null then
          v_out := v_out || format('exception %s is escalated to a deviation that is not linked to the batch (PR-49, PR-52)', r.exception_id);
        end if;
      end loop;
      l := recipe.audit_review_last(p_batch);
      if l.id is null then
        v_out := v_out || format('the audit-trail review of review cycle %s is not signed (DI-25)', recipe.batch_review_cycle(p_batch));
      elsif not recipe.audit_review_covered(p_batch) then
        v_out := v_out || 'audit events in scope were recorded after the review''s high-water mark; a delta review is due (INV-48)'::text;
      end if;
    when 'REOPEN' then
      if v_state is distinct from 'PRODUCTION_APPROVED' and v_state is distinct from 'QA_REVIEWED' then
        v_out := v_out || format('the record is %s; only a record in review (PRODUCTION_APPROVED or QA_REVIEWED) is reopened (L-09)', coalesce(v_state, 'without a stored state'));
      end if;
    else
      raise exception using errcode = 'P0001', message = format('EBMR-REV-001 %s is not a review act', coalesce(p_act, 'NULL'));
  end case;
  return v_out;
end
$$;

create or replace function recipe.record_audit_trail_review(p_review_id text, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
declare
  m       text[] := regexp_match(coalesce(p_review_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([1-9][0-9]{0,6})$');
  v_batch uuid;
  v_actor jsonb;
  l       recipe.batch_review_act;
  v_mark  jsonb;
  v_kind  text;
  v_id    uuid;
  v_prov  jsonb;
begin
  if m is null then
    raise exception using errcode = 'P0001', message = format('EBMR-REV-010 %s names no audit-trail review of a batch record (<batch>/<n>)', coalesce(p_review_id, 'NULL'));
  end if;
  v_batch := m[1]::uuid;
  perform iam.assert_not_administrator();
  perform recipe.review_batch(v_batch);
  v_actor := iam.require_permission('RECORD.AUDIT_TRAIL_REVIEW', plant.batch_scope(v_batch));
  perform 1 from recipe.execution_state s where s.batch_id = v_batch for update;
  perform recipe.raise_review_problems('EBMR-REV-010', 'the audit trail of the record cannot be reviewed now',
                                       recipe.review_gate_problems(v_batch, 'AUDIT_TRAIL_REVIEW'));
  if p_review_id is distinct from recipe.audit_review_next_id(v_batch) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REV-011 %s is not the next audit-trail review of the record (%s is); reload the report', p_review_id, recipe.audit_review_next_id(v_batch));
  end if;
  if (v_actor ->> 'person_id')::uuid = any (recipe.batch_involvement(v_batch)) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-REV-012 a person involved in the batch (who entered, corrected or signed in it, or approved it for production) cannot sign its audit-trail review (INV-35, outline 7.2 S10)';
  end if;
  l := recipe.audit_review_last(v_batch);
  v_kind := case when l.id is null then 'AUDIT_TRAIL_REVIEWED' else 'DELTA_AUDIT_TRAIL_REVIEWED' end;
  -- Finding 4: the mark, the report hash and the mark it starts from are taken from the very content the signature is
  -- checked against, computed once, so no event committed meanwhile can fall under a mark that was not signed.
  v_prov := esig.provide('batch_audit_review', p_review_id);
  perform recipe.assert_review_signature(p_signature, v_kind, 'batch_audit_review', p_review_id, (v_actor ->> 'person_id')::uuid);
  if esig.content_hash_of('batch_audit_review', p_review_id, v_prov) is distinct from (esig.signature_state(p_signature) ->> 'content_hash') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REV-013 audit events in scope were recorded while review %s was signed; reload the report and sign again (INV-48, DI-37)', p_review_id);
  end if;
  v_mark := v_prov -> 'content' -> 'high_water';
  v_id := recipe.insert_review_act(v_actor, v_batch, v_kind, p_signature,
                                   jsonb_build_object('review_number', m[2]::integer, 'from_mark', v_prov -> 'content' -> 'from_mark', 'high_water', v_mark,
                                                      'report_hash', v_prov -> 'content' ->> 'report_hash',
                                                      'epoch', recipe.epoch_of('BATCH', v_batch)));
  insert into recipe.audit_review_scope (chain_key, batch_id)
  select x.chain_key, v_batch from recipe.audit_review_scope_chains(v_batch) x
  on conflict do nothing;
  return v_id;
end
$$;

create or replace function recipe.reopen_review(p_batch uuid, p_signature uuid, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
declare
  v_actor jsonb;
  v_cycle integer;
  v_id    uuid;
  a       recipe.batch_review_act;
  v_agg   text;
begin
  perform iam.assert_not_administrator();
  perform recipe.review_batch(p_batch);
  v_actor := iam.require_permission('RECORD.QA_REVIEW', plant.batch_scope(p_batch));
  perform 1 from recipe.execution_state s where s.batch_id = p_batch for update;
  perform recipe.raise_review_problems('EBMR-REV-030', 'the review cannot be reopened', recipe.review_gate_problems(p_batch, 'REOPEN'));
  if p_reason is null or recipe.reason_is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-REV-030 a reopen states the person''s own reason (L-09, DI-22)';
  end if;
  v_cycle := recipe.batch_review_cycle(p_batch);
  perform recipe.assert_review_signature(p_signature, 'REVIEW_REOPENED', 'batch_review_reopen', p_batch::text || '/' || v_cycle, (v_actor ->> 'person_id')::uuid);
  v_id := recipe.insert_review_act(v_actor, p_batch, 'REOPENED', p_signature, jsonb_build_object('reason', btrim(p_reason)));
  -- L-09: the review signatures of the closed cycle no longer stand (each record's content changed with the cycle).
  perform esig.content_changed('batch_review', p_batch::text, 'recipe.batch_review_act', 'INSERT');
  for a in select * from recipe.batch_review_act x where x.batch_id = p_batch and x.cycle = v_cycle and x.review_number is not null loop
    perform esig.content_changed('batch_audit_review', p_batch::text || '/' || a.review_number, 'recipe.batch_review_act', 'INSERT');
  end loop;
  for v_agg in select distinct d.aggregate_id from recipe.review_item_disposition d where d.batch_id = p_batch order by 1 loop
    perform esig.content_changed('review_items', v_agg, 'recipe.batch_review_act', 'INSERT');
  end loop;
  return v_id;
end
$$;

create or replace function recipe.dispose_review_items(p_batch uuid, p_items text[], p_disposition text, p_justification text, p_deviation_ref text, p_signature uuid)
returns integer
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_actor  jsonb;
  v_person uuid;
  v_state  text;
  v_ids    text[];
  v_agg    text;
  v_text   text := nullif(btrim(coalesce(p_justification, '')), '');
  v_ref    text := nullif(btrim(coalesce(p_deviation_ref, '')), '');
  r        recipe.exception_register;
  v_st     text;
  v_disp   recipe.exception_register_act;
  v_refs   text[];
  v_shown  timestamptz;
  v_last   timestamptz;
  v_prob   text;
  v_act    bigint;
  st       jsonb;
begin
  perform iam.assert_not_administrator();
  perform recipe.review_batch(p_batch);
  v_actor := iam.require_permission('RECORD.QA_REVIEW', plant.batch_scope(p_batch));
  v_person := (v_actor ->> 'person_id')::uuid;
  perform 1 from recipe.execution_state s where s.batch_id = p_batch for update;
  v_state := recipe.batch_review_state(p_batch);
  -- INV-30, S8, DI-34 clause: QA dispositions items only in its review, after the production approval.
  if v_state is distinct from 'PRODUCTION_APPROVED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REV-050 the record is %s; QA dispositions register items in its review, which follows the production approval (INV-30, DI-34)', coalesce(v_state, 'unknown'));
  end if;
  if p_disposition is null or p_disposition not in ('ACCEPT', 'QUERY', 'ESCALATE') then
    raise exception using errcode = 'P0001', message = format('EBMR-REV-050 %s is not a disposition; an item is accepted, queried or escalated (outline 7.3)', coalesce(p_disposition, 'NULL'));
  end if;
  if p_items is null or cardinality(p_items) = 0 or exists (select 1 from unnest(p_items) x where x is null or x ~ '[/+]' or btrim(x) = '')
     or (select count(distinct x) from unnest(p_items) x) <> cardinality(p_items) then
    raise exception using errcode = 'P0001', message = 'EBMR-REV-050 a disposition names its register items, each once (PR-52)';
  end if;
  v_ids := array(select x from unnest(p_items) x order by x collate "C");
  if p_disposition in ('QUERY', 'ESCALATE') and cardinality(v_ids) > 1 then
    raise exception using errcode = 'P0001', message = format('EBMR-REV-051 a %s names one item; only non-critical items are accepted together (PR-52)', lower(p_disposition));
  end if;
  if p_disposition = 'QUERY' and v_text is null then
    raise exception using errcode = 'P0001', message = 'EBMR-REV-051 a query states its question (DI-26)';
  end if;
  if p_disposition = 'ESCALATE' and (v_ref is null or v_text is null) then
    raise exception using errcode = 'P0001', message = 'EBMR-REV-051 an escalation names the deviation it is escalated to and its reason (DI-26, PR-49)';
  end if;
  if p_disposition = 'ACCEPT' and cardinality(v_ids) > 1 and v_text is null then
    raise exception using errcode = 'P0001', message = 'EBMR-REV-054 items accepted together carry one justification (PR-52)';
  end if;
  v_agg := recipe.review_items_aggregate_id(p_batch, p_disposition, v_ids, v_text, v_ref);
  perform recipe.assert_review_signature(p_signature, 'REVIEW_ITEMS_DISPOSITIONED', 'review_items', v_agg, v_person);

  select max(x.recorded_at) into v_last from recipe.exception_register x where x.batch_id = p_batch;
  select max(v.shown_at) into v_shown from recipe.review_list_view v where v.batch_id = p_batch and v.person_id = v_person;
  select s.state into st from recipe.execution_state s where s.batch_id = p_batch;
  for r in select * from recipe.exception_register x where x.batch_id = p_batch and x.exception_id = any (v_ids) order by x.exception_id for update loop
    v_st := recipe.review_item_status(p_batch, r.exception_id);
    if v_st in ('ACCEPTED', 'ESCALATED') then
      raise exception using errcode = 'P0001', message = format('EBMR-REV-052 exception %s is already %s in review (DI-26)', r.exception_id, lower(v_st));
    end if;
    select * into v_disp from recipe.exception_register_act a where a.batch_id = p_batch and a.exception_id = r.exception_id and a.act = 'DISPOSITIONED';
    if p_disposition = 'QUERY' then
      if v_st = 'QUERIED' then
        raise exception using errcode = 'P0001', message = format('EBMR-REV-052 exception %s has an open query; it is answered before another is asked (DI-26)', r.exception_id);
      end if;
      continue;
    end if;
    -- ACCEPT and ESCALATE conclude the item: by a person outside its involvement (INV-03, DI-26).
    if recipe.exception_step_involvement(p_batch, st, r.exception_id, null) ? v_person::text or r.raised_by = v_person::text or v_disp.by_person = v_person then
      raise exception using errcode = 'P0001',
        message = format('EBMR-REV-053 this person raised, worked in the step of, or dispositioned exception %s, so they cannot conclude its review (INV-03, DI-26)', r.exception_id);
    end if;
    if p_disposition = 'ESCALATE' then
      if recipe.review_item_critical(r)
         and not exists (select 1 from recipe.review_item_view v where v.batch_id = p_batch and v.exception_id = r.exception_id and v.person_id = v_person) then
        raise exception using errcode = 'P0001', message = format('EBMR-REV-055 exception %s is critical; its detail is opened before it is escalated (PR-52, outline 7.3)', r.exception_id);
      end if;
      v_prob := site.deviation_ref_problem(v_ref, 'LINK', p_batch);
      if v_prob is not null then
        raise exception using errcode = 'P0001', message = format('EBMR-REV-051 exception %s cannot be escalated to %s: %s (PR-49, PR-13)', r.exception_id, v_ref, v_prob);
      end if;
      continue;
    end if;
    if v_disp.id is null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-REV-052 exception %s is not dispositioned; QA accepts an item only after its disposition, and a review never closes it (DI-26, INV-41)', r.exception_id);
    end if;
    if v_st = 'QUERIED' then
      raise exception using errcode = 'P0001', message = format('EBMR-REV-052 exception %s has an open query; it is answered before QA accepts it (DI-26)', r.exception_id);
    end if;
    if recipe.review_item_critical(r) then
      if cardinality(v_ids) > 1 then
        raise exception using errcode = 'P0001', message = format('EBMR-REV-054 exception %s is critical; a critical item is accepted on its own (PR-52, outline 7.3)', r.exception_id);
      end if;
      if v_text is null then
        raise exception using errcode = 'P0001', message = format('EBMR-REV-054 exception %s is critical; its acceptance carries a justification (PR-52)', r.exception_id);
      end if;
      if not exists (select 1 from recipe.review_item_view v where v.batch_id = p_batch and v.exception_id = r.exception_id and v.person_id = v_person) then
        raise exception using errcode = 'P0001', message = format('EBMR-REV-055 exception %s is critical; its detail is opened before it is accepted (PR-52, outline 7.3)', r.exception_id);
      end if;
    end if;
    if cardinality(v_ids) > 1 then
      if exists (select 1 from recipe.rbe_paused_step(p_batch) ps where ps = r.raising_step) then
        raise exception using errcode = 'P0001',
          message = format('EBMR-REV-056 exception %s is on step %s, whose review by exception is paused after three deviations; it is reviewed on its own (PR-07)', r.exception_id, r.raising_step);
      end if;
      v_refs := v_refs || (select a.deviation_ref from recipe.exception_register_act a where a.batch_id = p_batch and a.exception_id = r.exception_id and a.act = 'DEVIATION_LINKED');
    end if;
  end loop;
  if (select count(*) from recipe.exception_register x where x.batch_id = p_batch and x.exception_id = any (v_ids)) <> cardinality(v_ids) then
    raise exception using errcode = 'P0001', message = format('EBMR-REV-050 batch %s has no register item among %s (DI-26)', p_batch, array_to_string(v_ids, ', '));
  end if;
  if p_disposition = 'ACCEPT' and cardinality(v_ids) > 1 then
    if cardinality(v_refs) <> cardinality(v_ids) or exists (select 1 from unnest(v_refs) x where x is null) or (select count(distinct x) from unnest(v_refs) x) <> 1 then
      raise exception using errcode = 'P0001', message = 'EBMR-REV-057 items are accepted together only when they share one linked deviation (PR-52, outline 7.3)';
    end if;
    if v_shown is null or v_shown < v_last then
      raise exception using errcode = 'P0001', message = 'EBMR-REV-058 grouped acceptance follows the showing of the full list of register items to this person (PR-52, outline 7.3)';
    end if;
  end if;
  foreach v_st in array v_ids loop
    insert into recipe.exception_register_act (batch_id, exception_id, act, by_person, by_account, role_code, deviation_ref, note, correlation_id)
    values (p_batch, v_st, case p_disposition when 'ACCEPT' then 'ACCEPTED_BY_QA' when 'QUERY' then 'QUERIED' else 'ESCALATED' end,
            v_person, (v_actor ->> 'account_id')::uuid, v_actor ->> 'role_code', case when p_disposition = 'ESCALATE' then v_ref end, v_text,
            (v_actor ->> 'correlation_id')::uuid)
    returning id into v_act;
    insert into recipe.review_item_disposition (act_id, batch_id, exception_id, disposition, aggregate_id, signature_id, item_count, justification)
    values (v_act, p_batch, v_st, p_disposition, v_agg, p_signature, cardinality(v_ids), v_text);
  end loop;
  return cardinality(v_ids);
end
$$;

create or replace function recipe.review_exception(p_batch uuid, p_exception text, p_act text, p_note text, p_deviation_ref text) returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor  jsonb := recipe.execution_actor('Reviewing an exception of a test run');
  v_perms  text[];
  v_held   text[];
  v_perm   text;
  v_person uuid := (v_actor ->> 'person_id')::uuid;
  reg      recipe.exception_register;
  v_disp   recipe.exception_register_act;
  v_last   recipe.exception_register_act;
  v_query  recipe.exception_register_act;
  v_state  jsonb;
  v_id     bigint;
  v_prob   text;
begin
  select permissions into v_perms from recipe.exception_review_permission where act = p_act;
  if v_perms is null then
    raise exception using errcode = 'P0001',
      message = format('%s is not a review act; an exception is QUERIED, RESPONDED, ACCEPTED_BY_QA or ESCALATED in review (DI-26). [EBMR-EXE-164]', coalesce(p_act, 'null'));
  end if;
  v_held := iam.role_permissions_at(v_actor ->> 'role_code', clock_timestamp());
  select p into v_perm from unnest(v_perms) with ordinality as x (p, i) where p = any (v_held) order by i limit 1;
  perform iam.require_permission(coalesce(v_perm, v_perms[1]), iam.actor_location_scope());

  select * into reg from recipe.exception_register r where r.batch_id = p_batch and r.exception_id = p_exception for update;
  if not found then
    raise exception using errcode = 'P0001',
      message = format('Test batch %s has no registered exception %s (DI-26). [EBMR-EXE-164]', p_batch, coalesce(p_exception, 'null'));
  end if;
  select * into v_disp from recipe.exception_register_act a where a.batch_id = p_batch and a.exception_id = p_exception and a.act = 'DISPOSITIONED';
  select * into v_last from recipe.exception_register_act a
   where a.batch_id = p_batch and a.exception_id = p_exception and a.act in ('QUERIED', 'RESPONDED', 'ACCEPTED_BY_QA', 'ESCALATED') order by a.id desc limit 1;
  if v_last.act in ('ACCEPTED_BY_QA', 'ESCALATED') then
    raise exception using errcode = 'P0001',
      message = format('Exception %s was already %s in review; its review is concluded (DI-26). [EBMR-EXE-164]', p_exception, lower(replace(v_last.act, '_', ' ')));
  end if;
  -- Phase 4 slice 1a (PR-52, INV-30, DI-34): on a GMP batch QA accepts an item only in the QA review of the record,
  -- signed (recipe.dispose_review_items); the unsigned act stays for test runs. Queries, answers and escalations stay.
  if p_act in ('ACCEPTED_BY_QA', 'ESCALATED') and exists (select 1 from recipe.batch_execution b where b.id = p_batch and b.purpose = 'GMP_BATCH') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REV-059 on a GMP batch QA %s exception %s only in the QA review of the record, with its signed disposition (PR-52, INV-30, DI-34)',
                       case p_act when 'ESCALATED' then 'escalates' else 'accepts' end, p_exception);
  end if;
  if p_act in ('QUERIED', 'RESPONDED') and exists (select 1 from recipe.batch_execution b where b.id = p_batch and b.purpose = 'GMP_BATCH')
     and recipe.batch_review_state(p_batch) is distinct from 'PRODUCTION_APPROVED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REV-065 the record is %s; on a GMP batch a query and its answer belong to the QA review, after the production approval (INV-30, DI-26)',
                       coalesce(recipe.batch_review_state(p_batch), 'unknown'));
  end if;
  if p_act <> 'ACCEPTED_BY_QA' and (p_note is null or recipe.reason_is_blank(p_note)) then
    raise exception using errcode = 'P0001',
      message = format('A %s review act on exception %s states its text in words (DI-26, PR-49). [EBMR-EXE-164]', p_act, p_exception);
  end if;

  case p_act
    when 'QUERIED' then
      if v_last.act = 'QUERIED' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s has an open query; it is answered before another is asked (DI-26). [EBMR-EXE-164]', p_exception);
      end if;
    when 'RESPONDED' then
      if v_last.act is distinct from 'QUERIED' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s has no open query to respond to (DI-26). [EBMR-EXE-164]', p_exception);
      end if;
      if v_last.by_person = v_person then
        raise exception using errcode = 'P0001',
          message = format('%s asked the query on exception %s and cannot answer it too (INV-03, DI-26). [EBMR-EXE-165]', v_person, p_exception);
      end if;
    when 'ACCEPTED_BY_QA', 'ESCALATED' then
      if p_act = 'ACCEPTED_BY_QA' and v_disp.id is null then
        raise exception using errcode = 'P0001',
          message = format('Exception %s is still open; QA accepts an exception in review only after its disposition, and a review never closes it (DI-26, INV-41). [EBMR-EXE-164]', p_exception);
      end if;
      if p_act = 'ACCEPTED_BY_QA' and v_last.act = 'QUERIED' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s has an open query; it is answered before QA accepts the exception (DI-26). [EBMR-EXE-164]', p_exception);
      end if;
      if p_act = 'ESCALATED' and (p_deviation_ref is null or recipe.reason_is_blank(p_deviation_ref)) then
        raise exception using errcode = 'P0001',
          message = format('An escalation of exception %s names the deviation it is escalated to (DI-26, PR-49). [EBMR-EXE-164]', p_exception);
      end if;
      -- On a GMP batch the escalation names a deviation-lite record linked to it (slice 5a, D-S5-2).
      if p_act = 'ESCALATED' and exists (select 1 from recipe.batch_execution b where b.id = p_batch and b.installation = 'GMP') then
        v_prob := site.deviation_ref_problem(btrim(p_deviation_ref), 'LINK', p_batch);
        if v_prob is not null then
          raise exception using errcode = 'P0001',
            message = format('Exception %s cannot be escalated to %s: %s (PR-49, PR-13). [EBMR-EXE-604]', p_exception, btrim(p_deviation_ref), v_prob);
        end if;
      end if;
      select s.state into v_state from recipe.execution_state s where s.batch_id = p_batch;
      if recipe.exception_step_involvement(p_batch, v_state, p_exception, null) ? v_person::text or reg.raised_by = v_person::text
         or v_disp.by_person = v_person then
        raise exception using errcode = 'P0001',
          message = format('%s raised, worked in the step of, or dispositioned exception %s, so they cannot conclude its review (INV-03, DI-26). [EBMR-EXE-165]', v_person, p_exception);
      end if;
  end case;

  insert into recipe.exception_register_act (batch_id, exception_id, act, by_person, by_account, role_code, deviation_ref, note, correlation_id)
  values (p_batch, p_exception, p_act, v_person, (v_actor ->> 'account_id')::uuid, v_actor ->> 'role_code',
          case when p_act = 'ESCALATED' then btrim(p_deviation_ref) end, case when p_note is null or recipe.reason_is_blank(p_note) then null else p_note end,
          (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function recipe.review_cycle_start(uuid) from public;
grant execute on function recipe.review_cycle_start(uuid) to ebmr_app;

reset role;
