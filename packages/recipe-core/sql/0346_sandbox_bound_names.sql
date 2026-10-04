-- Recipe core, execution store (module C3): the words a test run's record may hold besides a TEST- identifier are bound to
-- the run, a person's name is read where the record copies it, a scale reading's chain is read in full, and a refusal
-- never repeats a word it refuses (Phase 2 exit follow-up F12, the lane's round-11 verification, needs 1, 2, 4 and 5;
-- DI-05, DI-30, INV-18; ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- What was wrong (recipe-core 0344, read with kernel 1030's rule).
--   (G1) recipe.engine_word allowed, in every member of every run, any word of the form of an engine name, whether or
--        not the run had such a record: (EX|EN|DP|DV|HOLD)-<n>, E<n>, S<n>, G-<nn>, G<nn>-<WORDS> and (DI|IN|INV|PR|ST)-<nn>.
--        The kernel's rule reads S24090017, E24090017, EX-24090017, DV-24090017, HOLD-2409017 and G24-LOT as real batch
--        or lot numbers; over HTTP operator1's exception descriptions and supervisor1's hold reason naming them were
--        recorded, S24090017 then sitting in rows, the state, events and content versions. E2409/0017 passed as a
--        compound of an engine name and a number.
--   (G2) In an audit entry the words of every person's legal name and login were allowed, and a row's actor_legal_name
--        was not read: after the administrator renamed operator1 'TEST-Priya L2409-0017' (kernel 1040 now refuses
--        that), L2409-0017 sat in the run's rows, its signature and 29 audit entries.
--   (G4) On a scale reading's chain ('device_reading:<id>') only the reason was read: the application role appended a
--        business entry 'Drum L2409-0017 on the scale' with details {lot: L2409-0017} there.
--   (G5) The refusal named the JSON path of the word, member names included: business details {"Z2409-0018": {"x":
--        "L2409-0017"}} were refused at $.body.details.Z2409-0018.x, so the message held the real-format word
--        Z2409-0018. An audit refusal also repeated the chain key, which the application role chooses.
--   Also found in this round's attack: the chain key of an entry on a run's chain or a reading's chain was read by
--   nothing (batch_step:<run>:L2409-0017 took a business entry), and 0344 read the text only with its escapes read
--   (kernel 1040 now reads it as written too).
--
-- What changed (recipe.execution_free_text_check and recipe.audit_free_text_check replaced; the triggers of 0344 stay,
-- the one on recipe.execution_command recreated to read actor_legal_name too).
--   (1) The words a run's record may hold that the identifier rule reads as real batch or lot numbers are only these,
--       none by its form alone:
--       * the run's MBR, batch number, site and room, as in 0344 (read as written and with escapes read);
--       * the names of the engine's registers, held in the new table recipe.engine_name and kept equal to the engine's
--         sources by a test (recipe-core test engine-names-sql): the block rule codes the engine's blocks give
--         (G<nn>-<WORDS>), the block types of the block registry (G-<nn>), the controls of the register (the 241 of
--         compliance/controls and the invariants INV-01 to INV-48 of the build outline), the engine's schema tag
--         ebmr.expr.evaluation/1 and the member name sha256;
--       * the ids of the records the run's state holds (recipe.state_record_ids): EX-, EN-, DP-, DV-, HOLD-<n> keyed in
--         their map, n at most the number of records that map holds (the engine numbers from 1 and never removes one);
--       * the flow edges of the run's MBR, e1 to e<m>, m the number of edges its compiled flow can have
--         (recipe.flow_edge_count, compile.ts's rule over the procedure with every library call expanded);
--       * a compound the engine builds, joined by '/': its parts each one of the above or a number, and a sample's
--         number S<n> only as the last part of an id that starts with the run's batch number (process.ts sampleId).
--   (2) Persons: execution_command.actor_legal_name is read; in an audit entry of a run's chain or a reading's chain
--       the actor's legal name is read, and the names and logins of the person register are no longer allowed words
--       (kernel 1040 holds the register to the rule; a name stored before it is refused where a run copies it).
--   (3) A scale reading's chain: every entry's reason, actor name and chain key, and every business entry's message and
--       details are read; the words allowed there are the site and room codes of the writing session and of its device
--       (a claim names the session's room) and the names of the engine's registers.
--   (4) The chain key of an entry on a run's chain is read after the run's id, and on a reading's chain after its
--       prefix.
--   (5) A refusal names the table, the column and the JSON path, a member name in the path only when it holds no word
--       read as a real batch or lot number that the run does not have (else <member>), and an audit refusal the chain
--       only up to the id it names: never the word.
-- The per-member guards stay: they bind meaning, this binds form. A row the server writes for an honest run passes
-- (the golden run and the round-10 and round-11 tests). Stricter than before, never weaker: a word that only looked like
-- an engine name, a person's name or a reading's text is now refused in a test run, 422 EBMR-EXE-147, nothing saved.
--
-- Corrections of earlier claims (applied migrations are never edited): 0344's header lists "the engine's own names" as
-- bound by their form, and says a refusal never names the word; both held only as stated here from this migration on.
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger functions are SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. recipe.engine_name is configuration shipped by migrations:
-- insert-only, audited, its rows attributed to the software release; the application roles have no right on it.
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05, DI-30 (header, item 1): the names the engine's registers give, upper-cased as the identifier rule compares
-- them. kind: RULE_CODE a block rule code, BLOCK_TYPE a block type of the registry, CONTROL a control of the register or
-- an invariant, SCHEMA_TAG an engine value's schema tag, MEMBER a member name the engine writes.
create table recipe.engine_name (
  name  text primary key check (name ~ '^[A-Z0-9][A-Z0-9/.-]{0,63}$'),
  kind  text not null check (kind in ('RULE_CODE', 'BLOCK_TYPE', 'CONTROL', 'SCHEMA_TAG', 'MEMBER'))
);
revoke all on recipe.engine_name from public;
select kernel.register_audited_table('recipe.engine_name', 'engine_name', 'name', true);

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0346_sandbox_bound_names)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the names of the engine''s registers a test run''s record may hold (DI-05, DI-30)'));

insert into recipe.engine_name (name, kind) values
  ('G03-ACK-MODE', 'RULE_CODE'), ('G03-NOT-ACKNOWLEDGED', 'RULE_CODE'), ('G03-SOP-REF', 'RULE_CODE'),
  ('G03-SOP-VERSION', 'RULE_CODE'), ('G07-BOM-INCOMPLETE', 'RULE_CODE'), ('G07-BOM-LINE', 'RULE_CODE'),
  ('G07-ITEM', 'RULE_CODE'), ('G07-LOT-EXPIRED', 'RULE_CODE'), ('G07-LOT-IDENTITY', 'RULE_CODE'),
  ('G07-LOT-RETEST', 'RULE_CODE'), ('G07-LOT-STATUS', 'RULE_CODE'), ('G07-NET', 'RULE_CODE'),
  ('G07-NO-BOM', 'RULE_CODE'), ('G07-TOLERANCE-MISSING', 'RULE_CODE'), ('G07-UNIT', 'RULE_CODE'),
  ('G07-WRONG-MATERIAL', 'RULE_CODE'), ('G08-CONSUMED', 'RULE_CODE'), ('G08-LABEL', 'RULE_CODE'),
  ('G08-MISSING-CONTAINER', 'RULE_CODE'), ('G08-OTHER-SUBLOT', 'RULE_CODE'), ('G08-UNPLANNED', 'RULE_CODE'),
  ('G08-WRONG-CONTAINER', 'RULE_CODE'), ('G09-ANSWERS', 'RULE_CODE'), ('G09-CHECK-IDS', 'RULE_CODE'),
  ('G09-EQUIPMENT', 'RULE_CODE'), ('G09-INCOMPLETE', 'RULE_CODE'), ('G10-ANSWERS', 'RULE_CODE'),
  ('G10-CHECK-IDS', 'RULE_CODE'), ('G10-INCOMPLETE', 'RULE_CODE'), ('G10-NO-CHECKER', 'RULE_CODE'),
  ('G10-NOT-APPLICABLE', 'RULE_CODE'), ('G12-NOT-PLANNED', 'RULE_CODE'), ('G14-NO-CALCULATION', 'RULE_CODE'),
  ('G15-TRANSFER', 'RULE_CODE'), ('G20-NO-CALCULATION', 'RULE_CODE'), ('G20-NO-VERIFIER', 'RULE_CODE'),
  ('G22-NET', 'RULE_CODE'), ('G22-NO-CONTAINER', 'RULE_CODE'), ('G22-NOT-PRODUCED', 'RULE_CODE'),
  ('G22-UNIT', 'RULE_CODE'), ('G23-BATCH-CODED', 'RULE_CODE'), ('G23-CONTAINER', 'RULE_CODE'),
  ('G23-METHOD', 'RULE_CODE'), ('G23-WITNESS', 'RULE_CODE'), ('G24-CHAINED', 'RULE_CODE'),
  ('G24-NO-ADDITION', 'RULE_CODE'), ('G24-NO-CASE', 'RULE_CODE'), ('G24-NOT-AUTHORISED', 'RULE_CODE'),
  ('G24-OTHER-PRODUCT', 'RULE_CODE'), ('G24-SELF-AUTHORISED', 'RULE_CODE'), ('G24-TOO-MANY-SOURCES', 'RULE_CODE'),
  ('G24-TOO-MUCH', 'RULE_CODE'), ('G24-TOO-OLD', 'RULE_CODE'), ('G-01', 'BLOCK_TYPE'), ('G-02', 'BLOCK_TYPE'),
  ('G-03', 'BLOCK_TYPE'), ('G-04', 'BLOCK_TYPE'), ('G-05', 'BLOCK_TYPE'), ('G-07', 'BLOCK_TYPE'),
  ('G-08', 'BLOCK_TYPE'), ('G-09', 'BLOCK_TYPE'), ('G-10', 'BLOCK_TYPE'), ('G-11', 'BLOCK_TYPE'),
  ('G-12', 'BLOCK_TYPE'), ('G-13', 'BLOCK_TYPE'), ('G-14', 'BLOCK_TYPE'), ('G-15', 'BLOCK_TYPE'),
  ('G-16', 'BLOCK_TYPE'), ('G-17', 'BLOCK_TYPE'), ('G-18', 'BLOCK_TYPE'), ('G-19', 'BLOCK_TYPE'),
  ('G-20', 'BLOCK_TYPE'), ('G-22', 'BLOCK_TYPE'), ('G-23', 'BLOCK_TYPE'), ('G-24', 'BLOCK_TYPE'), ('DI-01', 'CONTROL'),
  ('DI-02', 'CONTROL'), ('DI-03', 'CONTROL'), ('DI-04', 'CONTROL'), ('DI-05', 'CONTROL'), ('DI-06', 'CONTROL'),
  ('DI-07', 'CONTROL'), ('DI-08', 'CONTROL'), ('DI-09', 'CONTROL'), ('DI-10', 'CONTROL'), ('DI-11', 'CONTROL'),
  ('DI-12', 'CONTROL'), ('DI-13', 'CONTROL'), ('DI-14', 'CONTROL'), ('DI-15', 'CONTROL'), ('DI-16', 'CONTROL'),
  ('DI-17', 'CONTROL'), ('DI-18', 'CONTROL'), ('DI-19', 'CONTROL'), ('DI-20', 'CONTROL'), ('DI-21', 'CONTROL'),
  ('DI-22', 'CONTROL'), ('DI-23', 'CONTROL'), ('DI-24', 'CONTROL'), ('DI-25', 'CONTROL'), ('DI-26', 'CONTROL'),
  ('DI-27', 'CONTROL'), ('DI-28', 'CONTROL'), ('DI-29', 'CONTROL'), ('DI-30', 'CONTROL'), ('DI-31', 'CONTROL'),
  ('DI-32', 'CONTROL'), ('DI-33', 'CONTROL'), ('DI-34', 'CONTROL'), ('DI-35', 'CONTROL'), ('DI-36', 'CONTROL'),
  ('DI-37', 'CONTROL'), ('DI-38', 'CONTROL'), ('DI-39', 'CONTROL'), ('DI-40', 'CONTROL'), ('DI-41', 'CONTROL'),
  ('DI-42', 'CONTROL'), ('DI-43', 'CONTROL'), ('DI-44', 'CONTROL'), ('DI-45', 'CONTROL'), ('DI-46', 'CONTROL'),
  ('DI-47', 'CONTROL'), ('DI-48', 'CONTROL'), ('DI-49', 'CONTROL'), ('DI-50', 'CONTROL'), ('IN-01', 'CONTROL'),
  ('IN-02', 'CONTROL'), ('IN-03', 'CONTROL'), ('IN-04', 'CONTROL'), ('IN-05', 'CONTROL'), ('IN-06', 'CONTROL'),
  ('IN-07', 'CONTROL'), ('IN-08', 'CONTROL'), ('IN-09', 'CONTROL'), ('IN-10', 'CONTROL'), ('IN-11', 'CONTROL'),
  ('IN-12', 'CONTROL'), ('IN-13', 'CONTROL'), ('IN-14', 'CONTROL'), ('IN-15', 'CONTROL'), ('IN-16', 'CONTROL'),
  ('IN-17', 'CONTROL'), ('IN-18', 'CONTROL'), ('IN-19', 'CONTROL'), ('IN-20', 'CONTROL'), ('IN-21', 'CONTROL'),
  ('IN-22', 'CONTROL'), ('IN-23', 'CONTROL'), ('IN-24', 'CONTROL'), ('IN-25', 'CONTROL'), ('IN-26', 'CONTROL'),
  ('IN-27', 'CONTROL'), ('IN-28', 'CONTROL'), ('IN-29', 'CONTROL'), ('IN-30', 'CONTROL'), ('IN-31', 'CONTROL'),
  ('IN-32', 'CONTROL'), ('IN-33', 'CONTROL'), ('IN-34', 'CONTROL'), ('IN-35', 'CONTROL'), ('IN-36', 'CONTROL'),
  ('IN-37', 'CONTROL'), ('IN-38', 'CONTROL'), ('IN-39', 'CONTROL'), ('IN-40', 'CONTROL'), ('IN-41', 'CONTROL'),
  ('IN-42', 'CONTROL'), ('IN-43', 'CONTROL'), ('IN-44', 'CONTROL'), ('IN-45', 'CONTROL'), ('IN-46', 'CONTROL'),
  ('IN-47', 'CONTROL'), ('IN-48', 'CONTROL'), ('IN-49', 'CONTROL'), ('IN-50', 'CONTROL'), ('IN-51', 'CONTROL'),
  ('IN-52', 'CONTROL'), ('PR-01', 'CONTROL'), ('PR-02', 'CONTROL'), ('PR-03', 'CONTROL'), ('PR-04', 'CONTROL'),
  ('PR-05', 'CONTROL'), ('PR-06', 'CONTROL'), ('PR-07', 'CONTROL'), ('PR-08', 'CONTROL'), ('PR-09', 'CONTROL'),
  ('PR-10', 'CONTROL'), ('PR-11', 'CONTROL'), ('PR-12', 'CONTROL'), ('PR-13', 'CONTROL'), ('PR-14', 'CONTROL'),
  ('PR-15', 'CONTROL'), ('PR-16', 'CONTROL'), ('PR-17', 'CONTROL'), ('PR-18', 'CONTROL'), ('PR-19', 'CONTROL'),
  ('PR-20', 'CONTROL'), ('PR-21', 'CONTROL'), ('PR-22', 'CONTROL'), ('PR-23', 'CONTROL'), ('PR-24', 'CONTROL'),
  ('PR-25', 'CONTROL'), ('PR-26', 'CONTROL'), ('PR-27', 'CONTROL'), ('PR-28', 'CONTROL'), ('PR-29', 'CONTROL'),
  ('PR-30', 'CONTROL'), ('PR-31', 'CONTROL'), ('PR-32', 'CONTROL'), ('PR-33', 'CONTROL'), ('PR-34', 'CONTROL'),
  ('PR-35', 'CONTROL'), ('PR-36', 'CONTROL'), ('PR-37', 'CONTROL'), ('PR-38', 'CONTROL'), ('PR-39', 'CONTROL'),
  ('PR-40', 'CONTROL'), ('PR-41', 'CONTROL'), ('PR-42', 'CONTROL'), ('PR-43', 'CONTROL'), ('PR-44', 'CONTROL'),
  ('PR-45', 'CONTROL'), ('PR-46', 'CONTROL'), ('PR-47', 'CONTROL'), ('PR-48', 'CONTROL'), ('PR-49', 'CONTROL'),
  ('PR-50', 'CONTROL'), ('PR-51', 'CONTROL'), ('PR-52', 'CONTROL'), ('PR-53', 'CONTROL'), ('PR-54', 'CONTROL'),
  ('PR-55', 'CONTROL'), ('PR-56', 'CONTROL'), ('PR-57', 'CONTROL'), ('PR-58', 'CONTROL'), ('PR-59', 'CONTROL'),
  ('PR-60', 'CONTROL'), ('ST-01', 'CONTROL'), ('ST-02', 'CONTROL'), ('ST-03', 'CONTROL'), ('ST-04', 'CONTROL'),
  ('ST-05', 'CONTROL'), ('ST-06', 'CONTROL'), ('ST-07', 'CONTROL'), ('ST-08', 'CONTROL'), ('ST-09', 'CONTROL'),
  ('ST-10', 'CONTROL'), ('ST-11', 'CONTROL'), ('ST-12', 'CONTROL'), ('ST-13', 'CONTROL'), ('ST-14', 'CONTROL'),
  ('ST-15', 'CONTROL'), ('ST-16', 'CONTROL'), ('ST-17', 'CONTROL'), ('ST-18', 'CONTROL'), ('ST-19', 'CONTROL'),
  ('ST-20', 'CONTROL'), ('ST-21', 'CONTROL'), ('ST-22', 'CONTROL'), ('ST-23', 'CONTROL'), ('ST-24', 'CONTROL'),
  ('ST-25', 'CONTROL'), ('ST-26', 'CONTROL'), ('ST-27', 'CONTROL'), ('ST-28', 'CONTROL'), ('ST-29', 'CONTROL'),
  ('ST-30', 'CONTROL'), ('ST-31', 'CONTROL'), ('ST-32', 'CONTROL'), ('ST-33', 'CONTROL'), ('ST-34', 'CONTROL'),
  ('ST-35', 'CONTROL'), ('ST-36', 'CONTROL'), ('ST-37', 'CONTROL'), ('ST-38', 'CONTROL'), ('ST-39', 'CONTROL'),
  ('ST-40', 'CONTROL'), ('ST-41', 'CONTROL'), ('ST-42', 'CONTROL'), ('ST-43', 'CONTROL'), ('ST-44', 'CONTROL'),
  ('ST-45', 'CONTROL'), ('ST-46', 'CONTROL'), ('ST-47', 'CONTROL'), ('ST-48', 'CONTROL'), ('ST-49', 'CONTROL'),
  ('ST-50', 'CONTROL'), ('ST-51', 'CONTROL'), ('ST-52', 'CONTROL'), ('ST-53', 'CONTROL'), ('ST-54', 'CONTROL'),
  ('ST-55', 'CONTROL'), ('ST-56', 'CONTROL'), ('ST-57', 'CONTROL'), ('ST-58', 'CONTROL'), ('ST-59', 'CONTROL'),
  ('ST-60', 'CONTROL'), ('ST-61', 'CONTROL'), ('ST-62', 'CONTROL'), ('ST-63', 'CONTROL'), ('ST-64', 'CONTROL'),
  ('ST-65', 'CONTROL'), ('ST-66', 'CONTROL'), ('ST-67', 'CONTROL'), ('ST-68', 'CONTROL'), ('ST-69', 'CONTROL'),
  ('ST-70', 'CONTROL'), ('ST-71', 'CONTROL'), ('ST-72', 'CONTROL'), ('ST-73', 'CONTROL'), ('ST-74', 'CONTROL'),
  ('ST-75', 'CONTROL'), ('ST-76', 'CONTROL'), ('ST-77', 'CONTROL'), ('ST-78', 'CONTROL'), ('ST-79', 'CONTROL'),
  ('INV-01', 'CONTROL'), ('INV-02', 'CONTROL'), ('INV-03', 'CONTROL'), ('INV-04', 'CONTROL'), ('INV-05', 'CONTROL'),
  ('INV-06', 'CONTROL'), ('INV-07', 'CONTROL'), ('INV-08', 'CONTROL'), ('INV-09', 'CONTROL'), ('INV-10', 'CONTROL'),
  ('INV-11', 'CONTROL'), ('INV-12', 'CONTROL'), ('INV-13', 'CONTROL'), ('INV-14', 'CONTROL'), ('INV-15', 'CONTROL'),
  ('INV-16', 'CONTROL'), ('INV-17', 'CONTROL'), ('INV-18', 'CONTROL'), ('INV-19', 'CONTROL'), ('INV-20', 'CONTROL'),
  ('INV-21', 'CONTROL'), ('INV-22', 'CONTROL'), ('INV-23', 'CONTROL'), ('INV-24', 'CONTROL'), ('INV-25', 'CONTROL'),
  ('INV-26', 'CONTROL'), ('INV-27', 'CONTROL'), ('INV-28', 'CONTROL'), ('INV-29', 'CONTROL'), ('INV-30', 'CONTROL'),
  ('INV-31', 'CONTROL'), ('INV-32', 'CONTROL'), ('INV-33', 'CONTROL'), ('INV-34', 'CONTROL'), ('INV-35', 'CONTROL'),
  ('INV-36', 'CONTROL'), ('INV-37', 'CONTROL'), ('INV-38', 'CONTROL'), ('INV-39', 'CONTROL'), ('INV-40', 'CONTROL'),
  ('INV-41', 'CONTROL'), ('INV-42', 'CONTROL'), ('INV-43', 'CONTROL'), ('INV-44', 'CONTROL'), ('INV-45', 'CONTROL'),
  ('INV-46', 'CONTROL'), ('INV-47', 'CONTROL'), ('INV-48', 'CONTROL'), ('EBMR.EXPR.EVALUATION/1', 'SCHEMA_TAG'),
  ('SHA256', 'MEMBER');

select kernel.set_actor_context(null);

-- DI-05 (header, item 1): [edges, 1 when it compiles to a fragment else 0] of node p_node of MBR content p_content,
-- as compile.ts compileNode counts the edges of the expanded flow, every library call expanded (a call the engine
-- could not expand gives none, so the count is never below the engine's); p_calls the elements being expanded.
create function recipe.flow_fragment_edges(p_content jsonb, p_node jsonb, p_calls text[]) returns integer[]
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_kind text := case when jsonb_typeof(p_node) = 'object' then p_node ->> 'kind' end;
  v_e    integer := 0;
  v_n    integer := 0;
  v_f    integer[];
  v_els  bigint;
  v_body jsonb;
  c      jsonb;
begin
  if v_kind in ('phase', 'holdPoint') then
    return array[0, 1];
  elsif v_kind = 'libraryCall' then
    select count(*), (array_agg(e -> 'body'))[1] into v_els, v_body
      from jsonb_array_elements(case when jsonb_typeof(p_content -> 'library') = 'array' then p_content -> 'library' else '[]'::jsonb end) e
     where e ->> 'ref' = p_node ->> 'element';
    if v_els is distinct from 1 or (p_node ->> 'element') = any (p_calls) then
      return array[0, 0];
    end if;
    -- A sequence of one part, the element's body.
    return recipe.flow_fragment_edges(p_content, v_body, p_calls || (p_node ->> 'element'));
  elsif v_kind = 'sequence' then
    for c in select x from jsonb_array_elements(case when jsonb_typeof(p_node -> 'children') = 'array' then p_node -> 'children' else '[]'::jsonb end) x loop
      v_f := recipe.flow_fragment_edges(p_content, c, p_calls);
      v_e := v_e + v_f[1];
      v_n := v_n + v_f[2];
    end loop;
    return array[v_e + greatest(v_n - 1, 0), least(v_n, 1)];
  elsif v_kind in ('stage', 'operation', 'replicate') then
    v_f := recipe.flow_fragment_edges(p_content, p_node -> 'body', p_calls);
    return array[v_f[1] + 1 + v_f[2], 1];
  elsif v_kind = 'loop' then
    v_f := recipe.flow_fragment_edges(p_content, p_node -> 'body', p_calls);
    return array[v_f[1] + 2 + v_f[2], 1];
  elsif v_kind in ('parallel', 'alternative') then
    for c in select x from jsonb_array_elements(case when jsonb_typeof(p_node -> 'branches') = 'array' then p_node -> 'branches' else '[]'::jsonb end) x loop
      v_f := case when jsonb_typeof(c -> 'body') = 'object' then recipe.flow_fragment_edges(p_content, c -> 'body', p_calls) else array[0, 0] end;
      v_e := v_e + v_f[1] + 1 + v_f[2];
    end loop;
    return array[v_e, 1];
  end if;
  return array[0, 0];
end
$$;

-- DI-05 (header, item 1): the number of edges the compiled flow of MBR content p_content can have (compile.ts
-- compileFlow: the procedure's body between start and end).
create function recipe.flow_edge_count(p_content jsonb) returns integer
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select f[1] + 1 + f[2] from (select recipe.flow_fragment_edges(p_content, p_content -> 'procedure' -> 'body', '{}'::text[]) as f) x
$$;

-- DI-05 (header, item 1): the ids of the records state p_state holds, as the engine numbers them: <prefix>-<n> keyed in
-- its map, n at most the number of records that map holds.
create function recipe.state_record_ids(p_state jsonb) returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(array_agg(k.k), '{}')
    from (values ('exceptions', 'EX'), ('entries', 'EN'), ('points', 'DP'), ('derived', 'DV'), ('holds', 'HOLD')) m (map, prefix)
   cross join lateral (select case when jsonb_typeof(p_state -> m.map) = 'object' then p_state -> m.map else '{}'::jsonb end as v) x
   cross join lateral (select count(*) as n from jsonb_object_keys(x.v)) c
   cross join lateral jsonb_object_keys(x.v) k (k)
   where k.k ~ ('^' || m.prefix || '-[1-9][0-9]{0,8}$')
     and substr(k.k, length(m.prefix) + 2)::bigint <= c.n
$$;

-- DI-05: the words of text p_text a bound source contributes, upper-cased: every run of letters, digits, '.' and '-',
-- in the text as written and with its escapes read (kernel 1040).
create function recipe.source_words(p_text text) returns text[]
language sql immutable strict set search_path = pg_catalog, sandbox, pg_temp as $$
  select coalesce(array_agg(distinct sandbox.ascii_upper(m[1])), '{}')
    from (select sandbox.as_written(p_text) as t union all select sandbox.escapes_decoded(normalize(p_text, NFKC))) f
   cross join lateral regexp_matches(f.t, '([A-Za-z0-9][A-Za-z0-9.-]*)', 'g') m
$$;

-- DI-05 (header, item 1): what test batch p_batch's record may hold from a bound source, for the words of value p_value:
-- the words of its MBR (the imported package's content, product, family code and version), batch number, site and room;
-- the names of the engine's registers; the ids of the records its state holds; and, when p_value holds a word of
-- that form, its MBR's flow edges E1 to E<m>. Empty for a batch that does not exist.
create function recipe.run_bound_words(p_batch uuid, p_value jsonb) returns text[]
language plpgsql stable set search_path = pg_catalog, recipe, sandbox, pg_temp as $$
declare
  v_content jsonb;
  v_out     text[];
begin
  select p.content, recipe.source_words(jsonb_build_array(p.content, p.product, p.family_code, p.version_number, b.batch_number, b.site_code, b.room_code)::text)
    into v_content, v_out
    from recipe.batch_execution b
    join recipe.test_package p on p.package_hash = b.package_hash
   where b.id = p_batch;
  if not found then
    return '{}';
  end if;
  v_out := v_out || array(select n.name from recipe.engine_name n)
                 || recipe.state_record_ids((select s.state from recipe.execution_state s where s.batch_id = p_batch));
  if exists (select 1 from sandbox.identifier_words(p_value) w where w ~* '(^|/)e[0-9]+(/|$)') then
    v_out := v_out || array(select 'E' || g from generate_series(1, recipe.flow_edge_count(v_content)) g);
  end if;
  return v_out;
end
$$;

-- DI-05 (header, item 1): whether word p_word is bound: one of p_bound (upper-cased), or a compound the engine builds,
-- joined by '/', each part one of p_bound or a number, and a sample's number S<n> only as the last part of an id that
-- starts with batch number p_batch_number.
create function recipe.run_word_bound(p_word text, p_bound text[], p_batch_number text) returns boolean
language plpgsql immutable set search_path = pg_catalog, sandbox, pg_temp as $$
declare
  v_up     text := sandbox.ascii_upper(p_word);
  v_bn     text := sandbox.ascii_upper(p_batch_number);
  v_parts  text[];
  v_sample boolean := false;
  i        integer;
begin
  if v_up = any (p_bound) then
    return true;
  end if;
  if strpos(v_up, '/') = 0 then
    return false;
  end if;
  if v_bn is not null and starts_with(v_up, v_bn || '/') then
    v_parts := string_to_array(substr(v_up, length(v_bn) + 2), '/');
    v_sample := true;
  else
    v_parts := string_to_array(v_up, '/');
  end if;
  if coalesce(cardinality(v_parts), 0) = 0 then
    return false;
  end if;
  for i in 1 .. cardinality(v_parts) loop
    continue when v_parts[i] ~ '^[0-9]+$' or v_parts[i] = any (p_bound)
              or (v_sample and i = cardinality(v_parts) and v_parts[i] ~ '^S[1-9][0-9]{0,8}$');
    return false;
  end loop;
  return true;
end
$$;

-- DI-05 (header, item 1): the first word of value p_value that the identifier rule reads as a real batch or lot number
-- (kernel 1030, 1040) and that is not bound (recipe.run_word_bound); NULL when there is none.
create function recipe.unbound_real_identifier(p_value jsonb, p_bound text[], p_batch_number text) returns text
language plpgsql stable set search_path = pg_catalog, recipe, sandbox, pg_temp as $$
declare
  w text;
  p text;
begin
  for w in select x from sandbox.identifier_words(p_value) x order by 1 loop
    continue when recipe.run_word_bound(w, p_bound, p_batch_number);
    for p in select y from sandbox.real_identifier_parts(w) y order by 1 loop
      continue when recipe.run_word_bound(p, p_bound, p_batch_number);
      return p;
    end loop;
  end loop;
  return null;
end
$$;

-- DI-05 (header, item 5): where in value p_value word p_word stands: the JSON path of the first string holding it (as
-- written or with its escapes read), or of the object one of whose member names holds it. A member name on the path
-- that holds a word read as a real batch or lot number not bound by p_bound is written <member>: the path never
-- repeats such a word.
create function recipe.word_path(p_value jsonb, p_word text, p_bound text[], p_batch_number text) returns text
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
      where jsonb_typeof(t.v) = 'string'
        and (position(p_word in sandbox.as_written(t.v #>> '{}')) > 0 or position(p_word in sandbox.escapes_decoded(normalize(t.v #>> '{}', NFKC))) > 0)
      order by length(t.path), t.path limit 1),
    (select t.path || ' (the name of one of its members)' from t cross join lateral jsonb_object_keys(case when jsonb_typeof(t.v) = 'object' then t.v end) k
      where position(p_word in sandbox.as_written(k)) > 0 or position(p_word in sandbox.escapes_decoded(normalize(k, NFKC))) > 0
      order by length(t.path), t.path limit 1),
    '$')
$$;

-- DI-05 (header, item 5): chain key p_chain_key as a refusal shows it: up to the first UUID it names, then ':...' when
-- more follows; with no UUID, its kind before the first ':' then ':...'.
create function recipe.chain_shown(p_chain_key text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(
    (select m[1] || case when length(m[1]) < length(p_chain_key) then ':...' else '' end
       from regexp_match(p_chain_key, '^([a-z_:]{1,64}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') m),
    coalesce(substring(p_chain_key from '^([a-z_]{1,64}):'), 'an audit chain') || ':...')
$$;

-- DI-05 (header, item 3): the words a scale reading's chain may hold besides the engine's registers: the site and room
-- codes of the session of actor p_actor (an audit entry's actor) and of its device, upper-cased.
create function recipe.session_bound_words(p_actor jsonb) returns text[]
language sql stable set search_path = pg_catalog, recipe, iam, pg_temp as $$
  select coalesce(array_agg(distinct w), '{}')
    from (select unnest(recipe.source_words(concat_ws(' ', s.site_code, s.room_code))) w
            from iam.session s
           where s.id::text = p_actor ->> 'session_id'
          union all
          select unnest(recipe.source_words(concat_ws(' ', d.code, d.site_code, d.room_code, d.line_code)))
            from iam.device d
           where d.id::text = p_actor ->> 'device_id') x
$$;

-- DI-05, DI-30: row trigger of the execution store's tables (0344's, replaced; header). Arguments: the column holding
-- the batch id, then the columns to read. Outside a GMP installation, refuses a row whose named columns hold a word read
-- as a real batch or lot number that the run's record does not have from a bound source. EBMR-EXE-147. Raises; returns
-- nothing.
create or replace function recipe.execution_free_text_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, sandbox, kernel, pg_temp as $$
declare
  v_row    jsonb := to_jsonb(new);
  v_batch  uuid;
  v_number text;
  v_value  jsonb := '{}'::jsonb;
  v_bound  text[];
  v_word   text;
  i        integer;
begin
  if kernel.installation_kind() is not distinct from 'GMP' then
    return null;
  end if;
  v_batch := (v_row ->> tg_argv[0])::uuid;
  for i in 1 .. tg_nargs - 1 loop
    v_value := v_value || jsonb_build_object(tg_argv[i], v_row -> tg_argv[i]);
  end loop;
  -- Most rows hold no word the rule could read other than the names of the engine's registers: nothing more to read.
  if not exists (select 1 from sandbox.identifier_words(v_value) w
                  where not exists (select 1 from recipe.engine_name n where n.name = sandbox.ascii_upper(w))) then
    return null;
  end if;
  select b.batch_number into v_number from recipe.batch_execution b where b.id = v_batch;
  v_bound := recipe.run_bound_words(v_batch, v_value)
             || case when jsonb_typeof(v_row -> 'room_code') = 'string' then recipe.source_words(v_row ->> 'room_code') else '{}'::text[] end;
  for i in 1 .. tg_nargs - 1 loop
    v_word := recipe.unbound_real_identifier(v_row -> tg_argv[i], v_bound, v_number);
    if v_word is not null then
      raise exception using errcode = 'P0001',
        message = format('This %s row of test batch %s cannot be recorded: %s holds, at %s, a word of the form of a batch or lot number that is not a test one. A test run names a batch, lot or container only by a TEST- identifier (for example TEST-L24-0001), or describes it in words, whatever member holds it, so a real GMP identifier is never reused (DI-05, DI-30). [EBMR-EXE-147]',
                         tg_table_name, coalesce(v_batch::text, 'unknown'), tg_argv[i], recipe.word_path(v_row -> tg_argv[i], v_word, v_bound, v_number));
    end if;
  end loop;
  return null;
end
$$;

-- DI-05: an audit entry of a test run's chain, or of a scale reading's chain, names no real batch or lot number in what
-- the application can choose (0344's, replaced; header, items 2 to 5). EBMR-EXE-147. Raises; returns nothing.
create or replace function recipe.audit_free_text_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, sandbox, kernel, pg_temp as $$
declare
  v_batch  uuid;
  v_number text;
  v_tail   text;
  v_value  jsonb;
  v_bound  text[];
  v_word   text;
begin
  if kernel.installation_kind() is not distinct from 'GMP' then
    return null;
  end if;
  v_batch := recipe.audit_chain_batch(new.chain_key);
  if v_batch is not null then
    v_tail := substr(new.chain_key, strpos(new.chain_key, v_batch::text) + 36);
  elsif starts_with(new.chain_key, 'device_reading:') then
    v_tail := substr(new.chain_key, length('device_reading:') + 1);
  else
    return null;
  end if;
  v_value := jsonb_build_object('chain_key', v_tail, 'reason_code', new.payload -> 'reason_code', 'reason_text', new.payload -> 'reason_text',
                                'actor', jsonb_build_object('legal_name', new.payload -> 'actor' -> 'legal_name'))
             || case when new.action = 'BUSINESS' then jsonb_build_object('body', new.payload -> 'body') else '{}'::jsonb end;
  if not exists (select 1 from sandbox.identifier_words(v_value) w
                  where not exists (select 1 from recipe.engine_name n where n.name = sandbox.ascii_upper(w))) then
    return null;
  end if;
  if v_batch is not null then
    select b.batch_number into v_number from recipe.batch_execution b where b.id = v_batch;
    -- The run's own hashes: the issue's entry names the package and content by their leading characters.
    v_bound := recipe.run_bound_words(v_batch, v_value)
               || array(select sandbox.ascii_upper(x) from sandbox.identifier_words(v_value) x
                         where x ~ '^[0-9a-f]{8,63}$'
                           and exists (select 1 from recipe.batch_execution b
                                        where b.id = v_batch
                                          and (starts_with(b.package_hash, x) or starts_with(b.content_hash, x) or starts_with(b.policy_hash, x)
                                               or starts_with(b.registry_fingerprint, x))));
  else
    v_bound := array(select n.name from recipe.engine_name n) || recipe.session_bound_words(new.payload -> 'actor');
  end if;
  v_word := recipe.unbound_real_identifier(v_value, v_bound, v_number);
  if v_word is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s entry of audit chain %s%s cannot be recorded: it holds, at %s, a word of the form of a batch or lot number that is not a test one. A test run names a batch, lot or container only by a TEST- identifier (for example TEST-L24-0001), or describes it in words, also in a reason or a business entry of its audit trail (DI-05, DI-30). [EBMR-EXE-147]',
                       lower(new.action), recipe.chain_shown(new.chain_key), case when v_batch is not null then ' of test batch ' || v_batch else '' end,
                       recipe.word_path(v_value, v_word, v_bound, v_number));
  end if;
  return null;
end
$$;

-- (header, item 2) The row's actor name is read too.
drop trigger zzz_sandbox_free_text on recipe.execution_command;
create constraint trigger zzz_sandbox_free_text after insert on recipe.execution_command deferrable initially deferred
  for each row execute function recipe.execution_free_text_check('batch_id', 'kind', 'command_id', 'command_type', 'command', 'command_hash',
    'actor_role', 'actor_legal_name', 'source', 'device_class', 'room_code', 'refusal', 'state_hash', 'events_hash', 'roles', 'evidence',
    'prev_row_hash', 'row_hash');

-- 0344's helpers that allowed a word by its form, or a person's name in an audit entry, are no longer used.
drop function recipe.unbound_real_identifier(jsonb, text[]);
drop function recipe.bound_word(text, text[]);
drop function recipe.engine_word(text);
drop function recipe.word_path(jsonb, text);
drop function recipe.audit_bound_words(uuid, jsonb);
drop function recipe.batch_bound_words(uuid);

revoke all on function recipe.flow_fragment_edges(jsonb, jsonb, text[]), recipe.flow_edge_count(jsonb), recipe.state_record_ids(jsonb),
                       recipe.source_words(text), recipe.run_bound_words(uuid, jsonb), recipe.run_word_bound(text, text[], text),
                       recipe.unbound_real_identifier(jsonb, text[], text), recipe.word_path(jsonb, text, text[], text),
                       recipe.chain_shown(text), recipe.session_bound_words(jsonb) from public;

reset role;
