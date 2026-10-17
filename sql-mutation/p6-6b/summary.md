# SQL mutation report

| Group | Baseline (s) | Limit (s) | Mutants | Invalid | Equivalent | Detected | Survived | Score | Target |
|---|---|---|---|---|---|---|---|---|---|
| mbr-lifecycle | db 48, server 19 | db 240, server 240 | 6 | 0 | 0 | 6 | 0 | 100.0 % | 90 % |
| execution-commands | server 46, db 27 | server 240, db 240 | 130 | 0 | 1 | 91 | 38 | 70.5 % | 90 % |
| read-authorisation | server 25 | server 240 | 11 | 0 | 0 | 10 | 1 | 90.9 % | 90 % |
| connection-roles | db 17 | db 240 | 115 | 0 | 0 | 107 | 8 | 93.0 % | 90 % |
| plant-equipment-and-areas | db 37 | db 240 | 13 | 0 | 1 | 12 | 0 | 100.0 % | 90 % |
| lots-and-lims | db 50, server 37 | db 240, server 240 | 3 | 0 | 0 | 3 | 0 | 100.0 % | 90 % |
| release-gate | db 74, server 12 | db 240, server 240 | 14 | 0 | 0 | 10 | 4 | 71.4 % | 90 % |
| tablets-release-items | server 15 | server 240 | 2 | 0 | 0 | 2 | 0 | 100.0 % | 90 % |
| after-release-suspension | db 82, server 9 | db 245, server 240 | 33 | 0 | 1 | 30 | 2 | 93.8 % | 90 % |
| pqr-extract | db 30 | db 240 | 5 | 0 | 0 | 5 | 0 | 100.0 % | 90 % |

## Surviving mutants

- execution-commands recipe.require_command_permission (packages/recipe-core/sql/0210_execution_writers.sql:52) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = format('%s is not available o` -> `null`
- execution-commands recipe.require_command_permission (packages/recipe-core/sql/0210_execution_writers.sql:56) RELATIONAL: `=` -> `<>`
- execution-commands recipe.require_command_permission (packages/recipe-core/sql/0210_execution_writers.sql:59) RELATIONAL: `=` -> `<>`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:521) LOGICAL: `or` -> `and`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:522) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = 'The role evidence of the com` -> `null`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:525) LOGICAL: `or` -> `and`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:526) LOGICAL: `or` -> `and`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:526) LOGICAL: `or` -> `and`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:527) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = 'The role evidence of the com` -> `null`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:529) NOT_REMOVED: `not ` -> ``
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:529) RELATIONAL: `=` -> `<>`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:529) LOGICAL: `and` -> `or`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:529) RELATIONAL: `=` -> `<>`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:530) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = format('Engine role %s cannot` -> `null`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:539) NOT_REMOVED: `not ` -> ``
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:540) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = format('Engine role %s is not` -> `null`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:544) NOT_REMOVED: `not ` -> ``
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:545) RELATIONAL: `=` -> `<>`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:545) LOGICAL: `and` -> `or`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:545) RELATIONAL: `=` -> `<>`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:545) LOGICAL: `and` -> `or`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:545) RELATIONAL: `=` -> `<>`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:546) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = format('The declared role %s ` -> `null`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:550) RELATIONAL: `=` -> `<>`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:550) LOGICAL: `or` -> `and`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:551) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = format('The role evidence nam` -> `null`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:550) RELATIONAL: `=` -> `<>`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:557) RELATIONAL: `=` -> `<>`
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:557) NOT_REMOVED: `not ` -> ``
- execution-commands recipe.check_engine_roles (packages/recipe-core/sql/0270_execution_guards.sql:558) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = format('The command claims en` -> `null`
- execution-commands recipe.role_evaluation_problem (packages/recipe-core/sql/0270_execution_guards.sql:229) LOGICAL: `or` -> `and`
- execution-commands recipe.role_evaluation_problem (packages/recipe-core/sql/0270_execution_guards.sql:229) RELATIONAL: `<` -> `<=`
- execution-commands recipe.role_evaluation_problem (packages/recipe-core/sql/0270_execution_guards.sql:229) LOGICAL: `or` -> `and`
- execution-commands recipe.role_evaluation_problem (packages/recipe-core/sql/0270_execution_guards.sql:232) LOGICAL: `or` -> `and`
- execution-commands recipe.role_evaluation_problem (packages/recipe-core/sql/0270_execution_guards.sql:232) LOGICAL: `or` -> `and`
- execution-commands recipe.role_evaluation_problem (packages/recipe-core/sql/1100_batch_product_in_step_authority.sql:161) LOGICAL: `or` -> `and`
- execution-commands recipe.role_evaluation_problem (packages/recipe-core/sql/1100_batch_product_in_step_authority.sql:170) RELATIONAL: `>` -> `>=`
- execution-commands recipe.with_batch_scope (packages/recipe-core/sql/1100_batch_product_in_step_authority.sql:48) LOGICAL: `and` -> `or`
- read-authorisation tab.record_read_problem (apps/tablets-server/sql/1290_controlled_read.sql:30) NOT_REMOVED: `not ` -> ``
- connection-roles sandbox.apply_connect_policy (packages/kernel/sql/1210_reporting_role.sql:122) BOOLEAN: `false` -> `true`
- connection-roles sandbox.segregation_problems (packages/kernel/sql/1210_reporting_role.sql:218) RELATIONAL: `=` -> `<>`
- connection-roles sandbox.segregation_problems (packages/kernel/sql/1210_reporting_role.sql:222) LOGICAL: `or` -> `and`
- connection-roles sandbox.segregation_problems (packages/kernel/sql/1210_reporting_role.sql:222) LOGICAL: `or` -> `and`
- connection-roles sandbox.segregation_problems (packages/kernel/sql/1210_reporting_role.sql:222) LOGICAL: `or` -> `and`
- connection-roles sandbox.segregation_problems (packages/kernel/sql/1210_reporting_role.sql:222) LOGICAL: `or` -> `and`
- connection-roles sandbox.segregation_problems (packages/kernel/sql/1210_reporting_role.sql:222) LOGICAL: `or` -> `and`
- connection-roles sandbox.segregation_problems (packages/kernel/sql/1210_reporting_role.sql:228) LOGICAL: `or` -> `and`
- release-gate recipe.grel_evaluate (packages/recipe-core/sql/0951_qms_status_at_release.sql:62) RELATIONAL: `=` -> `<>`
- release-gate recipe.grel_evaluate (packages/recipe-core/sql/0951_qms_status_at_release.sql:62) LOGICAL: `and` -> `or`
- release-gate recipe.grel_evaluate (packages/recipe-core/sql/0951_qms_status_at_release.sql:62) RELATIONAL: `=` -> `<>`
- release-gate recipe.grel_evaluate (packages/recipe-core/sql/0951_qms_status_at_release.sql:66) RELATIONAL: `=` -> `<>`
- after-release-suspension recipe.genealogy_downstream_lots (packages/recipe-core/sql/1011_genealogy_recovery_and_dosage_form.sql:29) LOGICAL: `and` -> `or`
- after-release-suspension recipe.genealogy_downstream_lots (packages/recipe-core/sql/1011_genealogy_recovery_and_dosage_form.sql:29) RELATIONAL: `=` -> `<>`
