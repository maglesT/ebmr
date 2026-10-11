-- The company formulation library (Phase 3 slice 6a; decision 0006 part 1; slice 6 plan D-S6-3, D-S6-4; controls DI-13
-- clause 3 (the composition is confidential: readable only with FORMULA.READ), INV-25 (quantities computed, never typed),
-- DI-35 (two-person approval), PR-06 (an approved master's content never changes: a new formula version needs a new MBR
-- version)). Rules hold when the application's own database credentials are used directly (ADR 0012, 0016).
--
--   recipe.formula            insert-only, audited: one formula per product, strength and batch size in units, for a
--                             product of the ERP product master (FORMULA.MANAGE)
--   recipe.formula_version    insert-only, audited: versions 1, 2, ... of a formula, each with the author's reason
--   recipe.formula_line       insert-only, audited: the per-unit composition of a version (mg per unit; a processing aid
--                             in kg per batch) with the batch quantity in kg the database computed from it and the batch
--                             size (per unit x units x (1 + overage %) x salt factor / 10^6), never typed. Every material
--                             is in the ERP material master; overage and salt factor only on a PER_UNIT ACTIVE line;
--                             potency adjustment only on an ACTIVE line; at most one compensating excipient
--   recipe.formula_approval   insert-only, audited: the FORMULA_APPROVED signature of a version, by a person other than
--                             its author, of the formula's latest version only, once
--   recipe.mbr_formula_pin    insert-only, audited: the formula version an MBR version's composition was taken from, once
--                             per MBR version, while it is a DRAFT; the MBR's product and strength are the formula's, its
--                             reference batch size is the formula's theoretical batch mass and its BOM lines of the
--                             formula's materials carry exactly the computed quantities (recipe.formula_mbr_problem)
-- State of a version (recipe.formula_version_state): DRAFT until approved; APPROVED while no later version is approved;
-- SUPERSEDED after.
-- Readers (DI-13): the composition is served only to an actor holding FORMULA.READ in the product's scope; the application
-- role reads no formula table directly (it holds no SELECT on them).
-- MBR approval: recipe.guard_registered_ranges_kept (0130, latest) is replaced to refuse also an MBR version whose
-- pinned formula version is not APPROVED, or whose content no longer carries the formula's composition.
-- Messages: EBMR-FRM-001 to EBMR-FRM-019.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Permissions and the approval meaning (D-S6-4)
-- ---------------------------------------------------------------------------------------------

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0640_formulation_library)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'formulation library permissions and the formula approval meaning (decision 0006; D-S6-3, D-S6-4)'));

insert into iam.permission (code, domain, effect, description) values
  ('FORMULA.READ', 'READ_ONLY', 'READ', 'Read a formula''s composition (confidential master data of the dossier) and the composition of an MBR taken from it'),
  ('FORMULA.MANAGE', 'GMP', 'WRITE', 'Record a formula and write draft versions of its per-unit composition'),
  ('FORMULA.APPROVE', 'GMP', 'SIGN', 'Approve a formula version written by another person (FORMULA_APPROVED)');

insert into iam.role_permission (role_code, permission_code) values
  ('MASTER_DATA_STEWARD', 'FORMULA.READ'), ('MASTER_DATA_STEWARD', 'FORMULA.MANAGE'), ('MASTER_DATA_STEWARD', 'FORMULA.APPROVE'),
  ('MBR_AUTHOR', 'FORMULA.READ'), ('MBR_CHECKER', 'FORMULA.READ'),
  ('QA_MBR_APPROVER', 'FORMULA.READ'), ('QA_MBR_APPROVER', 'FORMULA.APPROVE'),
  ('QA_REVIEWER', 'FORMULA.READ'), ('QA_SHOP_FLOOR', 'FORMULA.READ'), ('AUTHORISED_PERSON', 'FORMULA.READ'),
  ('QC_ANALYST', 'FORMULA.READ'), ('HEAD_OF_QC', 'FORMULA.READ'),
  ('HEAD_OF_PRODUCTION', 'FORMULA.READ');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('FORMULA_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'MASTER_RECORD', 'APPROVER', 'Formula version approved',
   'I approve this formula version: its composition per unit and the batch quantities computed from it match the registered dossier.',
   array['FORMULA.APPROVE'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'Decision 0006 part 1; outline 5.2.1 (master data under change control); DI-35; INV-25');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Registers
-- ---------------------------------------------------------------------------------------------

create table recipe.formula (
  id                  uuid primary key default gen_random_uuid(),
  product_code        text not null check (btrim(product_code) <> '' and length(product_code) <= 64),
  strength            text not null check (btrim(strength) <> '' and length(strength) <= 64),
  batch_size_units    numeric not null check (batch_size_units >= 1 and scale(batch_size_units) = 0 and batch_size_units < 1000000000000),
  created_by_person   uuid not null,
  created_by_account  uuid not null,
  created_at          timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null,
  unique (product_code, strength, batch_size_units)
);

create table recipe.formula_version (
  id                  uuid primary key default gen_random_uuid(),
  formula_id          uuid not null references recipe.formula (id),
  version_number      integer not null check (version_number >= 1),
  change_reason       text not null check (btrim(change_reason) <> '' and length(change_reason) <= 2000),
  authored_by_person  uuid not null,
  authored_by_account uuid not null,
  authored_at         timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null,
  unique (formula_id, version_number)
);

create table recipe.formula_line (
  version_id          uuid not null references recipe.formula_version (id),
  line_id             text not null check (line_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,31}$'),
  ordinal             integer not null check (ordinal >= 1),
  material_code       text not null check (material_code ~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$'),
  material_name       text not null,
  role                text not null check (role in ('ACTIVE', 'EXCIPIENT', 'COATING', 'PROCESSING_AID')),
  basis               text not null check (basis in ('PER_UNIT', 'PER_BATCH')),
  quantity            numeric not null check (quantity > 0),
  overage_percent     numeric check (overage_percent >= 0 and overage_percent < 100),
  salt_factor         numeric check (salt_factor >= 1 and salt_factor < 10),
  potency_adjusted    boolean not null,
  compensating        boolean not null,
  batch_quantity_kg   numeric not null check (batch_quantity_kg > 0),
  primary key (version_id, line_id),
  unique (version_id, material_code),
  check ((overage_percent is null and salt_factor is null) or (role = 'ACTIVE' and basis = 'PER_UNIT')),
  check (not potency_adjusted or role = 'ACTIVE'),
  check (not compensating or role = 'EXCIPIENT')
);

create table recipe.formula_approval (
  version_id          uuid primary key references recipe.formula_version (id),
  signature_id        uuid not null unique,
  approved_by_person  uuid not null,
  approved_by_account uuid not null,
  approved_at         timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null
);

create table recipe.mbr_formula_pin (
  mbr_version_id      uuid primary key references recipe.mbr_version (id),
  formula_version_id  uuid not null references recipe.formula_version (id),
  pinned_by_person    uuid not null,
  pinned_by_account   uuid not null,
  pinned_at           timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null
);

do $$
declare
  t text;
begin
  foreach t in array array['recipe.formula', 'recipe.formula_version', 'recipe.formula_line', 'recipe.formula_approval', 'recipe.mbr_formula_pin'] loop
    execute format('revoke all on %s from public', t);
    execute format('create trigger aa_insert_only before update or delete on %s for each row execute function kernel.reject_mutation()', t);
    execute format('create trigger aa_no_truncate before truncate on %s for each statement execute function kernel.reject_mutation()', t);
  end loop;
end
$$;

select platform.enforce_db_time('recipe.formula', array['created_at']);
select platform.enforce_db_time('recipe.formula_version', array['authored_at']);
select platform.enforce_db_time('recipe.formula_approval', array['approved_at']);
select platform.enforce_db_time('recipe.mbr_formula_pin', array['pinned_at']);

select kernel.register_audited_table('recipe.formula', 'formula', 'id', true);
select kernel.register_audited_table('recipe.formula_version', 'formula', 'formula_id', true);
select kernel.register_audited_table('recipe.formula_line', 'formula_version', 'version_id', true);
select kernel.register_audited_table('recipe.formula_approval', 'formula_version', 'version_id', true);
select kernel.register_audited_table('recipe.mbr_formula_pin', 'mbr_version', 'mbr_version_id', true);

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

create function recipe.formula_fail(p_code text, p_message text) returns void
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  raise exception using errcode = 'P0001', message = format('%s [%s]', p_message, p_code);
end
$$;

-- DRAFT, APPROVED or SUPERSEDED (NULL for an unknown version).
create function recipe.formula_version_state(p_version uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case
           when not exists (select 1 from recipe.formula_approval a where a.version_id = v.id) then 'DRAFT'
           when exists (select 1 from recipe.formula_version w join recipe.formula_approval a on a.version_id = w.id
                         where w.formula_id = v.formula_id and w.version_number > v.version_number) then 'SUPERSEDED'
           else 'APPROVED' end
    from recipe.formula_version v where v.id = p_version
$$;

-- DI-13: whether the actor holds FORMULA.READ in the product's scope now (the evaluation is stored, INV-26).
create function recipe.formula_reader(p_product text) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
begin
  return coalesce((iam.evaluate_authority((v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, 'FORMULA.READ',
                                          jsonb_build_object('product', p_product), clock_timestamp(), v_actor ->> 'role_code') ->> 'allowed')::boolean, false);
end
$$;

-- The lines of a version as JSON, in order (no permission check: callers check FORMULA.READ).
create function recipe.formula_lines_json(p_version uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'lineId', l.line_id, 'materialCode', l.material_code, 'materialName', l.material_name, 'role', l.role, 'basis', l.basis,
           'quantity', trim_scale(l.quantity)::text, 'quantityUnit', case l.basis when 'PER_UNIT' then 'mg' else 'kg' end,
           'overagePercent', trim_scale(l.overage_percent)::text, 'saltFactor', trim_scale(l.salt_factor)::text,
           'potencyAdjusted', l.potency_adjusted, 'compensating', l.compensating,
           'batchQuantity', trim_scale(l.batch_quantity_kg)::text, 'batchUnit', 'kg') order by l.ordinal), '[]'::jsonb)
    from recipe.formula_line l where l.version_id = p_version
$$;

-- The theoretical batch mass (kg) of a version: its PER_UNIT lines other than processing aids.
create function recipe.formula_batch_mass(p_version uuid) returns numeric
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(sum(l.batch_quantity_kg), 0) from recipe.formula_line l where l.version_id = p_version and l.basis = 'PER_UNIT' and l.role <> 'PROCESSING_AID'
$$;

-- ---------------------------------------------------------------------------------------------
-- Writers
-- ---------------------------------------------------------------------------------------------

-- p: {productCode, strength, batchSizeUnits}. FORMULA.MANAGE in the product's scope; a product of the ERP product master.
create function recipe.formula_create(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, site, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v_id    uuid := gen_random_uuid();
begin
  perform iam.assert_not_administrator();
  if jsonb_typeof(p) is distinct from 'object' or coalesce(p ->> 'batchSizeUnits', '') !~ '^[1-9][0-9]{0,11}$' then
    perform recipe.formula_fail('EBMR-FRM-001', 'A formula names a product, a strength and a batch size in whole units (D-S6-3)');
  end if;
  perform iam.require_permission('FORMULA.MANAGE', jsonb_build_object('product', p ->> 'productCode'));
  if site.product_master_of(p ->> 'productCode', p ->> 'strength') is null then
    perform recipe.formula_fail('EBMR-FRM-002', format('Product %s %s is not in the ERP product master; a formula is recorded only for a known product (D-S6-3)',
                                                      coalesce(p ->> 'productCode', 'NULL'), coalesce(p ->> 'strength', 'NULL')));
  end if;
  insert into recipe.formula (id, product_code, strength, batch_size_units, created_by_person, created_by_account, correlation_id)
  values (v_id, p ->> 'productCode', p ->> 'strength', (p ->> 'batchSizeUnits')::numeric, (v_actor ->> 'person_id')::uuid,
          (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return v_id;
end
$$;

-- p: {changeReason, lines: [{lineId, materialCode, role, basis, quantity, overagePercent?, saltFactor?, potencyAdjusted,
-- compensating}]}. A new DRAFT version; the batch quantities are computed here (INV-25). Refused while the formula's latest
-- version is a DRAFT (one draft at a time).
create function recipe.formula_add_version(p_formula uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, site, pg_temp as $$
declare
  v_actor  jsonb := iam.assert_validated_actor();
  f        recipe.formula;
  v_id     uuid := gen_random_uuid();
  v_n      integer;
  l        jsonb;
  m        site.erp_material;
  v_ord    integer := 0;
  v_qty    numeric;
  v_over   numeric;
  v_salt   numeric;
  v_batch  numeric;
  v_dec    text := '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$';
begin
  perform iam.assert_not_administrator();
  select * into f from recipe.formula where id = p_formula for update;
  if f.id is null then
    perform recipe.formula_fail('EBMR-FRM-003', format('There is no formula %s', p_formula));
  end if;
  perform iam.require_permission('FORMULA.MANAGE', jsonb_build_object('product', f.product_code));
  if btrim(coalesce(p ->> 'changeReason', '')) = '' then
    perform recipe.formula_fail('EBMR-FRM-004', 'A formula version carries its author''s reason (DI-22)');
  end if;
  if jsonb_typeof(p -> 'lines') is distinct from 'array' or jsonb_array_length(p -> 'lines') = 0 or jsonb_array_length(p -> 'lines') > 60 then
    perform recipe.formula_fail('EBMR-FRM-005', 'A formula version lists 1 to 60 lines (D-S6-3)');
  end if;
  select coalesce(max(version_number), 0) into v_n from recipe.formula_version where formula_id = f.id;
  if v_n > 0 and recipe.formula_version_state((select id from recipe.formula_version where formula_id = f.id and version_number = v_n)) = 'DRAFT' then
    perform recipe.formula_fail('EBMR-FRM-006', format('Version %s of this formula is still a draft; a new version follows an approved one', v_n));
  end if;
  insert into recipe.formula_version (id, formula_id, version_number, change_reason, authored_by_person, authored_by_account, correlation_id)
  values (v_id, f.id, v_n + 1, btrim(p ->> 'changeReason'), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  for l in select * from jsonb_array_elements(p -> 'lines') loop
    v_ord := v_ord + 1;
    if jsonb_typeof(l) is distinct from 'object' or coalesce(l ->> 'quantity', '') !~ v_dec
       or (l ? 'overagePercent' and jsonb_typeof(l -> 'overagePercent') <> 'null' and coalesce(l ->> 'overagePercent', '') !~ v_dec)
       or (l ? 'saltFactor' and jsonb_typeof(l -> 'saltFactor') <> 'null' and coalesce(l ->> 'saltFactor', '') !~ v_dec)
       or jsonb_typeof(l -> 'potencyAdjusted') is distinct from 'boolean' or jsonb_typeof(l -> 'compensating') is distinct from 'boolean'
       or coalesce(l ->> 'basis', '') not in ('PER_UNIT', 'PER_BATCH') then
      perform recipe.formula_fail('EBMR-FRM-007', format('Line %s: quantities are decimal text, the basis PER_UNIT or PER_BATCH, and the flags yes or no (INV-25)', v_ord));
    end if;
    m := site.erp_material_current(l ->> 'materialCode');
    if m.id is null then
      perform recipe.formula_fail('EBMR-FRM-008', format('Line %s: material %s is not in the ERP material master', v_ord, coalesce(l ->> 'materialCode', 'NULL')));
    end if;
    v_qty := (l ->> 'quantity')::numeric;
    v_over := nullif(l ->> 'overagePercent', '')::numeric;
    v_salt := nullif(l ->> 'saltFactor', '')::numeric;
    if l ->> 'basis' = 'PER_BATCH' and l ->> 'role' <> 'PROCESSING_AID' then
      perform recipe.formula_fail('EBMR-FRM-009', format('Line %s: only a processing aid is given per batch; a component of the unit is given per unit (INV-25)', v_ord));
    end if;
    -- INV-25: the batch quantity is computed, never typed.
    v_batch := case l ->> 'basis'
                 when 'PER_UNIT' then v_qty * f.batch_size_units * (100 + coalesce(v_over, 0)) / 100 * coalesce(v_salt, 1) / 1000000
                 else v_qty end;
    begin
      insert into recipe.formula_line (version_id, line_id, ordinal, material_code, material_name, role, basis, quantity, overage_percent, salt_factor,
                                       potency_adjusted, compensating, batch_quantity_kg)
      values (v_id, l ->> 'lineId', v_ord, m.material_code, m.material_name, l ->> 'role', l ->> 'basis', v_qty, v_over, v_salt,
              (l ->> 'potencyAdjusted')::boolean, (l ->> 'compensating')::boolean, v_batch);
    exception when check_violation or unique_violation or not_null_violation then
      perform recipe.formula_fail('EBMR-FRM-010', format('Line %s is not a valid formula line: a line id once, a material once, overage and salt factor only on a per-unit active, potency adjustment only on an active, compensation only on an excipient (D-S6-3)', v_ord));
    end;
  end loop;
  if (select count(*) from recipe.formula_line where version_id = v_id and compensating) > 1 then
    perform recipe.formula_fail('EBMR-FRM-011', 'A formula has at most one compensating excipient (TB-01)');
  end if;
  if exists (select 1 from recipe.formula_line where version_id = v_id and potency_adjusted)
     <> exists (select 1 from recipe.formula_line where version_id = v_id and compensating) then
    perform recipe.formula_fail('EBMR-FRM-011', 'A potency-adjusted active needs its compensating excipient, and a compensating excipient an adjusted active (TB-01)');
  end if;
  return v_id;
end
$$;

-- DI-35: the FORMULA_APPROVED signature of the actor on the version; never its author's; the latest version only, once.
create function recipe.formula_approve(p_version uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, esig, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v       recipe.formula_version;
  f       recipe.formula;
  v_sig   jsonb;
begin
  perform iam.assert_not_administrator();
  select * into v from recipe.formula_version where id = p_version;
  if v.id is null then
    perform recipe.formula_fail('EBMR-FRM-003', format('There is no formula version %s', p_version));
  end if;
  select * into f from recipe.formula where id = v.formula_id for update;
  perform iam.require_permission('FORMULA.APPROVE', jsonb_build_object('product', f.product_code));
  v_sig := esig.assert_signature(p_signature, 'FORMULA_APPROVED', 'formula_version', p_version::text);
  if (v_sig ->> 'signer_person') is distinct from (v_actor ->> 'person_id') then
    perform recipe.formula_fail('EBMR-FRM-012', 'A formula version is approved by the person who signed FORMULA_APPROVED (DI-35)');
  end if;
  if v.authored_by_person = (v_actor ->> 'person_id')::uuid then
    perform recipe.formula_fail('EBMR-FRM-013', 'A formula version is approved by another person than its author (DI-35, two-person rule)');
  end if;
  if exists (select 1 from recipe.formula_approval a where a.version_id = v.id) then
    perform recipe.formula_fail('EBMR-FRM-014', format('Version %s of this formula is approved already', v.version_number));
  end if;
  if exists (select 1 from recipe.formula_version w where w.formula_id = v.formula_id and w.version_number > v.version_number) then
    perform recipe.formula_fail('EBMR-FRM-014', format('Version %s is not the latest version of this formula', v.version_number));
  end if;
  insert into recipe.formula_approval (version_id, signature_id, approved_by_person, approved_by_account, correlation_id)
  values (v.id, p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
end
$$;

-- What a FORMULA_APPROVED signature covers: the formula's identity and the version's composition (never its state).
create function recipe.formula_version_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v recipe.formula_version;
  f recipe.formula;
begin
  if p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return jsonb_build_object('exists', false);
  end if;
  select * into v from recipe.formula_version where id = p_id::uuid;
  if v.id is null then
    return jsonb_build_object('exists', false);
  end if;
  select * into f from recipe.formula where id = v.formula_id;
  return jsonb_build_object(
    'exists', true, 'content_version', 1, 'state', recipe.formula_version_state(v.id), 'entered_by', jsonb_build_array(v.authored_by_person),
    'scope', jsonb_build_object('product', f.product_code),
    'content', jsonb_build_object('title', format('Formula %s %s, %s units, version %s', f.product_code, f.strength, f.batch_size_units, v.version_number),
                                  'productCode', f.product_code, 'strength', f.strength, 'batchSizeUnits', f.batch_size_units::text,
                                  'versionNumber', v.version_number, 'changeReason', v.change_reason, 'lines', recipe.formula_lines_json(v.id)));
end
$$;

select esig.register_content_provider('formula_version', 'recipe.formula_version_content(text)',
  'A version of a formula of the company formulation library: product, strength, batch size and per-unit composition with the computed batch quantities (decision 0006)');

-- ---------------------------------------------------------------------------------------------
-- Readers (DI-13: the composition only with FORMULA.READ)
-- ---------------------------------------------------------------------------------------------

-- The formulas with their versions' states; the composition of each version only for a reader holding FORMULA.READ.
create function recipe.formula_read(p_formula uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, site, pg_temp as $$
declare
  f      recipe.formula;
  v_out  jsonb := '[]'::jsonb;
  v_read boolean;
begin
  perform iam.assert_validated_actor();
  for f in select * from recipe.formula where p_formula is null or id = p_formula order by product_code, strength, batch_size_units loop
    v_read := recipe.formula_reader(f.product_code);
    v_out := v_out || jsonb_build_object(
      'formulaId', f.id, 'productCode', f.product_code, 'strength', f.strength, 'batchSizeUnits', f.batch_size_units::text,
      'compositionReadable', v_read,
      'versions', coalesce((select jsonb_agg(jsonb_build_object(
          'versionId', v.id, 'versionNumber', v.version_number, 'state', recipe.formula_version_state(v.id), 'changeReason', v.change_reason,
          'authoredBy', v.authored_by_person, 'authoredByAccount', v.authored_by_account,
          'authoredUs', (extract(epoch from v.authored_at) * 1000000)::numeric(20, 0)::text,
          'approvedBy', a.approved_by_person, 'approvedByAccount', a.approved_by_account,
          'approvedUs', (extract(epoch from a.approved_at) * 1000000)::numeric(20, 0)::text,
          'lines', case when v_read then recipe.formula_lines_json(v.id) end) order by v.version_number)
        from recipe.formula_version v left join recipe.formula_approval a on a.version_id = v.id where v.formula_id = f.id), '[]'::jsonb));
  end loop;
  if p_formula is not null and jsonb_array_length(v_out) = 0 then
    perform recipe.formula_fail('EBMR-FRM-003', format('There is no formula %s', p_formula));
  end if;
  return v_out;
end
$$;

-- "Choose a product": the approved version of the formula for a product, strength and batch size, with its lines (and
-- their computed batch quantities). FORMULA.READ in the product's scope (DI-13).
create function recipe.formula_choice(p_product text, p_strength text, p_units numeric) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  f recipe.formula;
  v recipe.formula_version;
begin
  perform iam.require_permission('FORMULA.READ', jsonb_build_object('product', p_product));
  select * into f from recipe.formula where product_code = p_product and strength = p_strength and batch_size_units = p_units;
  if f.id is null then
    perform recipe.formula_fail('EBMR-FRM-015', format('No formula of %s %s for %s units is recorded in the library', p_product, p_strength, p_units));
  end if;
  select w.* into v from recipe.formula_version w where w.formula_id = f.id and recipe.formula_version_state(w.id) = 'APPROVED';
  if v.id is null then
    perform recipe.formula_fail('EBMR-FRM-016', format('The formula of %s %s for %s units has no approved version (D-S6-3)', p_product, p_strength, p_units));
  end if;
  return jsonb_build_object('formulaId', f.id, 'versionId', v.id, 'versionNumber', v.version_number, 'productCode', f.product_code, 'strength', f.strength,
                            'batchSizeUnits', f.batch_size_units::text, 'batchMassKg', trim_scale(recipe.formula_batch_mass(v.id))::text,
                            'lines', recipe.formula_lines_json(v.id));
end
$$;

-- A formula version by id for an MBR author's "Choose a product" (FORMULA.READ; APPROVED only).
create function recipe.formula_version_for_mbr(p_version uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v recipe.formula_version;
  f recipe.formula;
begin
  select * into v from recipe.formula_version where id = p_version;
  if v.id is null then
    perform recipe.formula_fail('EBMR-FRM-003', format('There is no formula version %s', p_version));
  end if;
  select * into f from recipe.formula where id = v.formula_id;
  perform iam.require_permission('FORMULA.READ', jsonb_build_object('product', f.product_code));
  if recipe.formula_version_state(v.id) <> 'APPROVED' then
    perform recipe.formula_fail('EBMR-FRM-016', format('Formula version %s is %s; an MBR takes its composition only from an approved version (D-S6-3)',
                                                      v.version_number, recipe.formula_version_state(v.id)));
  end if;
  return recipe.formula_choice(f.product_code, f.strength, f.batch_size_units);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The MBR pin and its check
-- ---------------------------------------------------------------------------------------------

-- Why MBR version p_mbr does not carry formula version p_formula's composition (NULL when it does): its product and
-- strength, its reference batch size (the formula's theoretical batch mass), every BOM line of a formula material with
-- exactly the computed quantity, every formula line in the BOM, and no other active, excipient or processing aid.
create function recipe.formula_mbr_problem(p_mbr uuid, p_formula uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  c        jsonb := (recipe.current_content(p_mbr)).content;
  v        recipe.formula_version;
  f        recipe.formula;
  v_ref    jsonb;
  v_mass   numeric;
  v_lines  jsonb := '{}'::jsonb;
  b        jsonb;
  v_code   text;
  v_kg     numeric;
  l        recipe.formula_line;
begin
  select * into v from recipe.formula_version where id = p_formula;
  select * into f from recipe.formula where id = v.formula_id;
  if c is null or v.id is null then
    return 'the MBR version or the formula version does not exist';
  end if;
  if c -> 'header' -> 'product' ->> 'code' is distinct from f.product_code or c -> 'header' -> 'product' ->> 'strength' is distinct from f.strength then
    return format('the MBR is for %s %s, the formula for %s %s', c -> 'header' -> 'product' ->> 'code', c -> 'header' -> 'product' ->> 'strength', f.product_code, f.strength);
  end if;
  v_ref := c -> 'header' -> 'batchSizes' -> 0 -> 'quantity';
  v_mass := recipe.formula_batch_mass(v.id);
  v_kg := case v_ref ->> 'unit' when 'kg' then (v_ref ->> 'value')::numeric when 'g' then (v_ref ->> 'value')::numeric / 1000 end;
  if v_kg is distinct from v_mass then
    return format('the reference batch size %s %s is not the formula''s theoretical batch mass %s kg for %s units', v_ref ->> 'value', v_ref ->> 'unit',
                  trim_scale(v_mass), f.batch_size_units);
  end if;
  for b in select * from jsonb_array_elements(coalesce(c -> 'bom', '[]'::jsonb)) loop
    select r ->> 'code' into v_code from jsonb_array_elements(coalesce(c -> 'references', '[]'::jsonb)) r where r ->> 'id' = b ->> 'material' limit 1;
    select * into l from recipe.formula_line x where x.version_id = v.id and x.material_code = v_code;
    if l.version_id is null then
      if b ->> 'role' in ('ACTIVE', 'EXCIPIENT', 'PROCESSING_AID') then
        return format('BOM line %s (%s) is not a line of the formula', b ->> 'id', coalesce(v_code, b ->> 'material'));
      end if;
      continue;
    end if;
    v_kg := case b -> 'quantity' ->> 'unit' when 'kg' then (b -> 'quantity' ->> 'value')::numeric when 'g' then (b -> 'quantity' ->> 'value')::numeric / 1000 end;
    if v_kg is distinct from l.batch_quantity_kg then
      return format('BOM line %s (%s) is %s %s; the formula computes %s kg (INV-25)', b ->> 'id', v_code, b -> 'quantity' ->> 'value', b -> 'quantity' ->> 'unit',
                    trim_scale(l.batch_quantity_kg));
    end if;
    v_lines := v_lines || jsonb_build_object(l.line_id, true);
  end loop;
  for l in select * from recipe.formula_line x where x.version_id = v.id order by x.ordinal loop
    if not v_lines ? l.line_id then
      return format('formula line %s (%s) is not in the BOM', l.line_id, l.material_code);
    end if;
  end loop;
  return null;
end
$$;

-- An MBR author pins the approved formula version its DRAFT version's composition was taken from (once).
create function recipe.formula_pin_mbr(p_mbr uuid, p_formula uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v_state text;
  v_p     text;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MBR.AUTHOR', recipe.version_scope(p_mbr));
  perform recipe.formula_version_for_mbr(p_formula);
  select s.state into v_state from platform.aggregate_state s where s.aggregate_type = 'mbr_version' and s.aggregate_id = p_mbr for update;
  if v_state is distinct from 'DRAFT' then
    perform recipe.formula_fail('EBMR-FRM-017', format('An MBR version takes a formula while it is a DRAFT; this one is %s (PR-06)', coalesce(v_state, 'unknown')));
  end if;
  if exists (select 1 from recipe.mbr_formula_pin where mbr_version_id = p_mbr) then
    perform recipe.formula_fail('EBMR-FRM-018', 'This MBR version has its formula already; another formula version is a new MBR version (PR-06)');
  end if;
  v_p := recipe.formula_mbr_problem(p_mbr, p_formula);
  if v_p is not null then
    perform recipe.formula_fail('EBMR-FRM-019', format('The MBR does not carry the formula''s composition: %s (INV-25)', v_p));
  end if;
  insert into recipe.mbr_formula_pin (mbr_version_id, formula_version_id, pinned_by_person, pinned_by_account, correlation_id)
  values (p_mbr, p_formula, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
end
$$;

-- The formula version an MBR version pins, if any (no composition: anyone who reads the MBR may know it is pinned).
create function recipe.mbr_formula_of(p_mbr uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select formula_version_id from recipe.mbr_formula_pin where mbr_version_id = p_mbr
$$;

-- DI-13: the composition of an MBR version (its BOM) for a reader holding FORMULA.READ in its product's scope.
create function recipe.mbr_composition(p_mbr uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
begin
  perform iam.require_permission('FORMULA.READ', recipe.version_scope(p_mbr));
  return jsonb_build_object('bom', (recipe.current_content(p_mbr)).content -> 'bom', 'formulaVersionId', recipe.mbr_formula_of(p_mbr));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The MBR approval refuses a pinned formula that is not APPROVED (replaces 0130, the latest definition, adding that check)
-- ---------------------------------------------------------------------------------------------

create or replace function recipe.guard_registered_ranges_kept(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v         recipe.mbr_version;
  v_new     jsonb := (recipe.current_content(p_id)).content;
  v_markets text[];
  v_base    uuid;
  x         record;
  m         text;
  v_out     text[] := '{}';
  v_formula uuid := recipe.mbr_formula_of(p_id);
  v_fstate  text;
  v_fp      text;
begin
  -- D-S6-3, INV-25: an MBR taken from the formulation library is approved only while its formula version is APPROVED and
  -- its content still carries that version's composition.
  if v_formula is not null then
    v_fstate := recipe.formula_version_state(v_formula);
    if v_fstate is distinct from 'APPROVED' then
      return format('the formula version this MBR pins is %s, not APPROVED: a formula is approved before the MBR that uses it, and a new formula version needs a new MBR version (D-S6-3, PR-06) [EBMR-FRM-020]', coalesce(v_fstate, 'unknown'));
    end if;
    v_fp := recipe.formula_mbr_problem(p_id, v_formula);
    if v_fp is not null then
      return format('the MBR no longer carries the composition of the formula version it pins: %s (INV-25) [EBMR-FRM-020]', v_fp);
    end if;
  end if;
  select * into v from recipe.mbr_version where id = p_id;
  v_markets := array(select jsonb_array_elements_text(v_new -> 'header' -> 'marketSet'));
  for v_base in select * from recipe.baseline_versions(p_id) loop
    for x in select * from recipe.registered_changes((recipe.current_content(v_base)).content, v_new) loop
      foreach m in array v_markets loop
        if not exists (select 1 from recipe.change_record_regulatory g where g.change_record_id = v.change_record_id and g.market = m
                         and (not x.widened or btrim(coalesce(g.regulatory_reference, '')) <> '')) then
          v_out := v_out || format('%s: %s without %s for market %s', x.subject, x.change,
                                   case when x.widened then 'a variation, supplement or approval reference' else 'a regulatory assessment' end, m);
        end if;
      end loop;
    end loop;
  end loop;
  if cardinality(v_out) > 0 then
    return format('registered elements changed without the regulatory action each market needs: %s (PR-04)',
                  array_to_string(array(select distinct e from unnest(v_out) e order by 1), '; '));
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: the application role executes the writers and readers; it reads no formula table.
-- ---------------------------------------------------------------------------------------------

revoke all on function recipe.formula_fail(text, text), recipe.formula_version_state(uuid), recipe.formula_reader(text), recipe.formula_lines_json(uuid),
                       recipe.formula_batch_mass(uuid), recipe.formula_create(jsonb), recipe.formula_add_version(uuid, jsonb),
                       recipe.formula_approve(uuid, uuid), recipe.formula_version_content(text), recipe.formula_read(uuid),
                       recipe.formula_choice(text, text, numeric), recipe.formula_version_for_mbr(uuid), recipe.formula_mbr_problem(uuid, uuid),
                       recipe.formula_pin_mbr(uuid, uuid), recipe.mbr_formula_of(uuid), recipe.mbr_composition(uuid) from public;
grant execute on function recipe.formula_version_state(uuid), recipe.formula_create(jsonb), recipe.formula_add_version(uuid, jsonb),
                          recipe.formula_approve(uuid, uuid), recipe.formula_read(uuid), recipe.formula_choice(text, text, numeric),
                          recipe.formula_version_for_mbr(uuid), recipe.formula_pin_mbr(uuid, uuid), recipe.mbr_formula_of(uuid),
                          recipe.mbr_composition(uuid) to ebmr_app;

reset role;
