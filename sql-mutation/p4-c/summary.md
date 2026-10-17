# SQL mutation report

| Group | Baseline (s) | Limit (s) | Mutants | Invalid | Equivalent | Detected | Survived | Score | Target |
|---|---|---|---|---|---|---|---|---|---|
| after-release-suspension | db 89, server 10 | db 266, server 240 | 137 | 0 | 3 | 132 | 2 | 98.5 % | 90 % |
| after-release-decisions | db 60 | db 240 | 198 | 1 | 5 | 187 | 5 | 97.4 % | 90 % |
| shipping-interlock | db 40, server 6 | db 240, server 240 | 89 | 0 | 14 | 75 | 0 | 100.0 % | 90 % |

## Surviving mutants

- after-release-suspension recipe.genealogy_downstream_lots (packages/recipe-core/sql/1011_genealogy_recovery_and_dosage_form.sql:29) LOGICAL: `and` -> `or`
- after-release-suspension recipe.genealogy_downstream_lots (packages/recipe-core/sql/1011_genealogy_recovery_and_dosage_form.sql:29) RELATIONAL: `=` -> `<>`
- after-release-decisions recipe.release_suspension_content (packages/recipe-core/sql/0840_after_release.sql:609) RELATIONAL: `=` -> `<>`
- after-release-decisions recipe.record_after_release_decision (packages/recipe-core/sql/0840_after_release.sql:732) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = 'EBMR-ARL-016 a person involv` -> `null`
- after-release-decisions recipe.record_after_release_decision (packages/recipe-core/sql/0840_after_release.sql:761) LOGICAL: `and` -> `or`
- after-release-decisions recipe.record_after_release_decision (packages/recipe-core/sql/0840_after_release.sql:761) RELATIONAL: `=` -> `<>`
- after-release-decisions recipe.witness_disposal (packages/recipe-core/sql/0840_after_release.sql:957) GUARD_REMOVED: `raise exception using errcode = 'P0001', message = 'EBMR-ARL-043 the witness of ` -> `null`
