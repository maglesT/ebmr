-- Tablets server, Phase 3 slice 6d (GB-T-01, outline 9.1): TB-01's configuration check flags a hydrate label that does
-- not match its molar mass (blocks/tb-01.ts): a name that says hydrate with no waters of hydration (TB01-HYDRATE-LABEL),
-- and waters of hydration with a form molar mass below the base, moieties and waters (TB01-HYDRATE-MASS). Both codes
-- are registered engine names so the findings and the refusals that carry them are recognised.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 1091_tb01_hydrate_codes)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the rule codes of TB-01 hydrate checks of Phase 3 slice 6d in the engine name register (PR-19, DI-33)'));

insert into recipe.engine_name (name, kind) values
  ('TB01-HYDRATE-LABEL', 'RULE_CODE'), ('TB01-HYDRATE-MASS', 'RULE_CODE');

select kernel.set_actor_context(null);

reset role;
