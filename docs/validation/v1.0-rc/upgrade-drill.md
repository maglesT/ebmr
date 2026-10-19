# Upgrade drill and migration dry run upgrade-20261019T075600Z-7b5849: PASS

Commit `ef8718f424f91cb17d37e1389a935e6d38e77fe8`, host `c52a61c4aa9d`. Inputs: database `ebmr_drill6a_e2e_7f01`, report SHA-256 `df18266179153cd738311060e7cb160442b94efe9f8ac6df22d16a9bcb177447`.

From Phase 6A exit (main bc46d55, PR #50) (ebmr_drill6a_e2e_7f01, 73194519 bytes, PostgreSQL 16.15 (Ubuntu 16.15-1.pgdg22.04+2)) to the release candidate, on the copy ebmr_drillrc_e2e_7f01 (kept).

| Item | Value |
|---|---|
| Schema release before | `a05376cf8a32c5a5537c70a73d43fdbd07d0fd2f819aec09c69509479435e94c` (558 migrations) |
| Schema release after | `9600714a051183f0fac729a2d1f0bcb2b08e62114072abeb0a16e9cc281c3591` |
| Migrations applied | 50 in 330 ms |
| Whole drill | 25738 ms |
| Chains and anchors before | 2527 chains, 0 anchors, 0 problems |
| Chains and anchors after | 2548 chains, 0 anchors, 0 problems |

## Counts and hashes per category (DI-48)

| Category | Tables | MATCH | ADDED_ONLY | CHANGED | Rows before | Rows after |
|---|---|---|---|---|---|---|
| RECORDS | 580 | 546 | 8 | 0 | 20447 | 20561 |
| SIGNATURES | 22 | 20 | 2 | 0 | 2008 | 2016 |
| AUDIT_TRAIL | 7 | 3 | 4 | 0 | 20615 | 21238 |
| SYSTEM | 1 | 0 | 1 | 0 | 558 | 608 |

## Tables the upgrade changed (every other table: MATCH, the same rows and hash)

| Table | Category | Status | Rows before | Rows after | Earlier rows missing | Columns added |
|---|---|---|---|---|---|---|
| "esig"."content_provider" | SIGNATURES | ADDED_ONLY | 71 | 76 | 0 |  |
| "esig"."meaning_type" | SIGNATURES | ADDED_ONLY | 117 | 120 | 0 |  |
| "iam"."permission" | RECORDS | ADDED_ONLY | 153 | 162 | 0 |  |
| "iam"."role_permission" | RECORDS | ADDED_ONLY | 323 | 348 | 0 |  |
| "kernel"."audit_chain_head" | AUDIT_TRAIL | ADVANCED | 2527 | 2548 | 16 |  |
| "kernel"."audit_event" | AUDIT_TRAIL | ADDED_ONLY | 7579 | 7654 | 0 |  |
| "kernel"."audited_table" | AUDIT_TRAIL | ADDED_ONLY | 493 | 514 | 0 |  |
| "kernel"."ddl_log" | AUDIT_TRAIL | ADDED_ONLY | 10016 | 10522 | 0 |  |
| "platform"."config_area" | RECORDS | ADDED_ONLY | 17 | 18 | 0 |  |
| "platform"."config_version" | RECORDS | ADDED_ONLY | 496 | 524 | 0 |  |
| "platform"."db_time_column" | RECORDS | ADDED_ONLY | 353 | 373 | 0 |  |
| "platform"."inbound_schema" | RECORDS | ADDED_ONLY | 22 | 23 | 0 |  |
| "platform"."setting_definition" | RECORDS | ADDED_ONLY | 28 | 29 | 0 |  |
| "public"."schema_migration" | SYSTEM | ADDED_ONLY | 558 | 608 | 0 |  |
| "report"."view_registry" | RECORDS | ADDED_ONLY | 16 | 19 | 0 |  |
| "continuity"."backup_download" | RECORDS | NEW | 0 | 0 | 0 |  |
| "continuity"."backup_request" | RECORDS | NEW | 0 | 0 | 0 |  |
| "continuity"."drill_request" | RECORDS | NEW | 0 | 0 | 0 |  |
| "continuity"."hardening_check" | RECORDS | NEW | 0 | 0 | 0 |  |
| "continuity"."upgrade_drill" | RECORDS | NEW | 0 | 0 | 0 |  |
| "iam"."installation_site" | RECORDS | NEW | 0 | 0 | 0 |  |
| "iam"."setup_token" | RECORDS | NEW | 0 | 0 | 0 |  |
| "plant"."beta_lactam_class_approval" | RECORDS | NEW | 0 | 0 | 0 |  |
| "plant"."facility_rule_approval" | RECORDS | NEW | 0 | 0 | 0 |  |
| "platform"."iq_record" | RECORDS | NEW | 0 | 0 | 0 |  |
| "platform"."operations_act" | RECORDS | NEW | 0 | 0 | 0 |  |
| "platform"."signing_source" | RECORDS | NEW | 0 | 1 | 0 |  |
| "platform"."source_verification" | RECORDS | NEW | 0 | 0 | 0 |  |
| "platform"."system_interface" | RECORDS | NEW | 0 | 0 | 0 |  |
| "platform"."validation_summary" | RECORDS | NEW | 0 | 0 | 0 |  |
| "records"."evaluation_pack" | RECORDS | NEW | 0 | 0 | 0 |  |
| "records"."evaluation_pack_approval" | RECORDS | NEW | 0 | 0 | 0 |  |
| "records"."export_restricted_table" | RECORDS | NEW | 0 | 8 | 0 |  |
| "records"."full_export" | RECORDS | NEW | 0 | 0 | 0 |  |
| "records"."full_export_run" | RECORDS | NEW | 0 | 0 | 0 |  |
| "records"."full_export_scope" | RECORDS | NEW | 0 | 0 | 0 |  |
| "report"."closed_record_source" | RECORDS | NEW | 0 | 3 | 0 |  |
| "report"."evaluation_source" | RECORDS | NEW | 0 | 14 | 0 |  |
| "tab"."demo_act" | RECORDS | NEW | 0 | 0 | 0 |  |
| "tab"."gateway_feed_binding" | RECORDS | NEW | 0 | 0 | 0 |  |
| "tab"."labelling_specimen_approval" | RECORDS | NEW | 0 | 0 | 0 |  |

## Records retrieved and rendered (DI-46)

| Record | Events | Signatures | Rows | Content SHA-256 before | After | Same | Complete |
|---|---|---|---|---|---|---|---|
| batch:fe2188c9-0f11-433d-bec4-453006691a9f | 941 | 61 | 813 | `035aa93123cb682f` | `035aa93123cb682f` | yes | yes |
| batch:74d4fec4-7ada-434c-94a6-29ff5672f2a7 | 384 | 22 | 323 | `01b8555d46d5e360` | `01b8555d46d5e360` | yes | yes |
| batch:ee0f3236-c6c6-4e50-8a61-d0400d7abbb9 | 383 | 20 | 322 | `b492e166ea0d4ab1` | `b492e166ea0d4ab1` | yes | yes |
| batch:b9226617-d306-4701-bc9c-e63155aa4ec5 | 90 | 6 | 73 | `e03b2a9ad8e298b3` | `e03b2a9ad8e298b3` | yes | yes |
| batch_review:fe2188c9-0f11-433d-bec4-453006691a9f | 122 | 61 | 120 | `a085ca058aa0708c` | `a085ca058aa0708c` | yes | yes |
| batch_review:74d4fec4-7ada-434c-94a6-29ff5672f2a7 | 45 | 22 | 43 | `b11942132040b7b6` | `b11942132040b7b6` | yes | yes |
| batch_audit_review:74d4fec4-7ada-434c-94a6-29ff5672f2a7/1 | 1 | 1 | 0 | `d93d68fbfd315a92` | `d93d68fbfd315a92` | yes | yes |
| batch_audit_review:fe2188c9-0f11-433d-bec4-453006691a9f/1 | 1 | 1 | 0 | `ca07543376eb2349` | `ca07543376eb2349` | yes | yes |
| mbr_version:846b2e4c-a58b-4483-90bd-adb297f34570 | 32 | 4 | 19 | `15758040fb7e1fdd` | `15758040fb7e1fdd` | yes | yes |
| mbr_version:e7d9d9eb-7adc-4bab-a702-8f07fe6cbded | 32 | 4 | 19 | `e43d9268780306a4` | `e43d9268780306a4` | yes | yes |
| mbr_version:63bb63f3-8d3c-401d-9368-b58e220a6258 | 31 | 4 | 20 | `dcfc859fffb48103` | `dcfc859fffb48103` | yes | yes |
| mbr_market_authorisation:478376fd-457d-42ba-85b1-dc5b034e80c4 | 5 | 2 | 3 | `c553718cc6f2c39b` | `c553718cc6f2c39b` | yes | yes |
| mbr_market_authorisation:50fa9fa4-9cce-4b2b-a69d-cde1d8a45531 | 5 | 2 | 3 | `d44276523e10a030` | `d44276523e10a030` | yes | yes |
| mbr_market_authorisation:978262dd-42ac-4988-8643-5ab2dad1bbbb | 5 | 2 | 3 | `8a484e54916ae1cf` | `8a484e54916ae1cf` | yes | yes |
| mbr_market_authorisation:9982356c-61e8-4a5e-8cc2-315e9e7287d1 | 5 | 2 | 3 | `e1a63a8aff489830` | `e1a63a8aff489830` | yes | yes |
| mbr_market_authorisation:9c7b6873-ced4-4d08-bed4-c27ff3c8320c | 5 | 2 | 3 | `f2992e6af2e711bb` | `f2992e6af2e711bb` | yes | yes |

## Spot checks (DI-48: audit trails, e-signature meaning and date-time, units)

| Kind | Table | Key | Shown | Same after |
|---|---|---|---|---|
| SIGNATURE | esig.signature | d98e2f7e-31b1-4e26-9857-0c18ef82bf10 | FORMULA_APPROVED by Meera Iyer at 2026-10-19 07:42:53Z | yes |
| SIGNATURE | esig.signature | fefbb7e7-09f5-4df0-a8b9-228f0d1f3340 | ERP_MASTER_CONFIRMED by Meera Iyer at 2026-10-19 07:42:28Z | yes |
| SIGNATURE | esig.signature | 20ad8171-27c2-4b9c-85d0-0879fa79095b | ERP_MASTER_CONFIRMED by Meera Iyer at 2026-10-19 07:42:27Z | yes |
| SIGNATURE | esig.signature | 37d3fa07-d5a7-4383-a144-8e3dd9752332 | YIELD_VERIFIED by Kavya Reddy at 2026-10-19 07:52:24Z | yes |
| SIGNATURE | esig.signature | 039a62ae-cfa3-4fb5-8ee5-7f9293ab19a3 | SPECIFICATION_APPROVED by Karan Malhotra at 2026-10-19 07:42:30Z | yes |
| SIGNATURE | esig.signature | 3cace469-c0ef-4eb1-8f09-1c7cf587145a | REVIEW_ITEMS_DISPOSITIONED by Arvind Rao at 2026-10-19 07:52:26Z | yes |
| SIGNATURE | esig.signature | 678082a6-f17b-46b9-a7ca-3dfb38e3ba94 | REVIEW_ITEMS_DISPOSITIONED by Arvind Rao at 2026-10-19 07:52:25Z | yes |
| SIGNATURE | esig.signature | e9727403-871a-4fa5-8f9f-4b57e29aba30 | EXCEPTION_DISPOSITIONED by Fatima Sheikh at 2026-10-19 07:47:16Z | yes |
| SIGNATURE | esig.signature | 5a66d092-977b-44bd-aa60-4acc4dea2949 | EXCEPTION_DISPOSITIONED by Fatima Sheikh at 2026-10-19 07:47:16Z | yes |
| SIGNATURE | esig.signature | f97d5c84-f910-4382-b2a4-2641d98a2236 | MATERIAL_LOT_RELEASED by Karan Malhotra at 2026-10-19 07:42:42Z | yes |
| SIGNATURE | esig.signature | fd43e156-7d65-4e1a-98d2-7d3e7812f84d | ERP_MASTER_CONFIRMED by Meera Iyer at 2026-10-19 07:42:24Z | yes |
| SIGNATURE | esig.signature | b9974c9b-1941-47fb-ab6a-a64cb3b72268 | PERFORMED by Priya Nair at 2026-10-19 07:47:10Z | yes |
| SIGNATURE | esig.signature | e807af12-e2d6-4150-afaf-9f479637460b | EXCEPTION_DISPOSITIONED by Fatima Sheikh at 2026-10-19 07:47:13Z | yes |
| SIGNATURE | esig.signature | 0e2d1386-e413-49c0-be0e-c3fe576b1ad8 | ERP_MASTER_CONFIRMED by Meera Iyer at 2026-10-19 07:42:23Z | yes |
| SIGNATURE | esig.signature | 160f2de7-a7bf-4edd-9533-14372080b0cf | PERFORMED by Arjun Das at 2026-10-19 07:44:59Z | yes |
| SIGNATURE | esig.signature | adfe2715-e9e4-4eac-bdc4-74396a11ef65 | PERFORMED by Arjun Das at 2026-10-19 07:50:19Z | yes |
| SIGNATURE | esig.signature | 0f1644f1-18b6-4807-9125-3ed8d9593e9e | MBR_MARKET_AUTHORISED by Meera Iyer at 2026-10-19 07:43:02Z | yes |
| SIGNATURE | esig.signature | 51cbc5e2-b447-4558-b534-6f2a34032ea4 | LOGBOOK_DOUBLE_CHECKED by Anita Desai at 2026-10-19 07:43:04Z | yes |
| SIGNATURE | esig.signature | 2d8170c1-f14c-4e5d-977d-a20e2569d076 | MATERIAL_LOT_RELEASED by Karan Malhotra at 2026-10-19 07:42:38Z | yes |
| SIGNATURE | esig.signature | b46fa3d6-f607-4540-8a18-a87b47f20e95 | HOLD_POINT_RELEASED by Fatima Sheikh at 2026-10-19 07:47:11Z | yes |
| AUDIT_EVENT | kernel.audit_event | 5877 | batch:fe2188c9-0f11-433d-bec4-453006691a9f #791 INSERT recipe.execution_event | yes |
| AUDIT_EVENT | kernel.audit_event | 931 | engine_name:PR-34 #1 INSERT recipe.engine_name | yes |
| AUDIT_EVENT | kernel.audit_event | 3378 | esig_signature:material_lot:32c0dabb-515b-4506-9bf2-25a2e75e392e #3 INSERT esig.signature_invalidation | yes |
| AUDIT_EVENT | kernel.audit_event | 3147 | erp_master:MATERIAL/c7d11ce5-d73e-4e82-934d-5842cd007417 #1 BUSINESS  | yes |
| AUDIT_EVENT | kernel.audit_event | 3271 | evidence_epoch:9a094f1f-3563-4497-b461-09f9e40eec85 #1 INSERT recipe.evidence_epoch | yes |
| AUDIT_EVENT | kernel.audit_event | 619 | iam_role:QC_ANALYST #4 INSERT iam.role_permission | yes |
| AUDIT_EVENT | kernel.audit_event | 4790 | batch:fe2188c9-0f11-433d-bec4-453006691a9f #67 INSERT recipe.execution_command | yes |
| AUDIT_EVENT | kernel.audit_event | 1468 | analytics_input:report.batch_fact_v1 #1 INSERT analytics.input_registry | yes |
| AUDIT_EVENT | kernel.audit_event | 3326 | esig_signature:lot_test_result:c951d8d3-2828-425e-8c37-3f9b35920b0b #2 INSERT esig.signature_seal | yes |
| AUDIT_EVENT | kernel.audit_event | 4601 | mbr_market_authorisation:a93f70f2-1118-4bcb-9548-d9e423b14ce3 #1 INSERT recipe.market_authorisation | yes |
| AUDIT_EVENT | kernel.audit_event | 2817 | badge:8dfadfb0-9509-457f-a63f-1c55120c5252 #3 UPDATE iam.badge | yes |
| AUDIT_EVENT | kernel.audit_event | 5874 | esig_signature:batch_step:fe2188c9-0f11-433d-bec4-453006691a9f:H-PACK@ #2 INSERT esig.signature_seal | yes |
| AUDIT_EVENT | kernel.audit_event | 2508 | engine_name:TB23-NO-BRIGHT-STOCK #1 INSERT recipe.engine_name | yes |
| AUDIT_EVENT | kernel.audit_event | 506 | esig_meaning:PEER_INSTALLATION_APPROVED #1 INSERT esig.meaning_type | yes |
| AUDIT_EVENT | kernel.audit_event | 3042 | market_rule_version:052dcac7-1c4c-4dae-ba5a-642594b9aaa6 #10 INSERT market.rule_row | yes |
| AUDIT_EVENT | kernel.audit_event | 3252 | specification:10f669d6-9c4b-4ae2-babf-d862f2c74966 #3 INSERT site.specification_test | yes |
| AUDIT_EVENT | kernel.audit_event | 3049 | reference_document:525248c3-3b16-43bf-b9c7-eab7be4ec3c9 #1 INSERT tab.reference_document | yes |
| AUDIT_EVENT | kernel.audit_event | 5006 | state:407c4e2f-83ee-476f-8071-df10ca2950cd #9 UPDATE platform.aggregate_state | yes |
| AUDIT_EVENT | kernel.audit_event | 6601 | batch:74d4fec4-7ada-434c-94a6-29ff5672f2a7 #348 INSERT recipe.execution_event | yes |
| AUDIT_EVENT | kernel.audit_event | 4727 | batch:fe2188c9-0f11-433d-bec4-453006691a9f #17 INSERT recipe.execution_event | yes |
| UNIT_VALUE | esig.policy_key | esig.challenge_validity_seconds | s | yes |
| UNIT_VALUE | esig.policy_key | esig.witness_window_seconds | s | yes |
| UNIT_VALUE | esig.policy_key | esig.mfa_at_signing |  | yes |
| UNIT_VALUE | esig.policy_key | esig.session_relaxation |  | yes |
| UNIT_VALUE | esig.policy_key | esig.india_dsc |  | yes |
| UNIT_VALUE | iam.policy_key | esig.us_certification_mode |  | yes |
| UNIT_VALUE | iam.policy_key | authn.event_max_age_seconds | s | yes |
| UNIT_VALUE | iam.policy_key | badge.test_interval_days | days | yes |
| UNIT_VALUE | iam.policy_key | qualification.mirror_max_staleness_seconds | s | yes |
| UNIT_VALUE | iam.policy_key | attribution.freshness_seconds.SHARED | s | yes |
| UNIT_VALUE | market.rule_row | 139bea97-742b-421a-add4-cab126d3b032 | {flag} | yes |
| UNIT_VALUE | market.rule_row | cf77f776-0a0c-4ff7-8ae0-4511167d5a42 | mo | yes |
| UNIT_VALUE | market.rule_row | 2afa9e5b-1a3c-43c4-80d3-9236318094dc | {flag} | yes |
| UNIT_VALUE | market.rule_row | 765c3820-722f-438f-af34-9f525987d6b7 | {flag} | yes |
| UNIT_VALUE | market.rule_row | 624444d0-f30f-4a63-86f0-143428d1a127 | mo | yes |
| UNIT_VALUE | plant.output_container | 817cee61-933d-4647-bca6-5d4a8dd69b51 | kg | yes |
| UNIT_VALUE | plant.output_container | 4b398280-07f3-4a72-a6a2-e12e70953a3a | kg | yes |
| UNIT_VALUE | plant.output_container | f0de19fd-1c85-4718-acd3-ce4f830e4def | kg | yes |
| UNIT_VALUE | plant.output_container | 576dba3e-65df-4075-89dd-6d856099bf82 | kg | yes |
| UNIT_VALUE | plant.output_container | 95a62085-3d33-4b75-a93f-0baf6f5e2e4c | kg | yes |
| UNIT_VALUE | plant.series_tag | fill.depth_mm | mm | yes |
| UNIT_VALUE | plant.series_tag | force.pre_kN | kN | yes |
| UNIT_VALUE | plant.series_tag | blister.seal_temp_C | degC | yes |
| UNIT_VALUE | plant.series_tag | granulator.chopper_rpm | rpm | yes |
| UNIT_VALUE | plant.series_tag | roller.gap_mm | mm | yes |
| UNIT_VALUE | platform.setting_definition | site.shift_boundaries |  | yes |
| UNIT_VALUE | platform.setting_definition | integration.mirror_max_age_s.erp_item_master | s | yes |
| UNIT_VALUE | platform.setting_definition | integration.mirror_max_age_s.qms_status | s | yes |
| UNIT_VALUE | platform.setting_definition | integration.mode.cmms_maintenance |  | yes |
| UNIT_VALUE | platform.setting_definition | time.late_entry_window_mode |  | yes |
| UNIT_VALUE | recipe.packaging_bulk_issue | 3719b041-c017-414a-96fc-8c9da470a15e | kg | yes |
| UNIT_VALUE | recipe.packaging_bulk_issue | 3eba19b8-ca33-4a32-bf0d-26b6369793e2 | kg | yes |
| UNIT_VALUE | site.batch_number_allocation | a648438d-a9d0-4f0e-a35d-cf2436ad7905 | {tbl} | yes |
| UNIT_VALUE | site.batch_number_allocation | a6dfb96e-56b6-400d-92a9-413f682babb1 | kg | yes |
| UNIT_VALUE | site.batch_number_allocation | 90e72d2c-5954-41fa-bcef-7e8503db4494 | {tbl} | yes |
| UNIT_VALUE | site.batch_number_allocation | 76a54cd0-afe4-454f-a44d-d2c927691d9c | kg | yes |
| UNIT_VALUE | site.erp_material | 7aafdfbd-0370-4f35-839d-1c2c31ec9d11 | kg | yes |
| UNIT_VALUE | site.erp_material | d8fa1c51-d144-48d0-ac4c-c6051685f22b | kg | yes |
| UNIT_VALUE | site.erp_material | b0b75cb8-7455-4834-b9e3-d4382f6416c8 | kg | yes |
| UNIT_VALUE | site.erp_material | ed7991df-1a26-4ca2-b7c0-3498da694134 | kg | yes |
| UNIT_VALUE | site.erp_material | 4d0a802d-d7b6-4926-b583-e40e02c7daaa | kg | yes |
| UNIT_VALUE | site.erp_production_order | 0b521937-ac96-42a3-bdf3-8b9b31d7cbdb | {tbl} | yes |
| UNIT_VALUE | site.erp_production_order | 70f72df4-27c6-4113-8582-cfd1bc2e7924 | kg | yes |
| UNIT_VALUE | site.erp_production_order | 632aedf3-aa7e-4bb2-b087-a3678fc6b3c5 | {tbl} | yes |
| UNIT_VALUE | site.erp_production_order | d29f2f62-8ae3-4b22-9f82-8712a131105c | kg | yes |
| UNIT_VALUE | site.erp_production_order | 5be48cee-d549-44be-8207-6ac95718ef5a | kg | yes |
| UNIT_VALUE | site.lot_consumption | bf86c1ab-a499-46aa-b032-8d77374bfb52 | kg | yes |
| UNIT_VALUE | site.lot_consumption | fb83c795-2beb-435c-a89d-8470a47c92ee | kg | yes |
| UNIT_VALUE | site.lot_consumption | 7fc7aaac-1cab-4615-90d9-9e7eb60bd060 | kg | yes |
| UNIT_VALUE | site.lot_consumption | dd6e5f18-1ba5-45f1-b68a-7c659ef30493 | kg | yes |
| UNIT_VALUE | site.lot_consumption | 55552117-c6a4-4e48-a0a1-b17e4d32c65a | kg | yes |
| UNIT_VALUE | site.lot_receipt | fdadc196-166f-470c-a9db-4592cee031c1 | kg | yes |
| UNIT_VALUE | site.lot_receipt | 9746a9e3-9a24-4ae1-9169-a2cef77e5288 | kg | yes |
| UNIT_VALUE | site.lot_receipt | 5780b1b5-33e9-4876-b0a9-90c8bce5744a | kg | yes |
| UNIT_VALUE | site.lot_receipt | b1000e73-17f4-4577-8385-27c5e527ef91 | kg | yes |
| UNIT_VALUE | site.lot_receipt | d07696a1-57f5-42bd-8ffb-68aca7ded564 | kg | yes |
| UNIT_VALUE | site.lot_reservation | 476c4f30-6eba-4140-bf4d-d23f32378ee2 | kg | yes |
| UNIT_VALUE | site.lot_reservation | f46fcb47-789a-484d-8b7e-c615b9e3b73f | kg | yes |
| UNIT_VALUE | site.lot_reservation | df5bbbbe-e071-41be-a09f-6132e8e85e25 | kg | yes |
| UNIT_VALUE | site.lot_reservation | 0608bb49-dd9d-4dd2-b57e-62fa14da865a | kg | yes |
| UNIT_VALUE | site.lot_reservation | 6882427d-f5a3-4a16-b61f-7d1bc19f819e | kg | yes |
| UNIT_VALUE | site.lot_sample | 7d34f6ab-cd50-4ca1-9a9f-ea359e3bb849 | packs | yes |
| UNIT_VALUE | site.lot_test_result | 62df473e-a583-4a3b-88ed-64507e21e87d | 1 | yes |
| UNIT_VALUE | site.lot_test_result | 21239fe2-d2e2-4d4a-8f99-3b1a706d3f43 | % | yes |
| UNIT_VALUE | site.lot_test_result | f1467758-502b-4efc-b90a-4f3aabc8b2cd | % | yes |
| UNIT_VALUE | site.lot_test_result | 3a9cb5da-f3f6-409e-89e9-245527d629c2 | 1 | yes |
| UNIT_VALUE | site.lot_test_result | 91454152-36a8-4d01-8fe9-9de20e94a338 | % | yes |
| UNIT_VALUE | site.material_lot | fdadc196-166f-470c-a9db-4592cee031c1 | kg | yes |
| UNIT_VALUE | site.material_lot | 9746a9e3-9a24-4ae1-9169-a2cef77e5288 | kg | yes |
| UNIT_VALUE | site.material_lot | 5780b1b5-33e9-4876-b0a9-90c8bce5744a | kg | yes |
| UNIT_VALUE | site.material_lot | b1000e73-17f4-4577-8385-27c5e527ef91 | kg | yes |
| UNIT_VALUE | site.material_lot | d07696a1-57f5-42bd-8ffb-68aca7ded564 | kg | yes |
| UNIT_VALUE | site.specification_test | 56bf56bb-9ecc-4080-9baf-f10c4cdade42 | % kg | yes |
| UNIT_VALUE | site.specification_test | c57733cf-01eb-47a3-a9f2-296b1b3a7ed0 | 1 kg | yes |
| UNIT_VALUE | site.specification_test | 26aa430a-a2be-4d43-b45e-2b3e78734a88 | um kg | yes |
| UNIT_VALUE | site.specification_test | 9979f574-870e-4023-aa75-3953f2e7dd3d | % kg | yes |
| UNIT_VALUE | site.specification_test | 26ed1dbb-be2e-46dd-aecb-fc2f5b343c09 | % kg | yes |
| UNIT_VALUE | tab.ipc_rule | tablets.compression.ipcSampleMaxInterval | min | yes |
| UNIT_VALUE | tab.process_tag | fill.depth_mm | mm | yes |
| UNIT_VALUE | tab.process_tag | force.pre_kN | kN | yes |
| UNIT_VALUE | tab.process_tag | blister.seal_temp_C | degC | yes |
| UNIT_VALUE | tab.process_tag | granulator.chopper_rpm | rpm | yes |
| UNIT_VALUE | tab.process_tag | roller.gap_mm | mm | yes |

## Migrations applied

`kernel/1300_release_identity_and_validation.sql`, `kernel/1305_source_signature_marker.sql`, `kernel/1306_transport_peer_advisory.sql`, `kernel/1320_sequence_gap_acknowledgment.sql`, `kernel/1321_dsc_administrator_refusal.sql`, `kernel/1322_analytics_audit_method_counts.sql`, `kernel/1328_series_gap_alarm_kind.sql`, `kernel/1329_stale_qualification_source_problem.sql`, `kernel/1330_opcua_offline_buffer_setting.sql`, `kernel/1335_full_export_closed_records.sql`, `kernel/1336_periodic_evaluation_pack.sql`, `kernel/1350_interface_drift_interlock.sql`, `kernel/1375_first_run_setup.sql`, `kernel/1376_operations_acts.sql`, `kernel/1381_iq_records.sql`, `kernel/1395_drills_and_hardening_checks.sql`, `site-services/1103_consumption_batch_product_scope.sql`, `site-services/1110_erp_outbound_insert_only.sql`, `site-services/1120_evaluation_deviations.sql`, `recipe-core/1210_plant_rule_qa_approval.sql`, `recipe-core/1214_controlled_reads_closed.sql`, `recipe-core/1215_controlled_tables_app_select.sql`, `recipe-core/1217_batch_scope_remaining_acts.sql`, `recipe-core/1218_batch_issue_order_product_scope.sql`, `recipe-core/1224_drop_check_engine_roles_two_argument.sql`, `recipe-core/1225_mock_recall_destinations.sql`, `recipe-core/1232_series_gap_message.sql`, `recipe-core/1233_source_time_session_lower_bound.sql`, `recipe-core/1234_opcua_alarm_event_offline_bound.sql`, `recipe-core/1235_opcua_series_offline_bound.sql`, `recipe-core/1240_evaluation_batch_records.sql`, `recipe-core/1250_validation_summary_issue_gate.sql`, `recipe-core/1260_us_esig_certification_issue_gate.sql`, `tablets/1400_validation_and_controlled_read_roles.sql`, `tablets/1405_gateway_feed_signature.sql`, `tablets/1406_gateway_feed_one_adapter.sql`, `tablets/1410_signing_meanings_plant_rules.sql`, `tablets/1413_controlled_reads_gated.sql`, `tablets/1414_controlled_record_read.sql`, `tablets/1415_controlled_audit_read.sql`, `tablets/1425_contract_giver_record_read.sql`, `tablets/1426_contract_giver_audit_read.sql`, `tablets/1432_gateway_feed_series_gap.sql`, `tablets/1460_session_idle_lock_in.sql`, `tablets/1479_mbr_signing_screens.sql`, `tablets/1485_operations_demo_and_backups.sql`, `tablets/1491_validation_signing_meanings.sql`, `tablets/1493_wp3_market_signing.sql`, `tablets/1496_lot_destruction_witness_signing.sql`, `tablets/1525_operations_restore_drills_reads.sql`

