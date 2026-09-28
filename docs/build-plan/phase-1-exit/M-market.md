# Fix agent M-market

Read 00-fix-brief.md first.

Your findings: F20 (critical: ALL_APPLY strictness must compare criterion content, not ids), F21, F22, F23, F24, F25, F26, F27, F76, F80. For the approval UUIDs (F24/F76): require real e-signatures through esig.assert_signature with the signer being the approving person (as records and continuity approvals already do via kernel 0720), adding content providers and meaning types in a new market-owned section if needed; coordinate names in your final message. Files: packages/kernel/sql/0300-0350, packages/kernel/src/market, compliance/rule-tables (only if a seed row is wrong), test/market.
