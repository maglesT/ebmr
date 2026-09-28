# Fix agent E-esig

Read 00-fix-brief.md first.

Your findings: F13, F14, F15, F16, F73, plausible F18, critic finding on esig.record_signing_failure, and the kill-results defects of groups 'signing' (esig.check_witness fails open with a NULL act room or an unknown act device; iam.assert_validated_actor stale context: coordinate with the audit agent's context fix: do not change 0010) and 'signature-invalidation'. F68/F74/F12 are fixed by the audit agent in the kernel; after that fix, confirm esig.sign's context switching still works and the F68/F74 reproducers pass. Files: packages/kernel/sql/0200-0250, packages/kernel/src/esig, test/esig.
