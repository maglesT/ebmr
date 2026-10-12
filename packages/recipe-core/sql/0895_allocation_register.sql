-- The batch-number allocation register completed with the use of every number (Phase 4 slice 6a; control IN-18; default
-- D-6a-7; Schedule M Part I 17.3.10 numbering and allocation record; ADR 0012).
--
--   recipe.allocation_register(site, from, to)  the register as exported for an inspector: every number allocated at the
--       site in the window (site.batch_number_allocation, voided numbers included), in allocation order, with the
--       allocation date in the site's zone, the product identity (code, name and, once used, strength), the batch size and
--       unit, the kind (PROCESSING or PACKAGING), the processing number a packaging number is linked to, how it was
--       allocated (GENERATED, EXTERNAL, RECOVERED_AFTER_RESTORE), and its use: VOIDED (with the reason), CANCELLED (the
--       planned batch cancelled; the number is never offered again), ISSUED (the batch, its issue instant and the licence
--       it was made under, IN-30), PLANNED, or UNUSED. A number is never in the register twice (site-services 0600).
-- Read-only; the register's writers are unchanged.

set local role ebmr_owner;

create function recipe.allocation_register(p_site text, p_from timestamptz default null, p_to timestamptz default null) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'allocationId', a.id, 'batchNumber', a.batch_number, 'siteCode', a.site_code,
           'allocatedAt', site.utc_text(a.recorded_at),
           'allocationDate', to_char(a.recorded_at at time zone a.site_zone, 'YYYY-MM-DD'),
           'productCode', a.product_code, 'productName', a.product_name, 'strength', f.strength,
           'batchSize', a.batch_size::text, 'batchSizeUnit', a.batch_size_unit, 'edition', a.edition, 'kind', a.batch_kind,
           'parentBatchNumber', pa.batch_number, 'source', a.source,
           'use', case when v.allocation_id is not null then 'VOIDED'
                       when sb.status = 'CANCELLED' then 'CANCELLED'
                       when x.id is not null then 'ISSUED'
                       when sb.id is not null then 'PLANNED'
                       else 'UNUSED' end,
           'voidReason', case when v.allocation_id is not null then v.reason_code || ': ' || v.reason_text end,
           'batchId', l.batch_id, 'issuedAt', site.utc_text(x.issued_at),
           'licenceNumber', lb.licence_number, 'loanLicenceNumber', lb.loan_licence_number)
         order by a.recorded_at, a.batch_number), '[]'::jsonb)
    from site.batch_number_allocation a
    left join site.batch_number_allocation pa on pa.id = a.parent_allocation_id
    left join site.batch_number_void v on v.allocation_id = a.id
    left join recipe.batch_allocation_link l on l.allocation_id = a.id
    left join recipe.stub_batch sb on sb.id = l.batch_id
    left join recipe.mbr_family f on f.id = sb.family_id
    left join recipe.batch_execution x on x.id = l.batch_id
    left join recipe.batch_licence_basis lb on lb.batch_id = l.batch_id
   where a.site_code = p_site and (p_from is null or a.recorded_at >= p_from) and (p_to is null or a.recorded_at < p_to)
$$;

revoke all on function recipe.allocation_register(text, timestamptz, timestamptz) from public;
grant execute on function recipe.allocation_register(text, timestamptz, timestamptz) to ebmr_app;

reset role;
