-- Batch-number register: the zone a numbering rule or a registered number is dated in is the site's own (policy
-- site.zone) (Phase 2 exit, lead TODO T10, the same defect elsewhere; DI-27, IN-18).
--
-- Why. Kernel 0940 holds the site policy site.zone to an IANA name of a place (or UTC), because the kernel reads it
-- as a zone. site.define_batch_number_rule and site.register_external_batch_number (0600) took the zone of a rule or
-- of a registered number from the caller and checked only that the database knows the name (EBMR-SITE-002). So a
-- rule could carry an abbreviation-style alias such as EST, a fixed offset with an inverted POSIX sign such as
-- Etc/GMT+5, or another site's zone. The rule's zone dates every number it generates ({YY}, {YYYY}, {MM}) and every
-- allocation's register date (site.batch_number_register_view: recorded_at at the row's zone), so around midnight
-- and at the turn of a year a number could carry another date than the site's, and the register another day.
-- Every actor context of the installation must already declare the policy's zone (EBMR-IAM-118), and retention
-- dates refuse any other (EBMR-REC-020).
--
-- Now a row guard on site.batch_number_rule and site.batch_number_allocation (aa_site_zone_*) refuses a site_zone
-- other than the site policy's (iam.policy_text('site.zone')) with EBMR-SITE-002, whoever writes the row, the
-- owner's SECURITY DEFINER code included. A number generated from a rule takes the rule's zone, so after a change
-- of the site's zone a rule defined before it generates nothing until it is defined again in the new zone (a
-- change of site.zone stops the server anyway, SITE_ZONE_CHANGED). The functions of 0600 are unchanged.
--
-- The guard function belongs to ebmr_owner and is granted to nobody. Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-27: the zone a batch number is dated in is the site's.
create function site.site_zone_row_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_site_zone text := iam.policy_text('site.zone');
begin
  if new.site_zone is distinct from v_site_zone then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-002 site zone %s is not the zone of this site (%s): batch numbers and the register are dated in the site''s zone (policy site.zone, DI-27)',
                       coalesce(new.site_zone, 'NULL'), coalesce(v_site_zone, 'NULL'));
  end if;
  return new;
end
$$;

create trigger aa_site_zone_batch_number_rule before insert or update of site_zone on site.batch_number_rule
  for each row execute function site.site_zone_row_guard();
create trigger aa_site_zone_batch_number_allocation before insert or update of site_zone on site.batch_number_allocation
  for each row execute function site.site_zone_row_guard();

reset role;
