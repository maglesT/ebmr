-- Site services: the deviations of the periodic evaluation pack (Phase 7 slice 7b-2; DI-11 clause 1; kernel 1336).
--
-- Handbook: modules/site-services.md
--
-- The periodic evaluation of the system lists the deviations raised in the period (topic DEVIATION, source log
-- site.deviation), each named by its row, read through the reporting path like every other topic. The row function is
-- STABLE (it cannot write) and executable by the owner only; report.evaluation_entry_rows_v1 (kernel 1336) calls it.

set local role ebmr_owner;

create function report.evaluation_deviations()
returns table (source_row text, occurred_at timestamptz, ended_at timestamptz, summary jsonb)
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select d.id::text, d.raised_at, null::timestamptz,
         jsonb_build_object('ref', d.ref, 'site', d.site_code, 'kind', d.kind, 'classification', d.classification, 'title', d.title)
    from site.deviation d
$$;
revoke all on function report.evaluation_deviations() from public;

select report.register_evaluation_source('DEVIATION', 'site.deviation', 'report.evaluation_deviations()', 'IN_PERIOD',
  'Deviations raised in the period, with their kind and classification');

reset role;
