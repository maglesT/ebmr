# Fix agent I-identity

Read 00-fix-brief.md first.

Your findings: F11, F70, F79, F81, and the kill-results defects of group 'segregation-and-grants' (HIGH role_permission_guard race lets a role mix administration and GMP permissions: lock per role, check in check_static_segregation, add a directory_scan finding; LOW stale check instant) and of group 'actor-validation' (open_session races with device block and with lockout). Files: packages/kernel/sql/0100-0190 (except the two restore lines in 0160/0180 owned by the audit agent), packages/kernel/src/identity, test/identity.
