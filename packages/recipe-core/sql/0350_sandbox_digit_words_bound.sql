-- Recipe core, execution store (module C3): a test run's record holds a word that holds a digit and a character outside
-- the identifier alphabet only as its MBR holds it, and a refusal of such a word says what to write instead (Phase 2 exit
-- follow-up F12, the verification of the lane's round 7, lane round 3, closed for the class by kernel 1120, decision
-- F12.14; DI-05, DI-30, INV-18; ADR 0012: the rules hold when the application's own database credentials are used
-- directly).
--
-- What changes. Kernel 1120 reads, in a sandbox, a word that holds a digit and a character other than an ASCII letter,
-- an ASCII digit, '/', '.' or '-' (sandbox.non_ascii_digit_words) whole, as a real identifier, through
-- sandbox.identifier_words and sandbox.real_identifier_parts, so 0344 to 0349's triggers on a test run's record and its
-- audit chains refuse it with no change (EBMR-EXE-147). Three things belong to this module:
--   1. recipe.content_bound_words (0348's, replaced): the words of 0346 to 0349 and, when the value read holds such a
--      word that none of them binds, the words of that kind the run's MBR and header hold, whole, as the reading reads
--      them (sandbox.identifier_words over every string and member name of the imported content and the header). The
--      server copies the MBR's names verbatim into a step's, stage's or exception's signed content (a step named
--      'Dry at 60°C', a Hindi stage name with Devanagari digits), so an honest run of such an MBR passes; the MBR is the
--      approved, hash-bound definition the run has its words from (decision F12.2), as for every other bound word. A word
--      written otherwise than the MBR holds it is not bound: the run's own code DISP-1 written with U+2010 HYPHEN, which
--      kernel 1050 read as the run's word, is refused in a test run from here on (decision F12.14; the honest screens
--      send the codes as the server gives them, in ASCII, and the MBR templates hold none).
--   2. recipe.unbound_real_identifier (0346's, replaced): the words are taken with those of the identifier alphabet first,
--      then those of kernel 1120 (each group in the order 0346 took them), so a refusal of a real-format identifier keeps
--      0346's message when a text holds both.
--   3. recipe.execution_free_text_check and recipe.audit_free_text_check (0346's, replaced): a refusal of a word of
--      kernel 1120 says so: the member's path (recipe.word_path, which never repeats the word: a member name holding an
--      unbound one is written <member>), that a word with a digit in it is written in ASCII only in a test run, and to
--      write a number with the digits 0 to 9 and put a space between a number and a word of another script or a sign.
--      A refusal of a real-format identifier keeps 0346's message. Same code, EBMR-EXE-147; the server's guidance for it
--      says the same (apps/tablets-server guidance.ts).
-- tab.manual_weighing_basis (tablets 0640) reads through recipe.unbound_real_identifier and recipe.run_bound_words and so
-- refuses such a word too, with 0640's message: its texts are the site gateway's, not a person's, and printable ASCII
-- (tablets 0250: a raw line is ^[ -~]{1,128}$).
-- Stricter only, never weaker: every word refused before is refused now; the words item 1 binds are whole words of the
-- run's own MBR and header, which kernel 1120 alone would refuse and which nothing refused before it.
--
-- Corrections of earlier claims (applied migrations are never edited): kernel 1050's header and its server test list the
-- run's own words written with a hyphen look-alike among the honest text a test run records (read with the look-alikes,
-- they are the run's words, 0349). From here on a word with a digit and a character outside the identifier alphabet is
-- held whole: the record holds it only as the MBR or the header holds it. 0349's "bound words can only grow" still
-- holds: this migration adds bound words and refuses a new kind of word.
--
-- Replaced functions keep their signature, owner (ebmr_owner), SECURITY DEFINER where they had it and privileges (none
-- for the application roles); every function pins its search_path with pg_temp last. Applied as a new migration because
-- applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05, DI-30 (0346's header, item 1; 0347; 0348; header, item 1): what the record of a test run of MBR content
-- p_content, whose header p_header lists its product, family code, version, batch number, site and room, and whose state
-- is p_state, may hold from a bound source, for the words of value p_value, upper-cased: 0348's words, and when p_value
-- holds a word of kernel 1120 (a digit and a character outside the identifier alphabet) that none of them binds, the
-- words of that kind the MBR and the header hold.
create or replace function recipe.content_bound_words(p_content jsonb, p_header jsonb, p_state jsonb, p_value jsonb) returns text[]
language plpgsql stable set search_path = pg_catalog, recipe, sandbox, pg_temp as $$
declare
  v_source jsonb := jsonb_build_array(p_content) || case when jsonb_typeof(p_header) = 'array' then p_header else '[]'::jsonb end;
  v_held   text[] := recipe.state_compound_ids(p_state);
  v_words  text[] := array(select sandbox.ascii_upper(w) from sandbox.identifier_words(p_value) w);
  v_tree   jsonb;
  v_out    text[];
begin
  v_out := recipe.source_words(v_source::text) || array(select n.name from recipe.engine_name n) || recipe.state_record_ids(p_state) || v_held;
  if exists (select 1 from unnest(v_words) w where w ~ '(^|/)E[0-9]+(/|$)') then
    v_out := v_out || array(select 'E' || g from generate_series(1, recipe.flow_edge_count(p_content)) g);
  end if;
  -- Kernel 1120 (header, item 1): such a word is bound only as the MBR or the header holds it, whole.
  if exists (select 1 from unnest(v_words) w where w !~ '^[A-Z0-9/.-]+$' and not (w = any (v_out))) then
    v_out := v_out || array(select sandbox.ascii_upper(w) from sandbox.identifier_words(v_source) w where w !~ '^[A-Za-z0-9/.-]+$');
  end if;
  if exists (select 1 from unnest(v_words) w where strpos(w, '/') > 0 and not (w = any (v_out))) then
    v_tree := recipe.flow_tree(p_content) -> 'ids';
    v_out := v_out
             || array(select sandbox.ascii_upper(w) from sandbox.identifier_words(v_source) w where strpos(w, '/') > 0)
             || array(select sandbox.ascii_upper(w)
                        from jsonb_object_keys(case when jsonb_typeof(v_tree) = 'object' then v_tree else '{}'::jsonb end) k
                       cross join lateral sandbox.identifier_words(k) w)
             || recipe.frame_fragments(p_content)
             || array(select sandbox.ascii_upper(w) from unnest(v_held) h cross join lateral sandbox.identifier_words(h) w);
  end if;
  return v_out;
end
$$;

-- DI-05 (0346's header, item 1; header, item 2): the first word of value p_value that the identifier rule reads as a
-- real batch or lot number (kernel 1030 to 1120) and that is not bound (recipe.run_word_bound), the words of the
-- identifier alphabet first; NULL when there is none.
create or replace function recipe.unbound_real_identifier(p_value jsonb, p_bound text[], p_batch_number text) returns text
language plpgsql stable set search_path = pg_catalog, recipe, sandbox, pg_temp as $$
declare
  w text;
  p text;
begin
  for w in select x from sandbox.identifier_words(p_value) x order by x !~ '^[A-Za-z0-9/.-]+$', x loop
    continue when recipe.run_word_bound(w, p_bound, p_batch_number);
    for p in select y from sandbox.real_identifier_parts(w) y order by 1 loop
      continue when recipe.run_word_bound(p, p_bound, p_batch_number);
      return p;
    end loop;
  end loop;
  return null;
end
$$;

-- DI-05, DI-30: row trigger of the execution store's tables (0346's, replaced; header, item 3). Arguments: the column
-- holding the batch id, then the columns to read. Outside a GMP installation, refuses a row whose named columns hold a
-- word read as a real batch or lot number, or a word with a digit and a character outside the identifier alphabet
-- (kernel 1120), that the run's record does not have from a bound source. EBMR-EXE-147. Raises; returns nothing.
create or replace function recipe.execution_free_text_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, sandbox, kernel, pg_temp as $$
declare
  v_row    jsonb := to_jsonb(new);
  v_batch  uuid;
  v_number text;
  v_value  jsonb := '{}'::jsonb;
  v_bound  text[];
  v_word   text;
  i        integer;
begin
  if kernel.installation_kind() is not distinct from 'GMP' then
    return null;
  end if;
  v_batch := (v_row ->> tg_argv[0])::uuid;
  for i in 1 .. tg_nargs - 1 loop
    v_value := v_value || jsonb_build_object(tg_argv[i], v_row -> tg_argv[i]);
  end loop;
  -- Most rows hold no word the rule could read other than the names of the engine's registers: nothing more to read.
  if not exists (select 1 from sandbox.identifier_words(v_value) w
                  where not exists (select 1 from recipe.engine_name n where n.name = sandbox.ascii_upper(w))) then
    return null;
  end if;
  select b.batch_number into v_number from recipe.batch_execution b where b.id = v_batch;
  v_bound := recipe.run_bound_words(v_batch, v_value)
             || case when jsonb_typeof(v_row -> 'room_code') = 'string' then recipe.source_words(v_row ->> 'room_code') else '{}'::text[] end;
  for i in 1 .. tg_nargs - 1 loop
    v_word := recipe.unbound_real_identifier(v_row -> tg_argv[i], v_bound, v_number);
    if v_word ~ '^[A-Za-z0-9/.-]+$' then
      raise exception using errcode = 'P0001',
        message = format('This %s row of test batch %s cannot be recorded: %s holds, at %s, a word of the form of a batch or lot number that is not a test one. A test run names a batch, lot or container only by a TEST- identifier (for example TEST-L24-0001), or describes it in words, whatever member holds it, so a real GMP identifier is never reused (DI-05, DI-30). [EBMR-EXE-147]',
                         tg_table_name, coalesce(v_batch::text, 'unknown'), tg_argv[i], recipe.word_path(v_row -> tg_argv[i], v_word, v_bound, v_number));
    elsif v_word is not null then
      raise exception using errcode = 'P0001',
        message = format('This %s row of test batch %s cannot be recorded: %s holds, at %s, a word that holds a digit and a character other than an ASCII letter, an ASCII digit, ''/'', ''.'' or ''-''. In a test run a word with a digit in it is written in ASCII only, whatever member holds it, so that no character drawn like a letter or a digit can make it show a real batch, lot or container identifier: write a number with the digits 0 to 9, and put a space between a number and a word of another script or a sign (DI-05, DI-30). [EBMR-EXE-147]',
                         tg_table_name, coalesce(v_batch::text, 'unknown'), tg_argv[i], recipe.word_path(v_row -> tg_argv[i], v_word, v_bound, v_number));
    end if;
  end loop;
  return null;
end
$$;

-- DI-05: an audit entry of a test run's chain, or of a scale reading's chain, names no real batch or lot number, and no
-- word with a digit and a character outside the identifier alphabet (kernel 1120), in what the application can choose
-- (0346's, replaced; header, item 3). EBMR-EXE-147. Raises; returns nothing.
create or replace function recipe.audit_free_text_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, sandbox, kernel, pg_temp as $$
declare
  v_batch  uuid;
  v_number text;
  v_tail   text;
  v_value  jsonb;
  v_bound  text[];
  v_word   text;
begin
  if kernel.installation_kind() is not distinct from 'GMP' then
    return null;
  end if;
  v_batch := recipe.audit_chain_batch(new.chain_key);
  if v_batch is not null then
    v_tail := substr(new.chain_key, strpos(new.chain_key, v_batch::text) + 36);
  elsif starts_with(new.chain_key, 'device_reading:') then
    v_tail := substr(new.chain_key, length('device_reading:') + 1);
  else
    return null;
  end if;
  v_value := jsonb_build_object('chain_key', v_tail, 'reason_code', new.payload -> 'reason_code', 'reason_text', new.payload -> 'reason_text',
                                'actor', jsonb_build_object('legal_name', new.payload -> 'actor' -> 'legal_name'))
             || case when new.action = 'BUSINESS' then jsonb_build_object('body', new.payload -> 'body') else '{}'::jsonb end;
  if not exists (select 1 from sandbox.identifier_words(v_value) w
                  where not exists (select 1 from recipe.engine_name n where n.name = sandbox.ascii_upper(w))) then
    return null;
  end if;
  if v_batch is not null then
    select b.batch_number into v_number from recipe.batch_execution b where b.id = v_batch;
    -- The run's own hashes: the issue's entry names the package and content by their leading characters.
    v_bound := recipe.run_bound_words(v_batch, v_value)
               || array(select sandbox.ascii_upper(x) from sandbox.identifier_words(v_value) x
                         where x ~ '^[0-9a-f]{8,63}$'
                           and exists (select 1 from recipe.batch_execution b
                                        where b.id = v_batch
                                          and (starts_with(b.package_hash, x) or starts_with(b.content_hash, x) or starts_with(b.policy_hash, x)
                                               or starts_with(b.registry_fingerprint, x))));
  else
    v_bound := array(select n.name from recipe.engine_name n) || recipe.session_bound_words(new.payload -> 'actor');
  end if;
  v_word := recipe.unbound_real_identifier(v_value, v_bound, v_number);
  if v_word ~ '^[A-Za-z0-9/.-]+$' then
    raise exception using errcode = 'P0001',
      message = format('This %s entry of audit chain %s%s cannot be recorded: it holds, at %s, a word of the form of a batch or lot number that is not a test one. A test run names a batch, lot or container only by a TEST- identifier (for example TEST-L24-0001), or describes it in words, also in a reason or a business entry of its audit trail (DI-05, DI-30). [EBMR-EXE-147]',
                       lower(new.action), recipe.chain_shown(new.chain_key), case when v_batch is not null then ' of test batch ' || v_batch else '' end,
                       recipe.word_path(v_value, v_word, v_bound, v_number));
  elsif v_word is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s entry of audit chain %s%s cannot be recorded: it holds, at %s, a word that holds a digit and a character other than an ASCII letter, an ASCII digit, ''/'', ''.'' or ''-''. In a test run a word with a digit in it is written in ASCII only, also in a reason or a business entry of its audit trail, so that no character drawn like a letter or a digit can make it show a real batch, lot or container identifier: write a number with the digits 0 to 9, and put a space between a number and a word of another script or a sign (DI-05, DI-30). [EBMR-EXE-147]',
                       lower(new.action), recipe.chain_shown(new.chain_key), case when v_batch is not null then ' of test batch ' || v_batch else '' end,
                       recipe.word_path(v_value, v_word, v_bound, v_number));
  end if;
  return null;
end
$$;

reset role;
