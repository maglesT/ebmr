-- The formulation library's readers for a caller that has decided FORMULA.READ itself (Phase 3 slice 6a; DI-13). The
-- tablets server reads formulas for the session behind a request without opening a command (tablets 1041: the session
-- is resolved from its token and its role's permissions read, as every other read of a record is decided, 0410), so a
-- shop-floor terminal's read needs no fresh authentication event (INV-40 is for commands). These functions are the
-- bodies of recipe.formula_read and recipe.formula_choice (0640) without their own permission check; only the owner
-- executes them (the application role holds no EXECUTE): tab.formula_read and tab.formula_choice call them after the
-- check. 0640's readers stay as they are for a caller in a command.

set local role ebmr_owner;

-- As recipe.formula_read (0640), the composition served only when p_readable.
create function recipe.formula_listing(p_formula uuid, p_readable boolean) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  f     recipe.formula;
  v_out jsonb := '[]'::jsonb;
begin
  for f in select * from recipe.formula where p_formula is null or id = p_formula order by product_code, strength, batch_size_units loop
    v_out := v_out || jsonb_build_object(
      'formulaId', f.id, 'productCode', f.product_code, 'strength', f.strength, 'batchSizeUnits', f.batch_size_units::text,
      'compositionReadable', coalesce(p_readable, false),
      'versions', coalesce((select jsonb_agg(jsonb_build_object(
          'versionId', v.id, 'versionNumber', v.version_number, 'state', recipe.formula_version_state(v.id), 'changeReason', v.change_reason,
          'authoredBy', v.authored_by_person, 'authoredByAccount', v.authored_by_account,
          'authoredUs', (extract(epoch from v.authored_at) * 1000000)::numeric(20, 0)::text,
          'approvedBy', a.approved_by_person, 'approvedByAccount', a.approved_by_account,
          'approvedUs', (extract(epoch from a.approved_at) * 1000000)::numeric(20, 0)::text,
          'lines', case when coalesce(p_readable, false) then recipe.formula_lines_json(v.id) end) order by v.version_number)
        from recipe.formula_version v left join recipe.formula_approval a on a.version_id = v.id where v.formula_id = f.id), '[]'::jsonb));
  end loop;
  if p_formula is not null and jsonb_array_length(v_out) = 0 then
    perform recipe.formula_fail('EBMR-FRM-003', format('There is no formula %s', p_formula));
  end if;
  return v_out;
end
$$;

-- As recipe.formula_choice (0640) without its permission check.
create function recipe.formula_choice_of(p_product text, p_strength text, p_units numeric) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  f recipe.formula;
  v recipe.formula_version;
begin
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

revoke all on function recipe.formula_listing(uuid, boolean), recipe.formula_choice_of(text, text, numeric) from public;

reset role;
