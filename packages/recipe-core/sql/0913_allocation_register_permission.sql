-- Recipe core: reading the batch-number allocation register checks a permission (Phase 4 slice 6 quick review; control
-- IN-18; DI-17). recipe.allocation_register (0895) is granted to the application role and checked nothing itself; the
-- route only required a session. Re-created from its latest definition (0895) with one change: it first requires
-- RECORD.READ in the scope of the site it reads (defence in depth; the route now calls it inside the person's own command).

set local role ebmr_owner;

create or replace function recipe.allocation_register(p_site text, p_from timestamptz default null, p_to timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, iam, pg_temp as $$
begin
  perform iam.require_permission('RECORD.READ', jsonb_build_object('site', p_site));
  return (
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
   where a.site_code = p_site and (p_from is null or a.recorded_at >= p_from) and (p_to is null or a.recorded_at < p_to));
end
$$;

reset role;
