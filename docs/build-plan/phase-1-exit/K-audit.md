# Fix agent K-audit

Read 00-fix-brief.md first.

Your findings: F1, F68, F74 and F12 (one root cause: every context marked in a transaction stays valid; fix in kernel.set_actor_context/actor_context_validated so only the current context is valid, and make every module restore context through kernel.set_actor_context, never set_config: iam.authn_change_secret 0160 and iam.bootstrap_installation 0180 restore with set_config today - you may edit those two restore lines), F2, F3, F4, F5, F6, F77, plausible F7, F8, critic findings on kernel.audit_row_change (session TimeZone) and verifyAllChains/DI-23 alarm half, kill-results audit-trail defect (test-support drop race: packages/kernel/test/support/db.ts). Files: packages/kernel/sql/0001, 0010, packages/kernel/src/audit, src/db, test/support, test/audit, test/security, the 0160/0180 restore lines named above.
