-- Electronic signatures (B2), part 6: a stub signable table with its canonical-content provider.
-- It stands in for the records later phases sign (steps, logbook entries, master documents) and is
-- the reference for how a module plugs into the signing module:
--   1. register the aggregate's content provider (esig.register_content_provider);
--   2. register every table holding signed content (esig.register_signed_table), so a permitted
--      change supersedes the affected signatures in the same transaction (INV-09);
--   3. complete a signature point only with a valid signature of the required meaning
--      (esig.assert_signature); there is no acknowledgement path (DI-35).

set local role ebmr_owner;

create table esig.stub_signable (
  id                      uuid primary key default gen_random_uuid(),
  kind                    text not null check (kind in ('STEP', 'CLEANING_LOG', 'MASTER_DOCUMENT')),
  title                   text not null check (btrim(title) <> ''),
  value                   text not null,
  unit                    text,
  site                    text,
  area                    text,
  product                 text,
  state                   text not null default 'OPEN' check (state in ('OPEN', 'COMPLETED')),
  content_version         bigint not null default 1 check (content_version >= 1),
  entered_device_id       uuid,
  entered_at              timestamptz,
  completed_by_signature  uuid,
  recorded_at             timestamptz not null default clock_timestamp()
);

-- Content version, entry terminal and time are kept by the database. A content change after
-- completion reopens the entry (the completion signature is superseded by the change). The state
-- changes only through esig.stub_complete.
create function esig.stub_signable_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, esig, kernel, pg_temp as $$
declare
  v_device     uuid := nullif(kernel.current_actor() ->> 'device_id', '')::uuid;
  v_completing boolean;
begin
  if tg_op = 'INSERT' then
    new.state := 'OPEN';
    new.content_version := 1;
    new.entered_at := clock_timestamp();
    new.entered_device_id := v_device;
    new.completed_by_signature := null;
    new.recorded_at := clock_timestamp();
    return new;
  end if;
  if new.id <> old.id or new.kind <> old.kind or new.recorded_at <> old.recorded_at then
    raise exception using errcode = 'P0001', message = 'EBMR-ESIG-090 the identity, kind and creation time of an entry never change';
  end if;
  v_completing := coalesce(current_setting('esig.stub_completing', true), '') = old.id::text;
  if (new.title, new.value, new.unit, new.site, new.area, new.product) is distinct from
     (old.title, old.value, old.unit, old.site, old.area, old.product) then
    if v_completing then
      raise exception using errcode = 'P0001', message = 'EBMR-ESIG-090 completion does not change content';
    end if;
    new.content_version := old.content_version + 1;
    new.entered_at := clock_timestamp();
    new.entered_device_id := v_device;
    new.state := 'OPEN';
    new.completed_by_signature := null;
  else
    new.content_version := old.content_version;
    new.entered_at := old.entered_at;
    new.entered_device_id := old.entered_device_id;
    if (new.state, new.completed_by_signature) is distinct from (old.state, old.completed_by_signature) and not v_completing then
      raise exception using errcode = 'P0001',
        message = 'EBMR-ESIG-090 an entry is completed only through esig.stub_complete with a signature, never by an acknowledgement';
    end if;
  end if;
  return new;
end
$$;
create trigger aa_stub_signable_guard before insert or update on esig.stub_signable for each row execute function esig.stub_signable_guard();
create trigger aa_stub_signable_no_delete before delete on esig.stub_signable for each row execute function esig.forbid_change();

-- Canonical-content provider for aggregate type esig_stub.
create function esig.stub_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
declare
  r    esig.stub_signable%rowtype;
  v_id uuid;
begin
  begin
    v_id := p_id::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('exists', false);
  end;
  select * into r from esig.stub_signable where id = v_id;
  if not found then
    return jsonb_build_object('exists', false);
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', r.content_version,
    'content', jsonb_build_object('kind', r.kind, 'title', r.title, 'value', r.value, 'unit', r.unit,
                                  'site', r.site, 'area', r.area, 'product', r.product),
    'state', r.state,
    'scope', jsonb_strip_nulls(jsonb_build_object('site', r.site, 'area', r.area, 'product', r.product)),
    'act', jsonb_build_object('device_id', r.entered_device_id, 'at', r.entered_at));
end
$$;

-- Completing a signature point: only a valid signature of a required meaning, on this entry, with
-- the performer's signature present too. There is no other way to complete an entry.
create function esig.stub_complete(p_id uuid, p_signature_id uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, esig, iam, kernel, pg_temp as $$
declare
  v_actor    jsonb := iam.assert_validated_actor();
  r          esig.stub_signable%rowtype;
  v_required text[];
  v_prereq   text;
  v_state    jsonb;
begin
  perform iam.assert_not_administrator();
  select * into r from esig.stub_signable where id = p_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-091 entry %s does not exist', p_id);
  end if;
  if r.state <> 'OPEN' then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-091 entry %s is already completed', p_id);
  end if;
  v_required := case r.kind when 'STEP' then array['VERIFIED', 'WITNESSED'] when 'CLEANING_LOG' then array['LOGBOOK_DOUBLE_CHECKED']
                            else array['APPROVED'] end;
  v_prereq := case r.kind when 'STEP' then 'PERFORMED' when 'CLEANING_LOG' then 'LOGBOOK_PERFORMED' else 'CHECKED' end;
  v_state := esig.signature_state(p_signature_id);
  if p_signature_id is null or not coalesce((v_state ->> 'exists')::boolean, false) or not (v_state ->> 'meaning_code' = any (v_required)) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-092 completing a %s entry needs a %s signature; an acknowledgement or any other token cannot complete a signature point',
                       r.kind, array_to_string(v_required, ' or '));
  end if;
  perform esig.assert_signature(p_signature_id, v_state ->> 'meaning_code', 'esig_stub', p_id::text);
  if not exists (select 1 from esig.signature g where g.aggregate_ref = 'esig_stub:' || p_id and g.meaning_code = v_prereq
                   and (esig.signature_state(g.id) ->> 'valid')::boolean) then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-093 entry %s has no valid %s signature', p_id, v_prereq);
  end if;
  perform set_config('esig.stub_completing', p_id::text, true);
  if coalesce(v_actor ->> 'reason_code', '') = '' then
    perform kernel.set_actor_context(v_actor || jsonb_build_object('reason_code', 'SIGNED_COMPLETION',
                                                                   'reason_text', 'entry completed by its required signature'));
  end if;
  update esig.stub_signable set state = 'COMPLETED', completed_by_signature = p_signature_id where id = p_id;
  perform kernel.set_actor_context(v_actor);
  perform set_config('esig.stub_completing', '', true);
end
$$;

select kernel.register_audited_table('esig.stub_signable', 'esig_stub', 'id', false);
select esig.register_content_provider('esig_stub', 'esig.stub_content(text)',
  'Stub signable entries (step, cleaning-log entry, master document): the reference provider for tests');
select esig.register_signed_table('esig.stub_signable', 'esig_stub', 'id', array['kind', 'title', 'value', 'unit', 'site', 'area', 'product']);

grant select on esig.stub_signable to ebmr_app;
grant insert (kind, title, value, unit, site, area, product), update (title, value, unit, site, area, product) on esig.stub_signable to ebmr_app;
grant execute on function esig.stub_complete(uuid, uuid) to ebmr_app;

reset role;
