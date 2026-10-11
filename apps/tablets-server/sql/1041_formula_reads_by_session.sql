-- Tablets server, Phase 3 slice 6a: the formulation library read for the session behind a request (DI-13, DI-17; ADR 0012).
-- The session is resolved from the hash of its cookie token (tab.reader_of, 0410: an active session in a role granted now,
-- EBMR-TAB-018) and FORMULA.READ is the role's permission now (tab.role_may), as every other read of a record is decided;
-- no command is opened, so a shop-floor terminal reads without a fresh authentication event (INV-40 is for commands) and
-- a reader without FORMULA.READ is refused for that (EBMR-IAM-040), never asked to tap.
--
--   tab.formula_read(token, formula)        the formulas (or one) with the composition only for a FORMULA.READ reader
--   tab.formula_choice(token, product, strength, units)   "Choose a product": FORMULA.READ, else EBMR-IAM-040
--   tab.mbr_composition_check(token, mbr)   refuses (EBMR-IAM-040) a reader without FORMULA.READ an MBR version that pins a
--                                           formula version (its composition comes from the library); nothing otherwise

set local role ebmr_owner;

create function tab.formula_read(p_token_hash text, p_formula uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  r tab.reader := tab.reader_of(p_token_hash);
begin
  return recipe.formula_listing(p_formula, tab.role_may(r.role_code, array['FORMULA.READ']));
end
$$;

create function tab.formula_reader_refusal(r tab.reader) returns void
language plpgsql stable set search_path = pg_catalog, tab, pg_temp as $$
begin
  if not tab.role_may(r.role_code, array['FORMULA.READ']) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-040 %s acting as %s lacks permission FORMULA.READ: a formula''s composition is confidential (DI-13, D-S6-4)', r.account_id, r.role_code);
  end if;
end
$$;

create function tab.formula_choice(p_token_hash text, p_product text, p_strength text, p_units numeric) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
begin
  perform tab.formula_reader_refusal(tab.reader_of(p_token_hash));
  return recipe.formula_choice_of(p_product, p_strength, p_units);
end
$$;

create function tab.mbr_composition_check(p_token_hash text, p_mbr uuid) returns void
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
begin
  if recipe.mbr_formula_of(p_mbr) is not null then
    perform tab.formula_reader_refusal(tab.reader_of(p_token_hash));
  end if;
end
$$;

revoke all on function tab.formula_read(text, uuid), tab.formula_reader_refusal(tab.reader), tab.formula_choice(text, text, text, numeric),
                       tab.mbr_composition_check(text, uuid) from public;
grant execute on function tab.formula_read(text, uuid), tab.formula_choice(text, text, text, numeric), tab.mbr_composition_check(text, uuid) to ebmr_app;

reset role;
