-- Recipe core: a twin family is refused at market authorisation (owner decision of 13 November 2026 on the MGL-SR-BL
-- retest, bug 6; controls PR-01, INV-01, INV-17).
-- Handbook: modules/recipe-core.md
--
-- The family identity (mbr_family_identity, INV-17) compares the whole batch-size set, so {51.2 kg} and {51.2 kg,
-- 102.4 kg} are two families of one product (lead audit D-0, M2), and both could be authorised for the same market,
-- site, line and batch quantity: two masters for one product and batch size (211.186(a); EU chapter 4 above 4.17), and
-- planning then took the first (1921 now lists both and lets the planner choose, for data that already has twins).
--
--   recipe.authorisation_cell_twin_guard() (trigger a3_twin_family on recipe.authorisation_cell, before insert): a cell
--   that opens (CURRENT or BRIDGING) is refused, EBMR-RCP-438, when an open cell of an ACTIVE authorisation of another
--   family of the same edition, record kind, product code and strength (and pack type, for a packaging family) covers
--   the same market, site and line, a validity interval overlapping its own, and a batch size of the same quantity and
--   unit. The message names that family, its version and its batch size. A transaction-scoped advisory lock per
--   product, market, site and line serialises two activations at once. Another line, another market or another batch
--   quantity is not a twin; the family's own new version supersedes its cell as before.
--
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

create function recipe.authorisation_cell_twin_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  f      recipe.mbr_family;
  v_qty  jsonb;
  o      record;
  dec    constant text := '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$';
begin
  if new.status not in ('CURRENT', 'BRIDGING') then
    return new;
  end if;
  select * into f from recipe.mbr_family where id = new.family_id;
  v_qty := (select x -> 'quantity' from jsonb_array_elements(f.batch_sizes) x where x ->> 'id' = new.batch_size limit 1);
  if f.id is null or v_qty is null or coalesce(v_qty ->> 'value', '') !~ dec then
    return new;  -- the insert guards (0160) refuse a cell of an unknown family or batch size
  end if;
  perform pg_advisory_xact_lock(hashtextextended(format('recipe.twin_family|%s|%s|%s|%s|%s', f.product_code, f.strength, new.market, new.site, new.line), 0));
  select g.code, c.version_number, c.batch_size into o
    from recipe.authorisation_cell c
    join recipe.mbr_family g on g.id = c.family_id
   where c.family_id <> new.family_id
     and c.market = new.market and c.site = new.site and c.line = new.line
     and c.status in ('CURRENT', 'BRIDGING')
     and tstzrange(c.effective_from, c.valid_until, '[)') && tstzrange(new.effective_from, new.valid_until, '[)')
     and g.edition = f.edition and g.record_kind = f.record_kind and g.product_code = f.product_code and g.strength = f.strength
     and (f.record_kind <> 'PACKAGING' or recipe.family_pack_type(g.id) is not distinct from recipe.family_pack_type(f.id))
     and recipe.market_authorisation_state(c.authorisation_id) = 'ACTIVE'
     and exists (select 1 from jsonb_array_elements(g.batch_sizes) y
                  where y ->> 'id' = c.batch_size and y -> 'quantity' ->> 'unit' = v_qty ->> 'unit'
                    and coalesce(y -> 'quantity' ->> 'value', '') ~ dec and (y -> 'quantity' ->> 'value')::numeric = (v_qty ->> 'value')::numeric)
   order by g.code
   limit 1;
  if found then
    raise exception using errcode = 'P0001', message = format(
      'MBR family %s version %s is already authorised for %s %s, market %s, site %s, line %s and batch size %s (%s %s); a second family for the same product and batch size is refused: withdraw that authorisation first, or authorise this family for another line or batch size (PR-01, INV-17; EBMR-RCP-438)',
      o.code, o.version_number, f.product_code, f.strength, new.market, new.site, new.line, o.batch_size, trim_scale((v_qty ->> 'value')::numeric), v_qty ->> 'unit');
  end if;
  return new;
end
$$;

create trigger a3_twin_family before insert on recipe.authorisation_cell for each row execute function recipe.authorisation_cell_twin_guard();

revoke all on function recipe.authorisation_cell_twin_guard() from public;

reset role;
