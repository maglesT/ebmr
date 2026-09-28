-- Platform services, part 7: a sample record that follows a state machine, to prove the engine
-- end to end (machine sample_record, published by the generated migration 0552). It stands in
-- for the controlled records later phases build (MBR versions, policies, rule tables): content
-- may be edited only in DRAFT, and submitting needs a non-empty body.

set local role ebmr_owner;

create table platform.stub_record (
  id               uuid primary key default gen_random_uuid(),
  title            text not null check (title <> ''),
  body             text not null default '',
  -- Version of the signed content (title and body): 1 on insert, +1 by the trigger below on every
  -- update that changes title or body, unchanged by a save that changes nothing. The e-signature
  -- content provider (kernel 0910) reports it, so the hash a signature is bound to changes exactly
  -- when signed content changes (INV-09), and is final before any AFTER trigger hashes it (DI-37).
  content_version  bigint not null default 1 check (content_version >= 1),
  created_at       timestamptz not null default clock_timestamp()
);

-- Content changes only while the record is in DRAFT (or before it has a state). The state row is
-- read FOR SHARE (the locking rule of 0550): an edit and a transition of the same record serialise,
-- so an edit never slips in after a SUBMIT it did not see, and the SUBMIT guards see the edit.
create function platform.stub_record_edit_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  v_state text;
begin
  select state into v_state from platform.aggregate_state where aggregate_type = 'sample_record' and aggregate_id = old.id for share;
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

create function platform.stub_record_content_version() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.content_version := 1;
  elsif new.title is distinct from old.title or new.body is distinct from old.body then
    new.content_version := old.content_version + 1;
  else
    new.content_version := old.content_version;
  end if;
  return new;
end
$$;
create trigger a2_content_version before insert or update on platform.stub_record
  for each row execute function platform.stub_record_content_version();

create function platform.guard_sample_record_has_body(p_aggregate_type text, p_aggregate_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb)
returns text
language sql stable set search_path = pg_catalog, platform, pg_temp as $$
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
