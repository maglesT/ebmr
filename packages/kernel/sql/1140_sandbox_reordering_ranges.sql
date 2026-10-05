-- Sandbox, training and simulation store (module A4), part 16: the characters that can make a text display in another
-- order are those of every browser's bidirectional data, not of one Unicode version: every code point of the ranges
-- reserved for right-to-left scripts (Phase 2 exit follow-up F12, the verification of the lane's round 8, lane round 2,
-- decision F12.16; control DI-05, invariant INV-18; ADR 0012: the rules hold when the application's own database
-- credentials are used directly).
--
-- What was wrong. Kernel 1050's sandbox.reordering_class (its header, item 4) holds the code points Unicode 18.0.0
-- gives bidirectional class R, AL or AN, the unassigned code points of the right-to-left blocks, the embedding, override
-- and isolate controls and U+200E. Kernels 1050 and 1130 arrange a text in every order of its runs only when it holds
-- one of them. The product's browser, Chromium 141 (Playwright build 1194, the E2E browser), ships ICU 74 (icudt74l),
-- whose character data is Unicode 15.1. Code points that Unicode 16 to 18 assigned as marks or neutrals inside the
-- right-to-left blocks are unassigned in 15.1, so ICU gives them their block's default class, R or AL, and the browser
-- reorders the line around them, while the class left them out. There are 61 such code points (the development
-- machine's ICU 74.2, u_charDirection, the same Unicode 15.1 data, gives each R or AL; Unicode 18.0.0 gives each NSM or
-- ON):
--   R (8): U+05C8, U+05C9, U+10D69 to U+10D6E;
--   AL (53): U+0897, U+FBC3 to U+FBD2, U+FD90, U+FD91, U+FDC8 to U+FDCE, U+10ECB to U+10ED8, U+10EF0 to U+10EFC.
-- The verification measured each in the E2E Chromium: 'Drum of L<X> 2409-0017 set aside' (R) and 'Drum of L<X>
-- 0017-2409 set aside' (AL: the digit runs are drawn in reverse order) are drawn as 'Drum of L2409-0017 <X> set aside'.
-- sandbox.real_identifiers read nothing in them; over HTTP the honest server kept them in operator1's exception
-- description, supervisor1's hold reason, a business entry's message and its details three levels down, and qa1 signed
-- a disposition whose justification held 'Drum L<U+05C8> 2409-0017 re-checked'; in a sandbox the person register kept an
-- employee reference 'L<U+05C8> 2409-0017'.
--
-- What changed (decision F12.16, a default taken under the 3 Oct heading; outside a GMP installation only):
--   1. sandbox.reordering_class() is replaced (its signature, owner, privileges and IMMUTABLE kept): every code point of
--      the ranges DerivedBidiClass.txt reserves for right-to-left scripts (its lines for the unassigned code points that
--      default to R or AL: U+0590 to U+08FF, U+FB1D to U+FDCF, U+FDF0 to U+FDFF, U+FE70 to U+FEFE, U+10800 to U+10FFF,
--      U+1E800 to U+1EFFF), whatever class a Unicode version gives it there (a letter, a digit, a mark, a sign, a
--      punctuation mark, or none yet), and the explicit embedding, override and isolate controls (U+202A to U+202E,
--      U+2066 to U+2069) and the marks U+200E and U+200F (U+061C is inside the ranges): 5837 code points. U+FEFF (zero
--      width no-break space) and the noncharacters U+FDD0 to U+FDEF stay out: every version gives them class BN, which
--      reorders nothing.
--   2. Nothing else is replaced. Kernel 1050's sandbox.rearranged_words, replaced by kernel 1130, asks this class, so a
--      text that holds one of these code points is read in every arrangement of its runs (each run of ASCII letters,
--      and each run of characters other than ASCII digits inside a word that holds a character outside ASCII, joined to
--      each run of digits), and every guard of the rule refuses such a joined word in a sandbox with no change of its
--      own: sandbox.guard_free_text (the kernel's stubs, the person register's employee references, tablets 0630;
--      EBMR-SBX-024), recipe-core 0344 to 0350's triggers on a test run's record and its audit chains and tablets 0640
--      (EBMR-EXE-147). The refusals name the column or the member, never the word.
-- Why the whole ranges, the strict side, and not the 61 code points alone: what a browser reorders depends on the
-- Unicode version of its own data, which the server cannot know, and each new version assigns more code points in these
-- ranges. Checked code point by code point: every code point that ICU 74.2 (Unicode 15.1, the data of Chromium 141),
-- Python 3.11's unicodedata (Unicode 14.0) and DerivedBidiClass.txt 18.0.0 give class R, AL or AN lies in these ranges,
-- except U+200F, which is listed; ICU 74.2's explicit controls are U+202A to U+202E and U+2066 to U+2069. Unassigned code
-- points take R or AL only inside these ranges in each of them. So the class covers the bidirectional data of Chromium
-- 141 and of any browser whose Unicode version gives R, AL or AN only inside the reserved ranges (Unicode 14.0, 15.1 and
-- 18.0 checked). In a left-to-right paragraph (the product's screens set no paragraph direction) only these classes and
-- the explicit controls can change the order in which a line is drawn: by the bidirectional algorithm's rules, a European
-- number with no right-to-left character before it takes the paragraph's direction, and neutrals between left-to-right
-- characters stay in order.
--
-- In effect, in a sandbox, a text that holds a code point of the class and a digit (of any script) is refused: the code
-- point is itself a character outside ASCII inside a word, so kernel 1130 joins its run to every run of digits. Refused
-- from here on although honest (the accepted cost, decision F12.16), beyond kernel 1130's (Urdu, Arabic or Hebrew prose
-- with a number in digits; a text with a direction mark and a number): a text with a number in digits and a mark or sign
-- of a right-to-left script that Unicode 18.0.0 does not class R, AL or AN (a Hebrew point, U+0897 ARABIC PEPET, an
-- Arabic honorific ligature such as U+FDFD, the Arabic comma U+060C). These 409 code points were added (317 marks, 77
-- neutrals, the ten Extended Arabic-Indic digits U+06F0 to U+06F9, which kernel 1120 refuses already as digits of
-- another script, and 5 others); each belongs to a right-to-left script, so a text that holds one nearly always holds
-- a letter of that script too, and was refused already. The server's guidance for EBMR-EXE-147 now names the marks and
-- signs of those scripts too. Still passes (tested): every text without such a code point: Hindi, Tamil, Japanese, Korean and
-- Greek prose with ASCII digits apart from its words, an emoji and its variation selector, a soft hyphen in a long word
-- without digits, TEST- identifiers, the run's own codes, ASCII dates and quantities; Hebrew and Urdu prose without a
-- number. A GMP installation is unchanged: it keeps what was written.
--
-- Corrections of earlier claims (applied migrations are never edited):
--   * Kernel 1050's header (item 4) says the class is the characters that can make a text display in another order
--     (DerivedBidiClass.txt 18.0.0), and its comment on sandbox.reordering_class names Unicode 18.0.0. That held for a
--     renderer with Unicode 18.0.0 data only; Chromium 141's ICU 74 (Unicode 15.1) reordered a line around the 61 code
--     points above. From here on the class is the reserved ranges and the controls, which hold the bidirectional data of
--     Chromium 141 and of Unicode 14.0, 15.1 and 18.0.
--   * Kernel 1130's header (its residual) and decision F12.15 (1), (4) and (6) say a text with none of these characters
--     displays in the order it is stored, and decision F12.14 (7), as F12.15 corrected it, says so of a text with no
--     such character. With kernel 1050's class that was not so in the E2E browser. It holds from here on for the
--     bidirectional data the item above names; a renderer whose data gives R, AL or AN outside the reserved ranges is
--     the residual (none is known).
--
-- What the rule still cannot see (residual, never weaker than the regulation, which asks that test data never be
-- confused with GMP data, not that every way of drawing an identifier be read): decision F12.14 (7) and F12.15 (6) as
-- corrected (each text read on its own; what two texts a screen draws in one line show together); a renderer whose
-- bidirectional data gives class R, AL or AN to a code point outside the reserved ranges, or a page that sets a
-- right-to-left paragraph direction (the product's screens set none).
--
-- Cost of the reading: unchanged (kernel 1130); only a text that holds a code point of the class is arranged.
--
-- The replaced function keeps its owner (ebmr_owner), its search_path pinned with pg_temp last, IMMUTABLE and its
-- privileges (executed by the application role, as kernel 1050's reading functions). Applied as a new migration because
-- applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05 (header, item 1): the code points that can make a text display in another order than it is stored: every code
-- point of the ranges reserved for right-to-left scripts (DerivedBidiClass.txt: the unassigned code points there default
-- to R or AL), whatever its class in a given Unicode version, the explicit embedding, override and isolate controls,
-- and the marks U+200E and U+200F. 5837 code points.
create or replace function sandbox.reordering_class() returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select '['
         '֐-ࣿיִ-﷏ﷰ-﷿ﹰ-﻾\U00010800-\U00010fff\U0001e800-\U0001efff'
         '‎-‏‪-‮⁦-⁩'
         ']'
$$;

reset role;
