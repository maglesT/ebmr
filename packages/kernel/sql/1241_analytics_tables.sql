-- Phase 6A slice 6A-0: the analytics tables (ADR 0020 points 4 and 6; draft controls DI-51, DI-52, DI-53; interfaces
-- slice-6A-0-interfaces.md section 2; D-6A-0-1, D-6A-0-3).
--
-- Handbook: modules/analytics.md
--
-- Every table is owned by ebmr_owner, registered with the kernel's hash-chained audit trail as insert-only (UPDATE,
-- DELETE and TRUNCATE are refused: EBMR-AUDIT-004), and keeps its event times on the database clock. No role but the
-- owner reads or writes them: the runner writes through the kernel 1242 functions, the screens read the kernel 1243
-- views. Nothing outside the schema refers to them (no foreign key, view, function or trigger; DI-51).
--   analytics.input_registry    the inputs the analytics role may read: a report view (VIEW) or a parameterised row
--                               function (FUNCTION), with its version, owning slice and grain (D-6A-0-2). Written by
--                               migrations only, through analytics.register_input (kernel 1242).
--   analytics.method_version    configuration area ANALYTICS_METHOD (DI-09 change control): a method version with its
--                               intended use, acceptance criteria, parameters and their SHA-256, code identity and
--                               validation reference. A version is retired by a later row of the same method and
--                               version with status RETIRED.
--   analytics.reference_set     configuration area ANALYTICS_REFERENCE: a QA-approved reference set and its fitted model,
--                               whose SHA-256 must equal the model candidate it was approved from (EBMR-ANA-010).
--   analytics.run, run_end      one run of a method version over recorded inputs, and its end (DONE or FAILED, once).
--   analytics.output, flag      advisory outputs and flags of a run, each with its reasons; a flag about a PERSON or an
--                               ACCOUNT is restricted (readable only through analytics.person_flags; DI-53).
--   analytics.flag_disposition  QA's verdict on a flag, by the person who gave it; a later one supersedes the current one
--                               with a reason (kernel 1242 analytics.record_disposition).
-- Columns beyond the interface notes (additive): an id per method-version row, recorded_at on both configuration
-- tables (the configuration history's recorded column), and kind and description on the input registry.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1241_analytics_tables)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the analytics tables: inputs, method versions, reference sets, runs, outputs, flags, dispositions (DI-51, DI-52)'));

create table analytics.input_registry (
  name           text primary key check (name ~ '^report\.[a-z][a-z0-9_]*_v[1-9][0-9]*(\(.*\))?$'),
  kind           text not null check (kind in ('VIEW', 'FUNCTION')),
  version        integer not null check (version >= 1),
  owner_slice    text not null check (owner_slice ~ '^6A-[0-9]$'),
  grain          text not null check (btrim(grain) <> ''),
  description    text not null check (btrim(description) <> ''),
  registered_at  timestamptz not null default clock_timestamp(),
  check ((kind = 'FUNCTION') = (name like '%(%'))
);

create table analytics.method_version (
  id                 uuid primary key default gen_random_uuid(),
  method             text not null check (method ~ '^[A-Z]+(\.[A-Z0-9_]+)+$'),
  version            integer not null check (version >= 1),
  status             text not null check (status in ('EFFECTIVE', 'RETIRED')),
  title              text not null check (btrim(title) <> ''),
  intended_use       text not null check (btrim(intended_use) <> ''),
  acceptance         jsonb not null check (jsonb_typeof(acceptance) = 'object'),
  parameters         jsonb not null check (jsonb_typeof(parameters) = 'object'),
  parameters_sha256  text not null check (parameters_sha256 ~ '^[0-9a-f]{64}$'),
  code_identity      text not null check (btrim(code_identity) <> ''),
  validation_ref     text not null check (btrim(validation_ref) <> ''),
  valid_from         timestamptz not null default clock_timestamp(),
  recorded_at        timestamptz not null default clock_timestamp(),
  unique (method, version, valid_from)
);

create table analytics.run (
  id             uuid primary key,
  method         text not null,
  version        integer not null check (version >= 1),
  reference_set  uuid,
  trigger        text not null check (trigger in ('SCHEDULED', 'BATCH_COMPLETE', 'ON_DEMAND')),
  inputs         jsonb not null check (jsonb_typeof(inputs) = 'array' and jsonb_array_length(inputs) >= 1),
  runtime        jsonb not null check (jsonb_typeof(runtime) = 'object'),
  started_at     timestamptz not null default clock_timestamp()
);
create index run_method_started on analytics.run (method, version, started_at);

create table analytics.run_end (
  run            uuid primary key references analytics.run (id),
  status         text not null check (status in ('DONE', 'FAILED')),
  output_sha256  text check (output_sha256 ~ '^[0-9a-f]{64}$'),
  counts         jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object'),
  error          text,
  ended_at       timestamptz not null default clock_timestamp(),
  check ((status = 'DONE') = (output_sha256 is not null)),
  check ((status = 'FAILED') = (error is not null and btrim(error) <> ''))
);

create table analytics.output (
  id            uuid primary key default gen_random_uuid(),
  run           uuid not null references analytics.run (id),
  subject_kind  text not null check (subject_kind in ('BATCH', 'PRODUCT_ITEM', 'GROUP', 'EQUIPMENT_STEP_TAG', 'PERSON', 'ACCOUNT', 'METHOD')),
  subject_ref   text not null check (btrim(subject_ref) <> ''),
  kind          text not null check (kind in ('CONTROL_CHART', 'CAPABILITY', 'DRIFT', 'RATE_COMPARISON', 'MODEL_CANDIDATE', 'MSPC_SCORE',
                                              'AUDIT_RULE_HIT', 'AUDIT_BASELINE', 'REVIEW_PRIORITY', 'PROFILE_DISTANCE')),
  "values"      jsonb not null check (jsonb_typeof("values") = 'object'),
  reasons       jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  recorded_at   timestamptz not null default clock_timestamp()
);
create index output_run on analytics.output (run);
create index output_kind_subject on analytics.output (kind, subject_kind, subject_ref);

create table analytics.flag (
  id            uuid primary key default gen_random_uuid(),
  run           uuid not null references analytics.run (id),
  output        uuid references analytics.output (id),
  subject_kind  text not null check (subject_kind in ('BATCH', 'PRODUCT_ITEM', 'GROUP', 'EQUIPMENT_STEP_TAG', 'PERSON', 'ACCOUNT', 'METHOD')),
  subject_ref   text not null check (btrim(subject_ref) <> ''),
  rule          text not null check (rule ~ '^[A-Z][A-Z0-9_]*$'),
  severity      text not null check (severity in ('INFO', 'ATTENTION', 'HIGH')),
  reasons       jsonb not null check (jsonb_typeof(reasons) = 'array' and jsonb_array_length(reasons) >= 1),
  restricted    boolean not null,
  raised_at     timestamptz not null default clock_timestamp(),
  check (restricted = (subject_kind in ('PERSON', 'ACCOUNT')))
);
create index flag_run on analytics.flag (run);
create index flag_restricted_raised on analytics.flag (restricted, raised_at);

create table analytics.flag_disposition (
  id             uuid primary key default gen_random_uuid(),
  flag           uuid not null references analytics.flag (id),
  verdict        text not null check (verdict in ('TRUE_SIGNAL', 'FALSE_ALARM', 'NOT_ASSESSABLE')),
  cause          text not null check (char_length(btrim(cause)) >= 10),
  deviation_ref  text check (deviation_ref is null or btrim(deviation_ref) <> ''),
  supersedes     uuid references analytics.flag_disposition (id),
  reason         text,
  person_id      uuid not null,
  account_id     uuid not null,
  recorded_at    timestamptz not null default clock_timestamp(),
  check (supersedes is null or (reason is not null and btrim(reason) <> '')),
  check (supersedes is null or supersedes <> id)
);
-- One first disposition per flag, and each disposition superseded at most once: the current one is the only one
-- nothing supersedes.
create unique index flag_disposition_first on analytics.flag_disposition (flag) where supersedes is null;
create unique index flag_disposition_supersedes on analytics.flag_disposition (supersedes) where supersedes is not null;

create table analytics.reference_set (
  id                uuid not null,
  method            text not null check (method ~ '^[A-Z]+(\.[A-Z0-9_]+)+$'),
  scope             jsonb not null check (jsonb_typeof(scope) = 'object'),
  batch_ids         uuid[] not null check (cardinality(batch_ids) >= 1),
  candidate_output  uuid not null references analytics.output (id),
  model             jsonb not null check (jsonb_typeof(model) = 'object'),
  model_sha256      text not null check (model_sha256 ~ '^[0-9a-f]{64}$'),
  status            text not null check (status in ('EFFECTIVE', 'RETIRED')),
  valid_from        timestamptz not null default clock_timestamp(),
  recorded_at       timestamptz not null default clock_timestamp(),
  primary key (id, valid_from)
);

-- EBMR-ANA-010: a reference set's model is the model candidate QA approved: a MODEL_CANDIDATE output of a DONE run of
-- the same method, whose recorded model hash ("values".modelSha256) equals the set's. ("values" is quoted everywhere:
-- VALUES is a reserved word.)
create function analytics.reference_model_check() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  v_ok boolean;
begin
  select o.kind = 'MODEL_CANDIDATE' and r.method = new.method and e.status = 'DONE' and o."values" ->> 'modelSha256' = new.model_sha256
    into v_ok
    from analytics.output o
    join analytics.run r on r.id = o.run
    left join analytics.run_end e on e.run = r.id
   where o.id = new.candidate_output;
  if not coalesce(v_ok, false) then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ANA-010 reference set %s: its model must be the model candidate it was approved from (a MODEL_CANDIDATE output of a completed %s run with the model SHA-256 %s) (DI-52)',
      new.id, new.method, new.model_sha256);
  end if;
  return new;
end
$$;
revoke all on function analytics.reference_model_check() from public;
create trigger a10_reference_model before insert on analytics.reference_set for each row execute function analytics.reference_model_check();

revoke all on analytics.input_registry, analytics.method_version, analytics.reference_set, analytics.run, analytics.run_end,
              analytics.output, analytics.flag, analytics.flag_disposition from public;

select platform.enforce_db_time('analytics.input_registry', array['registered_at']);
select platform.enforce_db_time('analytics.method_version', array['recorded_at']);
select platform.enforce_db_time('analytics.reference_set', array['recorded_at']);
select platform.enforce_db_time('analytics.run', array['started_at']);
select platform.enforce_db_time('analytics.run_end', array['ended_at']);
select platform.enforce_db_time('analytics.output', array['recorded_at']);
select platform.enforce_db_time('analytics.flag', array['raised_at']);
select platform.enforce_db_time('analytics.flag_disposition', array['recorded_at']);

select kernel.register_audited_table('analytics.input_registry', 'analytics_input', 'name', true);
select kernel.register_audited_table('analytics.method_version', 'analytics_method', 'method', true);
select kernel.register_audited_table('analytics.reference_set', 'analytics_reference', 'id', true);
select kernel.register_audited_table('analytics.run', 'analytics_run', 'id', true);
select kernel.register_audited_table('analytics.run_end', 'analytics_run', 'run', true);
select kernel.register_audited_table('analytics.output', 'analytics_run', 'run', true);
select kernel.register_audited_table('analytics.flag', 'analytics_flag', 'id', true);
select kernel.register_audited_table('analytics.flag_disposition', 'analytics_flag', 'flag', true);

-- DI-09 with DI-52: method versions and reference sets change only under an approved change record naming the area.
select platform.register_config_area('ANALYTICS_METHOD', 'analytics.method_version',
  'Analytics method versions: intended use, acceptance criteria, parameters and their SHA-256, code identity and validation reference (advisory analytics, DI-52)',
  array['method', 'version'],
  array['status', 'title', 'intended_use', 'acceptance', 'parameters', 'parameters_sha256', 'code_identity', 'validation_ref'],
  'valid_from', 'recorded_at');
select platform.register_config_area('ANALYTICS_REFERENCE', 'analytics.reference_set',
  'Analytics reference sets: the QA-approved reference batches of a method and the fitted model with its SHA-256 (advisory analytics, DI-52)',
  array['id'],
  array['method', 'scope', 'batch_ids', 'candidate_output', 'model', 'model_sha256', 'status'],
  'valid_from', 'recorded_at');

select kernel.set_actor_context(null);

reset role;
