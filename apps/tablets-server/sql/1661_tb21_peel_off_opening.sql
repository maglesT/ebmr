-- Tablets server, Phase 7 slice 7q (requirement R8, capability C8; decision D-7q-3): a peel-off blister. TB-21's pack
-- format may state how the blister is opened (packFormat.opening: PUSH_THROUGH, the default, PEEL_OFF or PEEL_PUSH;
-- blocks/tb-21.ts). A peelable opening is a property of the lidding foil, so the configuration check refuses it on a
-- strip pack (TB21-OPENING). The code is a registered engine name so the findings that carry it are recognised.
--
-- Handbook: modules/tablets-server.md

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 1661_tb21_peel_off_opening)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the rule code of the TB-21 peel-off opening check of Phase 7 slice 7q in the engine name register (PR-33)'));

insert into recipe.engine_name (name, kind) values ('TB21-OPENING', 'RULE_CODE');

select kernel.set_actor_context(null);

reset role;
