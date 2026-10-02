-- Recipe core, execution store (module C3): a test package's family metadata is its MBR content's own header (Phase 2
-- exit review F03; DI-04, DI-37, DI-05; ADR 0012: the rule holds when the application's own database credentials are
-- used directly).
--
-- recipe.import_test_package (0210) checked a package's format, both hashes, its file name and its GMP origin, and
-- stored its family code and product (recipe.test_package.family_code, product) from the package's own `family` member,
-- never compared with the content's header. A package whose metadata named family IBU400-DC and product "Ibuprofen
-- tablets" over the dc-mini content (family PCM500-DC, "Paracetamol tablets") was imported, and every signature dialog
-- of its runs showed that family and name as part of the record to be signed, while the signatures bind the content's
-- family, product code and MBR hash (signing-content.ts content.batch).
--
-- A new row trigger (a2_test_package_header, before insert on recipe.test_package) refuses a package whose family code
-- or product code, name or strength, in the package's `family` member or in the columns stored from it, is not the
-- content's header (EBMR-EXE-134). It runs for every insert, whatever function makes it. The GMP database already
-- binds the family code, product code and strength of a version's content to its family (recipe.content_family_problem,
-- 0110); the designer's export now takes the product name from the content too (apps/tablets-server designer), so an
-- honest export always agrees. The same rule runs in TypeScript before the import (execution/test-package.ts
-- packageHeaderProblems). Rows already imported are left as they are.
--
-- The new functions are owned by ebmr_owner and private to it; the trigger function is SECURITY DEFINER and pins its
-- search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed and never
-- edited.

set local role ebmr_owner;

-- DI-04, DI-37: why test package p_package (as recipe.import_test_package receives it), stored with family code
-- p_family_code and product p_product, does not name its content's own family and product (header); NULL when it does.
-- JSON values are compared, so a member of another type differs too.
create function recipe.package_header_problem(p_package jsonb, p_family_code text, p_product jsonb) returns text
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select case
    when jsonb_typeof(p_package -> 'family') is distinct from 'object' or jsonb_typeof(p_package -> 'family' -> 'product') is distinct from 'object'
      then 'the package names no family and product'
    when jsonb_typeof(p_package -> 'content' -> 'header') is distinct from 'object' or jsonb_typeof(p_package -> 'content' -> 'header' -> 'product') is distinct from 'object'
      then 'the MBR content has no header product'
    when p_package -> 'family' -> 'familyCode' is distinct from p_package -> 'content' -> 'header' -> 'family'
      or to_jsonb(p_family_code) is distinct from p_package -> 'content' -> 'header' -> 'family'
      then format('the family code %s is not the family of the MBR content (%s)', coalesce(p_package -> 'family' ->> 'familyCode', p_family_code, 'none'),
                  coalesce(p_package -> 'content' -> 'header' ->> 'family', 'none'))
    else (select format('the product %s %s is not the %s of the MBR content (%s)', k, coalesce(p_package -> 'family' -> 'product' ->> k, p_product ->> k, 'none'), k,
                        coalesce(p_package -> 'content' -> 'header' -> 'product' ->> k, 'none'))
            from unnest(array['code', 'name', 'strength']) k
           where p_package -> 'family' -> 'product' -> k is distinct from p_package -> 'content' -> 'header' -> 'product' -> k
              or p_product -> k is distinct from p_package -> 'content' -> 'header' -> 'product' -> k
           order by array_position(array['code', 'name', 'strength'], k)
           limit 1)
  end
$$;

-- DI-04, DI-37 (F03): a test package is stored only with the family and product of its own content. EBMR-EXE-134.
create function recipe.test_package_header_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_problem text := recipe.package_header_problem(new.package, new.family_code, new.product);
begin
  if new.content is distinct from new.package -> 'content' then
    v_problem := coalesce(v_problem, 'the stored content is not the package''s content');
  end if;
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('Test package %s is refused: %s. The family and product a test run shows are those of the MBR content its signatures bind (DI-04, DI-37). [EBMR-EXE-134]',
                       left(coalesce(new.package_hash, 'unknown'), 12), v_problem);
  end if;
  return new;
end
$$;

create trigger a2_test_package_header before insert on recipe.test_package
  for each row execute function recipe.test_package_header_check();

revoke all on function recipe.package_header_problem(jsonb, text, jsonb), recipe.test_package_header_check() from public;

reset role;
