-- Phase B slice 4 (docs/build-plan/phase-b/platform-move-plan.md, "Published views"; PL-08, PL-13): the report views
-- Batchwright publishes to linked products on the platform (Deviations and Operations read them through their platform
-- link, as their own login). Each already carries read_at and data_as_of; nothing is removed or renamed.
--
-- Handbook: modules/recipe-core.md
--
--   * security_barrier on each published view;
--   * they stay owner-rights views (not security_invoker): a linked login needs only SELECT on the view (the platform's
--     apply grants it with USAGE on the schema report). PostgreSQL checks EXECUTE on a function a view calls against
--     the reader, so each view's row function is executable by PUBLIC: the function is the view (SECURITY DEFINER, the
--     same rows), and the schema report still gates who reaches it.

set local role ebmr_owner;

alter view report.batch_fact_v1 set (security_barrier = true);
alter view report.step_use_v1 set (security_barrier = true);
alter view report.cpp_value_v1 set (security_barrier = true);
alter view report.exception_v1 set (security_barrier = true);
alter view report.alarm_v1 set (security_barrier = true);
alter view report.batch_reference_v1 set (security_barrier = true);
alter view report.equipment_use_v1 set (security_barrier = true);
alter view report.ipc_result_v1 set (security_barrier = true);
alter view report.process_actual_v1 set (security_barrier = true);
alter view report.exception_detail_v1 set (security_barrier = true);

grant execute on function report.batch_fact_rows_v1(), report.step_use_rows_v1(), report.cpp_value_rows_v1(),
  report.exception_rows_v1(), report.alarm_rows_v1(), report.batch_reference_rows_v1(), report.equipment_use_rows_v1(),
  report.ipc_result_rows_v1(), report.process_actual_rows_v1(), report.exception_detail_rows_v1() to public;

reset role;
