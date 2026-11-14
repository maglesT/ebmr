-- Owner decision of 13 November 2026 (retest item 9c; IN-18, INV-27): the batch-number register shows the serials a
-- numbering rule skipped and why. Batch numbers come from a protected write-ahead counter (kernel 0600); values are
-- never issued twice, so the database skips serials it cannot prove unused: after a server start the rest of the block
-- in force is retired (SERVER_RESTART), a ledger found ahead moves the counter past it (LEDGER_AHEAD), and a completed
-- restore moves it past everything the external ledger holds (RESTORE_EVENT). Each skip is already recorded, insert-only,
-- in continuity.sequence_bump; nothing new is stored. MGL260052 to MGL260100 on the demo are such a SERVER_RESTART skip.
--
-- Handbook: modules/site-services.md
--
--   site.batch_number_retired_ranges(site)  NEW. Read only (display and audit): per numbering rule of the site, each
--       recorded skip of its counter with the first and last serial skipped, the batch numbers those serials render to
--       at the time of the skip (null when the format needs a parent or a product the rule does not fix, or the serial
--       does not fit the format), the reason and when it was recorded. Never allocates, never reuses a number: a serial
--       of a skipped range can only come back through site.recover_batch_number, with the evidence that it was issued
--       before a restore (0600), and is then listed in the register itself.

set local role ebmr_owner;

create function site.batch_number_retired_ranges(p_site text)
returns table (rule_code text, format text, first_serial bigint, last_serial bigint, first_number text, last_number text,
               reason text, restore_event_id uuid, recorded_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, site, continuity, pg_temp as $$
declare
  r record;
begin
  for r in
    select k.rule_code, k.format, k.site_code, k.product_code, k.site_zone, b.value_before, b.value_after, b.reason, b.restore_event_id, b.recorded_at
      from site.batch_number_rule k
      join continuity.sequence_bump b on b.sequence_key = k.counter_key
     where k.site_code = p_site and b.value_after > b.value_before
     order by b.recorded_at, k.rule_code
  loop
    rule_code := r.rule_code;
    format := r.format;
    first_serial := r.value_before + 1;
    last_serial := r.value_after;
    reason := r.reason;
    restore_event_id := r.restore_event_id;
    recorded_at := r.recorded_at;
    first_number := null;
    last_number := null;
    if position('{PARENT}' in r.format) = 0 and (r.product_code is not null or position('{PRODUCT}' in r.format) = 0) then
      begin
        first_number := site.render_batch_number(r.format, r.site_code, r.product_code, r.recorded_at, r.site_zone, r.value_before + 1, null);
        last_number := site.render_batch_number(r.format, r.site_code, r.product_code, r.recorded_at, r.site_zone, r.value_after, null);
      exception when others then
        -- A serial beyond the format's digits renders no number; the serials still say what was skipped.
        first_number := null;
        last_number := null;
      end;
    end if;
    return next;
  end loop;
end
$$;

revoke all on function site.batch_number_retired_ranges(text) from public;
grant execute on function site.batch_number_retired_ranges(text) to ebmr_app;

reset role;
