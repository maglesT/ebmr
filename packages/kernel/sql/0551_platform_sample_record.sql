-- Platform services, part 7: a sample record that follows a state machine, to prove the engine
-- end to end (machine sample_record, published by the generated migration 0552). It stands in
-- for the controlled records later phases build (MBR versions, policies, rule tables): content
-- may be edited only in DRAFT, and submitting needs a non-empty body.

set local role ebmr_owner;

create table platform.stub_record (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (title <> ''),
  body        text not null default '',
  created_at  timestamptz not null default clock_timestamp()
);

-- Content changes only while the record is in DRAFT (or before it has a state).
create function platform.stub_record_edit_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform as $$
declare
  v_state text;
begin
  select state into v_state from platform.aggregate_state where aggregate_type = 'sample_record' and aggregate_id = old.id;
  if v_state is not null and v_state <> 'DRAFT' then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-074 sample record %s is %s; content can change only in DRAFT', old.id, v_state);
  end if;
  return new;
end
$$;
create trigger a1_edit_guard before update on platform.stub_record
  for each row execute function platform.stub_record_edit_guard();
create trigger aa_no_delete before delete or truncate on platform.stub_record
  for each statement execute function platform.reject_change();

create function platform.guard_sample_record_has_body(p_aggregate_type text, p_aggregate_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb)
returns text
language sql stable set search_path = pg_catalog, platform as $$
  select case
    when r.id is null then 'the sample record does not exist'
    when trim(r.body) = '' then 'the record body is empty'
  end
  from (select 1) dummy left join platform.stub_record r on r.id = p_aggregate_id
$$;
select platform.register_guard('sample_record.has_body', 'platform.guard_sample_record_has_body(text, uuid, jsonb, jsonb, jsonb)',
                               'The sample record exists and its body is not empty');

select platform.enforce_db_time('platform.stub_record', array['created_at']);
select kernel.register_audited_table('platform.stub_record', 'sample_record', 'id', false);

grant select on platform.stub_record to ebmr_app;
grant insert (id, title, body), update (title, body) on platform.stub_record to ebmr_app;

reset role;
