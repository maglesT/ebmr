-- Phase B slice 4 (docs/build-plan/phase-b/platform-move-plan.md, "Published views"; PL-08, PL-13): the report views
-- Batchwright publishes to linked products on the platform (Deviations and Operations read them through their platform
-- link, as their own login, which the platform's apply grants SELECT on the views and USAGE on the schema report).
-- Each already carries read_at and data_as_of; no column is removed or renamed.
--
-- Handbook: modules/recipe-core.md
--
--   * security_barrier on each published view; they stay owner-rights views (not security_invoker);
--   * PostgreSQL checks EXECUTE on a function a view calls against the reader, and the row functions report.<x>_rows_v1()
--     are revoked from PUBLIC (only ebmr_app and ebmr_report run them). Each view therefore reads through
--     report.<x>_published_v1(), executable by PUBLIC, which answers only a login that holds SELECT on that view
--     (session_user; otherwise 42501) and then returns the row function's rows. A login without the view's grant gets
--     nothing by calling it directly: ebmr_analytics still reads only its catalogued inputs (DI-51, PR-60), and a linked
--     login only the views its link grants. The row functions keep their grants.

set local role ebmr_owner;

do $do$
declare
  v text;
begin
  foreach v in array array['batch_fact', 'step_use', 'cpp_value', 'exception', 'alarm', 'batch_reference', 'equipment_use',
                            'ipc_result', 'process_actual', 'exception_detail'] loop
    execute format($f$
      create function report.%1$s_published_v1() returns %2$s
      language plpgsql stable security definer set search_path = pg_catalog, report, pg_temp as $b$
      begin
        if not has_table_privilege(session_user, 'report.%1$s_v1', 'SELECT') then
          raise exception using errcode = '42501', message = 'permission denied for view %1$s_v1';
        end if;
        return query select * from report.%1$s_rows_v1();
      end
      $b$$f$, v, pg_get_function_result(format('report.%s_rows_v1()', v)::regprocedure));
    execute format('grant execute on function report.%s_published_v1() to public', v);
    execute format('create or replace view report.%1$s_v1 with (security_barrier = true) as select * from report.%1$s_published_v1()', v);
  end loop;
end
$do$;

-- The analytics role read batch_fact_v1, cpp_value_v1 and step_use_v1 (its catalogued inputs) through their row functions
-- (1115); it now reads them through the views' own functions, so it keeps no EXECUTE on the row functions behind them.
revoke execute on function report.batch_fact_rows_v1(), report.cpp_value_rows_v1(), report.step_use_rows_v1() from ebmr_analytics;

reset role;
