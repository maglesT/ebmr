-- Tablets edition, module C3: what the manual-weighing gate records with a test run's hand-keyed weighing holds no
-- real-format batch or lot number (Phase 2 exit follow-up F12, the lane's round-12 verification, gap G1; DI-05, DI-30,
-- INV-18; ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- What was wrong. tab.manual_weighing_basis is part of a test run's record: one row per hand-keyed weighing, keyed to the
-- run's row (foreign key to recipe.execution_command), written by the gate (tab.manual_weighing_check, 0340, 0350) with
-- the status and reason of every scale of the room. A reason copies texts from outside the database's own vocabulary:
-- the gateway heartbeat's not-ready text, the serial a scale answers with and the serial registered for it
-- (tab.manual_path_verdict, 0350), the server's detail of an unreachable gateway API, and the code of a refused
-- reading's alarm. Recipe-core 0344 put the deferred constraint trigger zzz_sandbox_free_text on every other table keyed
-- to a run's row (the twelve of 0344, recipe.execution_command among them) and none on this one; docs/design/sandbox.md
-- section 7 filed it as outside every run's record and said no entry quotes a reading's serial. Over HTTP, with no
-- database credentials, the lane's round-12 verification had a fake gateway report both DISP-1 scales OFFLINE with the
-- not-ready text 'drum L2409-0017 left on the pan' for the gate's window (P1a), or ONLINE answering with serial
-- L2409-0017 (P1b); operator1's honest hand-keyed weighing was then recorded, and the run's basis rows held
-- L2409-0017 for both scales.
--
-- What changed. The deferred constraint trigger zzz_sandbox_free_text on tab.manual_weighing_basis (after insert; the
-- table is insert-only, kernel register_audited_table) runs tab.weighing_basis_free_text_check at commit, after every
-- other check of the weighing, in an installation that is not GMP: the room code and every string and member name of
-- the scales, at any depth, are read with the kernel's identifier rule (kernel 1030, 1040, as recipe-core 0344 to 0348
-- read the record: sandbox.identifier_words, sandbox.real_identifier_parts through recipe.unbound_real_identifier). A
-- word the rule reads as a real batch or lot number is refused (EBMR-EXE-147: nothing of the weighing is saved) unless
-- the run's record has it from a bound source (recipe.run_bound_words: the run's MBR, batch number, site and room, the
-- engine's registers, its state's records and compounds, sql 0348) or it is the room of the weighing, or one of the
-- system's own error codes that a function of this installation raises: a word EBMR-<area>-<three digits> that the body
-- of a function owned by the schema owner names (tab.named_system_codes). That last source is the code of a refused
-- reading's alarm the gate quotes ('the server refused a reading of gateway TEST-GW-01 (EBMR-DEV-048) ...'); the alarm
-- code itself is whatever the application role passed to tab.record_gateway_refusal, so it is bound to the installed
-- code, not to the alarm table, and a code no function names (EBMR-LOT-017) is refused like any other word. Device and
-- gateway codes are TEST- labels in a sandbox (kernel 0920, DEVICE_LABEL) and are not read as real; statuses are the
-- kernel's words. A refusal names the column and the JSON path, never the word (recipe.word_path).
--
-- What an honest test run sees. The gate's own reasons ('the site gateway reports it OFFLINE', 'no heartbeat from the
-- site gateway in the last 10 seconds', '<device> is BLOCKED in the device registry', a refused reading's code) pass.
-- A reason quoting a gateway's not-ready text, a serial or the API's detail that holds a word the rule reads as a real
-- batch or lot number is refused in a sandbox, also when the word is an honest instrument serial of letters and digits
-- (SIM-0001: the rule cannot tell it from a lot number by its form). The trainee then keys the weight once the scale is
-- reported offline for another reason (the device blocked in the register, the gateway silent), or once the serial
-- matches. A GMP installation records every reason as before. Decision F12.10 records this default.
--
-- The source of those texts is not refused (the other option the verification named): a heartbeat's serial is the
-- instrument's own, an honest one of letters and digits would stop a sandbox's scales from reporting at all, and none
-- of them is part of a test run's record until the gate copies it here, where it is now read.
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger function is SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed
-- and never edited.

set local role ebmr_owner;

-- DI-05 (header): the words of value p_value, upper-cased, that are error codes of the system named by a function of
-- this installation: EBMR-<area>-<three digits> appearing in the body of a function the schema owner owns.
create function tab.named_system_codes(p_value jsonb) returns text[]
language sql stable security definer set search_path = pg_catalog, sandbox, pg_temp as $$
  select coalesce(array_agg(distinct w.w), '{}')
    from (select sandbox.ascii_upper(x) as w from sandbox.identifier_words(p_value) x) w
   where w.w ~ '^EBMR-[A-Z]{2,5}-[0-9]{3}$'
     and exists (select 1 from pg_proc p where p.proowner = 'ebmr_owner'::regrole and strpos(p.prosrc, w.w) > 0)
$$;

-- DI-05, DI-30 (header): constraint trigger of tab.manual_weighing_basis. Outside a GMP installation, refuses a basis
-- whose room code or scales hold a word read as a real batch or lot number that the run's record does not have from a
-- bound source. EBMR-EXE-147. Raises; returns nothing.
create function tab.weighing_basis_free_text_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, sandbox, kernel, pg_temp as $$
declare
  v_value  jsonb;
  v_number text;
  v_bound  text[];
  v_word   text;
  v_column text;
begin
  if kernel.installation_kind() is not distinct from 'GMP' then
    return null;
  end if;
  v_value := jsonb_build_object('room_code', new.room_code, 'scales', new.scales);
  if not exists (select 1 from sandbox.identifier_words(v_value) w
                  where not exists (select 1 from recipe.engine_name n where n.name = sandbox.ascii_upper(w))) then
    return null;
  end if;
  select b.batch_number into v_number from recipe.batch_execution b where b.id = new.batch_id;
  v_bound := recipe.run_bound_words(new.batch_id, v_value)
             || case when new.room_code is not null then recipe.source_words(new.room_code) else '{}'::text[] end
             || tab.named_system_codes(v_value);
  foreach v_column in array array['room_code', 'scales'] loop
    v_word := recipe.unbound_real_identifier(v_value -> v_column, v_bound, v_number);
    if v_word is not null then
      raise exception using errcode = 'P0001',
        message = format('This manual_weighing_basis row of test batch %s cannot be recorded: %s holds, at %s, a word of the form of a batch or lot number that is not a test one. A test run names a batch, lot or container only by a TEST- identifier (for example TEST-L24-0001), or describes it in words, also where the record copies a scale''s reason from the site gateway, a serial or the gateway API''s answer, so a real GMP identifier is never reused (DI-05, DI-30). Key the weight once the scale is reported offline for another reason. [EBMR-EXE-147]',
                         coalesce(new.batch_id::text, 'unknown'), v_column, recipe.word_path(v_value -> v_column, v_word, v_bound, v_number));
    end if;
  end loop;
  return null;
end
$$;

create constraint trigger zzz_sandbox_free_text after insert on tab.manual_weighing_basis deferrable initially deferred
  for each row execute function tab.weighing_basis_free_text_check();

revoke all on function tab.named_system_codes(jsonb), tab.weighing_basis_free_text_check() from public;

reset role;
