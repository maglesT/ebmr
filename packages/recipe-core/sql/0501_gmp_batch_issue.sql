-- Recipe core, execution store (module C3): the writers of a GMP batch, and the writers that stay sandbox-only (Phase 3
-- slice 2b items 1, 2 and 4; DI-05, INV-18, INV-01, INV-02, INV-27, IN-18, DI-17, DI-18, DI-35).
--
-- recipe.execution_actor (0210) is the first call of every execution writer: the validated actor with its session facts,
-- refusing administrators (DI-18) and, in Phase 2, every GMP database (sandbox.assert_sandbox_installation). It is now
-- installation-aware: it no longer refuses a GMP database, so the writers that act on a stored batch (lock, append,
-- proposals, the exception register's review, the approval of an act) run GMP batches as they run test batches, each
-- with its own permission check (DI-17). What exists only in the sandbox says so itself, first thing after the actor:
-- recipe.import_test_package, recipe.begin_issue and recipe.issue_execution (copied from their latest definitions,
-- 0210, 0240 and 0298, with only that line added) refuse a GMP database with EBMR-SBX-011, as before (DI-05, INV-18).
--
-- The GMP issue, three calls (the server's flow; docs/build-plan/phase-3/slice-2b-plan.md item 1):
--   1. recipe.prepare_gmp_issue(batch, {familyId, markets, site, line, batchSize, allocationId?}), one command: the
--      version the selection gives now (0170: INV-01, INV-28, PR-04, the authorisation cells with the approved size),
--      the batch number from the site's register (site.allocate_batch_number, BATCH_NUMBER.ALLOCATE; or a given
--      allocation never linked before), the planned batch (recipe.stub_batch, same id), the link of the allocation
--      (0500), the pin and the control recipe;
--   2. the issuer signs the batch_issue content of the batch (0500) with the meaning ISSUED (kernel 0210: BATCH.ISSUE);
--   3. in one command with that signature: recipe.begin_gmp_issue(batch) (the clock marker and the control recipe the
--      engine issues from), the engine's issue, recipe.issue_gmp_execution(batch, signature, ...) (the row, the ISSUE
--      row with the engine's initial state, the planned batch ISSUED). The command carries the issuer's own reason.
-- Each refuses a sandbox installation (sandbox.assert_gmp_installation, EBMR-SBX-010): a real batch number is never
-- issued in the sandbox, and a sandbox record never becomes a GMP record (DI-05, INV-18).
--
-- New messages: EBMR-EXE-191 (number), 192 (no effective MBR, plan or control recipe), 193 (signature), 194 (request,
-- site), 196 (selection changed since planning, PR-05), 197 (planned or issued already). CREATE OR REPLACE keeps the
-- privileges of the replaced functions. Applied as a new migration because applied migrations are checksummed and never
-- edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- The actor (installation-aware)
-- ---------------------------------------------------------------------------------------------

-- The validated actor of the command with its session facts (device class, room, site) and the badge-tap event the
-- command consumed (INV-40). Refuses administrators (DI-18). The installation is each writer's own check: GMP-only
-- writers call sandbox.assert_gmp_installation, sandbox-only ones sandbox.assert_sandbox_installation (DI-05, INV-18).
create or replace function recipe.execution_actor(p_action text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, sandbox, pg_temp as $$
declare
  v jsonb := iam.assert_validated_actor();
  s iam.session%rowtype;
begin
  perform iam.assert_not_administrator();
  select * into s from iam.session where id = (v ->> 'session_id')::uuid;
  if not found then
    raise exception using errcode = 'P0001', message = 'The command names no session, so it cannot be attributed (DI-14). [EBMR-EXE-001]';
  end if;
  return v || jsonb_build_object('device_class', s.device_class, 'room_code', s.room_code, 'site_code', s.site_code,
                                 'command_auth_event', iam.current_command_auth_event());
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Sandbox only (DI-05, INV-18): test packages and test batches
-- ---------------------------------------------------------------------------------------------

create or replace function recipe.begin_issue(p_batch uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor  jsonb := recipe.execution_actor('Issuing a test batch');
  v_number text;
  v_serial text;
  v_now    bigint;
begin
  perform sandbox.assert_sandbox_installation('Issuing a test batch');
  perform recipe.require_command_permission('ISSUE', null);
  if exists (select 1 from recipe.batch_execution where id = p_batch) then
    raise exception using errcode = 'P0001', message = 'A test batch with this id exists already (DI-34). [EBMR-EXE-011]';
  end if;
  select c.batch_number into v_number from recipe.execution_clock c
   where c.xact_id = pg_current_xact_id() and c.backend_pid = pg_backend_pid() and c.batch_id = p_batch;
  if v_number is null then
    v_serial := nextval('recipe.test_batch_number_seq')::text;
    v_number := format('TEST-B%s-%s', to_char(clock_timestamp() at time zone iam.policy_text('site.zone'), 'YY'),
                       lpad(v_serial, greatest(4, length(v_serial)), '0'));
  end if;
  v_now := recipe.execution_marker(p_batch, v_number);
  return jsonb_build_object('now_us', v_now::text, 'batch_number', v_number, 'site_code', v_actor ->> 'site_code', 'room_code', v_actor ->> 'room_code');
end
$$;

create or replace function recipe.issue_execution(p_batch uuid, p_package_hash text, p_batch_number text, p_request jsonb, p_policy jsonb, p_policy_hash text,
                                                  p_registry_fingerprint text, p_engine_version text, p_now_us bigint, p_state jsonb, p_state_hash text,
                                                  p_events jsonb, p_events_hash text, p_contents jsonb, p_evidence jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, sandbox, pg_temp as $$
declare
  v_actor jsonb := recipe.execution_actor('Issuing a test batch');
  m       recipe.execution_clock;
  pk      recipe.test_package;
  b       recipe.batch_execution;
  r       recipe.execution_command;
  v_n     integer;
  v_eng   jsonb := p_request -> 'issuedBy';
  v_role  text;
  v_ev    jsonb;
  v_roles jsonb := '[]'::jsonb;
begin
  perform sandbox.assert_sandbox_installation('Issuing a test batch');
  perform recipe.require_command_permission('ISSUE', null);
  m := recipe.assert_marker(p_batch, p_now_us);
  if m.batch_number is distinct from p_batch_number then
    raise exception using errcode = 'P0001', message = 'The batch number was not allocated for this batch in this transaction (DI-05). [EBMR-EXE-012]';
  end if;
  perform sandbox.assert_identifier_allowed('BATCH_NUMBER', p_batch_number);
  select * into pk from recipe.test_package where package_hash = p_package_hash;
  if not found then
    raise exception using errcode = 'P0001', message = 'The test package has not been imported (DI-05). [EBMR-EXE-013]';
  end if;
  if recipe.canonical_hash(p_policy) is distinct from p_policy_hash then
    raise exception using errcode = 'P0001', message = 'The pinned engine policy does not hash to its stated hash (INV-26). [EBMR-EXE-014]';
  end if;
  if jsonb_typeof(v_eng) is distinct from 'object' or v_eng ->> 'id' is distinct from v_actor ->> 'person_id' or v_eng ->> 'kind' is distinct from 'PERSON'
     or p_request ->> 'batchId' is distinct from p_batch::text or p_request ->> 'batchNumber' is distinct from p_batch_number then
    raise exception using errcode = 'P0001', message = 'The issue request names another person, batch or number than this command (DI-14). [EBMR-EXE-015]';
  end if;
  if jsonb_typeof(coalesce(v_eng -> 'roles', '[]'::jsonb)) is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'The role evidence of the command is malformed (INV-26). [EBMR-EXE-035]';
  end if;
  for v_role in select distinct x from jsonb_array_elements_text(coalesce(v_eng -> 'roles', '[]'::jsonb)) x order by 1 loop
    select jsonb_build_object('role', mp.engine_role, 'permission', mp.via_permission, 'evaluationId', ev.id) into v_ev
      from recipe.engine_role_map mp
      join iam.authority_evaluation ev on ev.permission_code = mp.via_permission and ev.correlation_id = (v_actor ->> 'correlation_id')::uuid
                                      and ev.person_id = (v_actor ->> 'person_id')::uuid and ev.allowed
     where mp.kernel_role = v_actor ->> 'role_code' and mp.engine_role = v_role
       and recipe.role_evaluation_problem(v_actor, mp.via_permission, ev.id) is null
     order by ev.evaluated_at, ev.id
     limit 1;
    if v_ev is null then
      raise exception using errcode = 'P0001',
        message = format('The issue request gives the issuer engine role %s without a stored authority evaluation in the declared role at the actor''s location behind it; roles come from the stored evaluations, never from the client (INV-26, D4). [EBMR-EXE-037]', v_role);
    end if;
    v_roles := v_roles || jsonb_build_array(v_ev);
    v_ev := null;
  end loop;
  b.id := p_batch;
  b.batch_number := p_batch_number;
  b.package_hash := p_package_hash;
  b.content_hash := pk.content_hash;
  b.installation := kernel.installation_kind();
  b.purpose := 'SANDBOX_TEST_RUN';
  b.engine_version := p_engine_version;
  b.registry_fingerprint := p_registry_fingerprint;
  b.policy := p_policy;
  b.policy_hash := p_policy_hash;
  b.issue_request := p_request;
  b.market_set := array(select jsonb_array_elements_text(p_request -> 'marketSet'));
  b.batch_size := p_request ->> 'batchSize';
  b.site_code := coalesce(v_actor ->> 'site_code', '?');
  b.room_code := v_actor ->> 'room_code';
  b.site_zone := v_actor ->> 'site_zone';
  b.issued_at := clock_timestamp();
  b.issued_at_us := p_now_us;
  b.issued_by_person := (v_actor ->> 'person_id')::uuid;
  b.issued_by_account := (v_actor ->> 'account_id')::uuid;
  b.correlation_id := (v_actor ->> 'correlation_id')::uuid;
  insert into recipe.batch_execution select b.*;
  perform recipe.check_state(b, p_state, p_state_hash, p_events, p_events_hash);
  if (p_state ->> 'version') is distinct from '0' or p_state -> 'header' ->> 'issuedBy' is distinct from v_actor ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'The issued state is not the engine''s initial state of this request (DI-34). [EBMR-EXE-030]';
  end if;
  perform recipe.check_issued_state(p_state, p_request, (v_actor ->> 'person_id')::uuid);
  r := recipe.write_row(p_batch, 1, 'ISSUE', 'ISSUE:' || p_batch::text, jsonb_build_object('type', 'ISSUE', 'request', p_request), v_actor, p_now_us,
                        true, null, p_state, p_events, v_roles, '{}', p_evidence, recipe.execution_genesis_hash(p_batch));
  v_n := recipe.insert_contents(p_batch, 1, p_contents);
  perform kernel.audit_business_event('batch:' || p_batch::text,
    format('Test batch %s issued from package %s (MBR %s, content %s) by %s; sandbox test run, TEST, NOT GMP', p_batch_number, left(p_package_hash, 12),
           pk.family_code, left(pk.content_hash, 12), coalesce(v_actor ->> 'legal_name', v_actor ->> 'person_id')),
    jsonb_build_object('batch_number', p_batch_number, 'package_hash', p_package_hash, 'content_hash', pk.content_hash, 'engine_version', p_engine_version,
                       'registry_fingerprint', p_registry_fingerprint, 'policy_hash', p_policy_hash));
  return jsonb_build_object('batch_id', p_batch, 'batch_number', p_batch_number, 'seq', r.seq::text, 'row_hash', r.row_hash, 'contents', v_n);
end
$$;

create or replace function recipe.import_test_package(p_package jsonb, p_file_name text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := recipe.execution_actor('Importing a test package');
  v_hash  text;
  pk      recipe.test_package;
begin
  perform sandbox.assert_sandbox_installation('Importing a test package');
  perform recipe.require_command_permission('ISSUE', null);
  if jsonb_typeof(p_package) <> 'object' or p_package ->> 'format' is distinct from 'ebmr.mbr-test-package' or p_package -> 'formatVersion' is distinct from '1'::jsonb then
    raise exception using errcode = 'P0001', message = 'The file is not an ebmr.mbr-test-package version 1 (DI-05). [EBMR-EXE-016]';
  end if;
  v_hash := recipe.canonical_hash(p_package - 'packageHash');
  if v_hash is distinct from p_package ->> 'packageHash' or p_file_name is distinct from v_hash || '.json' then
    raise exception using errcode = 'P0001',
      message = 'The package hash does not match its content or its file name: the file was changed after export (DI-05, DI-37). [EBMR-EXE-017]';
  end if;
  if recipe.canonical_hash(p_package -> 'content') is distinct from p_package ->> 'contentHash' then
    raise exception using errcode = 'P0001', message = 'The MBR content does not match its content hash (DI-04). [EBMR-EXE-017]';
  end if;
  if p_package -> 'source' ->> 'installationKind' is distinct from 'GMP' or jsonb_typeof(p_package -> 'source' -> 'watermark') is distinct from 'null' then
    raise exception using errcode = 'P0001',
      message = 'The package does not come from a GMP installation; only MBR versions exported from GMP are test-run (DI-05, INV-18). [EBMR-EXE-018]';
  end if;
  if exists (select 1 from recipe.test_package where package_hash = v_hash) then
    raise exception using errcode = 'P0001', message = 'This test package has been imported already (DI-05). [EBMR-EXE-019]';
  end if;
  pk.package_hash := v_hash;
  pk.file_name := p_file_name;
  pk.package := p_package;
  pk.content := p_package -> 'content';
  pk.content_hash := p_package ->> 'contentHash';
  pk.family_id := (p_package -> 'family' ->> 'familyId')::uuid;
  pk.family_code := p_package -> 'family' ->> 'familyCode';
  pk.product := p_package -> 'family' -> 'product';
  pk.version_id := (p_package -> 'version' ->> 'versionId')::uuid;
  pk.version_number := p_package -> 'version' ->> 'number';
  pk.revision := (p_package -> 'version' ->> 'revision')::integer;
  pk.version_state := p_package -> 'version' ->> 'state';
  pk.exporter := p_package -> 'exporter';
  pk.exported_at_us := (p_package ->> 'exportedAtUs')::bigint;
  pk.source := p_package -> 'source';
  pk.imported_at := clock_timestamp();
  pk.imported_by_person := (v_actor ->> 'person_id')::uuid;
  pk.imported_by_account := (v_actor ->> 'account_id')::uuid;
  pk.correlation_id := (v_actor ->> 'correlation_id')::uuid;
  insert into recipe.test_package select pk.*;
  perform kernel.audit_business_event('test_package:' || v_hash,
    format('Test package %s imported (MBR %s version %s revision %s, %s; content %s) by %s', left(v_hash, 12), pk.family_code, pk.version_number,
           pk.revision, pk.version_state, left(pk.content_hash, 12), coalesce(v_actor ->> 'legal_name', v_actor ->> 'person_id')),
    jsonb_build_object('package_hash', v_hash, 'content_hash', pk.content_hash, 'version_id', pk.version_id));
  return jsonb_build_object('package_hash', v_hash, 'imported_at', recipe.utc_text(pk.imported_at));
end
$$;
-- ---------------------------------------------------------------------------------------------
-- The GMP issue (slice 2b item 1): plan, then issue under the issuer's ISSUED signature
-- ---------------------------------------------------------------------------------------------

-- Plans GMP batch p_batch from an effective MBR version (GMP installation, BATCH.ISSUE at the batch's site and product,
-- one transaction): the version the selection gives now for the market set and scope (recipe-core 0170: India in every
-- market set INV-28, every market approved PR-04, the authorisation cells of site, line and approved batch size INV-01;
-- D-S2b-1: the bill of materials is matched at issue with the ERP stub, slice 5), the batch number from the site's
-- register (site.allocate_batch_number, which requires BATCH_NUMBER.ALLOCATE for the site and product, or the given
-- allocationId of a number the register holds for this product, site and size and never linked before), the planned
-- batch, its link to the allocation, the pin and the control recipe. Nothing is issued yet: the issuer signs the
-- batch_issue content with ISSUED, then recipe.begin_gmp_issue and recipe.issue_gmp_execution issue it.
-- p_def: {familyId, markets: [..], site, line, batchSize, allocationId?}
create function recipe.prepare_gmp_issue(p_batch uuid, p_def jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, site, sandbox, pg_temp as $$
declare
  v_actor   jsonb := recipe.execution_actor('Planning a GMP batch');
  uuid_re   constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  zero      constant uuid := '00000000-0000-0000-0000-000000000000';
  f         recipe.mbr_family;
  v_markets text[];
  v_scope   jsonb;
  v_sel     jsonb;
  sz        jsonb;
  v_alloc   uuid;
  v_number  text;
  b         recipe.stub_batch;
  p         recipe.batch_mbr_pin;
  cr        recipe.control_recipe;
begin
  perform sandbox.assert_gmp_installation('Planning a GMP batch');
  perform recipe.require_command_permission('ISSUE', null);
  if p_batch is null or jsonb_typeof(p_def) is distinct from 'object' or coalesce(p_def ->> 'familyId', '') !~ uuid_re then
    raise exception using errcode = 'P0001', message = 'A GMP batch is planned with its id and its MBR family, market set and scope (INV-01). [EBMR-EXE-192]';
  end if;
  select * into f from recipe.mbr_family where id = (p_def ->> 'familyId')::uuid;
  if not found then
    raise exception using errcode = 'P0001', message = format('There is no MBR family %s; a GMP batch is issued only from an effective MBR version (INV-01, DI-05). [EBMR-EXE-192]', p_def ->> 'familyId');
  end if;
  perform iam.require_permission('BATCH.ISSUE', jsonb_strip_nulls(jsonb_build_object('site', p_def ->> 'site', 'product', f.product_code)));
  if exists (select 1 from recipe.stub_batch where id = p_batch) or exists (select 1 from recipe.batch_execution where id = p_batch) then
    raise exception using errcode = 'P0001', message = 'A batch with this id exists already; a batch is planned and issued once (DI-34). [EBMR-EXE-197]';
  end if;
  -- Wait for any market authorisation being activated for this family (INV-17 / INV-01 consistency), as 0170 does.
  perform 1 from recipe.mbr_family where id = f.id for share;
  v_markets := array(select distinct m from jsonb_array_elements_text(case when jsonb_typeof(p_def -> 'markets') = 'array' then p_def -> 'markets' else '[]'::jsonb end) m order by m);
  v_scope := jsonb_build_object('site', p_def ->> 'site', 'line', p_def ->> 'line', 'batch_size', p_def ->> 'batchSize');
  v_sel := recipe.select_version_for_issue(f.id, v_markets, v_scope, clock_timestamp());
  if not (v_sel ->> 'ok')::boolean then
    raise exception using errcode = 'P0001',
      message = format('The GMP batch cannot be planned: %s. A GMP batch is issued only from an effective MBR version (INV-01, INV-28, PR-04, DI-05). [EBMR-EXE-192]', v_sel ->> 'explanation');
  end if;
  if p_def ? 'allocationId' then
    if coalesce(p_def ->> 'allocationId', '') !~ uuid_re then
      raise exception using errcode = 'P0001', message = 'The batch number names no allocation of the site''s register (INV-27, IN-18). [EBMR-EXE-191]';
    end if;
    select a.id, a.batch_number into v_alloc, v_number from site.batch_number_allocation a where a.id = (p_def ->> 'allocationId')::uuid for update;
    if v_alloc is null then
      raise exception using errcode = 'P0001', message = format('Allocation %s is not in the site''s batch-number register (INV-27, IN-18). [EBMR-EXE-191]', p_def ->> 'allocationId');
    end if;
    if exists (select 1 from recipe.batch_allocation_link l where l.allocation_id = v_alloc or l.batch_number = v_number) then
      raise exception using errcode = 'P0001',
        message = format('Batch number %s was given to a batch already; a batch number is never reused (INV-27, IN-18). [EBMR-EXE-191]', v_number);
    end if;
  else
    sz := (select x -> 'quantity' from jsonb_array_elements(f.batch_sizes) x where x ->> 'id' = p_def ->> 'batchSize' limit 1);
    select a.allocation_id, a.batch_number into v_alloc, v_number
      from site.allocate_batch_number(jsonb_build_object('site_code', p_def ->> 'site', 'product_code', f.product_code, 'product_name', f.product_name,
                                                         'edition', upper(f.edition), 'batch_kind', f.record_kind,
                                                         'batch_size', sz ->> 'value', 'batch_size_unit', sz ->> 'unit')) a;
  end if;
  insert into recipe.stub_batch (id, batch_number, family_id, markets, site, line, batch_size, created_by_person, created_by_account)
  values (p_batch, v_number, f.id, v_markets, p_def ->> 'site', p_def ->> 'line', p_def ->> 'batchSize', zero, zero)
  returning * into b;
  insert into recipe.batch_allocation_link (batch_id, allocation_id, batch_number, person_id, account_id, correlation_id)
  values (b.id, v_alloc, v_number, zero, zero, zero);
  insert into recipe.batch_mbr_pin (batch_id, family_id, version_id, version_number, content_hash, markets, scope, selection, rule_table_versions, person_id, account_id)
  values (b.id, b.family_id, null, 0, repeat('0', 64), '{}', '{}', '{}', '{}', zero, zero)
  returning * into p;
  insert into recipe.control_recipe (batch_id, pin_id, version_id, mbr_content_hash, snapshot, snapshot_hash, person_id, account_id)
  values (b.id, p.id, p.version_id, p.content_hash, '{}', repeat('0', 64), zero, zero)
  returning * into cr;
  perform kernel.audit_business_event('batch:' || b.id,
    format('GMP batch %s planned on MBR %s version %s (%s) with batch number %s from the site register (allocation %s), control recipe %s, by %s; issued once signed ISSUED',
           b.batch_number, f.code, p.version_number, p.selection ->> 'rule', v_number, v_alloc, cr.snapshot_hash, coalesce(v_actor ->> 'legal_name', v_actor ->> 'person_id')),
    jsonb_build_object('allocation_id', v_alloc, 'pin_id', p.id, 'version_id', p.version_id, 'content_hash', p.content_hash, 'control_recipe_id', cr.id,
                       'snapshot_hash', cr.snapshot_hash));
  return jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'allocation_id', v_alloc, 'pin_id', p.id, 'version_id', p.version_id,
                            'version_number', p.version_number, 'content_hash', p.content_hash, 'rule', p.selection ->> 'rule', 'markets', to_jsonb(p.markets),
                            'control_recipe_id', cr.id, 'snapshot_hash', cr.snapshot_hash);
end
$$;

-- Why planned GMP batch b (pinned p, control recipe cr, linked l) cannot be issued now; NULL when it can: still PLANNED
-- and not executed, the selection at this instant still gives the pinned version (PR-05), the control recipe verifies
-- (INV-02) and the number is still the register's (INV-27). The message ends with its code.
create function recipe.gmp_issue_problem(b recipe.stub_batch, p recipe.batch_mbr_pin, l recipe.batch_allocation_link) returns text
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_sel  jsonb;
  v_ver  jsonb;
  v_prob text;
begin
  if b.status <> 'PLANNED' or exists (select 1 from recipe.batch_execution x where x.id = b.id) then
    return format('Batch %s is %s; a GMP batch is issued once (DI-34). [EBMR-EXE-197]', b.batch_number, b.status);
  end if;
  v_sel := recipe.select_version_for_issue(b.family_id, b.markets, p.scope, clock_timestamp());
  if not coalesce((v_sel ->> 'ok')::boolean, false) or (v_sel ->> 'version_id')::uuid is distinct from p.version_id then
    return format('Batch %s was planned on version %s, which is no longer the version its markets and scope may use now (%s): plan it again (PR-05, INV-01). [EBMR-EXE-196]',
                  b.batch_number, p.version_number, coalesce('version ' || (v_sel ->> 'version_number'), v_sel ->> 'explanation'));
  end if;
  v_ver := recipe.verify_control_recipe(b.id);
  if not (v_ver ->> 'ok')::boolean then
    return format('The control recipe of batch %s does not verify: %s (INV-02). [EBMR-EXE-192]', b.batch_number, v_ver ->> 'problems');
  end if;
  v_prob := recipe.allocation_problem(b.id, l.allocation_id);
  if v_prob is not null then
    return format('The batch number of batch %s is not the register''s: %s (INV-27, IN-18). [EBMR-EXE-191]', b.batch_number, v_prob);
  end if;
  return null;
end
$$;

-- The trusted time of the issue of planned GMP batch p_batch, and what the engine issues it from (GMP installation,
-- BATCH.ISSUE): the clock marker of this transaction with the batch's register number (INV-16), the pinned market set,
-- batch size and site, and the control recipe (its snapshot holds the MBR content, snapshot.mbr.content, and its hash).
create function recipe.begin_gmp_issue(p_batch uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, sandbox, pg_temp as $$
declare
  v_actor jsonb := recipe.execution_actor('Issuing a GMP batch');
  b       recipe.stub_batch;
  l       recipe.batch_allocation_link;
  p       recipe.batch_mbr_pin;
  cr      recipe.control_recipe;
  f       recipe.mbr_family;
  v_prob  text;
  v_now   bigint;
begin
  perform sandbox.assert_gmp_installation('Issuing a GMP batch');
  perform recipe.require_command_permission('ISSUE', null);
  select * into b from recipe.stub_batch where id = p_batch for update;
  select * into l from recipe.batch_allocation_link where batch_id = p_batch;
  select * into p from recipe.batch_mbr_pin where batch_id = p_batch;
  select * into cr from recipe.control_recipe where batch_id = p_batch;
  if b.id is null or l.batch_id is null or p.id is null or cr.id is null then
    raise exception using errcode = 'P0001',
      message = 'There is no GMP batch planned with this id; a GMP batch is issued only as planned from an effective MBR version (INV-01, DI-05). [EBMR-EXE-192]';
  end if;
  select * into f from recipe.mbr_family where id = b.family_id;
  perform iam.require_permission('BATCH.ISSUE', jsonb_build_object('site', b.site, 'product', f.product_code));
  perform 1 from recipe.mbr_family where id = b.family_id for share;
  v_prob := recipe.gmp_issue_problem(b, p, l);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = v_prob;
  end if;
  v_now := recipe.execution_marker(p_batch, b.batch_number);
  return jsonb_build_object('now_us', v_now::text, 'batch_number', b.batch_number, 'site_code', b.site, 'line', b.line, 'room_code', v_actor ->> 'room_code',
                            'market_set', to_jsonb(p.markets), 'batch_size', b.batch_size, 'content_hash', cr.mbr_content_hash,
                            'control_recipe_id', cr.id, 'snapshot_hash', cr.snapshot_hash, 'snapshot', cr.snapshot);
end
$$;

-- Issues planned GMP batch p_batch (GMP installation, BATCH.ISSUE at the batch's site and product, in the transaction of
-- recipe.begin_gmp_issue): the issuer's own valid ISSUED signature on the batch_issue content (DI-35, INV-10), the
-- request bound to the command, the batch's number, pinned market set and batch size, engine roles from stored
-- evaluations (INV-26, as the sandbox issue), the control recipe as the batch's MBR (INV-02), the engine's initial
-- state (recipe.check_issued_state), the ISSUE row, and the planned batch ISSUED (the command carries the issuer's own
-- reason, both halves: the kernel refuses the status change without them, EBMR-AUDIT-002). The evidence holds
-- nothing (no test package).
create function recipe.issue_gmp_execution(p_batch uuid, p_signature uuid, p_batch_number text, p_request jsonb, p_policy jsonb, p_policy_hash text,
                                           p_registry_fingerprint text, p_engine_version text, p_now_us bigint, p_state jsonb, p_state_hash text,
                                           p_events jsonb, p_events_hash text, p_contents jsonb, p_evidence jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, sandbox, esig, pg_temp as $$
declare
  v_actor jsonb := recipe.execution_actor('Issuing a GMP batch');
  m       recipe.execution_clock;
  sb      recipe.stub_batch;
  l       recipe.batch_allocation_link;
  p       recipe.batch_mbr_pin;
  cr      recipe.control_recipe;
  f       recipe.mbr_family;
  b       recipe.batch_execution;
  r       recipe.execution_command;
  v_n     integer;
  v_eng   jsonb := p_request -> 'issuedBy';
  v_role  text;
  v_ev    jsonb;
  v_roles jsonb := '[]'::jsonb;
  v_prob  text;
begin
  perform sandbox.assert_gmp_installation('Issuing a GMP batch');
  perform recipe.require_command_permission('ISSUE', null);
  m := recipe.assert_marker(p_batch, p_now_us);
  if m.batch_number is distinct from p_batch_number then
    raise exception using errcode = 'P0001', message = 'The batch number was not allocated for this batch in this transaction (DI-05). [EBMR-EXE-012]';
  end if;
  perform sandbox.assert_identifier_allowed('BATCH_NUMBER', p_batch_number);
  select * into sb from recipe.stub_batch where id = p_batch for update;
  select * into l from recipe.batch_allocation_link where batch_id = p_batch;
  select * into p from recipe.batch_mbr_pin where batch_id = p_batch;
  select * into cr from recipe.control_recipe where batch_id = p_batch;
  if sb.id is null or l.batch_id is null or p.id is null or cr.id is null then
    raise exception using errcode = 'P0001',
      message = 'There is no GMP batch planned with this id; a GMP batch is issued only as planned from an effective MBR version (INV-01, DI-05). [EBMR-EXE-192]';
  end if;
  select * into f from recipe.mbr_family where id = sb.family_id;
  perform iam.require_permission('BATCH.ISSUE', jsonb_build_object('site', sb.site, 'product', f.product_code));
  if l.batch_number is distinct from p_batch_number then
    raise exception using errcode = 'P0001',
      message = format('Batch number %s is not the number the site''s register allocated for this batch (%s); a batch is issued only under its own register number (INV-27, IN-18). [EBMR-EXE-191]',
                       p_batch_number, l.batch_number);
  end if;
  perform 1 from recipe.mbr_family where id = sb.family_id for share;
  v_prob := recipe.gmp_issue_problem(sb, p, l);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = v_prob;
  end if;
  if recipe.canonical_hash(p_policy) is distinct from p_policy_hash then
    raise exception using errcode = 'P0001', message = 'The pinned engine policy does not hash to its stated hash (INV-26). [EBMR-EXE-014]';
  end if;
  if jsonb_typeof(v_eng) is distinct from 'object' or v_eng ->> 'id' is distinct from v_actor ->> 'person_id' or v_eng ->> 'kind' is distinct from 'PERSON'
     or p_request ->> 'batchId' is distinct from p_batch::text or p_request ->> 'batchNumber' is distinct from p_batch_number then
    raise exception using errcode = 'P0001', message = 'The issue request names another person, batch or number than this command (DI-14). [EBMR-EXE-015]';
  end if;
  if (p_request -> 'marketSet') is distinct from to_jsonb(p.markets) or (p_request -> 'batchSize') is distinct from to_jsonb(sb.batch_size) then
    raise exception using errcode = 'P0001',
      message = format('The issue request names market set %s and batch size %s; batch %s was pinned for market set %s and batch size %s (INV-01, INV-28, PR-04). [EBMR-EXE-194]',
                       coalesce(left((p_request -> 'marketSet')::text, 80), 'none'), coalesce(left(p_request ->> 'batchSize', 40), 'none'), sb.batch_number,
                       to_jsonb(p.markets)::text, sb.batch_size);
  end if;
  if v_actor ->> 'site_code' is not null and v_actor ->> 'site_code' is distinct from sb.site then
    raise exception using errcode = 'P0001',
      message = format('Batch %s is planned for site %s; it is issued at that site, not at %s (INV-01). [EBMR-EXE-194]', sb.batch_number, sb.site, v_actor ->> 'site_code');
  end if;
  v_prob := esig.signature_problem(p_signature, 'ISSUED', 'batch_issue', p_batch::text);
  if v_prob is not null then
    raise exception using errcode = 'P0001',
      message = format('Batch %s is issued only under the issuer''s valid ISSUED signature of its issue content: %s (DI-35, INV-10). [EBMR-EXE-193]', sb.batch_number, v_prob);
  end if;
  if esig.signature_state(p_signature) ->> 'signer_person' is distinct from v_actor ->> 'person_id' then
    raise exception using errcode = 'P0001',
      message = format('The ISSUED signature of batch %s is another person''s; the person who issues the batch signs it (DI-35, DI-14). [EBMR-EXE-193]', sb.batch_number);
  end if;
  if jsonb_typeof(coalesce(v_eng -> 'roles', '[]'::jsonb)) is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'The role evidence of the command is malformed (INV-26). [EBMR-EXE-035]';
  end if;
  for v_role in select distinct x from jsonb_array_elements_text(coalesce(v_eng -> 'roles', '[]'::jsonb)) x order by 1 loop
    select jsonb_build_object('role', mp.engine_role, 'permission', mp.via_permission, 'evaluationId', ev.id) into v_ev
      from recipe.engine_role_map mp
      join iam.authority_evaluation ev on ev.permission_code = mp.via_permission and ev.correlation_id = (v_actor ->> 'correlation_id')::uuid
                                      and ev.person_id = (v_actor ->> 'person_id')::uuid and ev.allowed
     where mp.kernel_role = v_actor ->> 'role_code' and mp.engine_role = v_role
       and recipe.role_evaluation_problem(v_actor, mp.via_permission, ev.id) is null
     order by ev.evaluated_at, ev.id
     limit 1;
    if v_ev is null then
      raise exception using errcode = 'P0001',
        message = format('The issue request gives the issuer engine role %s without a stored authority evaluation in the declared role at the actor''s location behind it; roles come from the stored evaluations, never from the client (INV-26, D4). [EBMR-EXE-037]', v_role);
    end if;
    v_roles := v_roles || jsonb_build_array(v_ev);
    v_ev := null;
  end loop;
  b.id := p_batch;
  b.batch_number := p_batch_number;
  b.package_hash := null;
  b.control_recipe_id := cr.id;
  b.issue_signature_id := p_signature;
  b.content_hash := cr.mbr_content_hash;
  b.installation := 'GMP';
  b.purpose := 'GMP_BATCH';
  b.engine_version := p_engine_version;
  b.registry_fingerprint := p_registry_fingerprint;
  b.policy := p_policy;
  b.policy_hash := p_policy_hash;
  b.issue_request := p_request;
  b.market_set := p.markets;
  b.batch_size := sb.batch_size;
  b.site_code := sb.site;
  b.room_code := v_actor ->> 'room_code';
  b.site_zone := v_actor ->> 'site_zone';
  b.issued_at := clock_timestamp();
  b.issued_at_us := p_now_us;
  b.issued_by_person := (v_actor ->> 'person_id')::uuid;
  b.issued_by_account := (v_actor ->> 'account_id')::uuid;
  b.correlation_id := (v_actor ->> 'correlation_id')::uuid;
  insert into recipe.batch_execution select b.*;
  perform recipe.check_state(b, p_state, p_state_hash, p_events, p_events_hash);
  if (p_state ->> 'version') is distinct from '0' or p_state -> 'header' ->> 'issuedBy' is distinct from v_actor ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'The issued state is not the engine''s initial state of this request (DI-34). [EBMR-EXE-030]';
  end if;
  perform recipe.check_issued_state(p_state, p_request, (v_actor ->> 'person_id')::uuid);
  r := recipe.write_row(p_batch, 1, 'ISSUE', 'ISSUE:' || p_batch::text, jsonb_build_object('type', 'ISSUE', 'request', p_request), v_actor, p_now_us,
                        true, null, p_state, p_events, v_roles, '{}', p_evidence, recipe.execution_genesis_hash(p_batch));
  v_n := recipe.insert_contents(p_batch, 1, p_contents);
  update recipe.stub_batch set status = 'ISSUED' where id = p_batch;
  perform kernel.audit_business_event('batch:' || p_batch::text,
    format('GMP batch %s issued by %s under ISSUED signature %s from MBR %s version %s (content %s), control recipe %s, batch number from the site register (allocation %s)',
           p_batch_number, coalesce(v_actor ->> 'legal_name', v_actor ->> 'person_id'), p_signature, f.code, p.version_number, left(cr.mbr_content_hash, 12),
           left(cr.snapshot_hash, 12), l.allocation_id),
    jsonb_build_object('batch_number', p_batch_number, 'control_recipe_id', cr.id, 'snapshot_hash', cr.snapshot_hash, 'content_hash', cr.mbr_content_hash,
                       'allocation_id', l.allocation_id, 'signature_id', p_signature, 'engine_version', p_engine_version,
                       'registry_fingerprint', p_registry_fingerprint, 'policy_hash', p_policy_hash));
  return jsonb_build_object('batch_id', p_batch, 'batch_number', p_batch_number, 'seq', r.seq::text, 'row_hash', r.row_hash, 'contents', v_n);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on function recipe.prepare_gmp_issue(uuid, jsonb), recipe.begin_gmp_issue(uuid),
                       recipe.issue_gmp_execution(uuid, uuid, text, jsonb, jsonb, text, text, text, bigint, jsonb, text, jsonb, text, jsonb, jsonb),
                       recipe.gmp_issue_problem(recipe.stub_batch, recipe.batch_mbr_pin, recipe.batch_allocation_link) from public;
grant execute on function recipe.prepare_gmp_issue(uuid, jsonb), recipe.begin_gmp_issue(uuid),
                          recipe.issue_gmp_execution(uuid, uuid, text, jsonb, jsonb, text, text, text, bigint, jsonb, text, jsonb, text, jsonb, jsonb) to ebmr_app;

reset role;
