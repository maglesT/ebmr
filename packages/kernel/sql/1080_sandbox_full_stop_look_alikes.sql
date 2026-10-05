-- Sandbox, training and simulation store (module A4), part 10: the look-alikes of the full stop are read as the
-- look-alikes of the dash and the solidus are (Phase 2 exit follow-up F12, the attack on kernel 1070 in the lane's own
-- round 2; control DI-05, invariant INV-18; ADR 0012: the rules hold when the application's own database credentials are
-- used directly).
--
-- What was wrong. The identifier alphabet has three separators, '-', '/' and '.', and a word joined by full stops is
-- read as an identifier (L.2409-0017 and L2409.0017 are real formats). Kernel 1070 read the look-alikes of the dash and
-- the solidus by name and as Chromium 141 draws them, but not those of the full stop: our attack on 1070, the same pixel
-- scan for one solid dot on the baseline over every assigned code point the reading did not read, found six glyphs that
-- Chromium 141 (the browser of the E2E suite, with the fonts of the E2E machine) draws as a full stop, and
-- sandbox.real_identifiers read nothing in L, one of them, 2409-0017, which shows L.2409-0017: U+1390 ETHIOPIC TONAL MARK
-- YIZET, U+10100 AEGEAN WORD SEPARATOR LINE, U+1BC94 DUPLOYAN AFFIX LOW DOT, U+1D085 BYZANTINE MUSICAL SYMBOL APLI,
-- U+1D147 MUSICAL SYMBOL SQUARE NOTEHEAD BLACK, and U+2E3C STENOGRAPHIC FULL STOP (a full stop by its name in
-- UnicodeData.txt 18.0.0). The full stops UTS #39 confusables.txt lists (U+2024, U+FE52, U+FF0E and the others) are read
-- since kernel 1050.
--
-- Correction of an earlier claim (applied migrations are never edited): kernel 1070's header (item 3) reads the dashes
-- and solidi by name and drawing; the full stop belongs to the same class and is read from here on.
--
-- What changed. sandbox.look_alike takes these six characters as '.', basis SEPARATOR_SHAPE (kernel 1070, item 3), read
-- by every user of the reading. Left out, as kernel 1070 leaves out a dash drawn with a gap or below the line: a Braille
-- dot (U+2840, U+2880: one dot at the foot of a cell three quarters of an em wide, which shows a full stop followed by a
-- gap, as '. ' does in ASCII, a separator) and U+037A GREEK YPOGEGRAMMENI (drawn below the line like a comma, a
-- separator). Stricter only; honest text of the outline's languages holds none of these characters.
--
-- The table keeps its owner, privileges and basis check (kernel 1070). Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- Chromium 141's drawing (one dot on the baseline) and UnicodeData.txt 18.0.0's name (U+2E3C): full stops as '.'.
insert into sandbox.look_alike (code_point, reads_as, basis)
select c, '.', 'SEPARATOR_SHAPE' from unnest(array[0x1390, 0x2E3C, 0x10100, 0x1BC94, 0x1D085, 0x1D147]) c;

reset role;
