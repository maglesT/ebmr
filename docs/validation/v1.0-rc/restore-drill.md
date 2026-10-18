# Restore drill record drill-20261018T045346Z-bbd053: PASS

Commit `11a71d58e6b7a69422db788ea04991c7bf29f772`, host `vm`. Inputs: source `postgres://ebmr_dev@localhost:5439/ebmr_drillrc_e2e_7d01`.

Filled from `docs/operations/restore-drill-report-template.md` by `tools/drills` (sections 1 to 7 and the measurements); the reviewer completes sections 8 and 9.

## 1. Drill

| Item | Value |
|---|---|
| Drill id | `drill-20261018T045346Z-bbd053` |
| Purpose | validation (IQ/OQ) of the release candidate |
| Started and finished | 2026-10-18T04:53:46.945293Z to 2026-10-18T04:54:17.938518Z (database clock, UTC) |
| Duration | 31045 ms (kernel drill); 107647 ms with rendering, restore event and export |
| Source database and server version | ebmr_drillrc_e2e_7d01, PostgreSQL PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0, 64-bit, 78478359 bytes |
| Change or validation record | (reviewer) |
| External anchor exported before the backup | anchor 1 (to the installation's ledger, as its anchor job does) |

## 2. Backup used

| Item | Value |
|---|---|
| Backup id | ebmr_drillrc_e2e_7d01-20261018T045346Z-0d33cf |
| Format | PG_DUMP_CUSTOM |
| Encrypted at rest | true |
| Artefact SHA-256 | 80484a1c3a97c3c16e88b395c48c8ec3a8e89fb723ba4923a1415fa8a07d8be0 |
| Size (bytes) | 12491859 |
| Fixity verified | true |
| Tool | pg_dump (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) |

## 3. Restore

| Item | Value |
|---|---|
| Restored database | ebmr_drillrc_e2e_7d01_rst_fb8c04e7 |
| Isolated (no PUBLIC connect) | true |
| Dropped after the drill | true |
| Tool | pg_restore (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) |

## 4. Audit-trail verification

| Side | Chains | Anchors | Chain problems | Anchor problems |
|---|---|---|---|---|
| source | 2534 | 1 | 0 | 0 |
| restored | 2534 | 1 | 0 | 0 |

## 5. Content comparison by category

| Category | Tables | Matching | Rows (source) |
|---|---|---|---|
| RECORDS | 564 | 564 | 66648 |
| AUDIT_TRAIL | 7 | 7 | 20823 |
| SIGNATURES | 22 | 22 | 2013 |
| SYSTEM | 1 | 1 | 575 |

### Tables

| Table | Category | Rows source | Rows restored | Match | SHA-256 (source) |
|---|---|---|---|---|---|
| analytics.flag | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| analytics.flag_disposition | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| analytics.input_registry | RECORDS | 14 | 14 | yes | 46af3997d4cced8d... |
| analytics.method_version | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| analytics.output | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| analytics.reference_set | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| analytics.run | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| analytics.run_end | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.alarm | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.alarm_acknowledgement | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.backup_catalogue | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.backup_job_run | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.ceiling_reservation | RECORDS | 3 | 3 | yes | 0306788c2a559966... |
| continuity.counter | RECORDS | 3 | 3 | yes | e6f072dd713fcce7... |
| continuity.database_incarnation | RECORDS | 1 | 1 | yes | 7bd335e40cf7e52a... |
| continuity.device_hardening_attestation | RECORDS | 7 | 7 | yes | 3a59de8bb1078fbb... |
| continuity.device_hardening_revocation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.protected_sequence | RECORDS | 42 | 42 | yes | 3138af78c44586c2... |
| continuity.restore_completion | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.restore_drill | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.restore_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.restore_event_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.sequence_bump | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| drill_snapshot.chain_head_before | RECORDS | 2527 | 2527 | yes | b8dafee60f961b37... |
| drill_snapshot.row_hash | RECORDS | 43628 | 43628 | yes | dc79323ec326b098... |
| drill_snapshot.table_columns | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.challenge | SIGNATURES | 299 | 299 | yes | 850b4b3060811908... |
| esig.content_change | SIGNATURES | 532 | 532 | yes | b258958da1dda218... |
| esig.content_provider | SIGNATURES | 74 | 74 | yes | 7866c55fe09b12bc... |
| esig.dsc_enrolment | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.dsc_enrolment_end | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.dsc_meaning_setting | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.dsc_signature | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.dsc_trust_anchor | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.dsc_trust_anchor_retirement | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.meaning_type | SIGNATURES | 119 | 119 | yes | f4417b0db2508f2d... |
| esig.policy_key | SIGNATURES | 5 | 5 | yes | 6959d6e91412d2ff... |
| esig.policy_value | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.predicate_signature_point | SIGNATURES | 31 | 31 | yes | d8ef539b0501e47c... |
| esig.seal_key | SIGNATURES | 1 | 1 | yes | 2e14bc19d673dd57... |
| esig.seal_key_retirement | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.signature | SIGNATURES | 299 | 299 | yes | 1a612c7107a58ad2... |
| esig.signature_id_register | SIGNATURES | 299 | 299 | yes | 1de1e9f84a1ed3f0... |
| esig.signature_invalidation | SIGNATURES | 21 | 21 | yes | 5a487290553ba04b... |
| esig.signature_seal | SIGNATURES | 299 | 299 | yes | e723271109a25a05... |
| esig.signed_table | SIGNATURES | 34 | 34 | yes | 06b55a71476d919a... |
| esig.signing_failure | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.stub_signable | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| formulary.formula | RECORDS | 1 | 1 | yes | f5044ea86f2ab2fb... |
| formulary.formula_approval | RECORDS | 1 | 1 | yes | 0932d4a2a5804a5f... |
| formulary.formula_line | RECORDS | 9 | 9 | yes | d89f78970cadf440... |
| formulary.formula_version | RECORDS | 1 | 1 | yes | 4a5073ecb946c5c3... |
| formulary.mbr_formula_pin | RECORDS | 1 | 1 | yes | 7aeca3e4b8cf1565... |
| iam.access_recertification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.account | RECORDS | 27 | 27 | yes | 33eca90045d4ac4e... |
| iam.account_lock_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.account_status_event | RECORDS | 54 | 54 | yes | 93585bea55a2073d... |
| iam.auth_event | RECORDS | 1100 | 1100 | yes | ff9f7195616f9685... |
| iam.auth_event_use | RECORDS | 1276 | 1276 | yes | f128df47b1b441c4... |
| iam.authn_attempt | RECORDS | 1100 | 1100 | yes | 1e1ca4846b880112... |
| iam.authority_evaluation | RECORDS | 2150 | 2150 | yes | 2fd811d5327be529... |
| iam.badge | RECORDS | 5 | 5 | yes | 84cfac8cc25d89ca... |
| iam.badge_secret | RECORDS | 5 | 5 | yes | 1e9b0330fec23e54... |
| iam.badge_technology | RECORDS | 6 | 6 | yes | aef8c80b64f7db55... |
| iam.badge_test | RECORDS | 5 | 5 | yes | 56283adf773ef30a... |
| iam.break_glass_window | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.command_log | RECORDS | 1432 | 1432 | yes | 26c29401f6b0c8ee... |
| iam.credential | RECORDS | 61 | 61 | yes | bbcf32cfc18b832d... |
| iam.credential_secret | RECORDS | 61 | 61 | yes | a99e1e9d6891aa9c... |
| iam.delegation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.device | RECORDS | 33 | 33 | yes | 6bb5d9029a6dd24b... |
| iam.esig_acknowledgement | RECORDS | 22 | 22 | yes | f39fa8a9ae7a7523... |
| iam.esig_policy | RECORDS | 1 | 1 | yes | 348c504873fb0e4e... |
| iam.identity_verification | RECORDS | 24 | 24 | yes | 10c691126b400fee... |
| iam.installation_secret | RECORDS | 1 | 1 | yes | 66e532b576b37c47... |
| iam.integration_adapter | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.issued_identifier | RECORDS | 27 | 27 | yes | 3226902128683327... |
| iam.mirror_heartbeat | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.permission | RECORDS | 157 | 157 | yes | 7e23e33f7a870104... |
| iam.person | RECORDS | 28 | 28 | yes | 06a28360d8e699fa... |
| iam.person_name_event | RECORDS | 28 | 28 | yes | 9d16c928aab066aa... |
| iam.person_qualification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.person_status_event | RECORDS | 28 | 28 | yes | 8c9a425ee132d7dd... |
| iam.policy_key | RECORDS | 22 | 22 | yes | bf697519bbbf0898... |
| iam.policy_value | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.qualification_requirement | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.qualification_source | RECORDS | 2 | 2 | yes | fa30fcb2a16d970b... |
| iam.qualification_type | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.reserved_identifier | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.role | RECORDS | 39 | 39 | yes | aa02714c9a21578a... |
| iam.role_grant | RECORDS | 28 | 28 | yes | 620d539565c46dc8... |
| iam.role_permission | RECORDS | 339 | 339 | yes | 08b0f885d15fe4c3... |
| iam.role_permission_request | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.security_alert | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.security_alert_action | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.segregation_evaluation | RECORDS | 247 | 247 | yes | d0e6d90caca06e40... |
| iam.session | RECORDS | 426 | 426 | yes | 81e4cdbe36c9f68d... |
| iam.session_activity | RECORDS | 426 | 426 | yes | 46b5a48618cf7dd6... |
| iam.session_event | RECORDS | 473 | 473 | yes | 273abdd9050ff031... |
| iam.support_grant | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.support_grant_activation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.support_grant_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.support_grant_revocation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.support_session | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.us_esig_certification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| kernel.audit_anchor | AUDIT_TRAIL | 1 | 1 | yes | 9ec937c577e019b0... |
| kernel.audit_chain_head | AUDIT_TRAIL | 2534 | 2534 | yes | 7b4891802932cc12... |
| kernel.audit_checkpoint | AUDIT_TRAIL | 0 | 0 | yes | e3b0c44298fc1c14... |
| kernel.audit_event | AUDIT_TRAIL | 7620 | 7620 | yes | 3daf9308406553ac... |
| kernel.audit_verification_run | AUDIT_TRAIL | 0 | 0 | yes | e3b0c44298fc1c14... |
| kernel.audited_table | AUDIT_TRAIL | 498 | 498 | yes | fd3edab000c0d057... |
| kernel.command_marker | RECORDS | 11 | 11 | yes | f535d130e4e4490c... |
| kernel.ddl_log | AUDIT_TRAIL | 10170 | 10170 | yes | 9f6f6be7a5b1bb6f... |
| market.batch_policy_pin | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.change_impact | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.evaluation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.market | RECORDS | 3 | 3 | yes | 1661e72fdd3ef248... |
| market.policy | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.policy_version | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.rule_key | RECORDS | 24 | 24 | yes | 67d6c9d04bd0553d... |
| market.rule_row | RECORDS | 54 | 54 | yes | 42f26c56f6044b9f... |
| market.rule_table | RECORDS | 3 | 3 | yes | b1bbac7c43d08f6c... |
| market.rule_table_version | RECORDS | 2 | 2 | yes | b7e1128cd485cf79... |
| market.site_value | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.stub_batch | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.stub_equipment | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.stub_line | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.stub_material_lot | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.stub_mbr_limit | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.stub_pack | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.stub_person_qualification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.stub_product | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.stub_product_qualification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.stub_room | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.stub_site | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.alarm | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.alarm_ack | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.alarm_batch | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.alarm_code | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.alarm_transition | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.area | RECORDS | 5 | 5 | yes | bdb620c851eaed81... |
| plant.area_adjacency | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.area_dedication | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.area_dedication_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.area_occupancy | RECORDS | 6 | 6 | yes | 419fc967eb54fea1... |
| plant.area_occupancy_end | RECORDS | 6 | 6 | yes | 11b7b5af2c1b7d1a... |
| plant.area_rule | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.area_spill | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.beta_lactam_class | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.beta_lactam_class_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.calibration | RECORDS | 5 | 5 | yes | 6de0e9b74f798edf... |
| plant.campaign | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.campaign_closure | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.cleaning | RECORDS | 12 | 12 | yes | 097a1c7bb99228d2... |
| plant.cleaning_abandonment | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.cleaning_completion | RECORDS | 12 | 12 | yes | 4935f3a396d7056f... |
| plant.cleaning_verification | RECORDS | 12 | 12 | yes | b69920806c605b66... |
| plant.clearance | RECORDS | 6 | 6 | yes | e8550a2a155dd762... |
| plant.clearance_verification | RECORDS | 6 | 6 | yes | 858dae1bd6d454c4... |
| plant.cmms_calibration_message | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.cmms_work_order | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.container_charge | RECORDS | 3 | 3 | yes | 1571b8f58bca2f5f... |
| plant.container_close | RECORDS | 7 | 7 | yes | afd5eeb644bc90b0... |
| plant.container_close_verification | RECORDS | 7 | 7 | yes | 31c52239d562427d... |
| plant.container_hold | RECORDS | 1 | 1 | yes | f2070a836c093058... |
| plant.container_merge | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.controlled_product | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.controlled_product_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.device_original | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.equipment | RECORDS | 9 | 9 | yes | ba22bd6144c5824f... |
| plant.equipment_class | RECORDS | 6 | 6 | yes | 1783910d77013f73... |
| plant.equipment_event | RECORDS | 9 | 9 | yes | 4d8de81ff1f8e36e... |
| plant.equipment_repair | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.equipment_repair_verification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.equipment_state_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.equipment_use | RECORDS | 6 | 6 | yes | 99293e07c5583cd8... |
| plant.equipment_use_end | RECORDS | 6 | 6 | yes | f758123a9609fa2c... |
| plant.facility_rule | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.facility_rule_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.instrument_check | RECORDS | 7 | 7 | yes | 4fcf5fea07995d34... |
| plant.instrument_use | RECORDS | 7 | 7 | yes | 705442ddaa282c3c... |
| plant.ipc_check | RECORDS | 31 | 31 | yes | 49dd2517290c50d3... |
| plant.opcua_endpoint | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.opcua_endpoint_session | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.opcua_endpoint_unit | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.output_container | RECORDS | 8 | 8 | yes | 2030dca57b77054d... |
| plant.press_discharge | RECORDS | 1 | 1 | yes | da7477dd0439ac73... |
| plant.product | RECORDS | 2 | 2 | yes | ea2589b93384f412... |
| plant.product_hazard | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.product_hazard_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.reagent_use | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.series | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.series_tag | RECORDS | 51 | 51 | yes | 7ce48a6ed3b21b93... |
| plant.step_equipment | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.utility_feed_age | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.utility_reading | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.aggregate_clock | RECORDS | 43 | 43 | yes | b5d06625ff886b4f... |
| platform.aggregate_state | RECORDS | 43 | 43 | yes | 87aeaee423e4134e... |
| platform.alarm | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.alarm_clearance | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.change_record | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.change_record_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.config_area | RECORDS | 18 | 18 | yes | a915f1c19ccf4c0d... |
| platform.config_version | RECORDS | 514 | 514 | yes | 40c91ff332d1b82b... |
| platform.consumed_message | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.db_time_column | RECORDS | 358 | 358 | yes | 4ba4a12edd0cb9c3... |
| platform.drift_sample | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.federation_request | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.hook | RECORDS | 3 | 3 | yes | ac614875147f9eb5... |
| platform.idempotency_key | RECORDS | 597 | 597 | yes | f62a3e0f79e3d017... |
| platform.inbound_exception | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.inbound_message | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.inbound_override | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.inbound_schema | RECORDS | 22 | 22 | yes | 2cc13f4102070487... |
| platform.installation_alarm | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.installation_alarm_ack | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.installation_identity | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.integration_alarm | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.integration_alarm_ack | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.machine | RECORDS | 6 | 6 | yes | 47b002e41fa43011... |
| platform.machine_transition | RECORDS | 114 | 114 | yes | 7ec1845e96cc0b8e... |
| platform.machine_version | RECORDS | 8 | 8 | yes | 81d44a40692c567a... |
| platform.mirror_data_class | RECORDS | 8 | 8 | yes | 1d6db460075434f1... |
| platform.mirror_sync | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.outbox | RECORDS | 137 | 137 | yes | 6ae547701a6bcb10... |
| platform.outbox_attempt | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.outbox_state | RECORDS | 137 | 137 | yes | a3c22f7023e51fdc... |
| platform.peer_installation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.peer_installation_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.peer_installation_revocation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.reconciliation_report | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.setting_definition | RECORDS | 28 | 28 | yes | 86a1200f240528a8... |
| platform.setting_value | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.signing_source | RECORDS | 1 | 1 | yes | b5a95fcf1d2bbc95... |
| platform.source_verification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.state_guard | RECORDS | 42 | 42 | yes | 24b5cca55c7c6747... |
| platform.state_history | RECORDS | 137 | 137 | yes | 900bdee6655e6e54... |
| platform.stub_record | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.stub_step | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.stub_step_entry | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.system_interface | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.time_anomaly | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.time_source | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.time_source_registration | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.validation_summary | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| public.schema_migration | SYSTEM | 575 | 575 | yes | d5119df39940a8bd... |
| recipe.abort_checklist | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.after_release_decision | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.amendment_market_task | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.audit_review_scope | RECORDS | 131 | 131 | yes | c9b08f196eaff8ff... |
| recipe.authorisation_cell | RECORDS | 7 | 7 | yes | 3127f1c035743271... |
| recipe.batch_allocation_link | RECORDS | 4 | 4 | yes | 1f10c91866a2c476... |
| recipe.batch_erp_order | RECORDS | 4 | 4 | yes | 1721f3e2b5ceef5e... |
| recipe.batch_execution | RECORDS | 4 | 4 | yes | 0131b40cdbc398dc... |
| recipe.batch_licence_basis | RECORDS | 4 | 4 | yes | 3cac50fd86f719d5... |
| recipe.batch_mbr_pin | RECORDS | 4 | 4 | yes | d14695bb622d99bd... |
| recipe.batch_parent_link | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.batch_review_act | RECORDS | 6 | 6 | yes | 7ea9be9ea8f51bb9... |
| recipe.block_data_schema | RECORDS | 203 | 203 | yes | 6af9b6ba039577b3... |
| recipe.block_signature_meaning | RECORDS | 11 | 11 | yes | 118d10bd884786b0... |
| recipe.bright_stock_max_hold | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.bulk_reconciliation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.change_record | RECORDS | 3 | 3 | yes | e8fa680400ab2055... |
| recipe.change_record_regulatory | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.change_record_validation | RECORDS | 3 | 3 | yes | d11fb57cd51e13d1... |
| recipe.consumption_entry | RECORDS | 7 | 7 | yes | ce8211fc24676ae3... |
| recipe.contract_giver_access | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.contract_giver_access_revocation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.contract_giver_read | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.control_recipe | RECORDS | 4 | 4 | yes | 0ba96607660a4d5a... |
| recipe.controlled_checkpoint | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.controlled_checkpoint_signature | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.controlled_custody | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.controlled_custody_signature | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.controlled_custody_use | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.controlled_register_extract | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.engine_name | RECORDS | 990 | 990 | yes | 97f62db458899d3b... |
| recipe.engine_role_map | RECORDS | 8 | 8 | yes | 45d5568098b5dbc1... |
| recipe.engine_role_permission | RECORDS | 8 | 8 | yes | 1eaf63e336014d35... |
| recipe.eu_importer | RECORDS | 1 | 1 | yes | d94eb9dc4946cc1c... |
| recipe.eu_importer_product | RECORDS | 1 | 1 | yes | 292ec37515a6bdb1... |
| recipe.evidence_epoch | RECORDS | 165 | 165 | yes | 93971cc4fc254d75... |
| recipe.exception_register | RECORDS | 28 | 28 | yes | f549095b9c31202b... |
| recipe.exception_register_act | RECORDS | 55 | 55 | yes | 7565d131d8bb7c36... |
| recipe.exception_review_category | RECORDS | 11 | 11 | yes | cb188793864c34da... |
| recipe.exception_review_permission | RECORDS | 4 | 4 | yes | e6bbc78e3b58ea0d... |
| recipe.execution_act_proposal | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.execution_clock | RECORDS | 10 | 10 | yes | debd6c9414833d76... |
| recipe.execution_command | RECORDS | 255 | 255 | yes | e48e7cd21a6496a6... |
| recipe.execution_command_permission | RECORDS | 25 | 25 | yes | 5911735bfcd05b20... |
| recipe.execution_decision_proposal | RECORDS | 1 | 1 | yes | 0b69ddb504537ae0... |
| recipe.execution_disposition_proposal | RECORDS | 28 | 28 | yes | 5135ed98c88245de... |
| recipe.execution_event | RECORDS | 689 | 689 | yes | ac725515c47a7e3c... |
| recipe.execution_exception_content | RECORDS | 31 | 31 | yes | f8c57acbd1f88330... |
| recipe.execution_point_content | RECORDS | 18 | 18 | yes | f3456238a913e4fe... |
| recipe.execution_signature_meaning | RECORDS | 25 | 25 | yes | bf4551f481a0fd84... |
| recipe.execution_stage_content | RECORDS | 218 | 218 | yes | ab34aaa7acad93c7... |
| recipe.execution_stage_summary_legacy | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.execution_state | RECORDS | 4 | 4 | yes | 287452a2f79ae0d7... |
| recipe.execution_step_content | RECORDS | 145 | 145 | yes | a1eb6bc6389212a2... |
| recipe.federated_excerpt | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.federated_request_failure | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.federated_request_out | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.free_text_translation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.free_text_translation_verification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.grel_acknowledgement | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.grel_edition_hook | RECORDS | 1 | 1 | yes | 93bdc9bfa3c0c62a... |
| recipe.h2_payload_issue | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.in_flight_disposition | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.label_field_binding | RECORDS | 14 | 14 | yes | c2fbf89c5876cc99... |
| recipe.label_template | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.label_template_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.lot_disposal | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.lot_disposal_witness | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.manufacturer_release_decision | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.market_authorisation | RECORDS | 7 | 7 | yes | 23d76b89eb62112c... |
| recipe.market_authorisation_activation | RECORDS | 7 | 7 | yes | 66f42f81efab2604... |
| recipe.market_authorisation_withdrawal | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.market_change | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.market_disposition_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.mbr_content | RECORDS | 3 | 3 | yes | a4ff04d18ccbe60f... |
| recipe.mbr_draft_entry | RECORDS | 3 | 3 | yes | af3d6e39197935e0... |
| recipe.mbr_evidence | RECORDS | 15 | 15 | yes | f48da3ae798f7612... |
| recipe.mbr_evidence_void | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.mbr_family | RECORDS | 3 | 3 | yes | 231cc9a2f0a24801... |
| recipe.mbr_family_pack | RECORDS | 1 | 1 | yes | a0ee5fc47ab3e5a3... |
| recipe.mbr_risk_link | RECORDS | 3 | 3 | yes | 2ae48945e5a29fa6... |
| recipe.mbr_version | RECORDS | 3 | 3 | yes | 03294c5afcfd0219... |
| recipe.mbr_version_log | RECORDS | 30 | 30 | yes | 063131f360669ee7... |
| recipe.mock_recall | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.mock_recall_remote | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.mock_recall_signoff | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.notification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.notification_acknowledgement | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.notification_department | RECORDS | 2 | 2 | yes | 8ee9d5af487562f0... |
| recipe.notification_department_role | RECORDS | 6 | 6 | yes | ec6bb4c0853b532c... |
| recipe.open_investigation_justification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.packaging_bulk_issue | RECORDS | 2 | 2 | yes | 2c9e07df8e485381... |
| recipe.packaging_completion_block | RECORDS | 1 | 1 | yes | f06cc718801dce87... |
| recipe.packaging_labelling | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.periodic_review | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.post_change_evaluation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.ppq_outcome | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.pqr_extract | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.pqr_query_version | RECORDS | 2 | 2 | yes | 555cd4ad183c6b75... |
| recipe.pqr_signoff | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.qp_certification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.qp_message_ack | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.qp_register | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.qp_transcription_check | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.rbe_rereview_task | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.rbe_rule_version | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.record_amendment | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.record_amendment_close | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.record_amendment_entry | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.record_lock_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.release_suspension | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.release_task | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.release_task_closure | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.reprocessing_authorisation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.reprocessing_authorisation_signature | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.reprocessing_request | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.reprocessing_request_signature | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.reprocessing_step_start | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.residue_reservation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.review_item_disposition | RECORDS | 24 | 24 | yes | 494422764caa2b4d... |
| recipe.review_item_view | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.review_list_view | RECORDS | 2 | 2 | yes | a3454542a42fd419... |
| recipe.risk_assessment | RECORDS | 3 | 3 | yes | 9ba30dac74f17575... |
| recipe.sandbox_only_block | RECORDS | 2 | 2 | yes | 163c88d7d61b2cf9... |
| recipe.source_addition | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.stub_batch | RECORDS | 4 | 4 | yes | 86d15db6b8aa75a4... |
| recipe.test_package | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.us_disposition_decision | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.blocker_epoch | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.contingency_form | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.contingency_form_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.di_investigation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.di_investigation_closure | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.di_investigation_link | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.disposal_request | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.evidence_export | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.evidence_export_certification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.evidence_export_read | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.evidence_export_subject | RECORDS | 1 | 1 | yes | e7743f73a7847a83... |
| records.form_reconciliation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.incident | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.incident_assessment | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.incident_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.incident_link | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.purge_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.qp_access | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.qp_access_read | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.qp_access_revocation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.qp_package | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.qp_package_issue | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.qp_subject_provider | RECORDS | 1 | 1 | yes | 62b26241a726137f... |
| records.record_type | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.record_type_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.retention_aggregate | RECORDS | 1 | 1 | yes | bab4d5b0932b47c7... |
| records.retention_dependency | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.retention_evaluation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.retention_hold | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.retention_hold_release | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.retention_input | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.retention_rule | RECORDS | 15 | 15 | yes | 62a3c56b8534b726... |
| records.retention_rule_set | RECORDS | 1 | 1 | yes | fdf502dd018a4954... |
| records.retention_schedule | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.tombstone | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.true_copy | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| report.view_registry | RECORDS | 16 | 16 | yes | b095718d08b84247... |
| sandbox.installation | RECORDS | 1 | 1 | yes | 974ecfd867214109... |
| sandbox.look_alike | RECORDS | 3476 | 3476 | yes | f9a1e04fb2589910... |
| sandbox.reserved_identifier_pattern | RECORDS | 4 | 4 | yes | ee9c16157b3292d4... |
| sandbox.training_attempt | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| sandbox.training_step | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.approved_manufacturer | RECORDS | 17 | 17 | yes | d2fa19a7cfcc9781... |
| site.approved_manufacturer_approval | RECORDS | 17 | 17 | yes | 14cbd7152a7c397d... |
| site.approved_manufacturer_withdrawal | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.batch_number_allocation | RECORDS | 4 | 4 | yes | 2fa6f56a668e7bfd... |
| site.batch_number_rule | RECORDS | 3 | 3 | yes | 4c74be3eceb5a08c... |
| site.batch_number_serial_skip | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.batch_number_void | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.capa | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.capa_deviation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.capa_effectiveness_check | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.capa_effectiveness_result | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.capa_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.capa_master_resolver | RECORDS | 1 | 1 | yes | 2fcb31d3037fd062... |
| site.capa_master_version | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.chemical_recovery | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation | RECORDS | 3 | 3 | yes | c7cca27bfcc1bdc7... |
| site.deviation_classification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation_closure_basis | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation_conclusion | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation_conclusion_basis | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation_finding | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation_impact | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation_impact_signoff | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation_link | RECORDS | 3 | 3 | yes | 47c55ea45de1fa1f... |
| site.erp_lot_status | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.erp_master_effect | RECORDS | 23 | 23 | yes | a45287fbbd911ddc... |
| site.erp_material | RECORDS | 20 | 20 | yes | 3c61b61091f9d94d... |
| site.erp_outbound_attempt | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.erp_outbound_delivery | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.erp_outbound_message | RECORDS | 30 | 30 | yes | 942a5e353a232300... |
| site.erp_product | RECORDS | 3 | 3 | yes | 5c7c3313f68a9aa8... |
| site.erp_production_order | RECORDS | 8 | 8 | yes | c121522a2108344f... |
| site.erp_shipment | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.erp_stock_block_delivery | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.erp_stock_block_request | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.evidence_document | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.evidence_document_content | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.export_permission | RECORDS | 6 | 6 | yes | 0e5450e5f0c9b8df... |
| site.export_permission_approval | RECORDS | 6 | 6 | yes | 7207fa7d8cabb0cf... |
| site.export_permission_suspension | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.finished_lot | RECORDS | 2 | 2 | yes | 83dcb4a307974f8c... |
| site.label_store_transaction | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.licence_approval | RECORDS | 1 | 1 | yes | 0bb6ab6fc343f159... |
| site.licence_product | RECORDS | 3 | 3 | yes | c3ad7f1656c4bc02... |
| site.licence_suspension | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lims_sample_result | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_consumption | RECORDS | 7 | 7 | yes | 71691ce1d944df98... |
| site.lot_decision_intent | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_destruction | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_identity_result | RECORDS | 20 | 20 | yes | 20e546b595971aec... |
| site.lot_location_exception | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_location_exception_resolution | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_location_move | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_receipt | RECORDS | 21 | 21 | yes | 2ff71db6a1ca6c7d... |
| site.lot_receipt_examination | RECORDS | 21 | 21 | yes | fd64944d2274d582... |
| site.lot_reservation | RECORDS | 7 | 7 | yes | ef295715deb760de... |
| site.lot_reservation_revocation | RECORDS | 7 | 7 | yes | 83fd780abeb030e9... |
| site.lot_retest | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_retest_signature | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_sample | RECORDS | 1 | 1 | yes | 9f06c3188d31a34d... |
| site.lot_sample_disposal | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_state_entry | RECORDS | 21 | 21 | yes | 11a52b37fea06cec... |
| site.lot_status_command | RECORDS | 21 | 21 | yes | f89c007b20b1476b... |
| site.lot_test_approval | RECORDS | 24 | 24 | yes | a4843139df0e393d... |
| site.lot_test_oos | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_test_result | RECORDS | 24 | 24 | yes | 437527e8e4b1b461... |
| site.manufacturing_licence | RECORDS | 1 | 1 | yes | d75f9aeec5f97069... |
| site.material_lot | RECORDS | 23 | 23 | yes | 1dfab29e845da090... |
| site.pharmacopoeia_edition | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.qc_extra_testing_decision | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.qms_capa_state | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.qms_change_control | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.qms_deviation_status | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.qms_release_fetch | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.reagent_lot | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.reagent_lot_withdrawal | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.returned_goods | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.returned_goods_assessment | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.returned_goods_assessment_signature | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.shelf_life_stability | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.specification | RECORDS | 18 | 18 | yes | 0879f1de2be35bf0... |
| site.specification_approval | RECORDS | 18 | 18 | yes | f3a0ab20d898767c... |
| site.specification_test | RECORDS | 20 | 20 | yes | 17a21532b8d16215... |
| site.subject_resolver | RECORDS | 1 | 1 | yes | 07b000cf41d89601... |
| site.transfer_acceptance | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.transfer_package | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.transfer_package_seal | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.transfer_receipt | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.transfer_refusal | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.transfer_rule_resolution | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.vendor_route | RECORDS | 1 | 1 | yes | 5c5f074cccba2d11... |
| site.vendor_route_disablement | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.vendor_route_enablement | RECORDS | 1 | 1 | yes | 2f510004a44a9982... |
| tab.aql_letter | RECORDS | 16 | 16 | yes | 7aff23ad225277a5... |
| tab.aql_lot_result | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.aql_plan | RECORDS | 320 | 320 | yes | 0cac3c9052be6da4... |
| tab.aql_sample_code | RECORDS | 15 | 15 | yes | 8d9aaf91bcd533de... |
| tab.aql_scheme | RECORDS | 1 | 1 | yes | 9415faaaae7d09db... |
| tab.attribution_method | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.compendial_not_applicable | RECORDS | 1 | 1 | yes | 0d6e177d7b22787d... |
| tab.compendial_rule_set | RECORDS | 13 | 13 | yes | d925a71b0571dfa2... |
| tab.demo_installation | RECORDS | 1 | 1 | yes | daa0d58a66049b0d... |
| tab.designer_justification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.detector_challenge | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.detector_unit | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.device_alarm | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.device_nonce | RECORDS | 459 | 459 | yes | 0ca6ee8eb429f292... |
| tab.device_reading | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.engine_role_map | RECORDS | 8 | 8 | yes | 45d5568098b5dbc1... |
| tab.gateway_api_answer | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.gateway_api_contact | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.gateway_feed_binding | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.gateway_instrument | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.gateway_key | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.gateway_session | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.heartbeat_receipt | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.ingest_challenge | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.instrument_heartbeat | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.interface_loss | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.ipc_overdue_alarm | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.ipc_pass_delegate | RECORDS | 2 | 2 | yes | 1470fe7766b89f51... |
| tab.ipc_rule | RECORDS | 1 | 1 | yes | d247991bdf02c2b2... |
| tab.l3_aggregation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.l3_decommission_task | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.line_isolation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.line_stop | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.line_stop_resolution | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.listener_run | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.listener_tick | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.lot_assay_result | RECORDS | 1 | 1 | yes | 1bdb068898197a76... |
| tab.lot_assay_source | RECORDS | 2 | 2 | yes | c22c796da219da75... |
| tab.manual_weighing_basis | RECORDS | 14 | 14 | yes | fc5a886d1826540f... |
| tab.mbr_test_package_export | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.packaging_batch_data | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.packaging_batch_data_check | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.packaging_specimen | RECORDS | 10 | 10 | yes | 1c2bbf3f2de1319c... |
| tab.packaging_specimen_void | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.post_use_inspection | RECORDS | 2 | 2 | yes | 9a96fb1ea8588e85... |
| tab.post_use_inspection_verify | RECORDS | 2 | 2 | yes | e6a3d5a8ee80a1f9... |
| tab.print_device | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.print_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.print_event_use | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.print_job | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.print_job_ack | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.print_job_void | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.printed_lot_artwork | RECORDS | 4 | 4 | yes | fead14a3708b4a11... |
| tab.process_alarm_ack | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.process_block_type | RECORDS | 10 | 10 | yes | 9c00bf28581e747c... |
| tab.process_device | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.process_device_unit | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.process_reading | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.process_reading_native | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.process_reading_use | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.process_tag | RECORDS | 49 | 49 | yes | 4553c52aa974468b... |
| tab.reading_claim_mark | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.reading_use | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.reconciliation_waiver | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.reference_document | RECORDS | 63 | 63 | yes | d64259d37b24a583... |
| tab.reference_document_retirement | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.rule_set_verification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.rule_set_verification_signature | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.sandbox_lot | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.scale_room_lock | RECORDS | 4 | 4 | yes | 6271ea264c6df3f9... |
| tab.serial_event_upload | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.serial_pool | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.serial_report | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.session_binding | RECORDS | 52 | 52 | yes | 9a81a84f2e41a5a9... |
| tab.setpoint_download | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.setpoint_download_ack | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.setpoint_download_pickup | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.sscc_issue | RECORDS | 2 | 2 | yes | c0c2346a1b50dbfb... |
| tab.step_device | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.test_piece | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.tooling_inspection | RECORDS | 2 | 2 | yes | 8b58fd307bbfb509... |
| tab.tooling_issue | RECORDS | 1 | 1 | yes | 08b7376781f6e658... |
| tab.tooling_return | RECORDS | 1 | 1 | yes | dbe6ce4b539a4c21... |
| tab.tooling_set | RECORDS | 1 | 1 | yes | 1d407bb1c92d3e52... |

### Sequences

| Sequence | Source | Restored | Status |
|---|---|---|---|
| esig.content_change_id_seq | 532 | 532 | MATCH |
| esig.dsc_meaning_setting_id_seq | - | - | MATCH |
| esig.policy_value_id_seq | - | - | MATCH |
| esig.signing_failure_id_seq | - | - | MATCH |
| iam.account_lock_event_id_seq | - | - | MATCH |
| iam.account_status_event_id_seq | 54 | 54 | MATCH |
| iam.authn_attempt_id_seq | 1100 | 1100 | MATCH |
| iam.person_name_event_id_seq | 28 | 28 | MATCH |
| iam.person_status_event_id_seq | 28 | 28 | MATCH |
| iam.policy_value_id_seq | - | - | MATCH |
| iam.session_event_id_seq | 473 | 473 | MATCH |
| kernel.audit_anchor_id_seq | 1 | 1 | MATCH |
| kernel.audit_checkpoint_id_seq | - | - | MATCH |
| kernel.audit_event_id_seq | 7620 | 7620 | MATCH |
| kernel.audit_verification_run_id_seq | - | - | MATCH |
| kernel.ddl_log_id_seq | 10170 | 10170 | MATCH |
| platform.config_version_id_seq | 514 | 514 | MATCH |
| platform.drift_sample_id_seq | - | - | MATCH |
| platform.outbox_attempt_id_seq | - | - | MATCH |
| platform.outbox_id_seq | 137 | 137 | MATCH |
| platform.setting_value_id_seq | - | - | MATCH |
| platform.state_history_id_seq | 137 | 137 | MATCH |
| platform.time_anomaly_id_seq | - | - | MATCH |
| recipe.contract_giver_read_id_seq | - | - | MATCH |
| recipe.exception_register_act_id_seq | 55 | 55 | MATCH |
| recipe.execution_decision_proposal_id_seq | 1 | 1 | MATCH |
| recipe.execution_disposition_proposal_id_seq | 28 | 28 | MATCH |
| recipe.mbr_version_log_id_seq | 30 | 30 | MATCH |
| recipe.test_batch_number_seq | - | - | MATCH |
| records.contingency_form_serial | - | - | MATCH |
| records.di_investigation_investigation_no_seq | - | - | MATCH |
| records.incident_event_id_seq | - | - | MATCH |
| records.incident_incident_no_seq | - | - | MATCH |
| records.retention_evaluation_id_seq | - | - | MATCH |
| records.retention_hold_hold_no_seq | - | - | MATCH |
| records.retention_input_id_seq | - | - | MATCH |
| site.deviation_seq | - | - | MATCH |
| tab.attribution_method_id_seq | - | - | MATCH |
| tab.device_alarm_id_seq | - | - | MATCH |

## 6. Sample records opened with their audit trail

| Table | Record | Record compared | Record matches | Audit events | Audit trail matches |
|---|---|---|---|---|---|
| esig.signature | d48e48ed-179e-405a-80d6-c297f3bb6e75 | yes | yes | 1 | yes |
| platform.config_area | SITE_VALUE | no id column | - | 1 | yes |
| site.material_lot | e3f7e121-af64-4322-82f5-b1902cc5f14c | yes | yes | 1 | yes |
| esig.signature_seal | lot_test_result:8a4f7bee-e8c6-402c-a6b4-fa3e22739dbe | no id column | - | 1 | yes |
| site.specification_approval | 88cbaeda-bd41-453f-8c94-d0495de74f65 | no id column | - | 1 | yes |

### 6a. Records rendered completely from the restored copy (IN-09 clause 3)

| Record | Events | Signatures | Rows | Content SHA-256 (source) | Restored | Same | Complete |
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

### 6b. Signed restore event in the restored copy

| Item | Value |
|---|---|
| Restore event | `a10f390d-e1cf-4342-ad7e-fd47838ca3d7` |
| Recorded by | Demo Administrator (SYSTEM_ADMINISTRATOR) |
| Approved by | Divya Menon (QA_REVIEWER), signature `df3e7175-15ad-4a6b-bbd6-e38e1c8054f2` (RESTORE_APPROVED) |
| Status | APPROVED |
| Anchors compared | MATCH 1 |

### 6c. Batch exported and restored into an isolated environment (DI-02 clause 1)

| Item | Value |
|---|---|
| Record | batch:3a2ebbd8-5398-4bb5-aa94-a550288a1c00 |
| Export | `drill-20261018T045346Z-bbd053-export.json`, 8819318 bytes, export SHA-256 `2a2d5ee66b18af67577266c39d9a8db64a15d59abee02ab6f9c5ad806fd31e57` |
| Isolated environment | a separate process with no environment variables (0 seen) and no database connection |
| Restored there | 941 events, 813 rows; offline verification passed |
| Content SHA-256 source / restored / its PDF | `dc93755e484aafef` / `dc93755e484aafef` / `dc93755e484aafef` |
| Same record | yes |

## 7. Result and findings

**PASS**

No findings.

## 8. Reviewer assessment

| Question | Answer |
|---|---|
| Measured restore time (dump, restore, verification and comparison) | 31048 ms (0.52 min) for 78478359 bytes; RTO proposal for a full restore 8 h, failover 15 min |
| Measured recovery point | the copy holds every transaction committed before the backup snapshot (2026-10-18T04:53:46.945293Z); RPO proposal 0 on node loss, 5 min on site loss (archive_timeout: an installation item) |
| Does the achieved restore time meet the RTO for this database (ha-and-restore.md section 3)? | (reviewer) |
| Were the report hashes checked against `continuity.restore_drill`? | kernel report SHA-256 `7b1c6a7af2093a0016c89308eee77e10b308e98e2d8b9a42769418005a45744b` (reviewer) |
| Deviations or incidents opened | (reviewer) |
| Actions (owner, due date) | (reviewer) |

## 9. Sign-off

| Role | Name | Signature | Date (with time zone) |
|---|---|---|---|
| Performed by (system administrator) | | | |
| Reviewed by (CSV lead or IT quality) | | | |
| Approved by (QA) | | | |

