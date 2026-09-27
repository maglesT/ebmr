# ADR-0007: Hash-chained audit trail with checkpoints, anchors and restore events

- **Status:** Accepted (2026-09-27)
- **Deciders:** project owner (maglesT), accepting build outline v0.2 (decision record 0001)
- **Supersedes:** none

## Context

- The audit trail must capture creation, change and invalidation of GMP data with who, what, when, why and how; it must be always on, not editable and impossible to switch off (DI-22, DI-23).
- Privileges alone cannot stop a database superuser. Tampering by a privileged person must at least be detectable, and the detection must hold for the whole retention period.
- A point-in-time restore legitimately discards committed history. Without a defined record of that, every restore would look like tampering, or verification would have to be relaxed.
- Records are kept for 15 years or more. Volume at 100 batches a day is about 7 x 10^8 data points a year plus a similar volume of audit events, so closed records must move to verified archives and eventually be purged, while the remaining chains still verify.
- Write cost must stay small: the benchmark shows about 0.6 ms added per audited write (ADR-0002).

## Decision

1. **Capture in the database.** Row-level triggers on every GMP table write field-level audit entries in the same transaction. The application sets the actor context with `SET LOCAL` (person, account, role, session, device, authentication event, reason, correlation ID, source); a missing context fails the transaction. A reason is mandatory for every change or void after first entry. Insert-only tables are audited by reference to the row hash instead of a copy. The domain layer adds a plain-language business entry with the same correlation ID.
2. **Always on.** No setting disables, pauses, filters, edits or purges the trail. A start-up check and an hourly check confirm that every GMP table's trigger is enabled; otherwise GMP writes are refused and an alarm raised. An event trigger records DDL, including trigger disabling; pgaudit forwards to a hash-chained, write-once sink that administrators cannot write.
3. **Per-aggregate hash chains** (batch, MBR version, lot, equipment, room, person, configuration area). Each chain head holds a gapless sequence and the last hash; each entry's hash is SHA-256 over the previous hash and the entry's canonical form.
4. **Anchors.** Every few minutes a job builds a Merkle root over the chain heads changed since the last anchor and writes it to write-once storage, optionally with an RFC 3161 time-stamp.
5. **Checkpoints.** At record closure a sealed chain checkpoint (head hash and count) is written. Verification runs nightly over everything changed since the last checkpoint, plus a rolling full verification over a configurable number of weeks. Each run writes a signed verification record; a mismatch opens a data-integrity incident.
6. **Restore events.** A point-in-time restore needs two-person approval and writes a signed, externally anchored restore event naming the discarded anchor range. The verifier accepts a chain that ends at the restore point only when such an event covers the gap. A lost-window incident listing the batches active in the window is created automatically, with re-entry through the late-entry or paper path. Batch, form and per-batch counters resume above the highest value found in anchors, issued contingency packs and ERP acknowledgements.
7. **Archival and purge.** Closed records are exported as verified true-copy packages (canonical PDF/A-3 rendering plus JSON, signatures, audit trail and manifest) to write-once storage with periodic fixity and readability checks. Purging after retain-until is done only by an approved retention job through a SECURITY DEFINER function that leaves a tombstone and the checkpoint, so the remaining chains still verify.
8. **Partitioning:** audit data is partitioned by record-closure period, so closed periods archive as a unit.

## Consequences

### Positive

- Prevention by privileges (ADR-0012) and detection by chains, anchors and the external pgaudit log: a superuser who rewrites rows cannot make the recomputed chains match the anchored roots.
- A restore is distinguishable from tampering, and it can never silently reuse a batch, form or signature number.
- Archival and purge keep verification intact for the records that remain.
- Archived records can be read and verified without the application (verifier CLI).

### Negative

- The window since the last anchor (minutes) is covered only by the near-real-time pgaudit stream.
- Writers to one aggregate serialise on its chain head (worst case about 1,450 commits/s for one batch, far above human or instrument entry rates).
- Write-once storage, KMS/HSM and time-stamping infrastructure are needed; the demo uses an append-only directory labelled demo-only.
- The canonical form and hash functions must stay reproducible for decades; changing them needs a versioned verifier.
- Verification and fixity jobs are an ongoing operational cost that must be monitored.

## Alternatives considered

- **Application-level audit logging.** Rejected: any code path or direct SQL that skips it leaves no trace.
- **Change data capture to an external audit store.** Rejected: asynchronous, with a loss window, and not in the same transaction as the change.
- **One global chain.** Rejected: a write hot spot, and one break obscures every later entry.
- **Ledger database product.** Rejected: a second platform with lifecycle risk (ADR-0002).
- **No restore event.** Rejected: every restore would either raise false tampering alarms or require verification to be switched off.

## Related controls and invariants

- Controls: DI-22 (capture scope and content), DI-23 (always on, immutable, tamper-evident), DI-24 (corrections preserve the original), DI-25 (audit-trail review with high-water mark), DI-12 and DI-50 (incidents and investigations), DI-44 (integrity checking), DI-45 (backup and restore), DI-46 (archiving), DI-47 (retention and controlled disposal), PR-59 (retention and archiving).
- Invariants: INV-06, INV-07, INV-08, INV-22, INV-27, INV-48.

## References

- Build outline v0.2: sections 4.2 (High availability and restore), 4.4 (Privileges, Volume and partitioning), 4.7 (Audit of administrators), 5.3, 5.4, 11 Phase 1.
- Architecture research: 5.1 (including the feasibility probe), 5.7, 5.8.
