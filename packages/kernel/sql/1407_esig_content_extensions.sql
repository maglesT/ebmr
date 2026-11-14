-- E-signature content extensions (injectables review pass, I-6, item 2; lead's option (a), 14 November 2026): a module
-- adds lines to the signed content of a kernel aggregate without replacing the kernel's content provider and without the
-- kernel reading the module's table (ADR-0018: the kernel stays free of process logic and works on its own).
--
-- Handbook: modules/kernel.md
--
-- Why. Tablets 1910 replaced platform.change_record_content (kernel 1195) with a copy that reads plant.aps_required_line,
-- so a kernel function read a module's table and a later kernel change to 1195's content would be lost under the copy.
-- Re-registering the aggregate's provider to a module function instead would change an earlier row of the provider
-- catalogue, which the upgrade drill (DI-48) refuses. So the provider stays the kernel's and calls the extensions a
-- module registers for its aggregate type.
--
-- The catalogue table is in schema platform, not esig: the upgrade drill holds every esig table of the earlier release
-- to MATCH or ADDED_ONLY and has no place for a new esig table; its functions are esig's.
--
--   platform.content_extension
--                             the catalogue of extensions: aggregate type (one with a registered provider), extension
--                             key, function (aggregate_id text) returns jsonb, STABLE or IMMUTABLE, description. Owner
--                             only, insert-only (update, delete and truncate refused, EBMR-ESIG-001): an extension is
--                             never changed, replaced or removed, so the provider catalogue and the content of every
--                             signature already given stay as they were. Every insert is checked by a trigger, whoever
--                             writes it (EBMR-ESIG-094).
--   esig.register_content_extension(type, key, function, description)
--                             the migrations' way to add one (owner only); a key or function already registered for the
--                             type is refused, never replaced (EBMR-ESIG-094).
--   esig.extend_content(type, id, content)
--                             what a provider calls on its content object: each registered extension's output for the
--                             record, in extension-key order (code-unit order), merged into the content. An extension
--                             returns an object of keys to add; NULL or {} adds nothing. A key the content already has
--                             (the kernel's or an earlier extension's) is refused, never overwritten, and so is a result
--                             that is not an object (EBMR-ESIG-095). The content, and its hash, is therefore the same on
--                             every call for the same data.
--   platform.change_record_content(id)
--                             CREATE OR REPLACE of kernel 1195: the same body, its content object passed through
--                             esig.extend_content('config_change_record', ...). With no extension registered, or none
--                             with lines for the record, the output is 1195's exactly. Its provider row is unchanged.

set local role ebmr_owner;

create table platform.content_extension (
  aggregate_type  text not null references esig.content_provider (aggregate_type),
  extension_key   text not null check (extension_key ~ '^[a-z][a-z0-9_]*$'),
  function_oid    regprocedure not null,
  description     text not null check (btrim(description) <> ''),
  registered_at   timestamptz not null default clock_timestamp(),
  primary key (aggregate_type, extension_key),
  unique (aggregate_type, function_oid)
);
select esig.protect_log('platform.content_extension');

-- Whoever writes the row (the owner, directly or through the register function): the function has the extension
-- signature and does not change data, the aggregate's provider merges extensions, and the key and function are new.
create function esig.content_extension_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, esig, pg_temp as $$
declare
  v_provider regprocedure;
begin
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = new.function_oid and pg_catalog.oidvectortypes(p.proargtypes) = 'text'
                   and p.prorettype = 'jsonb'::regtype and p.provolatile in ('s', 'i')) then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ESIG-094 %s must have the extension signature (aggregate_id text) returns jsonb and be STABLE or IMMUTABLE', new.function_oid);
  end if;
  select c.function_oid into v_provider from esig.content_provider c where c.aggregate_type = new.aggregate_type;
  if v_provider is null or not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_provider
                                         and strpos(p.prosrc, 'esig.extend_content(' || quote_literal(new.aggregate_type)) > 0) then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ESIG-094 the content provider of %s does not merge content extensions', new.aggregate_type);
  end if;
  if exists (select 1 from platform.content_extension x where x.aggregate_type = new.aggregate_type
               and (x.extension_key = new.extension_key or x.function_oid = new.function_oid)) then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ESIG-094 content extension %s or %s is already registered for %s; an extension is never changed or replaced',
      new.extension_key, new.function_oid, new.aggregate_type);
  end if;
  return new;
end
$$;
create trigger content_extension_guard before insert on platform.content_extension
  for each row execute function esig.content_extension_guard();

create function esig.register_content_extension(p_aggregate_type text, p_extension_key text, p_function regprocedure, p_description text)
returns void
language plpgsql volatile security definer set search_path = pg_catalog, esig, pg_temp as $$
begin
  insert into platform.content_extension (aggregate_type, extension_key, function_oid, description)
  values (p_aggregate_type, p_extension_key, p_function, p_description);
end
$$;

-- The content object of one record with every registered extension's keys merged in, in extension-key order.
create function esig.extend_content(p_aggregate_type text, p_aggregate_id text, p_content jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
declare
  v_out jsonb := p_content;
  e     record;
  v_ext jsonb;
begin
  for e in select x.extension_key, quote_ident(n.nspname) || '.' || quote_ident(p.proname) as fn
             from platform.content_extension x
             left join pg_catalog.pg_proc p on p.oid = x.function_oid
             left join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where x.aggregate_type = p_aggregate_type
            order by x.extension_key collate "C" loop
    if e.fn is null then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-ESIG-095 the function of content extension %s of %s no longer exists', e.extension_key, p_aggregate_type);
    end if;
    execute format('select %s($1)', e.fn) into v_ext using p_aggregate_id;
    continue when v_ext is null;
    if jsonb_typeof(v_ext) <> 'object' then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-ESIG-095 content extension %s of %s must return an object of keys to add', e.extension_key, p_aggregate_type);
    end if;
    if exists (select 1 from pg_catalog.jsonb_object_keys(v_ext) k where v_out ? k) then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-ESIG-095 content extension %s of %s returned a key the content already has; it adds keys, never replaces one',
        e.extension_key, p_aggregate_type);
    end if;
    v_out := v_out || v_ext;
  end loop;
  return v_out;
end
$$;

-- Kernel 1195's provider, its content passed through the extensions registered for config_change_record.
create or replace function platform.change_record_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  r platform.change_record;
begin
  select * into r from platform.change_record c where c.number = p_id;
  if r.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', esig.extend_content('config_change_record', r.number,
                 jsonb_build_object('number', r.number, 'title', r.title, 'description', r.description, 'areas', to_jsonb(r.areas),
                                    'raised_by', r.raised_by_person, 'raised_at', to_char(r.raised_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))),
    'state', platform.change_record_state(r.id),
    'entered_by', jsonb_build_array(r.raised_by_person));
end
$$;

revoke all on platform.content_extension from public, ebmr_app;
grant select on platform.content_extension to ebmr_app;
revoke all on function esig.content_extension_guard(), esig.register_content_extension(text, text, regprocedure, text),
                       esig.extend_content(text, text, jsonb) from public;
-- register_content_extension and extend_content stay private to the owner, as register_content_provider and provide do.

reset role;
