-- API edition plan A1a (docs/build-plan/api/handover-a0.md items 2 and 7; lead clearance of 5 November 2026): an API
-- packaging record ends with the library pack block, and the release gate G-REL has the API edition's items.
--
-- Handbook: modules/substance.md
--
-- Data and functions of the substance namespace only; tablets and injectables behave as before.
--
--   recipe.packaging_completion_block  the row ('substance', 'LIB-API-PACK'): an API packaging master whose procedure
--       holds a step of the library block API-PACK packs to the end (recipe.packaging_master_problem, recipe-core 0800),
--       so its packaging orders can be planned and issued. A library step's block type is 'LIB-<code>' (recipe-core
--       1810); recipe-core 1873 lets the table name one.
--   substance.grel_edition_items(lot, market)  the API edition's G-REL items for a finished lot of the SUBSTANCE edition,
--       registered through recipe.register_grel_edition_hook (recipe-core 0780). P is the lot's packaging order
--       (site.finished_lot.batch_id), B the processing batch it packs (recipe.packaging_parent_of(P)). It reads the
--       entries of P's API-PACK steps (packages/recipe-core/src/library/seed/substance.ts: sections container, recon and
--       exam) and reuses the generic tablets helpers for the rest (tablets 1162, 1163).
--     group 4 (Schedule M Part XII and ICH Q7 on label reconciliation and yields; a result outside its limits blocks
--     release until resolved):
--       E.RECONCILIATION_LABELS  P ran at least one API-PACK step; each that ran is COMPLETED (it closes only on its
--                                signatures) and holds its label reconciliation (recon); no LIB_LIMIT_BREACH of those
--                                steps is unresolved (tab.grel_unresolved: dispositioned and its deviation CLOSED).
--       E.RECONCILIATION_YIELD   as tablets: no yield exception of B or P unresolved (tab.grel_recon_yield).
--       E.POSTED_QUANTITY        the finished lot was posted in kg and its quantity equals the sum of the net masses of
--                                the containers P filled (the container entries of its API-PACK steps). None is red.
--     group 9:
--       E.PACK_EXAMINATION       each API-PACK step that ran is COMPLETED and its last examination of the packed
--                                containers (exam) confirms them all correct and examined at least as many containers
--                                as the step filled; a fault found is cleared only by a new examination after the
--                                correction. No step ran is red.
--     group 10, as tablets: E.HELD_CONTAINERS, E.CONTAINER_RELEASE (the bulk issued to P is released; none issued is
--       red), E.RULE_SETS_VERIFIED, E.WHOLE_BATCH_PARENTS.
--     since_review on every item as tablets (tab.grel_changed_since, tablets 1163).
--   A lot of another edition answers one RED item (fails closed), as the tablets hook does.
--
-- Owned by ebmr_owner, SECURITY DEFINER, search_path pinned with pg_temp last (ADR 0016).

create schema substance authorization ebmr_owner;
revoke all on schema substance from public;

set local role ebmr_owner;

-- The API-PACK step instances of batch p_batch that ran (status not NOT_APPLICABLE): {step_key, step}. PL/pgSQL, as every
-- function here: a sandbox database is migrated without the tablets namespace, and only a SQL function's body is
-- checked when it is created.
create function substance.pack_steps(p_batch uuid) returns table (step_key text, step jsonb)
language plpgsql stable security definer set search_path = pg_catalog, substance, tab, pg_temp as $$
begin
  return query select g.step_key, g.step from tab.grel_steps(p_batch, 'LIB-API-PACK') g where g.step ->> 'status' is distinct from 'NOT_APPLICABLE';
end
$$;

-- E.RECONCILIATION_LABELS (header).
create function substance.grel_recon_labels(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, substance, tab, recipe, pg_temp as $$
declare
  v_probs jsonb := '[]'::jsonb;
  v_any   boolean := false;
  v_unres jsonb;
  k       text;
  s       jsonb;
begin
  for k, s in select p.step_key, p.step from substance.pack_steps(p_order) p loop
    v_any := true;
    if s ->> 'status' is distinct from 'COMPLETED' then
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the pack step %s is %s, not COMPLETED: its labels are not reconciled', k, coalesce(s ->> 'status', 'of no status')), tab.grel_batch_ev(p_order)));
    elsif jsonb_array_length(tab.grel_entries(p_order, k, 'recon')) = 0 then
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the pack step %s holds no label reconciliation', k), tab.grel_batch_ev(p_order)));
    end if;
    v_unres := tab.grel_unresolved(array[p_order], array['LIB_LIMIT_BREACH'], k);
    v_probs := v_probs || coalesce((select jsonb_agg(tab.grel_problem('a pack result outside its limits: ' || (u ->> 'problem'), u -> 'evidence')) from jsonb_array_elements(v_unres) u), '[]'::jsonb);
  end loop;
  if not v_any then
    v_probs := jsonb_build_array(tab.grel_problem('the packaging order ran no pack step (API-PACK): no label was reconciled', tab.grel_batch_ev(p_order)));
  end if;
  return tab.grel_item_of('E.RECONCILIATION_LABELS', '4', 'Labels reconciled (API-PACK)', v_probs, tab.grel_batch_ev(p_order));
end
$$;

-- E.POSTED_QUANTITY (header).
create function substance.grel_posted_quantity(p_lot uuid, p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, substance, tab, recipe, site, pg_temp as $$
declare
  l        site.material_lot;
  v_packed numeric := 0;
  v_n      integer := 0;
  v_bad    integer := 0;
  v_probs  jsonb := '[]'::jsonb;
  v_ev     jsonb;
begin
  select * into l from site.material_lot m where m.id = p_lot;
  v_ev := jsonb_build_array(jsonb_build_object('kind', 'LOT', 'ref', p_lot::text, 'label', l.lot_code)) || tab.grel_batch_ev(p_order);
  select coalesce(sum(case when e -> 'data' ->> 'netMass' ~ '^[0-9]+(\.[0-9]+)?$' then (e -> 'data' ->> 'netMass')::numeric end), 0), count(*),
         count(*) filter (where coalesce(e -> 'data' ->> 'netMass', '') !~ '^[0-9]+(\.[0-9]+)?$')
    into v_packed, v_n, v_bad
    from substance.pack_steps(p_order) p, jsonb_array_elements(tab.grel_entries(p_order, p.step_key, 'container')) e;
  if v_n = 0 then
    v_probs := jsonb_build_array(tab.grel_problem('the packaging order filled no drum or bag: the posted quantity cannot be checked against the containers', v_ev));
  elsif v_bad > 0 then
    v_probs := jsonb_build_array(tab.grel_problem(format('%s container entries of the packaging order hold no net mass', v_bad), v_ev));
  elsif l.unit is distinct from 'kg' then
    v_probs := jsonb_build_array(tab.grel_problem(format('the finished lot was posted in %s, but the containers were filled by net mass in kg', coalesce(l.unit, 'no unit')), v_ev));
  elsif l.received_quantity is distinct from v_packed then
    v_probs := jsonb_build_array(tab.grel_problem(format('the finished lot was posted with %s kg, but the packaging order filled %s kg net into %s containers', trim_scale(l.received_quantity), trim_scale(v_packed), v_n), v_ev));
  end if;
  return tab.grel_item_of('E.POSTED_QUANTITY', '4', 'Posted quantity equals the net mass packed', v_probs, v_ev);
end
$$;

-- E.PACK_EXAMINATION (header).
create function substance.grel_pack_examination(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, substance, tab, recipe, pg_temp as $$
declare
  v_probs jsonb := '[]'::jsonb;
  v_any   boolean := false;
  v_exam  jsonb;
  v_n     integer;
  k       text;
  s       jsonb;
begin
  for k, s in select p.step_key, p.step from substance.pack_steps(p_order) p loop
    v_any := true;
    if s ->> 'status' is distinct from 'COMPLETED' then
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the pack step %s is %s, not COMPLETED', k, coalesce(s ->> 'status', 'of no status')), tab.grel_batch_ev(p_order)));
      continue;
    end if;
    v_exam := tab.grel_entries(p_order, k, 'exam') -> -1;
    v_n := jsonb_array_length(tab.grel_entries(p_order, k, 'container'));
    if v_exam is null then
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('step %s holds no examination of the packed containers', k), tab.grel_batch_ev(p_order)));
    elsif v_exam -> 'data' -> 'allCorrect' is distinct from 'true'::jsonb then
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the last examination of the packed containers at %s does not confirm them correct: examine them again after the correction', k), tab.grel_batch_ev(p_order)));
    elsif coalesce(v_exam -> 'data' ->> 'examined', '') !~ '^[0-9]+(\.0+)?$' or (v_exam -> 'data' ->> 'examined')::numeric < v_n then
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the examination at %s covers %s of the %s containers filled', k, coalesce(v_exam -> 'data' ->> 'examined', 'none'), v_n), tab.grel_batch_ev(p_order)));
    end if;
  end loop;
  if not v_any then
    v_probs := jsonb_build_array(tab.grel_problem('the packaging order ran no pack step (API-PACK): the packed containers were not examined', tab.grel_batch_ev(p_order)));
  end if;
  return tab.grel_item_of('E.PACK_EXAMINATION', '9', 'Packed containers examined (API-PACK)', v_probs, tab.grel_batch_ev(p_order));
end
$$;

-- The API edition's items (header).
create function substance.grel_edition_items(p_lot uuid, p_market text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, substance, tab, recipe, site, pg_temp as $$
declare
  f        site.finished_lot;
  v_parent uuid;
  v_both   uuid[];
  v_rev    timestamptz;
  v_items  jsonb;
begin
  select * into f from site.finished_lot x where x.lot_id = p_lot;
  if f.lot_id is null or f.edition <> 'SUBSTANCE' then
    return jsonb_build_array(recipe.grel_item('E.EDITION', '10', 'Edition items', 'the lot is no finished lot of an API packaging order'));
  end if;
  v_parent := recipe.packaging_parent_of(f.batch_id);
  v_both := array_remove(array[f.batch_id, v_parent], null);
  v_rev := recipe.release_review_time(p_lot);
  v_items := jsonb_build_array(
    substance.grel_recon_labels(f.batch_id),
    tab.grel_recon_yield(f.batch_id, v_parent),
    substance.grel_posted_quantity(p_lot, f.batch_id),
    substance.grel_pack_examination(f.batch_id),
    tab.grel_held_containers(v_both),
    tab.grel_container_release(f.batch_id),
    tab.grel_rule_sets(v_both),
    tab.grel_whole_batch_parents(v_both));
  return (select jsonb_agg(i || jsonb_build_object('since_review', tab.grel_changed_since(v_rev,
            case i ->> 'id'
              when 'E.RECONCILIATION_LABELS' then array[f.batch_id] when 'E.POSTED_QUANTITY' then array[f.batch_id]
              when 'E.PACK_EXAMINATION' then array[f.batch_id]
              when 'E.CONTAINER_RELEASE' then '{}'::uuid[] when 'E.WHOLE_BATCH_PARENTS' then '{}'::uuid[]
              else v_both end,
            i -> 'evidence')) order by n)
            from jsonb_array_elements(v_items) with ordinality x (i, n));
end
$$;

revoke all on function substance.pack_steps(uuid), substance.grel_recon_labels(uuid), substance.grel_posted_quantity(uuid, uuid),
                       substance.grel_pack_examination(uuid), substance.grel_edition_items(uuid, text) from public;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (substance migration 5000_api_pack_release_items)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the API edition: its pack block completes a packaging record, and its items of the release gate G-REL'));
insert into recipe.packaging_completion_block (edition, block_type) values ('substance', 'LIB-API-PACK');
select recipe.register_grel_edition_hook('SUBSTANCE', 'substance.grel_edition_items(uuid, text)');
select kernel.set_actor_context(null);

reset role;
