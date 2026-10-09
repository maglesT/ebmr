-- Sandbox, training and simulation store (module A4), part 7: the identifier rule reads a text as it shows (Phase 2 exit
-- follow-up F12, the verification of the lane's round 6, lane round 3; control DI-05, invariant INV-18; ADR 0012: the
-- rules hold when the application's own database credentials are used directly).
--
-- What was wrong.
--   * Kernel 1030 and 1040 read the words of a text as the runs of the identifier alphabet (ASCII letters and digits, '/',
--     '.', '-') in its NFKC form, as written and with its escapes read. NFKC keeps the characters that show nothing (the
--     format characters, the default-ignorable code points, the bidirectional controls), the combining marks, letters of
--     other scripts that look like Latin ones, digits of other scripts and most look-alikes of '-', '/' and '.'. Each was
--     read as a separator although nothing, or the identifier's own character, shows in its place. Over HTTP the honest
--     server recorded, in operator1's exception descriptions, supervisor1's hold reasons and business entries the
--     application role appended on a run's chain (details three levels down): L2409-0017 with U+00AD (soft hyphen),
--     U+200B, U+200D, U+034F, U+FE0F or U+2060 after the L; 'L' U+202E '7100-9042' U+202C, which a right-to-left override
--     displays as L2409-0017; and BATCH/2409/0017 written with U+2215 or U+2044 for the solidus. Each record shows a
--     real-format identifier that the reading read as 'L' and '2409-0017' (neither a word with a letter and a digit), or
--     as 'BATCH', '2409' and '0017'. The same reading guards the kernel's stubs and the person register (1030, 1040),
--     recipe-core 0344 to 0348 and tablets 0630 and 0640: sandbox.real_identifiers returned nothing for 'TEST-Priya L'
--     U+00AD '2409-0017', and an employee reference or a stub's text holding it passed (the name itself and a login
--     name are refused by the person label rule, which allows ASCII only after TEST-, EBMR-SBX-022).
--   * Found in this round's own attack, the same class: a right-to-left letter reorders what a line shows with no control
--     character at all: 'L' U+05D0 '2409-0017' (HEBREW LETTER ALEF between the L and the digits) shows L2409-0017 followed
--     by the alef in a left-to-right line, and Arabic-Indic digits around a hyphen swap places (both checked in Chromium
--     141, the browser of the E2E suite); 'L' U+200F '0017' U+200F '-24' shows L24-0017. Letters of other scripts
--     (Cyrillic or Greek BATCH/2409/0017, Cherokee L2409-0017), digits of other scripts (L with Devanagari or Arabic-Indic
--     2409-0017), a combining mark on the L and a stroked letter were read as nothing too.
--
-- Correction of an earlier claim (applied migrations are never edited): 1040's header (item 1) calls sandbox.as_written
-- "the text as it shows"; it is the text as stored, in NFKC, and does not show what that text displays. What a text
-- shows is read from here on as items 1 to 4 say.
--
-- What changed (sandbox.identifier_words, through which sandbox.real_identifiers, sandbox.guard_free_text, recipe-core
-- 0344 to 0348 and tablets 0640 read, is replaced; recipe-core 0349 makes the bound words and the refusal's path read the
-- same readings). Each text, as stored, as written in NFKC and with its escapes read (1040; the escapes of U+0000 and of
-- '%' itself read as a space in all three), is read in four forms, and the words of all of them are its words; the
-- stored text is never changed: these forms are only how the rule reads it. The text as stored is read too because NFKC
-- itself changes what some characters show (U+03F9, a lunate sigma that shows as C, becomes the sigma U+03A3).
--   1. As it shows (sandbox.shown_text): in NFD, with the combining marks (general categories Mn and Me: a mark shows on
--      the character before it, never between two) and the characters kernel.is_blank counts as showing nothing (kernel
--      0960: the C0 and C1 controls, the format characters, the default-ignorable code points, the bidirectional controls,
--      marks and isolates, the variation selectors, the combining grapheme joiner, the tag characters, the Hangul fillers,
--      the Braille blank) removed, except the white-space characters (Unicode White_Space: a space of any width shows as a
--      gap, which separates two words as the ASCII space does), and then in NFC again (so a Hangul syllable stays one).
--      The class of what shows nothing is kernel.is_blank's own, asked character by character; there is no second list.
--   2. With look-alikes read (sandbox.look_alikes_read, table sandbox.look_alike): every character other than ASCII that
--      reads as the identifier alphabet is read as what it reads as. The table is data, built from the Unicode Security
--      Mechanisms' confusables.txt (UTS #39, version 18.0.0 of 2026-08-06) and the Unicode Character Database 18.0.0:
--        * every decimal digit of any script (general category Nd, 760 characters) as its digit value (UnicodeData.txt),
--          its shape notwithstanding, as the rule reads ASCII 0 and 1 as digits although they look like O and l;
--        * every other character that confusables.txt maps to a string of ASCII letters, digits, '/', '-' and '.' (with
--          the combining marks of that string dropped, as item 1 drops them: U+0141 is read as L), 1998 characters: the
--          Cyrillic, Greek, Cherokee, Coptic and mathematical letters that look like Latin ones, the division and fraction
--          slashes, the hyphens and minus signs, the one-dot leader, and so on; except a punctuation mark (general
--          category P*) whose string holds a letter or a digit (29 characters, the Devanagari danda among them, which
--          ends a Hindi sentence and looks like l): punctuation is read as the separator it is. confusables.txt gives the
--          prototype of a class of look-alikes (l for 1, l and I; O for 0 and O), so the 86 of these characters that have
--          a decomposition (UnicodeData.txt) every character of which reads in the alphabet are read as that decomposition
--          (U+00BD is 1/2, not l/2; U+2160 ROMAN NUMERAL ONE is I), as NFKC reads most of them;
--        * every other dash punctuation (general category Pd, 19 characters: the em dash, the horizontal bar, the
--          two- and three-em dashes, the wave dash ...) as '-'.
--      An ASCII character is read as it is coded, as the rule always has ('|' is a separator, O a letter, 0 a digit).
--   3. Both: the look-alikes of the text as it shows. The four forms are read, not only the last, so a short word that a
--      longer one would swallow in another form is still read (the rule reads a word too long to be an identifier part
--      by part, at its separators).
--   4. Display order. The reading does not compute the order in which a text is displayed: the bidirectional algorithm
--      orders each line on its own, and where a line breaks depends on the screen. Of the two ways the verification
--      offered (read a reordered text as it displays, or refuse the override, embedding and isolate controls outright),
--      neither closes the class: a right-to-left letter reorders a line with no control at all. The strict side is
--      taken instead: a text that holds a character that can make it display in another order than it is stored (one of
--      bidirectional class R, AL or AN, unassigned code points of the right-to-left blocks included, an explicit
--      embedding, override or isolate control, or a directional mark: DerivedBidiClass.txt 18.0.0) is read in every
--      arrangement of its runs: each run of letters joined to each run of digits, in any of its forms, is a word of it
--      (sandbox.rearranged_words). So in a sandbox such a text that holds a letter and a digit (after item 2) is refused
--      wherever the rule reads (EBMR-SBX-024, EBMR-EXE-147), unless every such word is one the run has from a bound
--      source; a GMP installation keeps it. This is stricter than refusing the controls alone, which would leave the
--      implicit reordering open, and it refuses Urdu, Arabic or Hebrew text that holds a number in a test run's record
--      (decision F12.11). A text with no such character displays in the order it is stored, left to right, in the
--      product's screens and printouts.
-- Honest text passes as before (tested): prose with an emoji and its variation selector, a soft hyphen in a long word
-- without digits, Hindi prose with Devanagari or ASCII digits and the danda, Tamil, Greek, Japanese and Korean prose with
-- a number, a vulgar fraction, TEST- identifiers, the run's own words (also written with a hyphen look-alike). Stricter only: every word read before is read now (the forms of 1030 and 1040 are
-- among the readings).
--
-- What the reading still cannot see (residual, never weaker than the regulation, which asks that test data never be
-- confused with GMP data and not that every way of drawing an identifier be read): an identifier of digits and
-- separators only; one broken by a space of any width, or by a visible character that is neither in the identifier
-- alphabet nor a look-alike of it (L 2409 0017, L#2409-0017); one spelled out in words, drawn in an image or a
-- signature's picture; one whose letter is drawn with a punctuation mark (a danda for an l); a word equal to an allowed
-- name (decision F12.10 (4)).
--
-- New objects are owned by ebmr_owner and pin their search_path with pg_temp last; the reading functions keep 1030's
-- privileges (granted to the application role, as 0810's are), and the table, configuration shipped by migrations,
-- may be read by the application role and written by nobody else. sandbox.identifier_words keeps its signatures, owner
-- and privileges; it reads a table now and is STABLE. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- DI-05 (header, item 2): what a character other than ASCII reads as in the identifier alphabet. basis: DECIMAL_DIGIT
-- a decimal digit of any script, by its value; UTS39_CONFUSABLE confusables.txt's string; UTS39_DECOMPOSED a character
-- confusables.txt lists, read as its decomposition; DASH_PUNCTUATION any other dash punctuation, as '-'.
create table sandbox.look_alike (
  code_point  integer primary key check (code_point between 128 and 1114111 and code_point not between 55296 and 57343),
  reads_as    text not null check (reads_as ~ '^[A-Za-z0-9/.-]{1,8}$'),
  basis       text not null check (basis in ('DECIMAL_DIGIT', 'UTS39_CONFUSABLE', 'UTS39_DECOMPOSED', 'DASH_PUNCTUATION'))
);
revoke all on sandbox.look_alike from public;
grant select on sandbox.look_alike to ebmr_app;

-- Every decimal digit of Unicode 18.0.0: the ten digits from each zero (their code points are consecutive, 0 to 9).
insert into sandbox.look_alike (code_point, reads_as, basis)
select z + d, d::text, 'DECIMAL_DIGIT'
  from unnest(array[
    0x0660, 0x06F0, 0x07C0, 0x0966, 0x09E6, 0x0A66, 0x0AE6, 0x0B66, 0x0BE6, 0x0C66, 0x0CE6, 0x0D66, 0x0DE6, 0x0E50,
  0x0ED0, 0x0F20, 0x1040, 0x1090, 0x17E0, 0x1810, 0x1946, 0x19D0, 0x1A80, 0x1A90, 0x1B50, 0x1BB0, 0x1C40, 0x1C50,
  0xA620, 0xA8D0, 0xA900, 0xA9D0, 0xA9F0, 0xAA50, 0xABF0, 0xFF10, 0x104A0, 0x10D30, 0x10D40, 0x11066, 0x110F0,
  0x11136, 0x111D0, 0x112F0, 0x11450, 0x114D0, 0x11650, 0x116C0, 0x116D0, 0x116DA, 0x11730, 0x118E0, 0x11950,
  0x11BF0, 0x11C50, 0x11D50, 0x11DA0, 0x11DE0, 0x11F50, 0x16130, 0x16A60, 0x16AC0, 0x16B50, 0x16D70, 0x1CCF0,
  0x1D7CE, 0x1D7D8, 0x1D7E2, 0x1D7EC, 0x1D7F6, 0x1E140, 0x1E2F0, 0x1E4F0, 0x1E5F1, 0x1E950, 0x1FBF0
  ]) z cross join generate_series(0, 9) d;

-- confusables.txt 18.0.0: the characters whose string is of the identifier alphabet and is how they are read (header, item 2).
insert into sandbox.look_alike (code_point, reads_as, basis)
select c, r, 'UTS39_CONFUSABLE' from (values
  (0x00A2, 'c'), (0x00A5, 'Y'), (0x00BE, '3/4'), (0x00C6, 'AE'), (0x00D0, 'D'), (0x00D7, 'x'), (0x00D8, 'O'),
  (0x00E6, 'ae'), (0x00F8, 'o'), (0x00FE, 'p'), (0x0110, 'D'), (0x0111, 'd'), (0x0126, 'H'), (0x0127, 'h'),
  (0x0131, 'i'), (0x0133, 'ij'), (0x0141, 'L'), (0x0142, 'l'), (0x014B, 'n'), (0x0152, 'OE'), (0x0153, 'oe'),
  (0x0166, 'T'), (0x0167, 't'), (0x0180, 'b'), (0x0182, 'b'), (0x0183, 'b'), (0x0184, 'b'), (0x0189, 'D'),
  (0x018B, 'd'), (0x018C, 'd'), (0x018D, 'g'), (0x0191, 'F'), (0x0192, 'f'), (0x0196, 'l'), (0x0197, 'l'),
  (0x0199, 'k'), (0x019A, 'l'), (0x019D, 'N'), (0x019E, 'n'), (0x019F, 'O'), (0x01A5, 'p'), (0x01A6, 'R'),
  (0x01A7, '2'), (0x01AB, 't'), (0x01AD, 't'), (0x01AE, 'T'), (0x01B4, 'y'), (0x01B5, 'Z'), (0x01B6, 'z'),
  (0x01B7, '3'), (0x01BB, '2'), (0x01BC, '5'), (0x01BD, 's'), (0x01BF, 'p'), (0x01C0, 'l'), (0x01C1, 'll'),
  (0x01C4, 'DZ'), (0x01C5, 'Dz'), (0x01C6, 'dz'), (0x01C7, 'LJ'), (0x01C8, 'Lj'), (0x01C9, 'lj'), (0x01CA, 'NJ'),
  (0x01CB, 'Nj'), (0x01CC, 'nj'), (0x01E4, 'G'), (0x01E5, 'g'), (0x01F1, 'DZ'), (0x01F2, 'Dz'), (0x01F3, 'dz'),
  (0x021C, '3'), (0x0222, '8'), (0x0223, '8'), (0x0224, 'Z'), (0x0225, 'z'), (0x0237, 'j'), (0x023C, 'c'),
  (0x023E, 'T'), (0x0244, 'U'), (0x0246, 'E'), (0x0247, 'e'), (0x0248, 'J'), (0x0249, 'j'), (0x024C, 'R'),
  (0x024D, 'r'), (0x024E, 'Y'), (0x024F, 'y'), (0x0251, 'a'), (0x0253, 'b'), (0x0256, 'd'), (0x0257, 'd'),
  (0x025F, 'j'), (0x0260, 'g'), (0x0261, 'g'), (0x0263, 'y'), (0x0266, 'h'), (0x0268, 'i'), (0x0269, 'i'),
  (0x026A, 'i'), (0x026B, 'l'), (0x026D, 'l'), (0x026F, 'w'), (0x0271, 'rn'), (0x0272, 'n'), (0x0273, 'n'),
  (0x0275, 'o'), (0x027C, 'r'), (0x027D, 'r'), (0x0282, 's'), (0x0284, 'f'), (0x028B, 'u'), (0x028F, 'y'),
  (0x0290, 'z'), (0x02A0, 'q'), (0x02A3, 'dz'), (0x02A6, 'ts'), (0x02A9, 'fn'), (0x02AA, 'ls'), (0x02AB, 'lz'),
  (0x02D7, '-'), (0x037F, 'J'), (0x0391, 'A'), (0x0392, 'B'), (0x0395, 'E'), (0x0396, 'Z'), (0x0397, 'H'),
  (0x0398, 'O'), (0x0399, 'l'), (0x039A, 'K'), (0x039C, 'M'), (0x039D, 'N'), (0x039F, 'O'), (0x03A1, 'P'),
  (0x03A4, 'T'), (0x03A5, 'Y'), (0x03A7, 'X'), (0x03B1, 'a'), (0x03B3, 'y'), (0x03B7, 'n'), (0x03B8, 'O'),
  (0x03B9, 'i'), (0x03BD, 'v'), (0x03BF, 'o'), (0x03C1, 'p'), (0x03C3, 'o'), (0x03C5, 'u'), (0x03D1, 'O'),
  (0x03D2, 'Y'), (0x03DC, 'F'), (0x03E8, '2'), (0x03EC, '6'), (0x03ED, 'o'), (0x03F1, 'p'), (0x03F2, 'c'),
  (0x03F3, 'j'), (0x03F4, 'O'), (0x03F8, 'p'), (0x03F9, 'C'), (0x03FA, 'M'), (0x0405, 'S'), (0x0406, 'l'),
  (0x0408, 'J'), (0x0410, 'A'), (0x0411, 'b'), (0x0412, 'B'), (0x0415, 'E'), (0x0417, '3'), (0x041A, 'K'),
  (0x041C, 'M'), (0x041D, 'H'), (0x041E, 'O'), (0x0420, 'P'), (0x0421, 'C'), (0x0422, 'T'), (0x0423, 'Y'),
  (0x0425, 'X'), (0x042B, 'bl'), (0x042C, 'b'), (0x042E, 'lO'), (0x0430, 'a'), (0x0431, '6'), (0x0433, 'r'),
  (0x0435, 'e'), (0x043E, 'o'), (0x0440, 'p'), (0x0441, 'c'), (0x0443, 'y'), (0x0445, 'x'), (0x0448, 'w'),
  (0x0455, 's'), (0x0456, 'i'), (0x0458, 'j'), (0x045B, 'h'), (0x045F, 'u'), (0x0461, 'w'), (0x0462, 'b'),
  (0x0463, 'b'), (0x0472, 'O'), (0x0473, 'o'), (0x0474, 'V'), (0x0475, 'v'), (0x0478, 'Oy'), (0x0479, 'oy'),
  (0x047D, 'w'), (0x048C, 'b'), (0x048D, 'b'), (0x0493, 'r'), (0x0498, '3'), (0x049A, 'K'), (0x049E, 'K'),
  (0x04A2, 'H'), (0x04AA, 'C'), (0x04AB, 'c'), (0x04AC, 'T'), (0x04AE, 'Y'), (0x04AF, 'y'), (0x04B0, 'Y'),
  (0x04B1, 'y'), (0x04B2, 'X'), (0x04BA, 'h'), (0x04BB, 'h'), (0x04BD, 'e'), (0x04BF, 'e'), (0x04C0, 'l'),
  (0x04C7, 'H'), (0x04C9, 'H'), (0x04CD, 'M'), (0x04CF, 'l'), (0x04D4, 'AE'), (0x04D5, 'ae'), (0x04E0, '3'),
  (0x04E8, 'O'), (0x04E9, 'o'), (0x0501, 'd'), (0x050C, 'G'), (0x051A, 'Q'), (0x051B, 'q'), (0x051C, 'W'),
  (0x051D, 'w'), (0x0545, '3'), (0x054D, 'U'), (0x054F, 'S'), (0x0555, 'O'), (0x0560, 'rn'), (0x0561, 'w'),
  (0x0563, 'q'), (0x0566, 'q'), (0x0570, 'h'), (0x0572, 'n'), (0x0575, 'j'), (0x0578, 'n'), (0x057C, 'n'),
  (0x057D, 'u'), (0x0581, 'g'), (0x0582, 'i'), (0x0584, 'f'), (0x0585, 'o'), (0x05D5, 'l'), (0x05D8, 'v'),
  (0x05DF, 'l'), (0x05E1, 'o'), (0x05F0, 'll'), (0x0627, 'l'), (0x0629, 'o'), (0x0647, 'o'), (0x0673, 'l'),
  (0x06BE, 'o'), (0x06C1, 'o'), (0x06C3, 'o'), (0x06D4, '-'), (0x06D5, 'o'), (0x06FF, 'o'), (0x0701, '.'),
  (0x0702, '.'), (0x07CA, 'l'), (0x07CB, 'o'), (0x07CC, 'Y'), (0x07D3, 'F'), (0x07D5, 'b'), (0x07E0, 'T'),
  (0x0840, 'o'), (0x0B03, '8'), (0x0B20, 'O'), (0x0C02, 'o'), (0x0C82, 'o'), (0x0D02, 'o'), (0x0D1F, 's'),
  (0x0D20, 'o'), (0x0D82, 'o'), (0x1004, 'c'), (0x101D, 'o'), (0x105A, 'c'), (0x10B9, 'h'), (0x10BD, 'S'),
  (0x10C7, '2'), (0x10CD, 'Z'), (0x10E7, 'y'), (0x10FD, 'S'), (0x10FF, 'o'), (0x110B, 'o'), (0x1147, 'oo'),
  (0x11BC, 'o'), (0x11EE, 'oo'), (0x1200, 'U'), (0x12D0, 'O'), (0x1340, 'O'), (0x13A0, 'D'), (0x13A1, 'R'),
  (0x13A2, 'T'), (0x13A4, 'O'), (0x13A5, 'i'), (0x13A9, 'Y'), (0x13AA, 'A'), (0x13AB, 'J'), (0x13AC, 'E'),
  (0x13B3, 'W'), (0x13B7, 'M'), (0x13BB, 'H'), (0x13BD, 'Y'), (0x13BE, 'O'), (0x13BF, 't'), (0x13C0, 'G'),
  (0x13C2, 'h'), (0x13C3, 'Z'), (0x13CC, 'U'), (0x13CE, '4'), (0x13CF, 'b'), (0x13D2, 'R'), (0x13D4, 'W'),
  (0x13D5, 'S'), (0x13D9, 'V'), (0x13DA, 'S'), (0x13DE, 'L'), (0x13DF, 'C'), (0x13E2, 'P'), (0x13E6, 'K'),
  (0x13E7, 'd'), (0x13EB, 'O'), (0x13EE, '6'), (0x13F2, 'h'), (0x13F3, 'G'), (0x13F4, 'B'), (0x142F, 'V'),
  (0x144C, 'U'), (0x146D, 'P'), (0x146F, 'd'), (0x1472, 'b'), (0x1473, 'b'), (0x148D, 'J'), (0x14AA, 'L'),
  (0x14BF, '2'), (0x1541, 'x'), (0x157C, 'H'), (0x157D, 'x'), (0x1587, 'R'), (0x15AF, 'b'), (0x15B4, 'F'),
  (0x15C5, 'A'), (0x15DE, 'D'), (0x15EA, 'D'), (0x15F0, 'M'), (0x15F7, 'B'), (0x1616, '2'), (0x166D, 'X'),
  (0x16B7, 'X'), (0x16C1, 'l'), (0x16C5, 'l'), (0x16D0, 'l'), (0x16D5, 'K'), (0x16D6, 'M'), (0x1702, '3'),
  (0x172A, '7'), (0x1735, '/'), (0x174D, '-'), (0x1763, 'x'), (0x1A45, 'o'), (0x1BEA, 'o'), (0x1BEC, 'x'),
  (0x1BF3, '-'), (0x1C82, 'o'), (0x1C83, 'c'), (0x1C84, '7'), (0x1C95, '3'), (0x1CB7, '2'), (0x1CBD, 'S'),
  (0x1CBF, 'O'), (0x1CF5, 'X'), (0x1D04, 'c'), (0x1D0F, 'o'), (0x1D11, 'o'), (0x1D1C, 'u'), (0x1D20, 'v'),
  (0x1D21, 'w'), (0x1D22, 'z'), (0x1D26, 'r'), (0x1D6B, 'ue'), (0x1D6E, 'f'), (0x1D6F, 'rn'), (0x1D70, 'n'),
  (0x1D72, 'r'), (0x1D74, 's'), (0x1D75, 't'), (0x1D76, 'z'), (0x1D7B, 'i'), (0x1D7C, 'i'), (0x1D7D, 'p'),
  (0x1D7E, 'u'), (0x1D83, 'g'), (0x1D8C, 'y'), (0x1E9D, 'f'), (0x1EFA, 'lL'), (0x1EFF, 'y'), (0x2010, '-'),
  (0x2011, '-'), (0x2012, '-'), (0x2013, '-'), (0x2024, '.'), (0x2025, '..'), (0x2026, '...'), (0x2041, '/'),
  (0x2043, '-'), (0x2044, '/'), (0x20A1, 'C'), (0x20A5, 'rn'), (0x20A8, 'Rs'), (0x20A9, 'W'), (0x20AB, 'd'),
  (0x20AD, 'K'), (0x20AE, 'T'), (0x20B6, 'lt'), (0x2100, 'a/c'), (0x2101, 'a/s'), (0x2102, 'C'), (0x2105, 'c/o'),
  (0x2106, 'c/u'), (0x210A, 'g'), (0x210B, 'H'), (0x210C, 'H'), (0x210D, 'H'), (0x210E, 'h'), (0x210F, 'h'),
  (0x2112, 'L'), (0x2113, 'l'), (0x2115, 'N'), (0x2116, 'No'), (0x2119, 'P'), (0x211A, 'Q'), (0x211B, 'R'),
  (0x211C, 'R'), (0x211D, 'R'), (0x2121, 'TEL'), (0x2124, 'Z'), (0x2128, 'Z'), (0x212C, 'B'), (0x212D, 'C'),
  (0x212E, 'e'), (0x212F, 'e'), (0x2130, 'E'), (0x2131, 'F'), (0x2133, 'M'), (0x2134, 'o'), (0x2139, 'i'),
  (0x213B, 'FAX'), (0x213D, 'y'), (0x2145, 'D'), (0x2146, 'd'), (0x2147, 'e'), (0x2148, 'i'), (0x2149, 'j'),
  (0x2154, '2/3'), (0x2156, '2/5'), (0x2157, '3/5'), (0x2158, '4/5'), (0x215A, '5/6'), (0x215C, '3/8'),
  (0x215D, '5/8'), (0x215E, '7/8'), (0x2164, 'V'), (0x2169, 'X'), (0x216C, 'L'), (0x216D, 'C'), (0x216E, 'D'),
  (0x216F, 'M'), (0x2170, 'i'), (0x2171, 'ii'), (0x2172, 'iii'), (0x2173, 'iv'), (0x2174, 'v'), (0x2175, 'vi'),
  (0x2176, 'vii'), (0x2177, 'viii'), (0x2178, 'ix'), (0x2179, 'x'), (0x217A, 'xi'), (0x217B, 'xii'), (0x217C, 'l'),
  (0x217D, 'c'), (0x217E, 'd'), (0x21BF, 'l'), (0x2205, 'O'), (0x2212, '-'), (0x2215, '/'), (0x221E, 'oo'),
  (0x2223, 'l'), (0x2225, 'll'), (0x2228, 'v'), (0x222A, 'U'), (0x2238, '-'), (0x2296, 'O'), (0x229D, 'O'),
  (0x22A4, 'T'), (0x22C1, 'v'), (0x22C3, 'U'), (0x22FF, 'E'), (0x2300, 'O'), (0x2361, 'T'), (0x2365, 'O'),
  (0x236C, 'O'), (0x2373, 'i'), (0x2374, 'p'), (0x2376, 'a'), (0x2378, 'i'), (0x237A, 'a'), (0x23FD, 'l'),
  (0x2489, '2.'), (0x248A, '3.'), (0x248B, '4.'), (0x248C, '5.'), (0x248D, '6.'), (0x248E, '7.'), (0x248F, '8.'),
  (0x2490, '9.'), (0x2502, 'l'), (0x2503, 'l'), (0x2571, '/'), (0x2573, 'X'), (0x2796, '-'), (0x27CB, '/'),
  (0x27D9, 'T'), (0x292B, 'x'), (0x292C, 'x'), (0x29E2, 'w'), (0x29F6, '/'), (0x29F8, '/'), (0x2A29, '-'),
  (0x2A2A, '-'), (0x2A2F, 'x'), (0x2A30, 'x'), (0x2AFB, '///'), (0x2AFD, '//'), (0x2C67, 'H'), (0x2C69, 'K'),
  (0x2C6B, 'Z'), (0x2C6C, 'z'), (0x2C82, 'B'), (0x2C85, 'r'), (0x2C8C, 'Z'), (0x2C8D, 'z'), (0x2C8E, 'H'),
  (0x2C90, 'O'), (0x2C91, 'o'), (0x2C92, 'l'), (0x2C93, 'i'), (0x2C94, 'K'), (0x2C98, 'M'), (0x2C9A, 'N'),
  (0x2C9C, '3'), (0x2C9E, 'O'), (0x2C9F, 'o'), (0x2CA2, 'P'), (0x2CA3, 'p'), (0x2CA4, 'C'), (0x2CA5, 'c'),
  (0x2CA6, 'T'), (0x2CA8, 'Y'), (0x2CA9, 'y'), (0x2CAC, 'X'), (0x2CB2, '-'), (0x2CB3, '-'), (0x2CBA, '-'),
  (0x2CBB, '-'), (0x2CBD, 'w'), (0x2CC4, '3'), (0x2CC6, '/'), (0x2CC7, '/'), (0x2CCA, '9'), (0x2CCB, '9'),
  (0x2CCC, '3'), (0x2CCE, 'P'), (0x2CCF, 'p'), (0x2CD0, 'L'), (0x2CD2, '6'), (0x2CD3, '6'), (0x2CDC, '6'),
  (0x2D2D, 'z'), (0x2D31, 'O'), (0x2D38, 'V'), (0x2D39, 'E'), (0x2D41, 'O'), (0x2D4A, 'l'), (0x2D4F, 'l'),
  (0x2D54, 'O'), (0x2D55, 'Q'), (0x2D5D, 'X'), (0x2E1A, '-'), (0x2F03, '/'), (0x3007, 'O'), (0x3033, '/'),
  (0x30CE, '/'), (0x3112, 'T'), (0x311A, 'Y'), (0x3147, 'o'), (0x3180, 'oo'), (0x31D2, '/'), (0x31D3, '/'),
  (0x3250, 'PTE'), (0x32CC, 'Hg'), (0x32CD, 'erg'), (0x32CE, 'eV'), (0x32CF, 'LTD'), (0x3371, 'hPa'), (0x3372, 'da'),
  (0x3373, 'AU'), (0x3374, 'bar'), (0x3375, 'oV'), (0x3376, 'pc'), (0x3380, 'pA'), (0x3381, 'nA'), (0x3384, 'kA'),
  (0x3385, 'KB'), (0x3386, 'MB'), (0x3387, 'GB'), (0x3388, 'cal'), (0x3389, 'kcal'), (0x338A, 'pF'), (0x338B, 'nF'),
  (0x338F, 'kg'), (0x3390, 'Hz'), (0x3391, 'kHz'), (0x3392, 'MHz'), (0x3393, 'GHz'), (0x3394, 'THz'), (0x3397, 'dl'),
  (0x3398, 'kl'), (0x33A9, 'Pa'), (0x33AA, 'kPa'), (0x33AB, 'MPa'), (0x33AC, 'GPa'), (0x33AD, 'rad'),
  (0x33AE, 'rad/s'), (0x33B0, 'ps'), (0x33B1, 'ns'), (0x33B4, 'pV'), (0x33B5, 'nV'), (0x33B8, 'kV'), (0x33B9, 'MV'),
  (0x33BA, 'pW'), (0x33BB, 'nW'), (0x33BE, 'kW'), (0x33BF, 'MW'), (0x33C3, 'Bq'), (0x33C4, 'cc'), (0x33C5, 'cd'),
  (0x33C6, 'C/kg'), (0x33C7, 'Co.'), (0x33C8, 'dB'), (0x33C9, 'Gy'), (0x33CA, 'ha'), (0x33CB, 'HP'), (0x33CC, 'in'),
  (0x33CD, 'KK'), (0x33CE, 'KM'), (0x33CF, 'kt'), (0x33D1, 'ln'), (0x33D2, 'log'), (0x33D3, 'lx'), (0x33D7, 'PH'),
  (0x33D9, 'PPM'), (0x33DA, 'PR'), (0x33DB, 'sr'), (0x33DC, 'Sv'), (0x33DD, 'Wb'), (0x33FF, 'gal'), (0x4E05, 'T'),
  (0x4E2B, 'Y'), (0x4E3F, '/'), (0xA4D0, 'B'), (0xA4D1, 'P'), (0xA4D2, 'd'), (0xA4D3, 'D'), (0xA4D4, 'T'),
  (0xA4D6, 'G'), (0xA4D7, 'K'), (0xA4D9, 'J'), (0xA4DA, 'C'), (0xA4DC, 'Z'), (0xA4DD, 'F'), (0xA4DF, 'M'),
  (0xA4E0, 'N'), (0xA4E1, 'L'), (0xA4E2, 'S'), (0xA4E3, 'R'), (0xA4E6, 'V'), (0xA4E7, 'H'), (0xA4EA, 'W'),
  (0xA4EB, 'X'), (0xA4EC, 'Y'), (0xA4EE, 'A'), (0xA4F0, 'E'), (0xA4F2, 'l'), (0xA4F3, 'O'), (0xA4F4, 'U'),
  (0xA4F8, '.'), (0xA4FA, '..'), (0xA4FE, '-.'), (0xA50B, 'T'), (0xA516, 'lll'), (0xA543, '6'), (0xA557, 'B'),
  (0xA56F, 'l'), (0xA576, 'S'), (0xA589, '8'), (0xA5CB, 'E'), (0xA60E, '.'), (0xA644, '2'), (0xA647, 'i'),
  (0xA68C, 'T'), (0xA695, 'h'), (0xA698, 'OO'), (0xA699, 'oo'), (0xA6A2, 'o'), (0xA6B2, 'Y'), (0xA6C9, 'Z'),
  (0xA6DF, 'V'), (0xA6EF, '2'), (0xA728, 'T3'), (0xA731, 's'), (0xA732, 'AA'), (0xA733, 'aa'), (0xA734, 'AO'),
  (0xA735, 'ao'), (0xA736, 'AU'), (0xA737, 'au'), (0xA738, 'AV'), (0xA739, 'av'), (0xA73A, 'AV'), (0xA73B, 'av'),
  (0xA73C, 'AY'), (0xA73D, 'ay'), (0xA740, 'K'), (0xA74A, 'O'), (0xA74B, 'o'), (0xA74E, 'OO'), (0xA74F, 'oo'),
  (0xA75A, '2'), (0xA761, 'w'), (0xA76A, '3'), (0xA76E, '9'), (0xA76F, '9'), (0xA777, 'tf'), (0xA781, 'l'),
  (0xA798, 'F'), (0xA799, 'f'), (0xA79F, 'u'), (0xA7AB, '3'), (0xA7AE, 'l'), (0xA7B2, 'J'), (0xA7B3, 'X'),
  (0xA7B4, 'B'), (0xA7C5, 'S'), (0xA7FA, 'w'), (0xA7FE, 'l'), (0xA830, 'l'), (0xA8F6, '3'), (0xAA7D, '-'),
  (0xAB32, 'e'), (0xAB35, 'f'), (0xAB3D, 'o'), (0xAB3E, 'o'), (0xAB43, 'co'), (0xAB44, 'co'), (0xAB47, 'r'),
  (0xAB48, 'r'), (0xAB4E, 'u'), (0xAB51, 'rn'), (0xAB52, 'u'), (0xAB5A, 'y'), (0xAB63, 'uo'), (0xAB64, 'a'),
  (0xAB74, 'o'), (0xAB75, 'i'), (0xAB81, 'r'), (0xAB83, 'w'), (0xAB8E, 'o'), (0xAB93, 'z'), (0xAB9C, 'u'),
  (0xAB9E, '4'), (0xABA4, 'w'), (0xABA9, 'v'), (0xABAA, 's'), (0xABAF, 'c'), (0xABBB, 'o'), (0xABBE, '6'),
  (0xABEC, '.'), (0xFB00, 'ff'), (0xFB01, 'fi'), (0xFB02, 'fl'), (0xFB03, 'ffi'), (0xFB04, 'ffl'), (0xFB06, 'st'),
  (0xFB29, '-'), (0xFBA4, 'o'), (0xFBA5, 'o'), (0xFBA6, 'o'), (0xFBA7, 'o'), (0xFBA8, 'o'), (0xFBA9, 'o'),
  (0xFBAA, 'o'), (0xFBAB, 'o'), (0xFBAC, 'o'), (0xFBAD, 'o'), (0xFCD9, 'o'), (0xFD3C, 'l'), (0xFD3D, 'l'),
  (0xFE52, '.'), (0xFE58, '-'), (0xFE63, '-'), (0xFE81, 'l'), (0xFE82, 'l'), (0xFE87, 'l'), (0xFE88, 'l'),
  (0xFE8D, 'l'), (0xFE8E, 'l'), (0xFE93, 'o'), (0xFE94, 'o'), (0xFEE9, 'o'), (0xFEEA, 'o'), (0xFEEB, 'o'),
  (0xFEEC, 'o'), (0xFF0E, '.'), (0xFF0F, '/'), (0xFF21, 'A'), (0xFF22, 'B'), (0xFF23, 'C'), (0xFF24, 'D'),
  (0xFF25, 'E'), (0xFF26, 'F'), (0xFF27, 'G'), (0xFF28, 'H'), (0xFF2A, 'J'), (0xFF2B, 'K'), (0xFF2C, 'L'),
  (0xFF2D, 'M'), (0xFF2E, 'N'), (0xFF2F, 'O'), (0xFF30, 'P'), (0xFF31, 'Q'), (0xFF32, 'R'), (0xFF33, 'S'),
  (0xFF34, 'T'), (0xFF35, 'U'), (0xFF36, 'V'), (0xFF37, 'W'), (0xFF38, 'X'), (0xFF39, 'Y'), (0xFF3A, 'Z'),
  (0xFF41, 'a'), (0xFF42, 'b'), (0xFF43, 'c'), (0xFF44, 'd'), (0xFF45, 'e'), (0xFF46, 'f'), (0xFF47, 'g'),
  (0xFF48, 'h'), (0xFF49, 'i'), (0xFF4A, 'j'), (0xFF4B, 'k'), (0xFF4C, 'l'), (0xFF4E, 'n'), (0xFF4F, 'o'),
  (0xFF50, 'p'), (0xFF51, 'q'), (0xFF52, 'r'), (0xFF53, 's'), (0xFF54, 't'), (0xFF55, 'u'), (0xFF56, 'v'),
  (0xFF57, 'w'), (0xFF58, 'x'), (0xFF59, 'y'), (0xFF5A, 'z'), (0xFF5C, 'l'), (0xFF89, '/'), (0xFFB7, 'o'),
  (0xFFE0, 'c'), (0xFFE5, 'Y'), (0xFFE6, 'W'), (0xFFE8, 'l'), (0x1017E, 'f'), (0x1018B, 'd'), (0x1018E, 'N'),
  (0x10191, '-'), (0x10196, 'X'), (0x10197, 'V'), (0x10198, 'llS'), (0x10199, 'll'), (0x10282, 'B'), (0x10286, 'E'),
  (0x10287, 'F'), (0x1028A, 'l'), (0x10290, 'X'), (0x10292, 'O'), (0x10295, 'P'), (0x10296, 'S'), (0x10297, 'T'),
  (0x102A0, 'A'), (0x102A1, 'B'), (0x102A2, 'C'), (0x102A5, 'F'), (0x102AB, 'O'), (0x102B0, 'M'), (0x102B1, 'T'),
  (0x102B2, 'Y'), (0x102B4, 'X'), (0x102CF, 'H'), (0x102F5, 'Z'), (0x10301, 'B'), (0x10302, 'C'), (0x10309, 'l'),
  (0x1030F, 'O'), (0x10311, 'M'), (0x10315, 'T'), (0x10317, 'X'), (0x1031A, '8'), (0x1031C, 'b'), (0x10320, 'l'),
  (0x10322, 'X'), (0x10404, 'O'), (0x10415, 'C'), (0x1041B, 'L'), (0x10420, 'S'), (0x1042C, 'o'), (0x1043D, 'c'),
  (0x10448, 's'), (0x104B4, 'R'), (0x104C2, 'O'), (0x104CE, 'U'), (0x104D2, '7'), (0x104EA, 'o'), (0x104F6, 'u'),
  (0x10507, 'Z'), (0x1050E, 'l'), (0x10513, 'N'), (0x10516, 'O'), (0x10518, 'K'), (0x1051B, 'C'), (0x1051D, 'V'),
  (0x1051E, 'O'), (0x10525, 'F'), (0x10526, 'L'), (0x10527, 'X'), (0x10926, 'l'), (0x1092C, 'o'), (0x10A50, '.'),
  (0x10C13, 'X'), (0x10C17, 'O'), (0x10C1F, 'V'), (0x10C20, 'Y'), (0x10C21, 'M'), (0x10C3E, 'l'), (0x10C82, 'X'),
  (0x10CA5, 'l'), (0x10CC2, 'x'), (0x10CFA, 'l'), (0x10CFC, 'X'), (0x10D07, 'o'), (0x11124, 'o'), (0x11302, 'o'),
  (0x11445, '8'), (0x114C5, 'w'), (0x11700, 'rn'), (0x11706, 'v'), (0x1170A, 'w'), (0x1170E, 'w'), (0x1170F, 'w'),
  (0x118A0, 'V'), (0x118A2, 'F'), (0x118A3, 'L'), (0x118A4, 'Y'), (0x118A6, 'E'), (0x118A9, 'Z'), (0x118AC, '9'),
  (0x118AE, 'E'), (0x118AF, '4'), (0x118B2, 'L'), (0x118B5, 'O'), (0x118B8, 'U'), (0x118BB, '5'), (0x118BC, 'T'),
  (0x118C0, 'v'), (0x118C1, 's'), (0x118C2, 'F'), (0x118C3, 'i'), (0x118C4, 'y'), (0x118C6, '7'), (0x118C8, 'o'),
  (0x118CA, '3'), (0x118CC, '9'), (0x118D5, '6'), (0x118D6, '9'), (0x118D7, 'o'), (0x118D8, 'u'), (0x118DC, 'y'),
  (0x118EC, 'X'), (0x118EF, 'W'), (0x118F2, 'C'), (0x11ABC, 'Z'), (0x11ABE, 'N'), (0x11DDA, 'l'), (0x1699B, 'O'),
  (0x169C1, '9'), (0x169FE, '8'), (0x16A19, 'r'), (0x16AD6, 'S'), (0x16AE4, 'l'), (0x16AE9, 'O'), (0x16D63, 'l'),
  (0x16E80, 'O'), (0x16E82, '4'), (0x16E8A, '7'), (0x16EAA, 'l'), (0x16EB6, 'b'), (0x16F08, 'V'), (0x16F0A, 'T'),
  (0x16F16, 'L'), (0x16F28, 'l'), (0x16F35, 'R'), (0x16F3A, 'S'), (0x16F3B, '3'), (0x16F40, 'A'), (0x16F42, 'U'),
  (0x16F43, 'Y'), (0x1CCD6, 'A'), (0x1CCD7, 'B'), (0x1CCD8, 'C'), (0x1CCD9, 'D'), (0x1CCDA, 'E'), (0x1CCDB, 'F'),
  (0x1CCDC, 'G'), (0x1CCDD, 'H'), (0x1CCDF, 'J'), (0x1CCE0, 'K'), (0x1CCE1, 'L'), (0x1CCE2, 'M'), (0x1CCE3, 'N'),
  (0x1CCE4, 'O'), (0x1CCE5, 'P'), (0x1CCE6, 'Q'), (0x1CCE7, 'R'), (0x1CCE8, 'S'), (0x1CCE9, 'T'), (0x1CCEA, 'U'),
  (0x1CCEB, 'V'), (0x1CCEC, 'W'), (0x1CCED, 'X'), (0x1CCEE, 'Y'), (0x1CCEF, 'Z'), (0x1CEFC, 'V'), (0x1D100, 'l'),
  (0x1D134, 'c'), (0x1D16D, '.'), (0x1D1FE, '7'), (0x1D206, '3'), (0x1D207, 'b'), (0x1D20C, 'W'), (0x1D20D, 'V'),
  (0x1D212, '7'), (0x1D213, 'F'), (0x1D216, 'R'), (0x1D21A, 'O'), (0x1D22A, 'L'), (0x1D23A, '/'), (0x1D262, 'll'),
  (0x1D373, 'T'), (0x1D377, 'l'), (0x1D400, 'A'), (0x1D401, 'B'), (0x1D402, 'C'), (0x1D403, 'D'), (0x1D404, 'E'),
  (0x1D405, 'F'), (0x1D406, 'G'), (0x1D407, 'H'), (0x1D409, 'J'), (0x1D40A, 'K'), (0x1D40B, 'L'), (0x1D40C, 'M'),
  (0x1D40D, 'N'), (0x1D40E, 'O'), (0x1D40F, 'P'), (0x1D410, 'Q'), (0x1D411, 'R'), (0x1D412, 'S'), (0x1D413, 'T'),
  (0x1D414, 'U'), (0x1D415, 'V'), (0x1D416, 'W'), (0x1D417, 'X'), (0x1D418, 'Y'), (0x1D419, 'Z'), (0x1D41A, 'a'),
  (0x1D41B, 'b'), (0x1D41C, 'c'), (0x1D41D, 'd'), (0x1D41E, 'e'), (0x1D41F, 'f'), (0x1D420, 'g'), (0x1D421, 'h'),
  (0x1D422, 'i'), (0x1D423, 'j'), (0x1D424, 'k'), (0x1D425, 'l'), (0x1D427, 'n'), (0x1D428, 'o'), (0x1D429, 'p'),
  (0x1D42A, 'q'), (0x1D42B, 'r'), (0x1D42C, 's'), (0x1D42D, 't'), (0x1D42E, 'u'), (0x1D42F, 'v'), (0x1D430, 'w'),
  (0x1D431, 'x'), (0x1D432, 'y'), (0x1D433, 'z'), (0x1D434, 'A'), (0x1D435, 'B'), (0x1D436, 'C'), (0x1D437, 'D'),
  (0x1D438, 'E'), (0x1D439, 'F'), (0x1D43A, 'G'), (0x1D43B, 'H'), (0x1D43D, 'J'), (0x1D43E, 'K'), (0x1D43F, 'L'),
  (0x1D440, 'M'), (0x1D441, 'N'), (0x1D442, 'O'), (0x1D443, 'P'), (0x1D444, 'Q'), (0x1D445, 'R'), (0x1D446, 'S'),
  (0x1D447, 'T'), (0x1D448, 'U'), (0x1D449, 'V'), (0x1D44A, 'W'), (0x1D44B, 'X'), (0x1D44C, 'Y'), (0x1D44D, 'Z'),
  (0x1D44E, 'a'), (0x1D44F, 'b'), (0x1D450, 'c'), (0x1D451, 'd'), (0x1D452, 'e'), (0x1D453, 'f'), (0x1D454, 'g'),
  (0x1D456, 'i'), (0x1D457, 'j'), (0x1D458, 'k'), (0x1D459, 'l'), (0x1D45B, 'n'), (0x1D45C, 'o'), (0x1D45D, 'p'),
  (0x1D45E, 'q'), (0x1D45F, 'r'), (0x1D460, 's'), (0x1D461, 't'), (0x1D462, 'u'), (0x1D463, 'v'), (0x1D464, 'w'),
  (0x1D465, 'x'), (0x1D466, 'y'), (0x1D467, 'z'), (0x1D468, 'A'), (0x1D469, 'B'), (0x1D46A, 'C'), (0x1D46B, 'D'),
  (0x1D46C, 'E'), (0x1D46D, 'F'), (0x1D46E, 'G'), (0x1D46F, 'H'), (0x1D471, 'J'), (0x1D472, 'K'), (0x1D473, 'L'),
  (0x1D474, 'M'), (0x1D475, 'N'), (0x1D476, 'O'), (0x1D477, 'P'), (0x1D478, 'Q'), (0x1D479, 'R'), (0x1D47A, 'S'),
  (0x1D47B, 'T'), (0x1D47C, 'U'), (0x1D47D, 'V'), (0x1D47E, 'W'), (0x1D47F, 'X'), (0x1D480, 'Y'), (0x1D481, 'Z'),
  (0x1D482, 'a'), (0x1D483, 'b'), (0x1D484, 'c'), (0x1D485, 'd'), (0x1D486, 'e'), (0x1D487, 'f'), (0x1D488, 'g'),
  (0x1D489, 'h'), (0x1D48A, 'i'), (0x1D48B, 'j'), (0x1D48C, 'k'), (0x1D48D, 'l'), (0x1D48F, 'n'), (0x1D490, 'o'),
  (0x1D491, 'p'), (0x1D492, 'q'), (0x1D493, 'r'), (0x1D494, 's'), (0x1D495, 't'), (0x1D496, 'u'), (0x1D497, 'v'),
  (0x1D498, 'w'), (0x1D499, 'x'), (0x1D49A, 'y'), (0x1D49B, 'z'), (0x1D49C, 'A'), (0x1D49E, 'C'), (0x1D49F, 'D'),
  (0x1D4A2, 'G'), (0x1D4A5, 'J'), (0x1D4A6, 'K'), (0x1D4A9, 'N'), (0x1D4AA, 'O'), (0x1D4AB, 'P'), (0x1D4AC, 'Q'),
  (0x1D4AE, 'S'), (0x1D4AF, 'T'), (0x1D4B0, 'U'), (0x1D4B1, 'V'), (0x1D4B2, 'W'), (0x1D4B3, 'X'), (0x1D4B4, 'Y'),
  (0x1D4B5, 'Z'), (0x1D4B6, 'a'), (0x1D4B7, 'b'), (0x1D4B8, 'c'), (0x1D4B9, 'd'), (0x1D4BB, 'f'), (0x1D4BD, 'h'),
  (0x1D4BE, 'i'), (0x1D4BF, 'j'), (0x1D4C0, 'k'), (0x1D4C1, 'l'), (0x1D4C3, 'n'), (0x1D4C5, 'p'), (0x1D4C6, 'q'),
  (0x1D4C7, 'r'), (0x1D4C8, 's'), (0x1D4C9, 't'), (0x1D4CA, 'u'), (0x1D4CB, 'v'), (0x1D4CC, 'w'), (0x1D4CD, 'x'),
  (0x1D4CE, 'y'), (0x1D4CF, 'z'), (0x1D4D0, 'A'), (0x1D4D1, 'B'), (0x1D4D2, 'C'), (0x1D4D3, 'D'), (0x1D4D4, 'E'),
  (0x1D4D5, 'F'), (0x1D4D6, 'G'), (0x1D4D7, 'H'), (0x1D4D9, 'J'), (0x1D4DA, 'K'), (0x1D4DB, 'L'), (0x1D4DC, 'M'),
  (0x1D4DD, 'N'), (0x1D4DE, 'O'), (0x1D4DF, 'P'), (0x1D4E0, 'Q'), (0x1D4E1, 'R'), (0x1D4E2, 'S'), (0x1D4E3, 'T'),
  (0x1D4E4, 'U'), (0x1D4E5, 'V'), (0x1D4E6, 'W'), (0x1D4E7, 'X'), (0x1D4E8, 'Y'), (0x1D4E9, 'Z'), (0x1D4EA, 'a'),
  (0x1D4EB, 'b'), (0x1D4EC, 'c'), (0x1D4ED, 'd'), (0x1D4EE, 'e'), (0x1D4EF, 'f'), (0x1D4F0, 'g'), (0x1D4F1, 'h'),
  (0x1D4F2, 'i'), (0x1D4F3, 'j'), (0x1D4F4, 'k'), (0x1D4F5, 'l'), (0x1D4F7, 'n'), (0x1D4F8, 'o'), (0x1D4F9, 'p'),
  (0x1D4FA, 'q'), (0x1D4FB, 'r'), (0x1D4FC, 's'), (0x1D4FD, 't'), (0x1D4FE, 'u'), (0x1D4FF, 'v'), (0x1D500, 'w'),
  (0x1D501, 'x'), (0x1D502, 'y'), (0x1D503, 'z'), (0x1D504, 'A'), (0x1D505, 'B'), (0x1D507, 'D'), (0x1D508, 'E'),
  (0x1D509, 'F'), (0x1D50A, 'G'), (0x1D50D, 'J'), (0x1D50E, 'K'), (0x1D50F, 'L'), (0x1D510, 'M'), (0x1D511, 'N'),
  (0x1D512, 'O'), (0x1D513, 'P'), (0x1D514, 'Q'), (0x1D516, 'S'), (0x1D517, 'T'), (0x1D518, 'U'), (0x1D519, 'V'),
  (0x1D51A, 'W'), (0x1D51B, 'X'), (0x1D51C, 'Y'), (0x1D51E, 'a'), (0x1D51F, 'b'), (0x1D520, 'c'), (0x1D521, 'd'),
  (0x1D522, 'e'), (0x1D523, 'f'), (0x1D524, 'g'), (0x1D525, 'h'), (0x1D526, 'i'), (0x1D527, 'j'), (0x1D528, 'k'),
  (0x1D529, 'l'), (0x1D52B, 'n'), (0x1D52C, 'o'), (0x1D52D, 'p'), (0x1D52E, 'q'), (0x1D52F, 'r'), (0x1D530, 's'),
  (0x1D531, 't'), (0x1D532, 'u'), (0x1D533, 'v'), (0x1D534, 'w'), (0x1D535, 'x'), (0x1D536, 'y'), (0x1D537, 'z'),
  (0x1D538, 'A'), (0x1D539, 'B'), (0x1D53B, 'D'), (0x1D53C, 'E'), (0x1D53D, 'F'), (0x1D53E, 'G'), (0x1D541, 'J'),
  (0x1D542, 'K'), (0x1D543, 'L'), (0x1D544, 'M'), (0x1D546, 'O'), (0x1D54A, 'S'), (0x1D54B, 'T'), (0x1D54C, 'U'),
  (0x1D54D, 'V'), (0x1D54E, 'W'), (0x1D54F, 'X'), (0x1D550, 'Y'), (0x1D552, 'a'), (0x1D553, 'b'), (0x1D554, 'c'),
  (0x1D555, 'd'), (0x1D556, 'e'), (0x1D557, 'f'), (0x1D558, 'g'), (0x1D559, 'h'), (0x1D55A, 'i'), (0x1D55B, 'j'),
  (0x1D55C, 'k'), (0x1D55D, 'l'), (0x1D55F, 'n'), (0x1D560, 'o'), (0x1D561, 'p'), (0x1D562, 'q'), (0x1D563, 'r'),
  (0x1D564, 's'), (0x1D565, 't'), (0x1D566, 'u'), (0x1D567, 'v'), (0x1D568, 'w'), (0x1D569, 'x'), (0x1D56A, 'y'),
  (0x1D56B, 'z'), (0x1D56C, 'A'), (0x1D56D, 'B'), (0x1D56E, 'C'), (0x1D56F, 'D'), (0x1D570, 'E'), (0x1D571, 'F'),
  (0x1D572, 'G'), (0x1D573, 'H'), (0x1D575, 'J'), (0x1D576, 'K'), (0x1D577, 'L'), (0x1D578, 'M'), (0x1D579, 'N'),
  (0x1D57A, 'O'), (0x1D57B, 'P'), (0x1D57C, 'Q'), (0x1D57D, 'R'), (0x1D57E, 'S'), (0x1D57F, 'T'), (0x1D580, 'U'),
  (0x1D581, 'V'), (0x1D582, 'W'), (0x1D583, 'X'), (0x1D584, 'Y'), (0x1D585, 'Z'), (0x1D586, 'a'), (0x1D587, 'b'),
  (0x1D588, 'c'), (0x1D589, 'd'), (0x1D58A, 'e'), (0x1D58B, 'f'), (0x1D58C, 'g'), (0x1D58D, 'h'), (0x1D58E, 'i'),
  (0x1D58F, 'j'), (0x1D590, 'k'), (0x1D591, 'l'), (0x1D593, 'n'), (0x1D594, 'o'), (0x1D595, 'p'), (0x1D596, 'q'),
  (0x1D597, 'r'), (0x1D598, 's'), (0x1D599, 't'), (0x1D59A, 'u'), (0x1D59B, 'v'), (0x1D59C, 'w'), (0x1D59D, 'x'),
  (0x1D59E, 'y'), (0x1D59F, 'z'), (0x1D5A0, 'A'), (0x1D5A1, 'B'), (0x1D5A2, 'C'), (0x1D5A3, 'D'), (0x1D5A4, 'E'),
  (0x1D5A5, 'F'), (0x1D5A6, 'G'), (0x1D5A7, 'H'), (0x1D5A9, 'J'), (0x1D5AA, 'K'), (0x1D5AB, 'L'), (0x1D5AC, 'M'),
  (0x1D5AD, 'N'), (0x1D5AE, 'O'), (0x1D5AF, 'P'), (0x1D5B0, 'Q'), (0x1D5B1, 'R'), (0x1D5B2, 'S'), (0x1D5B3, 'T'),
  (0x1D5B4, 'U'), (0x1D5B5, 'V'), (0x1D5B6, 'W'), (0x1D5B7, 'X'), (0x1D5B8, 'Y'), (0x1D5B9, 'Z'), (0x1D5BA, 'a'),
  (0x1D5BB, 'b'), (0x1D5BC, 'c'), (0x1D5BD, 'd'), (0x1D5BE, 'e'), (0x1D5BF, 'f'), (0x1D5C0, 'g'), (0x1D5C1, 'h'),
  (0x1D5C2, 'i'), (0x1D5C3, 'j'), (0x1D5C4, 'k'), (0x1D5C5, 'l'), (0x1D5C7, 'n'), (0x1D5C8, 'o'), (0x1D5C9, 'p'),
  (0x1D5CA, 'q'), (0x1D5CB, 'r'), (0x1D5CC, 's'), (0x1D5CD, 't'), (0x1D5CE, 'u'), (0x1D5CF, 'v'), (0x1D5D0, 'w'),
  (0x1D5D1, 'x'), (0x1D5D2, 'y'), (0x1D5D3, 'z'), (0x1D5D4, 'A'), (0x1D5D5, 'B'), (0x1D5D6, 'C'), (0x1D5D7, 'D'),
  (0x1D5D8, 'E'), (0x1D5D9, 'F'), (0x1D5DA, 'G'), (0x1D5DB, 'H'), (0x1D5DD, 'J'), (0x1D5DE, 'K'), (0x1D5DF, 'L'),
  (0x1D5E0, 'M'), (0x1D5E1, 'N'), (0x1D5E2, 'O'), (0x1D5E3, 'P'), (0x1D5E4, 'Q'), (0x1D5E5, 'R'), (0x1D5E6, 'S'),
  (0x1D5E7, 'T'), (0x1D5E8, 'U'), (0x1D5E9, 'V'), (0x1D5EA, 'W'), (0x1D5EB, 'X'), (0x1D5EC, 'Y'), (0x1D5ED, 'Z'),
  (0x1D5EE, 'a'), (0x1D5EF, 'b'), (0x1D5F0, 'c'), (0x1D5F1, 'd'), (0x1D5F2, 'e'), (0x1D5F3, 'f'), (0x1D5F4, 'g'),
  (0x1D5F5, 'h'), (0x1D5F6, 'i'), (0x1D5F7, 'j'), (0x1D5F8, 'k'), (0x1D5F9, 'l'), (0x1D5FB, 'n'), (0x1D5FC, 'o'),
  (0x1D5FD, 'p'), (0x1D5FE, 'q'), (0x1D5FF, 'r'), (0x1D600, 's'), (0x1D601, 't'), (0x1D602, 'u'), (0x1D603, 'v'),
  (0x1D604, 'w'), (0x1D605, 'x'), (0x1D606, 'y'), (0x1D607, 'z'), (0x1D608, 'A'), (0x1D609, 'B'), (0x1D60A, 'C'),
  (0x1D60B, 'D'), (0x1D60C, 'E'), (0x1D60D, 'F'), (0x1D60E, 'G'), (0x1D60F, 'H'), (0x1D611, 'J'), (0x1D612, 'K'),
  (0x1D613, 'L'), (0x1D614, 'M'), (0x1D615, 'N'), (0x1D616, 'O'), (0x1D617, 'P'), (0x1D618, 'Q'), (0x1D619, 'R'),
  (0x1D61A, 'S'), (0x1D61B, 'T'), (0x1D61C, 'U'), (0x1D61D, 'V'), (0x1D61E, 'W'), (0x1D61F, 'X'), (0x1D620, 'Y'),
  (0x1D621, 'Z'), (0x1D622, 'a'), (0x1D623, 'b'), (0x1D624, 'c'), (0x1D625, 'd'), (0x1D626, 'e'), (0x1D627, 'f'),
  (0x1D628, 'g'), (0x1D629, 'h'), (0x1D62A, 'i'), (0x1D62B, 'j'), (0x1D62C, 'k'), (0x1D62D, 'l'), (0x1D62F, 'n'),
  (0x1D630, 'o'), (0x1D631, 'p'), (0x1D632, 'q'), (0x1D633, 'r'), (0x1D634, 's'), (0x1D635, 't'), (0x1D636, 'u'),
  (0x1D637, 'v'), (0x1D638, 'w'), (0x1D639, 'x'), (0x1D63A, 'y'), (0x1D63B, 'z'), (0x1D63C, 'A'), (0x1D63D, 'B'),
  (0x1D63E, 'C'), (0x1D63F, 'D'), (0x1D640, 'E'), (0x1D641, 'F'), (0x1D642, 'G'), (0x1D643, 'H'), (0x1D645, 'J'),
  (0x1D646, 'K'), (0x1D647, 'L'), (0x1D648, 'M'), (0x1D649, 'N'), (0x1D64A, 'O'), (0x1D64B, 'P'), (0x1D64C, 'Q'),
  (0x1D64D, 'R'), (0x1D64E, 'S'), (0x1D64F, 'T'), (0x1D650, 'U'), (0x1D651, 'V'), (0x1D652, 'W'), (0x1D653, 'X'),
  (0x1D654, 'Y'), (0x1D655, 'Z'), (0x1D656, 'a'), (0x1D657, 'b'), (0x1D658, 'c'), (0x1D659, 'd'), (0x1D65A, 'e'),
  (0x1D65B, 'f'), (0x1D65C, 'g'), (0x1D65D, 'h'), (0x1D65E, 'i'), (0x1D65F, 'j'), (0x1D660, 'k'), (0x1D661, 'l'),
  (0x1D663, 'n'), (0x1D664, 'o'), (0x1D665, 'p'), (0x1D666, 'q'), (0x1D667, 'r'), (0x1D668, 's'), (0x1D669, 't'),
  (0x1D66A, 'u'), (0x1D66B, 'v'), (0x1D66C, 'w'), (0x1D66D, 'x'), (0x1D66E, 'y'), (0x1D66F, 'z'), (0x1D670, 'A'),
  (0x1D671, 'B'), (0x1D672, 'C'), (0x1D673, 'D'), (0x1D674, 'E'), (0x1D675, 'F'), (0x1D676, 'G'), (0x1D677, 'H'),
  (0x1D679, 'J'), (0x1D67A, 'K'), (0x1D67B, 'L'), (0x1D67C, 'M'), (0x1D67D, 'N'), (0x1D67E, 'O'), (0x1D67F, 'P'),
  (0x1D680, 'Q'), (0x1D681, 'R'), (0x1D682, 'S'), (0x1D683, 'T'), (0x1D684, 'U'), (0x1D685, 'V'), (0x1D686, 'W'),
  (0x1D687, 'X'), (0x1D688, 'Y'), (0x1D689, 'Z'), (0x1D68A, 'a'), (0x1D68B, 'b'), (0x1D68C, 'c'), (0x1D68D, 'd'),
  (0x1D68E, 'e'), (0x1D68F, 'f'), (0x1D690, 'g'), (0x1D691, 'h'), (0x1D692, 'i'), (0x1D693, 'j'), (0x1D694, 'k'),
  (0x1D695, 'l'), (0x1D697, 'n'), (0x1D698, 'o'), (0x1D699, 'p'), (0x1D69A, 'q'), (0x1D69B, 'r'), (0x1D69C, 's'),
  (0x1D69D, 't'), (0x1D69E, 'u'), (0x1D69F, 'v'), (0x1D6A0, 'w'), (0x1D6A1, 'x'), (0x1D6A2, 'y'), (0x1D6A3, 'z'),
  (0x1D6A4, 'i'), (0x1D6A5, 'j'), (0x1D6A8, 'A'), (0x1D6A9, 'B'), (0x1D6AC, 'E'), (0x1D6AD, 'Z'), (0x1D6AE, 'H'),
  (0x1D6AF, 'O'), (0x1D6B0, 'l'), (0x1D6B1, 'K'), (0x1D6B3, 'M'), (0x1D6B4, 'N'), (0x1D6B6, 'O'), (0x1D6B8, 'P'),
  (0x1D6B9, 'O'), (0x1D6BB, 'T'), (0x1D6BC, 'Y'), (0x1D6BE, 'X'), (0x1D6C2, 'a'), (0x1D6C4, 'y'), (0x1D6C8, 'n'),
  (0x1D6C9, 'O'), (0x1D6CA, 'i'), (0x1D6CE, 'v'), (0x1D6D0, 'o'), (0x1D6D2, 'p'), (0x1D6D4, 'o'), (0x1D6D6, 'u'),
  (0x1D6DD, 'O'), (0x1D6E0, 'p'), (0x1D6E2, 'A'), (0x1D6E3, 'B'), (0x1D6E6, 'E'), (0x1D6E7, 'Z'), (0x1D6E8, 'H'),
  (0x1D6E9, 'O'), (0x1D6EA, 'l'), (0x1D6EB, 'K'), (0x1D6ED, 'M'), (0x1D6EE, 'N'), (0x1D6F0, 'O'), (0x1D6F2, 'P'),
  (0x1D6F3, 'O'), (0x1D6F5, 'T'), (0x1D6F6, 'Y'), (0x1D6F8, 'X'), (0x1D6FC, 'a'), (0x1D6FE, 'y'), (0x1D702, 'n'),
  (0x1D703, 'O'), (0x1D704, 'i'), (0x1D708, 'v'), (0x1D70A, 'o'), (0x1D70C, 'p'), (0x1D70E, 'o'), (0x1D710, 'u'),
  (0x1D717, 'O'), (0x1D71A, 'p'), (0x1D71C, 'A'), (0x1D71D, 'B'), (0x1D720, 'E'), (0x1D721, 'Z'), (0x1D722, 'H'),
  (0x1D723, 'O'), (0x1D724, 'l'), (0x1D725, 'K'), (0x1D727, 'M'), (0x1D728, 'N'), (0x1D72A, 'O'), (0x1D72C, 'P'),
  (0x1D72D, 'O'), (0x1D72F, 'T'), (0x1D730, 'Y'), (0x1D732, 'X'), (0x1D736, 'a'), (0x1D738, 'y'), (0x1D73C, 'n'),
  (0x1D73D, 'O'), (0x1D73E, 'i'), (0x1D742, 'v'), (0x1D744, 'o'), (0x1D746, 'p'), (0x1D748, 'o'), (0x1D74A, 'u'),
  (0x1D751, 'O'), (0x1D754, 'p'), (0x1D756, 'A'), (0x1D757, 'B'), (0x1D75A, 'E'), (0x1D75B, 'Z'), (0x1D75C, 'H'),
  (0x1D75D, 'O'), (0x1D75E, 'l'), (0x1D75F, 'K'), (0x1D761, 'M'), (0x1D762, 'N'), (0x1D764, 'O'), (0x1D766, 'P'),
  (0x1D767, 'O'), (0x1D769, 'T'), (0x1D76A, 'Y'), (0x1D76C, 'X'), (0x1D770, 'a'), (0x1D772, 'y'), (0x1D776, 'n'),
  (0x1D777, 'O'), (0x1D778, 'i'), (0x1D77C, 'v'), (0x1D77E, 'o'), (0x1D780, 'p'), (0x1D782, 'o'), (0x1D784, 'u'),
  (0x1D78B, 'O'), (0x1D78E, 'p'), (0x1D790, 'A'), (0x1D791, 'B'), (0x1D794, 'E'), (0x1D795, 'Z'), (0x1D796, 'H'),
  (0x1D797, 'O'), (0x1D798, 'l'), (0x1D799, 'K'), (0x1D79B, 'M'), (0x1D79C, 'N'), (0x1D79E, 'O'), (0x1D7A0, 'P'),
  (0x1D7A1, 'O'), (0x1D7A3, 'T'), (0x1D7A4, 'Y'), (0x1D7A6, 'X'), (0x1D7AA, 'a'), (0x1D7AC, 'y'), (0x1D7B0, 'n'),
  (0x1D7B1, 'O'), (0x1D7B2, 'i'), (0x1D7B6, 'v'), (0x1D7B8, 'o'), (0x1D7BA, 'p'), (0x1D7BC, 'o'), (0x1D7BE, 'u'),
  (0x1D7C5, 'O'), (0x1D7C8, 'p'), (0x1D7CA, 'F'), (0x1DF24, 'tO'), (0x1DF2D, 'd'), (0x1DF2E, 'dz'), (0x1DF31, 'y'),
  (0x1DF32, 'h'), (0x1DF34, 'q'), (0x1DF37, 'r'), (0x1DF39, 'u'), (0x1DF3C, 'O'), (0x1DF3F, 'w'), (0x1DF40, 'A'),
  (0x1DF41, 'a'), (0x1DF45, 'g'), (0x1DF46, 'h'), (0x1DF47, 'h'), (0x1DF48, 'K'), (0x1DF49, 'k'), (0x1DF4A, 'M'),
  (0x1DF4B, 'rn'), (0x1DF4C, 'rn'), (0x1DF4D, 'N'), (0x1DF4E, 'n'), (0x1DF4F, 'n'), (0x1DF51, 'V'), (0x1DF52, 'v'),
  (0x1DF55, 'y'), (0x1DF5A, 'a'), (0x1DF5D, 'ie'), (0x1DF5E, 'oi'), (0x1DF5F, 'ou'), (0x1DF64, 'th'),
  (0x1DF65, 'wh'), (0x1DF6A, 'A'), (0x1DF6E, 'l'), (0x1DF7D, 'w'), (0x1DF81, 'E'), (0x1E8C7, 'l'), (0x1E8CB, '8'),
  (0x1ECAE, '.'), (0x1ED01, 'l'), (0x1EE00, 'l'), (0x1EE24, 'o'), (0x1EE80, 'l'), (0x1EE84, 'o'), (0x1F16D, 'cc'),
  (0x1F16E, 'C'), (0x1F190, 'DJ'), (0x1F700, 'QE'), (0x1F707, 'AR'), (0x1F708, 'V'), (0x1F714, 'O'), (0x1F74C, 'C'),
  (0x1F75C, 'sss'), (0x1F768, 'T'), (0x1F76B, 'MB'), (0x1F76C, 'VB')
) v (c, r);

-- confusables.txt 18.0.0: the characters it lists that are read as their decomposition (UnicodeData.txt 18.0.0).
insert into sandbox.look_alike (code_point, reads_as, basis)
select c, r, 'UTS39_DECOMPOSED' from (values
  (0x00BC, '1/4'), (0x00BD, '1/2'), (0x0132, 'IJ'), (0x017F, 's'), (0x2110, 'I'), (0x2111, 'I'), (0x2153, '1/3'),
  (0x2155, '1/5'), (0x2159, '1/6'), (0x215B, '1/8'), (0x215F, '1/'), (0x2160, 'I'), (0x2161, 'II'), (0x2162, 'III'),
  (0x2163, 'IV'), (0x2165, 'VI'), (0x2166, 'VII'), (0x2167, 'VIII'), (0x2168, 'IX'), (0x216A, 'XI'), (0x216B, 'XII'),
  (0x217F, 'm'), (0x2488, '1.'), (0x2491, '10.'), (0x2492, '11.'), (0x2493, '12.'), (0x2494, '13.'), (0x2495, '14.'),
  (0x2496, '15.'), (0x2497, '16.'), (0x2498, '17.'), (0x2499, '18.'), (0x249A, '19.'), (0x249B, '20.'),
  (0x3377, 'dm'), (0x337A, 'IU'), (0x3383, 'mA'), (0x338E, 'mg'), (0x3396, 'ml'), (0x3399, 'fm'), (0x339A, 'nm'),
  (0x339C, 'mm'), (0x339D, 'cm'), (0x339E, 'km'), (0x33A7, 'm/s'), (0x33B3, 'ms'), (0x33B7, 'mV'), (0x33BD, 'mW'),
  (0x33C2, 'a.m.'), (0x33D0, 'lm'), (0x33D4, 'mb'), (0x33D5, 'mil'), (0x33D6, 'mol'), (0x33D8, 'p.m.'),
  (0x33DE, 'V/m'), (0x33DF, 'A/m'), (0xFB05, 'st'), (0xFF29, 'I'), (0xFF4D, 'm'), (0x1CCDE, 'I'), (0x1D408, 'I'),
  (0x1D426, 'm'), (0x1D43C, 'I'), (0x1D45A, 'm'), (0x1D470, 'I'), (0x1D48E, 'm'), (0x1D4C2, 'm'), (0x1D4D8, 'I'),
  (0x1D4F6, 'm'), (0x1D52A, 'm'), (0x1D540, 'I'), (0x1D55E, 'm'), (0x1D574, 'I'), (0x1D592, 'm'), (0x1D5A8, 'I'),
  (0x1D5C6, 'm'), (0x1D5DC, 'I'), (0x1D5FA, 'm'), (0x1D610, 'I'), (0x1D62E, 'm'), (0x1D644, 'I'), (0x1D662, 'm'),
  (0x1D678, 'I'), (0x1D696, 'm'), (0x1EE64, 'o'), (0x1F100, '0.')
) v (c, r);

-- The other dash punctuation (general category Pd) of Unicode 18.0.0.
insert into sandbox.look_alike (code_point, reads_as, basis)
select c, '-', 'DASH_PUNCTUATION' from unnest(array[
  0x058A, 0x05BE, 0x1400, 0x1806, 0x2014, 0x2015, 0x2E17, 0x2E3A, 0x2E3B, 0x2E40, 0x2E5D, 0x301C, 0x3030, 0x30A0,
  0xFE31, 0xFE32, 0xFF0D, 0x10D6E, 0x10EAD
]) c;

-- DI-05 (header, item 1): the combining marks, general categories Mn and Me of Unicode 18.0.0, as a regular-expression
-- bracket.
create function sandbox.combining_mark_class() returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select '['
         '\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1-\u05c2\u05c4-\u05c5\u05c7-\u05c9\u0610-\u061a\u064b-\u065f'
         '\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7-\u06e8\u06ea-\u06ed\u0711\u0730-\u074a\u07a6-\u07b0\u07eb-\u07f3\u07fd'
         '\u0816-\u0819\u081b-\u0823\u0825-\u0827\u0829-\u082d\u0859-\u085b\u0897-\u089f\u08ca-\u08e1\u08e3-\u0902\u093a'
         '\u093c\u0941-\u0948\u094d\u0951-\u0957\u0962-\u0963\u0981\u09bc\u09c1-\u09c4\u09cd\u09e2-\u09e3\u09fe\u0a01-\u0a02'
         '\u0a3c\u0a41-\u0a42\u0a47-\u0a48\u0a4b-\u0a4d\u0a51\u0a70-\u0a71\u0a75\u0a81-\u0a82\u0abc\u0ac1-\u0ac5'
         '\u0ac7-\u0ac8\u0acd\u0ae2-\u0ae3\u0afa-\u0aff\u0b01\u0b3c\u0b3f\u0b41-\u0b44\u0b4d\u0b53-\u0b56\u0b62-\u0b63\u0b82'
         '\u0bc0\u0bcd\u0c00\u0c04\u0c3c\u0c3e-\u0c40\u0c46-\u0c48\u0c4a-\u0c4d\u0c55-\u0c56\u0c62-\u0c63\u0c81\u0cbc\u0cbf'
         '\u0cc6\u0ccc-\u0ccd\u0ce2-\u0ce3\u0d00-\u0d01\u0d3b-\u0d3c\u0d41-\u0d44\u0d4d\u0d62-\u0d63\u0d81\u0dca'
         '\u0dd2-\u0dd4\u0dd6\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u0eb1\u0eb4-\u0ebc\u0ec8-\u0ece\u0f18-\u0f19\u0f35\u0f37\u0f39'
         '\u0f71-\u0f7e\u0f80-\u0f84\u0f86-\u0f87\u0f8d-\u0f97\u0f99-\u0fbc\u0fc6\u102d-\u1030\u1032-\u1037\u1039-\u103a'
         '\u103d-\u103e\u1058-\u1059\u105e-\u1060\u1071-\u1074\u1082\u1085-\u1086\u108d\u109d\u135d-\u135f\u1712-\u1714'
         '\u1732-\u1733\u1752-\u1753\u1772-\u1773\u17b4-\u17b5\u17b7-\u17bd\u17c6\u17c9-\u17d3\u17dd\u180b-\u180d\u180f'
         '\u1885-\u1886\u18a9\u1920-\u1922\u1927-\u1928\u1932\u1939-\u193b\u1a17-\u1a18\u1a1b\u1a56\u1a58-\u1a5e\u1a60\u1a62'
         '\u1a65-\u1a6c\u1a73-\u1a7c\u1a7f\u1ab0-\u1af0\u1b00-\u1b03\u1b34\u1b36-\u1b3a\u1b3c\u1b42\u1b6b-\u1b73'
         '\u1b80-\u1b81\u1ba2-\u1ba5\u1ba8-\u1ba9\u1bab-\u1bad\u1be6\u1be8-\u1be9\u1bed\u1bef-\u1bf1\u1c2c-\u1c33'
         '\u1c36-\u1c37\u1cd0-\u1cd2\u1cd4-\u1ce0\u1ce2-\u1ce8\u1ced\u1cf4\u1cf8-\u1cf9\u1dc0-\u1dff\u20d0-\u20f0'
         '\u2cef-\u2cf1\u2d7f\u2de0-\u2dff\u302a-\u302d\u3099-\u309a\ua66f-\ua672\ua674-\ua67d\ua69e-\ua69f\ua6f0-\ua6f1'
         '\ua802\ua806\ua80b\ua825-\ua826\ua82c\ua8c4-\ua8c5\ua8e0-\ua8f1\ua8ff\ua926-\ua92d\ua947-\ua951\ua980-\ua982\ua9b3'
         '\ua9b6-\ua9b9\ua9bc-\ua9bd\ua9e5\uaa29-\uaa2e\uaa31-\uaa32\uaa35-\uaa36\uaa43\uaa4c\uaa7c\uaab0\uaab2-\uaab4'
         '\uaab7-\uaab8\uaabe-\uaabf\uaac1\uaaec-\uaaed\uaaf6\uabe5\uabe8\uabed\ufb1e\ufe00-\ufe0f\ufe20-\ufe2f\U000101fd'
         '\U000102e0\U00010376-\U0001037a\U00010a01-\U00010a03\U00010a05-\U00010a06\U00010a0c-\U00010a0f'
         '\U00010a38-\U00010a3a\U00010a3f\U00010ae5-\U00010ae6\U00010d24-\U00010d27\U00010d69-\U00010d6d'
         '\U00010eab-\U00010eac\U00010ecb-\U00010ecf\U00010ef0-\U00010eff\U00010f46-\U00010f50\U00010f82-\U00010f85'
         '\U00011001\U00011038-\U00011046\U00011070\U00011073-\U00011074\U0001107f-\U00011081\U000110b3-\U000110b6'
         '\U000110b9-\U000110ba\U000110c2\U00011100-\U00011102\U00011127-\U0001112b\U0001112d-\U00011134\U00011173'
         '\U00011180-\U00011181\U000111b6-\U000111be\U000111c9-\U000111cc\U000111cf\U0001122f-\U00011231\U00011234'
         '\U00011236-\U00011237\U0001123e\U00011241\U000112df\U000112e3-\U000112ea\U00011300-\U00011301\U0001133b-\U0001133c'
         '\U00011340\U00011366-\U0001136c\U00011370-\U00011374\U000113bb-\U000113c0\U000113ce\U000113d0\U000113d2'
         '\U000113e1-\U000113e2\U00011438-\U0001143f\U00011442-\U00011444\U00011446\U0001145e\U000114b3-\U000114b8\U000114ba'
         '\U000114bf-\U000114c0\U000114c2-\U000114c3\U000115b2-\U000115b5\U000115bc-\U000115bd\U000115bf-\U000115c0'
         '\U000115dc-\U000115dd\U00011633-\U0001163a\U0001163d\U0001163f-\U00011640\U000116ab\U000116ad\U000116b0-\U000116b5'
         '\U000116b7\U0001171d\U0001171f\U00011722-\U00011725\U00011727-\U0001172b\U0001182f-\U00011837\U00011839-\U0001183a'
         '\U0001193b-\U0001193c\U0001193e\U00011943\U000119d4-\U000119d7\U000119da-\U000119db\U000119e0\U00011a01-\U00011a0a'
         '\U00011a33-\U00011a38\U00011a3b-\U00011a3e\U00011a47\U00011a51-\U00011a56\U00011a59-\U00011a5b'
         '\U00011a8a-\U00011a96\U00011a98-\U00011a99\U00011b60\U00011b62-\U00011b64\U00011b66\U00011c30-\U00011c36'
         '\U00011c38-\U00011c3d\U00011c3f\U00011c92-\U00011ca7\U00011caa-\U00011cb0\U00011cb2-\U00011cb3'
         '\U00011cb5-\U00011cb6\U00011d31-\U00011d36\U00011d3a\U00011d3c-\U00011d3d\U00011d3f-\U00011d45\U00011d47'
         '\U00011d90-\U00011d91\U00011d95\U00011d97\U00011df0\U00011ef3-\U00011ef4\U00011f00-\U00011f01\U00011f36-\U00011f3a'
         '\U00011f40\U00011f42\U00011f5a\U00013440\U00013447-\U00013455\U0001611e-\U00016129\U0001612d-\U0001612f'
         '\U00016af0-\U00016af4\U00016b30-\U00016b36\U00016f4f\U00016f8f-\U00016f92\U00016fe4\U0001bc9d-\U0001bc9e'
         '\U0001cf00-\U0001cf2d\U0001cf30-\U0001cf46\U0001d127-\U0001d128\U0001d167-\U0001d169\U0001d17b-\U0001d182'
         '\U0001d185-\U0001d18b\U0001d1aa-\U0001d1ad\U0001d242-\U0001d244\U0001d25b-\U0001d25c\U0001da00-\U0001da36'
         '\U0001da3b-\U0001da6c\U0001da75\U0001da84\U0001da9b-\U0001da9f\U0001daa1-\U0001daaf\U0001e000-\U0001e006'
         '\U0001e008-\U0001e018\U0001e01b-\U0001e021\U0001e023-\U0001e024\U0001e026-\U0001e02a\U0001e08f'
         '\U0001e130-\U0001e136\U0001e2ae\U0001e2ec-\U0001e2ef\U0001e4ec-\U0001e4ef\U0001e5ee-\U0001e5ef\U0001e6e3\U0001e6e6'
         '\U0001e6ee-\U0001e6ef\U0001e6f5\U0001e8d0-\U0001e8d6\U0001e944-\U0001e94a\U000e0100-\U000e01ef'
         ']'
$$;

-- DI-05 (header, item 4): the characters that can make a text display in another order than it is stored: bidirectional
-- classes R, AL and AN (with the unassigned code points of the right-to-left blocks), the explicit embedding, override
-- and isolate controls, and U+200E (the marks U+200F and U+061C are R and AL), of Unicode 18.0.0.
create function sandbox.reordering_class() returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select '['
         '\u0590\u05be\u05c0\u05c3\u05c6\u05ca-\u0605\u0608\u060b\u060d\u061b-\u064a\u0660-\u0669\u066b-\u066f\u0671-\u06d5'
         '\u06dd\u06e5-\u06e6\u06ee-\u06ef\u06fa-\u0710\u0712-\u072f\u074b-\u07a5\u07b1-\u07ea\u07f4-\u07f5\u07fa-\u07fc'
         '\u07fe-\u0815\u081a\u0824\u0828\u082e-\u0858\u085c-\u0896\u08a0-\u08c9\u08e2\u200e-\u200f\u202a-\u202e'
         '\u2066-\u2069\ufb1d\ufb1f-\ufb28\ufb2a-\ufbc2\ufbd3-\ufd3d\ufd50-\ufd8f\ufd92-\ufdc7\ufdf0-\ufdfc\ufe70-\ufefe'
         '\U00010800-\U0001091e\U00010920-\U00010a00\U00010a04\U00010a07-\U00010a0b\U00010a10-\U00010a37'
         '\U00010a3b-\U00010a3e\U00010a40-\U00010ae4\U00010ae7-\U00010b38\U00010b40-\U00010d23\U00010d28-\U00010d68'
         '\U00010d6f-\U00010eaa\U00010ead-\U00010eca\U00010ed9-\U00010eef\U00010f00-\U00010f45\U00010f51-\U00010f81'
         '\U00010f86-\U00010fff\U0001e800-\U0001e8cf\U0001e8d7-\U0001e943\U0001e94b-\U0001eeef\U0001eef2-\U0001efff'
         ']'
$$;

-- DI-05 (header, item 1): text p_text as it shows. Printable ASCII and ASCII white space are returned as they are.
create function sandbox.shown_text(p_text text) returns text
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
    -- kernel.is_blank's class (kernel 0960), but for white space (Unicode White_Space, PropList.txt 18.0.0).
    if kernel.is_blank(c) and c !~ '[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028-\u2029\u202f\u205f\u3000]' then
      v_out := replace(v_out, c, '');
    end if;
  end loop;
  return normalize(v_out, NFC);
end
$$;

-- DI-05 (header, item 2): text p_text with every character other than ASCII that sandbox.look_alike lists read as what it
-- reads as. Text of ASCII only is returned as it is.
create function sandbox.look_alikes_read(p_text text) returns text
language plpgsql stable strict parallel safe set search_path = pg_catalog, sandbox, pg_temp as $$
declare
  v_out   text := p_text;
  v_reads text;
  c       text;
begin
  if p_text !~ '[^\u0001-\u007f]' then
    return p_text;
  end if;
  for c in select distinct x from regexp_split_to_table(regexp_replace(p_text, '[\u0001-\u007f]+', '', 'g'), '') x loop
    select l.reads_as into v_reads from sandbox.look_alike l where l.code_point = ascii(c);
    if found then
      v_out := replace(v_out, c, v_reads);
    end if;
  end loop;
  return v_out;
end
$$;

-- DI-05 (header, items 1 to 3): the forms of text p_text the rule reads: as stored, as written in NFKC and with its
-- escapes read (1040), the escapes of U+0000 and of '%' read as a space, each as it is, as it shows, with its
-- look-alikes read, and both. Distinct.
create function sandbox.text_readings(p_text text) returns text[]
language plpgsql stable strict parallel safe set search_path = pg_catalog, sandbox, pg_temp as $$
declare
  v_bases text[];
  v_out   text[] := '{}';
  v_base  text;
  v_shown text;
begin
  v_bases := array(select distinct b from unnest(array[regexp_replace(p_text, '%(00|25)|\\[uU]0000', ' ', 'g'), sandbox.as_written(p_text),
                                                        sandbox.escapes_decoded(normalize(p_text, NFKC))]) b);
  foreach v_base in array v_bases loop
    v_shown := sandbox.shown_text(v_base);
    v_out := v_out || array[v_base, sandbox.look_alikes_read(v_base)]
                   || case when v_shown = v_base then '{}'::text[] else array[v_shown, sandbox.look_alikes_read(v_shown)] end;
  end loop;
  return array(select distinct x from unnest(v_out) x);
end
$$;

-- DI-05 (header, item 4): the words of a text whose forms are p_forms in every arrangement of its runs, when one of its
-- forms holds a character that can reorder its display: each run of letters joined to each run of digits. Empty for a
-- text that displays in the order it is stored. Distinct.
create function sandbox.rearranged_words(p_forms text[]) returns setof text
language sql immutable strict parallel safe set search_path = pg_catalog, sandbox, pg_temp as $$
  with f as (select t from unnest(p_forms) t),
       l as (select distinct m[1] as p from f cross join lateral regexp_matches(f.t, '([A-Za-z]+)', 'g') m),
       d as (select distinct m[1] as p from f cross join lateral regexp_matches(f.t, '([0-9]+)', 'g') m)
  select l.p || d.p
    from l cross join d
   where exists (select 1 from f where f.t ~ sandbox.reordering_class())
$$;

-- DI-05: whether text p_text is read as it is stored only: printable ASCII and ASCII white space with no percent or
-- backslash escape, which every form of sandbox.text_readings leaves as it is and which displays in the order it is
-- stored.
create function sandbox.read_as_stored(p_text text) returns boolean
language sql immutable strict parallel safe set search_path = pg_catalog, pg_temp as $$
  select p_text !~ '[^\u0009-\u000d\u0020-\u007e]|%[0-9A-Fa-f]{2}|\\[uU][0-9A-Fa-f]{4}'
$$;

-- DI-05 (header): the texts the rule reads the words of text p_text in: the text itself when it is read as it is stored;
-- else every form of sandbox.text_readings and, for a text that can display in another order, one text more that lists
-- the words of sandbox.rearranged_words.
create function sandbox.texts_read(p_text text) returns text[]
language plpgsql stable strict parallel safe set search_path = pg_catalog, sandbox, pg_temp as $$
declare
  v_forms text[];
begin
  if sandbox.read_as_stored(p_text) then
    return array[p_text];
  end if;
  v_forms := sandbox.text_readings(p_text);
  return v_forms || array(select string_agg(w, ' ' order by w) from sandbox.rearranged_words(v_forms) w having count(*) > 0);
end
$$;

-- DI-05: the words of text p_text that could name an identifier (1030's header, item 1: the runs of the identifier
-- alphabet, trimmed of separators at either end, that hold a letter and a digit, other than an ordinal number and a
-- UUID), read in every text of sandbox.texts_read (header). Distinct.
create or replace function sandbox.identifier_words(p_text text) returns setof text
language sql stable strict parallel safe set search_path = pg_catalog, sandbox, pg_temp as $$
  select distinct x.w
    from unnest(case when sandbox.read_as_stored(p_text) then array[p_text] else sandbox.texts_read(p_text) end) f (t)
   cross join lateral regexp_matches(f.t, '[A-Za-z0-9/.-]*[A-Za-z][A-Za-z0-9/.-]*', 'g') m
   cross join lateral (select btrim(m[1], '/.-') as w) x
   where x.w ~ '[0-9]'
     and x.w !~* '^[0-9]+(st|nd|rd|th)$'
     and x.w !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

-- DI-05: the words of every string and every member name of JSON value p_value, at any depth (1030; as 1030's, now
-- STABLE as the text form it calls). Distinct.
create or replace function sandbox.identifier_words(p_value jsonb) returns setof text
language sql stable strict parallel safe set search_path = pg_catalog, sandbox, pg_temp as $$
  select distinct w
    from (select s #>> '{}' as t from jsonb_path_query(p_value, 'strict $.** ? (@.type() == "string")') s
          union
          select k #>> '{}' from jsonb_path_query(p_value, 'strict $.** ? (@.type() == "object").keyvalue().key') k) x
   cross join lateral sandbox.identifier_words(x.t) w
$$;

-- DI-05: whether text p_text holds word p_word in one of the texts the rule reads (header, sandbox.texts_read): where a
-- refusal says a word stands (recipe-core 0349, recipe.word_path).
create function sandbox.text_holds(p_text text, p_word text) returns boolean
language sql stable strict parallel safe set search_path = pg_catalog, sandbox, pg_temp as $$
  select exists (select 1 from unnest(sandbox.texts_read(p_text)) t where position(p_word in t) > 0)
$$;

revoke all on function sandbox.combining_mark_class(), sandbox.reordering_class(), sandbox.shown_text(text), sandbox.look_alikes_read(text),
                       sandbox.text_readings(text), sandbox.rearranged_words(text[]), sandbox.read_as_stored(text), sandbox.texts_read(text),
                       sandbox.text_holds(text, text) from public;
grant execute on function sandbox.combining_mark_class(), sandbox.reordering_class(), sandbox.shown_text(text), sandbox.look_alikes_read(text),
                          sandbox.text_readings(text), sandbox.rearranged_words(text[]), sandbox.read_as_stored(text), sandbox.texts_read(text),
                          sandbox.text_holds(text, text) to ebmr_app;

reset role;
