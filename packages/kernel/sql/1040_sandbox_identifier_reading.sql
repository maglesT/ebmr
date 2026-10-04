-- Sandbox, training and simulation store (module A4), part 6: the identifier rule read in text as written as well as
-- with its escapes read, and in the person register's names (Phase 2 exit follow-up F12, the lane's round-11
-- verification, needs 2 and 3; control DI-05, invariant INV-18; ADR 0012: the rules hold when the application's own
-- database credentials are used directly).
--
-- What was wrong.
--   * 1030's sandbox.identifier_words read a text only after reading its percent and backslash escapes. Read so, an
--     escape swallows the characters after it: '50%B24-0001' became 50, the character U+00B2 and 4-0001, so the batch
--     number B24-0001 that the text shows was read by nothing; so were 'lot %E2409001 found' (%E2 is U+00E2) and
--     'ref%A24-0001' (%A2 is U+00A2). sandbox.real_identifiers returned nothing for each, and sandbox.guard_free_text
--     (the kernel's stubs, tablets 0630) and recipe-core 0344 (a test run's record) let them through.
--   * In a sandbox the person register's names were held only to the PERSON_LABEL rule (0920: TEST- in front); what
--     follows the prefix was read by nothing. Through the application role the administrator renamed operator1
--     'TEST-Priya L2409-0017' (iam.rename_person); every row, signature and audit entry of the run operator1 then made
--     printed the real-format lot number L2409-0017 in the name (execution_command.actor_legal_name, the signature's
--     printed name, the audit entries' actor), and recipe-core 0344 even allowed a person's name as a bound word in an
--     audit entry.
--
-- What changed.
--   1. sandbox.as_written(text): the text as it shows, in NFKC, with only the escapes that stand for nothing a person
--      reads read as a space (the engine codec's storage escapes %00 and %25, recipe-core engine/codec.ts, which also
--      writes the token marking's keys with %00, and \u0000); every other escape stays as written, its '%' or '\' a
--      separator like any character outside the identifier alphabet.
--   2. sandbox.identifier_words(text) now reads the words of the text as written (1) and the words of the text with
--      every escape read (1030), both: '50%B24-0001' holds B24-0001 as written, '%4C2409-0017' holds L2409-0017 read.
--      The JSON form and sandbox.real_identifiers, which call it, read both through it. Still not read (1030's list):
--      an identifier of digits only, one broken by spaces or written in words, one in digits NFKC does not fold.
--   3. In an installation that is not GMP, sandbox.guard_free_text (1030) on the person register: iam.person.legal_name
--      and .employee_ref, and iam.issued_identifier.identifier (login names): a name, a reference or a login holding a
--      word the rule reads as a real batch or lot number is refused (EBMR-SBX-024), whatever follows the TEST- prefix.
--      'TEST-Priya Nair', 'test-operator-1' and 'TEST-Trainee-01' (a TEST- word) pass; a GMP installation keeps its
--      real names. Rows stored before this migration keep their values; recipe-core 0346 reads a name where a test
--      run's record copies it (a row's actor name, an audit entry's actor, which a signature's challenge of the run
--      writes before the signature, so a run's signature never prints such a name).
--
-- Correction of an earlier claim (applied migrations are never edited): 1030's header says the reading reads a text
-- "with its percent and backslash escapes read"; read only so, an escape hid the identifier written right after it.
--
-- The new function is owned by ebmr_owner, pins its search_path with pg_temp last and is granted to the application role,
-- as 1030's reading functions are; sandbox.identifier_words keeps its signature, owner and privileges. Applied as a new
-- migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05: text p_text as it shows (header, item 1): NFKC, the escapes of U+0000 and of '%' itself (%00, %25, \u0000)
-- a space, every other character as written.
create function sandbox.as_written(p_text text) returns text
language sql immutable strict parallel safe set search_path = pg_catalog, pg_temp as $$
  select regexp_replace(normalize(p_text, NFKC), '%(00|25)|\\[uU]0000', ' ', 'g')
$$;

-- DI-05: the words of text p_text that could name an identifier (1030's header, item 1), read in the text as written
-- and in the text with its escapes read (header, item 2). Distinct.
create or replace function sandbox.identifier_words(p_text text) returns setof text
language sql immutable strict parallel safe set search_path = pg_catalog, sandbox, pg_temp as $$
  select distinct x.w
    from (select sandbox.as_written(p_text) as t
          union all
          select sandbox.escapes_decoded(normalize(p_text, NFKC))) f
   cross join lateral regexp_matches(f.t, '[A-Za-z0-9/.-]*[A-Za-z][A-Za-z0-9/.-]*', 'g') m
   cross join lateral (select btrim(m[1], '/.-') as w) x
   where x.w ~ '[0-9]'
     and x.w !~* '^[0-9]+(st|nd|rd|th)$'
     and x.w !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

revoke all on function sandbox.as_written(text) from public;
grant execute on function sandbox.as_written(text) to ebmr_app;

-- DI-05, INV-18 (header, item 3): the person register's names, references and login names.
create trigger ac_sandbox_free_text before insert or update of legal_name, employee_ref on iam.person
  for each row execute function sandbox.guard_free_text('legal_name', 'employee_ref');
create trigger ac_sandbox_free_text before insert on iam.issued_identifier
  for each row execute function sandbox.guard_free_text('identifier');

reset role;
