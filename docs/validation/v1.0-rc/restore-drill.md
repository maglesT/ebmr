# Restore drill record drill-20261019T080825Z-6f6850: PASS

Commit `4381fd1fd8332763031cd690af9177a32b38afc4`, host `c52a61c4aa9d`. Inputs: source `postgres://ebmr_dev@localhost:5441/ebmr_drillrc_e2e_7f01`.

Filled from `docs/operations/restore-drill-report-template.md` by `tools/drills` (sections 1 to 7 and the measurements); the reviewer completes sections 8 and 9.

## 1. Drill

| Item | Value |
|---|---|
| Drill id | `drill-20261019T080825Z-6f6850` |
| Purpose | validation (IQ/OQ) of the release candidate (Phase 7 exit, pod) |
| Started and finished | 2026-10-19T08:08:25.322421Z to 2026-10-19T08:08:41.850454Z (database clock, UTC) |
| Duration | 16545 ms (kernel drill); 48786 ms with rendering, restore event and export |
| Source database and server version | ebmr_drillrc_e2e_7f01, PostgreSQL PostgreSQL 16.15 (Ubuntu 16.15-1.pgdg22.04+2) on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 11.4.0-1ubuntu1~22.04.3) 11.4.0, 64-bit, 79166487 bytes |
| Change or validation record | (reviewer) |
| External anchor exported before the backup | anchor 2 (to the installation's ledger, as its anchor job does) |

## 2. Backup used

| Item | Value |
|---|---|
| Backup id | ebmr_drillrc_e2e_7f01-20261019T080825Z-f106c5 |
| Format | PG_DUMP_CUSTOM |
| Encrypted at rest | true |
| Artefact SHA-256 | 8ee6b1c658cd4a5989a3cfbed0c3f3e807ce214507afd0681a0426ed3b2ab1c8 |
| Size (bytes) | 12862233 |
| Fixity verified | true |
| Tool | pg_dump (PostgreSQL) 16.15 (Ubuntu 16.15-1.pgdg22.04+2) |

## 3. Restore

| Item | Value |
|---|---|
| Restored database | ebmr_drillrc_e2e_7f01_rst_7e2e742a |
| Isolated (no PUBLIC connect) | true |
| Dropped after the drill | true |
| Tool | pg_restore (PostgreSQL) 16.15 (Ubuntu 16.15-1.pgdg22.04+2) |

## 4. Audit-trail verification

| Side | Chains | Anchors | Chain problems | Anchor problems |
|---|---|---|---|---|
| source | 2548 | 2 | 0 | 0 |
| restored | 2548 | 2 | 0 | 0 |

## 5. Content comparison by category

| Category | Tables | Matching | Rows (source) |
|---|---|---|---|
| RECORDS | 583 | 583 | 66717 |
| AUDIT_TRAIL | 7 | 7 | 21240 |
| SIGNATURES | 22 | 22 | 2016 |
| SYSTEM | 1 | 1 | 608 |

### Tables

| Table | Category | Rows source | Rows restored | Match | SHA-256 (source) |
|---|---|---|---|---|---|
| analytics.flag | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| analytics.flag_disposition | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| analytics.input_registry | RECORDS | 14 | 14 | yes | 5d7ec2aadababa63... |
| analytics.method_version | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| analytics.output | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| analytics.reference_set | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| analytics.run | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| analytics.run_end | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.alarm | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.alarm_acknowledgement | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.backup_catalogue | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.backup_download | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.backup_job_run | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.backup_request | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.ceiling_reservation | RECORDS | 3 | 3 | yes | 19fa1048b412d60c... |
| continuity.counter | RECORDS | 3 | 3 | yes | 67cec21ab3e84dbf... |
| continuity.database_incarnation | RECORDS | 1 | 1 | yes | f505001717dde3fb... |
| continuity.device_hardening_attestation | RECORDS | 7 | 7 | yes | f6c89fa7aa2c96c0... |
| continuity.device_hardening_revocation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.drill_request | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.hardening_check | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.protected_sequence | RECORDS | 42 | 42 | yes | 29154cb17ed6592c... |
| continuity.restore_completion | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.restore_drill | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.restore_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.restore_event_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.sequence_bump | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| continuity.upgrade_drill | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| drill_snapshot.chain_head_before | RECORDS | 2527 | 2527 | yes | 1dda2e61f4f5cd7c... |
| drill_snapshot.row_hash | RECORDS | 43628 | 43628 | yes | 3f2d64073bc9d2c3... |
| drill_snapshot.table_columns | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.challenge | SIGNATURES | 299 | 299 | yes | 86eb87f193e34321... |
| esig.content_change | SIGNATURES | 532 | 532 | yes | ef6ae50961898f5c... |
| esig.content_provider | SIGNATURES | 76 | 76 | yes | 42545559a9f10cc0... |
| esig.dsc_enrolment | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.dsc_enrolment_end | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.dsc_meaning_setting | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.dsc_signature | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.dsc_trust_anchor | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.dsc_trust_anchor_retirement | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.meaning_type | SIGNATURES | 120 | 120 | yes | 038575e76d1b0668... |
| esig.policy_key | SIGNATURES | 5 | 5 | yes | 6959d6e91412d2ff... |
| esig.policy_value | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.predicate_signature_point | SIGNATURES | 31 | 31 | yes | d8ef539b0501e47c... |
| esig.seal_key | SIGNATURES | 1 | 1 | yes | c6acdd1871669f19... |
| esig.seal_key_retirement | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.signature | SIGNATURES | 299 | 299 | yes | 019a900ab03acb32... |
| esig.signature_id_register | SIGNATURES | 299 | 299 | yes | 0163c78643a81f75... |
| esig.signature_invalidation | SIGNATURES | 21 | 21 | yes | 7da8cd6824ab7b8e... |
| esig.signature_seal | SIGNATURES | 299 | 299 | yes | 4f0d0e41e69a6fc6... |
| esig.signed_table | SIGNATURES | 34 | 34 | yes | 21c31faf58784318... |
| esig.signing_failure | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| esig.stub_signable | SIGNATURES | 0 | 0 | yes | e3b0c44298fc1c14... |
| formulary.formula | RECORDS | 1 | 1 | yes | 9a663422e490785b... |
| formulary.formula_approval | RECORDS | 1 | 1 | yes | 716208b4e6b10bbd... |
| formulary.formula_line | RECORDS | 9 | 9 | yes | 04f5b1dfe077fa79... |
| formulary.formula_version | RECORDS | 1 | 1 | yes | 115cb8bafb58e932... |
| formulary.mbr_formula_pin | RECORDS | 1 | 1 | yes | 8d7180b2ef1620fa... |
| iam.access_recertification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.account | RECORDS | 27 | 27 | yes | 3feee3376983573f... |
| iam.account_lock_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.account_status_event | RECORDS | 54 | 54 | yes | d7388a731928cb0c... |
| iam.auth_event | RECORDS | 1100 | 1100 | yes | a8b3d06e488d9b54... |
| iam.auth_event_use | RECORDS | 1276 | 1276 | yes | 8b6861deef37fb37... |
| iam.authn_attempt | RECORDS | 1100 | 1100 | yes | ad48d63ae24fee03... |
| iam.authority_evaluation | RECORDS | 2150 | 2150 | yes | 8f3aa72c9a0365bf... |
| iam.badge | RECORDS | 5 | 5 | yes | 23551c6b2fbc21c5... |
| iam.badge_secret | RECORDS | 5 | 5 | yes | e5c26cace833b049... |
| iam.badge_technology | RECORDS | 6 | 6 | yes | aef8c80b64f7db55... |
| iam.badge_test | RECORDS | 5 | 5 | yes | d97f60ab823f9755... |
| iam.break_glass_window | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.command_log | RECORDS | 1432 | 1432 | yes | 9be3218c1d3026f6... |
| iam.credential | RECORDS | 61 | 61 | yes | aa5550bb3c0c419c... |
| iam.credential_secret | RECORDS | 61 | 61 | yes | f363541d43e166e0... |
| iam.delegation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.device | RECORDS | 33 | 33 | yes | 8a925474eca35b17... |
| iam.esig_acknowledgement | RECORDS | 22 | 22 | yes | 278434da477b0b76... |
| iam.esig_policy | RECORDS | 1 | 1 | yes | b6414990339b3833... |
| iam.identity_verification | RECORDS | 24 | 24 | yes | afe546f77fef76b8... |
| iam.installation_secret | RECORDS | 1 | 1 | yes | 75731e2512a52350... |
| iam.installation_site | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.integration_adapter | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.issued_identifier | RECORDS | 27 | 27 | yes | 87d03f6bc1bd9974... |
| iam.mirror_heartbeat | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.permission | RECORDS | 162 | 162 | yes | cdf94c490bf9ea0f... |
| iam.person | RECORDS | 28 | 28 | yes | 56235f550ee2359c... |
| iam.person_name_event | RECORDS | 28 | 28 | yes | 9cb2f41f74e78e5c... |
| iam.person_qualification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.person_status_event | RECORDS | 28 | 28 | yes | 3dce3fdaa867b742... |
| iam.policy_key | RECORDS | 22 | 22 | yes | bf697519bbbf0898... |
| iam.policy_value | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.qualification_requirement | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.qualification_source | RECORDS | 2 | 2 | yes | fa30fcb2a16d970b... |
| iam.qualification_type | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.reserved_identifier | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.role | RECORDS | 39 | 39 | yes | e7da21497d037e95... |
| iam.role_grant | RECORDS | 28 | 28 | yes | 8be7e93169147386... |
| iam.role_permission | RECORDS | 348 | 348 | yes | 1da2fa6f4c1733ad... |
| iam.role_permission_request | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.security_alert | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.security_alert_action | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.segregation_evaluation | RECORDS | 247 | 247 | yes | fdad116fa86eaf64... |
| iam.session | RECORDS | 426 | 426 | yes | 6641c34e48f925e7... |
| iam.session_activity | RECORDS | 426 | 426 | yes | f2e4c9e5c444392a... |
| iam.session_event | RECORDS | 473 | 473 | yes | 1b0a7e3bbaa0296e... |
| iam.setup_token | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.support_grant | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.support_grant_activation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.support_grant_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.support_grant_revocation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.support_session | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| iam.us_esig_certification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| kernel.audit_anchor | AUDIT_TRAIL | 2 | 2 | yes | 04f631c2a12da87f... |
| kernel.audit_chain_head | AUDIT_TRAIL | 2548 | 2548 | yes | bfee63d1f9a49237... |
| kernel.audit_checkpoint | AUDIT_TRAIL | 0 | 0 | yes | e3b0c44298fc1c14... |
| kernel.audit_event | AUDIT_TRAIL | 7654 | 7654 | yes | d939a4b6c36fabd3... |
| kernel.audit_verification_run | AUDIT_TRAIL | 0 | 0 | yes | e3b0c44298fc1c14... |
| kernel.audited_table | AUDIT_TRAIL | 514 | 514 | yes | 47bad44142d6e9a8... |
| kernel.command_marker | RECORDS | 11 | 11 | yes | 0a71d42e6dec22ce... |
| kernel.ddl_log | AUDIT_TRAIL | 10522 | 10522 | yes | fb9a560f98d0022c... |
| market.batch_policy_pin | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.change_impact | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.evaluation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.market | RECORDS | 3 | 3 | yes | 1661e72fdd3ef248... |
| market.policy | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.policy_version | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| market.rule_key | RECORDS | 24 | 24 | yes | e8d6ff803b0a3492... |
| market.rule_row | RECORDS | 54 | 54 | yes | 335195b1a2f6108c... |
| market.rule_table | RECORDS | 3 | 3 | yes | b1bbac7c43d08f6c... |
| market.rule_table_version | RECORDS | 2 | 2 | yes | c839114585d5a5a8... |
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
| plant.area | RECORDS | 5 | 5 | yes | 5107a717791233a0... |
| plant.area_adjacency | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.area_dedication | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.area_dedication_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.area_occupancy | RECORDS | 6 | 6 | yes | a54c6a204ca4b545... |
| plant.area_occupancy_end | RECORDS | 6 | 6 | yes | df5c132641552793... |
| plant.area_rule | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.area_spill | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.beta_lactam_class | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.beta_lactam_class_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.calibration | RECORDS | 5 | 5 | yes | 9b916d7623160766... |
| plant.campaign | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.campaign_closure | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.cleaning | RECORDS | 12 | 12 | yes | 635455e46e05bb91... |
| plant.cleaning_abandonment | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.cleaning_completion | RECORDS | 12 | 12 | yes | 6b1ece45cf10af56... |
| plant.cleaning_verification | RECORDS | 12 | 12 | yes | 128e08fb3ea15d5d... |
| plant.clearance | RECORDS | 6 | 6 | yes | 226c77f6118318b4... |
| plant.clearance_verification | RECORDS | 6 | 6 | yes | 10d4d7907487ee61... |
| plant.cmms_calibration_message | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.cmms_work_order | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.container_charge | RECORDS | 3 | 3 | yes | 7425c1798a754623... |
| plant.container_close | RECORDS | 7 | 7 | yes | 5bbebaa6f45864fc... |
| plant.container_close_verification | RECORDS | 7 | 7 | yes | fe7aec7459a4d824... |
| plant.container_hold | RECORDS | 1 | 1 | yes | 04a824762df30da6... |
| plant.container_merge | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.controlled_product | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.controlled_product_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.device_original | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.equipment | RECORDS | 9 | 9 | yes | 0c30324eaf197999... |
| plant.equipment_class | RECORDS | 6 | 6 | yes | 8ae4c9e1958300ed... |
| plant.equipment_event | RECORDS | 9 | 9 | yes | 9ea7b2c63336390f... |
| plant.equipment_repair | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.equipment_repair_verification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.equipment_state_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.equipment_use | RECORDS | 6 | 6 | yes | 85e501ca8f88b2df... |
| plant.equipment_use_end | RECORDS | 6 | 6 | yes | 8bc904126ae96539... |
| plant.facility_rule | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.facility_rule_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.instrument_check | RECORDS | 7 | 7 | yes | 4d7ca11635f2570f... |
| plant.instrument_use | RECORDS | 7 | 7 | yes | 5ce602e9a80aa3b0... |
| plant.ipc_check | RECORDS | 31 | 31 | yes | 9887a30a889c00c0... |
| plant.opcua_endpoint | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.opcua_endpoint_session | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.opcua_endpoint_unit | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.output_container | RECORDS | 8 | 8 | yes | 20e3811769655572... |
| plant.press_discharge | RECORDS | 1 | 1 | yes | 14297520a8f11e66... |
| plant.product | RECORDS | 2 | 2 | yes | ffb00380379a5e0f... |
| plant.product_hazard | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.product_hazard_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.reagent_use | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.series | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.series_tag | RECORDS | 51 | 51 | yes | 0649eb42d9ab80c9... |
| plant.step_equipment | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.utility_feed_age | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| plant.utility_reading | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.aggregate_clock | RECORDS | 43 | 43 | yes | b2eb5c95e85bb7cb... |
| platform.aggregate_state | RECORDS | 43 | 43 | yes | 026b23728f531072... |
| platform.alarm | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.alarm_clearance | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.change_record | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.change_record_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.config_area | RECORDS | 18 | 18 | yes | 1fb138b0341d88f4... |
| platform.config_version | RECORDS | 524 | 524 | yes | dac3986b93443775... |
| platform.consumed_message | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.db_time_column | RECORDS | 373 | 373 | yes | 7d1e7ce729424194... |
| platform.drift_sample | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.federation_request | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.hook | RECORDS | 3 | 3 | yes | 40723cdab0761263... |
| platform.idempotency_key | RECORDS | 597 | 597 | yes | 0cd5cc1d1e113e59... |
| platform.inbound_exception | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.inbound_message | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.inbound_override | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.inbound_schema | RECORDS | 23 | 23 | yes | ee02b197042e693e... |
| platform.installation_alarm | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.installation_alarm_ack | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.installation_identity | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.integration_alarm | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.integration_alarm_ack | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.iq_record | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.machine | RECORDS | 6 | 6 | yes | 0fdf3e0160a06dfa... |
| platform.machine_transition | RECORDS | 114 | 114 | yes | 7ec1845e96cc0b8e... |
| platform.machine_version | RECORDS | 8 | 8 | yes | 6aefc1d660c13c38... |
| platform.mirror_data_class | RECORDS | 8 | 8 | yes | f8088f98e43b5e0f... |
| platform.mirror_sync | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.operations_act | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.outbox | RECORDS | 137 | 137 | yes | 36bc44d7e6fcb9ba... |
| platform.outbox_attempt | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.outbox_state | RECORDS | 137 | 137 | yes | 1e64104484b0e8e9... |
| platform.peer_installation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.peer_installation_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.peer_installation_revocation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.reconciliation_report | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.setting_definition | RECORDS | 29 | 29 | yes | 2f07ae35b4454780... |
| platform.setting_value | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.signing_source | RECORDS | 1 | 1 | yes | 16a44c4a414491ef... |
| platform.source_verification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.state_guard | RECORDS | 42 | 42 | yes | b3784099ffe0669a... |
| platform.state_history | RECORDS | 137 | 137 | yes | a7e58af977d5973a... |
| platform.stub_record | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.stub_step | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.stub_step_entry | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.system_interface | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.time_anomaly | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.time_source | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.time_source_registration | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| platform.validation_summary | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| public.schema_migration | SYSTEM | 608 | 608 | yes | dab6d4a01044197c... |
| recipe.abort_checklist | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.after_release_decision | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.amendment_market_task | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.audit_review_scope | RECORDS | 131 | 131 | yes | e054e081b4d8755a... |
| recipe.authorisation_cell | RECORDS | 7 | 7 | yes | 188e04e41fa3bf29... |
| recipe.batch_allocation_link | RECORDS | 4 | 4 | yes | b0bbe34ca95fa48e... |
| recipe.batch_erp_order | RECORDS | 4 | 4 | yes | a68466f18364f713... |
| recipe.batch_execution | RECORDS | 4 | 4 | yes | 4eff93a5cb46b7b5... |
| recipe.batch_licence_basis | RECORDS | 4 | 4 | yes | 8d6f5d7f83070b5c... |
| recipe.batch_mbr_pin | RECORDS | 4 | 4 | yes | 223e6e4d6bb96051... |
| recipe.batch_parent_link | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.batch_review_act | RECORDS | 6 | 6 | yes | dcec8e1070e541ee... |
| recipe.block_data_schema | RECORDS | 203 | 203 | yes | 6af9b6ba039577b3... |
| recipe.block_signature_meaning | RECORDS | 11 | 11 | yes | 118d10bd884786b0... |
| recipe.bright_stock_max_hold | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.bulk_reconciliation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.change_record | RECORDS | 3 | 3 | yes | d80db03076fb7a0b... |
| recipe.change_record_regulatory | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.change_record_validation | RECORDS | 3 | 3 | yes | 2fc613190eb4ca8d... |
| recipe.consumption_entry | RECORDS | 7 | 7 | yes | 923cb519e4f0bd4c... |
| recipe.contract_giver_access | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.contract_giver_access_revocation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.contract_giver_read | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.control_recipe | RECORDS | 4 | 4 | yes | cc766ee16983ab07... |
| recipe.controlled_checkpoint | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.controlled_checkpoint_signature | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.controlled_custody | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.controlled_custody_signature | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.controlled_custody_use | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.controlled_register_extract | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.engine_name | RECORDS | 990 | 990 | yes | 97f62db458899d3b... |
| recipe.engine_role_map | RECORDS | 8 | 8 | yes | 45d5568098b5dbc1... |
| recipe.engine_role_permission | RECORDS | 8 | 8 | yes | 1eaf63e336014d35... |
| recipe.eu_importer | RECORDS | 1 | 1 | yes | b70a220bc68d97b3... |
| recipe.eu_importer_product | RECORDS | 1 | 1 | yes | 602ccb12861c7824... |
| recipe.evidence_epoch | RECORDS | 165 | 165 | yes | e6e5b2d625cbbd82... |
| recipe.exception_register | RECORDS | 28 | 28 | yes | bc6aca6b77c82368... |
| recipe.exception_register_act | RECORDS | 55 | 55 | yes | 40bd5382fd9f124c... |
| recipe.exception_review_category | RECORDS | 11 | 11 | yes | cb188793864c34da... |
| recipe.exception_review_permission | RECORDS | 4 | 4 | yes | e6bbc78e3b58ea0d... |
| recipe.execution_act_proposal | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.execution_clock | RECORDS | 10 | 10 | yes | b4e0fe03a35a5af6... |
| recipe.execution_command | RECORDS | 255 | 255 | yes | 02ee935bfbe73fc9... |
| recipe.execution_command_permission | RECORDS | 25 | 25 | yes | 5911735bfcd05b20... |
| recipe.execution_decision_proposal | RECORDS | 1 | 1 | yes | c03b9c1d689291cf... |
| recipe.execution_disposition_proposal | RECORDS | 28 | 28 | yes | 73b8ffce2b6443ce... |
| recipe.execution_event | RECORDS | 689 | 689 | yes | ad02060c0b809add... |
| recipe.execution_exception_content | RECORDS | 31 | 31 | yes | c050781a49170b93... |
| recipe.execution_point_content | RECORDS | 18 | 18 | yes | 316828a3519f3a82... |
| recipe.execution_signature_meaning | RECORDS | 25 | 25 | yes | bf4551f481a0fd84... |
| recipe.execution_stage_content | RECORDS | 218 | 218 | yes | 92cb2dd4e0cb81e2... |
| recipe.execution_stage_summary_legacy | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.execution_state | RECORDS | 4 | 4 | yes | 0cf21c9f9a1c48e9... |
| recipe.execution_step_content | RECORDS | 145 | 145 | yes | ba82b1f369d74013... |
| recipe.federated_excerpt | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.federated_request_failure | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.federated_request_out | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.free_text_translation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.free_text_translation_verification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.grel_acknowledgement | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.grel_edition_hook | RECORDS | 1 | 1 | yes | ba92eb9ee9b56137... |
| recipe.h2_payload_issue | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.in_flight_disposition | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.label_field_binding | RECORDS | 14 | 14 | yes | c2fbf89c5876cc99... |
| recipe.label_template | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.label_template_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.lot_disposal | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.lot_disposal_witness | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.manufacturer_release_decision | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.market_authorisation | RECORDS | 7 | 7 | yes | da330e6b22612008... |
| recipe.market_authorisation_activation | RECORDS | 7 | 7 | yes | c5d567929be6cf3e... |
| recipe.market_authorisation_withdrawal | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.market_change | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.market_disposition_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.mbr_content | RECORDS | 3 | 3 | yes | 4ddeeec135bd242f... |
| recipe.mbr_draft_entry | RECORDS | 3 | 3 | yes | 8e9a2b789e4617f9... |
| recipe.mbr_evidence | RECORDS | 15 | 15 | yes | 711bf5b2d03da683... |
| recipe.mbr_evidence_void | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.mbr_family | RECORDS | 3 | 3 | yes | 096c333f02c0bbba... |
| recipe.mbr_family_pack | RECORDS | 1 | 1 | yes | 6b10cf4a907cccb4... |
| recipe.mbr_risk_link | RECORDS | 3 | 3 | yes | e34d002d40acf224... |
| recipe.mbr_version | RECORDS | 3 | 3 | yes | d7f7e9f96b910441... |
| recipe.mbr_version_log | RECORDS | 30 | 30 | yes | fcb36a66835acc06... |
| recipe.mock_recall | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.mock_recall_remote | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.mock_recall_signoff | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.notification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.notification_acknowledgement | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.notification_department | RECORDS | 2 | 2 | yes | 8ee9d5af487562f0... |
| recipe.notification_department_role | RECORDS | 6 | 6 | yes | ec6bb4c0853b532c... |
| recipe.open_investigation_justification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.packaging_bulk_issue | RECORDS | 2 | 2 | yes | 855bc84f4d18375d... |
| recipe.packaging_completion_block | RECORDS | 1 | 1 | yes | f06cc718801dce87... |
| recipe.packaging_labelling | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.periodic_review | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.post_change_evaluation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.ppq_outcome | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.pqr_extract | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.pqr_query_version | RECORDS | 2 | 2 | yes | ba6a798857b8f143... |
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
| recipe.review_item_disposition | RECORDS | 24 | 24 | yes | 5ba11aec40c7bd6f... |
| recipe.review_item_view | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.review_list_view | RECORDS | 2 | 2 | yes | 15eb514ebb068d0f... |
| recipe.risk_assessment | RECORDS | 3 | 3 | yes | 8b0eb0a39ee58a6a... |
| recipe.sandbox_only_block | RECORDS | 2 | 2 | yes | 163c88d7d61b2cf9... |
| recipe.source_addition | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.stub_batch | RECORDS | 4 | 4 | yes | 1fe461e0ea123522... |
| recipe.test_package | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| recipe.us_disposition_decision | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.blocker_epoch | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.contingency_form | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.contingency_form_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.di_investigation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.di_investigation_closure | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.di_investigation_link | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.disposal_request | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.evaluation_pack | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.evaluation_pack_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.evidence_export | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.evidence_export_certification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.evidence_export_read | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.evidence_export_subject | RECORDS | 1 | 1 | yes | eeaef9f2b0729a83... |
| records.export_restricted_table | RECORDS | 8 | 8 | yes | 08cf3a9a8d562265... |
| records.form_reconciliation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.full_export | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.full_export_run | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.full_export_scope | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
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
| records.qp_subject_provider | RECORDS | 1 | 1 | yes | 69361f228be69cd9... |
| records.record_type | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.record_type_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.retention_aggregate | RECORDS | 1 | 1 | yes | 8d8748c7eeaa0e90... |
| records.retention_dependency | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.retention_evaluation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.retention_hold | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.retention_hold_release | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.retention_input | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.retention_rule | RECORDS | 15 | 15 | yes | 62a3c56b8534b726... |
| records.retention_rule_set | RECORDS | 1 | 1 | yes | 4f00119f461b66c6... |
| records.retention_schedule | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.tombstone | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| records.true_copy | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| report.closed_record_source | RECORDS | 3 | 3 | yes | 784885ee01e7a599... |
| report.evaluation_source | RECORDS | 14 | 14 | yes | 4a0c1ee016010d0a... |
| report.view_registry | RECORDS | 19 | 19 | yes | 11e1385994303280... |
| sandbox.installation | RECORDS | 1 | 1 | yes | dee2d4ea03225d83... |
| sandbox.look_alike | RECORDS | 3476 | 3476 | yes | f9a1e04fb2589910... |
| sandbox.reserved_identifier_pattern | RECORDS | 4 | 4 | yes | ee9c16157b3292d4... |
| sandbox.training_attempt | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| sandbox.training_step | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.approved_manufacturer | RECORDS | 17 | 17 | yes | 31324fd7e30032ae... |
| site.approved_manufacturer_approval | RECORDS | 17 | 17 | yes | b755e0ad58941498... |
| site.approved_manufacturer_withdrawal | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.batch_number_allocation | RECORDS | 4 | 4 | yes | 9165299e77c86070... |
| site.batch_number_rule | RECORDS | 3 | 3 | yes | 7d382ce6678bd858... |
| site.batch_number_serial_skip | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.batch_number_void | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.capa | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.capa_deviation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.capa_effectiveness_check | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.capa_effectiveness_result | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.capa_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.capa_master_resolver | RECORDS | 1 | 1 | yes | 3c205c8e11402391... |
| site.capa_master_version | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.chemical_recovery | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation | RECORDS | 3 | 3 | yes | 8102bd3be0ea143e... |
| site.deviation_classification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation_closure_basis | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation_conclusion | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation_conclusion_basis | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation_finding | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation_impact | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation_impact_signoff | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.deviation_link | RECORDS | 3 | 3 | yes | 06b6fff452ba49c9... |
| site.erp_lot_status | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.erp_master_effect | RECORDS | 23 | 23 | yes | a1d9418bac80eb32... |
| site.erp_material | RECORDS | 20 | 20 | yes | d013b3508e215801... |
| site.erp_outbound_attempt | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.erp_outbound_delivery | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.erp_outbound_message | RECORDS | 30 | 30 | yes | 5b5970b02747c692... |
| site.erp_product | RECORDS | 3 | 3 | yes | c0c661732d20f930... |
| site.erp_production_order | RECORDS | 8 | 8 | yes | 3e0ac5e7698d6a7a... |
| site.erp_shipment | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.erp_stock_block_delivery | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.erp_stock_block_request | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.evidence_document | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.evidence_document_content | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.export_permission | RECORDS | 6 | 6 | yes | 60cbbaf72396ab90... |
| site.export_permission_approval | RECORDS | 6 | 6 | yes | 5adbbed341fa5d75... |
| site.export_permission_suspension | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.finished_lot | RECORDS | 2 | 2 | yes | a5f843abc3978c31... |
| site.label_store_transaction | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.licence_approval | RECORDS | 1 | 1 | yes | 11c1f2b16d7889dd... |
| site.licence_product | RECORDS | 3 | 3 | yes | 2f3df31ecd3c5f69... |
| site.licence_suspension | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lims_sample_result | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_consumption | RECORDS | 7 | 7 | yes | c9e29eb29ce39bc2... |
| site.lot_decision_intent | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_destruction | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_identity_result | RECORDS | 20 | 20 | yes | 0b6f5b610856fe4f... |
| site.lot_location_exception | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_location_exception_resolution | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_location_move | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_receipt | RECORDS | 21 | 21 | yes | 5314405214a1b27d... |
| site.lot_receipt_examination | RECORDS | 21 | 21 | yes | b367f829f9b615f2... |
| site.lot_reservation | RECORDS | 7 | 7 | yes | cde8f4d5f0b70eab... |
| site.lot_reservation_revocation | RECORDS | 7 | 7 | yes | a90196a96861118b... |
| site.lot_retest | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_retest_signature | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_sample | RECORDS | 1 | 1 | yes | 82ed86965e0eb55a... |
| site.lot_sample_disposal | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_state_entry | RECORDS | 21 | 21 | yes | b19b80dca830a757... |
| site.lot_status_command | RECORDS | 21 | 21 | yes | 2d0800c2a8a6426c... |
| site.lot_test_approval | RECORDS | 24 | 24 | yes | e01d508d41e1b46a... |
| site.lot_test_oos | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.lot_test_result | RECORDS | 24 | 24 | yes | 9c9a5ca9ed126f0c... |
| site.manufacturing_licence | RECORDS | 1 | 1 | yes | e19256335bf8743e... |
| site.material_lot | RECORDS | 23 | 23 | yes | 24adc123419885af... |
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
| site.specification | RECORDS | 18 | 18 | yes | a56833681ce6b69b... |
| site.specification_approval | RECORDS | 18 | 18 | yes | 4b8b17847b616e0b... |
| site.specification_test | RECORDS | 20 | 20 | yes | 7de4bf1478b045bb... |
| site.subject_resolver | RECORDS | 1 | 1 | yes | e2f2b7e2e5405252... |
| site.transfer_acceptance | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.transfer_package | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.transfer_package_seal | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.transfer_receipt | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.transfer_refusal | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.transfer_rule_resolution | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.vendor_route | RECORDS | 1 | 1 | yes | 71c815328b7e3b4f... |
| site.vendor_route_disablement | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| site.vendor_route_enablement | RECORDS | 1 | 1 | yes | a8d76bb58eb8a2c6... |
| tab.aql_letter | RECORDS | 16 | 16 | yes | 7aff23ad225277a5... |
| tab.aql_lot_result | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.aql_plan | RECORDS | 320 | 320 | yes | 0cac3c9052be6da4... |
| tab.aql_sample_code | RECORDS | 15 | 15 | yes | 8d9aaf91bcd533de... |
| tab.aql_scheme | RECORDS | 1 | 1 | yes | f94798d7657a301c... |
| tab.attribution_method | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.compendial_not_applicable | RECORDS | 1 | 1 | yes | 0d6e177d7b22787d... |
| tab.compendial_rule_set | RECORDS | 13 | 13 | yes | d925a71b0571dfa2... |
| tab.demo_act | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.demo_installation | RECORDS | 1 | 1 | yes | 4589130cb8e17ae4... |
| tab.designer_justification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.detector_challenge | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.detector_unit | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.device_alarm | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.device_nonce | RECORDS | 459 | 459 | yes | 74ec077b39f4c76d... |
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
| tab.labelling_specimen_approval | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.line_isolation | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.line_stop | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.line_stop_resolution | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.listener_run | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.listener_tick | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.lot_assay_result | RECORDS | 1 | 1 | yes | 2d010eee3d5658e4... |
| tab.lot_assay_source | RECORDS | 2 | 2 | yes | 4a85aae569eacd96... |
| tab.manual_weighing_basis | RECORDS | 14 | 14 | yes | 226252804b160fb9... |
| tab.mbr_test_package_export | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.packaging_batch_data | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.packaging_batch_data_check | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.packaging_specimen | RECORDS | 10 | 10 | yes | f3d2bc2afd42e9fe... |
| tab.packaging_specimen_void | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.post_use_inspection | RECORDS | 2 | 2 | yes | 56c9bf7cf9a521ee... |
| tab.post_use_inspection_verify | RECORDS | 2 | 2 | yes | b17e1feec3561ff6... |
| tab.print_device | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.print_event | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.print_event_use | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.print_job | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.print_job_ack | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.print_job_void | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.printed_lot_artwork | RECORDS | 4 | 4 | yes | 2675acef665bdbd8... |
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
| tab.reference_document | RECORDS | 63 | 63 | yes | ce0fb3fa7554bb95... |
| tab.reference_document_retirement | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.rule_set_verification | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.rule_set_verification_signature | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.sandbox_lot | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.scale_room_lock | RECORDS | 4 | 4 | yes | 6271ea264c6df3f9... |
| tab.serial_event_upload | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.serial_pool | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.serial_report | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.session_binding | RECORDS | 52 | 52 | yes | dbe6b3ce058cc56b... |
| tab.setpoint_download | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.setpoint_download_ack | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.setpoint_download_pickup | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.sscc_issue | RECORDS | 2 | 2 | yes | cd040e0bc7b42cb4... |
| tab.step_device | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.test_piece | RECORDS | 0 | 0 | yes | e3b0c44298fc1c14... |
| tab.tooling_inspection | RECORDS | 2 | 2 | yes | b6f71eacbed9fef7... |
| tab.tooling_issue | RECORDS | 1 | 1 | yes | f1807ff3e70b2dcd... |
| tab.tooling_return | RECORDS | 1 | 1 | yes | 74f45bc325cf34c6... |
| tab.tooling_set | RECORDS | 1 | 1 | yes | 289cfcec63058061... |

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
| kernel.audit_anchor_id_seq | 2 | 2 | MATCH |
| kernel.audit_checkpoint_id_seq | - | - | MATCH |
| kernel.audit_event_id_seq | 7654 | 7654 | MATCH |
| kernel.audit_verification_run_id_seq | - | - | MATCH |
| kernel.ddl_log_id_seq | 10522 | 10522 | MATCH |
| platform.config_version_id_seq | 524 | 524 | MATCH |
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
| esig.signature | 548a3831-5efa-4d43-8e04-8e2f10097f57 | yes | yes | 1 | yes |
| platform.state_history | 111 | yes | yes | 1 | yes |
| iam.identity_verification | baa33a89-a1ba-4d05-98fa-39bfc9ee4ba8 | yes | yes | 1 | yes |
| platform.state_history | 132 | yes | yes | 1 | yes |
| recipe.engine_name | PR-60 | no id column | - | 1 | yes |

### 6a. Records rendered completely from the restored copy (IN-09 clause 3)

| Record | Events | Signatures | Rows | Content SHA-256 (source) | Restored | Same | Complete |
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

### 6b. Signed restore event in the restored copy

| Item | Value |
|---|---|
| Restore event | `c22e2168-a1d9-4fc7-9921-d06cf333eb48` |
| Recorded by | Demo Administrator (SYSTEM_ADMINISTRATOR) |
| Approved by | Divya Menon (QA_REVIEWER), signature `e1dd0086-4320-4a33-8706-ff9d58b1f800` (RESTORE_APPROVED) |
| Status | APPROVED |
| Anchors compared | MATCH 2 |

### 6c. Batch exported and restored into an isolated environment (DI-02 clause 1)

| Item | Value |
|---|---|
| Record | batch:fe2188c9-0f11-433d-bec4-453006691a9f |
| Export | `drill-20261019T080825Z-6f6850-export.json`, 8815120 bytes, export SHA-256 `50e1850c49ae3b53b653162e040a946520109bf24ed273f745160759e2786713` |
| Isolated environment | a separate process with no environment variables (0 seen) and no database connection |
| Restored there | 941 events, 813 rows; offline verification passed |
| Content SHA-256 source / restored / its PDF | `035aa93123cb682f` / `035aa93123cb682f` / `035aa93123cb682f` |
| Same record | yes |

## 7. Result and findings

**PASS**

No findings.

## 8. Reviewer assessment

| Question | Answer |
|---|---|
| Measured restore time (dump, restore, verification and comparison) | 16546 ms (0.28 min) for 79166487 bytes; RTO proposal for a full restore 8 h, failover 15 min |
| Measured recovery point | the copy holds every transaction committed before the backup snapshot (2026-10-19T08:08:25.322421Z); RPO proposal 0 on node loss, 5 min on site loss (archive_timeout: an installation item) |
| Does the achieved restore time meet the RTO for this database (ha-and-restore.md section 3)? | (reviewer) |
| Were the report hashes checked against `continuity.restore_drill`? | kernel report SHA-256 `d20d8a108398c0015f4383760b7b5c5650fdfbf7d99e1b9fe247b3d548f4a1ee` (reviewer) |
| Deviations or incidents opened | (reviewer) |
| Actions (owner, due date) | (reviewer) |

## 9. Sign-off

| Role | Name | Signature | Date (with time zone) |
|---|---|---|---|
| Performed by (system administrator) | | | |
| Reviewed by (CSV lead or IT quality) | | | |
| Approved by (QA) | | | |

