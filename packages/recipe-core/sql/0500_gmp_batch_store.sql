-- Recipe core, execution store (module C3): a GMP batch is stored next to the sandbox's test batches (Phase 3 slice 2b;
-- docs/build-plan/phase-3/slice-2b-plan.md items 1 and 4; DI-05, INV-18, INV-01, INV-02, INV-27, IN-18; outline 5.2.2).
--
-- Until now recipe.batch_execution held only sandbox test runs: a row named the imported test package it ran
-- (package_hash, NOT NULL, references recipe.test_package) and the checks allowed nothing but installation SANDBOX and
-- purpose SANDBOX_TEST_RUN. A GMP batch runs the control recipe of an effective MBR version instead (recipe-core 0170:
-- the selection at issue, the pin INV-01, the control-recipe snapshot and hash INV-02), with a batch number allocated
-- from the site's register (site services 0600) and an issue signature with the meaning ISSUED (kernel 0210).
--
-- What this migration adds (the writers are 0501, the readers of a batch's MBR content 0502, the invariant query 0503):
--   * recipe.batch_execution.control_recipe_id (the GMP batch's control recipe, unique) and issue_signature_id (its
--     ISSUED signature, unique: a signature issues one batch); package_hash may be NULL now. One check holds every row
--     to exactly one origin: a SANDBOX test run (purpose SANDBOX_TEST_RUN) names a test package and neither of the GMP
--     links; a GMP batch (purpose GMP_BATCH) names its control recipe and its issue signature and never a test package.
--   * recipe.batch_allocation_link: the planned GMP batch (recipe.stub_batch row with the batch's id) and the register
--     allocation of its number, one to one, insert-only. Its guard refuses an allocation of another number, site,
--     product, edition, record kind or batch size, a voided one, and a batch already pinned (EBMR-EXE-191). A number is
--     linked once (unique allocation and number), so it is never reused.
--   * a guard on recipe.control_recipe: the control recipe of a batch planned for GMP execution (a linked batch) holds
--     no SANDBOX_ONLY block version (recipe.sandbox_only_block; D-S2b-2: G-09 and G-10 version 1 stay sandbox-only),
--     EBMR-EXE-195.
--   * recipe.batch_execution_origin_check (trigger aa_execution_origin, before insert): a row is of this database's
--     installation (a sandbox record never becomes a GMP record and a GMP record is never written in the sandbox,
--     EBMR-EXE-190), and a GMP row is exactly its planned batch: the linked, not voided allocation's number, the
--     control recipe of this batch that still verifies (INV-02), its MBR content hash, the pinned market set and batch
--     size, the planned site, no SANDBOX_ONLY block, and a valid ISSUED signature of the issuer on the batch's issue
--     content (EBMR-EXE-190 to 195).
--   * the e-signature aggregate batch_issue (recipe.batch_issue_content): what the issuer signs with ISSUED, the batch
--     number and its allocation, the family and product, the pinned version and its content hash, the markets, site,
--     line and batch size, and the control recipe with its hash. Every part is insert-only, so a signature once given
--     stays valid; the tables are registered signed tables all the same (INV-09).
--   * recipe.execution_mbr_content / recipe.batch_mbr_content: the MBR content a batch runs, from its test package or
--     from its control recipe's snapshot; recipe.content_for_mbr_hash: the content of a stored MBR content hash.
--   * the batch identity guard (0450) also freezes the two new links.
--
-- Messages: EBMR-EXE-190 to 199 (the GMP batch issue). Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- recipe.batch_execution: one origin per row
-- ---------------------------------------------------------------------------------------------

alter table recipe.batch_execution add column control_recipe_id uuid unique references recipe.control_recipe (id);
alter table recipe.batch_execution add column issue_signature_id uuid unique;
alter table recipe.batch_execution alter column package_hash drop not null;
alter table recipe.batch_execution drop constraint batch_execution_installation_check;
alter table recipe.batch_execution drop constraint batch_execution_purpose_check;
alter table recipe.batch_execution add constraint batch_execution_origin check (
  (installation = 'SANDBOX' and purpose = 'SANDBOX_TEST_RUN' and package_hash is not null and control_recipe_id is null and issue_signature_id is null)
  or (installation = 'GMP' and purpose = 'GMP_BATCH' and package_hash is null and control_recipe_id is not null and issue_signature_id is not null));

-- ---------------------------------------------------------------------------------------------
-- The MBR content a batch runs
-- ---------------------------------------------------------------------------------------------

-- DI-05, INV-02: the MBR content of a batch of test package p_package_hash (sandbox) or control recipe p_control_recipe
-- (GMP): the package's content, or the content the control recipe's snapshot holds. NULL when it names neither.
create function recipe.execution_mbr_content(p_package_hash text, p_control_recipe uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case
           when p_package_hash is not null then (select pk.content from recipe.test_package pk where pk.package_hash = p_package_hash)
           when p_control_recipe is not null then (select cr.snapshot -> 'mbr' -> 'content' from recipe.control_recipe cr where cr.id = p_control_recipe)
         end
$$;

-- The MBR content batch p_batch runs.
create function recipe.batch_mbr_content(p_batch uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) from recipe.batch_execution b where b.id = p_batch
$$;

-- The MBR content whose content hash is p_hash, from a test package or a control recipe of a batch (the engine state
-- names its MBR by this hash, mbrHash). NULL when none holds it.
create function recipe.content_for_mbr_hash(p_hash text) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce((select pk.content from recipe.test_package pk where pk.content_hash = p_hash limit 1),
                  (select cr.snapshot -> 'mbr' -> 'content' from recipe.control_recipe cr
                    where cr.mbr_content_hash = p_hash and recipe.json_hash(cr.snapshot -> 'mbr' -> 'content') = p_hash limit 1))
$$;

-- DI-05, INV-18: the SANDBOX_ONLY block versions MBR content p_content holds, as type@version, sorted ({} when none).
create function recipe.sandbox_only_blocks_in(p_content jsonb) returns text[]
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(array_agg(distinct s.block_type || '@' || s.block_version order by s.block_type || '@' || s.block_version), '{}')
    from jsonb_path_query(coalesce(p_content, '{}'::jsonb), 'strict $.**.block') blk
    join recipe.sandbox_only_block s on s.block_type = blk ->> 'type' and s.block_version = blk ->> 'version'
$$;

-- ---------------------------------------------------------------------------------------------
-- The batch number of a GMP batch: one register allocation, linked once (INV-27, IN-18)
-- ---------------------------------------------------------------------------------------------

create table recipe.batch_allocation_link (
  batch_id        uuid primary key references recipe.stub_batch (id),
  allocation_id   uuid not null unique references site.batch_number_allocation (id),
  batch_number    text not null unique,
  person_id       uuid not null,
  account_id      uuid not null,
  correlation_id  uuid not null,
  recorded_at     timestamptz not null default clock_timestamp()
);
revoke all on recipe.batch_allocation_link from public;

-- Why allocation p_allocation is not the register entry of planned batch p_batch's number; NULL when it is: the same
-- number, site, product, edition, record kind and batch size (value and unit of the family's approved size), not voided.
create function recipe.allocation_problem(p_batch uuid, p_allocation uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  b  recipe.stub_batch;
  f  recipe.mbr_family;
  a  site.batch_number_allocation;
  sz jsonb;
begin
  select * into b from recipe.stub_batch where id = p_batch;
  select * into a from site.batch_number_allocation where id = p_allocation;
  if b.id is null then
    return 'the batch is not planned';
  end if;
  if a.id is null then
    return format('allocation %s is not in the site''s batch-number register', p_allocation);
  end if;
  select * into f from recipe.mbr_family where id = b.family_id;
  sz := (select x -> 'quantity' from jsonb_array_elements(f.batch_sizes) x where x ->> 'id' = b.batch_size limit 1);
  if exists (select 1 from site.batch_number_void v where v.allocation_id = a.id) then
    return format('batch number %s was voided in the register; a voided number is never issued', a.batch_number);
  end if;
  if a.batch_number is distinct from b.batch_number then
    return format('the register allocated %s, not %s', a.batch_number, b.batch_number);
  end if;
  if a.site_code is distinct from b.site or a.product_code is distinct from f.product_code or a.edition is distinct from upper(f.edition)
     or a.batch_kind is distinct from f.record_kind then
    return format('batch number %s was allocated for %s %s %s at site %s, not for %s %s %s at site %s', a.batch_number, a.edition, a.batch_kind, a.product_code,
                  a.site_code, upper(f.edition), f.record_kind, f.product_code, b.site);
  end if;
  if sz is null or a.batch_size is distinct from (case when (sz ->> 'value') ~ '^[0-9]+(\.[0-9]+)?$' then (sz ->> 'value')::numeric end)
     or a.batch_size_unit is distinct from sz ->> 'unit' then
    return format('batch number %s was allocated for a batch of %s %s, not for the batch size %s of the batch', a.batch_number, a.batch_size, a.batch_size_unit, b.batch_size);
  end if;
  return null;
end
$$;

-- INV-27, IN-18: the link is the register allocation of the planned batch's own number, made before the batch is pinned.
create function recipe.batch_allocation_link_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_ctx     jsonb := recipe.require_actor();
  b         recipe.stub_batch;
  v_problem text;
begin
  select * into b from recipe.stub_batch where id = new.batch_id for update;
  if b.id is null or b.status <> 'PLANNED' or exists (select 1 from recipe.batch_mbr_pin p where p.batch_id = new.batch_id) then
    raise exception using errcode = 'P0001',
      message = 'A batch number is linked to a planned batch before it is pinned, once (INV-27, IN-18). [EBMR-EXE-191]';
  end if;
  perform 1 from site.batch_number_allocation a where a.id = new.allocation_id for update;
  v_problem := recipe.allocation_problem(new.batch_id, new.allocation_id);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The batch number of batch %s is not one the site''s register allocated for it: %s (INV-27, IN-18, DI-05). [EBMR-EXE-191]', b.batch_number, v_problem);
  end if;
  new.batch_number := b.batch_number;
  new.person_id := (v_ctx ->> 'person_id')::uuid;
  new.account_id := (v_ctx ->> 'account_id')::uuid;
  new.correlation_id := (v_ctx ->> 'correlation_id')::uuid;
  return new;
end
$$;
create trigger a1_guard before insert on recipe.batch_allocation_link for each row execute function recipe.batch_allocation_link_guard();
create trigger aa_insert_only before update or delete on recipe.batch_allocation_link for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.batch_allocation_link for each statement execute function kernel.reject_mutation();

-- DI-05, INV-18, D-S2b-2: the control recipe of a batch planned for GMP execution holds no SANDBOX_ONLY block version.
create function recipe.control_recipe_sandbox_only_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_blocks text[];
begin
  if exists (select 1 from recipe.batch_allocation_link l where l.batch_id = new.batch_id) then
    v_blocks := recipe.sandbox_only_blocks_in(new.snapshot -> 'mbr' -> 'content');
    if cardinality(v_blocks) > 0 then
      raise exception using errcode = 'P0001',
        message = format('The MBR version holds %s, which run only in the sandbox; a GMP batch is never issued with a sandbox-only block (DI-05, INV-18). [EBMR-EXE-195]',
                         array_to_string(v_blocks, ', '));
    end if;
  end if;
  return new;
end
$$;
create trigger b1_sandbox_only_blocks before insert on recipe.control_recipe for each row execute function recipe.control_recipe_sandbox_only_guard();

-- ---------------------------------------------------------------------------------------------
-- What the issuer signs: the batch_issue aggregate (meaning ISSUED, kernel 0210)
-- ---------------------------------------------------------------------------------------------

-- DI-35, INV-02, INV-09: the issue content of planned GMP batch p_id: its number and register allocation, family and
-- product, the pinned version and content hash, the selection rule, markets, site, line and batch size, and the
-- control recipe with its hash. State PLANNED until the batch is issued, then ISSUED. Scope: the batch's site and product.
create function recipe.batch_issue_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  l  recipe.batch_allocation_link;
  b  recipe.stub_batch;
  p  recipe.batch_mbr_pin;
  cr recipe.control_recipe;
  f  recipe.mbr_family;
begin
  if p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return jsonb_build_object('exists', false);
  end if;
  select * into l from recipe.batch_allocation_link where batch_id = p_id::uuid;
  select * into b from recipe.stub_batch where id = l.batch_id;
  select * into p from recipe.batch_mbr_pin where batch_id = l.batch_id;
  select * into cr from recipe.control_recipe where batch_id = l.batch_id;
  if l.batch_id is null or b.id is null or p.id is null or cr.id is null then
    return jsonb_build_object('exists', false);
  end if;
  select * into f from recipe.mbr_family where id = b.family_id;
  return jsonb_build_object(
    'exists', true, 'aggregate_id', l.batch_id::text, 'content_version', 1,
    'state', case when exists (select 1 from recipe.batch_execution x where x.id = l.batch_id) then 'ISSUED' else 'PLANNED' end,
    'scope', jsonb_build_object('site', b.site, 'product', f.product_code),
    'entered_by', '[]'::jsonb,
    'content', jsonb_build_object(
      'batchId', l.batch_id::text, 'batchNumber', l.batch_number, 'allocationId', l.allocation_id::text,
      'family', f.code, 'product', jsonb_build_object('code', f.product_code, 'name', f.product_name, 'strength', f.strength, 'dosageForm', f.dosage_form),
      'versionId', p.version_id::text, 'versionNumber', p.version_number, 'mbrContentHash', p.content_hash, 'selectionRule', p.selection ->> 'rule',
      'markets', to_jsonb(p.markets), 'site', b.site, 'line', b.line, 'batchSize', cr.snapshot -> 'batch' -> 'batch_size',
      'pinId', p.id::text, 'controlRecipeId', cr.id::text, 'controlRecipeHash', cr.snapshot_hash));
end
$$;

select esig.register_content_provider('batch_issue', 'recipe.batch_issue_content(text)',
  'A GMP batch as issued from its effective MBR version: number and register allocation, pinned version, markets, scope and control recipe (meaning ISSUED; C3)');
select esig.register_signed_table('recipe.batch_allocation_link', 'batch_issue', 'batch_id');
select esig.register_signed_table('recipe.batch_mbr_pin', 'batch_issue', 'batch_id');
select esig.register_signed_table('recipe.control_recipe', 'batch_issue', 'batch_id');

-- ---------------------------------------------------------------------------------------------
-- The origin of a row (DI-05, INV-18) and a GMP row as planned, pinned, allocated and signed
-- ---------------------------------------------------------------------------------------------

-- Why GMP batch row p_row is not exactly its planned batch; NULL when it is. Also read by recipe.execution_violations.
create function recipe.gmp_batch_problem(p_row recipe.batch_execution) returns text
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, pg_temp as $$
declare
  l       recipe.batch_allocation_link;
  b       recipe.stub_batch;
  p       recipe.batch_mbr_pin;
  cr      recipe.control_recipe;
  v_ver   jsonb;
  v_sig   jsonb;
  v_prob  text;
  v_blk   text[];
begin
  select * into b from recipe.stub_batch where id = p_row.id;
  select * into l from recipe.batch_allocation_link where batch_id = p_row.id;
  select * into p from recipe.batch_mbr_pin where batch_id = p_row.id;
  select * into cr from recipe.control_recipe where batch_id = p_row.id;
  if b.id is null or p.id is null then
    return '[192] it has no planned batch with a pinned MBR version (INV-01)';
  end if;
  if cr.id is null or cr.id is distinct from p_row.control_recipe_id then
    return '[192] it does not name the control recipe of its own batch (INV-02)';
  end if;
  v_ver := recipe.verify_control_recipe(p_row.id);
  if not (v_ver ->> 'ok')::boolean then
    return format('[192] its control recipe does not verify: %s (INV-02)', v_ver ->> 'problems');
  end if;
  if p_row.content_hash is distinct from cr.mbr_content_hash then
    return '[192] it runs other MBR content than its control recipe holds (INV-02)';
  end if;
  if l.batch_id is null then
    return '[191] its batch number has no allocation in the site''s register (INV-27, IN-18)';
  end if;
  v_prob := recipe.allocation_problem(p_row.id, l.allocation_id);
  if v_prob is not null or p_row.batch_number is distinct from l.batch_number then
    return format('[191] its batch number is not the one the register allocated for it: %s (INV-27, IN-18)', coalesce(v_prob, 'another number'));
  end if;
  if p_row.market_set is distinct from p.markets or p_row.batch_size is distinct from b.batch_size or p_row.site_code is distinct from b.site then
    return format('[194] its market set, batch size or site (%s; %s; %s) is not the pinned batch''s (%s; %s; %s) (INV-01, INV-28, PR-04)',
                  array_to_string(p_row.market_set, ','), p_row.batch_size, p_row.site_code, array_to_string(p.markets, ','), b.batch_size, b.site);
  end if;
  v_blk := recipe.sandbox_only_blocks_in(cr.snapshot -> 'mbr' -> 'content');
  if cardinality(v_blk) > 0 then
    return format('[195] its MBR holds %s, which run only in the sandbox (DI-05, INV-18)', array_to_string(v_blk, ', '));
  end if;
  v_prob := esig.signature_problem(p_row.issue_signature_id, 'ISSUED', 'batch_issue', p_row.id::text);
  if v_prob is not null then
    return format('[193] its issue signature is not a valid ISSUED signature of its issue content: %s (DI-35, INV-10)', v_prob);
  end if;
  v_sig := esig.signature_state(p_row.issue_signature_id);
  if v_sig ->> 'signer_person' is distinct from p_row.issued_by_person::text then
    return '[193] its issue signature is not the issuer''s own (DI-35, DI-14)';
  end if;
  return null;
end
$$;

-- DI-05, INV-18, INV-01, INV-02, INV-27: a row is of this database's installation; a GMP row is its planned batch.
create function recipe.batch_execution_origin_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_problem text;
begin
  if new.installation is distinct from kernel.installation_kind() then
    raise exception using errcode = 'P0001',
      message = format('Batch %s is a %s record and this is a %s database: a sandbox record never becomes a GMP record, and a GMP record is never written in the sandbox (DI-05, INV-18). [EBMR-EXE-190]',
                       new.batch_number, coalesce(new.installation, 'nameless'), kernel.installation_kind());
  end if;
  if new.installation = 'GMP' then
    v_problem := recipe.gmp_batch_problem(new);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('GMP batch %s cannot be recorded: %s. [%s]', new.batch_number, substr(v_problem, 7),
                         case substr(v_problem, 2, 3) when '191' then 'EBMR-EXE-191' when '192' then 'EBMR-EXE-192' when '193' then 'EBMR-EXE-193'
                                                      when '194' then 'EBMR-EXE-194' else 'EBMR-EXE-195' end);
    end if;
  end if;
  return new;
end
$$;
create trigger aa_execution_origin before insert on recipe.batch_execution for each row execute function recipe.batch_execution_origin_check();

-- INV-09 (0450, now with the GMP links): the identity of a batch, which its record's signed content holds, never changes
-- once issued. EBMR-EXE-170.
create or replace function recipe.batch_record_identity_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if (new.id, new.batch_number, new.installation, new.purpose, new.package_hash, new.content_hash, new.engine_version,
      new.policy_hash, new.market_set, new.batch_size, new.site_code, new.issued_at_us, new.control_recipe_id, new.issue_signature_id)
     is distinct from
     (old.id, old.batch_number, old.installation, old.purpose, old.package_hash, old.content_hash, old.engine_version,
      old.policy_hash, old.market_set, old.batch_size, old.site_code, old.issued_at_us, old.control_recipe_id, old.issue_signature_id) then
    raise exception using errcode = 'P0001',
      message = format('The identity of test batch %s is part of its signed record and never changes once issued (DI-37, INV-09). [EBMR-EXE-170]', old.batch_number);
  end if;
  return new;
end
$$;

select platform.enforce_db_time('recipe.batch_allocation_link', array['recorded_at']);
select kernel.register_audited_table('recipe.batch_allocation_link', 'batch', 'batch_id', true);

grant select on recipe.batch_allocation_link to ebmr_app;
revoke all on function recipe.execution_mbr_content(text, uuid), recipe.batch_mbr_content(uuid), recipe.content_for_mbr_hash(text),
                       recipe.sandbox_only_blocks_in(jsonb), recipe.allocation_problem(uuid, uuid), recipe.batch_allocation_link_guard(),
                       recipe.control_recipe_sandbox_only_guard(), recipe.batch_issue_content(text), recipe.gmp_batch_problem(recipe.batch_execution),
                       recipe.batch_execution_origin_check() from public;

reset role;
