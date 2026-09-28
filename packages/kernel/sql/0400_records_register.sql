-- Records module (B4), part 1: schema, shared helpers and the DI-01 record-type register.
--
-- The register lists every GMP record type the eBMR holds or references: official medium, which item
-- is the original, raw/derived/informational class, criticality, owner, storage location, retention
-- key and review rule. Versions are insert-only; a version becomes current when a person other than
-- its author approves it (approval signature id; the signing module supplies real signatures later).
--
-- Raw-data floor (DI-01): a data item that feeds an acceptance limit or another quality decision must
-- be classified RAW. records.assert_classification_valid is the check other validators (the MBR
-- validator in Phase 2) call; the register itself refuses such a classification by the same rule and
-- by a table constraint, so raw SQL cannot store it either.
--
-- Error codes: EBMR-REC-0xx (see packages/kernel/src/records/README.md).

create schema if not exists records authorization ebmr_owner;
revoke all on schema records from public;
grant usage on schema records to ebmr_app;

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------------------------

create function records.actor() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v jsonb := kernel.current_actor();
begin
  if v is null then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-001 no actor context: call kernel.begin_command first';
  end if;
  return v;
end
$$;

create function records.actor_person() returns uuid
language sql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
  select (records.actor() ->> 'person_id')::uuid
$$;

create function records.actor_account() returns uuid
language sql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
  select (records.actor() ->> 'account_id')::uuid
$$;

-- True when the command runs for a machine (SYSTEM job or INTEGRATION), not a person at a screen.
create function records.actor_is_machine() returns boolean
language sql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
  select (records.actor() ->> 'source') in ('SYSTEM', 'INTEGRATION')
$$;

-- True when p is NULL, empty or only white space (any kind, as kernel.is_blank: the audit trigger
-- refuses such a reason, so the records functions refuse it first with their own message).
create function records.is_blank(p text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(p !~ '[^[:space:]]', true)
$$;

create function records.record_key(p_aggregate_type text, p_aggregate_id text) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  if p_aggregate_type is null or p_aggregate_type !~ '^[a-z][a-z0-9_]*$' then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-002 aggregate type %L is not valid', p_aggregate_type);
  end if;
  if p_aggregate_id is null or length(btrim(p_aggregate_id)) = 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-002 aggregate id is required';
  end if;
  return p_aggregate_type || ':' || p_aggregate_id;
end
$$;

-- Calendar arithmetic used by the retention rules (mirrored exactly in src/records/calendar.ts).
-- Adding years/months to a date whose day does not exist in the target month (29 Feb + 1 year)
-- rolls forward to the first day of the next month, so a period is never shortened by clamping.
create function records.add_period(p_date date, p_years integer, p_months integer) returns date
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_total integer;
  v_year integer;
  v_month integer;
  v_day integer := extract(day from p_date)::integer;
  v_first date;
  v_days integer;
begin
  if p_years < 0 or p_months < 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-003 retention periods are never negative';
  end if;
  v_total := extract(year from p_date)::integer * 12 + extract(month from p_date)::integer - 1 + p_years * 12 + p_months;
  v_year := v_total / 12;
  v_month := v_total % 12 + 1;
  v_first := make_date(v_year, v_month, 1);
  v_days := extract(day from (v_first + interval '1 month' - interval '1 day'))::integer;
  if v_day <= v_days then
    return make_date(v_year, v_month, v_day);
  end if;
  return (v_first + interval '1 month')::date;
end
$$;

-- Blocker epoch (outline 5.7): a per-record counter bumped in the same transaction as any change to
-- the incidents, DI investigations or holds linked to that record. The release module locks it with
-- records.lock_blocker_epoch inside the disposition transaction and checks it did not move since
-- records.open_blockers was evaluated. A derived concurrency token, not a GMP record: every change
-- that bumps it is itself audited in the incident, investigation or hold chain.
--
-- The one blocker that appears without such a change is the implicit DI-investigation blocker (the
-- person investigated writes to the record inside the window after the investigation was opened). The
-- public records.lock_blocker_epoch (0430) therefore first links and holds any such record, which bumps
-- the epoch, before it locks (F35). Internal callers that only need the lock use lock_blocker_epoch_row.
create table records.blocker_epoch (
  record_key  text primary key,
  version     bigint not null check (version >= 0),
  changed_at  timestamptz not null default clock_timestamp()
);

create function records.bump_blocker_epoch(p_aggregate_type text, p_aggregate_id text) returns void
language sql volatile security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
  insert into records.blocker_epoch as b (record_key, version)
  values (records.record_key(p_aggregate_type, p_aggregate_id), 1)
  on conflict (record_key) do update set version = b.version + 1, changed_at = clock_timestamp()
$$;

-- Internal: lock the epoch row of one record and return its version (no implicit-blocker check).
create function records.lock_blocker_epoch_row(p_aggregate_type text, p_aggregate_id text) returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v_key text := records.record_key(p_aggregate_type, p_aggregate_id);
  v_version bigint;
begin
  insert into records.blocker_epoch (record_key, version) values (v_key, 0) on conflict (record_key) do nothing;
  select version into v_version from records.blocker_epoch where record_key = v_key for update;
  return v_version;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- DI-01 record-type register
-- ---------------------------------------------------------------------------------------------

create function records.data_class_rank(p_class text) returns integer
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_class when 'RAW' then 3 when 'DERIVED' then 2 when 'INFORMATIONAL' then 1 end
$$;

create table records.record_type (
  code                    text not null check (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  version                 integer not null check (version >= 1),
  title                   text not null check (length(btrim(title)) > 0),
  description             text not null,
  official_record         boolean not null,
  data_class              text not null check (data_class in ('RAW', 'DERIVED', 'INFORMATIONAL')),
  raw_data                boolean generated always as (data_class = 'RAW') stored,
  gmp_criticality         text not null check (gmp_criticality in ('HIGH', 'MEDIUM', 'LOW')),
  official_medium         text not null check (official_medium in ('ELECTRONIC', 'PAPER', 'HYBRID')),
  original_and_copies     text not null check (length(btrim(original_and_copies)) > 0),
  hybrid_linkage          text,
  storage_location        text not null check (length(btrim(storage_location)) > 0),
  owning_module           text not null check (length(btrim(owning_module)) > 0),
  owner_role              text not null check (length(btrim(owner_role)) > 0),
  retention_key           text not null check (retention_key in ('BATCH_RECORD', 'SUPPORTING_RECORD', 'DSCSA_RECORD', 'VALIDATION_RAW_DATA', 'PERMANENT')),
  review_rule             text not null check (length(btrim(review_rule)) > 0),
  retained_metadata       text[] not null default '{}',
  feeds_acceptance_limit  boolean not null,
  defined_by_person       uuid not null,
  recorded_at             timestamptz not null default clock_timestamp(),
  primary key (code, version),
  -- A hybrid record declares how paper and electronic parts are linked (DI-41, DI-43).
  constraint record_type_hybrid_linkage check (official_medium <> 'HYBRID' or length(btrim(coalesce(hybrid_linkage, ''))) > 0),
  -- Raw-data floor, also as a constraint so no write path can store the forbidden combination.
  constraint record_type_raw_data_floor check (not feeds_acceptance_limit or data_class = 'RAW')
);

create table records.record_type_approval (
  code                   text not null,
  version                integer not null,
  approved_by_person     uuid not null,
  approval_signature_id  uuid not null,
  recorded_at            timestamptz not null default clock_timestamp(),
  primary key (code, version),
  foreign key (code, version) references records.record_type (code, version)
);

-- The current register: the highest approved version of each record type.
create view records.record_register as
select distinct on (t.code)
       t.code, t.version, t.title, t.description, t.official_record, t.data_class, t.raw_data, t.gmp_criticality,
       t.official_medium, t.original_and_copies, t.hybrid_linkage, t.storage_location, t.owning_module, t.owner_role,
       t.retention_key, t.review_rule, t.retained_metadata, t.feeds_acceptance_limit, t.defined_by_person,
       a.approved_by_person, a.approval_signature_id, a.recorded_at as approved_at
from records.record_type t
join records.record_type_approval a on a.code = t.code and a.version = t.version
order by t.code, t.version desc;

-- Returns null when the classification is acceptable, otherwise a message starting with its code.
create function records.classification_problem(p_data_class text, p_feeds_acceptance_limit boolean, p_record_type_code text default null)
returns text
language plpgsql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v_type records.record_register%rowtype;
  v_feeds boolean;
begin
  if p_data_class is null or records.data_class_rank(p_data_class) is null then
    return format('EBMR-REC-011 data class %L is not one of RAW, DERIVED, INFORMATIONAL', p_data_class);
  end if;
  if p_feeds_acceptance_limit is null then
    return 'EBMR-REC-011 whether the data item feeds an acceptance limit must be stated';
  end if;
  v_feeds := p_feeds_acceptance_limit;
  if p_record_type_code is not null then
    select * into v_type from records.record_register where code = p_record_type_code;
    if not found then
      return format('EBMR-REC-013 record type %s has no approved version in the record register', p_record_type_code);
    end if;
    v_feeds := v_feeds or v_type.feeds_acceptance_limit;
  end if;
  if v_feeds and p_data_class <> 'RAW' then
    return format('EBMR-REC-010 a data item that feeds an acceptance limit or quality decision is raw data; it cannot be classified %s', p_data_class);
  end if;
  if p_record_type_code is not null and records.data_class_rank(p_data_class) < records.data_class_rank(v_type.data_class) then
    return format('EBMR-REC-014 classification %s is weaker than the register class %s of record type %s', p_data_class, v_type.data_class, v_type.code);
  end if;
  return null;
end
$$;

-- The check validators call for one data item (for example each element of an MBR at approval).
create function records.assert_classification_valid(p_item_ref text, p_data_class text, p_feeds_acceptance_limit boolean, p_record_type_code text default null)
returns void
language plpgsql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v_problem text := records.classification_problem(p_data_class, p_feeds_acceptance_limit, p_record_type_code);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('%s [item %s]', v_problem, coalesce(p_item_ref, '?'));
  end if;
end
$$;

-- Bulk form: every problem for a list of items [{itemRef, dataClass, feedsAcceptanceLimit, recordTypeCode}].
create function records.classification_problems(p_items jsonb)
returns table (item_ref text, problem text)
language sql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
  select i ->> 'itemRef',
         records.classification_problem(i ->> 'dataClass', (i ->> 'feedsAcceptanceLimit')::boolean, i ->> 'recordTypeCode')
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(i, n)
  where records.classification_problem(i ->> 'dataClass', (i ->> 'feedsAcceptanceLimit')::boolean, i ->> 'recordTypeCode') is not null
  order by n
$$;

create function records.define_record_type(p_def jsonb) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  k text;
  v_allowed text[] := array['code', 'title', 'description', 'officialRecord', 'dataClass', 'gmpCriticality', 'officialMedium',
                            'originalAndCopies', 'hybridLinkage', 'storageLocation', 'owningModule', 'ownerRole', 'retentionKey',
                            'reviewRule', 'retainedMetadata', 'feedsAcceptanceLimit'];
  v_required text[] := array['code', 'title', 'description', 'officialRecord', 'dataClass', 'gmpCriticality', 'officialMedium',
                             'originalAndCopies', 'storageLocation', 'owningModule', 'ownerRole', 'retentionKey', 'reviewRule',
                             'feedsAcceptanceLimit'];
  v_code text := p_def ->> 'code';
  v_version integer;
  v_problem text;
  v_person uuid := records.actor_person();
begin
  -- DI-18, then DI-17 installation-wide.
  perform iam.assert_not_administrator();
  perform iam.require_permission('RECORD.TYPE_DEFINE', '{}'::jsonb);
  if p_def is null or jsonb_typeof(p_def) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-011 a record type definition must be a JSON object';
  end if;
  for k in select jsonb_object_keys(p_def) loop
    if not k = any(v_allowed) then
      raise exception using errcode = 'P0001', message = format('EBMR-REC-011 unknown record type field %s', k);
    end if;
  end loop;
  foreach k in array v_required loop
    if p_def -> k is null or jsonb_typeof(p_def -> k) = 'null' or (jsonb_typeof(p_def -> k) = 'string' and records.is_blank(p_def ->> k)) then
      raise exception using errcode = 'P0001', message = format('EBMR-REC-011 record type field %s is required', k);
    end if;
  end loop;
  if jsonb_typeof(p_def -> 'officialRecord') <> 'boolean' or jsonb_typeof(p_def -> 'feedsAcceptanceLimit') <> 'boolean' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-011 officialRecord and feedsAcceptanceLimit must be true or false';
  end if;
  if p_def ? 'retainedMetadata' and jsonb_typeof(p_def -> 'retainedMetadata') <> 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-011 retainedMetadata must be a list of field names';
  end if;
  v_problem := records.classification_problem(p_def ->> 'dataClass', (p_def ->> 'feedsAcceptanceLimit')::boolean, null);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('%s [record type %s]', v_problem, v_code);
  end if;
  if p_def ->> 'officialMedium' = 'HYBRID' and records.is_blank(p_def ->> 'hybridLinkage') then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-016 hybrid record type %s must declare how paper and electronic parts are linked', v_code);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('records.record_type:' || v_code, 0));
  select coalesce(max(version), 0) + 1 into v_version from records.record_type where code = v_code;
  insert into records.record_type (code, version, title, description, official_record, data_class, gmp_criticality, official_medium,
                                   original_and_copies, hybrid_linkage, storage_location, owning_module, owner_role, retention_key,
                                   review_rule, retained_metadata, feeds_acceptance_limit, defined_by_person)
  values (v_code, v_version, p_def ->> 'title', p_def ->> 'description', (p_def ->> 'officialRecord')::boolean, p_def ->> 'dataClass',
          p_def ->> 'gmpCriticality', p_def ->> 'officialMedium', p_def ->> 'originalAndCopies', nullif(btrim(coalesce(p_def ->> 'hybridLinkage', '')), ''),
          p_def ->> 'storageLocation', p_def ->> 'owningModule', p_def ->> 'ownerRole', p_def ->> 'retentionKey', p_def ->> 'reviewRule',
          coalesce(array(select jsonb_array_elements_text(p_def -> 'retainedMetadata')), '{}'), (p_def ->> 'feedsAcceptanceLimit')::boolean, v_person);
  return v_version;
end
$$;

create function records.approve_record_type(p_code text, p_version integer, p_approval_signature_id uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  v_type records.record_type%rowtype;
  v_current integer;
  v_problem text;
  v_person uuid := records.actor_person();
begin
  if p_approval_signature_id is null then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-012 approving a record type needs the approval signature';
  end if;
  if records.actor_is_machine() then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-012 a record type is approved by a person, not by a system or integration account';
  end if;
  -- DI-18, then DI-17 installation-wide.
  perform iam.assert_not_administrator();
  perform iam.require_permission('RECORD.TYPE_APPROVE', '{}'::jsonb);
  perform pg_advisory_xact_lock(hashtextextended('records.record_type:' || p_code, 0));
  select * into v_type from records.record_type where code = p_code and version = p_version;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-013 record type %s version %s does not exist', p_code, p_version);
  end if;
  if exists (select 1 from records.record_type_approval where code = p_code and version = p_version) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-015 record type %s version %s is already approved', p_code, p_version);
  end if;
  select max(version) into v_current from records.record_type_approval where code = p_code;
  if v_current is not null and v_current > p_version then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-015 version %s of %s is older than the approved version %s', p_version, p_code, v_current);
  end if;
  if v_type.defined_by_person = v_person then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-012 the author of record type %s version %s cannot approve it', p_code, p_version);
  end if;
  v_problem := records.classification_problem(v_type.data_class, v_type.feeds_acceptance_limit, null);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('%s [record type %s]', v_problem, p_code);
  end if;
  -- DI-37: a valid RECORD_TYPE_APPROVED signature of exactly this version (0720), made by the approver.
  if (esig.assert_signature(p_approval_signature_id, 'RECORD_TYPE_APPROVED', 'record_type_version', p_code || ':' || p_version)
        ->> 'signer_person')::uuid is distinct from v_person then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REC-017 the approval signature of record type %s version %s was made by another person', p_code, p_version);
  end if;
  insert into records.record_type_approval (code, version, approved_by_person, approval_signature_id)
  values (p_code, p_version, v_person, p_approval_signature_id);
end
$$;

select kernel.register_audited_table('records.record_type', 'record_type', 'code', true);
select kernel.register_audited_table('records.record_type_approval', 'record_type', 'code', true);

-- ---------------------------------------------------------------------------------------------
-- Privileges: the application reads the register and calls the functions; it writes nothing directly.
-- ---------------------------------------------------------------------------------------------

revoke all on all tables in schema records from ebmr_app;
grant select on records.record_type, records.record_type_approval, records.record_register, records.blocker_epoch to ebmr_app;
grant execute on function records.add_period(date, integer, integer), records.record_key(text, text),
                          records.classification_problem(text, boolean, text),
                          records.assert_classification_valid(text, text, boolean, text),
                          records.classification_problems(jsonb),
                          records.define_record_type(jsonb),
                          records.approve_record_type(text, integer, uuid) to ebmr_app;
-- records.actor*, records.bump_blocker_epoch, records.lock_blocker_epoch_row, records.is_blank and
-- records.data_class_rank stay private; the public records.lock_blocker_epoch is defined in 0430.

reset role;
