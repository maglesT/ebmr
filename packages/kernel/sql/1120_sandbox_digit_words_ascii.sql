-- Sandbox, training and simulation store (module A4), part 14: in a sandbox a word that holds a digit is plain ASCII
-- (Phase 2 exit follow-up F12, the verification of the lane's round 7, lane round 3, closed for the class with the
-- verification's own structural alternative, decision F12.14; control DI-05, invariant INV-18; ADR 0012: the rules hold
-- when the application's own database credentials are used directly).
--
-- What was wrong. Kernels 1050 to 1110 read a character outside ASCII as the identifier alphabet only when a table lists
-- it: UTS #39 confusables, Unicode names, and two drawing scans of Chromium 141 with the product's sans-serif face at the
-- weights 400, 600 and 700. Every round found characters no table listed. The verification of round 7, with the scan's
-- own data and criterion, found eleven more that the sans-serif face draws as a Latin letter: U+0460 as W and U+A646 as
-- I in bold, U+056A as d, U+104FB as z, U+2AEE as l, and U+04FD, U+13A6, U+1456, U+1D03, U+28B8 and U+A666; and in the
-- monospace face in which the signature dialog shows the exact text that is signed (ui-monospace, Noto Sans Mono,
-- monospace: DejaVu Sans Mono on the E2E machine, which no scan had drawn) U+03D8 as Q, U+053A, U+056A and U+10EB as d,
-- U+0252 as o, U+057F as m, and U+10DC and U+1E9F as 6. Over HTTP the honest server recorded 'Drum of <U+0460>24-0001
-- set aside' (shown as W24-0001) and <U+A646>2409-0017 (shown as I2409-0017) in an exception's description, a hold reason
-- and a business entry three levels down, and qa1 signed a disposition whose justification held <U+10EB>2409-0017
-- (shown as d2409-0017 in the signed text). sandbox.real_identifiers read nothing in any of them. A table closes only
-- what it lists; the next face, weight or font finds more, so the class is closed here by structure, not by glyph.
--
-- What changed (decision F12.14, a default taken under the 3 Oct heading; outside a GMP installation only):
--   1. sandbox.text_words(text): the words of a text, its maximal runs of characters that are neither Unicode
--      White_Space (PropList.txt 18.0.0: U+0009 to U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000 to U+200A, U+2028,
--      U+2029, U+202F, U+205F, U+3000) nor ASCII punctuation other than '/', '.' and '-' (the 29 other printable ASCII
--      characters that are neither letters, digits nor the space). The one definition of a word every check below
--      shares, for every text it reads. Why this boundary: ASCII is the alphabet the identifier formats are written in,
--      and the rule reads an ASCII character as it is coded since kernel 1030 ('|' a separator, O a letter, 0 a digit);
--      a space of any width shows no character. Every other character (a hyphen, full stop or solidus look-alike, the
--      Devanagari danda, an ideographic comma, a character that takes no room, a mark, a bidirectional control) could
--      be drawn as a letter, a digit or one of the identifier's separators in some face, so it is never trusted to end a
--      word: it stays inside the word, where item 2 sees it. A space that shows less than a gap (U+200A, U+2006) or a
--      dash (U+1680) still ends a word as stored, and the readings of kernels 1050 to 1090 still read it as nothing or as
--      '-' (item 3 reads every reading), so the word it splits is read whole there.
--   2. sandbox.non_ascii_digit_words(text[]): the words of the given texts that hold a digit and a character other than
--      an ASCII letter, an ASCII digit, '/', '.' or '-' (trimmed of '/', '.' and '-' at either end, as kernel 1030 trims
--      a word). A word holds a digit when it holds an ASCII digit or a character sandbox.look_alike reads as a string
--      with a digit: every decimal digit of Unicode 18.0.0 (general category Nd, kernel 1050), the numeral digits kernel
--      1060 reads by name, the letters and signs UTS #39 and the drawing scans of kernels 1100 and 1110 read as a digit
--      (Cyrillic З, Э and б, Armenian Յ and Ց, the Odia visarga, N'Ko CHA, Ol Chiki AT), the vulgar fractions. An
--      invisible character, a bidirectional control or mark, a combining or spacing mark, a letter or a digit of another
--      script inside such a word makes it one of them: nothing is removed before the check.
--   3. sandbox.identifier_words(text) is replaced (its signature, owner and privileges kept; the JSON form, which calls
--      it for every string and member name at any depth, follows): for a text that is not printable ASCII read as stored
--      (sandbox.read_as_stored), its words are kernel 1050's (the identifier alphabet's runs in every reading) and also
--      the words of item 2 in the text as stored and in every text sandbox.texts_read gives (as written in NFKC, with its
--      escapes read, as it shows, with its look-alikes read, both, and the arrangements of a text that can display in
--      another order). Round 7's readings stay: they still read the words without a digit (a TEST- prefix, a bound word)
--      and the ASCII that look-alikes, escapes and marks make.
--   4. sandbox.real_identifier_parts(text) is replaced: a word of item 2 is read whole, as a real identifier (it cannot
--      be told from one drawn with a character no table lists). Every other word is read as kernel 1030 reads it.
--      Through sandbox.identifier_words and this function, every guard of the identifier rule refuses such a word in a
--      sandbox, with no change of its own: sandbox.guard_free_text (the kernel's stubs, kernel 1030; the person
--      register's employee references, kernel 1040; tablets 0630; EBMR-SBX-024), recipe-core 0344 to 0349's
--      zzz_sandbox_free_text triggers on a test run's record and its audit chains (recipe.unbound_real_identifier,
--      EBMR-EXE-147), tablets 0640's check of a hand-keyed weighing's basis (EBMR-EXE-147). A person's legal name and
--      login name are person labels, ASCII only after TEST- since kernels 0810 and 0920 (EBMR-SBX-022), and stay so. A
--      word the run has whole from a bound source stays allowed in a test run's record (recipe-core 0350: the MBR's own
--      names, copied verbatim into the signed content).
--   5. sandbox.guard_free_text is replaced (signature, owner, SECURITY DEFINER and privileges kept): a row whose column
--      holds a word of item 2, and no word kernel 1030 reads, is refused with its own message (EBMR-SBX-024): it names
--      the column, never the word, and says to write a number with the digits 0 to 9 and to put a space between a
--      number and a word of another script. A word kernel 1030 reads is named first, with 1030's message, as before.
-- A GMP installation is unchanged: it keeps what was written.
--
-- Honest text that still passes (tested): Hindi prose with ASCII digits apart from its words ('बैच 24 का वज़न 12.5
-- kg'), Tamil, Japanese, Korean and Greek prose with a number apart from its words, an emoji and its variation
-- selector next to a word, a soft hyphen in a long word without digits, TEST- identifiers, dates and quantities in
-- ASCII (2026-10-05, 12.5 kg, 250 mg with a thin or narrow no-break space), the run's own words in ASCII.
-- Refused in a test run from here on although honest (the accepted cost, decision F12.14; the refusal tells the person
-- to write the number with the digits 0 to 9 and a space): a number in digits of another script (Hindi २५), a number
-- joined to a word of another script (२४किलो, 25वां, Korean 3개, Japanese 3本, a date followed by the danda), a sign
-- joined to a number (25°C, ±0.1, an en dash in 2–8, 5µm), a vulgar fraction (½), a keycap emoji, the run's own words
-- written with a hyphen look-alike (DISP‐1 with U+2010, unless the MBR holds it so; the honest screens send the codes as
-- the server gives them, in ASCII), and words holding a letter a table reads as a digit (Russian б, З and Э, Armenian Յ
-- and Ց, the Odia visarga), whether they hold another digit or not. None is needed to write a test run's record in
-- English, Hindi or the outline's regional languages with the digits 0 to 9.
--
-- Corrections of earlier claims (applied migrations are never edited):
--   * Kernels 1100 and 1110 (headers) and decision F12.13 (3) and (6) say a character is read as a letter only when it
--     is drawn closer to it than any two different ASCII letters or digits are to each other (5 and S at 1.41 px), and
--     leave out "a character drawn near a letter but no closer than two letters of the alphabet are to each other". The
--     scans cut at a 95th percentile of at most 1 px, so eleven characters strictly closer than 1.41 px stayed unread
--     (U+0460 at 1.27 px to W in bold, U+A646 at 1.06 px to I); F12.13 (3)'s example U+0492 is at 1.33 px at the regular
--     weight. 1110's "every weight the product draws free text in" left out the monospace face of the signed text.
--     From here on a word with a digit does not depend on any drawing; the tables still read the words without one.
--   * Kernels 1050 and 1090 list among the honest text that passes Hindi prose with Devanagari digits, a number written
--     against a Devanagari word (25वां), a vulgar fraction and the run's own words with a hyphen look-alike, and the tests
--     of 1050 to 1110 used them and Korean 3개 as honest text; in a test run they are refused from here on (above).
--
-- What the rule still cannot see (residual, never weaker than the regulation, which asks that test data never be
-- confused with GMP data, not that every way of drawing an identifier be read): an identifier of digits and separators
-- only; one broken by a space or an ASCII punctuation mark (L 2409 0017, L#2409-0017), also where the mark is drawn
-- like a letter ('|2409-0017': the rule reads ASCII as it is coded, '|' a separator); one whose every digit is drawn
-- with a character no table reads as a digit (a word with no digit is not held to ASCII); one spelled out in words,
-- drawn in an image or a signature's
-- picture; a word equal to an allowed name (decision F12.10 (4)) or that the run has whole from a bound source.
--
-- New functions are owned by ebmr_owner, pin their search_path with pg_temp last and may be executed by the application
-- role, as kernel 1030's reading functions; replaced ones keep their signature, owner and privileges. Applied as a new
-- migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05 (header, item 1): the words of text p_text: its maximal runs of characters that are neither Unicode White_Space
-- nor ASCII punctuation other than '/', '.' and '-'. In order, with repeats.
create function sandbox.text_words(p_text text) returns setof text
language sql immutable strict parallel safe set search_path = pg_catalog, pg_temp as $$
  select w
    from regexp_split_to_table(p_text,
           '[\u0009-\u000d \u0085   -     　!-,:-@[-`{-~]+') w
   where w <> ''
$$;

-- DI-05 (header, item 2): whether word p_word holds a digit: an ASCII digit, or a character sandbox.look_alike reads as a
-- string with a digit.
create function sandbox.holds_digit(p_word text) returns boolean
language sql stable strict parallel safe set search_path = pg_catalog, sandbox, pg_temp as $$
  select p_word ~ '[0-9]'
      or exists (select 1
                   from regexp_split_to_table(regexp_replace(p_word, '[\u0001-\u007f]+', '', 'g'), '') c
                   join sandbox.look_alike l on l.code_point = ascii(c)
                  where l.reads_as ~ '[0-9]')
$$;

-- DI-05 (header, item 2): the words (sandbox.text_words) of texts p_texts that hold a digit and a character other than an
-- ASCII letter, an ASCII digit, '/', '.' or '-', trimmed of '/', '.' and '-' at either end. Distinct.
create function sandbox.non_ascii_digit_words(p_texts text[]) returns setof text
language sql stable strict parallel safe set search_path = pg_catalog, sandbox, pg_temp as $$
  select distinct btrim(w, '/.-')
    from unnest(p_texts) t (t)
   cross join lateral sandbox.text_words(t.t) w
   where w !~ '^[A-Za-z0-9/.-]+$'
     and sandbox.holds_digit(w)
$$;

-- DI-05: the words of text p_text that could name an identifier (1030's header, item 1, read in every text of
-- sandbox.texts_read, kernel 1050) and, for a text that is not printable ASCII read as stored, the words of
-- sandbox.non_ascii_digit_words in the text as stored and in every text sandbox.texts_read gives (header, item 3).
-- Distinct.
create or replace function sandbox.identifier_words(p_text text) returns setof text
language sql stable strict parallel safe set search_path = pg_catalog, sandbox, pg_temp as $$
  with f (stored, texts) as (
    select sandbox.read_as_stored(p_text), case when sandbox.read_as_stored(p_text) then array[p_text] else sandbox.texts_read(p_text) end
  )
  select x.w
    from f
   cross join lateral unnest(f.texts) t (t)
   cross join lateral regexp_matches(t.t, '[A-Za-z0-9/.-]*[A-Za-z][A-Za-z0-9/.-]*', 'g') m
   cross join lateral (select btrim(m[1], '/.-') as w) x
   where x.w ~ '[0-9]'
     and x.w !~* '^[0-9]+(st|nd|rd|th)$'
     and x.w !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  union
  select w
    from f
   cross join lateral sandbox.non_ascii_digit_words(array[p_text] || f.texts) w
   where not f.stored
$$;

-- DI-05: what of word p_word (one of sandbox.identifier_words) the rule reads as a real batch or lot number in a sandbox
-- (kernel 1030's header, item 1): a word of sandbox.non_ascii_digit_words whole (header, item 4); else the word, or for
-- a word too long to be an identifier every run of its parts between separators that holds a letter and a digit and is
-- read so. Empty when nothing is.
create or replace function sandbox.real_identifier_parts(p_word text) returns setof text
language plpgsql stable security definer set search_path = pg_catalog, sandbox, pg_temp as $$
declare
  v_seg text[] := '{}';
  v_sep text[] := '{}';
  m     text[];
  v_win text;
  i     integer;
  j     integer;
begin
  if p_word is null then
    return;
  end if;
  -- Kernel 1120: a word that holds a digit and a character outside the identifier alphabet is read whole.
  if p_word !~ '^[A-Za-z0-9/.-]*$' then
    if sandbox.holds_digit(p_word) then
      return next p_word;
    end if;
    return;
  end if;
  if sandbox.has_identifier_form(p_word) then
    if sandbox.is_real_identifier(p_word) then
      return next p_word;
    end if;
    return;
  end if;
  for m in select regexp_matches(p_word, '([A-Za-z0-9]+)([/.-]*)', 'g') loop
    v_seg := v_seg || m[1];
    v_sep := v_sep || m[2];
  end loop;
  for i in 1 .. coalesce(cardinality(v_seg), 0) loop
    v_win := '';
    for j in i .. cardinality(v_seg) loop
      v_win := v_win || v_seg[j];
      exit when not sandbox.has_identifier_form(v_win);
      if v_win ~ '[A-Za-z]' and v_win ~ '[0-9]' and v_win !~* '^[0-9]+(st|nd|rd|th)$' and sandbox.is_real_identifier(v_win) then
        return next v_win;
      end if;
      v_win := v_win || v_sep[j];
    end loop;
  end loop;
end
$$;

-- DI-05, INV-18: row trigger for tables whose free text a test, training or simulation run writes (kernel 1030, item 2;
-- header, item 5). Arguments: one or more column names (text, text[] or jsonb). Outside a GMP installation, refuses a
-- row whose named columns hold a word the identifier rule reads as a real batch or lot number, or a word that holds a
-- digit and a character other than an ASCII letter, an ASCII digit, '/', '.' or '-'. EBMR-SBX-024 (EBMR-SBX-023 for a
-- misconfigured trigger). The refusal names the column, never the word.
create or replace function sandbox.guard_free_text() returns trigger
language plpgsql security definer set search_path = pg_catalog, sandbox, kernel, pg_temp as $$
declare
  v_row  jsonb := to_jsonb(new);
  v_word text;
  i      integer;
begin
  if tg_nargs < 1 then
    raise exception using errcode = 'P0001',
      message = format('Trigger %s on %s.%s must name at least one column (DI-05). [EBMR-SBX-023]', tg_name, tg_table_schema, tg_table_name);
  end if;
  for i in 0 .. tg_nargs - 1 loop
    if not (v_row ? tg_argv[i]) then
      raise exception using errcode = 'P0001',
        message = format('Trigger %s names column %s, which %s.%s does not have (DI-05). [EBMR-SBX-023]', tg_name, tg_argv[i], tg_table_schema, tg_table_name);
    end if;
  end loop;
  if kernel.installation_kind() is not distinct from 'GMP' then
    return new;
  end if;
  for i in 0 .. tg_nargs - 1 loop
    -- A word of the identifier alphabet the rule reads is named first (kernel 1030's message), then a word of 1120.
    select p into v_word from sandbox.real_identifiers(v_row -> tg_argv[i]) p order by p !~ '^[A-Za-z0-9/.-]+$', p limit 1;
    if v_word ~ '^[A-Za-z0-9/.-]+$' then
      raise exception using errcode = 'P0001',
        message = format('%s.%s %s holds a word of the form of a batch or lot number that is not a test one: in the sandbox a text names a batch, lot or container only by a TEST- identifier (for example TEST-L24-0001), or describes it in words, so a real GMP identifier is never reused (DI-05, INV-18). [EBMR-SBX-024]',
                         tg_table_schema, tg_table_name, tg_argv[i]);
    elsif v_word is not null then
      raise exception using errcode = 'P0001',
        message = format('%s.%s %s holds a word that holds a digit and a character other than an ASCII letter, an ASCII digit, ''/'', ''.'' or ''-'': in the sandbox a word with a digit in it is written in ASCII only, so that no character drawn like a letter or a digit can make it show a real batch or lot number. Write a number with the digits 0 to 9, and put a space between a number and a word of another script or a sign (DI-05, INV-18). [EBMR-SBX-024]',
                         tg_table_schema, tg_table_name, tg_argv[i]);
    end if;
  end loop;
  return new;
end
$$;

revoke all on function sandbox.text_words(text), sandbox.holds_digit(text), sandbox.non_ascii_digit_words(text[]) from public;
grant execute on function sandbox.text_words(text), sandbox.holds_digit(text), sandbox.non_ascii_digit_words(text[]) to ebmr_app;

reset role;
