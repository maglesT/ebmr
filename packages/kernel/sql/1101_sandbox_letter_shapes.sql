-- Sandbox, training and simulation store (module A4), part 12: letters and digits are read as the E2E browser draws them
-- (Phase 2 exit follow-up F12, the verification of the lane's round 7, lane round 2; control DI-05, invariant INV-18;
-- ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- What was wrong. The verification drew text as DOM text in Chromium 141 (the browser of the E2E suite) with the
-- product's font stack (ui-kit tokens.css) and recorded over HTTP, through the honest server, in a test run's exception
-- descriptions, hold reasons and business entries (three levels down): U+053C ARMENIAN CAPITAL LETTER LIWN followed by
-- 2409-0017, and 'after lot' U+053C '24-0001' (the letter is drawn as L), and U+14AB CANADIAN SYLLABICS MAA followed by
-- 2409-0017 (drawn as L with a dot above, which the reading reads as L since kernel 1050 removes the dot). UTS #39
-- confusables.txt 18.0.0 lists neither, and no other basis of sandbox.look_alike read them.
--
-- Correction of earlier claims (applied migrations are never edited): kernel 1070's header (item 3 and its residual)
-- and decision F12.12 (5) say a character is read when UTS #39, its Unicode name or Chromium 141's drawing makes it a
-- look-alike of the alphabet. The drawing was used for the separators only (dashes and solidi in 1070, full stops in
-- 1080); letters and digits were read by UTS #39 and by name. From here on letters and digits are read by drawing too.
--
-- What changed (sandbox.look_alike, read by every user of the reading through sandbox.look_alikes_read:
-- sandbox.real_identifiers, sandbox.guard_free_text on the kernel's stubs and the person register, recipe-core 0344 to
-- 0349 including the run's bound words and a refusal's path, tablets 0630 and 0640; the stored text is never changed):
--   1. LETTER_SHAPE, 58 rows: a character other than punctuation that Chromium 141 draws as an ASCII letter or digit,
--      alone or with a combining mark, is read as that letter or digit. The data come from a drawing scan: every
--      assigned code point of Unicode 18.0.0 (and the private-use ones of the Basic Multilingual Plane) that the reading
--      did not already read as the alphabet or as nothing, 172,350 characters, was drawn as DOM text at 48 px with the
--      product's font stack and the E2E machine's fonts, on one baseline, and compared with the 62 ASCII letters and
--      digits, alone and with each of 297 combining marks of the blocks that carry the Latin diacritics (U+0300 to
--      U+036F, U+0483 to U+0489, U+1AB0 to U+1AFF, U+1DC0 to U+1DFF, U+20D0 to U+20FF, U+FE20 to U+FE2F). Two drawings
--      are the same when, aligned on the baseline and on the centre of their ink (a search of one pixel either way), 95
--      percent of each one's ink lies within one pixel (a forty-eighth of an em) of the other's. No two different ASCII
--      letters or digits are drawn that close in the product's font (the closest pairs are 5 and S, at 1.41 px, and i
--      and l, at 1.91 px), so the line reads a character as a letter only when it is drawn closer to that letter than
--      any two letters of the alphabet are to each other. Found: U+053C as L, U+14AB and U+18BA as L (with a dot), the
--      Gothic, Old Italic and Tai Le letters drawn as h, k, n, u, x, A, I, l, Cyrillic п as n, Hebrew ח as n, N'Ko CHA
--      as 1, the CJK and Kangxi vertical strokes and U+2758 as l, U+31C4 as L, U+2229 as n, U+2B58 as O, and two
--      private-use code points the machine's fonts draw as d and b. A character drawn as a letter with a mark is read as
--      the letter: the reading reads the letter with the mark so (kernel 1050, item 1).
--      Left out: punctuation, as kernel 1050 leaves out the danda: U+230A and U+230B (floors) and U+FF3B (a fullwidth
--      bracket) are drawn close to an l or a J with a mark and stay the separators they are; and a character drawn no
--      closer to a letter than two different letters are to each other (U+0259 ə and a, U+0492 Ғ and F), which the
--      drawing does not make the letter.
--   2. sandbox.no_advance_class (kernel 1090) is replaced to hold U+1D1A0 MUSICAL SYMBOL ORNAMENT STROKE-6 too: our
--      attack on 1090 laid out every character the reading does not remove between two digits, between two capitals
--      and between l and 0, and found this one drawn with an advance of at most one pixel at 16, 20 and 24 px (its ink
--      falls on the digits); every other character with no ink has an advance of five pixels or more and shows a gap,
--      which separates two words as a space does.
-- Honest text passes as before (tested): Hindi, Tamil and Telugu prose (no letter of their scripts is drawn as the
-- alphabet), Greek, Japanese, Chinese and Korean prose, an emoji, TEST- identifiers. Stricter only: every word read
-- before is read now.
--
-- What the reading still cannot see (residual, never weaker than the regulation, which asks that test data never be
-- confused with GMP data and not that every way of drawing an identifier be read): an identifier of digits and
-- separators only; one broken by a gap at least as wide as the thin space or by a visible character that is no
-- look-alike by UTS #39, its name or its drawing (L·2409-0017 with a separate middle dot, L#2409-0017); a character
-- drawn near a letter but no closer than two letters of the alphabet are to each other; one drawn as two letters that
-- UTS #39 does not list; a character another font draws as a letter, a digit or a separator (a floor terminal with
-- other fonts); one spelled out in words, drawn in an image or a signature's picture; one whose letter is drawn with a
-- punctuation mark (a danda for an l, a bracket); a word equal to an allowed name (decision F12.10 (4)).
--
-- The table keeps its owner and privileges (the application role may read it and nobody else may write it); its basis
-- check is replaced to admit the new basis. sandbox.no_advance_class keeps its signature, owner and privileges.
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

alter table sandbox.look_alike drop constraint look_alike_basis_check;
alter table sandbox.look_alike add constraint look_alike_basis_check
  check (basis in ('DECIMAL_DIGIT', 'UTS39_CONFUSABLE', 'UTS39_DECOMPOSED', 'UNICODE_NAME', 'DASH_PUNCTUATION',
                   'UTS39_PROTOTYPE_CLASS', 'LETTER_WITH_SIGN', 'SEPARATOR_SHAPE', 'UCD_COMPATIBILITY', 'LETTER_SHAPE'));

-- Chromium 141's drawing (header, item 1): letters, symbols and digits drawn as an ASCII letter or digit.
insert into sandbox.look_alike (code_point, reads_as, basis)
select c, r, 'LETTER_SHAPE' from (values
  (0x0185, 'b'), (0x025E, 'o'), (0x0289, 'u'), (0x03D9, 'o'), (0x03F5, 'c'), (0x040F, 'U'), (0x043F, 'n'),
  (0x049F, 'k'), (0x04A4, 'H'), (0x0528, 'H'), (0x053C, 'L'), (0x0544, 'U'), (0x05D7, 'n'), (0x07D7, '1'),
  (0x07DC, 'V'), (0x10D1, 'o'), (0x1455, 'C'), (0x146E, 'P'), (0x14A5, 'l'), (0x14AB, 'L'), (0x18BA, 'L'),
  (0x1952, 'n'), (0x1959, 'u'), (0x1963, 'l'), (0x196C, 'l'), (0x1C85, 'm'), (0x1D28, 'n'), (0x1E9C, 'f'),
  (0x2229, 'n'), (0x22BA, 'i'), (0x237F, 'l'), (0x23B8, 'l'), (0x23B9, 'l'), (0x2758, 'l'), (0x2B58, 'O'),
  (0x2C6D, 'O'), (0x2F01, 'l'), (0x3021, 'l'), (0x31C4, 'L'), (0x31D1, 'l'), (0x4E28, 'l'), (0xA669, 'o'),
  (0xA760, 'W'), (0xA785, 'r'), (0xF41B, 'd'), (0xF41E, 'b'), (0x10300, 'A'), (0x10306, 'I'), (0x10335, 'u'),
  (0x10337, 'h'), (0x1033A, 'k'), (0x1033F, 'n'), (0x10340, 'n'), (0x10345, 'v'), (0x10347, 'x'), (0x10348, 'o'),
  (0x11A1E, 'u'), (0x1BC0C, 'l')
) v (c, r);

-- DI-05 (header, item 2; kernel 1090): the spacing combining marks (Mc) of Unicode 18.0.0 and the characters Chromium 141
-- lays out with no advance that no other class of the reading removes, as a regular-expression bracket.
create or replace function sandbox.no_advance_class() returns text
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
         '\U00016ff0-\U00016ff1\U0001d165-\U0001d166\U0001d16d-\U0001d172\U0001d1a0\U0001d250-\U0001d252\U0001d25f'
         '\U0001d280-\U0001d281'
         ']'
$$;

reset role;
