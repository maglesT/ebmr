-- Phase 6 slice 6f (builder A): configuration change control (DI-09; EU Annex 11 section 10 paraphrased: changes to a
-- computerised system's configuration are made in a controlled way under a defined procedure; 21 CFR 211.68 and
-- Part 11 11.10(k): controls over the system documentation and its changes). Defaults D-P6f-1, D-P6f-A-1 to A-4.
--
-- Handbook: modules/kernel.md
--
--   platform.change_record        insert-only: one configuration change record (its number, the change-record id people
--                                 cite, a title, a description and the configuration areas it may change), raised by a
--                                 person holding CONFIG.CHANGE_RAISE.
--   platform.change_record_event  insert-only: APPROVED (the quality unit's CONFIG_CHANGE_APPROVED e-signature of the
--                                 record, by someone other than the person who raised it) and CLOSED. A record is OPEN,
--                                 then APPROVED, then CLOSED; only an APPROVED record lets configuration change.
--   platform.config_area          owner-maintained: the configuration tables under change control, each with its area
--                                 code, the columns that name one configuration item, the columns that are its value and
--                                 the column its validity starts from (D-P6f-1).
--   platform.config_version       insert-only: every configuration row ever written to an area's table, as one version
--                                 of one item with the instant it became valid and the change record (or the software
--                                 release) it was written under. A version is valid until the next version of the same
--                                 item, so the configuration of any past instant and the difference between two
--                                 instants are reads of this table (platform.config_as_of, platform.config_diff).
--
-- The guard (trigger a00_config_change, BEFORE INSERT OR UPDATE on every registered table) refuses a configuration row
-- unless the validated actor context of the command carries the id (number) of a change record that is APPROVED, not
-- CLOSED, and lists the row's area (EBMR-CFG-001 to -004). The context key is `change_record`; the server sets it from
-- the request (ActorContext.changeRecord). Rows written under the software-release identity (migrations; role
-- SOFTWARE_RELEASE, source SYSTEM, the zero person) are a release, which has its own change control (D-P6f-A-2); no
-- command started by kernel.begin_command can carry that identity, because kernel.validate_actor_context refuses the zero
-- person. Because the guard is a trigger on the table, every writer of the table is covered, today's and later ones;
-- packages/kernel/test/config/change-control.test.ts scans the catalogue for configuration tables without it.
--
-- Areas registered here: PLATFORM_SETTING (platform.setting_value: site values of the platform, among them the adapter
-- modes and mirror freshness bounds of slice 6a), IAM_POLICY (iam.policy_value), ESIG_POLICY (esig.policy_value),
-- ESIG_MEANING (esig.meaning_type), MARKET_POLICY (market.policy_version) and SITE_VALUE (market.site_value). Recipe-core
-- 1050 registers RBE_RULE. Rows already in these tables are back-filled as versions with basis BEFORE_CONTROL (or
-- RELEASE when the release wrote them), so the history starts complete.
--
-- Messages: EBMR-CFG-001 to EBMR-CFG-019.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1195_configuration_change_control)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'configuration change records, configuration versions and their guard (DI-09)'));

insert into iam.permission (code, domain, effect, description) values
  ('CONFIG.CHANGE_RAISE', 'GMP', 'WRITE', 'Raise a configuration change record (DI-09)'),
  ('CONFIG.CHANGE_APPROVE', 'GMP', 'SIGN', 'Record the quality unit''s approval of a configuration change record (DI-09)'),
  ('CONFIG.CHANGE_CLOSE', 'GMP', 'WRITE', 'Close a configuration change record (DI-09)');
insert into iam.role_permission (role_code, permission_code) values
  ('PROCESS_OWNER', 'CONFIG.CHANGE_RAISE'),
  ('CSV_DI_LEAD', 'CONFIG.CHANGE_RAISE'),
  ('MASTER_DATA_STEWARD', 'CONFIG.CHANGE_RAISE'),
  ('QA_MBR_APPROVER', 'CONFIG.CHANGE_RAISE'),
  ('QA_REVIEWER', 'CONFIG.CHANGE_APPROVE'),
  ('QA_MBR_APPROVER', 'CONFIG.CHANGE_APPROVE'),
  ('PROCESS_OWNER', 'CONFIG.CHANGE_CLOSE'),
  ('CSV_DI_LEAD', 'CONFIG.CHANGE_CLOSE'),
  ('MASTER_DATA_STEWARD', 'CONFIG.CHANGE_CLOSE'),
  ('QA_MBR_APPROVER', 'CONFIG.CHANGE_CLOSE');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values ('CONFIG_CHANGE_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'MASTER_RECORD', 'APPROVER', 'Configuration change approved',
        'As a quality-unit approver, I approve this configuration change record: the areas it names may change under it until it is closed.',
        array['RECORD.QA_REVIEW', 'MBR.APPROVE'], '{}', true, false, false, 'ALL_COMPONENTS', false,
        'DI-09 (change records for every configuration change); EU Annex 11 section 10; 21 CFR 211.68');

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table platform.config_area (
  code               text primary key check (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  table_name         regclass not null unique,
  description        text not null check (btrim(description) <> ''),
  key_columns        text[] not null check (cardinality(key_columns) >= 1),
  value_columns      text[] not null check (cardinality(value_columns) >= 1),
  valid_from_column  text not null,
  recorded_column    text not null,
  registered_at      timestamptz not null default clock_timestamp()
);

create table platform.change_record (
  id                   uuid primary key default gen_random_uuid(),
  number               text not null unique check (number ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'),
  title                text not null check (btrim(title) <> ''),
  description          text not null check (btrim(description) <> ''),
  areas                text[] not null check (cardinality(areas) >= 1),
  raised_by_person     uuid not null,
  raised_by_account    uuid not null,
  raised_at            timestamptz not null default clock_timestamp()
);

create table platform.change_record_event (
  id                   uuid primary key default gen_random_uuid(),
  change_record_id     uuid not null references platform.change_record (id),
  event                text not null check (event in ('APPROVED', 'CLOSED')),
  signature_id         uuid,
  person_id            uuid not null,
  account_id           uuid not null,
  note                 text,
  recorded_at          timestamptz not null default clock_timestamp(),
  unique (change_record_id, event),
  check ((event = 'APPROVED') = (signature_id is not null))
);

create table platform.config_version (
  id                   bigint generated always as identity primary key,
  area                 text not null references platform.config_area (code),
  item_key             text not null,
  value                jsonb not null,
  valid_from           timestamptz not null,
  source_row           jsonb not null,
  basis                text not null check (basis in ('CHANGE_RECORD', 'RELEASE', 'BEFORE_CONTROL')),
  change_record_id     uuid references platform.change_record (id),
  person_id            uuid,
  recorded_at          timestamptz not null default clock_timestamp(),
  check ((basis = 'CHANGE_RECORD') = (change_record_id is not null))
);
create index config_version_item on platform.config_version (area, item_key, valid_from, id);
create index config_version_change on platform.config_version (change_record_id);

revoke all on platform.config_area, platform.change_record, platform.change_record_event, platform.config_version from public;
grant select on platform.config_area, platform.change_record, platform.change_record_event, platform.config_version to ebmr_app;

select platform.enforce_db_time('platform.config_area', array['registered_at']);
select platform.enforce_db_time('platform.change_record', array['raised_at']);
select platform.enforce_db_time('platform.change_record_event', array['recorded_at']);
select platform.enforce_db_time('platform.config_version', array['recorded_at']);
select kernel.register_audited_table('platform.config_area', 'config_area', 'code', true);
select kernel.register_audited_table('platform.change_record', 'config_change_record', 'id', true);
select kernel.register_audited_table('platform.change_record_event', 'config_change_record', 'change_record_id', true);
select kernel.register_audited_table('platform.config_version', 'config_area', 'area', true);
select continuity.register_protected_sequence('platform.config_version_id_seq', 'platform.config_version_id_seq'::regclass,
  'OTHER', 'kernel', 'Configuration version ids (DI-09): the order of versions of one item', 100000);

-- ---------------------------------------------------------------------------------------------
-- State and the guard
-- ---------------------------------------------------------------------------------------------

-- OPEN, APPROVED or CLOSED (NULL for an unknown id).
create function platform.change_record_state(p_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select case when not exists (select 1 from platform.change_record r where r.id = p_id) then null
              when exists (select 1 from platform.change_record_event e where e.change_record_id = p_id and e.event = 'CLOSED') then 'CLOSED'
              when exists (select 1 from platform.change_record_event e where e.change_record_id = p_id and e.event = 'APPROVED') then 'APPROVED'
              else 'OPEN' end
$$;

-- The software-release identity (as market.is_release_actor, 0350): installed only by owner-level code.
create function platform.is_release_actor(p_actor jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_actor ->> 'role_code' = 'SOFTWARE_RELEASE' and p_actor ->> 'source' = 'SYSTEM'
                  and p_actor ->> 'person_id' = '00000000-0000-0000-0000-000000000000', false)
$$;

-- The change record a command may change configuration area p_area under: the APPROVED, not CLOSED record whose number
-- is the context's change_record and whose areas include p_area. Raises otherwise. Returns its id.
create function platform.require_change_record(p_area text, p_what text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx   jsonb := kernel.current_actor();
  v_num   text := btrim(coalesce(v_ctx ->> 'change_record', ''));
  r       platform.change_record;
  v_state text;
begin
  if v_ctx is null then
    raise exception using errcode = 'P0001', message = format('EBMR-CFG-001 %s is a configuration change (%s): it needs a command with a change-record id (DI-09)', p_what, p_area);
  end if;
  if v_num = '' then
    raise exception using errcode = 'P0001', message = format('EBMR-CFG-001 %s is a configuration change (%s): it needs a change-record id; a change without one is refused (DI-09)', p_what, p_area);
  end if;
  select * into r from platform.change_record c where c.number = v_num;
  if r.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-CFG-002 change record %s does not exist (DI-09)', v_num);
  end if;
  v_state := platform.change_record_state(r.id);
  if v_state <> 'APPROVED' then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-CFG-003 change record %s is %s: configuration changes only under an approved change record that is not closed (DI-09)', v_num, v_state);
  end if;
  if not (p_area = any (r.areas)) then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-CFG-004 change record %s covers %s, not %s; %s is refused (DI-09)', v_num, array_to_string(r.areas, ', '), p_area, p_what);
  end if;
  return r.id;
end
$$;

-- The item key and value of a row of a registered table.
create function platform.config_item_key(a platform.config_area, p_row jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select string_agg(coalesce(p_row ->> c, ''), '|' order by o) from unnest(a.key_columns) with ordinality as k(c, o)
$$;
create function platform.config_item_value(a platform.config_area, p_row jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_object_agg(c, p_row -> c), '{}'::jsonb) from unnest(a.value_columns) c
$$;

-- BEFORE INSERT OR UPDATE on every registered table (TG_ARGV[0] = area): the row needs an approved change record that
-- covers the area, or the software-release identity.
create function platform.config_change_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx jsonb := kernel.current_actor();
begin
  if v_ctx is not null and platform.is_release_actor(v_ctx) then
    return new;
  end if;
  perform platform.require_change_record(tg_argv[0], format('%s on %s', lower(tg_op), tg_relid::regclass));
  return new;
end
$$;

-- AFTER INSERT on every registered table: the row becomes a configuration version.
create function platform.config_version_log() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  a      platform.config_area;
  v_ctx  jsonb := kernel.current_actor();
  v_row  jsonb := to_jsonb(new);
  v_rel  boolean := platform.is_release_actor(v_ctx);
  v_cr   uuid;
begin
  select * into a from platform.config_area where code = tg_argv[0];
  if not v_rel then
    v_cr := platform.require_change_record(a.code, format('insert on %s', tg_relid::regclass));
  end if;
  insert into platform.config_version (area, item_key, value, valid_from, source_row, basis, change_record_id, person_id)
  values (a.code, platform.config_item_key(a, v_row), platform.config_item_value(a, v_row),
          coalesce((v_row ->> a.valid_from_column)::timestamptz, clock_timestamp()), v_row,
          case when v_rel then 'RELEASE' else 'CHANGE_RECORD' end, v_cr,
          case when v_rel then null else (v_ctx ->> 'person_id')::uuid end);
  return null;
end
$$;

-- Owner-only (migrations): put a table under configuration change control. Installs the guard and the version log and
-- back-fills the rows already in the table as versions (BEFORE_CONTROL, or RELEASE for rows of the release identity
-- where the table records who wrote them).
create function platform.register_config_area(p_code text, p_table regclass, p_description text, p_key_columns text[],
                                              p_value_columns text[], p_valid_from_column text, p_recorded_column text)
returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  a platform.config_area;
  c text;
begin
  foreach c in array p_key_columns || p_value_columns || array[p_valid_from_column, p_recorded_column] loop
    if not exists (select 1 from pg_catalog.pg_attribute t where t.attrelid = p_table and t.attname = c and t.attnum > 0 and not t.attisdropped) then
      raise exception using errcode = 'P0001', message = format('EBMR-CFG-010 %s has no column %s', p_table, c);
    end if;
  end loop;
  insert into platform.config_area (code, table_name, description, key_columns, value_columns, valid_from_column, recorded_column)
  values (p_code, p_table, p_description, p_key_columns, p_value_columns, p_valid_from_column, p_recorded_column)
  returning * into a;
  execute format('create trigger a00_config_change before insert or update on %s for each row execute function platform.config_change_guard(%L)', p_table, p_code);
  execute format('create trigger zz_config_version after insert on %s for each row execute function platform.config_version_log(%L)', p_table, p_code);
  execute format(
    'insert into platform.config_version (area, item_key, value, valid_from, source_row, basis)
     select %L, platform.config_item_key(a, to_jsonb(t)), platform.config_item_value(a, to_jsonb(t)),
            (to_jsonb(t) ->> %L)::timestamptz, to_jsonb(t), ''BEFORE_CONTROL''
       from %s t cross join (select * from platform.config_area where code = %L) a
      order by (to_jsonb(t) ->> %L)::timestamptz', p_code, p_valid_from_column, p_table, p_code, p_recorded_column);
end
$$;
revoke all on function platform.register_config_area(text, regclass, text, text[], text[], text, text) from public;

-- ---------------------------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------------------------

-- Raise a change record: {number, title, description, areas: [area codes]}. Returns its id.
create function platform.raise_change_record(p_def jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, kernel, pg_temp as $$
declare
  v_actor jsonb;
  v_areas text[];
  v_id    uuid;
  v_bad   text;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('CONFIG.CHANGE_RAISE', '{}'::jsonb);
  if jsonb_typeof(p_def -> 'areas') is distinct from 'array' or jsonb_array_length(p_def -> 'areas') = 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-CFG-011 a change record names at least one configuration area';
  end if;
  select array_agg(distinct x order by x) into v_areas from jsonb_array_elements_text(p_def -> 'areas') x;
  select string_agg(x, ', ') into v_bad from unnest(v_areas) x where not exists (select 1 from platform.config_area a where a.code = x);
  if v_bad is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-CFG-011 unknown configuration area %s', v_bad);
  end if;
  if kernel.is_blank(p_def ->> 'number') or kernel.is_blank(p_def ->> 'title') or kernel.is_blank(p_def ->> 'description') then
    raise exception using errcode = 'P0001', message = 'EBMR-CFG-012 a change record needs a number, a title and a description';
  end if;
  if exists (select 1 from platform.change_record c where c.number = btrim(p_def ->> 'number')) then
    raise exception using errcode = 'P0001', message = format('EBMR-CFG-012 change record %s already exists', btrim(p_def ->> 'number'));
  end if;
  insert into platform.change_record (number, title, description, areas, raised_by_person, raised_by_account)
  values (btrim(p_def ->> 'number'), btrim(p_def ->> 'title'), btrim(p_def ->> 'description'), v_areas,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- Record the approval: the caller's own CONFIG_CHANGE_APPROVED e-signature of the record, which must be OPEN; the person
-- who raised it cannot approve it.
create function platform.approve_change_record(p_number text, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, esig, kernel, pg_temp as $$
declare
  v_actor  jsonb;
  r        platform.change_record;
  v_signer uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('CONFIG.CHANGE_APPROVE', '{}'::jsonb);
  select * into r from platform.change_record c where c.number = p_number for update;
  if r.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-CFG-002 change record %s does not exist (DI-09)', p_number);
  end if;
  if platform.change_record_state(r.id) <> 'OPEN' then
    raise exception using errcode = 'P0001', message = format('EBMR-CFG-013 change record %s is %s; only an open record is approved',
                                                               p_number, platform.change_record_state(r.id));
  end if;
  if p_signature is null then
    raise exception using errcode = 'P0001', message = format('EBMR-CFG-013 the approval of change record %s is an e-signature', p_number);
  end if;
  v_signer := (esig.assert_signature(p_signature, 'CONFIG_CHANGE_APPROVED', 'config_change_record', r.number) ->> 'signer_person')::uuid;
  if v_signer is distinct from (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = format('EBMR-CFG-014 change record %s: the approver records their own signature', p_number);
  end if;
  if v_signer = r.raised_by_person then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-CFG-014 change record %s: the person who raised it cannot approve it; another person of the quality unit signs (DI-09)', p_number);
  end if;
  insert into platform.change_record_event (change_record_id, event, signature_id, person_id, account_id)
  values (r.id, 'APPROVED', p_signature, v_signer, (v_actor ->> 'account_id')::uuid);
end
$$;

-- Close a change record: no configuration changes under it afterwards.
create function platform.close_change_record(p_number text, p_note text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, kernel, pg_temp as $$
declare
  v_actor jsonb;
  r       platform.change_record;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('CONFIG.CHANGE_CLOSE', '{}'::jsonb);
  select * into r from platform.change_record c where c.number = p_number for update;
  if r.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-CFG-002 change record %s does not exist (DI-09)', p_number);
  end if;
  if platform.change_record_state(r.id) = 'CLOSED' then
    raise exception using errcode = 'P0001', message = format('EBMR-CFG-015 change record %s is already closed', p_number);
  end if;
  if kernel.is_blank(p_note) then
    raise exception using errcode = 'P0001', message = format('EBMR-CFG-015 closing change record %s needs a note', p_number);
  end if;
  insert into platform.change_record_event (change_record_id, event, person_id, account_id, note)
  values (r.id, 'CLOSED', (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, btrim(p_note));
end
$$;

-- Signed content of a change record (aggregate config_change_record, id = its number). The content never changes after
-- the record is raised, so the approval stays valid; the state is OPEN, APPROVED or CLOSED; its author is the raiser.
create function platform.change_record_content(p_id text) returns jsonb
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
    'content', jsonb_build_object('number', r.number, 'title', r.title, 'description', r.description, 'areas', to_jsonb(r.areas),
                                  'raised_by', r.raised_by_person, 'raised_at', to_char(r.raised_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
    'state', platform.change_record_state(r.id),
    'entered_by', jsonb_build_array(r.raised_by_person));
end
$$;
select esig.register_content_provider('config_change_record', 'platform.change_record_content(text)',
  'Configuration change record (DI-09): number, title, description, areas and who raised it');

-- ---------------------------------------------------------------------------------------------
-- Reads: the configuration of any instant and the difference between two instants (D-P6f-1)
-- ---------------------------------------------------------------------------------------------

-- Every configuration item's version valid at p_at (the latest version whose validity started at or before it).
create function platform.config_as_of(p_at timestamptz)
returns table (area text, item_key text, value jsonb, valid_from timestamptz, version_id bigint, basis text, change_record text)
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select distinct on (v.area, v.item_key) v.area, v.item_key, v.value, v.valid_from, v.id, v.basis, c.number
  from platform.config_version v left join platform.change_record c on c.id = v.change_record_id
  where v.valid_from <= p_at
  order by v.area, v.item_key, v.valid_from desc, v.id desc
$$;

-- The items whose valid version differs between p_from and p_to, with the value at each instant (NULL when the item had
-- no version yet) and the change records of the versions that took effect in between.
create function platform.config_diff(p_from timestamptz, p_to timestamptz)
returns table (area text, item_key text, value_before jsonb, value_after jsonb, change_records text[])
language plpgsql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception using errcode = 'P0001', message = 'EBMR-CFG-016 a configuration diff needs two instants, the first not after the second';
  end if;
  return query
    with b as (select * from platform.config_as_of(p_from)), a as (select * from platform.config_as_of(p_to))
    select coalesce(a.area, b.area), coalesce(a.item_key, b.item_key), b.value, a.value,
           array(select distinct c.number from platform.config_version v join platform.change_record c on c.id = v.change_record_id
                  where v.area = coalesce(a.area, b.area) and v.item_key = coalesce(a.item_key, b.item_key)
                    and v.valid_from > p_from and v.valid_from <= p_to order by 1)
    from a full join b on a.area = b.area and a.item_key = b.item_key
    where a.version_id is distinct from b.version_id and a.value is distinct from b.value
    order by 1, 2;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The configuration areas of the kernel
-- ---------------------------------------------------------------------------------------------

select platform.register_config_area('PLATFORM_SETTING', 'platform.setting_value',
  'Platform settings: site values of the platform, adapter modes and mirror freshness bounds (6a), reading ages',
  array['key'], array['value'], 'recorded_at', 'recorded_at');
select platform.register_config_area('IAM_POLICY', 'iam.policy_value',
  'Identity and access policies: lockout, idle lock, password rules, the site time zone',
  array['key'], array['value'], 'recorded_at', 'recorded_at');
select platform.register_config_area('ESIG_POLICY', 'esig.policy_value',
  'E-signature policies', array['key'], array['value'], 'recorded_at', 'recorded_at');
select platform.register_config_area('ESIG_MEANING', 'esig.meaning_type',
  'The signature catalogue: meanings, who may sign them and how',
  array['code'], array['version', 'status', 'category', 'role_class', 'title', 'meaning_text', 'permissions', 'independent_of',
                       'excludes_performers', 'excludes_involved', 'witness', 'reauth', 'delegable'],
  'recorded_at', 'recorded_at');
select platform.register_config_area('MARKET_POLICY', 'market.policy_version',
  'Market policy switches: each version from its effective instant',
  array['policy_code'], array['version', 'position', 'direction', 'effective_from'], 'effective_from', 'recorded_at');
select platform.register_config_area('SITE_VALUE', 'market.site_value',
  'Site values of market rule keys (a site''s own limits and settings within the rule tables)',
  array['site_id', 'key', 'effective_from'], array['value', 'unit', 'outcome', 'justification_ref'], 'recorded_at', 'recorded_at');

select kernel.set_actor_context(null);

revoke all on function platform.change_record_state(uuid), platform.is_release_actor(jsonb), platform.require_change_record(text, text),
                       platform.config_item_key(platform.config_area, jsonb), platform.config_item_value(platform.config_area, jsonb),
                       platform.config_change_guard(), platform.config_version_log(), platform.raise_change_record(jsonb),
                       platform.approve_change_record(text, uuid), platform.close_change_record(text, text),
                       platform.change_record_content(text), platform.config_as_of(timestamptz),
                       platform.config_diff(timestamptz, timestamptz) from public;
grant execute on function platform.change_record_state(uuid), platform.raise_change_record(jsonb), platform.approve_change_record(text, uuid),
                          platform.close_change_record(text, text), platform.change_record_content(text),
                          platform.config_as_of(timestamptz), platform.config_diff(timestamptz, timestamptz) to ebmr_app;

reset role;
