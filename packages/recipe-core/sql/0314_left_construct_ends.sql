-- Recipe core, execution store (module C3): the token's arrival at a step also records the ends of the constructs it
-- has left on its way (Phase 2 exit review F67, round 2, completing 0312; INV-20, PR-30, DI-27, DI-34; ADR 0012).
--
-- 0312 binds the starts and ends a person's act makes (a phase's START and END, a hold point's release, a stage's
-- sign-off, a loop's end) and the starts the token's arrival records. The ends the token's advance records by itself
-- were left out: an operation, a parallel or alternative section and a replicate section end when the token leaves
-- them (engine advance.ts afterFire: SCOPE_END, AND_JOIN, XOR_JOIN, REP_JOIN), and a minimum duration measured from such
-- an END (a time constraint from the end of an operation to the start of a later step) found no start when the row
-- left the END out, so the minimum was never measured, as in the round-2 verification's V1 for a phase.
--
-- recipe.own_node_event_problem (CREATE OR REPLACE; the body of 0312 carried, with item 7 added): for every step
-- instance a row brings in ENABLED, every node before it in a sequence it lies in, at every level, has been left by
-- the token; each stage, operation, loop, parallel, alternative or replicate section among them has its END in the
-- state, in the frames of the sections around it, and so has each such construct inside it that the token went
-- through: not one inside a loop or replicate section of it (the instance's frames name none of their iterations or
-- sub-lots) or inside an alternative of it (its branch may not have been taken). A phase or hold point among them
-- has its END bound to its own act (0312 items 2 and 3), or none (skipped, not applicable). The trigger of 0312
-- (zg_execution_own_node_events, EBMR-EXE-133) calls the function, so nothing else changes.
--
-- CREATE OR REPLACE keeps the owner (ebmr_owner), the privileges (none for PUBLIC) and the search_path. Applied as a
-- new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- INV-20, DI-27, DI-34 (F67, round 2): as 0312, and item 7 (the header).
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
  return null;
end
$$;

reset role;
