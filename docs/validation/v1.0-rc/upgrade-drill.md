# Upgrade drill and migration dry run upgrade-20261018T063727Z-501e1d: PASS

Commit `53dcb95eceeb87e78b60d61f3ffdb739351bd280`, host `vm`. Inputs: database `ebmr_drill6a_e2e_7d01`, report SHA-256 `c25aca79213bf90582783ce69cda493757c7bd3730b40bfdafb652ee5a19f447`.

From Phase 6A exit (main at the start of Phase 7, PR #50) (ebmr_drill6a_e2e_7d01, 73604119 bytes, PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)) to the release candidate, on the copy ebmr_drillrc_e2e_7d01 (kept).

| Item | Value |
|---|---|
| Schema release before | `a05376cf8a32c5a5537c70a73d43fdbd07d0fd2f819aec09c69509479435e94c` (558 migrations) |
| Schema release after | `34da56ef63bb2af2f708687c0e544b2da86a6a5ea1fd6b9e2c14878c12e3133a` |
| Migrations applied | 18 in 290 ms |
| Whole drill | 55748 ms |
| Chains and anchors before | 2527 chains, 0 anchors, 0 problems |
| Chains and anchors after | 2534 chains, 0 anchors, 0 problems |

## Counts and hashes per category (DI-48)

| Category | Tables | MATCH | ADDED_ONLY | CHANGED | Rows before | Rows after |
|---|---|---|---|---|---|---|
| RECORDS | 561 | 549 | 5 | 0 | 20447 | 20492 |
| SIGNATURES | 22 | 20 | 2 | 0 | 2008 | 2013 |
| AUDIT_TRAIL | 7 | 3 | 4 | 0 | 20615 | 20823 |
| SYSTEM | 1 | 0 | 1 | 0 | 558 | 576 |

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
| "kernel"."ddl_log" | AUDIT_TRAIL | ADDED_ONLY | 10016 | 10171 | 0 |  |
| "platform"."config_area" | RECORDS | ADDED_ONLY | 17 | 18 | 0 |  |
| "platform"."config_version" | RECORDS | ADDED_ONLY | 496 | 514 | 0 |  |
| "platform"."db_time_column" | RECORDS | ADDED_ONLY | 353 | 358 | 0 |  |
| "public"."schema_migration" | SYSTEM | ADDED_ONLY | 558 | 576 | 0 |  |
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
| SIGNATURE | esig.signature | c3548184-9a05-4ecd-b9bb-7f7d7a06be48 | SPECIFICATION_APPROVED by Karan Malhotra at 2026-10-18 03:55:41Z | yes |
| SIGNATURE | esig.signature | f50274d4-6dfc-4621-be40-98147d7068ec | QC_RESULT_APPROVED by Karan Malhotra at 2026-10-18 03:55:57Z | yes |
| SIGNATURE | esig.signature | df9bc1ec-4340-4298-92e6-59822e09134c | VERIFIED by Kavya Reddy at 2026-10-18 03:59:12Z | yes |
| SIGNATURE | esig.signature | d7e5487a-1f69-41d2-8073-51d2513a66aa | PRODUCTION_APPROVED by Lakshmi Iyengar at 2026-10-18 04:05:43Z | yes |
| SIGNATURE | esig.signature | 792401f1-b73f-4e52-b3bf-afcfa11ff226 | MBR_MARKET_AUTHORISED by Meera Iyer at 2026-10-18 03:56:09Z | yes |
| SIGNATURE | esig.signature | da4bc254-f6e3-48d9-8bd4-1cd8a3f437a9 | PERFORMED by Arjun Das at 2026-10-18 04:05:37Z | yes |
| SIGNATURE | esig.signature | c0fdfba7-0942-41e7-936d-59fc0704f567 | SPECIFICATION_APPROVED by Karan Malhotra at 2026-10-18 03:55:54Z | yes |
| SIGNATURE | esig.signature | ede26033-375d-46d5-87c2-8b5075a3f449 | MANUFACTURER_APPROVED by Divya Menon at 2026-10-18 03:55:52Z | yes |
| SIGNATURE | esig.signature | 0fb9f7b0-45cf-455b-8bb0-5ebbcd90135b | PERFORMED by Arjun Das at 2026-10-18 04:05:40Z | yes |
| SIGNATURE | esig.signature | 54b168c6-f777-4698-ab70-93702f4d28cb | VERIFIED by Kavya Reddy at 2026-10-18 03:58:07Z | yes |
| SIGNATURE | esig.signature | 666aa0e4-c1b3-4fb3-9194-0189576d94e0 | PERFORMED by Arjun Das at 2026-10-18 04:05:36Z | yes |
| SIGNATURE | esig.signature | ad11369a-b256-42a7-a073-1c6316f7f06b | MBR_MARKET_AUTHORISED by Meera Iyer at 2026-10-18 03:56:10Z | yes |
| SIGNATURE | esig.signature | adc6e1a8-173e-4bc9-8523-5bba43d550bf | VERIFIED by Kavya Reddy at 2026-10-18 03:59:14Z | yes |
| SIGNATURE | esig.signature | 7596e339-8c7b-4d64-b845-c57ce3c56896 | EXCEPTION_DISPOSITIONED by Fatima Sheikh at 2026-10-18 04:03:32Z | yes |
| SIGNATURE | esig.signature | a42a7aa8-732f-499e-a579-5003ff4a960f | MATERIAL_LOT_RELEASED by Karan Malhotra at 2026-10-18 03:55:53Z | yes |
| SIGNATURE | esig.signature | fbbe3e84-a057-4909-b88a-70f1caa1b8f4 | VERIFIED by Kavya Reddy at 2026-10-18 04:05:37Z | yes |
| SIGNATURE | esig.signature | 8e7d99d1-6dbc-4307-91c1-13b95a4ee2fc | PERFORMED by Arjun Das at 2026-10-18 04:02:33Z | yes |
| SIGNATURE | esig.signature | 591753ed-4967-4b65-9137-d74ba19488ac | QC_RESULT_APPROVED by Karan Malhotra at 2026-10-18 03:55:56Z | yes |
| SIGNATURE | esig.signature | 623c3827-daa1-429b-8fe2-867cab35e18e | MATERIAL_LOT_RELEASED by Karan Malhotra at 2026-10-18 03:55:53Z | yes |
| SIGNATURE | esig.signature | 5e8cf3e5-0688-47a2-b88e-9b41b8c7dd2f | QC_RESULT_APPROVED by Karan Malhotra at 2026-10-18 03:55:43Z | yes |
| AUDIT_EVENT | kernel.audit_event | 6645 | esig_challenge:batch_stage:8100a1a8-f798-42b6-837d-77372d594732:S-PACK@ #1 INSERT esig.challenge | yes |
| AUDIT_EVENT | kernel.audit_event | 2141 | aql_scheme:AQL-SINGLE-SAMPLING #177 INSERT tab.aql_plan | yes |
| AUDIT_EVENT | kernel.audit_event | 7326 | esig_challenge:review_items:3a2ebbd8-5398-4bb5-aa94-a550288a1c00/ACCEPT/01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b/EX-18 #1 INSERT esig.challenge | yes |
| AUDIT_EVENT | kernel.audit_event | 4953 | batch:3a2ebbd8-5398-4bb5-aa94-a550288a1c00 #191 INSERT recipe.execution_event | yes |
| AUDIT_EVENT | kernel.audit_event | 2714 | person:29c09921-8c33-4d9e-93a7-1141d8e7ca20 #2 INSERT iam.identity_verification | yes |
| AUDIT_EVENT | kernel.audit_event | 1011 | engine_name:ST-54 #1 INSERT recipe.engine_name | yes |
| AUDIT_EVENT | kernel.audit_event | 2478 | block_data_schema:TB-23 #3 INSERT recipe.block_data_schema | yes |
| AUDIT_EVENT | kernel.audit_event | 7490 | batch_review:3a2ebbd8-5398-4bb5-aa94-a550288a1c00 #103 INSERT recipe.audit_review_scope | yes |
| AUDIT_EVENT | kernel.audit_event | 2554 | engine_name:TB08-ADDED-ITEM #1 INSERT recipe.engine_name | yes |
| AUDIT_EVENT | kernel.audit_event | 4274 | batch:794bc11a-c84c-421a-b577-ec6d1f9babe8 #37 INSERT recipe.execution_exception_content | yes |
| AUDIT_EVENT | kernel.audit_event | 7159 | batch:17f9af80-8628-4461-99c2-55abc23cfa3c #347 INSERT recipe.execution_event | yes |
| AUDIT_EVENT | kernel.audit_event | 1072 | engine_name:INV-36 #1 INSERT recipe.engine_name | yes |
| AUDIT_EVENT | kernel.audit_event | 4993 | state:b84cef71-e0c5-4aba-b223-6891a1378619 #21 UPDATE platform.aggregate_state | yes |
| AUDIT_EVENT | kernel.audit_event | 845 | engine_name:DI-50 #1 INSERT recipe.engine_name | yes |
| AUDIT_EVENT | kernel.audit_event | 3014 | market_rule_version:97eb859b-53c9-46a1-b269-e3f308c451da #52 INSERT market.rule_row | yes |
| AUDIT_EVENT | kernel.audit_event | 1346 | plant_series_tag:dryer.airflow_m3_h #1 INSERT plant.series_tag | yes |
| AUDIT_EVENT | kernel.audit_event | 279 | config_area:ROLE_PERMISSION #3 INSERT platform.config_version | yes |
| AUDIT_EVENT | kernel.audit_event | 3488 | evidence_epoch:41e9450f-4fea-4d0e-8ecd-0dd317f4341c #2 INSERT recipe.evidence_epoch | yes |
| AUDIT_EVENT | kernel.audit_event | 755 | engine_name:G20-NO-CALCULATION #1 INSERT recipe.engine_name | yes |
| AUDIT_EVENT | kernel.audit_event | 5659 | batch:3a2ebbd8-5398-4bb5-aa94-a550288a1c00 #612 INSERT recipe.execution_command | yes |
| UNIT_VALUE | esig.policy_key | esig.witness_window_seconds | s | yes |
| UNIT_VALUE | esig.policy_key | esig.india_dsc |  | yes |
| UNIT_VALUE | esig.policy_key | esig.mfa_at_signing |  | yes |
| UNIT_VALUE | esig.policy_key | esig.challenge_validity_seconds | s | yes |
| UNIT_VALUE | esig.policy_key | esig.session_relaxation |  | yes |
| UNIT_VALUE | iam.policy_key | attribution.freshness_seconds.GRADE_A_B | s | yes |
| UNIT_VALUE | iam.policy_key | badge.test_interval_days | days | yes |
| UNIT_VALUE | iam.policy_key | credential.password_history | passwords | yes |
| UNIT_VALUE | iam.policy_key | alert.ack_deadline_seconds | s | yes |
| UNIT_VALUE | iam.policy_key | esig.us_certification_mode |  | yes |
| UNIT_VALUE | market.rule_row | c2ae2ea0-9d21-4da3-8df2-7a497c0a425b | {flag} | yes |
| UNIT_VALUE | market.rule_row | 532c5ef2-9322-4785-8cf8-54caa26c1584 | {flag} | yes |
| UNIT_VALUE | market.rule_row | ff98f0ea-486b-471c-be40-90d46a54f372 | mo | yes |
| UNIT_VALUE | market.rule_row | 1bf2ac50-dd1f-400c-8553-1f91ef1fb130 | {criteria} | yes |
| UNIT_VALUE | market.rule_row | b087b80f-86ad-4d27-ba79-79b483d6429e | {flag} | yes |
| UNIT_VALUE | plant.output_container | d4eba547-328a-449c-ad2b-3fd084e0062c | kg | yes |
| UNIT_VALUE | plant.output_container | 36f0b561-2472-4a9e-871f-783bb13a88e5 | kg | yes |
| UNIT_VALUE | plant.output_container | a5d71ea1-2ed4-488c-87ee-7f76ef303f6b | kg | yes |
| UNIT_VALUE | plant.output_container | f7c7b434-ed5a-4b46-a186-2fb1c620170c | kg | yes |
| UNIT_VALUE | plant.output_container | 5355a044-8a59-4a7e-b811-455d0e01a7bd | kg | yes |
| UNIT_VALUE | plant.series_tag | dryer.exhaust_temp_C | degC | yes |
| UNIT_VALUE | plant.series_tag | roller.gap_mm | mm | yes |
| UNIT_VALUE | plant.series_tag | dryer.inlet_temp_C | degC | yes |
| UNIT_VALUE | plant.series_tag | granulator.power_kW | kW | yes |
| UNIT_VALUE | plant.series_tag | blister.seal_pressure_bar | bar | yes |
| UNIT_VALUE | platform.setting_definition | integration.mode.lms_qualification |  | yes |
| UNIT_VALUE | platform.setting_definition | integration.mode.qms_status |  | yes |
| UNIT_VALUE | platform.setting_definition | integration.mirror_max_age_s.erp_lot_status | s | yes |
| UNIT_VALUE | platform.setting_definition | integration.mirror_max_age_s.l3_serial_status | s | yes |
| UNIT_VALUE | platform.setting_definition | records.qp_access_max_days | d | yes |
| UNIT_VALUE | recipe.packaging_bulk_issue | 065a823d-28a8-414e-b6ba-5bcbbd9a5839 | kg | yes |
| UNIT_VALUE | recipe.packaging_bulk_issue | a2002194-1091-476d-9b0c-988af1382309 | kg | yes |
| UNIT_VALUE | site.batch_number_allocation | 41ca8e1d-255f-4d78-a186-bc284e83327b | {tbl} | yes |
| UNIT_VALUE | site.batch_number_allocation | 76ae25b0-b1ee-4301-953c-5515d2747e38 | kg | yes |
| UNIT_VALUE | site.batch_number_allocation | 7d995a7a-abf3-4875-850a-99c7a92e531f | kg | yes |
| UNIT_VALUE | site.batch_number_allocation | 0c04f164-7eed-4494-83d7-ea01feaec1e4 | {tbl} | yes |
| UNIT_VALUE | site.erp_material | 420866fd-4998-4b40-9960-5ff85a844f67 | kg | yes |
| UNIT_VALUE | site.erp_material | 2cd6e4f1-c36e-4e75-9c5a-10656c68c0d0 | kg | yes |
| UNIT_VALUE | site.erp_material | 866cc5be-2180-4afc-9b8d-6a42e457a14e | kg | yes |
| UNIT_VALUE | site.erp_material | 4b917fec-89c7-4539-8852-3f53445938e3 | kg | yes |
| UNIT_VALUE | site.erp_material | 9b91f84a-e086-41ce-a552-c3e9ba21f1c6 | kg | yes |
| UNIT_VALUE | site.erp_production_order | b8a54bbf-ecad-4006-be50-d76758ea740b | {tbl} | yes |
| UNIT_VALUE | site.erp_production_order | 34c16af9-d634-42fd-9e41-5f461430aa41 | {tbl} | yes |
| UNIT_VALUE | site.erp_production_order | cf5feaae-7f10-4484-ad85-b41deff64aef | {tbl} | yes |
| UNIT_VALUE | site.erp_production_order | 7cc5b58b-a1dc-4897-9585-625ffa6d1c50 | kg | yes |
| UNIT_VALUE | site.erp_production_order | 32e66b1d-4b0d-44f7-bdb0-d612a1e36ff3 | kg | yes |
| UNIT_VALUE | site.lot_consumption | d7df9b4e-a8e2-4e10-8778-b4181a88a222 | kg | yes |
| UNIT_VALUE | site.lot_consumption | 279e5726-303c-4881-a3a8-39a33181e459 | kg | yes |
| UNIT_VALUE | site.lot_consumption | 052d8de5-c38b-437d-bc31-774746d2014f | kg | yes |
| UNIT_VALUE | site.lot_consumption | cd7a0d1c-7413-4076-8335-fa7825df31ce | kg | yes |
| UNIT_VALUE | site.lot_consumption | 30cc6b91-6d9c-484b-ba3c-ab2362122b77 | kg | yes |
| UNIT_VALUE | site.lot_receipt | c04b14cd-3acd-4602-8f9e-37406b867aa7 | kg | yes |
| UNIT_VALUE | site.lot_receipt | c0d64c43-1924-49df-9e5d-a2c359be47fb | kg | yes |
| UNIT_VALUE | site.lot_receipt | 9c031db0-11d9-4040-8e69-b674b63088d9 | kg | yes |
| UNIT_VALUE | site.lot_receipt | ff37047e-e043-4299-b402-08671f5701b4 | kg | yes |
| UNIT_VALUE | site.lot_receipt | 0fc4f8ec-f129-4adf-a0fc-059f50cd29c2 | 1 | yes |
| UNIT_VALUE | site.lot_reservation | 0a58f916-16dd-4b64-9f58-886f2d2a7879 | kg | yes |
| UNIT_VALUE | site.lot_reservation | 9b9d75a8-a769-48f2-b3cf-cef0a2eabd5a | kg | yes |
| UNIT_VALUE | site.lot_reservation | 17e1745a-3ab4-4012-ac3f-936e574a0a76 | kg | yes |
| UNIT_VALUE | site.lot_reservation | bd031db0-d649-4910-8070-d825495ce5a9 | kg | yes |
| UNIT_VALUE | site.lot_reservation | 4ba9d9a3-1138-4335-a4fe-b1d85b598f65 | kg | yes |
| UNIT_VALUE | site.lot_sample | 314dfc66-83d7-4d68-94b9-c2668c123a5f | packs | yes |
| UNIT_VALUE | site.lot_test_result | 00bd376d-ccad-43c2-9b1c-c06d7aef3356 | % | yes |
| UNIT_VALUE | site.lot_test_result | 6e01d2e7-6d4a-4d3e-91d7-5ee7839b57af | % | yes |
| UNIT_VALUE | site.lot_test_result | 0b68b37c-3f37-4937-bf3c-4e1c3cb2e8a5 | % | yes |
| UNIT_VALUE | site.lot_test_result | 392af385-0e2f-42a4-8140-1be68414bf14 | % | yes |
| UNIT_VALUE | site.lot_test_result | 896b8aef-e84c-471e-a5bf-711d1be34a6e | % | yes |
| UNIT_VALUE | site.material_lot | d6349b7e-181e-4b09-a74f-47ba9eb5c2d6 | packs | yes |
| UNIT_VALUE | site.material_lot | c04b14cd-3acd-4602-8f9e-37406b867aa7 | kg | yes |
| UNIT_VALUE | site.material_lot | c0d64c43-1924-49df-9e5d-a2c359be47fb | kg | yes |
| UNIT_VALUE | site.material_lot | 9c031db0-11d9-4040-8e69-b674b63088d9 | kg | yes |
| UNIT_VALUE | site.material_lot | ff37047e-e043-4299-b402-08671f5701b4 | kg | yes |
| UNIT_VALUE | site.specification_test | e4a96612-fb4b-4867-b13c-ddcf5e105242 | % kg | yes |
| UNIT_VALUE | site.specification_test | 1cf822c1-6334-436f-9733-8af88de3640f | 1 kg | yes |
| UNIT_VALUE | site.specification_test | c9b83e50-199a-40cd-be7d-848187603641 | um kg | yes |
| UNIT_VALUE | site.specification_test | c3578e93-7752-4c3c-a13a-bd3422b10bee | % kg | yes |
| UNIT_VALUE | site.specification_test | 838e607a-7168-4883-8a75-2c9f8b0ebe13 | % kg | yes |
| UNIT_VALUE | tab.ipc_rule | tablets.compression.ipcSampleMaxInterval | min | yes |
| UNIT_VALUE | tab.process_tag | dryer.exhaust_temp_C | degC | yes |
| UNIT_VALUE | tab.process_tag | roller.gap_mm | mm | yes |
| UNIT_VALUE | tab.process_tag | dryer.inlet_temp_C | degC | yes |
| UNIT_VALUE | tab.process_tag | granulator.power_kW | kW | yes |
| UNIT_VALUE | tab.process_tag | blister.seal_pressure_bar | bar | yes |

## Migrations applied

`kernel/1300_release_identity_and_validation.sql`, `kernel/1305_source_signature_marker.sql`, `kernel/1306_transport_peer_advisory.sql`, `site-services/1103_consumption_batch_product_scope.sql`, `recipe-core/1210_plant_rule_qa_approval.sql`, `recipe-core/1214_controlled_reads_closed.sql`, `recipe-core/1215_controlled_tables_app_select.sql`, `recipe-core/1217_batch_scope_remaining_acts.sql`, `recipe-core/1218_batch_issue_order_product_scope.sql`, `recipe-core/1224_drop_check_engine_roles_two_argument.sql`, `tablets/1400_validation_and_controlled_read_roles.sql`, `tablets/1405_gateway_feed_signature.sql`, `tablets/1406_gateway_feed_one_adapter.sql`, `tablets/1410_signing_meanings_plant_rules.sql`, `tablets/1413_controlled_reads_gated.sql`, `tablets/1414_controlled_record_read.sql`, `tablets/1415_controlled_audit_read.sql`, `tablets/1460_session_idle_lock_in.sql`

