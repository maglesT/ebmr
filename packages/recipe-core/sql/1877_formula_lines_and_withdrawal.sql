-- Recipe core: formula lines for multi-part products, and a draft that can be withdrawn (demo finding D-2 and the D-0
-- restriction sweep, lead audit of 7 November 2026; docs/build-plan/demo-gaps/plan.md, d0/README.md).
--
-- Handbook: modules/recipe-core.md
--
--   * formulary.formula_line: the unique key (version, material) is dropped. A formula lists every component with its
--     quantity (21 CFR 211.186(b)); nothing asks for one line per material, and a bilayer tablet, two kinds of pellets,
--     an injectable's powder and solvent kit or an API's solvent in two stages each need the same material on two
--     lines. Line ids stay unique, now whatever their letter case (EBMR-FRM-023; the designer upper-cases them into
--     BOM ids, so mcc and MCC collided in the master).
--   * recipe.formula_add_version (CREATE OR REPLACE from 1875): EBMR-FRM-011 no longer counts compensating excipients
--     and no longer asks an adjusted active for one (TB-01 also dispenses an adjusted active without compensation);
--     a compensating excipient still needs an adjusted active. A capsule's coat is given per batch (EBMR-FRM-009), as
--     the designer asks for it. EBMR-FRM-010 no longer says "a material once".
--   * recipe.formula_mbr_problem (CREATE OR REPLACE from 1740): a BOM line is matched to the formula line whose BOM id
--     it carries, or to the one line of its material; each formula line is matched once.
--   * recipe.formula_create (CREATE OR REPLACE from 0640): a second formula for the same product, strength and batch
--     size is refused with EBMR-FRM-021, not a bare unique violation.
--   * formulary.formula_withdrawal and recipe.formula_withdraw: the author withdraws a DRAFT version with a reason
--     (DI-22). Nothing is deleted: the version, its lines and the withdrawal stay, insert-only and in the audit trail
--     (record retention, 211.180, Part 11 11.10(c)); the version reads WITHDRAWN, cannot be approved (EBMR-FRM-022),
--     and a new version may follow it (EBMR-FRM-006 asks only that the latest version is not a DRAFT).
--
-- Messages: EBMR-FRM-009, -010, -011 (reworded); EBMR-FRM-021, -022, -023 (new).

set local role ebmr_owner;

do $$
declare
  k text;
begin
  select c.conname into k from pg_constraint c
   where c.conrelid = 'formulary.formula_line'::regclass and c.contype = 'u'
     and (select array_agg(a.attname::text order by a.attname) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) = array['material_code', 'version_id'];
  if k is null then
    raise exception '1877: the unique key (version_id, material_code) of formulary.formula_line is not there';
  end if;
  execute format('alter table formulary.formula_line drop constraint %I', k);
end
$$;

create unique index formula_line_id_any_case on formulary.formula_line (version_id, upper(line_id));

create table formulary.formula_withdrawal (
  version_id           uuid primary key references formulary.formula_version (id),
  reason               text not null check (btrim(reason) <> '' and length(reason) <= 2000),
  withdrawn_by_person  uuid not null,
  withdrawn_by_account uuid not null,
  withdrawn_at         timestamptz not null default clock_timestamp(),
  correlation_id       uuid not null
);
revoke all on formulary.formula_withdrawal from public;
create trigger aa_insert_only before update or delete on formulary.formula_withdrawal for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on formulary.formula_withdrawal for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('formulary.formula_withdrawal', array['withdrawn_at']);
select kernel.register_audited_table('formulary.formula_withdrawal', 'formula_version', 'version_id', true);

-- DRAFT, APPROVED, SUPERSEDED or WITHDRAWN (NULL for an unknown version).
create or replace function recipe.formula_version_state(p_version uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case
           when exists (select 1 from formulary.formula_withdrawal w where w.version_id = v.id) then 'WITHDRAWN'
           when not exists (select 1 from formulary.formula_approval a where a.version_id = v.id) then 'DRAFT'
           when exists (select 1 from formulary.formula_version w join formulary.formula_approval a on a.version_id = w.id
                         where w.formula_id = v.formula_id and w.version_number > v.version_number) then 'SUPERSEDED'
           else 'APPROVED' end
    from formulary.formula_version v where v.id = p_version
$$;

-- The author (FORMULA.MANAGE) withdraws a DRAFT version with a reason; it stays on record, WITHDRAWN.
create function recipe.formula_withdraw(p_version uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v       formulary.formula_version;
  f       formulary.formula;
begin
  perform iam.assert_not_administrator();
  select * into v from formulary.formula_version where id = p_version;
  if v.id is null then
    perform recipe.formula_fail('EBMR-FRM-003', format('There is no formula version %s', p_version));
  end if;
  select * into f from formulary.formula where id = v.formula_id for update;
  perform iam.require_permission('FORMULA.MANAGE', jsonb_build_object('product', f.product_code));
  if btrim(coalesce(p_reason, '')) = '' then
    perform recipe.formula_fail('EBMR-FRM-004', 'Withdrawing a formula version carries its reason (DI-22)');
  end if;
  if recipe.formula_version_state(v.id) <> 'DRAFT' then
    perform recipe.formula_fail('EBMR-FRM-022', format('Version %s of this formula is %s; only a draft is withdrawn', v.version_number, lower(recipe.formula_version_state(v.id))));
  end if;
  insert into formulary.formula_withdrawal (version_id, reason, withdrawn_by_person, withdrawn_by_account, correlation_id)
  values (v.id, btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
end
$$;

-- As 0640, with the duplicate formula named (header).
create or replace function recipe.formula_create(p jsonb) returns uuid
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
  -- 1877: a formula is one per product, strength and batch size; say so instead of a bare unique violation.
  if exists (select 1 from formulary.formula x where x.product_code = p ->> 'productCode' and x.strength = p ->> 'strength'
                and x.batch_size_units = (p ->> 'batchSizeUnits')::numeric) then
    perform recipe.formula_fail('EBMR-FRM-021', format('Product %s %s already has a formula for %s units; write a new version of that formula',
                                                      p ->> 'productCode', p ->> 'strength', p ->> 'batchSizeUnits'));
  end if;
  insert into formulary.formula (id, product_code, strength, batch_size_units, created_by_person, created_by_account, correlation_id)
  values (v_id, p ->> 'productCode', p ->> 'strength', (p ->> 'batchSizeUnits')::numeric, (v_actor ->> 'person_id')::uuid,
          (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return v_id;
end
$$;

-- As 1875, with the lines of multi-part products (header).
create or replace function recipe.formula_add_version(p_formula uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, site, pg_temp as $$
declare
  v_actor  jsonb := iam.assert_validated_actor();
  f        formulary.formula;
  v_id     uuid := gen_random_uuid();
  v_n      integer;
  l        jsonb;
  m        site.erp_material;
  v_ord    integer := 0;
  v_qty    numeric;
  v_over   numeric;
  v_overq  numeric;
  v_why    text;
  v_salt   numeric;
  v_batch  numeric;
  v_dec    text := '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$';
begin
  perform iam.assert_not_administrator();
  select * into f from formulary.formula where id = p_formula for update;
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
  select coalesce(max(version_number), 0) into v_n from formulary.formula_version where formula_id = f.id;
  if v_n > 0 and recipe.formula_version_state((select id from formulary.formula_version where formula_id = f.id and version_number = v_n)) = 'DRAFT' then
    perform recipe.formula_fail('EBMR-FRM-006', format('Version %s of this formula is still a draft; a new version follows an approved one', v_n));
  end if;
  insert into formulary.formula_version (id, formula_id, version_number, change_reason, authored_by_person, authored_by_account, correlation_id)
  values (v_id, f.id, v_n + 1, btrim(p ->> 'changeReason'), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  -- 1877: line ids are told apart whatever their letter case (the designer upper-cases them into BOM ids).
  if exists (select 1 from jsonb_array_elements(p -> 'lines') x where jsonb_typeof(x) = 'object'
              group by upper(x ->> 'lineId') having count(*) > 1) then
    perform recipe.formula_fail('EBMR-FRM-023', 'Two lines of the formula have the same line id, letter case aside; give each line its own id');
  end if;
  for l in select * from jsonb_array_elements(p -> 'lines') loop
    v_ord := v_ord + 1;
    if jsonb_typeof(l) is distinct from 'object' or coalesce(l ->> 'quantity', '') !~ v_dec
       or (l ? 'overagePercent' and jsonb_typeof(l -> 'overagePercent') <> 'null' and coalesce(l ->> 'overagePercent', '') !~ v_dec)
       or (l ? 'overageQuantity' and jsonb_typeof(l -> 'overageQuantity') <> 'null' and coalesce(l ->> 'overageQuantity', '') !~ v_dec)
       or (l ? 'overageReason' and jsonb_typeof(l -> 'overageReason') not in ('null', 'string'))
       or (l ? 'saltFactor' and jsonb_typeof(l -> 'saltFactor') <> 'null' and coalesce(l ->> 'saltFactor', '') !~ v_dec)
       or jsonb_typeof(l -> 'potencyAdjusted') is distinct from 'boolean' or jsonb_typeof(l -> 'compensating') is distinct from 'boolean'
       or coalesce(l ->> 'basis', '') not in ('PER_UNIT', 'PER_BATCH') then
      perform recipe.formula_fail('EBMR-FRM-007', format('Line %s: quantities are decimal text, the basis PER_UNIT or PER_BATCH, the overage reason text, and the flags yes or no (INV-25)', v_ord));
    end if;
    m := site.erp_material_current(l ->> 'materialCode');
    if m.id is null then
      perform recipe.formula_fail('EBMR-FRM-008', format('Line %s: material %s is not in the ERP material master', v_ord, coalesce(l ->> 'materialCode', 'NULL')));
    end if;
    v_qty := (l ->> 'quantity')::numeric;
    v_over := nullif(l ->> 'overagePercent', '')::numeric;
    v_overq := nullif(l ->> 'overageQuantity', '')::numeric;
    v_why := nullif(btrim(coalesce(l ->> 'overageReason', '')), '');
    v_salt := nullif(l ->> 'saltFactor', '')::numeric;
    -- 1875: a capsule's per-batch excipient (a soft gel's gel mass components) is given per batch too (header).
    if l ->> 'basis' = 'PER_BATCH' and l ->> 'role' <> 'PROCESSING_AID'
       and not (l ->> 'role' in ('EXCIPIENT', 'COATING') and p ->> 'unitForm' is not distinct from 'CAPSULE') then
      perform recipe.formula_fail('EBMR-FRM-009', format('Line %s: only a processing aid (or, for a capsule, an excipient of its shell or a coat on the capsules) is given per batch; a component of the unit is given per unit (INV-25)', v_ord));
    end if;
    if v_over is not null and v_overq is not null then
      perform recipe.formula_fail('EBMR-FRM-060', format('Line %s: an overage is stated in percent or as a quantity, not both (D-7q-1)', v_ord));
    end if;
    if (coalesce(v_over, 0) = 0 and v_overq is null) <> (v_why is null) then
      perform recipe.formula_fail('EBMR-FRM-061', format(case when v_why is null then 'Line %s: an overage carries its reason (why the excess over the label claim is formulated; D-7q-1, PR-04)'
                                                               else 'Line %s: an overage reason is written only with an overage above zero (D-7q-1)' end, v_ord));
    end if;
    -- INV-25: the batch quantity is computed, never typed; the label claim (the quantity) is unaffected by the overage.
    v_batch := case l ->> 'basis'
                 when 'PER_UNIT' then (v_qty + coalesce(v_overq, 0)) * f.batch_size_units * (100 + coalesce(v_over, 0)) / 100 * coalesce(v_salt, 1) / 1000000
                 else (v_qty + coalesce(v_overq, 0)) * (100 + coalesce(v_over, 0)) / 100 end;
    begin
      insert into formulary.formula_line (version_id, line_id, ordinal, material_code, material_name, role, basis, quantity, overage_percent, salt_factor,
                                       potency_adjusted, compensating, batch_quantity_kg, overage_quantity, overage_reason)
      values (v_id, l ->> 'lineId', v_ord, m.material_code, m.material_name, l ->> 'role', l ->> 'basis', v_qty, v_over, v_salt,
              (l ->> 'potencyAdjusted')::boolean, (l ->> 'compensating')::boolean, v_batch, v_overq, v_why);
    exception when check_violation or unique_violation or not_null_violation then
      perform recipe.formula_fail('EBMR-FRM-010', format('Line %s is not a valid formula line: a line id once, an overage below 100 %% or a positive overage quantity with a reason of at most 500 characters, the salt factor only on a per-unit active, potency adjustment only on an active, compensation only on an excipient (D-S6-3, D-7q-1)', v_ord));
    end;
  end loop;
  if exists (select 1 from formulary.formula_line where version_id = v_id and compensating)
     and not exists (select 1 from formulary.formula_line where version_id = v_id and potency_adjusted) then
    perform recipe.formula_fail('EBMR-FRM-011', 'A compensating excipient makes up for a potency-adjusted active; this formula adjusts none (TB-01)');
  end if;
  return v_id;
end
$$;

-- As 0640, refusing a withdrawn version (header).
create or replace function recipe.formula_approve(p_version uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, esig, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v       formulary.formula_version;
  f       formulary.formula;
  v_sig   jsonb;
begin
  perform iam.assert_not_administrator();
  select * into v from formulary.formula_version where id = p_version;
  if v.id is null then
    perform recipe.formula_fail('EBMR-FRM-003', format('There is no formula version %s', p_version));
  end if;
  select * into f from formulary.formula where id = v.formula_id for update;
  perform iam.require_permission('FORMULA.APPROVE', jsonb_build_object('product', f.product_code));
  v_sig := esig.assert_signature(p_signature, 'FORMULA_APPROVED', 'formula_version', p_version::text);
  if (v_sig ->> 'signer_person') is distinct from (v_actor ->> 'person_id') then
    perform recipe.formula_fail('EBMR-FRM-012', 'A formula version is approved by the person who signed FORMULA_APPROVED (DI-35)');
  end if;
  if v.authored_by_person = (v_actor ->> 'person_id')::uuid then
    perform recipe.formula_fail('EBMR-FRM-013', 'A formula version is approved by another person than its author (DI-35, two-person rule)');
  end if;
  if exists (select 1 from formulary.formula_withdrawal w where w.version_id = v.id) then
    perform recipe.formula_fail('EBMR-FRM-022', format('Version %s of this formula was withdrawn; write a new version', v.version_number));
  end if;
  if exists (select 1 from formulary.formula_approval a where a.version_id = v.id) then
    perform recipe.formula_fail('EBMR-FRM-014', format('Version %s of this formula is approved already', v.version_number));
  end if;
  if exists (select 1 from formulary.formula_version w where w.formula_id = v.formula_id and w.version_number > v.version_number) then
    perform recipe.formula_fail('EBMR-FRM-014', format('Version %s is not the latest version of this formula', v.version_number));
  end if;
  insert into formulary.formula_approval (version_id, signature_id, approved_by_person, approved_by_account, correlation_id)
  values (v.id, p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
end
$$;

-- As 1740, matching BOM lines by line id (header).
create or replace function recipe.formula_mbr_problem(p_mbr uuid, p_formula uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  c        jsonb := (recipe.current_content(p_mbr)).content;
  v        formulary.formula_version;
  f        formulary.formula;
  v_ref    jsonb;
  v_mass   numeric;
  v_lines  jsonb := '{}'::jsonb;
  b        jsonb;
  v_code   text;
  v_kg     numeric;
  v_want   numeric;
  v_over   jsonb;
  l        formulary.formula_line;
begin
  select * into v from formulary.formula_version where id = p_formula;
  select * into f from formulary.formula where id = v.formula_id;
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
    -- 1877: a material may be on several lines (a bilayer's two layers, two kinds of pellets, a solvent in two
    -- stages): the BOM line is the formula line whose BOM id it carries (BOM-<line id>), or else the one line of
    -- its material; each formula line is taken once.
    l := null;
    select * into l from formulary.formula_line x where x.version_id = v.id and x.material_code = v_code and 'BOM-' || upper(x.line_id) = b ->> 'id';
    if l.version_id is null and (select count(*) from formulary.formula_line x where x.version_id = v.id and x.material_code = v_code) = 1 then
      select * into l from formulary.formula_line x where x.version_id = v.id and x.material_code = v_code;
    end if;
    if l.version_id is not null and v_lines ? l.line_id then
      return format('BOM lines %s and another both take formula line %s (%s); each formula line is one BOM line', b ->> 'id', l.line_id, l.material_code);
    end if;
    if l.version_id is null then
      -- Review P7Q-6: an overage is stated only on a BOM line taken from a formula line.
      if b ? 'overage' then
        return format('BOM line %s (%s) states an overage but is not a line of the formula (D-7q-2)', b ->> 'id', coalesce(v_code, b ->> 'material'));
      end if;
      if b ->> 'role' in ('ACTIVE', 'EXCIPIENT', 'PROCESSING_AID') then
        return format('BOM line %s (%s) is not a line of the formula', b ->> 'id', coalesce(v_code, b ->> 'material'));
      end if;
      continue;
    end if;
    v_kg := case b -> 'quantity' ->> 'unit' when 'kg' then (b -> 'quantity' ->> 'value')::numeric when 'g' then (b -> 'quantity' ->> 'value')::numeric / 1000 end;
    -- The salt on the base (0690): the BOM line holds the base when a base-stated TB-01 step dispenses it; with the
    -- overage quantity as well (this migration).
    v_want := case
                when l.salt_factor is not null and l.role = 'ACTIVE' and l.basis = 'PER_UNIT' and recipe.formula_bom_line_on_base(c, b ->> 'id')
                  then (l.quantity + coalesce(l.overage_quantity, 0)) * f.batch_size_units * (100 + coalesce(l.overage_percent, 0)) / 100 / 1000000
                else l.batch_quantity_kg
              end;
    if v_kg is distinct from v_want then
      return format('BOM line %s (%s) is %s %s; the formula computes %s kg (INV-25)', b ->> 'id', v_code, b -> 'quantity' ->> 'value', b -> 'quantity' ->> 'unit',
                    trim_scale(v_want));
    end if;
    v_over := recipe.formula_line_overage_json(l);
    if (b ? 'overage' or v_over is not null) and not recipe.bom_overage_matches(b -> 'overage', v_over) then
      return format('BOM line %s (%s) states the overage %s; the formula line states %s (D-7q-2)', b ->> 'id', v_code,
                    coalesce((b -> 'overage')::text, 'none'), coalesce(v_over::text, 'none'));
    end if;
    v_lines := v_lines || jsonb_build_object(l.line_id, true);
  end loop;
  for l in select * from formulary.formula_line x where x.version_id = v.id order by x.ordinal loop
    if not v_lines ? l.line_id then
      return format('formula line %s (%s) is not in the BOM', l.line_id, l.material_code);
    end if;
  end loop;
  return null;
end
$$;

revoke all on function recipe.formula_withdraw(uuid, text) from public;
grant execute on function recipe.formula_withdraw(uuid, text) to ebmr_app;

reset role;
