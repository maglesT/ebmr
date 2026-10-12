-- Recipe core: a batch completes only with its contingency forms reconciled (Phase 4 slice 6 gate, residual R-6b-1;
-- controls DI-43, PR-16; default D-6-6; kernel 1170).
--
-- recipe.refuse_unreconciled_completion(): the row trigger a1_form_reconciliation, BEFORE INSERT OR UPDATE OF status on
-- recipe.execution_state. When a batch's status becomes EXECUTION_COMPLETE (from any other status, or on a first row)
-- it asks records.form_reconciliation_problem(batch) (kernel 1170) and refuses with its words (EBMR-EXE-310, then
-- EBMR-REC-106 and every unreconciled form serial, or the missing FORMS_RECONCILED signature). Every path that completes a
-- batch writes this row (the engine's projection through recipe.append_execution, and any other writer), so the rule holds
-- for all of them. A batch with no contingency form issued is unaffected (the function answers NULL). A row already
-- EXECUTION_COMPLETE is not checked again (later status changes, such as a review reopening, are other rules).

set local role ebmr_owner;

create function recipe.refuse_unreconciled_completion() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, records, pg_temp as $$
declare
  v_problem text;
begin
  if new.status = 'EXECUTION_COMPLETE' and (tg_op = 'INSERT' or old.status is distinct from 'EXECUTION_COMPLETE') then
    v_problem := records.form_reconciliation_problem(new.batch_id);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-EXE-310 the batch cannot complete before its contingency forms are reconciled: %s (DI-43, PR-16)', v_problem);
    end if;
  end if;
  return new;
end
$$;

revoke all on function recipe.refuse_unreconciled_completion() from public;

create trigger a1_form_reconciliation before insert or update of status on recipe.execution_state
  for each row execute function recipe.refuse_unreconciled_completion();

reset role;
