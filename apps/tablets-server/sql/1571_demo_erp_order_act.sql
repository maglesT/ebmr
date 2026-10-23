-- Tablets: the ERP simulator's production order as a recorded demo convenience (Phase 7 slice 7k; requirement R5 of the
-- hosted-demo trials).
--
-- Handbook: modules/tablets-server.md
--
-- "Send a production order" on the operations screen's simulators posts one order of a demo product as the ERP interface
-- (a demo GMP installation only; replaces the hosted demo's post-demo-order script). Like every demo convenience it is
-- recorded first through tab.record_demo_act (tablets 1485: refused on a GMP installation that is not a demo one,
-- EBMR-OPS-010, then PLATFORM.OPERATE), as act ERP_ORDER_SENT with the product and kind as its target. This migration
-- only widens the acts tab.demo_act accepts; the table stays insert-only and audited, and the function is unchanged.

set local role ebmr_owner;

do $$
declare
  v_name text;
begin
  for v_name in
    select c.conname from pg_constraint c
     where c.conrelid = 'tab.demo_act'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%SIMULATOR_FAULT_OFF%'
  loop
    execute format('alter table tab.demo_act drop constraint %I', v_name);
  end loop;
end
$$;

alter table tab.demo_act add constraint demo_act_act_check
  check (act in ('DEMO_LOAD', 'DEMO_RESET', 'SIMULATOR_START', 'SIMULATOR_STOP', 'SIMULATOR_FAULT_ON', 'SIMULATOR_FAULT_OFF', 'ERP_ORDER_SENT'));

reset role;
