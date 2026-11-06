-- Recipe core: a capsule's per-batch excipients (Capsules edition C6b, lead 5 November 2026; 21 CFR 211.186(b)(1) and
-- Schedule M: the master's component list names what goes into the product; controls INV-25, PR-03).
--
-- Handbook: modules/recipe-core.md
--
--   * recipe.formula_add_version (CREATE OR REPLACE from 1740): a line given per batch may be an EXCIPIENT when the
--     request states unitForm CAPSULE (a soft gel's gelatin and glycerin make its shell and stay in the product, so they
--     are excipients, not processing aids). The application server states it from the product's dosage form (one rule,
--     recipe-core flow.readDosageForm: the product master's, or core's report.product_v1 on the platform build); the
--     client never sends it. A request without it is a tablet's, refused as before (EBMR-FRM-009). Nothing else changes.
--
-- Messages: EBMR-FRM-009 (reworded).

set local role ebmr_owner;

-- As 1740, with the capsule's per-batch excipient (header).
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
    -- 1875: a capsule's per-batch excipient (a soft gel's gel mass components) is given per batch too (header).
    if l ->> 'basis' = 'PER_BATCH' and l ->> 'role' <> 'PROCESSING_AID'
       and not (l ->> 'role' = 'EXCIPIENT' and p ->> 'unitForm' is not distinct from 'CAPSULE') then
      perform recipe.formula_fail('EBMR-FRM-009', format('Line %s: only a processing aid (or, for a capsule, an excipient of its shell) is given per batch; a component of the unit is given per unit (INV-25)', v_ord));
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

reset role;
