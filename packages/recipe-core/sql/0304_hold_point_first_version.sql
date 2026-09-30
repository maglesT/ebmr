-- Recipe core, execution store (module C3): a hold point's first content version is the system's only when it is,
-- in full, the content the engine derives for it (review finding P28, round-2 verification; DI-14, INV-03, DI-37,
-- PR-45; ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- 0280 and 0299 store the first content version of a hold point that the token advance of a person's row creates
-- (its STEP_STATUS_CHANGED from PENDING, by SYSTEM) under the internal system identity (recipe.system_actor), so the
-- person whose release enabled it is not logged as having changed it (esig.content_change) and may still decide it
-- (INV-03). 0299 proves a time fact's whole first version (recipe.exception_content_of), but for a hold point it kept
-- what 0280 checked: the step key and kind HOLD, no data point, derived value, entry or exception in the stored
-- content, nobody in the step instance, and the row's own event. The rest of the stored content was never derived:
-- the batch header, the step's title, number, stage and frames, and the instruction (node hash, text, SOP). The
-- round-2 verification stored a hold point whose title said to release at once and whose node hash was zeros, through
-- the application role; the database logged it as the system's creation (changedBy the nil person), the check of
-- the record found nothing, and QA would then sign that text at the hold-point decision.
--
-- The rule now is fail safe, as for a time fact: a hold point's first version is the system's only when the stored
-- content equals, member for member, the content the engine derives from the state the row produced and the batch's
-- MBR (signing-content.ts stepSigningContent for a hold point):
--   batch        the header, from the state and the MBR, as recipe.exception_content_of;
--   step         {key, id, kind HOLD, number, title (the node's name), stage, block null, frames};
--   instruction  {nodeHash (the canonical hash of the flow node), text null, sop null};
--   points, derived, entries and exceptions empty.
-- Anything else is stored under the validated person of the row, which is stricter (that person is then excluded
-- from deciding the hold point, INV-03). The document number is derived here as flow/numbering.ts numberMbr and
-- instanceNumber derive it: stages, operations and steps in document order, one counter per enclosing numbered
-- element, constructs and library calls without a number of their own (a library call's content under its expanded
-- id call/inner), every branch of an alternative numbered, and a suffix per loop iteration and sub-lot of the
-- instance. The stage is the nearest enclosing stage of the expanded tree (engine definition.ts). The flow node hashed
-- is the node as the parser and the library expansion give it (flow/parse.ts: kind, id, name, role, dispositions and
-- nothing else; flow/expand.ts: the expanded id). The frames (and so the number's suffix) come from the state
-- instance, so they must be the frames the engine gives every instance of the hold point (engine definition.ts
-- StepDef.constructs, flow/tokens.ts): one frame per enclosing loop or replicate section of the expanded tree, outermost
-- first, each with a whole index from 1. An MBR the numbering cannot number (a node without an id, a duplicate id, an
-- unknown library element or a recursive call, a node of no known kind), a state instance whose key is not its step
-- and frames, or one whose frames are not those of its enclosing constructs (a construct that does not enclose it, one
-- left out, another order, an index 0, negative, fractional or written as a decimal), gives no derivation, so the
-- version stays the person's.
--
-- Unchanged: the checks of the state instance (kind HOLD, ENABLED or NOT_APPLICABLE, no decision, start or end, no
-- performer, enterer, corrector, signer or signature) and of the row's own STEP_STATUS_CHANGED event from PENDING by
-- SYSTEM (0280); the time facts (0299). CREATE OR REPLACE keeps the owner (ebmr_owner), SECURITY DEFINER, the
-- volatility, the search_path and the privileges of recipe.created_by_system (owner only, 0280 and 0299); the new
-- helpers are private to the owner. Applied as a new migration because applied migrations are checksummed and never
-- edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Helpers (owner only)
-- ---------------------------------------------------------------------------------------------

-- One node p_node of a flow tree visited in document order (flow/numbering.ts numberFlow), inside the numbered element
-- numbered p_number ('' at the top), in stage p_stage, under the id prefix p_prefix of the library calls it lies in
-- (p_calls: the elements being expanded). p_acc carries the counter of the enclosing numbered element (n), the loops
-- and replicates enclosing p_node by expanded id, outermost first (path), the numbered nodes by expanded id (ids:
-- {kind, number, stage, within: the path at the node, engine definition.ts StepDef.constructs}) and the loops and
-- replicates by expanded id (constructs), and 'bad' once the tree cannot be numbered (numberFlow throws there).
create function recipe.flow_numbering_visit(p_content jsonb, p_node jsonb, p_number text, p_stage text, p_prefix text, p_calls text[], p_acc jsonb)
returns jsonb
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_acc  jsonb := p_acc;
  v_kind text := p_node ->> 'kind';
  v_id   text;
  v_n    integer;
  v_num  text;
  v_body jsonb;
  v_els  bigint;
  v_path jsonb;
  c      jsonb;
begin
  if v_acc ? 'bad' then
    return v_acc;
  end if;
  if jsonb_typeof(p_node) is distinct from 'object' or jsonb_typeof(p_node -> 'id') is distinct from 'string' then
    return v_acc || jsonb_build_object('bad', 'a node of the procedure has no id');
  end if;
  v_id := p_prefix || (p_node ->> 'id');
  -- Stages, operations and steps take the next number of the enclosing element; a stage or an operation numbers its
  -- body with a counter of its own.
  if v_kind in ('stage', 'operation', 'phase', 'holdPoint') then
    if (v_acc -> 'ids') ? v_id then
      return v_acc || jsonb_build_object('bad', format('node id %s occurs twice', v_id));
    end if;
    v_n := (v_acc ->> 'n')::integer + 1;
    v_num := case when p_number = '' then v_n::text else p_number || '.' || v_n::text end;
    v_acc := jsonb_set(jsonb_set(v_acc, '{n}', to_jsonb(v_n)), array['ids', v_id],
                      jsonb_build_object('kind', v_kind, 'number', v_num, 'stage', p_stage, 'within', coalesce(v_acc -> 'path', '[]'::jsonb)));
    if v_kind in ('stage', 'operation') then
      v_acc := recipe.flow_numbering_visit(p_content, p_node -> 'body', v_num, case when v_kind = 'stage' then v_id else p_stage end, p_prefix, p_calls,
                                           jsonb_set(v_acc, '{n}', '0'::jsonb));
      if not (v_acc ? 'bad') then
        v_acc := jsonb_set(v_acc, '{n}', to_jsonb(v_n));
      end if;
    end if;
    return v_acc;
  end if;
  -- A library call: the pinned element's body, numbered in place under the call's id.
  if v_kind = 'libraryCall' then
    if jsonb_typeof(p_node -> 'element') is distinct from 'string' or (p_node ->> 'element') = any (p_calls) then
      return v_acc || jsonb_build_object('bad', format('library call %s names no element or its own element', v_id));
    end if;
    select count(*), (array_agg(e -> 'body'))[1] into v_els, v_body
      from jsonb_array_elements(case when jsonb_typeof(p_content -> 'library') = 'array' then p_content -> 'library' else '[]'::jsonb end) e
     where e ->> 'ref' = p_node ->> 'element';
    if v_els is distinct from 1 then
      return v_acc || jsonb_build_object('bad', format('library call %s names %s, which the MBR does not embed once', v_id, p_node ->> 'element'));
    end if;
    return recipe.flow_numbering_visit(p_content, v_body, p_number, p_stage, v_id || '/', p_calls || (p_node ->> 'element'), v_acc);
  end if;
  -- Constructs take no number; loops and replicates give an instance its suffix, and every instance of a node in
  -- their body a frame of theirs (the path, while their body is visited).
  if v_kind in ('loop', 'replicate') then
    v_acc := jsonb_set(v_acc, array['constructs', v_id], to_jsonb(case v_kind when 'loop' then 'LOOP' else 'REPLICATE' end));
    v_path := coalesce(v_acc -> 'path', '[]'::jsonb);
    v_acc := recipe.flow_numbering_visit(p_content, p_node -> 'body', p_number, p_stage, p_prefix, p_calls,
                                         jsonb_set(v_acc, '{path}', v_path || to_jsonb(v_id)));
    if not (v_acc ? 'bad') then
      v_acc := jsonb_set(v_acc, '{path}', v_path);
    end if;
    return v_acc;
  end if;
  if v_kind = 'sequence' and jsonb_typeof(p_node -> 'children') = 'array' then
    for c in select a.v from jsonb_array_elements(p_node -> 'children') with ordinality a (v, i) order by a.i loop
      v_acc := recipe.flow_numbering_visit(p_content, c, p_number, p_stage, p_prefix, p_calls, v_acc);
    end loop;
    return v_acc;
  end if;
  -- Every branch of a parallel section; every branch of an alternative that has a body, taken or not.
  if v_kind in ('parallel', 'alternative') and jsonb_typeof(p_node -> 'branches') = 'array' then
    for c in select a.v -> 'body' from jsonb_array_elements(p_node -> 'branches') with ordinality a (v, i)
              where v_kind = 'parallel' or jsonb_typeof(a.v -> 'body') = 'object' order by a.i loop
      v_acc := recipe.flow_numbering_visit(p_content, c, p_number, p_stage, p_prefix, p_calls, v_acc);
    end loop;
    return v_acc;
  end if;
  return v_acc || jsonb_build_object('bad', format('node %s is of no kind a procedure has (%s)', v_id, coalesce(v_kind, 'none')));
end
$$;

-- The document numbering of MBR content p_content (flow/numbering.ts numberMbr): {ids: {<expanded id>: {kind, number,
-- stage, within}}, constructs: {<expanded id>: LOOP | REPLICATE}}, or {bad: <why>} when the procedure cannot be
-- numbered. within lists the loops and replicates enclosing the node, outermost first (engine StepDef.constructs).
create function recipe.flow_numbering(p_content jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select case when jsonb_typeof(p_content -> 'procedure' -> 'body') = 'object'
              then recipe.flow_numbering_visit(p_content, p_content -> 'procedure' -> 'body', '', null, '', '{}'::text[],
                                               '{"n": 0, "path": [], "ids": {}, "constructs": {}}'::jsonb) - 'n' - 'path'
              else '{"bad": "the content has no procedure"}'::jsonb end
$$;

-- The number of step p_step's instance in frames p_frames (flow/numbering.ts instanceNumber): the step's document
-- number and, inside loops or replicate sections, the suffix of each frame in order ("sub-lot 2", "iteration 3",
-- else "<construct> <index>"), e.g. "3.1.2 (sub-lot 2, iteration 1)". NULL when p_numbering has no such step or a frame
-- is malformed (fail closed).
create function recipe.step_instance_number(p_numbering jsonb, p_step text, p_frames jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
    when p_numbering ? 'bad' or coalesce(p_numbering -> 'ids' -> p_step ->> 'kind', '') not in ('phase', 'holdPoint')
         or jsonb_typeof(p_numbering -> 'ids' -> p_step -> 'number') is distinct from 'string' or jsonb_typeof(p_frames) is distinct from 'array'
         or exists (select 1 from jsonb_array_elements(p_frames) f
                     where jsonb_typeof(f -> 'construct') is distinct from 'string' or jsonb_typeof(f -> 'index') is distinct from 'number')
      then null
    when jsonb_array_length(p_frames) = 0 then p_numbering -> 'ids' -> p_step ->> 'number'
    else (p_numbering -> 'ids' -> p_step ->> 'number') || ' ('
         || (select string_agg(case p_numbering -> 'constructs' ->> (a.f ->> 'construct')
                                 when 'REPLICATE' then 'sub-lot '
                                 when 'LOOP' then 'iteration '
                                 else (a.f ->> 'construct') || ' ' end || (a.f ->> 'index'), ', ' order by a.n)
               from jsonb_array_elements(p_frames) with ordinality a (f, n))
         || ')'
  end
$$;

-- The first content version the engine derives for hold-point instance p_key of state p_state, p_mbr being the batch's
-- MBR content (signing-content.ts stepSigningContent for a hold point, with no data point, derived value, entry or
-- exception of its own yet). NULL when the state has no such hold point, the MBR has no such hold-point node, its
-- number cannot be derived, or its frames are not the ones of its enclosing loops and replicate sections (fail closed:
-- the version then stays the person's).
create function recipe.hold_point_content_of(p_mbr jsonb, p_state jsonb, p_key text) returns jsonb
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  x           jsonb := p_state -> 'steps' -> p_key;
  v_step      text;
  v_node      jsonb;
  v_numbering jsonb;
  v_number    text;
begin
  if jsonb_typeof(x) is distinct from 'object' or x ->> 'kind' is distinct from 'HOLD' or jsonb_typeof(x -> 'step') is distinct from 'string'
     or jsonb_typeof(x -> 'frames') is distinct from 'array' or p_key is distinct from (x ->> 'step') || '@' || recipe.ctx_key(x -> 'frames') then
    return null;
  end if;
  v_step := x ->> 'step';
  v_node := recipe.step_node(p_mbr, v_step);
  if v_node ->> 'kind' is distinct from 'holdPoint' then
    return null;
  end if;
  v_numbering := recipe.flow_numbering(p_mbr);
  v_number := recipe.step_instance_number(v_numbering, v_step, x -> 'frames');
  if v_number is null or v_numbering -> 'ids' -> v_step ->> 'kind' is distinct from 'holdPoint' then
    return null;
  end if;
  -- The frames are the ones the engine gives every instance of this hold point (flow/tokens.ts): one per loop or
  -- replicate section enclosing it, outermost first, each with a whole index from 1 written as the engine writes it
  -- (2, never 2.0, which would file a second instance of the same sub-lot under the key R=2.0). step_instance_number
  -- has already refused a frame without a text construct or a numeric index.
  if (select coalesce(jsonb_agg(a.f -> 'construct' order by a.n), '[]'::jsonb) from jsonb_array_elements(x -> 'frames') with ordinality a (f, n))
       is distinct from (v_numbering -> 'ids' -> v_step -> 'within')
     or exists (select 1 from jsonb_array_elements(x -> 'frames') f where (f ->> 'index') !~ '^[1-9][0-9]*$') then
    return null;
  end if;
  return jsonb_build_object(
    'schema', 'ebmr.batch-step-content',
    'batch', jsonb_build_object('batchNumber', p_state -> 'header' -> 'batchNumber', 'batchId', p_state -> 'header' -> 'batchId', 'mbrHash', p_state -> 'mbrHash',
                                'family', p_mbr -> 'header' -> 'family', 'product', p_mbr -> 'header' -> 'product' -> 'code'),
    'step', jsonb_build_object('key', p_key, 'id', v_step, 'kind', 'HOLD', 'number', v_number, 'title', v_node -> 'name',
                               'stage', coalesce(v_numbering -> 'ids' -> v_step -> 'stage', 'null'::jsonb), 'block', 'null'::jsonb,
                               'frames', recipe.content_frames(x -> 'frames')),
    -- The node as the parser and the expansion give it: its own five members, under its expanded id.
    'instruction', jsonb_build_object('nodeHash', recipe.canonical_hash(jsonb_build_object('kind', 'holdPoint', 'id', v_step, 'name', v_node -> 'name',
                                                                                          'role', v_node -> 'role', 'dispositions', v_node -> 'dispositions')),
                                      'text', 'null'::jsonb, 'sop', 'null'::jsonb),
    'points', '[]'::jsonb, 'derived', '[]'::jsonb, 'entries', '[]'::jsonb, 'exceptions', '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The attribution
-- ---------------------------------------------------------------------------------------------

-- Whether content p_c ({type, key, content}) is the first version of a record the system created in row p_seq of
-- batch p_batch, whose resulting state is p_state, with nobody's entry in it:
--   * an exception raised by SYSTEM (a time fact, checked in full by recipe.execution_system_fact_check when the state
--     was written), told by this row's EXCEPTION_RAISED event, open and unlinked, whose stored content is exactly the
--     content the engine derives from it (recipe.exception_content_of; 0299, unchanged);
--   * a hold point that this row's token advance enabled or set not applicable (its STEP_STATUS_CHANGED event from
--     PENDING, by SYSTEM), not started, decided or signed, with no performer, enterer, corrector or signer, whose
--     stored content is exactly the content the engine derives for it (recipe.hold_point_content_of; now).
create or replace function recipe.created_by_system(p_batch uuid, p_seq bigint, p_state jsonb, p_c jsonb) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_key text := p_c ->> 'key';
  v_ct  jsonb := p_c -> 'content';
  v_mbr jsonb;
  x     jsonb;
  f     text;
begin
  if jsonb_typeof(p_state) is distinct from 'object' or v_key is null or jsonb_typeof(v_ct) is distinct from 'object' then
    return false;
  end if;
  if p_c ->> 'type' = 'batch_exception' then
    x := p_state -> 'exceptions' -> v_key;
    if not coalesce(jsonb_typeof(x) = 'object' and x ->> 'raisedBy' = 'SYSTEM' and recipe.is_system_fact(x ->> 'type') and x ->> 'status' = 'OPEN'
                    and not (x ?| array['deviation', 'disposition']), false) then
      return false;
    end if;
    select pk.content into v_mbr from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = p_batch;
    return coalesce(
      exists (select 1 from recipe.execution_event e
               where e.batch_id = p_batch and e.row_seq = p_seq and e.event_type = 'EXCEPTION_RAISED'
                 and e.event ->> 'exception' = v_key and e.event ->> 'exceptionType' = x ->> 'type')
      and v_ct = recipe.exception_content_of(v_mbr, p_state, x),
      false);
  end if;
  if p_c ->> 'type' = 'batch_step' then
    x := p_state -> 'steps' -> v_key;
    if jsonb_typeof(x) is distinct from 'object' or x ->> 'kind' is distinct from 'HOLD' or coalesce(x ->> 'status', '') not in ('ENABLED', 'NOT_APPLICABLE')
       or x ?| array['disposition', 'startedAt', 'endedAt'] then
      return false;
    end if;
    foreach f in array array['performers', 'dataEnterers', 'correctors', 'performedSigners', 'signatures'] loop
      if coalesce(x -> f, '[]'::jsonb) is distinct from '[]'::jsonb then
        return false;
      end if;
    end loop;
    select pk.content into v_mbr from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = p_batch;
    return coalesce(
      v_ct = recipe.hold_point_content_of(v_mbr, p_state, v_key)
      and exists (select 1 from recipe.execution_event e
                   where e.batch_id = p_batch and e.row_seq = p_seq and e.event_type = 'STEP_STATUS_CHANGED'
                     and e.event ->> 'stepKey' = v_key and e.event ->> 'from' = 'PENDING' and e.event ->> 'by' = 'SYSTEM'),
      false);
  end if;
  return false;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: every new helper is private to the owner (recipe.created_by_system runs them). CREATE OR REPLACE kept the
-- privileges of recipe.created_by_system (0280, 0299: owner only).
-- ---------------------------------------------------------------------------------------------

revoke all on function recipe.flow_numbering_visit(jsonb, jsonb, text, text, text, text[], jsonb), recipe.flow_numbering(jsonb),
                       recipe.step_instance_number(jsonb, text, jsonb), recipe.hold_point_content_of(jsonb, jsonb, text)
  from public;

reset role;
