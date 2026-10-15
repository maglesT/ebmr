-- Phase 6 slice 6f: the India DSC configuration is under change control (IN-10 with DI-09; builder A's kernel 1195).
--
-- Handbook: modules/kernel.md
--
-- The trust anchors of the DSC (kernel 1203) and the per-meaning DSC setting are configuration: a change needs the id of
-- an approved, open change record naming the area in the command's context (platform.config_change_guard), and every
-- row is a configuration version readable as of any date. The mode itself (esig.india_dsc) is an e-signature policy,
-- already in area ESIG_POLICY.
--   DSC_ANCHOR             esig.dsc_trust_anchor             item: the kind (TEST_CA or LICENSED); value: the root's
--                                                            SHA-256, label and subject.
--   DSC_ANCHOR_RETIREMENT  esig.dsc_trust_anchor_retirement  item: the anchor; value: the reason.
--   DSC_MEANING            esig.dsc_meaning_setting          item: the signature meaning; value: whether a DSC is needed.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1205_dsc_configuration_areas)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the India DSC configuration under change control (IN-10, DI-09)'));

select platform.register_config_area('DSC_ANCHOR', 'esig.dsc_trust_anchor',
  'India DSC trust anchors: the root certificate a DSC chain must end at (a TEST_CA in v1; IN-10)',
  array['kind'], array['root_sha256', 'label', 'subject'], 'recorded_at', 'recorded_at');
select platform.register_config_area('DSC_ANCHOR_RETIREMENT', 'esig.dsc_trust_anchor_retirement',
  'India DSC trust anchors retired (replaced or withdrawn)',
  array['anchor_id'], array['reason'], 'recorded_at', 'recorded_at');
select platform.register_config_area('DSC_MEANING', 'esig.dsc_meaning_setting',
  'India DSC per signature meaning: whether a second signature with a Class 3 certificate is needed while the policy is on',
  array['meaning_code'], array['required'], 'recorded_at', 'recorded_at');

-- INV-27: the ids of the per-meaning settings are a protected sequence.
select continuity.register_protected_sequence('esig.dsc_meaning_setting.id', pg_get_serial_sequence('esig.dsc_meaning_setting', 'id')::regclass,
  'OTHER', 'kernel', 'Ids of esig.dsc_meaning_setting (configuration versions of the India DSC per meaning)', 100000);

select kernel.set_actor_context(null);

reset role;
