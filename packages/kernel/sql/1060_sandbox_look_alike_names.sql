-- Sandbox, training and simulation store (module A4), part 8: letters and digits that Unicode names but no look-alike
-- table lists are read as what they are named (Phase 2 exit follow-up F12, the attack on kernel 1050 in the lane's own
-- round; control DI-05, invariant INV-18; ADR 0012: the rules hold when the application's own database credentials are
-- used directly).
--
-- What was wrong. Kernel 1050 reads a character other than ASCII as the identifier alphabet when it is a decimal digit,
-- when confusables.txt (UTS #39) maps it to the alphabet, or when it is dash punctuation; NFKC reads the characters
-- with a compatibility decomposition (circled, parenthesized, squared and fullwidth letters and digits). The attack on
-- 1050 found characters that show a Latin letter or a digit and that none of these reads: U+029F LATIN LETTER SMALL
-- CAPITAL L ('L' U+029F '2409-0017' shows a small capital L before 2409-0017), U+1F1F1 REGIONAL INDICATOR SYMBOL LETTER
-- L, U+1F17B NEGATIVE SQUARED LATIN CAPITAL LETTER L, and the dingbat circled digits (L, U+2777, U+2779, U+24FF, U+277E,
-- '-0017' shows L2409-0017 in circled digits). sandbox.real_identifiers returned nothing for each.
--
-- Correction of an earlier claim (applied migrations are never edited): 1050's header (item 2) lists what is read with
-- its look-alikes as the decimal digits, confusables.txt's characters and the dashes; from here on also the characters
-- below.
--
-- What changed. sandbox.look_alike (1050) takes a fifth basis, UNICODE_NAME: every character other than ASCII with no
-- decomposition at all (canonical or compatibility: those NFKC and 1050's reading as it shows already read), that
-- 1050's table does not list, that is not a format character, a mark, a control or private use, and whose name in
-- UnicodeData.txt 18.0.0 makes it
--   * a Latin letter, with or without a hook, stroke, bar, tail, loop, curl or the like ('LATIN CAPITAL LETTER x',
--     'LATIN SMALL LETTER x', possibly followed by 'WITH ...', possibly preceded by a qualifier such as NEGATIVE CIRCLED
--     or NEGATIVE SQUARED), a small capital ('LATIN LETTER SMALL CAPITAL x') or a regional indicator ('REGIONAL
--     INDICATOR SYMBOL LETTER x'): read as that letter, a capital as a capital and a small letter as a small one;
--   * a digit of a numeral system (a name ending 'DIGIT ZERO' to 'DIGIT NINE', other than a turned digit): read as that
--     digit, as 1050 reads a decimal digit of any script by its value.
-- 372 characters. The readings that use the table (sandbox.look_alikes_read, and through it every user of
-- sandbox.identifier_words) read them with no other change. Stricter only: nothing read before is read less. Honest
-- text of the outline's languages holds none of them; a regional indicator pair, which shows as a flag (U+1F1EE U+1F1F3
-- for India), reads as its two letters and so is refused only when it touches a digit.
--
-- The table keeps its owner and privileges (the application role may read it and nobody else may write it); its basis
-- check is replaced to admit the new basis. Applied as a new migration because applied migrations are checksummed and
-- never edited.

set local role ebmr_owner;

alter table sandbox.look_alike drop constraint look_alike_basis_check;
alter table sandbox.look_alike add constraint look_alike_basis_check
  check (basis in ('DECIMAL_DIGIT', 'UTS39_CONFUSABLE', 'UTS39_DECOMPOSED', 'UNICODE_NAME', 'DASH_PUNCTUATION'));

-- UnicodeData.txt 18.0.0: the characters with no decomposition that its names make a Latin letter or a digit (header).
insert into sandbox.look_alike (code_point, reads_as, basis)
select c, r, 'UNICODE_NAME' from (values
  (0x0181, 'B'), (0x0187, 'C'), (0x0188, 'c'), (0x018A, 'D'), (0x0193, 'G'), (0x0198, 'K'), (0x01A4, 'P'),
  (0x01AC, 'T'), (0x01B2, 'V'), (0x01B3, 'Y'), (0x0220, 'N'), (0x0221, 'd'), (0x0234, 'l'), (0x0235, 'n'),
  (0x0236, 't'), (0x023A, 'A'), (0x023B, 'C'), (0x023D, 'L'), (0x023F, 's'), (0x0240, 'z'), (0x0243, 'B'),
  (0x024B, 'q'), (0x0255, 'c'), (0x0262, 'G'), (0x026C, 'l'), (0x0274, 'N'), (0x027E, 'r'), (0x0280, 'R'),
  (0x0288, 't'), (0x0291, 'z'), (0x0299, 'B'), (0x029B, 'G'), (0x029C, 'H'), (0x029D, 'j'), (0x029F, 'L'),
  (0x1369, '1'), (0x136A, '2'), (0x136B, '3'), (0x136C, '4'), (0x136D, '5'), (0x136E, '6'), (0x136F, '7'),
  (0x1370, '8'), (0x1371, '9'), (0x19DA, '1'), (0x1D00, 'A'), (0x1D05, 'D'), (0x1D07, 'E'), (0x1D0A, 'J'),
  (0x1D0B, 'K'), (0x1D0C, 'L'), (0x1D0D, 'M'), (0x1D18, 'P'), (0x1D1B, 'T'), (0x1D6C, 'b'), (0x1D6D, 'd'),
  (0x1D71, 'p'), (0x1D73, 'r'), (0x1D80, 'b'), (0x1D81, 'd'), (0x1D82, 'f'), (0x1D84, 'k'), (0x1D85, 'l'),
  (0x1D86, 'm'), (0x1D87, 'n'), (0x1D88, 'p'), (0x1D89, 'r'), (0x1D8A, 's'), (0x1D8D, 'x'), (0x1D8E, 'z'),
  (0x1D8F, 'a'), (0x1D91, 'd'), (0x1D92, 'e'), (0x1D96, 'i'), (0x1D99, 'u'), (0x1EFE, 'Y'), (0x24F5, '1'),
  (0x24F6, '2'), (0x24F7, '3'), (0x24F8, '4'), (0x24F9, '5'), (0x24FA, '6'), (0x24FB, '7'), (0x24FC, '8'),
  (0x24FD, '9'), (0x24FF, '0'), (0x2776, '1'), (0x2777, '2'), (0x2778, '3'), (0x2779, '4'), (0x277A, '5'),
  (0x277B, '6'), (0x277C, '7'), (0x277D, '8'), (0x277E, '9'), (0x2780, '1'), (0x2781, '2'), (0x2782, '3'),
  (0x2783, '4'), (0x2784, '5'), (0x2785, '6'), (0x2786, '7'), (0x2787, '8'), (0x2788, '9'), (0x278A, '1'),
  (0x278B, '2'), (0x278C, '3'), (0x278D, '4'), (0x278E, '5'), (0x278F, '6'), (0x2790, '7'), (0x2791, '8'),
  (0x2792, '9'), (0x2C60, 'L'), (0x2C61, 'l'), (0x2C62, 'L'), (0x2C63, 'P'), (0x2C64, 'R'), (0x2C65, 'a'),
  (0x2C66, 't'), (0x2C68, 'h'), (0x2C6A, 'k'), (0x2C6E, 'M'), (0x2C71, 'v'), (0x2C72, 'W'), (0x2C73, 'w'),
  (0x2C74, 'v'), (0x2C78, 'e'), (0x2C7A, 'o'), (0x2C7E, 'S'), (0x2C7F, 'Z'), (0xA730, 'F'), (0xA741, 'k'),
  (0xA742, 'K'), (0xA743, 'k'), (0xA744, 'K'), (0xA745, 'k'), (0xA748, 'L'), (0xA749, 'l'), (0xA74C, 'O'),
  (0xA74D, 'o'), (0xA750, 'P'), (0xA751, 'p'), (0xA752, 'P'), (0xA753, 'p'), (0xA754, 'P'), (0xA755, 'p'),
  (0xA756, 'Q'), (0xA757, 'q'), (0xA758, 'Q'), (0xA759, 'q'), (0xA75E, 'V'), (0xA75F, 'v'), (0xA78E, 'l'),
  (0xA790, 'N'), (0xA791, 'n'), (0xA792, 'C'), (0xA793, 'c'), (0xA794, 'c'), (0xA795, 'h'), (0xA796, 'B'),
  (0xA797, 'b'), (0xA7A0, 'G'), (0xA7A1, 'g'), (0xA7A2, 'K'), (0xA7A3, 'k'), (0xA7A4, 'N'), (0xA7A5, 'n'),
  (0xA7A6, 'R'), (0xA7A7, 'r'), (0xA7A8, 'S'), (0xA7A9, 's'), (0xA7AA, 'H'), (0xA7AD, 'L'), (0xA7AF, 'Q'),
  (0xA7B8, 'U'), (0xA7B9, 'u'), (0xA7C4, 'C'), (0xA7C6, 'Z'), (0xA7C7, 'D'), (0xA7C8, 'd'), (0xA7C9, 'S'),
  (0xA7CA, 's'), (0xA7CC, 'S'), (0xA7CD, 's'), (0xA7E2, 'R'), (0xAB34, 'e'), (0xAB37, 'l'), (0xAB38, 'l'),
  (0xAB39, 'l'), (0xAB3A, 'm'), (0xAB3B, 'n'), (0xAB46, 'R'), (0xAB49, 'r'), (0xAB56, 'x'), (0xAB57, 'x'),
  (0xAB58, 'x'), (0xAB59, 'x'), (0x102E1, '1'), (0x102E2, '2'), (0x102E3, '3'), (0x102E4, '4'), (0x102E5, '5'),
  (0x102E6, '6'), (0x102E7, '7'), (0x102E8, '8'), (0x102E9, '9'), (0x10A40, '1'), (0x10A41, '2'), (0x10A42, '3'),
  (0x10A43, '4'), (0x10E60, '1'), (0x10E61, '2'), (0x10E62, '3'), (0x10E63, '4'), (0x10E64, '5'), (0x10E65, '6'),
  (0x10E66, '7'), (0x10E67, '8'), (0x10E68, '9'), (0x111E1, '1'), (0x111E2, '2'), (0x111E3, '3'), (0x111E4, '4'),
  (0x111E5, '5'), (0x111E6, '6'), (0x111E7, '7'), (0x111E8, '8'), (0x111E9, '9'), (0x16E81, '1'), (0x16E83, '3'),
  (0x16E84, '4'), (0x16E85, '5'), (0x16E86, '6'), (0x16E87, '7'), (0x16E88, '8'), (0x16E89, '9'), (0x1D360, '1'),
  (0x1D361, '2'), (0x1D362, '3'), (0x1D363, '4'), (0x1D364, '5'), (0x1D365, '6'), (0x1D366, '7'), (0x1D367, '8'),
  (0x1D368, '9'), (0x1D369, '1'), (0x1D36A, '2'), (0x1D36B, '3'), (0x1D36C, '4'), (0x1D36D, '5'), (0x1D36E, '6'),
  (0x1D36F, '7'), (0x1D370, '8'), (0x1D371, '9'), (0x1DF04, 'L'), (0x1DF09, 't'), (0x1DF11, 'l'), (0x1DF13, 'l'),
  (0x1DF16, 'r'), (0x1DF1A, 'i'), (0x1DF1B, 'o'), (0x1DF1D, 'c'), (0x1DF1E, 's'), (0x1DF25, 'd'), (0x1DF26, 'l'),
  (0x1DF27, 'n'), (0x1DF28, 'r'), (0x1DF29, 's'), (0x1DF2A, 't'), (0x1DF30, 'G'), (0x1DF35, 'R'), (0x1DF61, 'r'),
  (0x1DF70, 'i'), (0x1DF72, 'O'), (0x1DF73, 'o'), (0x1DF7A, 'U'), (0x1DF7B, 'u'), (0x1DF7C, 'U'), (0x1DF80, 'A'),
  (0x1DF90, 'c'), (0x1DF91, 'c'), (0x1DF92, 'c'), (0x1E8C8, '2'), (0x1E8C9, '3'), (0x1E8CA, '4'), (0x1E8CC, '6'),
  (0x1E8CD, '7'), (0x1E8CE, '8'), (0x1E8CF, '9'), (0x1F10B, '0'), (0x1F10C, '0'), (0x1F150, 'A'), (0x1F151, 'B'),
  (0x1F152, 'C'), (0x1F153, 'D'), (0x1F154, 'E'), (0x1F155, 'F'), (0x1F156, 'G'), (0x1F157, 'H'), (0x1F158, 'I'),
  (0x1F159, 'J'), (0x1F15A, 'K'), (0x1F15B, 'L'), (0x1F15C, 'M'), (0x1F15D, 'N'), (0x1F15E, 'O'), (0x1F15F, 'P'),
  (0x1F160, 'Q'), (0x1F161, 'R'), (0x1F162, 'S'), (0x1F163, 'T'), (0x1F164, 'U'), (0x1F165, 'V'), (0x1F166, 'W'),
  (0x1F167, 'X'), (0x1F168, 'Y'), (0x1F169, 'Z'), (0x1F170, 'A'), (0x1F171, 'B'), (0x1F172, 'C'), (0x1F173, 'D'),
  (0x1F174, 'E'), (0x1F175, 'F'), (0x1F176, 'G'), (0x1F177, 'H'), (0x1F178, 'I'), (0x1F179, 'J'), (0x1F17A, 'K'),
  (0x1F17B, 'L'), (0x1F17C, 'M'), (0x1F17D, 'N'), (0x1F17E, 'O'), (0x1F17F, 'P'), (0x1F180, 'Q'), (0x1F181, 'R'),
  (0x1F182, 'S'), (0x1F183, 'T'), (0x1F184, 'U'), (0x1F185, 'V'), (0x1F186, 'W'), (0x1F187, 'X'), (0x1F188, 'Y'),
  (0x1F189, 'Z'), (0x1F18A, 'P'), (0x1F1A5, 'd'), (0x1F1E6, 'A'), (0x1F1E7, 'B'), (0x1F1E8, 'C'), (0x1F1E9, 'D'),
  (0x1F1EA, 'E'), (0x1F1EB, 'F'), (0x1F1EC, 'G'), (0x1F1ED, 'H'), (0x1F1EE, 'I'), (0x1F1EF, 'J'), (0x1F1F0, 'K'),
  (0x1F1F1, 'L'), (0x1F1F2, 'M'), (0x1F1F3, 'N'), (0x1F1F4, 'O'), (0x1F1F5, 'P'), (0x1F1F6, 'Q'), (0x1F1F7, 'R'),
  (0x1F1F8, 'S'), (0x1F1F9, 'T'), (0x1F1FA, 'U'), (0x1F1FB, 'V'), (0x1F1FC, 'W'), (0x1F1FD, 'X'), (0x1F1FE, 'Y'),
  (0x1F1FF, 'Z')
) v (c, r);

reset role;
