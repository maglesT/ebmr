-- Sandbox, training and simulation store (module A4), part 11: what the E2E browser lays out with no advance hides
-- nothing (Phase 2 exit follow-up F12, the verification of the lane's round 7, lane round 2; control DI-05, invariant
-- INV-18; ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- What was wrong. The verification laid out text as DOM text in Chromium 141 (the browser of the E2E suite) with the
-- product's font stack (ui-kit tokens.css: Noto Sans Variable, then the machine's fonts) and recorded over HTTP, through
-- the honest server, in a test run's exception descriptions, hold reasons and business entries (three levels down):
--   * 'Drum L' U+FFFC '2409-0017 set aside' and 'B' U+FFFC '24-0001': Blink lays out U+FFFC OBJECT REPLACEMENT CHARACTER
--     with no advance and no ink, so the record shows L2409-0017 and B24-0001; kernel.is_blank(U+FFFC) is false, so the
--     reading kept it as a separator, and a sandbox person's employee reference holding it was accepted;
--   * L, a spacing combining mark (general category Mc), 2409-0017: Chromium draws 325 of the 477 spacing marks of
--     Unicode 18.0.0 with no advance after a Latin letter (U+1031 and U+102B, Myanmar vowel signs, drawn before the L;
--     U+0C03 TELUGU SIGN VISARGA on it), so the identifier shows unbroken; kernel 1050 removed the marks of Mn and Me only.
-- Our own scan, the same layout ('L' + c + '2' against 'L2' at 16, 20 and 24 px, every code point from U+0080 to
-- U+10FFFF but the surrogates), found 5708 code points that take no room. All but 339 were already read as nothing (a
-- mark of Mn or Me, or what kernel.is_blank counts as showing nothing, which holds every unassigned one among them). The
-- 339 are the 325 spacing marks and fourteen others: U+FFFC, U+A717 to U+A71A (modifier letters), U+A8FA DEVANAGARI
-- CARET, U+1193F, U+11941, U+11A3A, U+11A86 to U+11A89 and U+11D46 (cluster-initial letters and a repha, which join the
-- next letter).
--
-- Correction of earlier claims (applied migrations are never edited):
--   * kernel 1050's header (item 1) reads a text as it shows without "the combining marks (general categories Mn and
--     Me)"; a spacing mark (Mc) belongs to its cluster as they do and is removed too from here on, with the fourteen
--     characters above;
--   * kernel 1070's header (item 5) says U+2006 SIX-PER-EM SPACE is narrower than U+2009 THIN SPACE and that the thin
--     space and the narrow no-break space are a fifth of an em. In Chromium 141 DOM text U+2006 is as wide as U+2009
--     (3, 3 and 4 px at 16, 20 and 24 px) and U+202F NARROW NO-BREAK SPACE is narrower (2, 3 and 3 px). Which spaces are
--     read as no gap is the honest-text default of decision F12.12 (2): U+200A and U+2006 are read as nothing (stricter),
--     U+2009 and U+202F stay gaps because they separate a number from its unit (250 mg); it is not a measure of the
--     screen.
--
-- Why kernel.is_blank is not extended (the verification offered either way). kernel.is_blank is the audit trail's test
-- of a blank reason (kernel 0960). Its class is defined by Unicode properties so that a reason is blank in every
-- renderer, and the execution engine holds the same class (recipe-core guards.ts, BLANK_CODE_POINTS) under a test that
-- compares the two over every code point, so changing it is a new engine version. U+FFFC is a visible symbol (So) in
-- other renderers (a log viewer or another browser draws its box), and a spacing mark is a vowel sign of a word: neither
-- makes a reason blank. The identifier rule reads instead what the E2E browser draws, as a reading only (the stored text
-- is never changed), so the class below is the reading's own and kernel.is_blank stays one definition.
--
-- What changed. sandbox.shown_text (kernel 1050, item 1; replaced by 1070) is replaced: it also removes the characters
-- of sandbox.no_advance_class(), for every user of the reading, which all read through sandbox.text_readings:
-- sandbox.real_identifiers, sandbox.guard_free_text on the kernel's stubs and the person register, recipe-core 0344 to
-- 0349 (the run's bound words and a refusal's path read the same forms, so they stay consistent), tablets 0630 and 0640:
--   * every spacing combining mark of Unicode 18.0.0 (general category Mc, DerivedGeneralCategory.txt 18.0.0: 477), not
--     only the 325 drawn with no advance after a Latin letter: a spacing mark belongs to the cluster of the letter
--     before it, and a text read without it joins only what was on either side. Stricter only: one drawn with an
--     advance, such as U+0903 DEVANAGARI SIGN VISARGA, between an L and digits is read as nothing too; no honest sentence
--     writes a vowel sign after a Latin letter;
--   * the fourteen other characters the scan found laid out with no advance (above).
-- Honest text passes as before (tested): Hindi prose with its vowel signs (spacing marks between Devanagari letters,
-- which the identifier alphabet does not hold) and with a number written against a Devanagari word (25वां), Tamil and
-- Telugu prose with a number, an emoji, a soft hyphen in a long word, TEST- identifiers.
--
-- What still is not read (residual, never weaker than the regulation, which asks that test data never be confused with
-- GMP data and not that every way of drawing an identifier be read): a character that another renderer or another font
-- lays out with no advance (a floor terminal with other fonts may lay out a rare character differently); and decision
-- F12.12 (5) as kernel 1100's header corrects it.
--
-- sandbox.shown_text keeps its signature, owner and privileges. The new function is owned by ebmr_owner, pins its
-- search_path with pg_temp last and may be executed by the application role, as 1050's classes. Applied as a new
-- migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05 (header): the spacing combining marks (Mc) of Unicode 18.0.0 and the characters Chromium 141 lays out with no
-- advance after a Latin letter that no other class of the reading removes, as a regular-expression bracket.
create function sandbox.no_advance_class() returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select '['
         '\u0903\u093b\u093e-\u0940\u0949-\u094c\u094e-\u094f\u0982-\u0983\u09be-\u09c0\u09c7-\u09c8\u09cb-\u09cc\u09d7'
         '\u0a03\u0a3e-\u0a40\u0a83\u0abe-\u0ac0\u0ac9\u0acb-\u0acc\u0b02-\u0b03\u0b3e\u0b40\u0b47-\u0b48\u0b4b-\u0b4c'
         '\u0b57\u0bbe-\u0bbf\u0bc1-\u0bc2\u0bc6-\u0bc8\u0bca-\u0bcc\u0bd7\u0c01-\u0c03\u0c41-\u0c44\u0c82-\u0c83\u0cbe'
         '\u0cc0-\u0cc4\u0cc7-\u0cc8\u0cca-\u0ccb\u0cd5-\u0cd6\u0cf3\u0d02-\u0d03\u0d3e-\u0d40\u0d46-\u0d48\u0d4a-\u0d4c'
         '\u0d57\u0d82-\u0d83\u0dcf-\u0dd1\u0dd8-\u0ddf\u0df2-\u0df3\u0f3e-\u0f3f\u0f7f\u102b-\u102c\u1031\u1038'
         '\u103b-\u103c\u1056-\u1057\u1062-\u1064\u1067-\u106d\u1083-\u1084\u1087-\u108c\u108f\u109a-\u109c\u1715\u1734'
         '\u17b6\u17be-\u17c5\u17c7-\u17c8\u1923-\u1926\u1929-\u192b\u1930-\u1931\u1933-\u1938\u1a19-\u1a1a\u1a55\u1a57'
         '\u1a61\u1a63-\u1a64\u1a6d-\u1a72\u1b04\u1b35\u1b3b\u1b3d-\u1b41\u1b43-\u1b44\u1b82\u1ba1\u1ba6-\u1ba7\u1baa'
         '\u1be7\u1bea-\u1bec\u1bee\u1bf2-\u1bf3\u1c24-\u1c2b\u1c34-\u1c35\u1ce1\u1cf7\u302e-\u302f\ua717-\ua71a'
         '\ua823-\ua824\ua827\ua880-\ua881\ua8b4-\ua8c3\ua8fa\ua952-\ua953\ua983\ua9b4-\ua9b5\ua9ba-\ua9bb\ua9be-\ua9c0'
         '\uaa2f-\uaa30\uaa33-\uaa34\uaa4d\uaa7b\uaa7d\uaaeb\uaaee-\uaaef\uaaf5\uabe3-\uabe4\uabe6-\uabe7\uabe9-\uabea'
         '\uabec\ufffc\U00011000\U00011002\U00011082\U000110b0-\U000110b2\U000110b7-\U000110b8\U0001112c'
         '\U00011145-\U00011146\U00011182\U000111b3-\U000111b5\U000111bf-\U000111c0\U000111ce\U0001122c-\U0001122e'
         '\U00011232-\U00011233\U00011235\U000112e0-\U000112e2\U00011302-\U00011303\U0001133e-\U0001133f'
         '\U00011341-\U00011344\U00011347-\U00011348\U0001134b-\U0001134d\U00011357\U00011362-\U00011363'
         '\U000113b8-\U000113ba\U000113c2\U000113c5\U000113c7-\U000113ca\U000113cc-\U000113cd\U000113cf'
         '\U00011435-\U00011437\U00011440-\U00011441\U00011445\U000114b0-\U000114b2\U000114b9\U000114bb-\U000114be'
         '\U000114c1\U000115af-\U000115b1\U000115b8-\U000115bb\U000115be\U00011630-\U00011632\U0001163b-\U0001163c'
         '\U0001163e\U000116ac\U000116ae-\U000116af\U000116b6\U0001171e\U00011720-\U00011721\U00011726'
         '\U0001182c-\U0001182e\U00011838\U00011930-\U00011935\U00011937-\U00011938\U0001193d\U0001193f-\U00011942'
         '\U000119d1-\U000119d3\U000119dc-\U000119df\U000119e4\U00011a39-\U00011a3a\U00011a57-\U00011a58'
         '\U00011a86-\U00011a89\U00011a97\U00011b61\U00011b65\U00011b67\U00011c2f\U00011c3e\U00011ca9\U00011cb1\U00011cb4'
         '\U00011d46\U00011d8a-\U00011d8e\U00011d93-\U00011d94\U00011d96\U00011ef5-\U00011ef6\U00011f03'
         '\U00011f34-\U00011f35\U00011f3e-\U00011f3f\U00011f41\U0001612a-\U0001612c\U00016f51-\U00016f87'
         '\U00016ff0-\U00016ff1\U0001d165-\U0001d166\U0001d16d-\U0001d172\U0001d250-\U0001d252\U0001d25f'
         '\U0001d280-\U0001d281'
         ']'
$$;

-- DI-05 (header; kernel 1050, item 1; kernel 1070, item 5): text p_text as it shows. Printable ASCII and ASCII white space
-- are returned as they are.
create or replace function sandbox.shown_text(p_text text) returns text
language plpgsql immutable strict parallel safe set search_path = pg_catalog, sandbox, kernel, pg_temp as $$
declare
  v_out text;
  c     text;
begin
  if p_text !~ '[^\u0009-\u000d -~]' then
    return p_text;
  end if;
  v_out := regexp_replace(regexp_replace(normalize(p_text, NFD), sandbox.combining_mark_class(), '', 'g'), sandbox.no_advance_class(), '', 'g');
  for c in select distinct x from regexp_split_to_table(regexp_replace(v_out, '[\u0009-\u000d -~]+', '', 'g'), '') x loop
    -- kernel.is_blank's class (kernel 0960), but for the white space that shows a gap at least as wide as U+2009 THIN
    -- SPACE (Unicode White_Space, PropList.txt 18.0.0, without U+2006 and U+200A: kernel 1070, item 5, as corrected above).
    if kernel.is_blank(c) and c !~ '[\u0009-\u000d \u0085   -  -  -   　]' then
      v_out := replace(v_out, c, '');
    end if;
  end loop;
  return normalize(v_out, NFC);
end
$$;

revoke all on function sandbox.no_advance_class() from public;
grant execute on function sandbox.no_advance_class() to ebmr_app;

reset role;
