# Fix agent P-platform

Read 00-fix-brief.md first.

Your findings: F41, F42, F43, F44, F45, F46, F47, F48, F49, F78, plausible F85, F88, and the integration findings F17 and F69 (kernel 0900/0910), plus the kill-results defects of group 'signature-invalidation' about the platform sample record (D1 no-op save vs INV-09, D2 transient hash). Files: packages/kernel/sql/0500-0552, 0900, 0910, packages/kernel/src/time, src/commands, src/state, test/platform, test/integration/wiring.test.ts.
