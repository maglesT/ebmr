-- API edition plan A2, change C1 (lead design of 5 November 2026; controls AS-03, AS-09, AS-16): the output of a
-- processing batch of the API edition is posted as an INTERMEDIATE lot in quarantine (site-services 1732).
--
-- Handbook: modules/substance.md
--
-- A function of the substance namespace only; tablets and injectables behave as before (they post with
-- tab.post_finished_lot, tablets 1150 and 1201, which is unchanged).
--
--   substance.post_intermediate_lot(batch, quantity, unit)  MATERIAL.HANDLE at the batch's site (site services checks it
--       again), never an administrator. As tab.post_finished_lot for a processing batch of the API edition: the batch is
--       a GMP batch; its intermediate lot is created once, in QUARANTINE, with lot code = batch number, material code =
--       the intermediate product's code, the product's name from the product master in effect, and the expiry of
--       recipe.batch_expiry (the batch's manufacture date plus the product master's shelf life in effect then, rounded
--       down to a month end, capped by recovered inputs; IN-19 (b)) at the end of that day in the site's zone. Which
--       batches may post (a complete PROCESSING batch of edition SUBSTANCE) is site.create_intermediate_lot's guard.
--       Without a shelf life the post is refused (AS-09: a held intermediate carries its date).
-- Released only by QA's release for further processing (the material-lot release), consumed by the next step's batch
-- through the reservation and consumption of any lot.
-- Messages: EBMR-SUB-001 to EBMR-SUB-003.
--
-- Owned by ebmr_owner, SECURITY DEFINER, search_path pinned with pg_temp last (ADR 0016). PL/pgSQL: a sandbox database
-- is migrated without the tablets namespace.

set local role ebmr_owner;

create function substance.post_intermediate_lot(p_batch uuid, p_quantity text, p_unit text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, substance, recipe, site, iam, kernel, pg_temp as $$
declare
  v_b      jsonb;
  v_be     jsonb;
  v_expiry date;
  v_name   text;
begin
  perform site.require_actor();
  perform iam.assert_not_administrator();
  v_b := site.subject_identity('BATCH', p_batch);
  if v_b is null then
    raise exception using errcode = 'P0001', message = format('EBMR-SUB-001 batch %s is not a GMP batch of this installation', coalesce(p_batch::text, 'NULL'));
  end if;
  perform iam.require_permission('MATERIAL.HANDLE', jsonb_build_object('site', v_b ->> 'siteCode'));
  if coalesce(p_unit, '') !~ '^[!-~]{1,32}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-SUB-002 the unit of the posted quantity is a UCUM code';
  end if;
  v_be := recipe.batch_expiry(p_batch);
  v_expiry := (v_be ->> 'expiryDate')::date;
  if v_expiry is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SUB-003 the expiry of intermediate batch %s cannot be computed: the product master''s shelf life is needed (AS-09, IN-19)', v_b ->> 'batchNumber');
  end if;
  select e.product_name into v_name from site.erp_product_effective(v_b ->> 'productCode', v_b ->> 'strength') e where e.id is not null;
  return site.create_intermediate_lot(jsonb_build_object(
    'batchId', p_batch, 'productName', v_name, 'quantity', p_quantity, 'unit', p_unit,
    'expiresAt', ((v_expiry + 1)::timestamp at time zone kernel.site_zone()) - interval '1 microsecond'));
end
$$;

revoke all on function substance.post_intermediate_lot(uuid, text, text) from public;
grant usage on schema substance to ebmr_app;
grant execute on function substance.post_intermediate_lot(uuid, text, text) to ebmr_app;

reset role;
