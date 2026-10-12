-- Tablets server: the edition's record tables refuse writes to a locked record, and a packing line does not start on
-- bright stock past its maximum hold (Phase 4 slice 5b; INV-21, PR-38; defaults D-5-7, D-5-8; recipe-core 0870, 0871).
--
--   * The row trigger a0_record_lock (recipe.refuse_locked_write, recipe-core 0870) on every edition table that holds a
--     batch record's content: dispensing's manual weighing basis, step devices and setpoint downloads, process readings
--     used and alarms acknowledged, tooling issued, detector challenges, packaging batch data, print jobs and the print
--     events used, SSCCs issued and AQL lot results. Not covered on purpose: device-side rows that are no entry of the
--     record (readings, heartbeats, acknowledgements of a download, interface losses and overdue alarms the system
--     raises, tooling returns, the serial pool).
--   * tab.packaging_run_problem: CREATE OR REPLACE from its latest definition (1102). Besides the bulk issued to the
--     order, packaging start (a new RUN_START at a TB-21 step, or the first entry of a TB-23 or TB-24 step) needs the
--     bulk within the product's maximum hold for bright stock, or a QA-assessed deviation covering it
--     (recipe.bright_stock_hold_problem, D-5-8). The trigger (1102) reports it as EBMR-TAB-395.

set local role ebmr_owner;

create trigger a0_record_lock before insert or update or delete on tab.manual_weighing_basis for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on tab.step_device for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on tab.setpoint_download for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on tab.process_reading_use for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on tab.process_alarm_ack for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on tab.tooling_issue for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on tab.detector_challenge for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on tab.packaging_batch_data for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on tab.print_job for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on tab.print_event_use for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on tab.sscc_issue for each row execute function recipe.refuse_locked_write('batch_id');
create trigger a0_record_lock before insert or update or delete on tab.aql_lot_result for each row execute function recipe.refuse_locked_write('batch_id');

create or replace function tab.packaging_run_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  e0     jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1     jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  k      text;
  e      jsonb;
  v_type text;
  v_hold text;
begin
  if kernel.installation_kind() = 'SANDBOX' then
    return null;
  end if;
  for k, e in select y.key, y.value from jsonb_each(e1) y where not (e0 ? y.key) order by (y.value ->> 'recordedSeq')::numeric, y.key loop
    v_type := recipe.step_node(p_content, split_part(coalesce(e ->> 'stepKey', ''), '@', 1)) -> 'block' ->> 'type';
    continue when not ((v_type = 'TB-21' and e ->> 'kind' = 'RUN_START') or v_type in ('TB-23', 'TB-24'));
    if not recipe.packaging_bulk_charged(p_batch) then
      return format('entry %s (%s) of %s step %s starts packing, and no bulk was issued to this batch: a packing line runs only a packaging order whose processing batch QA released for packing (H-PACK), on bulk issued to it from that batch''s usable containers (recipe.issue_packaging_bulk; D-S4-2, INV-27)',
                    k, e ->> 'kind', v_type, e ->> 'stepKey');
    end if;
    -- PR-38 (D-5-8): packaging start, the line's RUN_START or the first entry of the step, checks the bright-stock hold.
    if v_type = 'TB-21' or not exists (select 1 from jsonb_each(e0) z where z.value ->> 'stepKey' = e ->> 'stepKey') then
      v_hold := recipe.bright_stock_hold_problem(p_batch);
      if v_hold is not null then
        return format('entry %s (%s) of %s step %s starts packing on bright stock past its maximum hold: %s', k, e ->> 'kind', v_type, e ->> 'stepKey', v_hold);
      end if;
    end if;
  end loop;
  return null;
end
$$;

reset role;
