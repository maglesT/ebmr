-- Recipe core: the GMP batch issue is authorised in the order's product scope (Phase 6 exit review 6jc-R16, the rest;
-- IN-04, DI-21, DI-17).
--
-- Handbook: modules/recipe-core.md
--
-- What was wrong. recipe.prepare_gmp_issue (0761), recipe.begin_gmp_issue and recipe.issue_gmp_execution (0501) check
-- the issue command's permission (recipe.require_command_permission('ISSUE', null), 0210) at the actor's location only,
-- before BATCH.ISSUE at the batch's {site, product}. A request without a product is matched by every product-limited
-- requirement and covered by no product-limited grant, so a requirement on BATCH.ISSUE limited to product A refused the
-- issue of every product's batch, and an issuer whose grant is limited to product A could not issue A's batches.
--
-- What changed:
--   * recipe.require_issue_permission(product): as recipe.require_command_permission(text, text, uuid) of 1100 for the
--     ISSUE command, at the actor's location with the given product added (none: the location only). Owner only.
--   * recipe.prepare_gmp_issue: the issue command's check with the product of the MBR family the batch is planned from
--     (the order's product); recipe.begin_gmp_issue and recipe.issue_gmp_execution: with the planned batch's family's
--     product. Each is replaced from its latest definition with that one line; the BATCH.ISSUE check at {site, product},
--     the ISSUED signature (whose content gives {site, product}) and every other guard are unchanged, in the same order.
--   * The issuer's engine roles at a GMP issue keep the location-only evaluation (tablets 1320): the batch issuer's kernel
--     role carries no engine role (recipe.engine_role_map), and a role an evaluation did not allow is only left out of the
--     request, never a refusal. A test run's issue (recipe.begin_issue, recipe.issue_execution) has no order and keeps
--     the location-only check.
--
-- CREATE OR REPLACE keeps the owners, privileges, SECURITY DEFINER and search_path of the replaced functions. Applied as
-- a new migration because applied migrations are never edited.

set local role ebmr_owner;

-- As recipe.require_command_permission(text, text, uuid) of 1100 for the ISSUE command, with the order's product in
-- place of the batch's (header).
create function recipe.require_issue_permission(p_product text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v_perms text[];
  v_held  text[];
  v_perm  text;
begin
  select permissions into v_perms from recipe.execution_command_permission where command_type = 'ISSUE';
  if v_perms is null then
    raise exception using errcode = 'P0001',
      message = 'ISSUE is not available on test runs in this release; it arrives with the next increment (DI-34). [EBMR-EXE-003]';
  end if;
  v_held := iam.role_permissions_at(v_actor ->> 'role_code', clock_timestamp());
  select p into v_perm from unnest(v_perms) with ordinality as x (p, i) where p = any (v_held) order by i limit 1;
  v_perm := coalesce(v_perm, v_perms[1]);
  return iam.require_permission(v_perm, iam.actor_location_scope()
                                        || coalesce(jsonb_strip_nulls(jsonb_build_object('product', nullif(btrim(p_product), ''))), '{}'::jsonb));
end
$$;

-- As 0761; the issue command's permission with the order's product (header).
create or replace function recipe.prepare_gmp_issue(p_batch uuid, p_def jsonb) returns jsonb
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
  v_parent  recipe.batch_allocation_link;
  v_problem text;
  v_order   jsonb;
begin
  perform sandbox.assert_gmp_installation('Planning a GMP batch');
  -- 6jc-R16: the issue command's permission at the actor's location with the order's product (the family planned from;
  -- none while the family is not known, which is the location-only check as before).
  perform recipe.require_issue_permission((select f0.product_code from recipe.mbr_family f0
                                            where f0.id = case when coalesce(p_def ->> 'familyId', '') ~ uuid_re then (p_def ->> 'familyId')::uuid end));
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
  -- D-S4-2: a packaging order names the issued processing batch it packs; a processing batch names none.
  if f.record_kind = 'PACKAGING' then
    if coalesce(p_def ->> 'parentBatch', '') !~ uuid_re then
      raise exception using errcode = 'P0001',
        message = 'A packaging order is planned with the processing batch it packs (parentBatch): its number comes from the register as a packaging number of that batch (D-S4-2, INV-27, IN-18). [EBMR-EXE-198]';
    end if;
    select l.* into v_parent from recipe.batch_allocation_link l where l.batch_id = (p_def ->> 'parentBatch')::uuid;
    v_problem := recipe.packaging_parent_problem(f.product_code, p_def ->> 'site', (p_def ->> 'parentBatch')::uuid);
    if v_problem is not null then
      raise exception using errcode = 'P0001', message = format('The packaging order cannot be planned: %s (D-S4-2, INV-27). [EBMR-EXE-198]', v_problem);
    end if;
  elsif p_def ? 'parentBatch' then
    raise exception using errcode = 'P0001', message = 'A processing batch names no parent batch; only a packaging order does (D-S4-2). [EBMR-EXE-198]';
  end if;
  -- Phase 4 slice 2c: a packaging order is planned only on a master that packs to the end (the edition's secondary
  -- packaging block, tablets TB-24: examined finished packs, shippers and their SSCCs).
  if f.record_kind = 'PACKAGING' then
    v_problem := recipe.packaging_master_problem(f.edition, (recipe.current_content((v_sel ->> 'version_id')::uuid)).content);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-PLN-005 the packaging order cannot be planned on MBR %s version %s: %s (outline 5.2.9; PR-37, IN-16)', f.code, v_sel ->> 'version_number', v_problem);
    end if;
  end if;
  if p_def ? 'allocationId' then
    if coalesce(p_def ->> 'allocationId', '') !~ uuid_re then
      raise exception using errcode = 'P0001', message = 'The batch number names no allocation of the site''s register (INV-27, IN-18). [EBMR-EXE-191]';
    end if;
    select a.id, a.batch_number into v_alloc, v_number from site.batch_number_allocation a where a.id = (p_def ->> 'allocationId')::uuid for update;
    if v_alloc is null then
      raise exception using errcode = 'P0001', message = format('Allocation %s is not in the site''s batch-number register (INV-27, IN-18). [EBMR-EXE-191]', p_def ->> 'allocationId');
    end if;
    -- Review backlog 2b #4: a number allocated ahead is taken only by the person who allocated it (who held
    -- BATCH_NUMBER.ALLOCATE for it); another planner allocates a number of their own.
    if (select a.allocated_by_person_id from site.batch_number_allocation a where a.id = v_alloc) is distinct from (v_actor ->> 'person_id')::uuid then
      raise exception using errcode = 'P0001',
        message = format('EBMR-PLN-004 batch number %s was allocated by another person; a number allocated ahead is planned only by the person who allocated it (INV-27, IN-18, DI-14)', v_number);
    end if;
    if f.record_kind = 'PACKAGING'
       and (select a.parent_allocation_id from site.batch_number_allocation a where a.id = v_alloc) is distinct from v_parent.allocation_id then
      raise exception using errcode = 'P0001',
        message = format('Batch number %s is not a packaging number of batch %s, which this packaging order packs (D-S4-2, INV-27). [EBMR-EXE-198]', v_number, v_parent.batch_number);
    end if;
    if exists (select 1 from recipe.batch_allocation_link l where l.allocation_id = v_alloc or l.batch_number = v_number) then
      raise exception using errcode = 'P0001',
        message = format('Batch number %s was given to a batch already; a batch number is never reused (INV-27, IN-18). [EBMR-EXE-191]', v_number);
    end if;
  else
    sz := (select x -> 'quantity' from jsonb_array_elements(f.batch_sizes) x where x ->> 'id' = p_def ->> 'batchSize' limit 1);
    select a.allocation_id, a.batch_number into v_alloc, v_number
      from site.allocate_batch_number(jsonb_build_object('site_code', p_def ->> 'site', 'product_code', f.product_code, 'product_name', f.product_name,
                                                         'edition', upper(f.edition), 'batch_kind', recipe.register_batch_kind(f.record_kind),
                                                         'batch_size', sz ->> 'value', 'batch_size_unit', sz ->> 'unit')
                                      || case when f.record_kind = 'PACKAGING' then jsonb_build_object('parent_batch_number', v_parent.batch_number) else '{}'::jsonb end) a;
  end if;
  -- Review backlog 2b #4: the number's test-data check runs at planning too, not only at issue (DI-05, INV-18).
  perform sandbox.assert_identifier_allowed('BATCH_NUMBER', v_number);
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
  -- D-S4-ERP (slice 5a, D-S5-4; outline 5.2.2): the named ERP order matches the pinned MBR: product, strength, site,
  -- batch size and BOM (each material once, quantities scaled to this batch size, exact decimals).
  v_order := site.erp_order_of(p_def ->> 'erpOrder');
  v_problem := recipe.erp_order_problem(p_def ->> 'erpOrder', v_order, f, p_def ->> 'site', p_def ->> 'batchSize', cr.snapshot -> 'mbr' -> 'content');
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('The GMP batch cannot be planned: %s (outline 5.2.2; D-S5-4). [EBMR-EXE-605]', v_problem);
  end if;
  insert into recipe.batch_erp_order (batch_id, order_id, order_no) values (b.id, (v_order ->> 'orderId')::uuid, v_order ->> 'orderNo');
  perform kernel.audit_business_event('batch:' || b.id,
    format('GMP batch %s planned on MBR %s version %s (%s) with batch number %s from the site register (allocation %s), control recipe %s, by %s; issued once signed ISSUED',
           b.batch_number, f.code, p.version_number, p.selection ->> 'rule', v_number, v_alloc, cr.snapshot_hash, coalesce(v_actor ->> 'legal_name', v_actor ->> 'person_id')),
    jsonb_build_object('allocation_id', v_alloc, 'pin_id', p.id, 'version_id', p.version_id, 'content_hash', p.content_hash, 'control_recipe_id', cr.id,
                       'snapshot_hash', cr.snapshot_hash));
  return jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'allocation_id', v_alloc, 'pin_id', p.id, 'version_id', p.version_id,
                            'version_number', p.version_number, 'content_hash', p.content_hash, 'rule', p.selection ->> 'rule', 'markets', to_jsonb(p.markets),
                            'control_recipe_id', cr.id, 'snapshot_hash', cr.snapshot_hash, 'erp_order', v_order ->> 'orderNo');
end
$$;

-- As 0501; the issue command's permission with the planned batch's product (header).
create or replace function recipe.begin_gmp_issue(p_batch uuid) returns jsonb
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
  -- 6jc-R16: the issue command's permission at the actor's location with the planned batch's product (its family's).
  perform recipe.require_issue_permission((select f0.product_code from recipe.stub_batch b0 join recipe.mbr_family f0 on f0.id = b0.family_id where b0.id = p_batch));
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

-- As 0501; the issue command's permission with the planned batch's product (header).
create or replace function recipe.issue_gmp_execution(p_batch uuid, p_signature uuid, p_batch_number text, p_request jsonb, p_policy jsonb, p_policy_hash text,
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
  -- 6jc-R16: the issue command's permission at the actor's location with the planned batch's product (its family's).
  perform recipe.require_issue_permission((select f0.product_code from recipe.stub_batch b0 join recipe.mbr_family f0 on f0.id = b0.family_id where b0.id = p_batch));
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

revoke all on function recipe.require_issue_permission(text) from public;

reset role;
