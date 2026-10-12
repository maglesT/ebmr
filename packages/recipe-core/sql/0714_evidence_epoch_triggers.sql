-- Recipe core: the triggers that bump the evidence epochs (Phase 4 slice 1a; the interface of 0710; plan "Interfaces fixed
-- up front"). An act that evaluated evidence (the QA review now; G-REL and the dispositions in slices 3 and 4) names the
-- epoch it saw and is refused when it moved (write after evaluation).
--
--   BATCH       an exception raised in the record (recipe.exception_register), a deviation link or a disposition of one
--               (recipe.exception_register_act: DEVIATION_LINKED, DISPOSITIONED; QA's own review acts are the review, not
--               evidence), an accepted correction, invalidation or void row (recipe.execution_command), a deviation-lite
--               link naming the batch, and an audit event on a chain a signed audit-trail review of the record covered
--               (recipe.audit_review_scope, written with each review);
--   LOT         a lot state change (site.lot_state_entry), a LIMS result or its approval (site.lot_test_result,
--               site.lot_test_approval), a deviation-lite link naming the lot;
--   CONTAINER   a deviation-lite link naming the output container;
--   DEVIATION   a link, a life-cycle event, a finding or a conclusion of the record (and each BATCH it is linked to).

set local role ebmr_owner;

create table recipe.audit_review_scope (
  chain_key  text not null,
  batch_id   uuid not null references recipe.batch_execution (id),
  primary key (chain_key, batch_id)
);
revoke all on recipe.audit_review_scope from public;
comment on table recipe.audit_review_scope is 'Chains a signed audit-trail review of a batch record covered: an event on one bumps the batch''s evidence epoch';

-- Written with every audit-trail review (as 0712's recipe.record_audit_trail_review, with the scope kept).
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
  v_actor := recipe.review_actor(v_batch, 'RECORD.AUDIT_TRAIL_REVIEW');
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

create function recipe.epoch_on_exception() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if tg_table_name = 'exception_register_act' then
    if to_jsonb(new) ->> 'act' not in ('DEVIATION_LINKED', 'DISPOSITIONED') then
      return null;
    end if;
  end if;
  perform recipe.bump_epoch('BATCH', new.batch_id);
  return null;
end
$$;

create function recipe.epoch_on_command() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if new.accepted and new.kind = 'COMMAND' and new.command_type in ('CORRECT_ENTRY', 'INVALIDATE_RESULT', 'VOID_ATTEMPT') then
    perform recipe.bump_epoch('BATCH', new.batch_id);
  end if;
  return null;
end
$$;

create function recipe.epoch_on_deviation_link() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  perform recipe.bump_epoch(new.subject_kind, new.subject_id);
  if new.batch_id is not null and (new.subject_kind <> 'BATCH' or new.batch_id <> new.subject_id) then
    perform recipe.bump_epoch('BATCH', new.batch_id);
  end if;
  perform recipe.bump_epoch('DEVIATION', new.deviation_id);
  return null;
end
$$;

-- A deviation's life cycle: the record and every batch it is linked to.
create function recipe.epoch_on_deviation_change() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_id uuid := new.deviation_id;
  b    uuid;
begin
  perform recipe.bump_epoch('DEVIATION', v_id);
  for b in select distinct coalesce(l.batch_id, case when l.subject_kind = 'BATCH' then l.subject_id end) from site.deviation_link l
            where l.deviation_id = v_id and (l.batch_id is not null or l.subject_kind = 'BATCH') loop
    perform recipe.bump_epoch('BATCH', b);
  end loop;
  return null;
end
$$;

create function recipe.epoch_on_lot() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
begin
  if tg_table_name = 'lot_test_approval' then
    perform recipe.bump_epoch('LOT', (select r.lot_id from site.lot_test_result r where r.id = (to_jsonb(new) ->> 'result_id')::uuid));
  else
    perform recipe.bump_epoch('LOT', (to_jsonb(new) ->> 'lot_id')::uuid);
  end if;
  return null;
end
$$;

-- An audit event on a chain a signed audit-trail review covered (QA's own review acts excepted).
create function recipe.epoch_on_audit_event() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  b uuid;
begin
  if new.table_name = 'recipe.exception_register_act'
     and exists (select 1 from recipe.exception_register_act a where a.id::text = new.record_id and a.act in ('QUERIED', 'RESPONDED', 'ACCEPTED_BY_QA', 'ESCALATED')) then
    return null;
  end if;
  for b in select s.batch_id from recipe.audit_review_scope s where s.chain_key = new.chain_key loop
    perform recipe.bump_epoch('BATCH', b);
  end loop;
  return null;
end
$$;

create trigger zzze_epoch_exception after insert on recipe.exception_register for each row execute function recipe.epoch_on_exception();
create trigger zzze_epoch_exception_act after insert on recipe.exception_register_act for each row execute function recipe.epoch_on_exception();
create trigger zzze_epoch_command after insert on recipe.execution_command
  for each row when (new.accepted and new.command_type in ('CORRECT_ENTRY', 'INVALIDATE_RESULT', 'VOID_ATTEMPT')) execute function recipe.epoch_on_command();
create trigger zzze_epoch_deviation_link after insert on site.deviation_link for each row execute function recipe.epoch_on_deviation_link();
create trigger zzze_epoch_deviation_event after insert on site.deviation_event for each row execute function recipe.epoch_on_deviation_change();
create trigger zzze_epoch_deviation_finding after insert on site.deviation_finding for each row execute function recipe.epoch_on_deviation_change();
create trigger zzze_epoch_deviation_conclusion after insert on site.deviation_conclusion for each row execute function recipe.epoch_on_deviation_change();
create trigger zzze_epoch_lot_state after insert on site.lot_state_entry for each row execute function recipe.epoch_on_lot();
create trigger zzze_epoch_lot_result after insert on site.lot_test_result for each row execute function recipe.epoch_on_lot();
create trigger zzze_epoch_lot_approval after insert on site.lot_test_approval for each row execute function recipe.epoch_on_lot();
create trigger zzze_epoch_audit_event after insert on kernel.audit_event for each row execute function recipe.epoch_on_audit_event();

revoke all on function recipe.epoch_on_exception(), recipe.epoch_on_command(), recipe.epoch_on_deviation_link(), recipe.epoch_on_deviation_change(),
                       recipe.epoch_on_lot(), recipe.epoch_on_audit_event() from public;
revoke all on recipe.audit_review_scope from ebmr_app;
grant select on recipe.audit_review_scope to ebmr_app;

reset role;
