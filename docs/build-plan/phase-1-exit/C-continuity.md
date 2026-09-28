# Fix agent C-continuity

Read 00-fix-brief.md first.

Your findings: F55, F56, F57, F58, F59, F71, F72 (kernel 0710 platform authority adapter: denied checks must store an evaluation), plausible F61, F62, F66, F64, F65, the critic finding on continuity external anchors after a lawful purge, and the kill-results defect of group 'protected-numbers' (after_restore partial setval on refusal). Files: packages/kernel/sql/0600-0620, 0700-0720, packages/site-services/sql, packages/kernel/src/continuity, ops/, test/continuity, packages/site-services/test, test/integration/authorization.test.ts.
