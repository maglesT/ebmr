-- Electronic signatures (module B2), part 1: schema, protected-log helpers, canonical JSON and
-- content hashing, e-signature policy values, and the registry of canonical-content providers.
--
-- Build outline 5.5 (challenge, authenticate, sign; components and sessions; meanings); ADR 0006,
-- 0012; controls DI-35, DI-36, DI-37, DI-38 (and the DI-13 evidence package); invariants INV-03,
-- INV-09, INV-10 and the "signature IDs never reused" part of INV-27.
--
-- What a signature signs: the canonical content of one record version, as rebuilt on the server by
-- the provider function registered for the record's aggregate type. The content hash is SHA-256 of
-- the canonical JSON (keys sorted by code point, no insignificant white space) of the envelope
--   {"aggregate_type": t, "aggregate_id": id, "content_version": v, "content": <provider content>}
-- so a hash never matches another record, even one with identical content.
--
-- Error codes: EBMR-ESIG-NNN.

create schema if not exists esig authorization ebmr_owner;
revoke all on schema esig from public;
grant usage on schema esig to ebmr_app;

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Protected-log helpers (tables written by esig functions only, never changed afterwards)
-- ---------------------------------------------------------------------------------------------

create function esig.forbid_change() returns trigger
language plpgsql security definer set search_path = pg_catalog, esig, pg_temp as $$
begin
  raise exception using errcode = 'P0001',
    message = format('EBMR-ESIG-001 %s is insert-only (%s refused)', tg_relid::regclass, lower(tg_op));
end
$$;

create function esig.protect_log(p_table regclass) returns void
language plpgsql security definer set search_path = pg_catalog, esig, pg_temp as $$
declare
  v_name text := replace(replace(p_table::text, '.', '_'), '"', '');
begin
  execute format('create trigger %I before update or delete on %s for each row execute function esig.forbid_change()', 'ab_log_' || v_name, p_table);
  execute format('create trigger %I before truncate on %s for each statement execute function esig.forbid_change()', 'ab_log_trunc_' || v_name, p_table);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Canonical JSON and hashing
-- ---------------------------------------------------------------------------------------------

-- Canonical text of a JSON value: object keys sorted by Unicode code point (UTF-8 byte order),
-- no white space, strings escaped as JSON requires, numbers in PostgreSQL's numeric text form.
-- Content providers emit GMP decimals as strings, so a client can reproduce the text exactly.
create function esig.canonical_json(p jsonb) returns text
language plpgsql immutable strict set search_path = pg_catalog, pg_temp as $$
declare
  v_out text;
begin
  case jsonb_typeof(p)
    when 'object' then
      select '{' || coalesce(string_agg(to_json(e.k)::text || ':' || esig.canonical_json(e.v), ',' order by e.k collate "C"), '') || '}'
      into v_out from jsonb_each(p) as e (k, v);
    when 'array' then
      select '[' || coalesce(string_agg(esig.canonical_json(a.v), ',' order by a.i), '') || ']'
      into v_out from jsonb_array_elements(p) with ordinality as a (v, i);
    else
      v_out := p::text;
  end case;
  return v_out;
end
$$;

create function esig.sha256_hex(p text) returns text
language sql immutable strict set search_path = pg_catalog, pg_temp as $$
  select encode(sha256(convert_to(p, 'UTF8')), 'hex')
$$;

-- An instant as UTC text with microseconds (independent of the session's TimeZone setting).
create function esig.utc_text(p timestamptz) returns text
language sql stable strict set search_path = pg_catalog, pg_temp as $$
  select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- The UTC offset of an IANA zone at an instant, as +HH:MM or -HH:MM.
create function esig.utc_offset(p_at timestamptz, p_zone text) returns text
language plpgsql stable strict set search_path = pg_catalog, pg_temp as $$
declare
  v_secs integer := extract(epoch from ((p_at at time zone p_zone) - (p_at at time zone 'UTC')))::integer;
begin
  return case when v_secs < 0 then '-' else '+' end
         || lpad((abs(v_secs) / 3600)::text, 2, '0') || ':' || lpad(((abs(v_secs) % 3600) / 60)::text, 2, '0');
end
$$;

-- Site-local wall-clock time of an instant, YYYY-MM-DD HH:MM:SS.
create function esig.local_text(p_at timestamptz, p_zone text) returns text
language sql stable strict set search_path = pg_catalog, pg_temp as $$
  select to_char(p_at at time zone p_zone, 'YYYY-MM-DD HH24:MI:SS')
$$;

-- ---------------------------------------------------------------------------------------------
-- E-signature policy values (design defaults with allowed ranges). Changes are insert-only,
-- audited, need a reason and a change-control reference, and are made by the quality unit
-- (esig.set_policy, defined in 0210 once the permission guard is available).
-- ---------------------------------------------------------------------------------------------

create table esig.policy_key (
  key            text primary key check (key ~ '^esig\.[a-z][a-z0-9_]*$'),
  value_type     text not null check (value_type in ('INTEGER', 'BOOLEAN', 'TEXT')),
  default_value  text not null,
  min_value      bigint,
  max_value      bigint,
  allowed_values text[],
  unit           text,
  description    text not null,
  basis          text not null
);
select esig.protect_log('esig.policy_key');

insert into esig.policy_key (key, value_type, default_value, min_value, max_value, allowed_values, unit, description, basis) values
  ('esig.challenge_validity_seconds', 'INTEGER', '120', 30, 120, null, 's',
   'Validity of a single-use signature challenge',
   'Outline 5.5 step 1: a challenge is valid for 120 s; shorter values are allowed, longer ones are not'),
  ('esig.session_relaxation', 'BOOLEAN', 'false', null, null, null, null,
   'QA-approvable relaxation (DI-38): within one continuous session, routine signings by the session owner after a first signing with all components may use the private component (password or PIN) alone; never for disposition, certification or master-record approval, never for anyone but the session owner',
   '21 CFR 11.200(a)(1)(i) permits it (paraphrased); the EU draft Annex 11 expects re-authentication at each signing; default off, so all components are needed at every signing'),
  ('esig.witness_window_seconds', 'INTEGER', '300', 60, 1800, null, 's',
   'A WITNESSED signature is applied within this time after the act it witnesses',
   'Outline 5.5 meanings: configurable window, design default 5 min; no regulation sets the number'),
  ('esig.mfa_at_signing', 'BOOLEAN', 'false', null, null, null, null,
   'Stricter option: every signing also needs an MFA component in its authentication event',
   'DI-38 notes: MFA at signing can be switched on (optional, stricter)'),
  ('esig.india_dsc', 'TEXT', 'OFF', null, null, array['OFF'], null,
   'India option (IN-10): a second signature with a Class 3 DSC or eSign over the same content hash. Extension point only in v1; it cannot be switched on until a licensed CA or eSign provider is configured and validated',
   'Outline 5.5 India option and Decision 3: off in v1');

create table esig.policy_value (
  id              bigint generated always as identity primary key,
  key             text not null references esig.policy_key (key),
  value           text not null,
  set_by_person   uuid not null,
  set_by_account  uuid not null,
  reason          text not null check (btrim(reason) <> ''),
  change_ref      text not null check (btrim(change_ref) <> ''),
  recorded_at     timestamptz not null default clock_timestamp()
);
create index policy_value_key on esig.policy_value (key, id desc);

create function esig.policy_value_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, esig, pg_temp as $$
begin
  new.recorded_at := clock_timestamp();
  return new;
end
$$;
create trigger aa_policy_value_guard before insert on esig.policy_value for each row execute function esig.policy_value_guard();

create function esig.policy_text(p_key text) returns text
language plpgsql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
declare
  v text;
begin
  select pv.value into v from esig.policy_value pv where pv.key = p_key order by pv.id desc limit 1;
  if v is null then
    select k.default_value into v from esig.policy_key k where k.key = p_key;
    if v is null then
      raise exception using errcode = 'P0001', message = format('EBMR-ESIG-002 unknown e-signature policy key %s', p_key);
    end if;
  end if;
  return v;
end
$$;

create function esig.policy_int(p_key text) returns bigint
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select esig.policy_text(p_key)::bigint
$$;

create function esig.policy_bool(p_key text) returns boolean
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select esig.policy_text(p_key)::boolean
$$;

create function esig.policy_values() returns table (key text, value text, value_type text, min_value bigint, max_value bigint,
                                                      allowed_values text[], unit text, description text, basis text, is_default boolean)
language sql stable security definer set search_path = pg_catalog, esig, pg_temp as $$
  select k.key, esig.policy_text(k.key), k.value_type, k.min_value, k.max_value, k.allowed_values, k.unit, k.description, k.basis,
         not exists (select 1 from esig.policy_value v where v.key = k.key)
  from esig.policy_key k
  order by k.key
$$;

-- ---------------------------------------------------------------------------------------------
-- Canonical-content providers (one SQL function per aggregate type)
--
-- Contract: fn(aggregate_id text) returns jsonb with
--   exists           boolean (required)
--   aggregate_id     text, the record's canonical id (recommended): a record has exactly one id for
--                    signing, so a challenge naming it any other way (an upper-case or braced UUID,
--                    for example) is refused (EBMR-ESIG-014). Without it, a UUID-shaped id must be
--                    in PostgreSQL's canonical text form.
--   content_version  integer >= 1, the version of the signable content (required when exists)
--   content          JSON object: the canonical content (values, units, limit evaluations,
--                    performers, master-record version, attachment hashes); decimals as strings
--   state            text, the record's current state (optional; checked against the caller's
--                    expected state at signing, stored with the signature, and a signature applied
--                    in one state never authorises a state-engine transition out of another)
--   scope            {"site", "area", "product"} for the authority evaluation (optional)
--   market           text, for market-bound meanings and delegations (optional)
--   act              {"device_id": uuid, "at": timestamptz, "next_step_started": boolean} of the
--                    act a WITNESSED signature witnesses (optional; without it nothing can be
--                    witnessed). next_step_started is derived from the record: whether the step
--                    after the act has started. When it is missing, witnessing is refused.
--   entered_by       uuid[] persons who entered or corrected data in the record, in addition to
--                    those esig records itself for registered signed tables (optional)
--   involved         uuid[] the record's involvement set for review and release meanings (optional)
-- The provider must not change data. Its content must cover exactly the data held in the tables
-- registered for the aggregate type (esig.register_signed_table), so a change that supersedes
-- nothing never changes the content hash (INV-09). Providers are registered by migrations only.
-- ---------------------------------------------------------------------------------------------

create table esig.content_provider (
  aggregate_type  text primary key check (aggregate_type ~ '^[a-z][a-z0-9_]*$'),
  function_oid    regprocedure not null,
  description     text not null check (btrim(description) <> ''),
  registered_at   timestamptz not null default clock_timestamp()
);

create function esig.register_content_provider(p_aggregate_type text, p_function regprocedure, p_description text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, esig, pg_temp as $$
begin
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = p_function and pg_catalog.oidvectortypes(p.proargtypes) = 'text'
                   and p.prorettype = 'jsonb'::regtype) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ESIG-003 %s must have the provider signature (aggregate_id text) returns jsonb', p_function);
  end if;
  insert into esig.content_provider (aggregate_type, function_oid, description) values (p_aggregate_type, p_function, p_description)
  on conflict (aggregate_type) do update set function_oid = excluded.function_oid, description = excluded.description,
                                             registered_at = clock_timestamp();
end
$$;

-- The provider's output for one record, validated. Unknown aggregate types report exists = false.
create function esig.provide(p_aggregate_type text, p_aggregate_id text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, esig, pg_temp as $$
declare
  v_fn  regprocedure;
  v_out jsonb;
begin
  select function_oid into v_fn from esig.content_provider where aggregate_type = p_aggregate_type;
  if v_fn is null then
    return jsonb_build_object('exists', false, 'provider', false);
  end if;
  execute format('select %s($1)', (select quote_ident(n.nspname) || '.' || quote_ident(p.proname)
                                   from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where p.oid = v_fn))
    into v_out using p_aggregate_id;
  if v_out is null or jsonb_typeof(v_out) <> 'object' or jsonb_typeof(v_out -> 'exists') is distinct from 'boolean' then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-004 the content provider of %s returned an invalid result', p_aggregate_type);
  end if;
  if (v_out ->> 'exists')::boolean then
    if jsonb_typeof(v_out -> 'content_version') is distinct from 'number' or (v_out ->> 'content_version') !~ '^[1-9][0-9]*$'
       or jsonb_typeof(v_out -> 'content') is distinct from 'object' then
      raise exception using errcode = 'P0001',
        message = format('EBMR-ESIG-004 the content provider of %s must return content_version >= 1 and a content object', p_aggregate_type);
    end if;
    if v_out ? 'aggregate_id' and jsonb_typeof(v_out -> 'aggregate_id') is distinct from 'string' then
      raise exception using errcode = 'P0001',
        message = format('EBMR-ESIG-004 the content provider of %s must return aggregate_id as text', p_aggregate_type);
    end if;
  end if;
  return v_out || jsonb_build_object('provider', true);
end
$$;

-- NULL when p_aggregate_id is the record's canonical id, otherwise why not. Every signature, lock,
-- change log and independence rule is keyed on the id text, so a second spelling of the same record
-- (an upper-case, braced or unhyphenated UUID) would be a second identity that none of them sees.
create function esig.aggregate_id_problem(p_aggregate_id text, p_provided jsonb) returns text
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  v_uuid uuid;
begin
  if p_provided ? 'aggregate_id' then
    if p_provided ->> 'aggregate_id' is distinct from p_aggregate_id then
      return format('the record''s canonical id is %s', p_provided ->> 'aggregate_id');
    end if;
    return null;
  end if;
  begin
    v_uuid := p_aggregate_id::uuid;
  exception when invalid_text_representation then
    return null;
  end;
  if v_uuid::text <> p_aggregate_id then
    return format('the record''s canonical id is %s', v_uuid);
  end if;
  return null;
end
$$;

-- The canonical envelope text and its hash for a provider result.
create function esig.canonical_envelope(p_aggregate_type text, p_aggregate_id text, p_provided jsonb) returns text
language sql immutable strict set search_path = pg_catalog, esig, pg_temp as $$
  select esig.canonical_json(jsonb_build_object('aggregate_type', p_aggregate_type, 'aggregate_id', p_aggregate_id,
                                                'content_version', (p_provided -> 'content_version'), 'content', p_provided -> 'content'))
$$;

create function esig.content_hash_of(p_aggregate_type text, p_aggregate_id text, p_provided jsonb) returns text
language sql immutable strict set search_path = pg_catalog, esig, pg_temp as $$
  select case when (p_provided ->> 'exists')::boolean
              then esig.sha256_hex(esig.canonical_envelope(p_aggregate_type, p_aggregate_id, p_provided)) end
$$;

-- What a client shows before signing: the canonical text, its hash and the version. The client
-- renders exactly this text and sends its hash with the challenge request.
create function esig.content_for_signing(p_aggregate_type text, p_aggregate_id text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, esig, pg_temp as $$
declare
  v         jsonb := esig.provide(p_aggregate_type, p_aggregate_id);
  v_problem text;
begin
  if not (v ->> 'exists')::boolean then
    return jsonb_build_object('exists', false, 'aggregate_type', p_aggregate_type, 'aggregate_id', p_aggregate_id);
  end if;
  v_problem := esig.aggregate_id_problem(p_aggregate_id, v);
  if v_problem is not null then
    return jsonb_build_object('exists', false, 'aggregate_type', p_aggregate_type, 'aggregate_id', p_aggregate_id,
                              'problem', format('EBMR-ESIG-014 %s names the record by another id than its own: %s', p_aggregate_id, v_problem));
  end if;
  return jsonb_build_object('exists', true, 'aggregate_type', p_aggregate_type, 'aggregate_id', p_aggregate_id,
                            'content_version', v ->> 'content_version', 'state', v ->> 'state',
                            'canonical', esig.canonical_envelope(p_aggregate_type, p_aggregate_id, v),
                            'content_hash', esig.content_hash_of(p_aggregate_type, p_aggregate_id, v));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Registry of tables whose rows are signed content (the invalidation trigger is created in 0220)
-- ---------------------------------------------------------------------------------------------

create table esig.signed_table (
  table_name        regclass primary key,
  aggregate_type    text not null check (aggregate_type ~ '^[a-z][a-z0-9_]*$'),
  aggregate_column  text not null,
  content_columns   text[],
  trigger_name      text not null,
  registered_at     timestamptz not null default clock_timestamp()
);

-- ---------------------------------------------------------------------------------------------
-- Audit registration and privileges
-- ---------------------------------------------------------------------------------------------

select kernel.register_audited_table('esig.policy_value', 'esig_policy', 'key', true);

revoke all on all tables in schema esig from ebmr_app;
grant select on esig.policy_key, esig.policy_value, esig.content_provider, esig.signed_table to ebmr_app;
grant execute on function esig.canonical_json(jsonb), esig.sha256_hex(text), esig.utc_text(timestamptz),
                          esig.utc_offset(timestamptz, text), esig.local_text(timestamptz, text), esig.policy_text(text),
                          esig.policy_int(text), esig.policy_bool(text), esig.policy_values(),
                          esig.content_for_signing(text, text) to ebmr_app;
-- register_content_provider, provide, protect_log and forbid_change stay private to the owner.

reset role;
