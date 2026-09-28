# SQL mutation report

| Group | Mutants | Invalid | Equivalent | Detected | Survived | Score | Target |
|---|---|---|---|---|---|---|---|
| audit-trail | 129 | 27 | 1 | 99 | 2 | 98.0 % | 90 % |
| actor-validation | 99 | 41 | 0 | 56 | 2 | 96.6 % | 90 % |
| signing | 342 | 80 | 4 | 247 | 11 | 95.7 % | 90 % |
| signature-invalidation | 48 | 6 | 1 | 41 | 0 | 100.0 % | 90 % |
| segregation-and-grants | 271 | 77 | 0 | 183 | 11 | 94.3 % | 90 % |
| authentication-events | 151 | 42 | 3 | 100 | 6 | 94.3 % | 90 % |
| retention-and-purge | 164 | 44 | 0 | 107 | 13 | 89.2 % | 90 % |
| site-values-and-policies | 160 | 47 | 0 | 110 | 3 | 97.3 % | 90 % |
| protected-numbers | 348 | 90 | 0 | 223 | 35 | 86.4 % | 90 % |

## Surviving mutants

- audit-trail kernel.audit_row_change (packages/kernel/sql/0010_audit_trail.sql:338) LOGICAL: `or` -> `and`
- audit-trail kernel.verify_chain (packages/kernel/sql/0010_audit_trail.sql:464) LOGICAL: `or` -> `and`
- actor-validation kernel.validate_actor_context (packages/kernel/sql/0190_iam_actor_context.sql:91) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = format('EBMR-IAM-118 DI-27: t` -> `null`
- actor-validation kernel.validate_actor_context (packages/kernel/sql/0190_iam_actor_context.sql:93) RELATIONAL: `>` -> `>=`
- signing esig.check_independence (packages/kernel/sql/0230_esig_sign.sql:176) RELATIONAL: `=` -> `<>`
- signing esig.check_witness (packages/kernel/sql/0230_esig_sign.sql:276) BOOLEAN: `true` -> `false`
- signing esig.create_challenge (packages/kernel/sql/0230_esig_sign.sql:381) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = 'EBMR-ESIG-010 the session ow` -> `null`
- signing platform.transition_signature_check (packages/kernel/sql/0910_integration_esig.sql:29) BOOLEAN: `false` -> `true`
- signing platform.transition_signature_check (packages/kernel/sql/0910_integration_esig.sql:38) LOGICAL: `and` -> `or`
- signing platform.transition_signature_check (packages/kernel/sql/0910_integration_esig.sql:38) RELATIONAL: `=` -> `<>`
- signing platform.transition_signature_check (packages/kernel/sql/0910_integration_esig.sql:39) LOGICAL: `and` -> `or`
- signing platform.transition_signature_check (packages/kernel/sql/0910_integration_esig.sql:39) LOGICAL: `and` -> `or`
- signing platform.transition_signature_check (packages/kernel/sql/0910_integration_esig.sql:39) RELATIONAL: `=` -> `<>`
- signing platform.transition_signature_check (packages/kernel/sql/0910_integration_esig.sql:42) LOGICAL: `or` -> `and`
- signing platform.transition_signature_check (packages/kernel/sql/0910_integration_esig.sql:42) RELATIONAL: `<` -> `<=`
- segregation-and-grants iam.check_static_segregation (packages/kernel/sql/0120_iam_roles_grants.sql:321) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = format('EBMR-IAM-030 unknown ` -> `null`
- segregation-and-grants iam.role_permission_guard (packages/kernel/sql/0120_iam_roles_grants.sql:599) LOGICAL: `and` -> `or`
- segregation-and-grants iam.role_permission_guard (packages/kernel/sql/0120_iam_roles_grants.sql:599) LOGICAL: `and` -> `or`
- segregation-and-grants iam.role_permission_guard (packages/kernel/sql/0120_iam_roles_grants.sql:604) RELATIONAL: `>` -> `>=`
- segregation-and-grants iam.role_permission_guard (packages/kernel/sql/0120_iam_roles_grants.sql:604) RELATIONAL: `<>` -> `=`
- segregation-and-grants iam.role_permission_guard (packages/kernel/sql/0120_iam_roles_grants.sql:605) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = 'EBMR-IAM-039 outside a comma` -> `null`
- segregation-and-grants iam.check_role_permission_addition (packages/kernel/sql/0120_iam_roles_grants.sql:455) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = format('EBMR-IAM-030 unknown ` -> `null`
- segregation-and-grants iam.check_role_permission_addition (packages/kernel/sql/0120_iam_roles_grants.sql:457) RELATIONAL: `=` -> `<>`
- segregation-and-grants iam.check_role_permission_addition (packages/kernel/sql/0120_iam_roles_grants.sql:459) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = format('EBMR-IAM-030 unknown ` -> `null`
- segregation-and-grants iam.decide_role_permission (packages/kernel/sql/0120_iam_roles_grants.sql:734) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = 'EBMR-IAM-039 unknown role-pe` -> `null`
- segregation-and-grants iam.decide_role_permission (packages/kernel/sql/0120_iam_roles_grants.sql:741) BOOLEAN: `false` -> `true`
- authentication-events iam.open_session (packages/kernel/sql/0160_iam_authentication_sessions.sql:680) RELATIONAL: `=` -> `<>`
- authentication-events iam.open_session (packages/kernel/sql/0160_iam_authentication_sessions.sql:681) RELATIONAL: `=` -> `<>`
- authentication-events iam.open_session (packages/kernel/sql/0160_iam_authentication_sessions.sql:681) RELATIONAL: `=` -> `<>`
- authentication-events iam.lock_auth_event (packages/kernel/sql/0160_iam_authentication_sessions.sql:562) LOGICAL: `or` -> `and`
- authentication-events iam.lock_auth_event (packages/kernel/sql/0160_iam_authentication_sessions.sql:562) LOGICAL: `or` -> `and`
- authentication-events iam.lock_auth_event (packages/kernel/sql/0160_iam_authentication_sessions.sql:563) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = 'EBMR-IAM-103 the account of ` -> `null`
- retention-and-purge records.approve_purge (packages/kernel/sql/0440_records_blockers_and_purge.sql:305) RELATIONAL: `=` -> `<>`
- retention-and-purge records.approve_purge (packages/kernel/sql/0440_records_blockers_and_purge.sql:333) RELATIONAL: `=` -> `<>`
- retention-and-purge records.approve_purge (packages/kernel/sql/0440_records_blockers_and_purge.sql:334) RELATIONAL: `=` -> `<>`
- retention-and-purge records.approve_purge (packages/kernel/sql/0440_records_blockers_and_purge.sql:335) RELATIONAL: `=` -> `<>`
- retention-and-purge records.approve_purge (packages/kernel/sql/0440_records_blockers_and_purge.sql:335) RELATIONAL: `>=` -> `>`
- retention-and-purge records.approve_purge (packages/kernel/sql/0440_records_blockers_and_purge.sql:338) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = format('EBMR-REC-041 the disp` -> `null`
- retention-and-purge records.purge (packages/kernel/sql/0440_records_blockers_and_purge.sql:478) NOT_REMOVED: `not ` -> ``
- retention-and-purge records.purge (packages/kernel/sql/0440_records_blockers_and_purge.sql:481) RELATIONAL: `=` -> `<>`
- retention-and-purge records.purge (packages/kernel/sql/0440_records_blockers_and_purge.sql:483) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = format('EBMR-REC-038 true cop` -> `null`
- retention-and-purge records.create_retention_schedule (packages/kernel/sql/0420_records_retention.sql:652) RELATIONAL: `=` -> `<>`
- retention-and-purge records.create_retention_schedule (packages/kernel/sql/0420_records_retention.sql:653) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = format('EBMR-REC-020 site zon` -> `null`
- retention-and-purge records.create_retention_schedule (packages/kernel/sql/0420_records_retention.sql:659) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = format('EBMR-REC-020 %s recor` -> `null`
- retention-and-purge records.create_retention_schedule (packages/kernel/sql/0420_records_retention.sql:667) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = format('EBMR-REC-020 %s alrea` -> `null`
- site-values-and-policies market.criteria_cover (packages/kernel/sql/0300_market_rule_model.sql:204) NOT_REMOVED: `not ` -> ``
- site-values-and-policies market.criteria_cover (packages/kernel/sql/0300_market_rule_model.sql:205) NOT_REMOVED: `not ` -> ``
- site-values-and-policies market.criteria_cover (packages/kernel/sql/0300_market_rule_model.sql:205) RELATIONAL: `=` -> `<>`
- protected-numbers continuity.reserve_counter_ceiling (packages/kernel/sql/0600_continuity_core.sql:545) RELATIONAL: `>` -> `>=`
- protected-numbers continuity.after_restore (packages/kernel/sql/0600_continuity_core.sql:1127) LOGICAL: `or` -> `and`
- protected-numbers continuity.after_restore (packages/kernel/sql/0600_continuity_core.sql:1128) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = 'EBMR-CONT-022 the login name` -> `null`
- protected-numbers continuity.after_restore (packages/kernel/sql/0600_continuity_core.sql:1148) RELATIONAL: `=` -> `<>`
- protected-numbers continuity.after_restore (packages/kernel/sql/0600_continuity_core.sql:1148) LOGICAL: `and` -> `or`
- protected-numbers continuity.after_restore (packages/kernel/sql/0600_continuity_core.sql:1148) RELATIONAL: `=` -> `<>`
- protected-numbers continuity.secure_identifiers (packages/kernel/sql/0600_continuity_core.sql:899) LOGICAL: `or` -> `and`
- protected-numbers continuity.secure_identifiers (packages/kernel/sql/0600_continuity_core.sql:900) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = 'EBMR-CONT-026 external high-` -> `null`
- protected-numbers continuity.secure_identifiers (packages/kernel/sql/0600_continuity_core.sql:902) LOGICAL: `or` -> `and`
- protected-numbers continuity.secure_identifiers (packages/kernel/sql/0600_continuity_core.sql:903) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = 'EBMR-CONT-026 the login name` -> `null`
- protected-numbers continuity.secure_identifiers (packages/kernel/sql/0600_continuity_core.sql:905) LOGICAL: `or` -> `and`
- protected-numbers continuity.secure_identifiers (packages/kernel/sql/0600_continuity_core.sql:905) RELATIONAL: `<` -> `<=`
- protected-numbers continuity.secure_identifiers (packages/kernel/sql/0600_continuity_core.sql:906) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = 'EBMR-CONT-026 the margin for` -> `null`
- protected-numbers continuity.secure_identifiers (packages/kernel/sql/0600_continuity_core.sql:917) BOOLEAN: `false` -> `true`
- protected-numbers continuity.prepare_counter_reservation (packages/kernel/sql/0600_continuity_core.sql:490) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = format('EBMR-CONT-010 %s is n` -> `null`
- protected-numbers continuity.counter_scope (packages/kernel/sql/0600_continuity_core.sql:469) RELATIONAL: `=` -> `<>`
- protected-numbers continuity.compare_external_anchors (packages/kernel/sql/0600_continuity_core.sql:777) LOGICAL: `or` -> `and`
- protected-numbers continuity.compare_external_anchors (packages/kernel/sql/0600_continuity_core.sql:778) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = 'EBMR-CONT-002 external ancho` -> `null`
- protected-numbers continuity.compare_external_anchors (packages/kernel/sql/0600_continuity_core.sql:783) BOOLEAN: `false` -> `true`
- protected-numbers continuity.compare_external_anchors (packages/kernel/sql/0600_continuity_core.sql:791) NOT_REMOVED: `not ` -> ``
- protected-numbers continuity.compare_external_anchors (packages/kernel/sql/0600_continuity_core.sql:795) BOOLEAN: `false` -> `true`
- protected-numbers continuity.compare_external_anchors (packages/kernel/sql/0600_continuity_core.sql:798) BOOLEAN: `false` -> `true`
- protected-numbers continuity.compare_external_anchors (packages/kernel/sql/0600_continuity_core.sql:798) BOOLEAN: `false` -> `true`
- protected-numbers continuity.compare_external_anchors (packages/kernel/sql/0600_continuity_core.sql:803) BOOLEAN: `false` -> `true`
- protected-numbers continuity.compare_external_anchors (packages/kernel/sql/0600_continuity_core.sql:804) RELATIONAL: `>` -> `>=`
- protected-numbers continuity.compare_external_anchors (packages/kernel/sql/0600_continuity_core.sql:805) BOOLEAN: `false` -> `true`
- protected-numbers continuity.compare_external_anchors (packages/kernel/sql/0600_continuity_core.sql:809) RELATIONAL: `>` -> `>=`
- protected-numbers continuity.verify_external_anchors (packages/kernel/sql/0600_continuity_core.sql:1219) LOGICAL: `or` -> `and`
- protected-numbers continuity.verify_external_anchors (packages/kernel/sql/0600_continuity_core.sql:1220) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = 'EBMR-CONT-002 external ancho` -> `null`
- protected-numbers continuity.verify_external_anchors (packages/kernel/sql/0600_continuity_core.sql:1232) LOGICAL: `and` -> `or`
- protected-numbers continuity.verify_external_anchors (packages/kernel/sql/0600_continuity_core.sql:1233) LOGICAL: `and` -> `or`
- protected-numbers continuity.verify_external_anchors (packages/kernel/sql/0600_continuity_core.sql:1236) BOOLEAN: `false` -> `true`
- protected-numbers continuity.verify_external_anchors (packages/kernel/sql/0600_continuity_core.sql:1240) RELATIONAL: `=` -> `<>`
- protected-numbers continuity.verify_external_anchors (packages/kernel/sql/0600_continuity_core.sql:1243) LOGICAL: `and` -> `or`
- protected-numbers continuity.verify_external_anchors (packages/kernel/sql/0600_continuity_core.sql:1243) RELATIONAL: `<` -> `<=`
