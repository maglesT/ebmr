-- Recipe core: review act gates written out, and the evidence epochs insert-only and audited (Phase 4 slice 1a; DI-17,
-- DI-18, ADR 0012; recipe-core 0710, 0712, 0714).
--
--   * The review acts of 0712 and 0714 reached the kernel's administrator refusal and permission check through a helper
--     (recipe.review_actor); every app-callable recipe writer states them itself, first the refusal of administrators,
--     then the permission (the authority test reads them from each function). Each act is replaced from its latest
--     definition with the helper's calls written out; nothing else changes.
--   * recipe.evidence_epoch (0710) was a counter updated in place and not audited. It becomes insert-only and audited: one
--     row per version of a subject, written by recipe.bump_epoch under a transaction lock per subject
--     (recipe.lock_epoch); recipe.epoch_of reads the highest version (0 when none). The interface is unchanged:
--     (subject_kind, subject_id, version), bump_epoch(kind, id) and epoch_of(kind, id). The QA review takes the same lock
--     before it reads the epoch, so a bump is either seen or waits (write after evaluation).
--   * recipe.audit_review_scope (0714) is audited and insert-only too.

set local role ebmr_owner;

drop table recipe.evidence_epoch;
create table recipe.evidence_epoch (
  subject_kind  text not null check (subject_kind in ('BATCH', 'LOT', 'CONTAINER', 'DEVIATION')),
  subject_id    uuid not null,
  version       bigint not null check (version >= 1),
  bumped_at     timestamptz not null default clock_timestamp(),
  primary key (subject_kind, subject_id, version)
);
revoke all on recipe.evidence_epoch from public;
comment on table recipe.evidence_epoch is 'Evidence version tokens (Phase 4 slice 1): one insert-only row per version of a subject, written by triggers on the evidence an act evaluates';
select platform.enforce_db_time('recipe.evidence_epoch', array['bumped_at']);
select kernel.register_audited_table('recipe.evidence_epoch', 'evidence_epoch', 'subject_id', true);
select kernel.register_audited_table('recipe.audit_review_scope', 'batch_review', 'batch_id', true);

create function recipe.lock_epoch(p_kind text, p_id uuid) returns void
language sql volatile security definer set search_path = pg_catalog, pg_temp as $$
  select pg_advisory_xact_lock(hashtextextended('recipe.evidence_epoch:' || coalesce(p_kind, '') || ':' || coalesce(p_id::text, ''), 0))
$$;

create or replace function recipe.bump_epoch(p_kind text, p_id uuid) returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v bigint;
begin
  if p_id is null then
    return null;
  end if;
  perform recipe.lock_epoch(p_kind, p_id);
  v := recipe.epoch_of(p_kind, p_id) + 1;
  insert into recipe.evidence_epoch (subject_kind, subject_id, version) values (p_kind, p_id, v);
  return v;
end
$$;

create or replace function recipe.epoch_of(p_kind text, p_id uuid) returns bigint
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce((select max(e.version) from recipe.evidence_epoch e where e.subject_kind = p_kind and e.subject_id = p_id), 0)
$$;

create or replace function recipe.record_production_approval(p_batch uuid, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_actor   jsonb;
  v_meaning text;
  v_sig     jsonb;
begin
  perform iam.assert_not_administrator();
  perform recipe.review_batch(p_batch);
  v_actor := iam.require_permission('RECORD.PRODUCTION_APPROVE', plant.batch_scope(p_batch));
  perform 1 from recipe.execution_state s where s.batch_id = p_batch for update;
  perform recipe.raise_review_problems('EBMR-REV-002', 'the record cannot be approved by production',
                                       recipe.review_gate_problems(p_batch, 'PRODUCTION_APPROVE'));
  v_meaning := case when recipe.batch_record_kind(p_batch) = 'PACKAGING' then 'PACKAGING_RECORD_APPROVED' else 'PRODUCTION_APPROVED' end;
  v_sig := recipe.assert_review_signature(p_signature, v_meaning, 'batch_review', p_batch::text, (v_actor ->> 'person_id')::uuid);
  return recipe.insert_review_act(v_actor, p_batch, v_meaning, p_signature,
                                  jsonb_build_object('reviewed_content_hash', v_sig ->> 'content_hash', 'epoch', recipe.epoch_of('BATCH', p_batch)));
end
$$;

create or replace function recipe.record_audit_trail_review(p_review_id text, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  m       text[] := regexp_match(coalesce(p_review_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([1-9][0-9]{0,6})$');
  v_batch uuid;
  v_actor jsonb;
  l       recipe.batch_review_act;
  v_mark  jsonb;
  v_kind  text;
  v_id    uuid;
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
  perform recipe.assert_review_signature(p_signature, v_kind, 'batch_audit_review', p_review_id, (v_actor ->> 'person_id')::uuid);
  v_mark := recipe.audit_review_mark(v_batch);
  v_id := recipe.insert_review_act(v_actor, v_batch, v_kind, p_signature,
                                   jsonb_build_object('review_number', m[2]::integer, 'from_mark', l.high_water, 'high_water', v_mark,
                                                      'report_hash', recipe.audit_review_report_hash(v_batch, l.high_water),
                                                      'epoch', recipe.epoch_of('BATCH', v_batch)));
  insert into recipe.audit_review_scope (chain_key, batch_id)
  select x.chain_key, v_batch from recipe.audit_review_scope_chains(v_batch) x
  on conflict do nothing;
  return v_id;
end
$$;

create or replace function recipe.record_qa_review(p_batch uuid, p_signature uuid, p_expected_epoch bigint) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_actor jsonb;
  v_epoch bigint;
  v_sig   jsonb;
  v_items text;
begin
  perform iam.assert_not_administrator();
  perform recipe.review_batch(p_batch);
  v_actor := iam.require_permission('RECORD.QA_REVIEW', plant.batch_scope(p_batch));
  perform 1 from recipe.execution_state s where s.batch_id = p_batch for update;
  perform recipe.lock_epoch('BATCH', p_batch);
  perform recipe.raise_review_problems('EBMR-REV-020', 'the record cannot be QA reviewed', recipe.review_gate_problems(p_batch, 'QA_REVIEW'));
  v_epoch := recipe.epoch_of('BATCH', p_batch);
  if p_expected_epoch is null or p_expected_epoch <> v_epoch then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REV-021 the evidence of the record changed after it was evaluated (epoch %s, now %s); review it again (DI-37)',
                       coalesce(p_expected_epoch::text, 'none given'), v_epoch);
  end if;
  v_sig := recipe.assert_review_signature(p_signature, 'QA_REVIEWED', 'batch_review', p_batch::text, (v_actor ->> 'person_id')::uuid);
  select string_agg(a.exception_id || '#' || a.act || '#' || a.id, E'\n' order by a.exception_id, a.id) into v_items
    from recipe.exception_register_act a where a.batch_id = p_batch and a.act in ('QUERIED', 'RESPONDED', 'ACCEPTED_BY_QA', 'ESCALATED');
  return recipe.insert_review_act(v_actor, p_batch, 'QA_REVIEWED', p_signature,
    jsonb_build_object('reviewed_content_hash', encode(sha256(convert_to((v_sig ->> 'content_hash') || E'\n' || coalesce(v_items, ''), 'UTF8')), 'hex'),
                       'epoch', v_epoch));
end
$$;

create or replace function recipe.reopen_review(p_batch uuid, p_signature uuid, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
declare
  v_actor jsonb;
  v_cycle integer;
  v_id    uuid;
  a       recipe.batch_review_act;
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
  return v_id;
end
$$;

create or replace function recipe.show_review_register(p_batch uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_actor jsonb;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  perform recipe.review_batch(p_batch);
  v_actor := iam.require_permission('RECORD.READ', plant.batch_scope(p_batch));
  insert into recipe.review_list_view (batch_id, item_count, person_id, account_id)
  values (p_batch, (select count(*) from recipe.exception_register r where r.batch_id = p_batch), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create or replace function recipe.open_review_item(p_batch uuid, p_exception text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_actor jsonb;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  perform recipe.review_batch(p_batch);
  v_actor := iam.require_permission('RECORD.READ', plant.batch_scope(p_batch));
  if not exists (select 1 from recipe.exception_register r where r.batch_id = p_batch and r.exception_id = p_exception) then
    raise exception using errcode = 'P0001', message = format('EBMR-REV-050 batch %s has no register item %s (DI-26)', p_batch, coalesce(p_exception, 'NULL'));
  end if;
  insert into recipe.review_item_view (batch_id, exception_id, person_id, account_id)
  values (p_batch, p_exception, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
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

create or replace function recipe.record_abort_checklist(p_batch uuid, p_checklist jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_actor jsonb;
  k       text;
begin
  perform iam.assert_not_administrator();
  perform recipe.review_batch(p_batch);
  v_actor := iam.require_permission('RECORD.PRODUCTION_APPROVE', plant.batch_scope(p_batch));
  perform 1 from recipe.execution_state s where s.batch_id = p_batch for update;
  if recipe.batch_review_state(p_batch) is distinct from 'ABORTED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REV-060 the record is %s; the abort checklist belongs to an ABORTED record before its production approval (L-20)', recipe.batch_review_state(p_batch));
  end if;
  foreach k in array array['materialsAccounted', 'outputsDispositioned', 'equipmentDirty', 'genealogyClosed', 'contingencyReconciled'] loop
    if jsonb_typeof(p_checklist -> k) is distinct from 'string' or recipe.reason_is_blank(p_checklist ->> k) then
      raise exception using errcode = 'P0001', message = format('EBMR-REV-060 the abort checklist states %s in words (L-20)', k);
    end if;
  end loop;
  insert into recipe.abort_checklist (batch_id, materials_accounted, outputs_dispositioned, equipment_dirty, genealogy_closed, contingency_reconciled,
                                      person_id, account_id, role_code)
  values (p_batch, btrim(p_checklist ->> 'materialsAccounted'), btrim(p_checklist ->> 'outputsDispositioned'), btrim(p_checklist ->> 'equipmentDirty'),
          btrim(p_checklist ->> 'genealogyClosed'), btrim(p_checklist ->> 'contingencyReconciled'),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_actor ->> 'role_code');
exception when unique_violation then
  raise exception using errcode = 'P0001', message = 'EBMR-REV-060 the abort checklist of this record is recorded already (L-20)';
end
$$;

create or replace function recipe.record_translation(p_batch uuid, p_source_ref text, p_english text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_actor jsonb;
  v_body  text;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  perform recipe.review_batch(p_batch);
  v_actor := iam.require_permission('RECORD.READ', plant.batch_scope(p_batch));
  perform 1 from recipe.execution_state s where s.batch_id = p_batch for update;
  perform recipe.assert_translation_open(p_batch);
  select f.body into v_body from recipe.batch_free_text(p_batch) f where f.source_ref = p_source_ref;
  if v_body is null then
    raise exception using errcode = 'P0001', message = format('EBMR-REV-062 the record holds no free text %s (D-P4-12)', coalesce(p_source_ref, 'NULL'));
  end if;
  if p_english is null or recipe.reason_is_blank(p_english) or recipe.text_needs_translation(p_english) then
    raise exception using errcode = 'P0001', message = 'EBMR-REV-062 a translation is English text in Latin script (D-P4-12)';
  end if;
  insert into recipe.free_text_translation (batch_id, source_ref, source_sha256, english, translated_by, translated_account)
  values (p_batch, p_source_ref, encode(sha256(convert_to(v_body, 'UTF8')), 'hex'), btrim(p_english), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create or replace function recipe.verify_translation(p_translation uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  t       recipe.free_text_translation;
  v_actor jsonb;
  v_latest uuid;
begin
  select * into t from recipe.free_text_translation where id = p_translation;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-REV-063 there is no translation %s (D-P4-12)', coalesce(p_translation::text, 'NULL'));
  end if;
  perform iam.assert_not_administrator();
  perform recipe.review_batch(t.batch_id);
  v_actor := iam.require_permission('RECORD.READ', plant.batch_scope(t.batch_id));
  perform 1 from recipe.execution_state s where s.batch_id = t.batch_id for update;
  perform recipe.assert_translation_open(t.batch_id);
  select x.id into v_latest from recipe.latest_translation(t.batch_id, t.source_ref) x;
  if v_latest is distinct from t.id then
    raise exception using errcode = 'P0001', message = 'EBMR-REV-063 a newer translation of this text exists; verify that one (D-P4-12)';
  end if;
  if t.translated_by = (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-REV-064 a translation is verified by a second person, not by its translator (D-P4-12, outline 7.4)';
  end if;
  insert into recipe.free_text_translation_verification (translation_id, verified_by, verified_account)
  values (t.id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  return t.id;
exception when unique_violation then
  raise exception using errcode = 'P0001', message = 'EBMR-REV-063 this translation is verified already (D-P4-12)';
end
$$;

revoke all on recipe.evidence_epoch from ebmr_app;
grant select on recipe.evidence_epoch to ebmr_app;
revoke all on function recipe.lock_epoch(text, uuid) from public;

reset role;
