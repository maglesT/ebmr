-- Sandbox, training and simulation store (module A4), part 13: letters and digits are read as the E2E browser draws
-- them at every weight the product draws free text in, with a complete comparison (Phase 2 exit follow-up F12, the
-- attack on kernel 1101 in the lane's own round 3; control DI-05, invariant INV-18; ADR 0012: the rules hold when the
-- application's own database credentials are used directly).
--
-- What was wrong. Kernel 1101 read the characters Chromium 141 draws as an ASCII letter or digit, but our attack on it
-- found two gaps in its scan:
--   * it drew at the regular weight only, while the product draws free text of a test run's record in bold too: the
--     exception banner's title and an audit entry's summary at 700, a typed value's echo at 600 (ui-kit floor, audit and
--     primitives styles). There the turned e and the schwa (U+01DD, U+0259) are drawn within one pixel of a, U+0250 of
--     e, Cyrillic U+0492 of F and U+042D of 3, Armenian U+0562 of p, and the Masaram Gondi letter E, the Mro letter YO
--     and the Pau Cin Hau letter TA of L, so U+11D06 2409-0017 shows L2409-0017 in an exception banner;
--   * it compared a character only with the references whose ink box was within 3 px of its own and whose centre-aligned
--     mean distance was at most 1.2 px, a cut that is not implied by the criterion, and so missed matches it meets at the
--     regular weight: U+0265 (turned h, drawn as u with a hook), U+047A (Cyrillic round omega, as O with a mark), U+10307
--     (Old Italic HE, as B) and U+1092F (Lydian T, as i with a mark).
--
-- Correction of an earlier claim (applied migrations are never edited): kernel 1101's header (item 1) says every one
-- of the 172,350 characters was compared with every reference; it was compared at the regular weight only and with the
-- references its first cut kept, and its residual "a character drawn no closer to a letter than two letters of the
-- alphabet are to each other (U+0259 ə and a, U+0492 Ғ and F)" named two characters that are that close at 700.
--
-- What changed. sandbox.look_alike takes 84 more rows, basis LETTER_SHAPE (kernel 1101), read by every user of the
-- reading. The scan of kernel 1101 is repeated on the same 172,350 characters and the same 62 letters and digits with
-- each of 297 combining marks, drawn at weights 400, 600 and 700 (Noto Sans Variable and the machine's fonts at those
-- weights), with the same criterion (aligned on the baseline and the centre of their ink, a search of one pixel either
-- way, 95 % of each drawing's ink within one pixel of the other's) and a first cut that the criterion implies: a
-- distance transform moves by at most the length of a shift, so a pair that meets the criterion has a 95th percentile
-- of at most 1 + sqrt(2) px at the centre-aligned position, and only such pairs are searched; references are taken
-- within an eighth of an em of the character's ink box and 0.6 to 1.6 times its ink. At each of the three weights no two
-- different ASCII letters or digits are drawn that close (the closest are 5 and S, and D and O at 700, at 1.41 px), so
-- the line still reads a character as a letter only when it is drawn closer to it than any two letters are to each
-- other. Matched, punctuation aside: 68 characters at 400, 88 at 600 and 102 at 700, 142 in all, of which kernel
-- 1101 lists 58; 8 punctuation marks matched too and are left out, as kernel 1101 leaves them out. A character matched
-- at several weights is read as its closest drawing (the lowest 95th percentile, then the lowest mean, the regular
-- weight first). Among the 84: Cyrillic Э as 3 and є as c, Greek Γ as l, Thai ก as n, Ol Chiki AT as 0, Armenian Ա
-- as U and Ց as 8; Russian, Greek, Thai and Santali prose is read more where such a letter meets a digit (none is a
-- language of the outline; a test run refuses it, a GMP installation keeps it).
--   Not scanned: the weights 500 (the watermark's notice), 800 and 900 (the product name, the batch number, a device's
--   value and the sandbox band), which draw no free text of a run's record; at 800, 5 and S are drawn within one
--   pixel, so the drawing no longer tells two letters apart there.
-- Honest text passes as before (tested): Hindi, Tamil and Telugu prose (no letter of their scripts is drawn as the
-- alphabet at these weights), Greek, Japanese, Chinese and Korean prose, an emoji, TEST- identifiers. Stricter only.
--
-- What the reading still cannot see: kernel 1101's residual, the drawing as the regular, semibold and bold weights of
-- the E2E machine's fonts give it (another weight or font may draw a character otherwise).
--
-- The table keeps its owner, privileges and basis check. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- Chromium 141's drawing at weights 400, 600 and 700 (header): letters, symbols and digits drawn as an ASCII letter or
-- digit that kernel 1101 does not list.
insert into sandbox.look_alike (code_point, reads_as, basis)
select c, r, 'LETTER_SHAPE' from (values
  (0x014A, 'N'), (0x01DD, 'a'), (0x0250, 'e'), (0x0259, 'a'), (0x0265, 'u'), (0x0283, 'j'), (0x02AF, 'u'),
  (0x0373, 'i'), (0x037C, 'c'), (0x0393, 'l'), (0x03DB, 'c'), (0x03E5, 'q'), (0x042D, '3'), (0x0454, 'c'),
  (0x047A, 'O'), (0x047F, 'w'), (0x0481, 'c'), (0x048E, 'P'), (0x048F, 'p'), (0x0492, 'F'), (0x04D9, 'a'),
  (0x04DB, 'a'), (0x04FF, 'x'), (0x0531, 'U'), (0x0551, '8'), (0x0562, 'p'), (0x0565, 'b'), (0x056B, 'h'),
  (0x0E01, 'n'), (0x10D8, 'o'), (0x10EE, 'b'), (0x119D, 'l'), (0x146C, 'P'), (0x1C5B, '0'), (0x1D13, 'o'),
  (0x1D77, 'b'), (0x20C0, 'c'), (0x2207, 'V'), (0x22BD, 'V'), (0x22CE, 'v'), (0x2759, 'l'), (0x2A42, 'O'),
  (0x2C70, 'D'), (0x2D42, 'i'), (0x2D5F, 'E'), (0xA388, 'N'), (0xA66B, 'e'), (0xA68F, 'u'), (0xA780, 'l'),
  (0xA7C0, 'O'), (0xA7C1, 'o'), (0xA7D0, '8'), (0xF425, '8'), (0x102A7, 'B'), (0x10305, 'F'), (0x10307, 'B'),
  (0x10313, 'P'), (0x1031B, 'P'), (0x10332, 'r'), (0x10333, 'o'), (0x10336, 'z'), (0x10343, 's'), (0x105B7, 'v'),
  (0x1089B, 'i'), (0x10929, '1'), (0x1092F, 'T'), (0x10C27, 'o'), (0x10C92, '1'), (0x10CA7, 'T'), (0x10E81, 'v'),
  (0x1101E, 'o'), (0x11ACE, 'L'), (0x11D06, 'L'), (0x16A42, 'L'), (0x16B01, 'a'), (0x16B16, 'a'), (0x16E95, '1'),
  (0x1D6C5, 'o'), (0x1D76F, 'V'), (0x1D781, 'c'), (0x1D78A, 'c'), (0x1DA79, 'I'), (0x1E826, 'l'), (0x1E829, 'l')
) v (c, r);

reset role;
