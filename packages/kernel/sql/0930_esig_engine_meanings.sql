-- Signature meanings the recipe execution engine requires (recipe-core engine, Phase 2) that the Phase 1 catalogue
-- (esig 0210) did not yet define. Vendor minimum types: customers may add types, never remove these (DI-35).

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 0930_esig_engine_meanings)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'signature meanings used by the recipe execution engine (DI-35)'));

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('HOLD_POINT_NOT_RELEASED', 1, 'VENDOR', true, 'ACTIVE', 'EXCEPTION', 'AUTHORISER', 'Hold point not released',
   'Quality-unit decision not to release this hold point; the intermediate is held and the batch waits for QA.',
   array['QA.FLOOR_APPROVE'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'Outline 5.2.2 hold; G-17; PR-45; IN-37'),
  ('STAGE_SIGNED_OFF', 1, 'VENDOR', true, 'ACTIVE', 'BATCH_RECORD', 'SUPERVISOR', 'Stage signed off',
   'As the person responsible for this stage, I confirm the stage record and its summary are complete and correct.',
   array['STEP.SUPERVISE', 'RECORD.PRODUCTION_APPROVE'], '{}', false, false, false, 'ALL_COMPONENTS', false,
   'IN-15 (person responsible for each stage); G-02; PR-16'),
  ('CORRECTION_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'EXCEPTION', 'AUTHORISER', 'Correction approved',
   'I approve this correction of recorded data, with its reason and evidence.',
   array['QA.FLOOR_APPROVE', 'RECORD.QA_REVIEW'], '{}', false, false, false, 'ALL_COMPONENTS', false,
   'Outline 5.2.3 (a), S25; DI-24'),
  ('INVALIDATION_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'EXCEPTION', 'AUTHORISER', 'Invalidation approved',
   'I approve the invalidation of this result on the basis of the linked investigation and its assignable cause.',
   array['RECORD.QA_REVIEW'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'Outline 5.2.3 (c); INV-41; DI-29'),
  ('BATCH_ABORT_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'BATCH_RECORD', 'APPROVER', 'Batch abort approved',
   'I approve aborting this batch, with the reason recorded; its outputs are held or rejected by QA.',
   array['RECORD.PRODUCTION_APPROVE', 'RECORD.QA_REVIEW'], '{}', false, false, false, 'ALL_COMPONENTS', false,
   'Outline 5.2.2 abort (production head and QA)'),
  ('BATCH_CANCELLED', 1, 'VENDOR', true, 'ACTIVE', 'BATCH_RECORD', 'SUPERVISOR', 'Batch cancelled',
   'As supervisor, I cancel this issued batch before any step started; its number is retired, the record kept.',
   array['STEP.SUPERVISE'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'Outline 5.2.2 ISSUED to CANCELLED; PR-10; IN-18');

select kernel.set_actor_context(null);

reset role;
