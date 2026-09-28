-- Recipe core, execution store (module C3), part 1: tables, permission catalogue entries and helpers.
--
-- Phase 2 apps plan section 7; ADR 0004 (engine step(state, command, clock)), 0006 (commands), 0010 (a
-- record is re-executed with the engine it ran on), 0012 (privilege separation), 0016 (validated actor,
-- definer hardening). Controls DI-05, DI-34, DI-37 (execution part), PR-08; invariants INV-03, INV-09,
-- INV-10, INV-16, INV-18, INV-19, INV-20, INV-25, INV-26, INV-40.
--
-- The pure engine (packages/recipe-core/src/engine) decides; this schema stores what it decided and
-- re-checks everything a database can check on its own:
--   * one row per engine call (ISSUE, COMMAND, PREPARE, SWEEP) in recipe.execution_command, numbered per
--     batch without gaps and hash-chained, with the trusted database time it ran at (INV-16), the actor
--     and device of the command, the badge-tap event on shared terminals (INV-40), the engine's verdict,
--     and the hashes of the resulting state and of the events (recomputed here from the JSON);
--   * the events of each row (recipe.execution_event) and the resulting state (recipe.execution_state,
--     the projection of the last row);
--   * the signable content of steps, stages, exceptions and data points, one insert-only row per content
--     version, registered with the e-signature module so a new version supersedes the signatures made on
--     the previous one (INV-09) and a signature is checked against it (INV-10).
-- Phase 2 runs batches only in the sandbox (test runs of MBR versions): every writer refuses a GMP
-- installation (DI-05, INV-18). The same tables exist in GMP databases, empty.
--
-- Privileges: the application role (ebmr_app; in a sandbox the mirrored ebmr_sandbox) reads these tables
-- and writes nothing directly. Every write is a SECURITY DEFINER function (0210).
--
-- Messages are plain language first, then the control and the code EBMR-EXE-NNN in brackets:
--   001-009 actor, installation, generic   010-019 packages and issue   020-029 clock and sequence
--   030-039 state, events, roles           040-049 attribution          050-059 signatures and content

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Permission catalogue: the in-process sweeper (a SERVICE account, source SYSTEM) evaluates time
-- constraints of running batches. Written under the software-release identity, like kernel 0700.
-- ---------------------------------------------------------------------------------------------

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0200_execution_store)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'permission of the execution sweeper (INV-20, DI-17)'));

insert into iam.permission (code, domain, effect, description) values
  ('EXECUTION.SWEEP', 'GMP', 'WRITE',
   'Evaluate the time constraints of running batches and record the breaches (the in-process sweeper; a system service account)');

insert into iam.role_permission (role_code, permission_code) values ('SERVICE_ACCOUNT', 'EXECUTION.SWEEP');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Engine roles and the permission that must allow each (INV-26). The edition maps its kernel roles to
-- these (tablets: tab.engine_role_map); append_execution accepts an engine role on a command only with
-- a stored authority evaluation of this permission made in the same command.
-- ---------------------------------------------------------------------------------------------

create table recipe.engine_role_permission (
  engine_role  text not null check (engine_role ~ '^[A-Z][A-Z_]{1,39}$'),
  permission   text not null references iam.permission (code),
  primary key (engine_role, permission)
);
revoke all on recipe.engine_role_permission from public;

insert into recipe.engine_role_permission (engine_role, permission) values
  ('PRODUCTION_OPERATOR', 'STEP.EXECUTE'),
  ('DISPENSER', 'DISPENSE.EXECUTE'),
  ('PRODUCTION_VERIFIER', 'STEP.VERIFY'),
  ('PRODUCTION_SUPERVISOR', 'STEP.SUPERVISE'),
  ('STAGE_RESPONSIBLE', 'RECORD.PRODUCTION_APPROVE'),
  ('HEAD_OF_PRODUCTION', 'RECORD.PRODUCTION_APPROVE'),
  ('QA', 'QA.FLOOR_APPROVE'),
  ('QA_REVIEWER', 'RECORD.QA_REVIEW');

create trigger aa_insert_only before update or delete on recipe.engine_role_permission for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.engine_role_permission for each statement execute function kernel.reject_mutation();

-- Which permission a command needs (any one of the list, held in the role declared in the command, at
-- the actor's location). PREPARE rows need the permission of the command they prepare. Command types
-- that are not listed are not available in Phase 2 (skip, void, invalidation, abort, cancel: A2).
create table recipe.execution_command_permission (
  command_type  text primary key check (command_type ~ '^[A-Z][A-Z_]{1,39}$'),
  permissions   text[] not null check (cardinality(permissions) >= 1),
  signed        boolean not null default false
);
revoke all on recipe.execution_command_permission from public;

insert into recipe.execution_command_permission (command_type, permissions, signed) values
  ('ISSUE', array['BATCH.ISSUE'], false),
  ('SWEEP', array['EXECUTION.SWEEP'], false),
  ('START_STEP', array['STEP.EXECUTE', 'DISPENSE.EXECUTE'], false),
  ('RECORD_DATA', array['STEP.EXECUTE', 'DISPENSE.EXECUTE'], false),
  ('RECORD_ENTRY', array['STEP.EXECUTE', 'DISPENSE.EXECUTE'], false),
  ('SIGN_PERFORMED', array['STEP.SIGN_PERFORMED'], true),
  ('VERIFY', array['STEP.VERIFY', 'STEP.WITNESS'], true),
  ('DISPOSITION_HOLD_POINT', array['QA.FLOOR_APPROVE'], true),
  ('SIGN_OFF_STAGE', array['STEP.SUPERVISE', 'RECORD.PRODUCTION_APPROVE'], true),
  ('RAISE_EXCEPTION', array['STEP.EXECUTE', 'DISPENSE.EXECUTE', 'STEP.VERIFY', 'STEP.SUPERVISE', 'QA.FLOOR_APPROVE', 'RECORD.PRODUCTION_APPROVE'], false),
  ('ATTACH_DEVIATION', array['STEP.SUPERVISE', 'QA.FLOOR_APPROVE'], false),
  ('DISPOSITION_EXCEPTION', array['QA.FLOOR_APPROVE', 'RECORD.QA_REVIEW'], true),
  ('HOLD_BATCH', array['STEP.SUPERVISE', 'QA.FLOOR_APPROVE'], false),
  ('RELEASE_HOLD', array['STEP.SUPERVISE', 'QA.FLOOR_APPROVE'], false),
  ('CORRECT_ENTRY', array['STEP.EXECUTE', 'DISPENSE.EXECUTE', 'STEP.SUPERVISE', 'QA.FLOOR_APPROVE'], true),
  ('CHOOSE_ALTERNATIVE', array['STEP.SUPERVISE'], false),
  ('CHOOSE_REPLICATE_COUNT', array['STEP.SUPERVISE'], false),
  ('COMPLETE_LOOP_ITERATION', array['STEP.EXECUTE', 'DISPENSE.EXECUTE'], false);

create trigger aa_insert_only before update or delete on recipe.execution_command_permission for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.execution_command_permission for each statement execute function kernel.reject_mutation();

-- Block versions that may run only in the sandbox (decision D3; the registry's SANDBOX_ONLY versions).
-- execution_violations() reports any of them in content a GMP database holds.
create table recipe.sandbox_only_block (
  block_type     text not null,
  block_version  text not null,
  reason         text not null,
  primary key (block_type, block_version)
);
revoke all on recipe.sandbox_only_block from public;
insert into recipe.sandbox_only_block (block_type, block_version, reason) values
  ('G-09', '1', 'Equipment status by manual attestation; database-backed status arrives in Phase 3'),
  ('G-10', '1', 'Clearance checklist by manual attestation; database-backed room and line status arrives in Phase 3');
create trigger aa_insert_only before update or delete on recipe.sandbox_only_block for each row execute function kernel.reject_mutation();

-- ---------------------------------------------------------------------------------------------
-- Test packages (the MBR version content a test run executes) and test batches
-- ---------------------------------------------------------------------------------------------

create table recipe.test_package (
  package_hash         text primary key check (package_hash ~ '^[0-9a-f]{64}$'),
  file_name            text not null check (file_name = package_hash || '.json'),
  package              jsonb not null,
  content              jsonb not null,
  content_hash         text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  family_id            uuid not null,
  family_code          text not null,
  product              jsonb not null,
  version_id           uuid not null,
  version_number       text not null,
  revision             integer not null check (revision >= 0),
  version_state        text not null,
  exporter             jsonb not null,
  exported_at_us       bigint not null,
  source               jsonb not null,
  imported_at          timestamptz not null default clock_timestamp(),
  imported_by_person   uuid not null,
  imported_by_account  uuid not null,
  correlation_id       uuid not null
);
revoke all on recipe.test_package from public;

create sequence recipe.test_batch_number_seq as bigint minvalue 1 no cycle;
revoke all on sequence recipe.test_batch_number_seq from public;

create table recipe.batch_execution (
  id                    uuid primary key,
  batch_number          text not null unique,
  package_hash          text not null references recipe.test_package (package_hash),
  content_hash          text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  installation          text not null check (installation = 'SANDBOX'),
  purpose               text not null check (purpose in ('SANDBOX_TEST_RUN')),
  engine_version        text not null,
  registry_fingerprint  text not null check (registry_fingerprint ~ '^[0-9a-f]{64}$'),
  policy                jsonb not null,
  policy_hash           text not null check (policy_hash ~ '^[0-9a-f]{64}$'),
  issue_request         jsonb not null,
  market_set            text[] not null check (cardinality(market_set) >= 1),
  batch_size            text not null,
  site_code             text not null,
  room_code             text,
  site_zone             text not null,
  issued_at             timestamptz not null default clock_timestamp(),
  issued_at_us          bigint not null,
  issued_by_person      uuid not null,
  issued_by_account     uuid not null,
  correlation_id        uuid not null
);
revoke all on recipe.batch_execution from public;

-- TEST- batch numbers in the sandbox; a GMP database refuses them (DI-05, INV-18; kernel 0810).
create trigger ab_sandbox_identifier_guard before insert or update on recipe.batch_execution
  for each row execute function sandbox.guard_identifier('BATCH_NUMBER', 'batch_number');

-- ---------------------------------------------------------------------------------------------
-- Engine calls, events, projection
-- ---------------------------------------------------------------------------------------------

create table recipe.execution_command (
  batch_id        uuid not null references recipe.batch_execution (id),
  seq             bigint not null check (seq >= 1),
  kind            text not null check (kind in ('ISSUE', 'COMMAND', 'PREPARE', 'SWEEP')),
  command_id      text not null unique check (btrim(command_id) <> ''),
  command_type    text not null,
  command         jsonb not null,
  command_hash    text not null check (command_hash ~ '^[0-9a-f]{64}$'),
  actor_person    uuid not null,
  actor_account   uuid not null,
  actor_role      text not null,
  actor_legal_name text,
  source          text not null check (source in ('UI', 'API', 'INTEGRATION', 'SYSTEM')),
  session_id      uuid not null,
  device_id       uuid,
  device_class    text not null,
  room_code       text,
  auth_event_id   uuid,
  now_us          bigint not null,
  accepted        boolean not null,
  refusal         jsonb,
  state_version   integer not null check (state_version >= 0),
  state_hash      text not null check (state_hash ~ '^[0-9a-f]{64}$'),
  events_hash     text not null check (events_hash ~ '^[0-9a-f]{64}$'),
  event_count     integer not null check (event_count >= 0),
  roles           jsonb not null default '[]'::jsonb,
  signature_ids   uuid[] not null default '{}',
  evidence        jsonb not null default '{}'::jsonb,
  prev_row_hash   text not null check (prev_row_hash ~ '^[0-9a-f]{64}$'),
  row_hash        text not null check (row_hash ~ '^[0-9a-f]{64}$'),
  correlation_id  uuid not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  primary key (batch_id, seq),
  check ((kind = 'ISSUE') = (seq = 1)),
  check (accepted or refusal is not null)
);
revoke all on recipe.execution_command from public;

create table recipe.execution_event (
  batch_id    uuid not null,
  row_seq     bigint not null,
  idx         integer not null check (idx >= 0),
  event_type  text not null,
  event       jsonb not null,
  primary key (batch_id, row_seq, idx),
  foreign key (batch_id, row_seq) references recipe.execution_command (batch_id, seq)
);
revoke all on recipe.execution_event from public;
create trigger aa_insert_only before update or delete on recipe.execution_event for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.execution_event for each statement execute function kernel.reject_mutation();

-- The state after the last row (a projection, checked against the row chain by execution_violations).
create table recipe.execution_state (
  batch_id       uuid primary key references recipe.batch_execution (id),
  state          jsonb not null,
  state_version  integer not null,
  state_hash     text not null check (state_hash ~ '^[0-9a-f]{64}$'),
  last_seq       bigint not null,
  last_row_hash  text not null,
  status         text not null,
  updated_at     timestamptz not null default clock_timestamp()
);
revoke all on recipe.execution_state from public;
create trigger aa_no_truncate before truncate on recipe.execution_state for each statement execute function kernel.reject_mutation();

-- The trusted clock of the transaction (INV-16): recipe.lock_execution writes it, append_execution
-- accepts no other time. Owner only; unlogged (transaction-scoped markers, pruned per backend).
create unlogged table recipe.execution_clock (
  xact_id       xid8 not null,
  backend_pid   integer not null,
  batch_id      uuid not null,
  now_us        bigint not null,
  batch_number  text,
  primary key (xact_id, backend_pid, batch_id)
);
revoke all on recipe.execution_clock from public;

-- ---------------------------------------------------------------------------------------------
-- Signable content: one insert-only row per content version of a step, stage, exception or data point
-- (aggregate id `<batch id>:<key>`). The e-signature module supersedes signatures when a new version is
-- inserted (INV-09) and checks a signature against the latest version (INV-10).
-- ---------------------------------------------------------------------------------------------

create function recipe.create_content_table(p_name text, p_aggregate_type text) returns void
language plpgsql set search_path = pg_catalog, recipe, pg_temp as $$
begin
  execute format($f$
    create table recipe.%1$I (
      batch_id         uuid not null references recipe.batch_execution (id),
      aggregate_key    text not null check (btrim(aggregate_key) <> ''),
      aggregate_id     text not null,
      content_version  integer not null check (content_version >= 1),
      content          jsonb not null,
      content_hash     text not null check (content_hash ~ '^[0-9a-f]{64}$'),
      row_seq          bigint not null,
      recorded_at      timestamptz not null default clock_timestamp(),
      primary key (aggregate_id, content_version),
      check (aggregate_id = batch_id::text || ':' || aggregate_key),
      foreign key (batch_id, row_seq) references recipe.execution_command (batch_id, seq)
    )$f$, p_name);
  execute format('revoke all on recipe.%I from public', p_name);
  execute format('comment on table recipe.%I is %L', p_name, 'Signable content of ' || p_aggregate_type || ' aggregates (one row per content version; insert-only)');
end
$$;

select recipe.create_content_table('execution_step_content', 'batch_step');
select recipe.create_content_table('execution_stage_content', 'batch_stage');
select recipe.create_content_table('execution_exception_content', 'batch_exception');
select recipe.create_content_table('execution_point_content', 'batch_point');
drop function recipe.create_content_table(text, text);

-- The content table of an aggregate type.
create function recipe.content_table(p_aggregate_type text) returns regclass
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select case p_aggregate_type
           when 'batch_step' then 'recipe.execution_step_content'::regclass
           when 'batch_stage' then 'recipe.execution_stage_content'::regclass
           when 'batch_exception' then 'recipe.execution_exception_content'::regclass
           when 'batch_point' then 'recipe.execution_point_content'::regclass
         end
$$;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

-- The engine's context key of loop and replicate frames: [{construct, index}, ...] -> "c=1/d=2".
create function recipe.ctx_key(p_frames jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(string_agg((f.v ->> 'construct') || '=' || (f.v ->> 'index'), '/' order by f.i), '')
  from jsonb_array_elements(case when jsonb_typeof(p_frames) = 'array' then p_frames else '[]'::jsonb end) with ordinality as f (v, i)
$$;

-- SHA-256 of the canonical JSON of a value (the engine codec's hashJson; esig.canonical_json rules).
create function recipe.canonical_hash(p jsonb) returns text
language sql immutable strict set search_path = pg_catalog, esig, pg_temp as $$
  select esig.sha256_hex(esig.canonical_json(p))
$$;

-- An engine microsecond value (codec tag {"$u": "..."}) as bigint; null when absent.
create function recipe.micros_of(p jsonb) returns bigint
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(p) = 'object' and (p ->> '$u') ~ '^-?[0-9]{1,19}$' then (p ->> '$u')::bigint end
$$;

-- Person ids (UUIDs) in a JSON array of engine ids ('SYSTEM' and other non-UUID ids are left out).
create function recipe.person_ids(p jsonb) returns uuid[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(array_agg(distinct x::uuid) filter (where x ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), '{}')
  from jsonb_array_elements_text(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) x
$$;

-- The row hash of the execution chain: SHA-256 over the previous hash and the canonical row facts.
create function recipe.execution_row_hash(p_prev text, p_row recipe.execution_command) returns text
language sql immutable set search_path = pg_catalog, esig, recipe, pg_temp as $$
  select esig.sha256_hex(p_prev || '|' || esig.canonical_json(jsonb_build_object(
    'batch_id', p_row.batch_id, 'seq', p_row.seq::text, 'kind', p_row.kind, 'command_id', p_row.command_id,
    'command_type', p_row.command_type, 'command_hash', p_row.command_hash, 'actor_person', p_row.actor_person,
    'actor_account', p_row.actor_account, 'actor_role', p_row.actor_role, 'source', p_row.source, 'session_id', p_row.session_id,
    'device_id', p_row.device_id, 'device_class', p_row.device_class, 'auth_event_id', p_row.auth_event_id,
    'now_us', p_row.now_us::text, 'accepted', p_row.accepted, 'refusal', p_row.refusal, 'state_version', p_row.state_version,
    'state_hash', p_row.state_hash, 'events_hash', p_row.events_hash, 'event_count', p_row.event_count, 'roles', p_row.roles,
    'signature_ids', to_jsonb(p_row.signature_ids), 'evidence', p_row.evidence)))
$$;

create function recipe.execution_genesis_hash(p_batch uuid) returns text
language sql immutable set search_path = pg_catalog, esig, pg_temp as $$
  select esig.sha256_hex('genesis:batch:' || p_batch::text)
$$;

-- ---------------------------------------------------------------------------------------------
-- Proposed dispositions of exceptions (Part 11 signature/record linking; EU GMP Annex 11 section 14): the
-- outcome, justification and linked deviation a QA reviewer is about to sign, recorded when the signing
-- challenge is prepared and part of the signed content of the exception (the batch_exception provider adds
-- the latest proposal made on the current content version). Kept apart from the signed content table on
-- purpose: proposing is not a change of the exception's data, so it never makes the reviewer an "enterer"
-- of the record they then disposition (esig content_change, INV-03). Insert-only, audited.
-- ---------------------------------------------------------------------------------------------

create table recipe.execution_disposition_proposal (
  id                   bigint generated always as identity primary key,
  batch_id             uuid not null references recipe.batch_execution (id),
  exception_id         text not null check (btrim(exception_id) <> ''),
  aggregate_id         text not null,
  content_version      integer not null check (content_version >= 1),
  proposal             jsonb not null check (jsonb_typeof(proposal) = 'object'),
  proposed_by_person   uuid not null,
  proposed_by_account  uuid not null,
  correlation_id       uuid not null,
  proposed_at          timestamptz not null default clock_timestamp(),
  check (aggregate_id = batch_id::text || ':' || exception_id)
);
revoke all on recipe.execution_disposition_proposal from public;
create index execution_disposition_proposal_aggregate on recipe.execution_disposition_proposal (aggregate_id, content_version, id);

-- ---------------------------------------------------------------------------------------------
-- Audit registration: insert-only, on the batch chain batch:<id> (with the business entries)
-- ---------------------------------------------------------------------------------------------

select kernel.register_audited_table('recipe.test_package', 'test_package', 'package_hash', true);
select kernel.register_audited_table('recipe.batch_execution', 'batch', 'id', true);
select kernel.register_audited_table('recipe.execution_command', 'batch', 'batch_id', true);
select kernel.register_audited_table('recipe.execution_step_content', 'batch', 'batch_id', true);
select kernel.register_audited_table('recipe.execution_stage_content', 'batch', 'batch_id', true);
select kernel.register_audited_table('recipe.execution_exception_content', 'batch', 'batch_id', true);
select kernel.register_audited_table('recipe.execution_point_content', 'batch', 'batch_id', true);
select kernel.register_audited_table('recipe.execution_disposition_proposal', 'batch', 'batch_id', true);
select kernel.register_audited_table('recipe.execution_event', 'batch', 'batch_id', true);
-- Configuration shipped by migrations (insert-only; a later release adds rows under its own attribution).
select kernel.register_audited_table('recipe.engine_role_permission', 'engine_role_permission', 'engine_role', true);
select kernel.register_audited_table('recipe.execution_command_permission', 'execution_command_permission', 'command_type', true);
select kernel.register_audited_table('recipe.sandbox_only_block', 'sandbox_only_block', 'block_type', true);
-- Recorded times come from the database clock (DI-27), never from the caller.
select platform.enforce_db_time('recipe.execution_command', array['recorded_at']);
select platform.enforce_db_time('recipe.execution_step_content', array['recorded_at']);
select platform.enforce_db_time('recipe.execution_stage_content', array['recorded_at']);
select platform.enforce_db_time('recipe.execution_exception_content', array['recorded_at']);
select platform.enforce_db_time('recipe.execution_point_content', array['recorded_at']);
-- recipe.execution_state is not audited: it is a projection of the audited, hash-chained command rows, rebuilt
-- from them and checked against them by recipe.execution_violations(); it holds no fact of its own.

-- The app and sandbox roles read; they never write (every write is a definer function in 0210).
grant select on recipe.engine_role_permission, recipe.execution_command_permission, recipe.sandbox_only_block, recipe.test_package,
                recipe.batch_execution, recipe.execution_command, recipe.execution_event, recipe.execution_state,
                recipe.execution_step_content, recipe.execution_stage_content, recipe.execution_exception_content,
                recipe.execution_point_content, recipe.execution_disposition_proposal to ebmr_app;
grant execute on function recipe.ctx_key(jsonb), recipe.canonical_hash(jsonb), recipe.micros_of(jsonb), recipe.person_ids(jsonb),
                          recipe.execution_row_hash(text, recipe.execution_command), recipe.execution_genesis_hash(uuid),
                          recipe.content_table(text) to ebmr_app;

reset role;
