-- Injectables edition, slice I-1c2 (docs/build-plan/injectables/resume.md; lead rulings of 9 November 2026): a packaging
-- record of the edition ends with the finished-pack examination, and the release gate G-REL has the edition's items.
-- The first migration of the injectables namespace; the namespace numbers its migrations 3000-3999 (editions/README.md).
--
-- Handbook: modules/injectables.md
--
-- Data and two functions of the injectables namespace; tablets and substance behave as before.
--
--   recipe.packaging_completion_block  the row ('injectables', 'LIB-INJ-PACK-EXAM'): an injectables packaging master
--       whose procedure holds a step of the library block INJ-PACK-EXAM, the examination of the finished packs at the
--       completion of finishing (21 CFR 211.134(c)), packs to the end (recipe.packaging_master_problem, recipe-core
--       0800), so its packaging orders can be planned and issued. A library step's block type is 'LIB-<code>'
--       (recipe-core 1810, 1873).
--   injectables.grel_edition_items(lot, market)  the edition's G-REL items, registered for INJECTABLES through
--       recipe.register_grel_edition_hook (recipe-core 0780). As the API edition's (substance 5000), it answers with the
--       tablets release items that apply to any packaging order (tablets 1162, 1163) for the lot's packaging order P and
--       the processing batch B it packs: printed materials reconciled (the labels, leaflets and cartons of G-21; 211.125),
--       yields, held containers, the bulk issued to P released, rule sets verified, whole-batch reprocessing parents. A
--       lot of another edition answers one RED item (fails closed), as the tablets and substance hooks do. No
--       posted-quantity item: the tablets one counts TB-24 shippers, and its rule is a default (D-3b-6), not a clause.
--     Group 9 stays RED in the core gate until the edition answers it (recipe-core 0781, G9.PACK_EXAMINATION; PR-37).
--       E.PACK_EXAMINATION  P ran at least one INJ-PACK-EXAM step and each that ran is COMPLETED (211.134(c): a
--                           representative sample examined at completion and the result recorded). A unit with a wrong
--                           or missing label is a critical breach whose exception keeps the step from completing until it
--                           is resolved. No examination ran is RED.
--
-- PL/pgSQL, SECURITY DEFINER, search_path pinned with pg_temp last (ADR 0016). PL/pgSQL because a sandbox database is
-- migrated without the tablets namespace, and only a SQL function's body is checked when it is created.

create schema injectables authorization ebmr_owner;
revoke all on schema injectables from public;

set local role ebmr_owner;

-- E.PACK_EXAMINATION (header).
create function injectables.grel_pack_examination(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, injectables, tab, recipe, pg_temp as $$
declare
  v_probs jsonb := '[]'::jsonb;
  v_any   boolean := false;
  k       text;
  s       jsonb;
begin
  for k, s in select g.step_key, g.step from tab.grel_steps(p_order, 'LIB-INJ-PACK-EXAM') g where g.step ->> 'status' is distinct from 'NOT_APPLICABLE' loop
    v_any := true;
    if s ->> 'status' is distinct from 'COMPLETED' then
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the finished-pack examination %s is %s, not COMPLETED', k, coalesce(s ->> 'status', 'of no status')), tab.grel_batch_ev(p_order)));
    end if;
  end loop;
  if not v_any then
    v_probs := jsonb_build_array(tab.grel_problem('the packaging order ran no finished-pack examination (INJ-PACK-EXAM): no sample of the finished packs was examined', tab.grel_batch_ev(p_order)));
  end if;
  return tab.grel_item_of('E.PACK_EXAMINATION', '9', 'Finished packs examined (INJ-PACK-EXAM)', v_probs, tab.grel_batch_ev(p_order));
end
$$;

create function injectables.grel_edition_items(p_lot uuid, p_market text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, injectables, tab, recipe, site, pg_temp as $$
declare
  f        site.finished_lot;
  v_parent uuid;
  v_both   uuid[];
  v_rev    timestamptz;
  v_items  jsonb;
begin
  select * into f from site.finished_lot x where x.lot_id = p_lot;
  if f.lot_id is null or f.edition <> 'INJECTABLES' then
    return jsonb_build_array(recipe.grel_item('E.EDITION', '10', 'Edition items', 'the lot is no finished lot of an injectables packaging order'));
  end if;
  v_parent := recipe.packaging_parent_of(f.batch_id);
  v_both := array_remove(array[f.batch_id, v_parent], null);
  v_rev := recipe.release_review_time(p_lot);
  v_items := jsonb_build_array(
    tab.grel_recon_printed(f.batch_id, v_parent),
    tab.grel_recon_yield(f.batch_id, v_parent),
    injectables.grel_pack_examination(f.batch_id),
    tab.grel_held_containers(v_both),
    tab.grel_container_release(f.batch_id),
    tab.grel_rule_sets(v_both),
    tab.grel_whole_batch_parents(v_both));
  return (select jsonb_agg(i || jsonb_build_object('since_review', tab.grel_changed_since(v_rev,
            case i ->> 'id' when 'E.PACK_EXAMINATION' then array[f.batch_id] when 'E.CONTAINER_RELEASE' then '{}'::uuid[] when 'E.WHOLE_BATCH_PARENTS' then '{}'::uuid[] else v_both end,
            i -> 'evidence')) order by n)
            from jsonb_array_elements(v_items) with ordinality x (i, n));
end
$$;

revoke all on function injectables.grel_pack_examination(uuid), injectables.grel_edition_items(uuid, text) from public;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (injectables migration 3000_inj_pack_release_items)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the injectables edition: its finished-pack examination completes a packaging record, and its items of the release gate G-REL'));
insert into recipe.packaging_completion_block (edition, block_type) values ('injectables', 'LIB-INJ-PACK-EXAM');
select recipe.register_grel_edition_hook('INJECTABLES', 'injectables.grel_edition_items(uuid, text)');
select kernel.set_actor_context(null);

reset role;
