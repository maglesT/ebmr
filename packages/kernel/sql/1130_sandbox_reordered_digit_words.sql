-- Sandbox, training and simulation store (module A4), part 15: a text that can display in another order is read in every
-- arrangement of its runs, the runs of characters outside ASCII included, so a word that holds a digit is plain ASCII also
-- as a reordered line shows it (Phase 2 exit follow-up F12, the verification of the lane's round 8, lane round 2,
-- decision F12.15; control DI-05, invariant INV-18; ADR 0012: the rules hold when the application's own database
-- credentials are used directly).
--
-- What was wrong. Kernel 1120 holds a word that holds a digit to ASCII in the text as stored and in every reading of
-- round 7, the arrangements of a text that can display in another order included (its header, item 3). That arrangement
-- (sandbox.rearranged_words, kernel 1050, item 4) joins only the runs of ASCII letters of a text's forms to its runs of
-- digits: a letter outside ASCII that no table reads is in no run of it, so kernel 1120 never saw the word such a line
-- displays. A right-to-left mark or a right-to-left letter between that letter and a space reorders the line: stored
-- 'बैच <U+0460><U+200F> 24-0001 मिला' is drawn by Chromium 141 (the E2E browser) as 'बैच Ѡ24-0001  मिला' (the space is
-- moved after the digits; the verification measured the right edge of the omega and the left edge of the 2 at the same
-- pixel), <U+A646><U+200F> 2409-0017 as I2409-0017, and with U+05D0 HEBREW LETTER ALEF instead of the mark as
-- 'Ѡ24-0001 א'.
-- sandbox.real_identifiers read nothing in these texts with U+0460, U+A646, U+10EB, U+03D8 or U+056A (the ASCII 'L'
-- U+200F ' 2409-0017' was read). In a sandbox the person register kept an employee reference '<U+0460><U+05D0> 24-0001'
-- (sandbox.guard_free_text), and over HTTP the honest server kept supervisor1's hold reasons 'बैच <probe> मिला' and a
-- business entry with the probe three levels down in its details; the exception descriptions holding them were refused
-- only because kernel 1050's arrangement read the ASCII words of the event's title joined to the digits.
--
-- What changed (decision F12.15, a default taken under the 3 Oct heading; outside a GMP installation only):
--   1. sandbox.rearranged_words(text[]) is replaced (its signature, owner, privileges and IMMUTABLE kept): for a text one
--      of whose forms holds a character of sandbox.reordering_class (kernel 1050: bidirectional classes R, AL and AN, the
--      embedding, override and isolate controls, the direction marks), each run of ASCII letters of every form (kernel
--      1050, kept) and also each run of characters other than the ASCII digits inside a word of every form (the words of
--      sandbox.text_words, kernel 1120's one definition of a word) that holds a character outside ASCII is joined to each
--      run of ASCII digits of every form (the form with its look-alikes read gives every decimal digit, of any script, as
--      an ASCII one). What lies between the run and the digits in the stored text does not matter.
--   2. Nothing else is replaced. Kernel 1050's sandbox.texts_read lists these words in its one text more; kernel 1120's
--      sandbox.identifier_words reads the words of item 2 of its header in every text sandbox.texts_read gives, so a
--      joined word (a digit and a character outside ASCII) is read whole and sandbox.real_identifier_parts reads it as a
--      real identifier; every guard of the rule refuses it in a sandbox with no change of its own: sandbox.guard_free_text
--      (the kernel's stubs, the person register's employee references, tablets 0630; EBMR-SBX-024, with kernel 1120's
--      message, which names the column and never the word), recipe-core 0344 to 0350's triggers on a test run's record
--      and its audit chains (EBMR-EXE-147) and tablets 0640. sandbox.text_holds reads the same texts, so a refusal's path
--      (recipe.word_path) names the member that holds the text.
-- Why every run is joined to every run of digits (the verification's option (a)) and not only the words that White_Space
-- alone parts (its option (b)): the bidirectional algorithm moves neutral characters too (by its rule for neutrals
-- between a right-to-left character and a European number, UAX #9 N1, a comma and a space there take the right-to-left
-- direction, so 'Ѡ' U+200F ', 24-0001' is ordered as 'Ѡ24-0001 ,'), embeddings and isolates nest, and where a line breaks
-- depends on the screen; the display order is not computed, so every arrangement is read, the strict side, as kernel
-- 1050 decided for the runs of ASCII letters.
--
-- In effect, in a sandbox, a text that can display in another order is refused when it holds a digit and a word with a
-- character outside ASCII, whatever parts them. Refused from here on although honest (the accepted cost, decision
-- F12.15): Urdu, Arabic or Hebrew prose with a number in digits (most of it was refused since kernel 1050 through the
-- look-alikes of its letters, decision F12.11; none is a language of the outline), and any text with a direction mark,
-- an embedding, override or isolate control and a number (Hindi prose with a stray U+200F, a pasted text that carries
-- U+200E). The server's guidance for EBMR-EXE-147 tells the person to write the number in words in such a text. Still
-- passes (tested): such prose without a number, and every text without such a character (Hindi, Tamil, Japanese, Korean
-- and Greek prose with ASCII digits apart from its words, TEST- identifiers, dates and quantities in ASCII); the product
-- itself writes none of these characters (no source of the server or the web app composes one). A GMP installation is
-- unchanged: it keeps what was written.
--
-- Corrections of earlier claims (applied migrations are never edited):
--   * Kernel 1120's header (item 3) and decision F12.14 (1) say a word that holds a digit is held to ASCII also in "the
--     arrangements of a text that can display in another order". Kernel 1120 read the words of its item 2 in the text of
--     arrangements kernel 1050 builds, but that text held only runs of ASCII letters joined to digits, so no word with a
--     character outside ASCII was ever in it. It holds from here on.
--   * Kernel 1050's header (item 4) says such a text is read with "each run of letters joined to each run of digits": the
--     letters were the runs of ASCII letters of its forms (a letter the look-alike table does not read was in none).
--   * Decision F12.14 (7) leaves unread "one broken by a space or by an ASCII punctuation mark": that holds only for a text
--     that displays in the order it is stored; in a text that can display in another order every run is joined.
--   * Recipe-core 0349's header says the arrangements of a text "are not words a source gives ... so a source never binds
--     them". That still holds for recipe.source_words. Recipe-core 0350 (item 1) takes the run's bound words of kernel
--     1120's kind from the MBR and the header through sandbox.identifier_words, so from here on an MBR text that can
--     display in another order binds its own arrangements of such words, which a record copying that text verbatim holds;
--     a crafted MBR could bind any word before (decision F12.8 (6), an imported package), so nothing is weaker, and
--     nothing refused before is allowed now: these words were not read at all before.
--
-- What the rule still cannot see (residual, never weaker than the regulation, which asks that test data never be
-- confused with GMP data, not that every way of drawing an identifier be read): kernel 1120's residual (decision F12.14
-- (7)) as corrected above; and each text is read on its own: what two texts a screen draws in one line show together
-- (a reason that ends in a letter and a right-to-left mark beside a field that begins with digits) is not read; the
-- product's screens set no paragraph direction (every paragraph is left to right) and a text with none of these
-- characters displays in the order it is stored.
--
-- Cost of the reading: the arrangement is quadratic in the runs of one text, as kernel 1050's was (a text of 2293
-- characters with 400 distinct runs of letters and of digits and a mark gives 160,400 words, read in under a second on
-- the development machine); only a text that holds a character of the class is arranged.
--
-- The replaced function keeps its owner (ebmr_owner), its search_path pinned with pg_temp last and its privileges
-- (executed by the application role, as kernel 1050's reading functions). Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05 (header, item 1; kernel 1050's header, item 4): the words of a text whose forms are p_forms in every arrangement
-- of its runs, when one of its forms holds a character that can reorder its display: each run of ASCII letters, and each
-- run of characters other than ASCII digits inside a word (sandbox.text_words) that holds a character outside ASCII,
-- joined to each run of ASCII digits. Empty for a text that displays in the order it is stored. Distinct.
create or replace function sandbox.rearranged_words(p_forms text[]) returns setof text
language sql immutable strict parallel safe set search_path = pg_catalog, sandbox, pg_temp as $$
  with f as (select t from unnest(p_forms) t),
       l as (select m[1] as p from f cross join lateral regexp_matches(f.t, '([A-Za-z]+)', 'g') m
             union
             select m[1] from f cross join lateral sandbox.text_words(f.t) w (w) cross join lateral regexp_matches(w.w, '([^0-9]+)', 'g') m
              where m[1] ~ '[^\u0001-\u007f]'),
       d as (select distinct m[1] as p from f cross join lateral regexp_matches(f.t, '([0-9]+)', 'g') m)
  select l.p || d.p
    from l cross join d
   where exists (select 1 from f where f.t ~ sandbox.reordering_class())
$$;

reset role;
