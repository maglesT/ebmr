-- API edition plan A1a (docs/build-plan/api/handover-a0.md items 2 and 7; lead clearance of 5 November 2026): an API
-- packaging record ends with the library pack block, and the release gate G-REL has the API edition's items.
--
-- Handbook: modules/substance.md
--
-- Data and two functions of the substance namespace; tablets and injectables behave as before.
--
--   recipe.packaging_completion_block  the row ('substance', 'LIB-API-PACK'): an API packaging master whose procedure
--       holds a step of the library block API-PACK packs to the end (recipe.packaging_master_problem, recipe-core 0800),
--       so its packaging orders can be planned and issued. A library step's block type is 'LIB-<code>' (recipe-core
--       1810); recipe-core 1873 lets the table name one.
--   substance.grel_edition_items(lot, market)  the API edition's G-REL items, registered for SUBSTANCE through
--       recipe.register_grel_edition_hook (recipe-core 0780). It answers with the existing tablets release items that
--       apply to any packaging order (tablets 1162, 1163), for the lot's packaging order P and the processing batch B
--       it packs: printed materials reconciled (the labels, G-21), yields, held containers, the bulk issued to P
--       released, rule sets verified, whole-batch reprocessing parents. A lot of another edition answers one RED item
--       (fails closed), as the tablets hook does. since_review as tablets (tab.grel_changed_since).
--     Group 9 has no tablets item that fits a drum (TB-24 is a carton line), and the core gate stays RED until the
--     edition answers it (recipe-core 0781, G9.PACK_EXAMINATION; SM 11.3.7, PR-37). One item answers it:
--       E.PACK_EXAMINATION  P ran at least one API-PACK step and each that ran is COMPLETED. Each drum or bag entry of
--                           the step checks its closure and its label; a wrong answer raises the exception that keeps
--                           the step from completing until it is resolved. No pack step ran is RED.
--
-- PL/pgSQL, SECURITY DEFINER, search_path pinned with pg_temp last (ADR 0016). PL/pgSQL because a sandbox database is
-- migrated without the tablets namespace, and only a SQL function's body is checked when it is created.

create schema substance authorization ebmr_owner;
revoke all on schema substance from public;

set local role ebmr_owner;

-- E.PACK_EXAMINATION (header).
create function substance.grel_pack_examination(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, substance, tab, recipe, pg_temp as $$
declare
  v_probs jsonb := '[]'::jsonb;
  v_any   boolean := false;
  k       text;
  s       jsonb;
begin
  for k, s in select g.step_key, g.step from tab.grel_steps(p_order, 'LIB-API-PACK') g where g.step ->> 'status' is distinct from 'NOT_APPLICABLE' loop
    v_any := true;
    if s ->> 'status' is distinct from 'COMPLETED' then
      v_probs := v_probs || jsonb_build_array(tab.grel_problem(format('the pack step %s is %s, not COMPLETED', k, coalesce(s ->> 'status', 'of no status')), tab.grel_batch_ev(p_order)));
    end if;
  end loop;
  if not v_any then
    v_probs := jsonb_build_array(tab.grel_problem('the packaging order ran no pack step (API-PACK): no drum or bag was examined', tab.grel_batch_ev(p_order)));
  end if;
  return tab.grel_item_of('E.PACK_EXAMINATION', '9', 'Drums or bags examined (API-PACK)', v_probs, tab.grel_batch_ev(p_order));
end
$$;

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
    tab.grel_recon_printed(f.batch_id, v_parent),
    tab.grel_recon_yield(f.batch_id, v_parent),
    substance.grel_pack_examination(f.batch_id),
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

revoke all on function substance.grel_pack_examination(uuid), substance.grel_edition_items(uuid, text) from public;

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
