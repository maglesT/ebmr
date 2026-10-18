# Upgrade drill and migration dry run upgrade-20261018T044559Z-13afc9: PASS

Commit `11a71d58e6b7a69422db788ea04991c7bf29f772`, host `vm`. Inputs: database `ebmr_drill6a_e2e_7d01`, report SHA-256 `160080ec97b1e35c3ac410ec1884426b39cdeb9cca6e2aa617c1eca6b7a383cf`.

From Phase 6A exit (main at the start of Phase 7, PR #50) (ebmr_drill6a_e2e_7d01, 73604119 bytes, PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)) to the release candidate, on the copy ebmr_drillrc_e2e_7d01 (kept).

| Item | Value |
|---|---|
| Schema release before | `a05376cf8a32c5a5537c70a73d43fdbd07d0fd2f819aec09c69509479435e94c` (558 migrations) |
| Schema release after | `68e4d1a8f1289af00dd0b41affdb1944123d8350e4434233bd356d30d1c3b61e` |
| Migrations applied | 17 in 491 ms |
| Whole drill | 78968 ms |
| Chains and anchors before | 2527 chains, 0 anchors, 0 problems |
| Chains and anchors after | 2534 chains, 0 anchors, 0 problems |

## Counts and hashes per category (DI-48)

| Category | Tables | MATCH | ADDED_ONLY | CHANGED | Rows before | Rows after |
|---|---|---|---|---|---|---|
| RECORDS | 561 | 549 | 5 | 0 | 20447 | 20492 |
| SIGNATURES | 22 | 20 | 2 | 0 | 2008 | 2013 |
| AUDIT_TRAIL | 7 | 3 | 4 | 0 | 20615 | 20822 |
| SYSTEM | 1 | 0 | 1 | 0 | 558 | 575 |

## Tables the upgrade changed (every other table: MATCH, the same rows and hash)

| Table | Category | Status | Rows before | Rows after | Earlier rows missing | Columns added |
|---|---|---|---|---|---|---|
| "esig"."content_provider" | SIGNATURES | ADDED_ONLY | 71 | 74 | 0 |  |
| "esig"."meaning_type" | SIGNATURES | ADDED_ONLY | 117 | 119 | 0 |  |
| "iam"."permission" | RECORDS | ADDED_ONLY | 153 | 157 | 0 |  |
| "iam"."role_permission" | RECORDS | ADDED_ONLY | 323 | 339 | 0 |  |
| "kernel"."audit_chain_head" | AUDIT_TRAIL | ADVANCED | 2527 | 2534 | 14 |  |
| "kernel"."audit_event" | AUDIT_TRAIL | ADDED_ONLY | 7579 | 7620 | 0 |  |
| "kernel"."audited_table" | AUDIT_TRAIL | ADDED_ONLY | 493 | 498 | 0 |  |
| "kernel"."ddl_log" | AUDIT_TRAIL | ADDED_ONLY | 10016 | 10170 | 0 |  |
| "platform"."config_area" | RECORDS | ADDED_ONLY | 17 | 18 | 0 |  |
| "platform"."config_version" | RECORDS | ADDED_ONLY | 496 | 514 | 0 |  |
| "platform"."db_time_column" | RECORDS | ADDED_ONLY | 353 | 358 | 0 |  |
| "public"."schema_migration" | SYSTEM | ADDED_ONLY | 558 | 575 | 0 |  |
| "plant"."beta_lactam_class_approval" | RECORDS | NEW | 0 | 0 | 0 |  |
| "plant"."facility_rule_approval" | RECORDS | NEW | 0 | 0 | 0 |  |
| "platform"."signing_source" | RECORDS | NEW | 0 | 1 | 0 |  |
| "platform"."source_verification" | RECORDS | NEW | 0 | 0 | 0 |  |
| "platform"."system_interface" | RECORDS | NEW | 0 | 0 | 0 |  |
| "platform"."validation_summary" | RECORDS | NEW | 0 | 0 | 0 |  |
| "tab"."gateway_feed_binding" | RECORDS | NEW | 0 | 0 | 0 |  |

## Records retrieved and rendered (DI-46)

| Record | Events | Signatures | Rows | Content SHA-256 before | After | Same | Complete |
|---|---|---|---|---|---|---|---|
| batch:3a2ebbd8-5398-4bb5-aa94-a550288a1c00 | 941 | 61 | 813 | `dc93755e484aafef` | `dc93755e484aafef` | yes | yes |
| batch:8100a1a8-f798-42b6-837d-77372d594732 | 384 | 22 | 323 | `395fabd14315cfda` | `395fabd14315cfda` | yes | yes |
| batch:17f9af80-8628-4461-99c2-55abc23cfa3c | 383 | 20 | 322 | `141d4cdbc6d1b11e` | `141d4cdbc6d1b11e` | yes | yes |
| batch:794bc11a-c84c-421a-b577-ec6d1f9babe8 | 90 | 6 | 73 | `5a6255c16b33e03a` | `5a6255c16b33e03a` | yes | yes |
| batch_review:3a2ebbd8-5398-4bb5-aa94-a550288a1c00 | 122 | 61 | 120 | `b543b36662f27f66` | `b543b36662f27f66` | yes | yes |
| batch_review:8100a1a8-f798-42b6-837d-77372d594732 | 45 | 22 | 43 | `28ec5f4f9e73a097` | `28ec5f4f9e73a097` | yes | yes |
| batch_audit_review:3a2ebbd8-5398-4bb5-aa94-a550288a1c00/1 | 1 | 1 | 0 | `28ac2700e2b1d6e3` | `28ac2700e2b1d6e3` | yes | yes |
| batch_audit_review:8100a1a8-f798-42b6-837d-77372d594732/1 | 1 | 1 | 0 | `4c3ab848f284a22b` | `4c3ab848f284a22b` | yes | yes |
| mbr_version:511c1f27-fb4a-4877-92af-b7692c9a22f0 | 32 | 4 | 19 | `d01759df82a4116c` | `d01759df82a4116c` | yes | yes |
| mbr_version:5ed4f674-739a-426e-967d-e494b6973696 | 32 | 4 | 19 | `267970cf053a5ada` | `267970cf053a5ada` | yes | yes |
| mbr_version:2eaddf06-4430-4906-a8da-fb9859f15434 | 31 | 4 | 20 | `8d3382f8d9687e2d` | `8d3382f8d9687e2d` | yes | yes |
| mbr_market_authorisation:57b3d2d0-ad7d-40cc-be85-19255b2ead5c | 5 | 2 | 3 | `4825f7e914f92606` | `4825f7e914f92606` | yes | yes |
| mbr_market_authorisation:5b8755a5-887c-4b9d-938f-d72b508d701e | 5 | 2 | 3 | `270ec6cd70547983` | `270ec6cd70547983` | yes | yes |
| mbr_market_authorisation:8ded777f-1d67-48a4-9a95-0308eeae9fdb | 5 | 2 | 3 | `e1e640328eac4af9` | `e1e640328eac4af9` | yes | yes |
| mbr_market_authorisation:92f4ec58-a32b-4ce9-99d3-d31f571a683d | 5 | 2 | 3 | `d200db31469c7d0e` | `d200db31469c7d0e` | yes | yes |
| mbr_market_authorisation:abb0b030-ce95-491c-ba50-4eb84dcb9c25 | 5 | 2 | 3 | `06d838b4b8b74abe` | `06d838b4b8b74abe` | yes | yes |

## Spot checks (DI-48: audit trails, e-signature meaning and date-time, units)

| Kind | Table | Key | Shown | Same after |
|---|---|---|---|---|
| SIGNATURE | esig.signature | f50274d4-6dfc-4621-be40-98147d7068ec | QC_RESULT_APPROVED by Karan Malhotra at 2026-10-18 03:55:57Z | yes |
| SIGNATURE | esig.signature | 6d1017e5-c208-42b7-bcc5-ae9cdce9349b | EXCEPTION_DISPOSITIONED by Fatima Sheikh at 2026-10-18 04:00:26Z | yes |
| SIGNATURE | esig.signature | 3da61411-3551-4eb6-825e-781687f88d79 | APPROVED by Meera Iyer at 2026-10-18 03:56:10Z | yes |
| SIGNATURE | esig.signature | 836bd7e7-e5c1-4a25-953a-a04f6be95537 | REVIEW_ITEMS_DISPOSITIONED by Arvind Rao at 2026-10-18 04:05:44Z | yes |
| SIGNATURE | esig.signature | 61ae7592-16a1-4a1e-9c8c-9e9002881cdf | APPROVED by Meera Iyer at 2026-10-18 03:56:09Z | yes |
| SIGNATURE | esig.signature | e41cd974-11f7-4884-b268-5c27fecf98be | VERIFIED by Kavya Reddy at 2026-10-18 04:03:34Z | yes |
| SIGNATURE | esig.signature | 9512fd3c-df22-49ba-8a3b-4a7e1cdcd52a | REVIEW_ITEMS_DISPOSITIONED by Arvind Rao at 2026-10-18 04:06:45Z | yes |
| SIGNATURE | esig.signature | 0c05bc05-7000-4290-92e9-5db1f208e517 | YIELD_VERIFIED by Kavya Reddy at 2026-10-18 04:05:41Z | yes |
| SIGNATURE | esig.signature | 0e6ce8e8-fd6c-430c-904e-4b76253cb0f7 | MATERIAL_LOT_RELEASED by Karan Malhotra at 2026-10-18 03:55:58Z | yes |
| SIGNATURE | esig.signature | deb3fa6b-637c-4fe7-b0c3-4efeb0b35a57 | SPECIFICATION_APPROVED by Karan Malhotra at 2026-10-18 03:55:57Z | yes |
| SIGNATURE | esig.signature | 7f96f64e-7210-48c7-88da-0331d3e953ec | ERP_MASTER_CONFIRMED by Meera Iyer at 2026-10-18 03:55:23Z | yes |
| SIGNATURE | esig.signature | 210b12c6-ed68-4f22-8cf7-6345ddc23d6f | LINE_CLEARANCE_PERFORMED by Arjun Das at 2026-10-18 04:01:27Z | yes |
| SIGNATURE | esig.signature | 7dd68328-8fd7-4ed1-ab84-d8f207a52736 | PERFORMED by Priya Nair at 2026-10-18 04:00:16Z | yes |
| SIGNATURE | esig.signature | 7ee6ed65-9b29-4f48-93f9-499be81f50db | EXPORT_PERMISSION_APPROVED by Meera Iyer at 2026-10-18 03:55:59Z | yes |
| SIGNATURE | esig.signature | 08424d43-b7d5-45d5-812d-9a88b73fbc59 | WITNESSED by Kavya Reddy at 2026-10-18 04:03:30Z | yes |
| SIGNATURE | esig.signature | 785a0bb4-5234-4316-8986-78798ac75aef | REVIEW_ITEMS_DISPOSITIONED by Arvind Rao at 2026-10-18 04:06:45Z | yes |
| SIGNATURE | esig.signature | ede26033-375d-46d5-87c2-8b5075a3f449 | MANUFACTURER_APPROVED by Divya Menon at 2026-10-18 03:55:52Z | yes |
| SIGNATURE | esig.signature | 707513b9-a38b-4ffc-aafb-c4e86c318d50 | REVIEW_ITEMS_DISPOSITIONED by Arvind Rao at 2026-10-18 04:05:45Z | yes |
| SIGNATURE | esig.signature | d013a670-c8bd-4459-a767-d0b71dfa7c1f | QC_RESULT_APPROVED by Karan Malhotra at 2026-10-18 03:55:49Z | yes |
| SIGNATURE | esig.signature | f338b5a5-fe24-4d3c-b107-5d2c2a76d83a | YIELD_VERIFIED by Kavya Reddy at 2026-10-18 03:58:06Z | yes |
| AUDIT_EVENT | kernel.audit_event | 6174 | plant_clearance:8b7522af-f083-485a-b899-cfcecdbe739a #2 BUSINESS  | yes |
| AUDIT_EVENT | kernel.audit_event | 4024 | material_lot:18917fb4-7a66-4d2c-859f-408b0a77793d #9 BUSINESS  | yes |
| AUDIT_EVENT | kernel.audit_event | 1176 | engine_name:G21-NOT-CODED #1 INSERT recipe.engine_name | yes |
| AUDIT_EVENT | kernel.audit_event | 3168 | esig_signature:erp_master:MATERIAL/5e69ec1c-c4a2-41a2-8d47-727db27ac96a #2 INSERT esig.signature_seal | yes |
| AUDIT_EVENT | kernel.audit_event | 5862 | batch:3a2ebbd8-5398-4bb5-aa94-a550288a1c00 #780 INSERT recipe.execution_command | yes |
| AUDIT_EVENT | kernel.audit_event | 7449 | batch_review:3a2ebbd8-5398-4bb5-aa94-a550288a1c00 #62 INSERT recipe.audit_review_scope | yes |
| AUDIT_EVENT | kernel.audit_event | 459 | config_area:RETENTION_RULE_SET #1 INSERT platform.config_area | yes |
| AUDIT_EVENT | kernel.audit_event | 6187 | plant_equipment:a8ee04d7-d0f0-41e9-abdc-e83ecd0b5e9e #5 INSERT plant.instrument_use | yes |
| AUDIT_EVENT | kernel.audit_event | 3273 | esig_signature:lot_test_result:20e4700c-300c-4005-a7c6-b437d21fb88c #1 INSERT esig.signature | yes |
| AUDIT_EVENT | kernel.audit_event | 2912 | account:c1ba3ed1-fb63-4433-be60-83c706fb258d #3 INSERT iam.credential | yes |
| AUDIT_EVENT | kernel.audit_event | 2729 | account:951cf16c-8a2a-4468-8fb5-449daecc939f #4 UPDATE iam.account | yes |
| AUDIT_EVENT | kernel.audit_event | 6331 | batch:8100a1a8-f798-42b6-837d-77372d594732 #129 INSERT recipe.execution_stage_content | yes |
| AUDIT_EVENT | kernel.audit_event | 2794 | account:6abc5843-a3cf-4d14-b5d4-30d7d4a54b7f #8 INSERT iam.credential | yes |
| AUDIT_EVENT | kernel.audit_event | 1769 | engine_name:TB11-STOPPED #1 INSERT recipe.engine_name | yes |
| AUDIT_EVENT | kernel.audit_event | 3425 | esig_signature:specification:1c3e3fa6-573b-4924-87f0-10be16dd2088 #1 INSERT esig.signature | yes |
| AUDIT_EVENT | kernel.audit_event | 1247 | config_area:ESIG_MEANING #96 INSERT platform.config_version | yes |
| AUDIT_EVENT | kernel.audit_event | 2832 | badge:4063adf4-7e4c-45dd-a11b-79a0bd79bce0 #1 INSERT iam.badge | yes |
| AUDIT_EVENT | kernel.audit_event | 5499 | state:a5d71ea1-2ed4-488c-87ee-7f76ef303f6b #3 UPDATE platform.aggregate_state | yes |
| AUDIT_EVENT | kernel.audit_event | 7182 | esig_challenge:batch_step:17f9af80-8628-4461-99c2-55abc23cfa3c:p-pk-yield@ #2 INSERT esig.challenge | yes |
| AUDIT_EVENT | kernel.audit_event | 1146 | engine_name:G10-TWICE #1 INSERT recipe.engine_name | yes |
| UNIT_VALUE | esig.policy_key | esig.challenge_validity_seconds | s | yes |
| UNIT_VALUE | esig.policy_key | esig.india_dsc |  | yes |
| UNIT_VALUE | esig.policy_key | esig.session_relaxation |  | yes |
| UNIT_VALUE | esig.policy_key | esig.mfa_at_signing |  | yes |
| UNIT_VALUE | esig.policy_key | esig.witness_window_seconds | s | yes |
| UNIT_VALUE | iam.policy_key | attribution.freshness_seconds.SHARED | s | yes |
| UNIT_VALUE | iam.policy_key | attribution.freshness_seconds.GRADE_A_B | s | yes |
| UNIT_VALUE | iam.policy_key | credential.compromised_screening |  | yes |
| UNIT_VALUE | iam.policy_key | site.zone |  | yes |
| UNIT_VALUE | iam.policy_key | esig.us_certification_mode |  | yes |
| UNIT_VALUE | market.rule_row | 9c1c0cb0-bb62-4065-8f4a-4f73937abb3b | {flag} | yes |
| UNIT_VALUE | market.rule_row | 87fb2ed8-55f2-48e7-9cff-fa37f85c3064 | {criteria} | yes |
| UNIT_VALUE | market.rule_row | 3d9e254d-ad2f-4e38-8da1-0eae9db5dbd2 | {category} | yes |
| UNIT_VALUE | market.rule_row | 5f6c8743-0b97-4f22-b891-2606401c5583 | {multiple} | yes |
| UNIT_VALUE | market.rule_row | b087b80f-86ad-4d27-ba79-79b483d6429e | {flag} | yes |
| UNIT_VALUE | plant.output_container | ff346c07-dae4-4a9f-801a-253ad92081be | kg | yes |
| UNIT_VALUE | plant.output_container | a5d71ea1-2ed4-488c-87ee-7f76ef303f6b | kg | yes |
| UNIT_VALUE | plant.output_container | 47c1c1b5-aac7-47b7-a248-8e2560b1e933 | kg | yes |
| UNIT_VALUE | plant.output_container | 36f0b561-2472-4a9e-871f-783bb13a88e5 | kg | yes |
| UNIT_VALUE | plant.output_container | d4eba547-328a-449c-ad2b-3fd084e0062c | kg | yes |
| UNIT_VALUE | plant.series_tag | blister.seal_dwell_s | s | yes |
| UNIT_VALUE | plant.series_tag | roller.mill_rpm | rpm | yes |
| UNIT_VALUE | plant.series_tag | bottle.induction_power_pct | % | yes |
| UNIT_VALUE | plant.series_tag | roller.speed_rpm | rpm | yes |
| UNIT_VALUE | plant.series_tag | spray.rate_g_min | g/min | yes |
| UNIT_VALUE | platform.setting_definition | release.in_system_qp_certification |  | yes |
| UNIT_VALUE | platform.setting_definition | time.late_entry_window_mode |  | yes |
| UNIT_VALUE | platform.setting_definition | integration.mode.erp_lot_status |  | yes |
| UNIT_VALUE | platform.setting_definition | integration.mode.cmms_calibration |  | yes |
| UNIT_VALUE | platform.setting_definition | integration.mirror_max_age_s.lms_qualification | s | yes |
| UNIT_VALUE | recipe.packaging_bulk_issue | a2002194-1091-476d-9b0c-988af1382309 | kg | yes |
| UNIT_VALUE | recipe.packaging_bulk_issue | 065a823d-28a8-414e-b6ba-5bcbbd9a5839 | kg | yes |
| UNIT_VALUE | site.batch_number_allocation | 76ae25b0-b1ee-4301-953c-5515d2747e38 | kg | yes |
| UNIT_VALUE | site.batch_number_allocation | 41ca8e1d-255f-4d78-a186-bc284e83327b | {tbl} | yes |
| UNIT_VALUE | site.batch_number_allocation | 0c04f164-7eed-4494-83d7-ea01feaec1e4 | {tbl} | yes |
| UNIT_VALUE | site.batch_number_allocation | 7d995a7a-abf3-4875-850a-99c7a92e531f | kg | yes |
| UNIT_VALUE | site.erp_material | 3907ee7a-01bd-4f29-b1de-303ebb87a3c5 | kg | yes |
| UNIT_VALUE | site.erp_material | 34184ee1-0d50-44e0-9376-f0df7652adf8 | kg | yes |
| UNIT_VALUE | site.erp_material | 5e1e56ad-ee49-4a97-a59b-b9d4a0a83205 | kg | yes |
| UNIT_VALUE | site.erp_material | 9b91f84a-e086-41ce-a552-c3e9ba21f1c6 | kg | yes |
| UNIT_VALUE | site.erp_material | 5e69ec1c-c4a2-41a2-8d47-727db27ac96a | kg | yes |
| UNIT_VALUE | site.erp_production_order | cf5feaae-7f10-4484-ad85-b41deff64aef | {tbl} | yes |
| UNIT_VALUE | site.erp_production_order | 7cc5b58b-a1dc-4897-9585-625ffa6d1c50 | kg | yes |
| UNIT_VALUE | site.erp_production_order | f52c05bc-b18e-499b-b646-b14877caf143 | kg | yes |
| UNIT_VALUE | site.erp_production_order | f83a4bc6-6dfc-4214-b1a3-0702dd936fff | kg | yes |
| UNIT_VALUE | site.erp_production_order | 3ebe85b9-314f-4bf5-b3b7-106d79de1734 | kg | yes |
| UNIT_VALUE | site.lot_consumption | cd7a0d1c-7413-4076-8335-fa7825df31ce | kg | yes |
| UNIT_VALUE | site.lot_consumption | e7de746e-c0ad-41d9-963b-09ad50d9d19b | kg | yes |
| UNIT_VALUE | site.lot_consumption | d7df9b4e-a8e2-4e10-8778-b4181a88a222 | kg | yes |
| UNIT_VALUE | site.lot_consumption | 052d8de5-c38b-437d-bc31-774746d2014f | kg | yes |
| UNIT_VALUE | site.lot_consumption | 279e5726-303c-4881-a3a8-39a33181e459 | kg | yes |
| UNIT_VALUE | site.lot_receipt | 75ba1219-986a-4d71-bdc6-820bdb1acc95 | 1 | yes |
| UNIT_VALUE | site.lot_receipt | e1b8888f-1204-48fe-80aa-ba9152c2c9f0 | kg | yes |
| UNIT_VALUE | site.lot_receipt | 1ba68c4c-bea3-4777-b0d5-91dd9d3d03f9 | kg | yes |
| UNIT_VALUE | site.lot_receipt | 18917fb4-7a66-4d2c-859f-408b0a77793d | 1 | yes |
| UNIT_VALUE | site.lot_receipt | a7f3e823-b60d-4ead-8740-e7efc08505e1 | kg | yes |
| UNIT_VALUE | site.lot_reservation | 17e1745a-3ab4-4012-ac3f-936e574a0a76 | kg | yes |
| UNIT_VALUE | site.lot_reservation | bd031db0-d649-4910-8070-d825495ce5a9 | kg | yes |
| UNIT_VALUE | site.lot_reservation | 0a58f916-16dd-4b64-9f58-886f2d2a7879 | kg | yes |
| UNIT_VALUE | site.lot_reservation | 432dddc3-81ac-4fa2-90be-c58b2f0d4f8d | kg | yes |
| UNIT_VALUE | site.lot_reservation | 4ba9d9a3-1138-4335-a4fe-b1d85b598f65 | kg | yes |
| UNIT_VALUE | site.lot_sample | 314dfc66-83d7-4d68-94b9-c2668c123a5f | packs | yes |
| UNIT_VALUE | site.lot_test_result | 5b21f817-bb1b-4ec1-a06f-87fba2323890 | % | yes |
| UNIT_VALUE | site.lot_test_result | af5c9a0a-4ed3-416c-b01a-321bd06690c2 | um | yes |
| UNIT_VALUE | site.lot_test_result | 4184f733-5249-4442-b2af-dbee77359cd5 | 1 | yes |
| UNIT_VALUE | site.lot_test_result | 0b68b37c-3f37-4937-bf3c-4e1c3cb2e8a5 | % | yes |
| UNIT_VALUE | site.lot_test_result | 9b0335b8-5d46-4fc5-83f9-43353c5a0c90 | % | yes |
| UNIT_VALUE | site.material_lot | 75ba1219-986a-4d71-bdc6-820bdb1acc95 | 1 | yes |
| UNIT_VALUE | site.material_lot | e1b8888f-1204-48fe-80aa-ba9152c2c9f0 | kg | yes |
| UNIT_VALUE | site.material_lot | d6349b7e-181e-4b09-a74f-47ba9eb5c2d6 | packs | yes |
| UNIT_VALUE | site.material_lot | 1ba68c4c-bea3-4777-b0d5-91dd9d3d03f9 | kg | yes |
| UNIT_VALUE | site.material_lot | 18917fb4-7a66-4d2c-859f-408b0a77793d | 1 | yes |
| UNIT_VALUE | site.specification_test | 565e023b-a91e-450d-ab3b-122245500fed | % kg | yes |
| UNIT_VALUE | site.specification_test | ff0de78c-fc35-4ee8-bfea-3010598882bb | 1 kg | yes |
| UNIT_VALUE | site.specification_test | eab8fec8-0da5-4161-9e36-41b3c08afac7 | % kg | yes |
| UNIT_VALUE | site.specification_test | bd0252ac-ea1c-462c-9a78-39aefe060123 | % kg | yes |
| UNIT_VALUE | site.specification_test | c3578e93-7752-4c3c-a13a-bd3422b10bee | % kg | yes |
| UNIT_VALUE | tab.ipc_rule | tablets.compression.ipcSampleMaxInterval | min | yes |
| UNIT_VALUE | tab.process_tag | blister.seal_dwell_s | s | yes |
| UNIT_VALUE | tab.process_tag | roller.mill_rpm | rpm | yes |
| UNIT_VALUE | tab.process_tag | bottle.induction_power_pct | % | yes |
| UNIT_VALUE | tab.process_tag | roller.speed_rpm | rpm | yes |
| UNIT_VALUE | tab.process_tag | spray.rate_g_min | g/min | yes |

## Migrations applied

`kernel/1300_release_identity_and_validation.sql`, `kernel/1305_source_signature_marker.sql`, `kernel/1306_transport_peer_advisory.sql`, `site-services/1103_consumption_batch_product_scope.sql`, `recipe-core/1210_plant_rule_qa_approval.sql`, `recipe-core/1214_controlled_reads_closed.sql`, `recipe-core/1215_controlled_tables_app_select.sql`, `recipe-core/1217_batch_scope_remaining_acts.sql`, `recipe-core/1218_batch_issue_order_product_scope.sql`, `recipe-core/1224_drop_check_engine_roles_two_argument.sql`, `tablets/1400_validation_and_controlled_read_roles.sql`, `tablets/1405_gateway_feed_signature.sql`, `tablets/1406_gateway_feed_one_adapter.sql`, `tablets/1410_signing_meanings_plant_rules.sql`, `tablets/1413_controlled_reads_gated.sql`, `tablets/1414_controlled_record_read.sql`, `tablets/1415_controlled_audit_read.sql`

