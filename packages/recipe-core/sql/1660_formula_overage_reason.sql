-- Recipe core: overages in the formula (Phase 7 slice 7q, requirement R8 capability C1; decisions D-7q-1, D-7q-2;
-- decision 0006 part 1; controls INV-25, DI-35, PR-04).
--
-- Handbook: modules/recipe-core.md
--
-- A company formulates some materials with a deliberate excess over the label claim (an overage): a vitamin that loses
-- potency on storage, an enzyme, a volatile flavour. Before this migration a formula line could carry an overage in
-- percent on a per-unit active only, without a reason. Now:
--   * formulary.formula_line gains overage_quantity (the excess as a quantity in the line's own unit: mg per unit for a
--     PER_UNIT line, kg per batch for a PER_BATCH processing aid) and overage_reason. A line states its overage in
--     percent or as a quantity, never both, on any role, and an overage above zero always carries its reason (checked
--     for new rows: the rows written before this migration keep their overage without one, NOT VALID).
--   * The label claim stays the line's quantity; the batch quantity the database computes includes the overage, never
--     typed (INV-25): PER_UNIT (quantity + overage quantity) x units x (100 + overage %) / 100 x salt factor / 10^6 kg;
--     PER_BATCH (quantity + overage quantity) x (100 + overage %) / 100 kg. So the theoretical batch mass, an MBR's BOM
--     taken from the formula and every dispensing target taken from the BOM (G-07, TB-01) include it.
--   * recipe.formula_add_version (CREATE OR REPLACE from 0640): reads overageQuantity and overageReason.
--   * recipe.formula_lines_json (CREATE OR REPLACE from 0640): a line with an overage quantity or reason carries
--     overageQuantity and overageReason as well; a line without either is written exactly as before, so the content a
--     FORMULA_APPROVED signature covers is unchanged for every version approved before (DI-35: the approver signs the
--     overage and its reason with the composition).
--   * recipe.formula_mbr_problem (CREATE OR REPLACE from 0690): the base quantity of a salt on the base includes the
--     overage quantity; a BOM line that states an overage (MBR content bom[].overage, shown on the master's bill of
--     materials) states exactly the formula line's, and a formula line with a reasoned overage is stated on its BOM
--     line, so the master shows what the approver signed.
--
-- Messages: EBMR-FRM-060 to 061 (and the existing EBMR-FRM-007 and 010 with the new members).

set local role ebmr_owner;

alter table formulary.formula_line
  add column overage_quantity numeric check (overage_quantity > 0),
  add column overage_reason   text check (btrim(overage_reason) <> '' and length(overage_reason) <= 500);

-- 0640 tied the overage and the salt factor to a per-unit active; the overage now stands on any line (D-7q-1).
alter table formulary.formula_line drop constraint formula_line_check;
alter table formulary.formula_line add constraint formula_line_salt_on_active check (salt_factor is null or (role = 'ACTIVE' and basis = 'PER_UNIT'));
alter table formulary.formula_line add constraint formula_line_one_overage check (overage_percent is null or overage_quantity is null);
alter table formulary.formula_line add constraint formula_line_overage_reason
  check ((coalesce(overage_percent, 0) = 0 and overage_quantity is null) = (overage_reason is null)) not valid;

-- As 0640, with the overage quantity and reason when set (header).
create or replace function recipe.formula_lines_json(p_version uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'lineId', l.line_id, 'materialCode', l.material_code, 'materialName', l.material_name, 'role', l.role, 'basis', l.basis,
           'quantity', trim_scale(l.quantity)::text, 'quantityUnit', case l.basis when 'PER_UNIT' then 'mg' else 'kg' end,
           'overagePercent', trim_scale(l.overage_percent)::text, 'saltFactor', trim_scale(l.salt_factor)::text,
           'potencyAdjusted', l.potency_adjusted, 'compensating', l.compensating,
           'batchQuantity', trim_scale(l.batch_quantity_kg)::text, 'batchUnit', 'kg')
         || case when l.overage_quantity is null and l.overage_reason is null then '{}'::jsonb
                 else jsonb_build_object('overageQuantity', trim_scale(l.overage_quantity)::text, 'overageReason', l.overage_reason) end
         order by l.ordinal), '[]'::jsonb)
    from formulary.formula_line l where l.version_id = p_version
$$;

-- p: {changeReason, lines: [{lineId, materialCode, role, basis, quantity, overagePercent?, overageQuantity?, overageReason?,
-- saltFactor?, potencyAdjusted, compensating}]}. As 0640, with the overage on any line, in percent or as a quantity in the
-- line's unit, and its reason (header).
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
    if l ->> 'basis' = 'PER_BATCH' and l ->> 'role' <> 'PROCESSING_AID' then
      perform recipe.formula_fail('EBMR-FRM-009', format('Line %s: only a processing aid is given per batch; a component of the unit is given per unit (INV-25)', v_ord));
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
      perform recipe.formula_fail('EBMR-FRM-010', format('Line %s is not a valid formula line: a line id once, a material once, an overage below 100 %% or a positive overage quantity with a reason of at most 500 characters, the salt factor only on a per-unit active, potency adjustment only on an active, compensation only on an excipient (D-S6-3, D-7q-1)', v_ord));
    end;
  end loop;
  if (select count(*) from formulary.formula_line where version_id = v_id and compensating) > 1 then
    perform recipe.formula_fail('EBMR-FRM-011', 'A formula has at most one compensating excipient (TB-01)');
  end if;
  if exists (select 1 from formulary.formula_line where version_id = v_id and potency_adjusted)
     <> exists (select 1 from formulary.formula_line where version_id = v_id and compensating) then
    perform recipe.formula_fail('EBMR-FRM-011', 'A potency-adjusted active needs its compensating excipient, and a compensating excipient an adjusted active (TB-01)');
  end if;
  return v_id;
end
$$;

-- The overage a BOM line states for formula line p_line (MBR content bom[].overage): {reason, percent} or {reason,
-- quantity: {value, unit}} (mg per unit for a PER_UNIT line, kg per batch for a PER_BATCH one), or NULL without a reasoned
-- overage.
create function recipe.formula_line_overage_json(p_line formulary.formula_line) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p_line.overage_reason is null then null
              when p_line.overage_quantity is not null
                then jsonb_build_object('reason', p_line.overage_reason, 'quantity',
                                        jsonb_build_object('value', trim_scale(p_line.overage_quantity)::text, 'unit', case p_line.basis when 'PER_UNIT' then 'mg' else 'kg' end))
              else jsonb_build_object('reason', p_line.overage_reason, 'percent', trim_scale(p_line.overage_percent)::text) end
$$;

-- As 0690, with the overage quantity in the base quantity and the BOM line's overage statement (header).
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
    select * into l from formulary.formula_line x where x.version_id = v.id and x.material_code = v_code;
    if l.version_id is null then
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
    if (b ? 'overage' or v_over is not null) and (b -> 'overage') is distinct from v_over then
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

revoke all on function recipe.formula_line_overage_json(formulary.formula_line) from public;

reset role;
