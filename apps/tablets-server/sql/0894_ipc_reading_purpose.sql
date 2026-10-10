-- Tablets server, Phase 3 slice 3c (builder B): an instrument reading is claimed as the value of an in-process check
-- (purpose IPC) besides the tare or the gross of a weighing (controls DI-31, DI-32; ADR 0012). tablets 0600 allowed TARE
-- and GROSS only and said a later release adds a purpose with its flow; the IPC blocks TB-11 to TB-15 are that flow: a
-- test value captured from the instrument stands on a reading claimed as IPC in the same command (tablets 0893,
-- tab.ipc_readings_problem). tab.reading_use_purpose_check is replaced from its definition in 0600 with IPC added;
-- nothing else of it changes (any other purpose, a real-format word among them, is still refused). Applied as a new
-- migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- As tablets 0600, with IPC beside TARE and GROSS.
create or replace function tab.reading_use_purpose_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
begin
  if new.purpose is null or new.purpose not in ('TARE', 'GROSS', 'IPC') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-106 DI-32: reading %s cannot be claimed as "%s": a scale reading is claimed only as the TARE or the GROSS of a weighing, or as the value of an in-process check (IPC), the purposes the server claims (DI-05)',
                       new.reading_id, left(coalesce(new.purpose, 'nothing'), 64));
  end if;
  return new;
end
$$;

reset role;
