-- Tablets server, Phase 4 slice 3b: the Tablets items of the release gate G-REL (outline 5.2.7 groups 4, 9 and 10;
-- recipe-core 0780 hook; controls IN-37, IN-17 clause 2, PR-37, PR-39, PR-42, L-30, TB-11, IN-34, PR-47, INV-33;
-- defaults D-3b-2 to D-3b-7 in docs/build-plan/phase-4/phase-4-plan.md).
--
-- tab.grel_edition_items (CREATE OR REPLACE from its stub, tablets 1160) answers for a finished lot of the Tablets edition:
-- its packaging order P (site.finished_lot.batch_id) and the processing batch B it packs (recipe.packaging_parent_of(P)).
-- Every item is a database rule read from the stored records; nobody sets one by hand.
--
--   group 10
--     E.PRINTED_TABLETS_QC   IN-37: every printing step (TB-19) of B is followed by its QC hold point COMPLETED with a
--                            positive disposition under a valid hold-point signature, in the same frames. NA when B's
--                            master prints nothing.
--     E.HELD_CONTAINERS      L-30, TB-11: every output container of B or P that was ever held is dispositioned: REJECTED,
--                            RELEASED_BY_QA, or charged into its whole-batch reprocessing (the only place held material
--                            goes, recipe-core 0624). HELD or SORTED is red.
--     E.CONTAINER_RELEASE    L-30: every container issued to P (recipe.packaging_bulk_issue) is now released: CLOSED and
--                            bracketed (plant.bracketing_problem) or RELEASED_BY_QA; a container held after it was packed
--                            (a later failing check) is red. No bulk issued is red.
--     E.RULE_SETS_VERIFIED   IN-34, tablets spec E.1: every compendial rule set version an entry of B or P cites
--                            (data.ruleSets) has QA's signed verification against the official text
--                            (tab.rule_set_verification_problem, tablets 1161). NA when no entry cites one.
--     E.WHOLE_BATCH_PARENTS  PR-47, INV-33: for each whole-batch reprocessing parent X of B or P (recipe.batch_parent_link),
--                            X is REJECTED (default D-3b-5): each of its end containers (not charged within X, not merged)
--                            is REJECTED or charged into a reprocessing child of X, and every finished lot packed from X is
--                            REJECTED. NA when there is none.
--   group 9
--     E.FINISHED_PACK_EXAMINATION  Schedule M 11.3.7, PR-37: P runs at least one secondary packaging step (TB-24); each
--                            that ran is COMPLETED with an end-of-run examination; a failing one counts only when every
--                            LINE_CHECK_FAILED exception of the step is resolved (below).
--   group 4 (IN-17, PR-39; a reconciliation outside its limits blocks release until resolved, never by a justification
--   of the PR-53 path; default D-3b-2)
--     E.RECONCILIATION_PRINTED  every G-21 step of P COMPLETED (it closes only reconciled) and no PRINTED_RECONCILIATION
--                            exception of P or B unresolved. NA when P has no G-21 step and no such exception.
--     E.RECONCILIATION_PACKS every COMPLETED TB-24 step of P holds its RECONCILIATION entry and no PACK_RECONCILIATION
--                            exception of P is unresolved.
--     E.RECONCILIATION_SERIAL PR-42: tab.serialisation_release_problem(P) is NULL and no SERIAL_RECONCILIATION_OPEN
--                            exception of P is unresolved.
--     E.RECONCILIATION_YIELD no YIELD_OUT_OF_LIMITS or COMPACTION_YIELD_OUT_OF_RANGE exception of B or P is unresolved.
--     E.POSTED_QUANTITY      the quantity posted with the finished lot (tab.post_finished_lot) equals the packs P put into
--                            shippers (the TB-24 SHIPPER entries), the count the warehouse receives (slice 2 backlog low;
--                            default D-3b-6). No shipper is red.
--   A reconciliation-type exception is resolved when it is DISPOSITIONED and the deviation linked to it (DEVIATION_LINKED
--   or ESCALATED) is CLOSED (site.deviation_state): the closure is QA's signed conclusion (outline 5.2.7 group 4).
--
-- since_review is false on every item for now (open item: the "since review" comparison is 3a's evidence epoch).
-- Not here (core groups, recipe-core 3a): open exceptions in general, deviations, reprocessing extra testing (PR-47 wired in
-- core group 3). Every function is owned by ebmr_owner, SECURITY DEFINER where it reads private tables, and pins its
-- search_path with pg_temp last (ADR 0016). CREATE OR REPLACE keeps the owner and grants. Applied as a new migration
-- because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- The step instances {key, step, status, frames, ...} of batch p_batch whose node runs block p_type.
create function tab.grel_steps(p_batch uuid, p_type text) returns table (step_key text, step jsonb)
language sql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
  select x.key, x.value
    from recipe.execution_state st,
         lateral (select recipe.batch_mbr_content(st.batch_id) as c) m,
         jsonb_each(case when jsonb_typeof(st.state -> 'steps') = 'object' then st.state -> 'steps' else '{}'::jsonb end) x
   where st.batch_id = p_batch and recipe.step_node(m.c, x.value ->> 'step') -> 'block' ->> 'type' = p_type
   order by x.key
$$;

-- The entries of step instance p_key of batch p_batch of kind p_kind (all kinds when NULL), in recorded order.
create function tab.grel_entries(p_batch uuid, p_key text, p_kind text) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
  select coalesce(jsonb_agg(e.value order by (e.value ->> 'recordedSeq')::numeric, e.key), '[]'::jsonb)
    from recipe.execution_state st,
         jsonb_each(case when jsonb_typeof(st.state -> 'entries') = 'object' then st.state -> 'entries' else '{}'::jsonb end) e
   where st.batch_id = p_batch and (p_key is null or e.value ->> 'stepKey' = p_key) and (p_kind is null or e.value ->> 'kind' = p_kind)
$$;

-- The exceptions of batches p_batches of types p_types (at step p_step when given) that are not resolved (header):
-- [{batch, exception, type, problem, evidence}].
create function tab.grel_unresolved(p_batches uuid[], p_types text[], p_step text default null) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, recipe, site, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'batch', r.batch_id, 'exception', r.exception_id, 'type', r.exception_type,
           'problem', case when d.id is null then format('exception %s (%s) of batch %s is not dispositioned', r.exception_id, r.exception_type, b.batch_number)
                           when v.id is null then format('exception %s (%s) of batch %s names no deviation', r.exception_id, r.exception_type, b.batch_number)
                           else format('the deviation %s of exception %s (%s) of batch %s is %s, not CLOSED', l.ref, r.exception_id, r.exception_type, b.batch_number,
                                       coalesce(site.deviation_state(v.id), 'unknown')) end,
           'evidence', jsonb_build_array(jsonb_build_object('kind', 'EXCEPTION', 'ref', r.batch_id::text || '/' || r.exception_id, 'label', format('%s %s', b.batch_number, r.title)))
                       || case when v.id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('kind', 'DEVIATION', 'ref', v.id::text, 'label', v.ref)) end)
           order by b.batch_number, r.raised_at_us, r.exception_id), '[]'::jsonb)
    from recipe.exception_register r
    join recipe.batch_execution b on b.id = r.batch_id
    left join recipe.exception_register_act d on d.batch_id = r.batch_id and d.exception_id = r.exception_id and d.act = 'DISPOSITIONED'
    left join lateral (select a.deviation_ref as ref from recipe.exception_register_act a
                        where a.batch_id = r.batch_id and a.exception_id = r.exception_id and a.act in ('DEVIATION_LINKED', 'ESCALATED')
                        order by a.id desc limit 1) l on true
    left join site.deviation v on v.ref = l.ref
   where r.batch_id = any (p_batches) and r.exception_type = any (p_types) and (p_step is null or r.raising_step_key = p_step)
     and (d.id is null or v.id is null or site.deviation_state(v.id) is distinct from 'CLOSED')
$$;

-- One item from a list of problems [{problem, evidence}] (RED with the first problem, and the evidence of all), or GREEN
-- with p_green evidence; NA when p_na.
create function tab.grel_item_of(p_id text, p_group text, p_title text, p_problems jsonb, p_green jsonb, p_na boolean default false) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
  select case
    when p_na then recipe.grel_item(p_id, p_group, p_title, null, coalesce(p_green, '[]'::jsonb), false, 'NA')
    when jsonb_array_length(coalesce(p_problems, '[]'::jsonb)) = 0 then recipe.grel_item(p_id, p_group, p_title, null, coalesce(p_green, '[]'::jsonb))
    else recipe.grel_item(p_id, p_group, p_title,
                          (p_problems -> 0 ->> 'problem') || case when jsonb_array_length(p_problems) > 1 then format(' (and %s more)', jsonb_array_length(p_problems) - 1) else '' end,
                          coalesce((select jsonb_agg(ev order by i, j) from jsonb_array_elements(p_problems) with ordinality p (x, i),
                                           jsonb_array_elements(case when jsonb_typeof(p.x -> 'evidence') = 'array' then p.x -> 'evidence' else '[]'::jsonb end) with ordinality q (ev, j)), '[]'::jsonb))
  end
$$;

create function tab.grel_problem(p_problem text, p_evidence jsonb default '[]'::jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('problem', p_problem, 'evidence', coalesce(p_evidence, '[]'::jsonb))
$$;

create function tab.grel_batch_ev(p_batch uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce((select jsonb_build_array(jsonb_build_object('kind', 'BATCH', 'ref', b.id::text, 'label', b.batch_number)) from recipe.batch_execution b where b.id = p_batch), '[]'::jsonb)
$$;

create function tab.grel_container_ev(c plant.output_container) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_array(jsonb_build_object('kind', 'CONTAINER', 'ref', c.id::text, 'label', c.label_code))
$$;

-- E.PRINTED_TABLETS_QC (header).
create function tab.grel_printed_tablets(p_parent uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_title   text := 'Printed tablets approved by QC (IN-37)';
  v_content jsonb := recipe.batch_mbr_content(p_parent);
  v_state   jsonb;
  v_probs   jsonb := '[]'::jsonb;
  v_ran     integer := 0;
  k         text;
  s         jsonb;
  v_next    jsonb;
begin
  if p_parent is null or v_content is null then
    return tab.grel_item_of('E.PRINTED_TABLETS_QC', '10', v_title, jsonb_build_array(tab.grel_problem('the packaging order packs no processing batch of this installation')), null);
  end if;
  if not exists (select 1 from jsonb_path_query(coalesce(v_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p where p -> 'block' ->> 'type' = 'TB-19') then
    return tab.grel_item_of('E.PRINTED_TABLETS_QC', '10', v_title, null, tab.grel_batch_ev(p_parent), true);
  end if;
  select st.state into v_state from recipe.execution_state st where st.batch_id = p_parent;
  for k, s in select g.step_key, g.step from tab.grel_steps(p_parent, 'TB-19') g loop
    continue when s ->> 'status' = 'NOT_APPLICABLE';
    v_ran := v_ran + 1;
    v_next := tab.coat_next_node(v_content, s ->> 'step');
    if not exists (select 1 from jsonb_each(v_state -> 'steps') h
                    where h.value ->> 'step' = v_next ->> 'id' and h.value ->> 'status' = 'COMPLETED'
                      and (h.value -> 'disposition' -> 'positive') = 'true'::jsonb and (h.value -> 'frames') is not distinct from (s -> 'frames')
                      and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(h.value -> 'signatures') = 'array' then h.value -> 'signatures' else '[]'::jsonb end) g
                                   where g ->> 'role' = 'HOLD_POINT' and g ->> 'valid' = 'true')) then
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(
        format('the tablets printed at %s wait for the QC approval at hold point %s (IN-37)', k, coalesce(v_next ->> 'id', '(none)')), tab.grel_batch_ev(p_parent)));
    end if;
  end loop;
  if v_ran = 0 then
    v_probs := jsonb_build_array(tab.grel_problem('the processing batch''s master prints the tablets, but its record holds no printing step', tab.grel_batch_ev(p_parent)));
  end if;
  return tab.grel_item_of('E.PRINTED_TABLETS_QC', '10', v_title, v_probs, tab.grel_batch_ev(p_parent));
end
$$;

-- E.HELD_CONTAINERS (header).
create function tab.grel_held_containers(p_batches uuid[]) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, plant, recipe, pg_temp as $$
  select tab.grel_item_of('E.HELD_CONTAINERS', '10', 'Held containers dispositioned (L-30, TB-11)',
    coalesce((select jsonb_agg(tab.grel_problem(format('container %s was held and is %s: QA has not dispositioned it', c.label_code, coalesce(plant.container_state(c.id), 'of no state')),
                                                tab.grel_container_ev(c)) order by c.label_code)
                from plant.output_container c
               where c.batch_id = any (p_batches)
                 and exists (select 1 from plant.container_hold h where h.container_id = c.id)
                 and coalesce(plant.container_state(c.id), '') not in ('REJECTED', 'RELEASED_BY_QA')
                 and not exists (select 1 from plant.container_charge g join recipe.batch_parent_link l on l.child_batch_id = g.batch_id and l.parent_batch_id = c.batch_id
                                  where g.container_id = c.id)), '[]'::jsonb),
    coalesce((select jsonb_agg(e order by e ->> 'label') from (select (tab.grel_container_ev(c)) -> 0 as e from plant.output_container c
               where c.batch_id = any (p_batches) and exists (select 1 from plant.container_hold h where h.container_id = c.id)) z), '[]'::jsonb))
$$;

-- E.CONTAINER_RELEASE (header).
create function tab.grel_container_release(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, plant, recipe, pg_temp as $$
declare
  v_title text := 'Containers packed are released (L-30)';
  v_probs jsonb := '[]'::jsonb;
  v_ev    jsonb := '[]'::jsonb;
  c       plant.output_container;
  v_state text;
  v_br    text;
begin
  for c in select o.* from recipe.packaging_bulk_issue i join plant.output_container o on o.id = i.container_id where i.order_batch_id = p_order order by o.label_code loop
    v_ev := v_ev || tab.grel_container_ev(c);
    v_state := plant.container_state(c.id);
    if v_state is null or v_state not in ('CLOSED', 'RELEASED_BY_QA') then
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('container %s packed into this order is %s', c.label_code, coalesce(v_state, 'of no state')), tab.grel_container_ev(c)));
    elsif v_state = 'CLOSED' then
      v_br := plant.bracketing_problem(c, plant.container_closed_at(c.id));
      if v_br is not null then
        v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('container %s packed into this order is not vouched for: %s', c.label_code, v_br), tab.grel_container_ev(c)));
      end if;
    end if;
  end loop;
  if jsonb_array_length(v_ev) = 0 then
    v_probs := jsonb_build_array(tab.grel_problem('no bulk container was issued to the packaging order', tab.grel_batch_ev(p_order)));
  end if;
  return tab.grel_item_of('E.CONTAINER_RELEASE', '10', v_title, v_probs, v_ev);
end
$$;

-- E.RULE_SETS_VERIFIED (header).
create function tab.grel_rule_sets(p_batches uuid[]) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
  with cited as (
    select distinct r ->> 'code' as code, (r ->> 'version')::integer as version
      from recipe.execution_state st,
           jsonb_each(case when jsonb_typeof(st.state -> 'entries') = 'object' then st.state -> 'entries' else '{}'::jsonb end) e,
           jsonb_array_elements(case when jsonb_typeof(e.value -> 'data' -> 'ruleSets') = 'array' then e.value -> 'data' -> 'ruleSets' else '[]'::jsonb end) r
     where st.batch_id = any (p_batches) and (r ->> 'version') ~ '^[1-9][0-9]{0,8}$'
  )
  select tab.grel_item_of('E.RULE_SETS_VERIFIED', '10', 'Compendial rule sets verified by QA (tablets spec E.1)',
    coalesce((select jsonb_agg(tab.grel_problem(tab.rule_set_verification_problem(c.code, c.version),
                                                jsonb_build_array(jsonb_build_object('kind', 'RULE_SET', 'ref', c.code || ':' || c.version, 'label', format('%s version %s', c.code, c.version))))
                               order by c.code, c.version)
                from cited c where tab.rule_set_verification_problem(c.code, c.version) is not null), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('kind', 'RULE_SET', 'ref', c.code || ':' || c.version, 'label', format('%s version %s', c.code, c.version)) order by c.code, c.version) from cited c), '[]'::jsonb),
    not exists (select 1 from cited))
$$;

-- E.WHOLE_BATCH_PARENTS (header; default D-3b-5).
create function tab.grel_whole_batch_parents(p_batches uuid[]) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, plant, recipe, site, pg_temp as $$
declare
  v_title text := 'Whole-batch reprocessing parents rejected (PR-47, INV-33)';
  v_probs jsonb := '[]'::jsonb;
  v_ev    jsonb := '[]'::jsonb;
  x       record;
  c       plant.output_container;
  f       record;
  v_lot   text;
begin
  for x in select distinct l.parent_batch_id as id, l.parent_batch_number as number from recipe.batch_parent_link l where l.child_batch_id = any (p_batches) order by 2 loop
    v_ev := v_ev || tab.grel_batch_ev(x.id);
    for c in select o.* from plant.output_container o
              where o.batch_id = x.id
                and not exists (select 1 from plant.container_charge g where g.container_id = o.id and g.batch_id = x.id)
                and not exists (select 1 from plant.container_merge m where m.source_id = o.id)
                and coalesce(plant.container_state(o.id), '') <> 'REJECTED'
                and not exists (select 1 from plant.container_charge g join recipe.batch_parent_link l on l.child_batch_id = g.batch_id and l.parent_batch_id = x.id
                                 where g.container_id = o.id)
              order by o.label_code loop
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(
        format('parent %s of the whole-batch reprocessing is not rejected: its container %s is %s', x.number, c.label_code, coalesce(plant.container_state(c.id), 'of no state')),
        tab.grel_container_ev(c)));
    end loop;
    for f in select fl.lot_id, fl.batch_number from site.finished_lot fl where recipe.packaging_parent_of(fl.batch_id) = x.id order by fl.batch_number loop
      v_lot := site.lot_state(f.lot_id);
      if v_lot is distinct from 'REJECTED' then
        v_probs := v_probs || jsonb_build_array(tab.grel_problem(
          format('parent %s of the whole-batch reprocessing is not rejected: its finished lot %s is %s', x.number, f.batch_number, coalesce(v_lot, 'of no state')),
          jsonb_build_array(jsonb_build_object('kind', 'LOT', 'ref', f.lot_id::text, 'label', f.batch_number))));
      end if;
    end loop;
  end loop;
  return tab.grel_item_of('E.WHOLE_BATCH_PARENTS', '10', v_title, v_probs, v_ev, jsonb_array_length(v_ev) = 0);
end
$$;

-- E.FINISHED_PACK_EXAMINATION (header).
create function tab.grel_pack_examination(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_title text := 'Finished-pack examination recorded (TB-24)';
  v_probs jsonb := '[]'::jsonb;
  v_ran   integer := 0;
  k       text;
  s       jsonb;
  v_end   jsonb;
  v_unres jsonb;
begin
  for k, s in select g.step_key, g.step from tab.grel_steps(p_order, 'TB-24') g loop
    continue when s ->> 'status' = 'NOT_APPLICABLE';
    v_ran := v_ran + 1;
    if s ->> 'status' is distinct from 'COMPLETED' then
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the secondary packaging step %s is %s, not COMPLETED', k, coalesce(s ->> 'status', 'of no status')), tab.grel_batch_ev(p_order)));
      continue;
    end if;
    select e into v_end from jsonb_array_elements(tab.grel_entries(p_order, k, 'EXAMINATION')) e where e -> 'data' ->> 'timing' = 'END' limit 1;
    if v_end is null then
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('step %s holds no end-of-run examination of the finished packs', k), tab.grel_batch_ev(p_order)));
    elsif v_end -> 'data' ->> 'result' is distinct from 'PASS' then
      v_unres := tab.grel_unresolved(array[p_order], array['LINE_CHECK_FAILED'], k);
      if jsonb_array_length(v_unres) > 0 then
        v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the end-of-run examination at %s failed and is not resolved: %s', k, v_unres -> 0 ->> 'problem'), v_unres -> 0 -> 'evidence'));
      end if;
    end if;
  end loop;
  if v_ran = 0 then
    v_probs := jsonb_build_array(tab.grel_problem('the packaging order ran no secondary packaging step (TB-24): the finished packs were not examined', tab.grel_batch_ev(p_order)));
  end if;
  return tab.grel_item_of('E.FINISHED_PACK_EXAMINATION', '9', v_title, v_probs, tab.grel_batch_ev(p_order));
end
$$;

-- E.RECONCILIATION_PRINTED (header).
create function tab.grel_recon_printed(p_order uuid, p_parent uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_probs jsonb := '[]'::jsonb;
  v_unres jsonb := tab.grel_unresolved(array_remove(array[p_order, p_parent], null), array['PRINTED_RECONCILIATION']);
  v_any   boolean := false;
  k       text;
  s       jsonb;
begin
  for k, s in select g.step_key, g.step from tab.grel_steps(p_order, 'G-21') g loop
    continue when s ->> 'status' = 'NOT_APPLICABLE';
    v_any := true;
    if s ->> 'status' is distinct from 'COMPLETED' then
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the printed-materials step %s is %s: its reconciliation is not closed', k, coalesce(s ->> 'status', 'of no status')), tab.grel_batch_ev(p_order)));
    end if;
  end loop;
  v_probs := v_probs || coalesce((select jsonb_agg(tab.grel_problem('printed materials reconciled outside their limits: ' || (u ->> 'problem'), u -> 'evidence')) from jsonb_array_elements(v_unres) u), '[]'::jsonb);
  return tab.grel_item_of('E.RECONCILIATION_PRINTED', '4', 'Printed materials reconciled (G-21, IN-17)', v_probs, tab.grel_batch_ev(p_order),
                          not v_any and not exists (select 1 from recipe.exception_register r where r.batch_id in (p_order, p_parent) and r.exception_type = 'PRINTED_RECONCILIATION'));
end
$$;

-- E.RECONCILIATION_PACKS (header).
create function tab.grel_recon_packs(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_probs jsonb := '[]'::jsonb;
  v_unres jsonb := tab.grel_unresolved(array[p_order], array['PACK_RECONCILIATION']);
  v_any   boolean := false;
  k       text;
  s       jsonb;
begin
  for k, s in select g.step_key, g.step from tab.grel_steps(p_order, 'TB-24') g where g.step ->> 'status' = 'COMPLETED' loop
    v_any := true;
    if jsonb_array_length(tab.grel_entries(p_order, k, 'RECONCILIATION')) = 0 then
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('step %s holds no reconciliation of the packs', k), tab.grel_batch_ev(p_order)));
    end if;
  end loop;
  if not v_any then
    v_probs := v_probs || jsonb_build_array(tab.grel_problem('no completed secondary packaging step reconciled the packs', tab.grel_batch_ev(p_order)));
  end if;
  v_probs := v_probs || coalesce((select jsonb_agg(tab.grel_problem('packs reconciled outside their limit: ' || (u ->> 'problem'), u -> 'evidence')) from jsonb_array_elements(v_unres) u), '[]'::jsonb);
  return tab.grel_item_of('E.RECONCILIATION_PACKS', '4', 'Packs reconciled (TB-24, IN-17)', v_probs, tab.grel_batch_ev(p_order));
end
$$;

-- E.RECONCILIATION_SERIAL (header).
create function tab.grel_recon_serial(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_probs jsonb := '[]'::jsonb;
  v_prob  text := tab.serialisation_release_problem(p_order);
begin
  if v_prob is not null then
    v_probs := jsonb_build_array(tab.grel_problem(v_prob, tab.grel_batch_ev(p_order)));
  end if;
  v_probs := v_probs || coalesce((select jsonb_agg(tab.grel_problem('a serial pool reconciled open: ' || (u ->> 'problem'), u -> 'evidence'))
                                    from jsonb_array_elements(tab.grel_unresolved(array[p_order], array['SERIAL_RECONCILIATION_OPEN'])) u), '[]'::jsonb);
  return tab.grel_item_of('E.RECONCILIATION_SERIAL', '4', 'Serial pools reconciled (PR-42)', v_probs, tab.grel_batch_ev(p_order));
end
$$;

-- E.RECONCILIATION_YIELD (header).
create function tab.grel_recon_yield(p_order uuid, p_parent uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
  select tab.grel_item_of('E.RECONCILIATION_YIELD', '4', 'Yields within limits or explained (IN-17, PR-39)',
    coalesce((select jsonb_agg(tab.grel_problem('a yield outside its limits: ' || (u ->> 'problem'), u -> 'evidence'))
                from jsonb_array_elements(tab.grel_unresolved(array_remove(array[p_order, p_parent], null), array['YIELD_OUT_OF_LIMITS', 'COMPACTION_YIELD_OUT_OF_RANGE'])) u), '[]'::jsonb),
    tab.grel_batch_ev(p_parent) || tab.grel_batch_ev(p_order))
$$;

-- E.POSTED_QUANTITY (header; default D-3b-6).
create function tab.grel_posted_quantity(p_lot uuid, p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, site, pg_temp as $$
declare
  l        site.material_lot;
  v_packed numeric := 0;
  v_any    boolean := false;
  k        text;
  v_probs  jsonb := '[]'::jsonb;
  v_ev     jsonb;
begin
  select * into l from site.material_lot m where m.id = p_lot;
  v_ev := jsonb_build_array(jsonb_build_object('kind', 'LOT', 'ref', p_lot::text, 'label', l.lot_code)) || tab.grel_batch_ev(p_order);
  for k in select g.step_key from tab.grel_steps(p_order, 'TB-24') g where g.step ->> 'status' <> 'NOT_APPLICABLE' loop
    select v_packed + coalesce(sum(tab.packline_n(e -> 'data' -> 'packs')), 0), v_any or count(*) > 0 into v_packed, v_any
      from jsonb_array_elements(tab.grel_entries(p_order, k, 'SHIPPER')) e;
  end loop;
  if not v_any then
    v_probs := jsonb_build_array(tab.grel_problem('the packaging order filled no shipper: the posted quantity cannot be checked against the packs', v_ev));
  elsif l.received_quantity is distinct from v_packed then
    v_probs := jsonb_build_array(tab.grel_problem(format('the finished lot was posted with %s %s, but the packaging order put %s packs into shippers', trim_scale(l.received_quantity), l.unit, v_packed), v_ev));
  end if;
  return tab.grel_item_of('E.POSTED_QUANTITY', '4', 'Posted quantity equals the packs shipped', v_probs, v_ev);
end
$$;

-- The Tablets items (header). CREATE OR REPLACE from tablets 1160 (the stub).
create or replace function tab.grel_edition_items(p_lot uuid, p_market text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, site, pg_temp as $$
declare
  f        site.finished_lot;
  v_parent uuid;
  v_both   uuid[];
begin
  select * into f from site.finished_lot x where x.lot_id = p_lot;
  if f.lot_id is null or f.edition <> 'TABLETS' then
    return jsonb_build_array(recipe.grel_item('E.EDITION', '10', 'Edition items', 'the lot is no finished lot of a Tablets packaging order'));
  end if;
  v_parent := recipe.packaging_parent_of(f.batch_id);
  v_both := array_remove(array[f.batch_id, v_parent], null);
  return jsonb_build_array(
    tab.grel_recon_printed(f.batch_id, v_parent),
    tab.grel_recon_packs(f.batch_id),
    tab.grel_recon_serial(f.batch_id),
    tab.grel_recon_yield(f.batch_id, v_parent),
    tab.grel_posted_quantity(p_lot, f.batch_id),
    tab.grel_pack_examination(f.batch_id),
    tab.grel_printed_tablets(v_parent),
    tab.grel_held_containers(v_both),
    tab.grel_container_release(f.batch_id),
    tab.grel_rule_sets(v_both),
    tab.grel_whole_batch_parents(v_both));
end
$$;

revoke all on function tab.grel_steps(uuid, text), tab.grel_entries(uuid, text, text), tab.grel_unresolved(uuid[], text[], text),
  tab.grel_item_of(text, text, text, jsonb, jsonb, boolean), tab.grel_problem(text, jsonb), tab.grel_batch_ev(uuid), tab.grel_container_ev(plant.output_container),
  tab.grel_printed_tablets(uuid), tab.grel_held_containers(uuid[]), tab.grel_container_release(uuid), tab.grel_rule_sets(uuid[]),
  tab.grel_whole_batch_parents(uuid[]), tab.grel_pack_examination(uuid), tab.grel_recon_printed(uuid, uuid), tab.grel_recon_packs(uuid),
  tab.grel_recon_serial(uuid), tab.grel_recon_yield(uuid, uuid), tab.grel_posted_quantity(uuid, uuid) from public;

reset role;
