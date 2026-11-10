-- Sandbox, training and simulation store (module A4): a typed ISO date-time is no identifier (control DI-05, invariant
-- INV-18; defect found by injectables session 10, lead ruling of 10 November 2026; decision 0008: removing a false
-- refusal is no hardening round of the frozen F12 rule).
--
-- Handbook: modules/kernel.md
--
-- What was wrong. sandbox.identifier_words (kernel 1120) ends a word at ':' (ASCII punctuation outside the identifier
-- alphabet), so a typed date-time such as 2026-11-10T10:17 gave the word 2026-11-10T10: a letter and digits, which the
-- rule read as a real lot number. A library DATE_TIME field with a time could not be recorded in a sandbox run
-- (EBMR-SBX-024 from sandbox.guard_free_text, and the recipe-core readers that call the same words). No clause asks for a
-- date-time to be refused, so the refusal had no basis.
--
-- The change. Before the words are scanned, each text the rule reads blanks out a well-formed ISO 8601 date-time that
-- stands on its own: YYYY-MM-DDThh:mm, optional :ss and a fraction of 1 to 9 digits, optional Z or +hh:mm / -hh:mm; month
-- 01-12, day 01-31, hour 00-23, minute and second 00-59; with the start or end of the text, or a character outside
-- [A-Za-z0-9/.:-], on each side. As kernel 1030 leaves UUID-shaped words out, nothing else changes: a lot or batch number
-- beside a date-time, glued to one (B2026-11-10T10:17, 2026-11-10T10:17L2409-0017) or inside one, and a date-shaped value
-- that is no date-time (month 13, hour 24, no minutes) are read as before.
--
--   sandbox.identifier_words(text)   CREATE OR REPLACE of kernel 1120 with the blanking above; grants unchanged.

create or replace function sandbox.identifier_words(p_text text) returns setof text
language sql stable strict parallel safe set search_path = pg_catalog, sandbox, pg_temp as $$
  with f (stored, texts) as (
    select sandbox.read_as_stored(p_text), case when sandbox.read_as_stored(p_text) then array[p_text] else sandbox.texts_read(p_text) end
  )
  select x.w
    from f
   cross join lateral unnest(f.texts) t0 (t)
   cross join lateral (select regexp_replace(
            t0.t,
            '(^|[^A-Za-z0-9/.:-])[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,9})?)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])?(?=$|[^A-Za-z0-9/.:-])',
            '\1 ', 'g') as t) t
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
