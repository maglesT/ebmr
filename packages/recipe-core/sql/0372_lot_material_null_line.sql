-- Recipe core, execution store (module C3): a weighed or charged lot is of the material its BOM line names, also where
-- the line names null (PR-18, IN-23, PR-21; decision F12.3: the accept rules are applied never weaker than the engine;
-- ADR 0012: the rules hold when the application's own database credentials are used directly). Found by the SQL
-- mutation run (batch 2, group entry-references-and-schema: the mutant recipe.lot_usability_problem#6 compared the
-- material of every line that has one, as the engine does, and was the stricter of the two).
--
-- What was wrong. recipe.lot_usability_problem (0330) compared a lot's material with its BOM line's only when the line's
-- material was neither absent nor JSON null. The engine (blocks/generic/material.ts lotProblems) compares whenever the
-- line's material is not undefined: a line whose material is null names null, so a lot of any material is refused
-- there (G07-WRONG-MATERIAL, "not the item the MBR names (null)"). The MBR parser (flow/parse.ts) defines no such line,
-- so neither the server nor the release gate's replay defines a batch of it; but recipe.import_test_package (0210)
-- checks the package's format, hashes, file name and origin and does not parse its content, so a test package imported
-- through the application role can hold one, and for a batch of it 0330 let a lot of any material be weighed or charged
-- at that line.
--
-- What changed: recipe.lot_usability_problem (CREATE OR REPLACE, the body of 0330 otherwise unchanged) compares the
-- lot's material whenever the line has a material member, JSON null included, as the engine does, and names null in
-- its words as the engine does. Not changed, stated so it is not over-read: a line without a material member, and a
-- BOM line the MBR does not hold, are not compared, as in the engine (0328 refuses a BOM line that the step's node does
-- not name). Every MBR the parser defines names a material on each line, so the engine's own runs are read as before.
--
-- CREATE OR REPLACE keeps the owner (ebmr_owner) and the privileges of 0330 (none for PUBLIC); IMMUTABLE and the
-- search_path are restated. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- PR-18, IN-23, PR-21: as 0330; a BOM line whose material is null names null, and a lot of any material is not of it.
create or replace function recipe.lot_usability_problem(p_content jsonb, p_bom_line jsonb, p_lot jsonb, p_now_us numeric, p_markets jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_material jsonb;
  v_code     jsonb;
  v_lot      jsonb := case when jsonb_typeof(p_lot) = 'object' then p_lot else '{}'::jsonb end;
  v_id       text := coalesce(v_lot ->> 'id', '(no id)');
begin
  select b.v -> 'material' into v_material
    from jsonb_array_elements(case when jsonb_typeof(p_content -> 'bom') = 'array' then p_content -> 'bom' else '[]'::jsonb end) with ordinality b (v, i)
   where b.v -> 'id' = p_bom_line order by b.i limit 1;
  if v_material is not null then
    select r.v -> 'code' into v_code
      from jsonb_array_elements(case when jsonb_typeof(p_content -> 'references') = 'array' then p_content -> 'references' else '[]'::jsonb end) with ordinality r (v, i)
     where r.v -> 'id' = v_material order by r.i limit 1;
    if (v_lot -> 'material') is distinct from v_material and (v_code is null or (v_lot -> 'material') is distinct from v_code) then
      return format('lot %s is of material %s, not the item the MBR names (%s) (G07-WRONG-MATERIAL)', v_id, coalesce(v_lot ->> 'material', '(none)'),
                    coalesce(coalesce(v_code, v_material) #>> '{}', 'null'));
    end if;
  end if;
  if (v_lot -> 'status') is distinct from '"RELEASED"'::jsonb then
    return format('lot %s is %s; only a released lot is used (G07-LOT-STATUS)', v_id, coalesce(v_lot ->> 'status', '(no status)'));
  end if;
  if jsonb_typeof(v_lot -> 'expiresAtUs') = 'string' and (v_lot ->> 'expiresAtUs') ~ '^[0-9]{1,20}$' and (v_lot ->> 'expiresAtUs')::numeric <= p_now_us then
    return format('lot %s is past its expiry date (G07-LOT-EXPIRED)', v_id);
  end if;
  if jsonb_typeof(v_lot -> 'retestAtUs') = 'string' and (v_lot ->> 'retestAtUs') ~ '^[0-9]{1,20}$' and (v_lot ->> 'retestAtUs')::numeric <= p_now_us then
    return format('lot %s is past its retest date (G07-LOT-RETEST)', v_id);
  end if;
  if (v_lot -> 'identityTested') = 'false'::jsonb
     and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_markets) = 'array' then p_markets else '[]'::jsonb end) m where m <> '"IN"'::jsonb) then
    return format('lot %s has no identity-test result, and the batch is for %s (G07-LOT-IDENTITY)', v_id,
                  (select string_agg(m #>> '{}', ', ') from jsonb_array_elements(p_markets) m));
  end if;
  return null;
end
$$;

reset role;
