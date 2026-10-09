-- Recipe core, execution store (module C3): the words a bound source gives and the place a refusal names are read as the
-- identifier rule reads a text since kernel 1050: as it shows, with its look-alikes read and, for a text that can display
-- in another order, in every arrangement of its runs (Phase 2 exit follow-up F12, the verification of the lane's round 6,
-- lane round 3; DI-05, DI-30, INV-18; ADR 0012: the rules hold when the application's own database credentials are used
-- directly).
--
-- What was wrong. Kernel 1050 reads every text a test run records in more forms than kernel 1030 and 1040 did (the text
-- as stored, as it shows with what shows nothing and the combining marks removed, with the look-alikes of the identifier
-- alphabet read, and both), so a word it reads may stand in none of the two forms recipe-core 0346 still read:
--   * recipe.source_words, the words a bound source (the imported MBR, the batch number, a site or room code) gives a
--     run, read the source as written and with its escapes read only. A text of the MBR written with a non-breaking
--     hyphen or a combining mark, copied into a run's record, is read by 1050 as the word it shows; bound words that
--     did not read the source the same way would refuse what the run has from its own MBR.
--   * recipe.word_path, the JSON path a refusal names, looked the word up in the same two forms only, so a refusal of a
--     word 1050 reads in another form named '$' instead of the member that holds it.
--
-- What changed. Both read through the kernel's readings (kernel 1050):
--   * recipe.source_words: every run of letters, digits, '.' and '-' in every form of sandbox.text_readings (the text
--     as stored, as written, with its escapes read, each as it shows and with its look-alikes read). The arrangements of
--     a text that can display in another order (sandbox.rearranged_words) are not words a source gives: they are what a
--     record could show, never what a run may hold, so a source never binds them.
--   * recipe.word_path: a string holds the word when sandbox.text_holds says so (a form of it, or an arrangement of its
--     runs); a member name likewise. Member names holding an unbound word are still written <member>.
-- Bound words can only grow (every form 0346 read is among the forms read), and every word the reading takes from a
-- record is now looked up in the same forms; nothing else changes. STABLE (they read sandbox.look_alike through
-- sandbox.text_readings).
--
-- Replaced functions keep their owner (ebmr_owner) and privileges (none for the application roles); every function pins
-- its search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed and never
-- edited.

set local role ebmr_owner;

-- DI-05: the words of text p_text a bound source contributes, upper-cased: every run of letters, digits, '.' and '-' in
-- every form the identifier rule reads (kernel 1050, sandbox.text_readings).
create or replace function recipe.source_words(p_text text) returns text[]
language sql stable strict set search_path = pg_catalog, sandbox, pg_temp as $$
  select coalesce(array_agg(distinct sandbox.ascii_upper(m[1])), '{}')
    from unnest(sandbox.text_readings(p_text)) f (t)
   cross join lateral regexp_matches(f.t, '([A-Za-z0-9][A-Za-z0-9.-]*)', 'g') m
$$;

-- DI-05 (0346's header, item 5): where in value p_value word p_word stands: the JSON path of the first string holding it
-- in a form the rule reads or in an arrangement of its runs (kernel 1050, sandbox.text_holds), or of the object one of
-- whose member names holds it. A member name on the path that holds a word read as a real batch or lot number not bound
-- by p_bound is written <member>: the path never repeats such a word.
create or replace function recipe.word_path(p_value jsonb, p_word text, p_bound text[], p_batch_number text) returns text
language sql stable set search_path = pg_catalog, recipe, sandbox, pg_temp as $$
  with recursive t (path, v, depth) as (
    select '$'::text, p_value, 0
    union all
    select t.path || e.step, e.value, t.depth + 1
      from t
     cross join lateral (
       select '.' || case when recipe.unbound_real_identifier(to_jsonb(x.key), p_bound, p_batch_number) is null then x.key else '<member>' end as step, x.value
         from jsonb_each(case when jsonb_typeof(t.v) = 'object' then t.v end) x
       union all
       select '[' || (a.ord - 1) || ']', a.value
         from jsonb_array_elements(case when jsonb_typeof(t.v) = 'array' then t.v end) with ordinality a (value, ord)
     ) e
     where t.depth < 64
  )
  select coalesce(
    (select t.path from t
      where jsonb_typeof(t.v) = 'string' and sandbox.text_holds(t.v #>> '{}', p_word)
      order by length(t.path), t.path limit 1),
    (select t.path || ' (the name of one of its members)' from t cross join lateral jsonb_object_keys(case when jsonb_typeof(t.v) = 'object' then t.v end) k
      where sandbox.text_holds(k, p_word)
      order by length(t.path), t.path limit 1),
    '$')
$$;

reset role;
