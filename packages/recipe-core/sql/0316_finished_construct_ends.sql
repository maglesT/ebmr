-- Recipe core, execution store (module C3): a construct the token has finished records its END in the row that
-- finishes it, wherever it lies (Phase 2 exit review F67, round-3 verification, completing 0312 and 0314; INV-20, PR-30,
-- DI-27, DI-34; ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- 0314 required the END of a construct the token left only when a later step arrived, and only for the constructs
-- before that step in a sequence it lies in, not those inside an alternative, a loop iteration or a sub-lot of them.
-- 0308 measures a minimum only for the node events a row adds. The round-3 verification stored, through the
-- application role, on dc-mini with an alternative chosen by the issue variant at the start of the dispensing stage
-- (branch A: operation O-ALT with the SOP read p-alt-sop) and a 1 h minimum from O-ALT's START to its END, operator1's
-- signed SIGN_PERFORMED of p-alt-sop seconds after its start, with the engine result of a definition without that
-- minimum and O-ALT's END left out: accepted, no TIME_MIN_BREACH, the clearance enabled after it, and the invariant
-- query reported nothing. By the same reading, the END of the last operation of the final stage was never required.
--
-- The engine records the END of an operation, a parallel or alternative section and a replicate section in the same
-- advance in which the token finishes what it holds (advance.ts afterFire: SCOPE_END fires at once for an operation,
-- AND_JOIN once every branch has arrived, XOR_JOIN once the branch taken has, REP_JOIN once every sub-lot has), and a
-- step that finishes always runs that advance (it needs the batch in progress; engine.ts step dispatches, then
-- advances). A stage's END waits for its sign-off and a loop's for the decision that ends it: 0312 binds those to their
-- acts (items 4 and 5). So this migration:
--
--   1. recipe.flow_body(tree, id, slot): the node the body or branch `slot` of construct `id` begins with;
--   2. recipe.flow_node_left(tree, state, id, frames): whether the token has left node `id` in `frames`: a phase or
--      hold point finished at least once (COMPLETED or SKIPPED, or marked with its first completion when a correction
--      sent it back; recipe.step_once_finished), a sequence whose last child it left, a library call whose body it
--      left, a construct whose END the state records;
--   3. recipe.flow_content_left(tree, state, id, frames): whether the token has finished what construct `id` holds in
--      `frames`: an operation its body, a parallel section every branch, an alternative the branch its recorded
--      decision names (an empty branch at once), a replicate section the body of every sub-lot 1 to its recorded count;
--   4. recipe.own_node_event_problem (CREATE OR REPLACE; the body of 0314 carried, item 8 added): every operation,
--      parallel, alternative and replicate section whose START the state records and whose content the token has
--      finished has its END in the state, in the frames of its START. The trigger of 0312 (zg_execution_own_node_events,
--      EBMR-EXE-133) checks every row's state, so the row that finishes such a construct without its END is refused,
--      and 0308 then measures the minimum ending in it (an automatic END before its minimum needs its TIME_MIN_BREACH).
--
-- The check reads the whole state the row stores, not only what the row adds; every state the engine leaves holds it.
-- Taken as recorded, as in 0307: the decisions (which branch, how many sub-lots).
--
-- New functions are owned by ebmr_owner and private to the owner (no EXECUTE for PUBLIC); every function pins its
-- search_path with pg_temp last. CREATE OR REPLACE keeps the owner, the privileges (none for PUBLIC) and the search_path
-- of own_node_event_problem. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- The node the body (slot '0') or branch p_slot of construct p_id begins with, in tree p_tree (recipe.flow_tree: the
-- last element of a node's path names its parent and the slot it fills); NULL when there is none (an empty branch).
create function recipe.flow_body(p_tree jsonb, p_id text, p_slot text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select m.key
    from jsonb_each(case when jsonb_typeof(p_tree -> 'ids') = 'object' then p_tree -> 'ids' else '{}'::jsonb end) m
   where m.value -> 'path' -> -1 ->> 0 = p_id and m.value -> 'path' -> -1 ->> 2 = p_slot
   order by (m.value ->> 'n')::integer
   limit 1
$$;

-- INV-20, DI-27: whether the token has left node p_id of tree p_tree in frames p_frames (those of its enclosing loops
-- and replicate sections), as state p_state records it (header item 2).
create function recipe.flow_node_left(p_tree jsonb, p_state jsonb, p_id text, p_frames jsonb) returns boolean
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_kind text := p_tree -> 'ids' -> p_id ->> 'kind';
  v_kids jsonb := p_tree -> 'ids' -> p_id -> 'children';
  v_body text;
begin
  if v_kind in ('phase', 'holdPoint') then
    return recipe.step_once_finished(p_state -> 'steps' -> (p_id || '@' || recipe.ctx_key(p_frames)), false, null);
  elsif v_kind = 'sequence' then
    return jsonb_typeof(v_kids) = 'array' and jsonb_array_length(v_kids) > 0
           and recipe.flow_node_left(p_tree, p_state, v_kids ->> (jsonb_array_length(v_kids) - 1), p_frames);
  elsif v_kind = 'libraryCall' then
    v_body := recipe.flow_body(p_tree, p_id, '0');
    return v_body is not null and recipe.flow_node_left(p_tree, p_state, v_body, p_frames);
  elsif v_kind in ('stage', 'operation', 'loop', 'parallel', 'alternative', 'replicate') then
    return coalesce(jsonb_typeof(p_state -> 'nodeEvents') = 'object' and (p_state -> 'nodeEvents') ? recipe.node_event_key(p_id, 'END', p_frames), false);
  end if;
  return false;
end
$$;

-- INV-20, DI-27: whether the token has finished what construct p_id (an operation, parallel, alternative or replicate
-- section) holds in frames p_frames, as state p_state records it (header item 3). False for any other node.
create function recipe.flow_content_left(p_tree jsonb, p_state jsonb, p_id text, p_frames jsonb) returns boolean
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_kind   text := p_tree -> 'ids' -> p_id ->> 'kind';
  v_body   text;
  v_branch text;
  v_count  text;
  v_n      integer;
begin
  if v_kind = 'operation' then
    v_body := recipe.flow_body(p_tree, p_id, '0');
    return v_body is not null and recipe.flow_node_left(p_tree, p_state, v_body, p_frames);
  elsif v_kind = 'parallel' then
    return exists (select 1 from jsonb_each(p_tree -> 'ids') m where m.value -> 'path' -> -1 ->> 0 = p_id)
           and not exists (select 1 from jsonb_each(p_tree -> 'ids') m
                            where m.value -> 'path' -> -1 ->> 0 = p_id and not recipe.flow_node_left(p_tree, p_state, m.key, p_frames));
  elsif v_kind = 'alternative' then
    v_branch := p_state -> 'decisions' -> (p_id || '@' || recipe.ctx_key(p_frames)) ->> 'outcome';
    if v_branch is null then
      return false;
    end if;
    v_body := recipe.flow_body(p_tree, p_id, v_branch);
    return v_body is null or recipe.flow_node_left(p_tree, p_state, v_body, p_frames);
  elsif v_kind = 'replicate' then
    v_count := p_state -> 'decisions' -> (p_id || '@' || recipe.ctx_key(p_frames)) ->> 'outcome';
    v_body := recipe.flow_body(p_tree, p_id, '0');
    if v_count is null or v_count !~ '^[1-9][0-9]{0,5}$' or v_body is null then
      return false;
    end if;
    v_n := v_count::integer;
    return not exists (select 1 from generate_series(1, v_n) g (k)
                        where not recipe.flow_node_left(p_tree, p_state, v_body,
                                                        coalesce(p_frames, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('construct', p_id, 'index', g.k))));
  end if;
  return false;
end
$$;

create or replace function recipe.own_node_event_problem(p_tree jsonb, p_old jsonb, p_new jsonb, p_kind text, p_accepted boolean, p_command jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ev    jsonb := case when jsonb_typeof(p_new -> 'nodeEvents') = 'object' then p_new -> 'nodeEvents' else '{}'::jsonb end;
  v_type  text := case when p_kind = 'COMMAND' and p_accepted is true then p_command ->> 'type' end;
  v_ctx   jsonb := case when jsonb_typeof(p_command -> 'context') = 'array' then p_command -> 'context' else '[]'::jsonb end;
  v_key   text;
  v_dkey  text;
  v_want  text;
  v_what  text;
  v_kid   text;
  k       text;
  y       jsonb;
  c       record;
begin
  -- Items 1 to 3: the act on a phase or hold point.
  if v_type in ('START_STEP', 'SIGN_PERFORMED', 'DISPOSITION_HOLD_POINT') and jsonb_typeof(p_command -> 'step') = 'string' then
    v_key := (p_command ->> 'step') || '@' || recipe.ctx_key(v_ctx);
    if v_type = 'START_STEP' then
      v_want := recipe.node_event_key(p_command ->> 'step', 'START', v_ctx);
      v_what := format('starts phase %s', v_key);
    elsif v_type = 'SIGN_PERFORMED' and p_old -> 'steps' -> v_key ->> 'status' = 'IN_PROGRESS'
          and p_new -> 'steps' -> v_key ->> 'status' is distinct from 'IN_PROGRESS' then
      v_want := recipe.node_event_key(p_command ->> 'step', 'END', v_ctx);
      v_what := format('ends phase %s', v_key);
    elsif v_type = 'DISPOSITION_HOLD_POINT' and p_new -> 'steps' -> v_key ->> 'status' = 'COMPLETED'
          and p_old -> 'steps' -> v_key ->> 'status' is distinct from 'COMPLETED' then
      v_want := recipe.node_event_key(p_command ->> 'step', 'END', v_ctx);
      v_what := format('releases hold point %s', v_key);
    end if;
    if v_want is not null and not (v_ev ? v_want) then
      return format('%s but records no %s event of it (%s)', v_what, split_part(v_want, '|', 2), v_want);
    end if;
  end if;
  -- Item 4: the stage signed off.
  if v_type = 'SIGN_OFF_STAGE' and jsonb_typeof(p_command -> 'stage') = 'string' then
    v_want := recipe.node_event_key(p_command ->> 'stage', 'END', v_ctx);
    if not (v_ev ? v_want) then
      return format('signs off stage %s@%s but records no END event of it (%s)', p_command ->> 'stage', recipe.ctx_key(v_ctx), v_want);
    end if;
  end if;
  -- Item 5: the loop ended.
  if v_type = 'COMPLETE_LOOP_ITERATION' and jsonb_typeof(p_command -> 'construct') = 'string' and jsonb_array_length(v_ctx) > 0 then
    v_dkey := (p_command ->> 'construct') || '@' || recipe.ctx_key(v_ctx);
    if not coalesce((p_old -> 'decisions') ? v_dkey, false) and p_new -> 'decisions' -> v_dkey ->> 'outcome' in ('EXIT', 'EXHAUSTED') then
      v_want := recipe.node_event_key(p_command ->> 'construct', 'END', recipe.frames_head(v_ctx, jsonb_array_length(v_ctx) - 1));
      if not (v_ev ? v_want) then
        return format('ends loop %s (%s) but records no END event of it (%s)', p_command ->> 'construct', p_new -> 'decisions' -> v_dkey ->> 'outcome', v_want);
      end if;
    end if;
  end if;
  -- Item 6: the token's arrival at a step instance.
  for k, y in select e.key, e.value
                from jsonb_each(case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end) e
               where not coalesce((p_old -> 'steps') ? e.key, false) and e.value ->> 'status' = 'ENABLED'
               order by e.key
  loop
    if jsonb_typeof(p_tree -> 'ids' -> (y ->> 'step')) is distinct from 'object' then
      continue; -- not a step of the flow: 0307 refuses it (EBMR-EXE-129)
    end if;
    if y ->> 'kind' = 'HOLD' then
      v_want := recipe.node_event_key(y ->> 'step', 'START', y -> 'frames');
      if not (v_ev ? v_want) then
        return format('brings in hold point %s, which the token reaches, but records no START event of it (%s)', k, v_want);
      end if;
    end if;
    for c in select p.v ->> 0 as id, p.v ->> 1 as kind
               from jsonb_array_elements(p_tree -> 'ids' -> (y ->> 'step') -> 'path') with ordinality p (v, i)
              where p.v ->> 1 in ('stage', 'operation', 'loop', 'parallel', 'alternative', 'replicate')
              order by p.i
    loop
      v_want := recipe.node_event_key(c.id, 'START', recipe.frames_head(y -> 'frames', coalesce(jsonb_array_length(recipe.flow_within(p_tree, c.id)), 0)));
      if not (v_ev ? v_want) then
        return format('brings in step %s, which lies in %s %s, but records no START event of that %s (%s)', k, c.kind, c.id, c.kind, v_want);
      end if;
    end loop;
    -- Item 7 (0314): the token has left every node before the instance in a sequence it lies in; a construct it left
    -- has its END, and so has every construct inside it the token went through (not inside a loop or replicate section
    -- of it, whose iterations and sub-lots the instance's frames do not name, nor inside an alternative of it, whose
    -- branch may not have been taken).
    for v_kid in select ch.v #>> '{}'
                   from jsonb_array_elements(p_tree -> 'ids' -> (y ->> 'step') -> 'path') with ordinality p (v, i)
                  cross join lateral jsonb_array_elements(p_tree -> 'ids' -> (p.v ->> 0) -> 'children') with ordinality ch (v, j)
                  where p.v ->> 1 = 'sequence' and ch.j <= (p.v ->> 2)::integer
                  order by p.i, ch.j
    loop
      for c in select m.key as id, m.value ->> 'kind' as kind
                 from jsonb_each(p_tree -> 'ids') m
                where (m.key = v_kid or exists (select 1 from jsonb_array_elements(m.value -> 'path') q where q ->> 0 = v_kid))
                  and m.value ->> 'kind' in ('stage', 'operation', 'loop', 'parallel', 'alternative', 'replicate')
                  and not (case when m.key = v_kid then '{}'::text[]
                                else (select coalesce(array_agg(q.v ->> 1), '{}'::text[])
                                        from jsonb_array_elements(m.value -> 'path') with ordinality q (v, i)
                                       where q.i >= (select min(z.i) from jsonb_array_elements(m.value -> 'path') with ordinality z (v, i) where z.v ->> 0 = v_kid)) end
                           && array['loop', 'replicate', 'alternative'])
                order by (m.value ->> 'n')::integer
      loop
        v_want := recipe.node_event_key(c.id, 'END', recipe.frames_head(y -> 'frames', coalesce(jsonb_array_length(recipe.flow_within(p_tree, c.id)), 0)));
        if not (v_ev ? v_want) then
          return format('brings in step %s, which comes after %s %s, but records no END event of that %s (%s)', k, c.kind, c.id, c.kind, v_want);
        end if;
      end loop;
    end loop;
  end loop;
  -- Item 8 (0316): every operation, parallel, alternative and replicate section the token entered and whose content it
  -- has finished has its END, in the frames of its START: the token leaves it in the same advance (engine advance.ts
  -- afterFire: SCOPE_END, AND_JOIN, XOR_JOIN, REP_JOIN), whatever comes after it, whether it lies inside an
  -- alternative, a loop iteration or a sub-lot, and also when it is the last construct of the batch.
  for k, y in select e.key, e.value
                from jsonb_each(v_ev) e
               where e.value ->> 'event' = 'START' and jsonb_typeof(e.value -> 'node') = 'string'
                 and p_tree -> 'ids' -> (e.value ->> 'node') ->> 'kind' in ('operation', 'parallel', 'alternative', 'replicate')
               order by e.key
  loop
    v_want := recipe.node_event_key(y ->> 'node', 'END', y -> 'frames');
    if not (v_ev ? v_want) and recipe.flow_content_left(p_tree, p_new, y ->> 'node', y -> 'frames') then
      return format('finishes what %s %s holds, so the token leaves it, but records no END event of it (%s)',
                    p_tree -> 'ids' -> (y ->> 'node') ->> 'kind', y ->> 'node', v_want);
    end if;
  end loop;
  return null;
end
$$;

revoke all on function recipe.flow_body(jsonb, text, text), recipe.flow_node_left(jsonb, jsonb, text, jsonb),
                       recipe.flow_content_left(jsonb, jsonb, text, jsonb) from public;

reset role;
