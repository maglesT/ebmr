-- Market-profile engine: a site value of a set-valued key is EQUAL to the resolved value when it holds the same
-- elements, in whatever order (Phase 2 exit, lead TODO T9; IN-52, INV-28, DI-37).
--
-- Why. market.assess_site_value (0320) called a site value at least as strict as the resolved value EQUAL only when
-- the two were the same JSON (p_value = v_res), else TIGHTER. For SET_UNION and ALL_APPLY keys a value is a set: its
-- order carries no meaning, and the strictness test already compares sets (a @> b for SET_UNION; criteria_cover for
-- ALL_APPLY, each criterion by its full definition). So the very criteria the markets require, listed in another
-- order, were recorded as a TIGHTER site value (market.site_value.outcome) and every evaluation that used it reported
-- SITE_TIGHTER (market.apply_site_value, 0330): the record claimed the site had added a criterion or an element when
-- it had added nothing. Nothing looser was ever accepted; the record said something untrue.
--
-- Now market.same_value(method, ordered, a, b) decides equality as the strictness test decides order: for SET_UNION
-- and ALL_APPLY two values are equal when each is at least as strict as the other, that is, when they hold the same
-- elements (SET_UNION: identifiers; ALL_APPLY: criteria, each by its full definition, so a criterion that keeps its id
-- but changes anything is another criterion); a value cannot repeat an element or a criterion id
-- (market.value_problem, EBMR-MKT-062). For the other methods it is JSON equality, as before. The TypeScript twin is
-- isSameValue in src/market/strictness.ts; a test compares the two. market.assess_site_value (CREATE OR REPLACE,
-- otherwise unchanged) uses it for EQUAL.
--
-- market.same_value belongs to ebmr_owner and is granted to nobody, as market.at_least_as_strict. assess_site_value
-- keeps its signature, owner, SECURITY DEFINER, search_path and grants. Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- IN-52, INV-28 (T9): are values a and b of a key with this method the same value? Sets by their elements, in any
-- order; everything else as JSON. NULL for a NOT_COMPARABLE key, as market.at_least_as_strict.
create function market.same_value(p_method text, p_ordered jsonb, a jsonb, b jsonb) returns boolean
language sql immutable set search_path = pg_catalog, market, pg_temp as $$
  select case
    when p_method in ('SET_UNION', 'ALL_APPLY')
      then market.at_least_as_strict(p_method, p_ordered, a, b) and market.at_least_as_strict(p_method, p_ordered, b, a)
    when p_method = 'NOT_COMPARABLE' then null
    else a = b
  end
$$;

-- Assess a candidate value against a resolution. Returns {outcome, code, message}: outcome is
-- TIGHTER, EQUAL, LOOSENING (allowed only with justification and QA approval) or REFUSED.
create or replace function market.assess_site_value(p_resolution jsonb, p_value jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, market, pg_temp as $$
declare
  k         market.rule_key;
  v_prob    text;
  v_res     jsonb := p_resolution -> 'value';
  c         jsonb;
  v_design  text;
begin
  select * into k from market.rule_key where version_id = (p_resolution ->> 'tableVersionId')::uuid and key = p_resolution ->> 'key';
  if k.method = 'NOT_COMPARABLE' then
    return jsonb_build_object('outcome', 'REFUSED', 'code', 'EBMR-MKT-063',
      'message', format('key %s is NOT_COMPARABLE; it is resolved per destination and takes no site value', k.key));
  end if;
  v_prob := market.value_problem(k.value_type, k.ordered_values, p_value);
  if v_prob is not null then
    return jsonb_build_object('outcome', 'REFUSED', 'code', 'EBMR-MKT-062', 'message', format('site value for %s: %s', k.key, v_prob));
  end if;
  if not (p_resolution ->> 'applicable')::boolean then
    -- No market in scope sets this key, so any site value is an addition.
    return jsonb_build_object('outcome', 'TIGHTER');
  end if;
  if market.at_least_as_strict(k.method, k.ordered_values, p_value, v_res) then
    -- T9: EQUAL when it is the same value; a set in another order is the same set.
    return jsonb_build_object('outcome', case when market.same_value(k.method, k.ordered_values, p_value, v_res) then 'EQUAL' else 'TIGHTER' end);
  end if;
  if k.method in ('SET_UNION', 'ALL_APPLY') then
    return jsonb_build_object('outcome', 'REFUSED', 'code', 'EBMR-MKT-064',
      'message', format('a site value for %s may add elements but cannot remove or change any of %s', k.key, v_res::text));
  end if;
  if market.nz(p_resolution -> 'hardFloor', null) is not null
     and not market.at_least_as_strict(k.method, k.ordered_values, p_value, p_resolution -> 'hardFloor') then
    return jsonb_build_object('outcome', 'REFUSED', 'code', 'EBMR-MKT-060',
      'message', format('site value %s for %s is looser than the binding (HARD) value %s', p_value::text, k.key, (p_resolution -> 'hardFloor')::text));
  end if;
  select string_agg(x ->> 'market', ', ' order by x ->> 'market') into v_design
    from jsonb_array_elements(p_resolution -> 'contributions') x
   where x ->> 'floorType' = 'DESIGN' and not market.at_least_as_strict(k.method, k.ordered_values, p_value, x -> 'value');
  if v_design is not null then
    return jsonb_build_object('outcome', 'REFUSED', 'code', 'EBMR-MKT-061',
      'message', format('site value %s for %s would loosen a DESIGN value (product choice, %s); design values change only through a new table version',
                        p_value::text, k.key, v_design));
  end if;
  return jsonb_build_object('outcome', 'LOOSENING');
end
$$;

reset role;
