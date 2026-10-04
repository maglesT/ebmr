-- Recipe core, execution store (module C3): the reason a test package's header is refused names the side that differs
-- and what its value is (Phase 2 exit, SQL mutation kill work, defect D14; DI-04, DI-37, DI-05; message wording only:
-- what is refused is unchanged).
--
-- recipe.package_header_problem (0318) gives the reason of EBMR-EXE-134. Its family-code reason named
-- coalesce(the package's family code, the stored family code, 'none') against the header's family, and its product
-- reasons likewise the package's member before the stored one. So:
--   * when only the stored column differed (an owner-level insert into recipe.test_package with the package's own family
--     member), the reason named the package's value, which is the header's own, on both sides ("the family code
--     PCM500-DC is not the family of the MBR content (PCM500-DC)"), and the same for a product code, name or strength;
--   * when the family code was not text (a JSON number, boolean or null in both the package's family member and the
--     content's header), recipe.import_test_package stored it as text, which is never the header's value, so the package
--     was refused through the application role, as it must be, with the same value named on both sides ("the family code
--     500 is not the family of the MBR content (500)"), or "none" for a JSON null.
--
-- What changed: recipe.package_header_problem (CREATE OR REPLACE) refuses exactly the same packages and rows. Its reason
-- now says, for the family code: when the package's family code or the content's family is not text, that a family code
-- must be text, naming both values (one that is not text with its JSON type); when the package's family code is another
-- text than the content's, that one (as before); otherwise the stored family code that differs. For a product code,
-- name or strength: the package's value when it differs (as before), otherwise the stored value that differs, each value
-- that is not text named with its JSON type. recipe.json_value_described gives a value as the reasons name it.
--
-- The new function is owned by ebmr_owner and private to it; both pin their search_path with pg_temp last. CREATE OR
-- REPLACE by the same owner keeps the owner and the privileges (none for PUBLIC) of package_header_problem. Applied as a
-- new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-04, DI-37 (D14): JSON value p as a refusal names it: a text as it is, a missing value as none, any other value with
-- its JSON type.
create function recipe.json_value_described(p jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p is null then 'none'
              when jsonb_typeof(p) = 'string' then p #>> '{}'
              else format('%s (a JSON %s)', p::text, jsonb_typeof(p)) end
$$;

-- DI-04, DI-37: why test package p_package (as recipe.import_test_package receives it), stored with family code
-- p_family_code and product p_product, does not name its content's own family and product (0318); NULL when it does.
-- JSON values are compared, so a member of another type differs too. The reason names the side that differs (D14).
create or replace function recipe.package_header_problem(p_package jsonb, p_family_code text, p_product jsonb) returns text
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select case
    when jsonb_typeof(p_package -> 'family') is distinct from 'object' or jsonb_typeof(p_package -> 'family' -> 'product') is distinct from 'object'
      then 'the package names no family and product'
    when jsonb_typeof(p_package -> 'content' -> 'header') is distinct from 'object' or jsonb_typeof(p_package -> 'content' -> 'header' -> 'product') is distinct from 'object'
      then 'the MBR content has no header product'
    when p_package -> 'family' -> 'familyCode' is distinct from p_package -> 'content' -> 'header' -> 'family'
      or to_jsonb(p_family_code) is distinct from p_package -> 'content' -> 'header' -> 'family'
      then case
        when jsonb_typeof(p_package -> 'family' -> 'familyCode') is distinct from 'string' or jsonb_typeof(p_package -> 'content' -> 'header' -> 'family') is distinct from 'string'
          then format('the family code must be text: the package gives %s and the MBR content %s',
                      recipe.json_value_described(p_package -> 'family' -> 'familyCode'), recipe.json_value_described(p_package -> 'content' -> 'header' -> 'family'))
        when p_package -> 'family' -> 'familyCode' is distinct from p_package -> 'content' -> 'header' -> 'family'
          then format('the family code %s is not the family of the MBR content (%s)',
                      p_package -> 'family' ->> 'familyCode', p_package -> 'content' -> 'header' ->> 'family')
        else format('the stored family code %s is not the family of the MBR content (%s)',
                    coalesce(p_family_code, 'none'), p_package -> 'content' -> 'header' ->> 'family')
      end
    else (select case
                   when p_package -> 'family' -> 'product' -> k is distinct from p_package -> 'content' -> 'header' -> 'product' -> k
                     then format('the product %s %s is not the %s of the MBR content (%s)', k, recipe.json_value_described(p_package -> 'family' -> 'product' -> k), k,
                                 recipe.json_value_described(p_package -> 'content' -> 'header' -> 'product' -> k))
                   else format('the stored product %s %s is not the %s of the MBR content (%s)', k, recipe.json_value_described(p_product -> k), k,
                               recipe.json_value_described(p_package -> 'content' -> 'header' -> 'product' -> k))
                 end
            from unnest(array['code', 'name', 'strength']) k
           where p_package -> 'family' -> 'product' -> k is distinct from p_package -> 'content' -> 'header' -> 'product' -> k
              or p_product -> k is distinct from p_package -> 'content' -> 'header' -> 'product' -> k
           order by array_position(array['code', 'name', 'strength'], k)
           limit 1)
  end
$$;

revoke all on function recipe.json_value_described(jsonb) from public;

reset role;
