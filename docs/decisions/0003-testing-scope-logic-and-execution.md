# Decision record 0003: Testing scope is logic and execution; deployment is a separate system design

- **Date:** 28 September 2026
- **Decided by:** project owner (maglesT)
- **Decision:** "whatever testing you will do for the software should be based on testing its logic and execution in
  terms of the working; don't worry about load testing, as for actual deployment it will be a separate system design."

## What this means

| In scope (continues) | Out of scope for this build (moves to the separate deployment design) |
|---|---|
| Unit, property-based, model-based and golden-batch tests of the logic | Load, soak and performance testing (outline 9.1 load tests; Phase 7 "load and soak tests including release under concurrent ingestion") |
| Database enforcement and bypass tests (privileges, triggers, invariants) | Production topology, high availability, failover, capacity and sizing |
| Concurrency tests of correctness (two commands at once must not break a rule: locks, single use, idempotency) | Performance targets and benchmarks beyond what a correctness test needs |
| Mutation testing (do the tests really detect wrong logic?) | Penetration testing and hardening of deployed infrastructure (network, OS, TLS termination, WORM storage products) |
| End-to-end execution tests through the screens (Playwright) of what the software does | Deployment runbooks as operational procedures |
| Restore and number-protection logic (DI-45, INV-27) as tested software behaviour | Backup schedule, RPO/RTO and storage product choices (open questions C1-C4 become inputs to the deployment design) |

## Consequences

- Correctness under concurrency stays in scope: it is logic (for example a release racing a change must be refused), not
  load.
- The Phase 1 documents docs/operations/ha-and-restore.md and docs/security/asvs-l2-review.md remain as design input
  for the deployment project; the software keeps the hooks they need (TLS configuration checks, restore events, drill
  tooling) but no further deployment work is planned here.
- Phase 7 becomes: generated validation pack (URS, risk, specifications, trace matrix, test evidence), accessibility,
  user and admin guides, and a release candidate; load/soak and penetration testing are removed from it.
