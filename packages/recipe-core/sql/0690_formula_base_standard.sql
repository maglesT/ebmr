-- Phase 3 slice 6d (GB-T-01; D-S6-3, INV-25, PR-19): an active given in the formula as its base with a salt-to-base
-- factor may stand in the MBR's BOM on the base. The formula's batch mass counts the salt (the reference batch size is
-- the mass of the batch, 0640), but a TB-01 dispensing step that states its standard on the base (config active
-- standardIs BASE, with the declared form's molar masses) converts the base to the salt itself at dispensing, from the
-- lot's assay (C-02): its BOM line, and the ERP order's, hold the base. Before this, a formula with a salt factor could
-- only be pinned to an MBR whose BOM held the salt, and the base-stated TB-01 step then applied the factor twice.
--
-- recipe.formula_mbr_problem (0640) is replaced from its latest definition with one change: the BOM line of a formula
-- line with a salt factor that a TB-01 step of the MBR consumes as its active, stated on the base, carries the base
-- quantity (quantity x units x (100 + overage) / 100, in kg), computed here like every other quantity, never typed.
-- Every other line is checked as before.

set local role ebmr_owner;

-- Whether MBR content p_content has a TB-01 step whose active is BOM line p_bom_line stated on the base.
create function recipe.formula_bom_line_on_base(p_content jsonb, p_bom_line text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1 from jsonb_path_query(coalesce(p_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p
     where p -> 'block' ->> 'type' = 'TB-01'
       and p -> 'config' -> 'active' ->> 'bomLine' = p_bom_line
       and p -> 'config' -> 'active' ->> 'standardIs' = 'BASE'
       and jsonb_typeof(p -> 'consumes') = 'array' and p -> 'consumes' ? p_bom_line)
$$;

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
    -- The salt on the base (this migration): the BOM line holds the base when a base-stated TB-01 step dispenses it.
    v_want := case
                when l.salt_factor is not null and l.role = 'ACTIVE' and l.basis = 'PER_UNIT' and recipe.formula_bom_line_on_base(c, b ->> 'id')
                  then l.quantity * f.batch_size_units * (100 + coalesce(l.overage_percent, 0)) / 100 / 1000000
                else l.batch_quantity_kg
              end;
    if v_kg is distinct from v_want then
      return format('BOM line %s (%s) is %s %s; the formula computes %s kg (INV-25)', b ->> 'id', v_code, b -> 'quantity' ->> 'value', b -> 'quantity' ->> 'unit',
                    trim_scale(v_want));
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

revoke all on function recipe.formula_bom_line_on_base(jsonb, text) from public;

reset role;
