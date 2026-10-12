-- Recipe core: both departments are notified of a recorded manufacturer decision (Phase 4 slice 3c; control IN-39
-- clause 2; the notification centre is recipe-core 0810). An AFTER INSERT trigger on recipe.manufacturer_release_decision
-- (slice 3a, recipe-core 0781) calls recipe.notify_departments_of_release with the decision's lot, decision and
-- signature, in the signing transaction: no decision is recorded without its two notifications (PRODUCTION and QA), and
-- a signature without a recorded decision notifies nobody.
-- Messages: EBMR-NTF-001 (0810).

set local role ebmr_owner;

create function recipe.notify_on_release_decision() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  perform recipe.notify_departments_of_release(new.lot_id,
                                               case new.decision when 'RELEASED' then 'RELEASE' when 'REJECTED' then 'REJECT' end,
                                               new.signature_id);
  return null;
end
$$;

create trigger zzzn_notify_departments after insert on recipe.manufacturer_release_decision
  for each row execute function recipe.notify_on_release_decision();

revoke all on function recipe.notify_on_release_decision() from public;

reset role;
