-- Recipe core: a TEST- batch number is never cut short, so a number is never issued twice (INV-27).
--
-- recipe.begin_issue (0210) wrote the serial from recipe.test_batch_number_seq with lpad(serial, 4, '0').
-- PostgreSQL's lpad also shortens a string that is already longer than the width: serials 10000 to 10009
-- all became 1000, and 12345 became 1234. The first 9999 test batches were numbered correctly; after that,
-- or at once after the first restore (0220 registers the sequence as protected, and the restore procedure,
-- continuity.after_restore and continuity.secure_identifiers in kernel 0600, moves it to at least the
-- exported high-water mark plus 10000), every serial was cut to four digits. Each issue then either failed
-- on the unique batch number or re-issued a number from the lost window that may already be printed on
-- sandbox records and quoted in test reports: the reuse INV-27 forbids.
--
-- Now the serial is written in full and only padded with leading zeros up to four digits:
--   1 -> 0001, 999 -> 0999, 9999 -> 9999, 10000 -> 10000, 10001 -> 10001.
-- The mapping from serial to number is one to one (within a year's prefix; the sequence never restarts), so
-- distinct serials always give distinct batch numbers, and a number of five or more digits never matches
-- one of four digits issued before. The format stays TEST-B<yy>-<nnnn...>; the sandbox identifier rule for
-- batch numbers (kernel 0810, up to 27 characters after TEST-) holds up to the sequence's maximum.
--
-- Everything else in begin_issue is unchanged. Applied as a new migration because applied migrations are
-- checksummed and never edited. CREATE OR REPLACE keeps the privileges set in 0210.

set local role ebmr_owner;

-- The trusted time and the TEST- batch number of a test batch about to be issued (sandbox only,
-- BATCH.ISSUE). Numbers come from a sequence: TEST-B<yy>-<serial>, the serial at least four digits
-- and never shortened.
create or replace function recipe.begin_issue(p_batch uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor  jsonb := recipe.execution_actor('Issuing a test batch');
  v_number text;
  v_serial text;
  v_now    bigint;
begin
  perform recipe.require_command_permission('ISSUE', null);
  if exists (select 1 from recipe.batch_execution where id = p_batch) then
    raise exception using errcode = 'P0001', message = 'A test batch with this id exists already (DI-34). [EBMR-EXE-011]';
  end if;
  select c.batch_number into v_number from recipe.execution_clock c
   where c.xact_id = pg_current_xact_id() and c.backend_pid = pg_backend_pid() and c.batch_id = p_batch;
  if v_number is null then
    v_serial := nextval('recipe.test_batch_number_seq')::text;
    v_number := format('TEST-B%s-%s', to_char(clock_timestamp() at time zone iam.policy_text('site.zone'), 'YY'),
                       lpad(v_serial, greatest(4, length(v_serial)), '0'));
  end if;
  v_now := recipe.execution_marker(p_batch, v_number);
  return jsonb_build_object('now_us', v_now::text, 'batch_number', v_number, 'site_code', v_actor ->> 'site_code', 'room_code', v_actor ->> 'room_code');
end
$$;

reset role;
