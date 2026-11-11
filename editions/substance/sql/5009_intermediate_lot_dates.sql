-- SITE-995 (lead rulings of 11 November 2026; site-services 1736): an in-house intermediate lot carries the dates the
-- firm set: an expiry date, a retest date, both, or neither. The person posting chooses which; no date is invented and no
-- choice is defaulted.
--
-- Handbook: modules/substance.md
--
--   substance.post_intermediate_lot(batch, quantity, unit, dating, retest_at)  replaces the three-argument function of
--       5004, which is dropped. Changes against 5004:
--       * dating (required): 'EXPIRY' is 5004's expiry (recipe.batch_expiry, the product master's shelf life, at the end of
--         that day in the site's zone; EBMR-SUB-003 without a shelf life, as before), with an optional retest date on or
--         before it; 'RETEST' is the person's retest date and no expiry; 'NONE' is neither date (site-services 1736 allows
--         a lot without an expiry for an in-house intermediate only). Any other value, a RETEST without its date, or a
--         date with NONE is refused (EBMR-SUB-005);
--       * a retest date is in the future (EBMR-SUB-004): a lot past its retest date is not used (PR-18); one after the
--         expiry is refused by site.create_intermediate_lot (EBMR-SITE-998).
--       Everything else (identity, permission, unit, product name, the guard of site.create_intermediate_lot) as 5004.
-- Messages: EBMR-SUB-001 to EBMR-SUB-003 (unchanged), EBMR-SUB-004, EBMR-SUB-005.
--
-- Owned by ebmr_owner, SECURITY DEFINER, search_path pinned with pg_temp last (ADR 0016).

set local role ebmr_owner;

drop function substance.post_intermediate_lot(uuid, text, text);

create function substance.post_intermediate_lot(p_batch uuid, p_quantity text, p_unit text, p_dating text, p_retest_at timestamptz) returns uuid
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
  -- Basis: record integrity (ALCOA+ accurate: the record holds the dates the firm set, never one the software chose).
  if p_dating is null or p_dating not in ('EXPIRY', 'RETEST', 'NONE')
     or (p_dating = 'RETEST' and p_retest_at is null) or (p_dating = 'NONE' and p_retest_at is not null) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SUB-005 intermediate batch %s: choose its dates: EXPIRY (from the product master''s shelf life, with a retest date if one is set), RETEST (with its date) or NONE (no date)', v_b ->> 'batchNumber');
  end if;
  -- Basis: PR-18 (a lot past its retest date is not used before it is retested): a new lot is never posted already due.
  if p_retest_at is not null and p_retest_at <= clock_timestamp() then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SUB-004 the retest date of intermediate batch %s is in the future (PR-18)', v_b ->> 'batchNumber');
  end if;
  if p_dating = 'EXPIRY' then
    v_be := recipe.batch_expiry(p_batch);
    v_expiry := (v_be ->> 'expiryDate')::date;
    if v_expiry is null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SUB-003 the expiry of intermediate batch %s cannot be computed: the product master''s shelf life is needed (IN-19)', v_b ->> 'batchNumber');
    end if;
  end if;
  select e.product_name into v_name from site.erp_product_effective(v_b ->> 'productCode', v_b ->> 'strength') e where e.id is not null;
  return site.create_intermediate_lot(jsonb_strip_nulls(jsonb_build_object(
    'batchId', p_batch, 'productName', v_name, 'quantity', p_quantity, 'unit', p_unit,
    'expiresAt', case when v_expiry is not null then ((v_expiry + 1)::timestamp at time zone kernel.site_zone()) - interval '1 microsecond' end,
    'retestAt', p_retest_at)));
end
$$;

revoke all on function substance.post_intermediate_lot(uuid, text, text, text, timestamptz) from public;
grant execute on function substance.post_intermediate_lot(uuid, text, text, text, timestamptz) to ebmr_app;

reset role;
