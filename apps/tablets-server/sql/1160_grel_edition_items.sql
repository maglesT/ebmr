-- Tablets server, Phase 4 slice 3-0: the Tablets items of the release gate G-REL behind the recipe-core hook
-- (recipe-core 0780, recipe.grel_edition_items; outline 5.2.7 group 10 and the edition's blocks for groups 4 and 9).
--
--   tab.grel_edition_items(lot uuid, market text) returns jsonb   a JSON array of G-REL items (shape in recipe-core 0780;
--       ids "E.<NAME>", groups "4", "9" or "10"). 3-0 stub: no items. Slice 3b fills it (tablets 1161 to 1179): printed-
--       tablet QC approval (IN-37), held containers dispositioned, container release state, finished-pack examination
--       from TB-24 (group 9), reconciliation within limits or explained (group 4, IN-17 clause 2), the TB-12 rule-set QA
--       verification record, whole-batch parents not REJECTED. The core gate keeps groups 4 and 9 RED until the edition
--       answers for them (fails closed).

set local role ebmr_owner;

create function tab.grel_edition_items(p_lot uuid, p_market text) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select '[]'::jsonb
$$;

revoke all on function tab.grel_edition_items(uuid, text) from public;
grant execute on function tab.grel_edition_items(uuid, text) to ebmr_app;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 1160_grel_edition_items)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the Tablets items of the release gate G-REL (outline 5.2.7)'));
select recipe.register_grel_edition_hook('TABLETS', 'tab.grel_edition_items(uuid, text)');
select kernel.set_actor_context(null);

reset role;
