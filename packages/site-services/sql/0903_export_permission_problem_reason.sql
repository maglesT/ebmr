-- The reason site.export_permission_problem gives (Phase 4 focused mutation, decision 0012; D-6-2, IN-30).
--
-- Found by the SQL mutation run (site.export_permission_problem#12): for an approved, not suspended permission asked about
-- an instant within its validity but before its QA approval (or before a suspension that came later), the reason said
-- "it lapsed at <valid until>", which it had not. Such an instant is asked only for a past instant (the issue gate asks
-- at the database's clock, where an approval is never later), so no batch was issued or refused wrongly: only the
-- reason was wrong. CREATE OR REPLACE from its latest definition (site services 0885) with one branch added, as
-- site.licence_problem has it: within its validity a permission that does not count at the instant "is not current" (not
-- yet approved then). Nothing else changes; CREATE OR REPLACE keeps the owner and the grants. Applied as a new migration
-- (applied migrations are never edited).

set local role ebmr_owner;

-- As 0885, with "not current" for an instant within the validity (header).
create or replace function site.export_permission_problem(p_site text, p_product text, p_strength text, p_destination text, p_at timestamptz) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  e site.export_permission;
begin
  if p_destination = 'IN' then
    return null;
  end if;
  if site.export_permission_current(p_site, p_product, p_strength, p_destination, p_at) is not null then
    return null;
  end if;
  select x.* into e from site.export_permission x
   where x.site_code = p_site and x.product_code = p_product and x.strength = p_strength and x.destination = p_destination
   order by x.recorded_at desc, x.id desc limit 1;
  if e.id is null then
    return format('no export permission of site %s covers %s %s for %s (D-6-2)', p_site, p_product, p_strength, coalesce(p_destination, 'NULL'));
  end if;
  return format('export permission %s for %s %s to %s does not count at %s: %s (D-6-2)', e.permission_number, p_product, p_strength, p_destination,
                site.utc_text(p_at),
                case
                  when site.export_permission_state(e.id) = 'DRAFT' then 'it is not approved by QA'
                  when site.export_permission_state(e.id) = 'SUSPENDED' then 'it is suspended or withdrawn'
                  when p_at < e.valid_from then 'it is valid only from ' || site.utc_text(e.valid_from)
                  when p_at >= e.valid_until then 'it lapsed at ' || site.utc_text(e.valid_until)
                  else 'it is not current'
                end);
end
$$;

reset role;
