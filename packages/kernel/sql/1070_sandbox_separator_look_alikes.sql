-- Sandbox, training and simulation store (module A4), part 9: the look-alikes of the separators are read as a class
-- (Phase 2 exit follow-up F12, the verification of the lane's round 7; control DI-05, invariant INV-18; ADR 0012: the
-- rules hold when the application's own database credentials are used directly).
--
-- What was wrong.
--   * Kernel 1050 reads U+2014 EM DASH and U+2015 HORIZONTAL BAR as '-' (dash punctuation) and NFKC reads U+FF0D
--     FULLWIDTH HYPHEN-MINUS as '-', but UTS #39 confusables.txt 18.0.0, the source 1050 names, gives all three the
--     prototype U+30FC KATAKANA-HIRAGANA PROLONGED SOUND MARK, shared with the box-drawing horizontals U+2500 and U+2501,
--     U+30FC and U+FF70, CJK U+4E00, U+2F00, U+3192 and U+31D0, Hangul U+1173, U+3161 and U+FFDA, U+1BC7, U+A7F7 and
--     U+1104B. 1050 took only the characters whose prototype is in the identifier alphabet, so none of these was read.
--     Characters that draw a dash or a solidus and that no table lists were not read either (U+23AF HORIZONTAL LINE
--     EXTENSION, the dashed box-drawing horizontals U+2504 to U+2509, U+1F67C VERY HEAVY SOLIDUS). Over HTTP the honest
--     server recorded LOT─2409─0017, LOT━2409━0017, LOTー2409ー0017, LOT㇐2409㇐0017, LOT⎯2409⎯0017 and B─24─0001 in
--     operator1's exception descriptions, supervisor1's hold reasons and business entries the application role appended
--     on a run's chain three levels down; Chromium 141 draws LOT─2409─0017 like the em-dash form, which is refused.
--   * U+013F and U+0140 (L WITH MIDDLE DOT): Chromium draws Ŀ2409-0017 at the width of L2409-0017 with the dot inside
--     the L, and it was recorded; NFKC splits the letter from U+00B7, a separator, and 1060 left out every character
--     with a decomposition.
--   * U+200A HAIR SPACE: L, U+200A, 2409-0017 is drawn with a gap of a twelfth of an em (1.7 px at 20 px) and was
--     recorded: 1050 read every white-space character as a gap.
--   * Found in this round's own attack, the same class: U+1680 OGHAM SPACE MARK is white space, which 1050 read as a
--     gap, but Chromium 141 draws it as a stroke of half an em at hyphen height (the Unicode chart draws the Ogham stem
--     line), so L, U+1680, 2409, U+1680, 0017 shows L-2409-0017; U+2006 SIX-PER-EM SPACE is drawn a sixth of an em wide;
--     the Canadian syllabic U+14B7 has the prototype of U+013F (L with a middle dot) and is drawn the same way; and
--     PostgreSQL 16's normalize() applies the decompositions of an older Unicode version, so 105 characters of Unicode
--     18.0.0 with a compatibility decomposition are left as they are (U+A7F1 MODIFIER LETTER CAPITAL S, the subscript
--     w, y and z, the modifier small letters with a stroke or a hook of U+1DFD0 to U+1DFFF).
--
-- Correction of earlier claims (applied migrations are never edited):
--   * 1050's header, item 2, says confusables.txt's characters are read with their look-alikes; it read only those
--     whose prototype is in the identifier alphabet. Item 1 says a space of any width shows as a gap; U+200A and U+2006
--     do not, and U+1680 shows a dash. Its residual, a visible character "neither in the identifier alphabet nor a
--     look-alike of it", left out look-alikes of characters it reads itself.
--   * 1060's header says the characters with a decomposition are read by NFKC or by the reading as it shows; not
--     U+013F, U+0140 and U+1E9A, whose compatibility decomposition puts a spacing sign beside the letter, and not the
--     105 characters PostgreSQL 16's NFKC does not know.
--
-- What changed (sandbox.look_alike, which every user of sandbox.identifier_words reads through sandbox.look_alikes_read:
-- sandbox.real_identifiers, sandbox.guard_free_text on the kernel's stubs and the person register, recipe-core 0344 to
-- 0349 including the run's bound words and a refusal's path, and tablets 0630 and 0640). The stored text is never
-- changed; the table is only how the rule reads it. 179 rows with four new bases, data built from confusables.txt
-- 18.0.0 (2026-08-06), UnicodeData.txt and PropList.txt 18.0.0, and Chromium 141 (the browser of the E2E suite):
--   1. UTS39_PROTOTYPE_CLASS (69): a member of a confusables class whose prototype lies outside the identifier
--      alphabet and outside ASCII, when another member of that class is read by what it looks like, is read as that
--      member is. The class of U+30FC is read as '-' (through U+2014, U+2015 and U+FF0D). The classes of the Latin
--      small capitals and hooked letters that 1060 reads by name are read as those letters: U+0138 kra, Greek κ ϰ, Cyrillic
--      к, Coptic, Cherokee and mathematical kappas as K; Cyrillic в, Cherokee and Coptic as B; н as H; м and ʍ as M; т
--      and Greek τ as T; ԍ as G; and so on (the classes of U+0138, U+024B, U+0262, U+0274, U+0280, U+028D, U+0299,
--      U+029C, U+029F, U+1D00, U+1D05, U+1D07, U+1D0A, U+1D18, U+1D1B, U+A727, U+A742, U+1DF69). Classes left out, each
--      as a group:
--        * a prototype that is ASCII outside the alphabet (':', '=', '~'): the class shows that separator; a member
--          read more strictly than it shows (a double hyphen as '-', a vertical two-dot leader as '..') does not make
--          the separator a letter;
--        * the folded member is read by its value, not its look (a decimal digit of a script, a numeral digit by
--          name): the letters drawn like it are letters of their script (the Tamil letter KA is drawn like the Tamil
--          digit one; Greek Λ and Cyrillic Л like the Arabic-Indic digit eight; Arabic DAL like the Coptic epact one);
--          reading them as digits would read Tamil, Arabic, Greek and Cyrillic prose as numbers;
--        * the folded member is read through a compatibility decomposition that changes its size, position or
--          frame (a superscript or modifier letter, a circled or parenthesized letter or digit, a vertical
--          presentation form): its look-alikes (the degree sign, the copyright sign, Canadian syllabic finals, the
--          vertical ellipsis) show a raised, enclosed or vertical sign, not the letter or digit at text size;
--        * the folded member is read by its name while UTS #39 gives it the look of a letter that is not that Latin
--          letter (U+A7E2 R WITH LONG LEG looks like Γ, U+A792 and U+A793 C WITH BAR like Є and ε, U+1DF70 I WITH
--          PIGTAIL like ɹ): Γ, Г, Є, ε, є and ɹ are read as themselves.
--      A member that already reads in the alphabet (by 1050, 1060 or NFKC), or whose text a right-to-left character
--      already makes read in every arrangement (1050, item 4: the Arabic alef forms of the class of U+0627 U+0674), is
--      not listed again.
--   2. LETTER_WITH_SIGN (27): one character that confusables.txt gives the look of a letter or digit of the alphabet
--      with a middle dot or an apostrophe beside it (U+013F Ŀ, U+0140 ŀ, U+1E9A ẚ, U+0491 ґ, U+14B7 ᒷ and the other
--      Canadian syllabics with a dot or an apostrophe, U+A6DD) is read as that letter or digit: the sign belongs to the
--      character, which takes one letter's place, as a combining mark does (1050, item 1). Two characters, a letter
--      and U+00B7 or an apostrophe, still read as two: L·2409 written so shows its separator.
--   3. SEPARATOR_SHAPE (49): characters read as '-' or '/' by their name in UnicodeData.txt 18.0.0 (a horizontal line
--      or dash, a solidus) or because Chromium 141 draws them as a straight stroke at hyphen height or along the rising
--      diagonal (a pixel scan of every assigned code point the reading did not read, in the serif and sans-serif fonts
--      of the E2E machine): U+23AF, U+23E4 STRAIGHTNESS, the box-drawing dashed, half and mixed-weight horizontals
--      U+2504 to U+2509, U+254C, U+254D, U+2574, U+2576, U+2578, U+257A, U+257C, U+257E, U+1CE0D and U+1CE0E, U+2E43
--      DASH WITH LEFT UPTURN, U+10D8F GARAY MINUS SIGN, U+1680 OGHAM SPACE MARK, U+29FF MINY, the one-eighth blocks 4
--      to 6, U+1F67C VERY HEAVY SOLIDUS, U+2E4A DOTTED SOLIDUS, and the letters and signs drawn so (Telugu, Hanunoo,
--      Balinese, Ol Chiki, Tifinagh, Bopomofo, Aegean, Brahmi, Kaithi, Duployan, Byzantine and Western musical
--      symbols, a Mayan numeral; Tibetan, Bamum, Rejang, Shavian, Katakana Minnan and Duployan strokes as '/'). Left
--      out: a stroke at the top or the bottom of the line (horizontal scan lines 1, 7 and 9, overlines, low lines, the
--      one-eighth blocks 1 to 3, 7 and 8: an overline or an underscore, which the rule reads as a separator in ASCII
--      too), a scan line above the middle of a capital (scan line 3), double lines (they show '='), dotted lines at mid
--      height (they show middle dots), curves, hooks and arcs (breves, tildes), a slash crossed by a bar or with dots
--      beside it (they show ≠, ÷ or %), reverse solidi, arrows and check marks.
--   4. UCD_COMPATIBILITY (34): a character whose compatibility decomposition in UnicodeData.txt 18.0.0 PostgreSQL 16's
--      normalize() does not apply is read through that decomposition when every character of it reads in the alphabet,
--      as NFKC reads the older ones (U+A7F1 as S, U+209D to U+209F as w, y and z, U+1DFD0 to U+1DFFF).
--   5. sandbox.shown_text (1050, item 1) is replaced: a white-space character narrower than U+2009 THIN SPACE shows no
--      gap and is removed with what shows nothing (kernel.is_blank's class, kernel 0960): U+200A HAIR SPACE (a twelfth
--      of an em in Chromium 141) and U+2006 SIX-PER-EM SPACE (a sixth). The thin space (a fifth of an em) and the
--      narrow no-break space separate a number from its unit in honest text (250 mg) and stay gaps (decision F12.11).
--
-- Honest text passes as before (tested): Japanese prose with the prolonged sound mark, Chinese prose with the ideograph
-- one, Korean prose with the letter eu, Greek prose with kappa and tau, a number and its unit with a thin or narrow
-- no-break space, an emoji, TEST- identifiers. They are refused only where a mark of the class joins a letter of the
-- alphabet to a digit, which no honest sentence of those languages does. Stricter only: every word read before is read
-- now.
--
-- What the reading still cannot see (residual, never weaker than the regulation, which asks that test data never be
-- confused with GMP data and not that every way of drawing an identifier be read): an identifier of digits and
-- separators only; one broken by a gap at least as wide as the thin space, or by a visible character that is neither
-- in the alphabet nor, by UTS #39, its name or its drawing in Chromium 141, a look-alike of it (L·2409-0017 with a
-- separate middle dot, L 2409 0017, L#2409-0017); one drawn with characters a font other than Chromium 141's draws as
-- a dash or a slash; one spelled out in words, drawn in an image or a signature's picture; one whose letter is drawn
-- with a punctuation mark (a danda for an l, 1050); a word equal to an allowed name (decision F12.10 (4)).
--
-- The table keeps its owner and privileges (the application role may read it and nobody else may write it); its basis
-- check is replaced to admit the new bases. sandbox.shown_text keeps its signature, owner and privileges. Applied as a
-- new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

alter table sandbox.look_alike drop constraint look_alike_basis_check;
alter table sandbox.look_alike add constraint look_alike_basis_check
  check (basis in ('DECIMAL_DIGIT', 'UTS39_CONFUSABLE', 'UTS39_DECOMPOSED', 'UNICODE_NAME', 'DASH_PUNCTUATION',
                   'UTS39_PROTOTYPE_CLASS', 'LETTER_WITH_SIGN', 'SEPARATOR_SHAPE', 'UCD_COMPATIBILITY'));

-- confusables.txt 18.0.0: the members of the classes another member of which is read by its look (header, item 1).
insert into sandbox.look_alike (code_point, reads_as, basis)
select c, r, 'UTS39_PROTOTYPE_CLASS' from (values
  (0x0138, 'K'), (0x028D, 'M'), (0x03BA, 'K'), (0x03C4, 'T'), (0x03F0, 'K'), (0x0432, 'B'), (0x043A, 'K'),
  (0x043C, 'M'), (0x043D, 'H'), (0x0442, 'T'), (0x050D, 'G'), (0x1173, '-'), (0x13FB, 'G'), (0x13FC, 'B'),
  (0x1BC7, '-'), (0x1D29, 'P'), (0x1D90, 'q'), (0x2500, '-'), (0x2501, '-'), (0x2C83, 'B'), (0x2C8F, 'H'),
  (0x2C95, 'K'), (0x2C99, 'M'), (0x2C9B, 'N'), (0x2CA7, 'T'), (0x2CD1, 'L'), (0x2F00, '-'), (0x30FC, '-'),
  (0x3161, '-'), (0x3192, '-'), (0x31D0, '-'), (0x4E00, '-'), (0xA68D, 'T'), (0xA727, 'h'), (0xA7F7, '-'),
  (0xAB70, 'D'), (0xAB71, 'R'), (0xAB72, 'T'), (0xAB7A, 'A'), (0xAB7B, 'J'), (0xAB7C, 'E'), (0xAB87, 'M'),
  (0xAB8B, 'H'), (0xAB90, 'G'), (0xABA2, 'R'), (0xABAE, 'L'), (0xABB2, 'P'), (0xABB6, 'K'), (0xFF70, '-'),
  (0xFFDA, '-'), (0x10182, 'K'), (0x10443, 'L'), (0x1104B, '-'), (0x1D6CB, 'K'), (0x1D6D5, 'T'), (0x1D6DE, 'K'),
  (0x1D705, 'K'), (0x1D70F, 'T'), (0x1D718, 'K'), (0x1D73F, 'K'), (0x1D749, 'T'), (0x1D752, 'K'), (0x1D779, 'K'),
  (0x1D783, 'T'), (0x1D78C, 'K'), (0x1D7B3, 'K'), (0x1D7BD, 'T'), (0x1D7C6, 'K'), (0x1DF69, 'a')
) v (c, r);

-- confusables.txt 18.0.0: one character with the look of a letter or digit with a middle dot or an apostrophe (header, item 2).
insert into sandbox.look_alike (code_point, reads_as, basis)
select c, r, 'LETTER_WITH_SIGN' from (values
  (0x013F, 'L'), (0x0140, 'l'), (0x0491, 'r'), (0x143A, 'V'), (0x143B, 'V'), (0x1457, 'U'), (0x1458, 'U'),
  (0x1467, 'U'), (0x1476, 'P'), (0x1477, 'p'), (0x147A, 'd'), (0x147B, 'd'), (0x147E, 'b'), (0x147F, 'b'),
  (0x1480, 'b'), (0x1481, 'b'), (0x1486, 'P'), (0x1487, 'd'), (0x1488, 'b'), (0x1498, 'J'), (0x1499, 'J'),
  (0x14B6, 'L'), (0x14B7, 'L'), (0x152F, '4'), (0x1530, '4'), (0x1E9A, 'a'), (0xA6DD, '9')
) v (c, r);

-- UnicodeData.txt 18.0.0 names and Chromium 141's drawing: dashes as '-', solidi as '/' (header, item 3).
insert into sandbox.look_alike (code_point, reads_as, basis)
select c, r, 'SEPARATOR_SHAPE' from (values
  (0x0C7C, '-'), (0x0F3C, '/'), (0x1680, '-'), (0x172D, '-'), (0x1B78, '-'), (0x1C7C, '-'), (0x23AF, '-'),
  (0x23E4, '-'), (0x2504, '-'), (0x2505, '-'), (0x2508, '-'), (0x2509, '-'), (0x254C, '-'), (0x254D, '-'),
  (0x2574, '-'), (0x2576, '-'), (0x2578, '-'), (0x257A, '-'), (0x257C, '-'), (0x257E, '-'), (0x29FF, '-'),
  (0x2D67, '-'), (0x2E43, '-'), (0x2E4A, '/'), (0x3127, '-'), (0xA6F3, '/'), (0xA937, '/'), (0x10110, '-'),
  (0x10462, '/'), (0x10D8F, '-'), (0x11049, '-'), (0x11052, '-'), (0x110BE, '-'), (0x1AFF0, '/'), (0x1BC03, '-'),
  (0x1BC08, '-'), (0x1BC0D, '-'), (0x1BC4F, '/'), (0x1CE0D, '-'), (0x1CE0E, '-'), (0x1D01A, '-'), (0x1D047, '-'),
  (0x1D116, '-'), (0x1D13C, '-'), (0x1D2E5, '-'), (0x1F67C, '/'), (0x1FB78, '-'), (0x1FB79, '-'), (0x1FB7A, '-')
) v (c, r);

-- UnicodeData.txt 18.0.0: compatibility decompositions PostgreSQL 16's normalize() does not apply (header, item 4).
insert into sandbox.look_alike (code_point, reads_as, basis)
select c, r, 'UCD_COMPATIBILITY' from (values
  (0x058C, 'j'), (0x209D, 'w'), (0x209E, 'y'), (0x209F, 'z'), (0xA7F1, 'S'), (0x1DFD0, 'y'), (0x1DFD1, 'P'),
  (0x1DFD2, 'b'), (0x1DFD3, 'd'), (0x1DFD4, 'g'), (0x1DFD5, 'l'), (0x1DFD6, 'l'), (0x1DFD9, 'j'), (0x1DFDB, 'w'),
  (0x1DFDC, 'n'), (0x1DFDD, 'r'), (0x1DFE8, 'D'), (0x1DFE9, 'A'), (0x1DFEA, 'E'), (0x1DFEF, 'd'), (0x1DFF0, 'l'),
  (0x1DFF1, 'n'), (0x1DFF2, 't'), (0x1DFF5, 'd'), (0x1DFF6, 'h'), (0x1DFF7, 'n'), (0x1DFF8, 's'), (0x1DFF9, 'z'),
  (0x1DFFA, 'c'), (0x1DFFB, 'k'), (0x1DFFC, 'p'), (0x1DFFD, 'q'), (0x1DFFE, 't'), (0x1DFFF, 't')
) v (c, r);

-- DI-05 (header, item 5): text p_text as it shows (1050, item 1), a white-space character narrower than the thin space
-- removed with what shows nothing. Printable ASCII and ASCII white space are returned as they are.
create or replace function sandbox.shown_text(p_text text) returns text
language plpgsql immutable strict parallel safe set search_path = pg_catalog, sandbox, kernel, pg_temp as $$
declare
  v_out text;
  c     text;
begin
  if p_text !~ '[^\u0009-\u000d\u0020-\u007e]' then
    return p_text;
  end if;
  v_out := regexp_replace(normalize(p_text, NFD), sandbox.combining_mark_class(), '', 'g');
  for c in select distinct x from regexp_split_to_table(regexp_replace(v_out, '[\u0009-\u000d\u0020-\u007e]+', '', 'g'), '') x loop
    -- kernel.is_blank's class (kernel 0960), but for the white space that shows a gap at least as wide as U+2009 THIN
    -- SPACE (Unicode White_Space, PropList.txt 18.0.0, without U+2006 and U+200A).
    if kernel.is_blank(c) and c !~ '[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u2005\u2007-\u2009\u2028-\u2029\u202f\u205f\u3000]' then
      v_out := replace(v_out, c, '');
    end if;
  end loop;
  return normalize(v_out, NFC);
end
$$;

reset role;
