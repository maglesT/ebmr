-- Slice S16: two report views of the documents a batch's master record cites, for a separate Deviations and CAPA system
-- that reads Batchwright batch data read-only through the reporting role (ADR 0022, decisions D-S16-1 to D-S16-3 and
-- D-S16-6; kernel 1210, recipe-core 1070 and 1115).
-- Handbook: modules/tablets-server.md
--
-- Why. The Deviations system investigates a batch from the report views it already reads (batch_fact_v1, step_use_v1,
-- cpp_value_v1, exception_v1, alarm_v1). To name the procedures in force at the event it also needs the reference
-- documents (the SOPs, validation reports, equipment classes and the rest that tab.reference_document, the DMS
-- stand-in, holds) and the ones the batch's master record cites in its references. Block instructions carry no SOP link
-- (sop: null); the procedures of a batch are the references of its pinned master version (route level). Both live in
-- the Tablets edition (tab.reference_document is a Tablets table), so the views are a Tablets migration: recipe-core
-- never names a tab table.
--
--   report.reference_document_v1   one row per recorded reference document version: kind, code, version, title and the
--                                  date it takes effect (retired and withdrawn versions stay listed: the version a
--                                  batch cited is still the one it cited)
--   report.batch_reference_v1      one row per GMP batch record and document its master record cites: the batch number
--                                  and the kind, code and version the record pins (its references list), with the
--                                  title of the registered document (the record's own title for a reference no
--                                  document of that kind, code and version is registered for)
-- The master record of a batch is the one it runs (recipe.batch_mbr_content: its control recipe's snapshot), the same
-- content batch_fact_v1's mbr_version_id and cpp_value_v1's limits come from. GMP batch records only (installation GMP,
-- purpose GMP_BATCH), as batch_fact_v1.
--
-- Built as the 6g and 6A report views are: each view report.<name>_v1 selects from its row function
-- report.<name>_rows_v1() (SQL, STABLE, SECURITY DEFINER, owned by ebmr_owner, search_path pinned with pg_temp last), so
-- the reader needs no right on the tab or recipe tables behind it; every row carries read_at (the statement time) and
-- data_as_of (report.data_as_of()). SELECT on the views and EXECUTE on their row functions to ebmr_app (the dashboards)
-- and ebmr_report only: the segregation check (sandbox.segregation_problems, kernel 1242) allows the reporting role
-- exactly SELECT on report views and EXECUTE on non-volatile report functions, so nothing there changes. Both are in the
-- report catalogue (report.view_registry); neither is an analytics input. The views write nothing and decide nothing.
-- A change of columns is a new _v2 view; these _v1 views are never changed in place (D-S16-2).

set local role ebmr_owner;

create function report.reference_document_rows_v1()
returns table (kind text, code text, version text, title text, effective_from date, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, tab, report, pg_temp as $$
  select d.kind, d.code, d.version, d.title, d.effective_from, pg_catalog.statement_timestamp(), report.data_as_of()
    from tab.reference_document d
   order by d.kind, d.code, d.effective_from, d.version
$$;

create function report.batch_reference_rows_v1()
returns table (batch_number text, kind text, code text, version text, title text, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, tab, report, pg_temp as $$
  select x.batch_number, r.v ->> 'kind', r.v ->> 'code', r.v ->> 'version',
         coalesce((select d.title from tab.reference_document d
                    where d.kind = r.v ->> 'kind' and d.code = r.v ->> 'code' and d.version = r.v ->> 'version'),
                  r.v ->> 'title'),
         pg_catalog.statement_timestamp(), report.data_as_of()
    from recipe.batch_execution x
    cross join lateral (select recipe.batch_mbr_content(x.id) as content) m
    cross join lateral pg_catalog.jsonb_array_elements(
                         case when pg_catalog.jsonb_typeof(m.content -> 'references') = 'array' then m.content -> 'references' else '[]'::jsonb end)
                       with ordinality r(v, n)
   where x.installation = 'GMP' and x.purpose = 'GMP_BATCH'
     and pg_catalog.jsonb_typeof(r.v) = 'object' and r.v ->> 'kind' is not null and r.v ->> 'code' is not null
   order by x.issued_at, x.batch_number, r.v ->> 'kind', r.v ->> 'code', r.v ->> 'version'
$$;

revoke all on function report.reference_document_rows_v1(), report.batch_reference_rows_v1() from public;
grant execute on function report.reference_document_rows_v1(), report.batch_reference_rows_v1() to ebmr_app, ebmr_report;

create view report.reference_document_v1 as select * from report.reference_document_rows_v1();
create view report.batch_reference_v1 as select * from report.batch_reference_rows_v1();
revoke all on report.reference_document_v1, report.batch_reference_v1 from public;
grant select on report.reference_document_v1, report.batch_reference_v1 to ebmr_app, ebmr_report;

insert into report.view_registry (view_name, version, grain, description) values
  ('reference_document_v1', 1, 'reference document version', 'Every recorded reference document version (SOPs, validation reports, equipment classes and the rest): kind, code, version, title and the date it takes effect'),
  ('batch_reference_v1', 1, 'GMP batch record and cited document', 'The documents each GMP batch record''s master record cites (its references): batch number, kind, code, version and title');

reset role;
