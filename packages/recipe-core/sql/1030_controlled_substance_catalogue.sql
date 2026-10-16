-- Recipe core: controlled-substance mode, the catalogue (Phase 6 slice 6e-0; draft control IN-53, status U: the NDPS Act
-- 1985 and NDPS Rules 1985 are not verified; docs/build-plan/phase-6/slice-6e-0-interfaces.md).
--
-- Handbook: modules/recipe-core.md
--
-- Permissions (never an administrator's; the commands of 1031 to 1034 check them first):
--   CONTROLLED.RECORD    QA records a product's controlled-substance flag (QA MBR approver).
--   CONTROLLED.APPROVE   a second QA person approves it (QA MBR approver, QA reviewer).
--   CONTROLLED.CUSTODY   proposes and signs a custody record of a controlled API (dispenser, warehouse, verifier, shift
--                        supervisor, QA shop floor).
--   CONTROLLED.BALANCE   records and signs the controlled account of a batch at a yield checkpoint (shift supervisor,
--                        stage responsible, QA shop floor).
--   CONTROLLED.REGISTER  runs the register export (QA reviewer, head of QC, authorised person, warehouse).
-- Meanings: CONTROLLED_PRODUCT_APPROVED (approver, never the recorder), CONTROLLED_CUSTODY_RECORDED (the first custodian),
-- CONTROLLED_CUSTODY_COUNTERSIGNED (witness class: never the first custodian or the proposer, independent of the first
-- signature), CONTROLLED_BALANCE_SIGNED (supervisor). IN-53 joins the names a test run may cite (recipe.engine_name).

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 1030_controlled_substance_catalogue)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'controlled-substance mode: permissions, signature meanings and the draft control IN-53'));

insert into iam.permission (code, domain, effect, description) values
  ('CONTROLLED.RECORD', 'GMP', 'WRITE', 'Record a product''s controlled-substance flag and its controlled API materials (QA; IN-53)'),
  ('CONTROLLED.APPROVE', 'GMP', 'SIGN', 'Approve a controlled-substance flag recorded by another person (IN-53)'),
  ('CONTROLLED.CUSTODY', 'GMP', 'SIGN', 'Propose and sign a dual-custody record of a controlled API: dispensing, transfer, return or destruction (IN-53)'),
  ('CONTROLLED.BALANCE', 'GMP', 'SIGN', 'Record and sign the controlled-API account of a batch at a yield checkpoint (IN-53)'),
  ('CONTROLLED.REGISTER', 'GMP', 'WRITE', 'Run the controlled-substance register export (IN-53)');
insert into iam.role_permission (role_code, permission_code) values
  ('QA_MBR_APPROVER', 'CONTROLLED.RECORD'),
  ('QA_MBR_APPROVER', 'CONTROLLED.APPROVE'), ('QA_REVIEWER', 'CONTROLLED.APPROVE'),
  ('DISPENSER', 'CONTROLLED.CUSTODY'), ('WAREHOUSE_LABELLING', 'CONTROLLED.CUSTODY'), ('VERIFIER', 'CONTROLLED.CUSTODY'),
  ('SHIFT_SUPERVISOR', 'CONTROLLED.CUSTODY'), ('QA_SHOP_FLOOR', 'CONTROLLED.CUSTODY'),
  ('SHIFT_SUPERVISOR', 'CONTROLLED.BALANCE'), ('STAGE_RESPONSIBLE', 'CONTROLLED.BALANCE'), ('QA_SHOP_FLOOR', 'CONTROLLED.BALANCE'),
  ('QA_REVIEWER', 'CONTROLLED.REGISTER'), ('HEAD_OF_QC', 'CONTROLLED.REGISTER'), ('AUTHORISED_PERSON', 'CONTROLLED.REGISTER'),
  ('WAREHOUSE_LABELLING', 'CONTROLLED.REGISTER');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('CONTROLLED_PRODUCT_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'MASTER_RECORD', 'APPROVER', 'Controlled-substance flag approved',
   'I confirm this product''s controlled-substance flag and the controlled API materials it names, as recorded under the change record shown.',
   array['CONTROLLED.APPROVE'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'IN-53 (draft, NDPS not verified); outline decision 14'),
  ('CONTROLLED_CUSTODY_RECORDED', 1, 'VENDOR', true, 'ACTIVE', 'EXECUTION', 'PERFORMER', 'Controlled API custody recorded',
   'As the first custodian, I hand over or dispense the quantity of the controlled API lot shown, for the purpose shown.',
   array['CONTROLLED.CUSTODY'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'IN-53 (draft, NDPS not verified); outline decision 14'),
  ('CONTROLLED_CUSTODY_COUNTERSIGNED', 1, 'VENDOR', true, 'ACTIVE', 'VERIFICATION', 'WITNESS', 'Controlled API custody countersigned',
   'As the second custodian and witness, I saw the quantity of the controlled API lot shown handed over, dispensed or destroyed as recorded.',
   array['CONTROLLED.CUSTODY'], array['CONTROLLED_CUSTODY_RECORDED'], true, false, true, 'ALL_COMPONENTS', false, 'IN-53 (draft, NDPS not verified); outline decision 14'),
  ('CONTROLLED_BALANCE_SIGNED', 1, 'VENDOR', true, 'ACTIVE', 'BATCH_RECORD', 'SUPERVISOR', 'Controlled API account signed',
   'I confirm the account of the controlled API of this batch at this yield checkpoint, and the explanation and deviation of any difference.',
   array['CONTROLLED.BALANCE'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'IN-53 (draft, NDPS not verified); outline decision 14');

insert into recipe.engine_name (name, kind) values ('IN-53', 'CONTROL');

select kernel.set_actor_context(null);

reset role;
