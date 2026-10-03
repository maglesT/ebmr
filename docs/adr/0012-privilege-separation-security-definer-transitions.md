# ADR-0012: Privilege separation and SECURITY DEFINER transitions

- **Status:** Accepted (2026-09-27)
- **Deciders:** project owner (maglesT), accepting build outline v0.2 (decision record 0001)
- **Supersedes:** none

## Context

- The rules must hold even if application code has a bug or someone obtains the application's database credentials: nobody may jump a state machine, forge or transplant a signature, sign without a real authentication, or rewrite recorded data.
- Administrators must not be able to alter GMP content, and GMP users must not administer the system (DI-18).
- A database superuser cannot be fully prevented from acting; that residual risk must be detected (ADR-0007) and kept to a two-person, logged break-glass path.
- Each invariant needs an application guard and a database enforcement, and the enforcement must be proven by attacking it (outline 5.3, 9.1).

## Decision

1. **Roles.**
   - The table owner is NOLOGIN. Migrations run only through the pipeline under change control with a separate migration role.
   - The **application role** has no UPDATE or DELETE on audit, signature, data-point or genealogy rows, and no UPDATE right on any status column. DELETE is revoked on GMP tables; removal happens only through the retention function (ADR-0007).
   - An **authentication-service role** is the only role that can insert authentication events. Each event is single-use, expiring and bound to person, device and signature challenge.
   - The **sandbox role** has no grants on any GMP database.
   - No login role but a superuser may cancel or end another connection's work: `pg_cancel_backend` and `pg_terminate_backend` are revoked from PUBLIC and every other role by the database-level policy (`sandbox.apply_connect_policy`, kernel 0970), and no login role is a member of `pg_signal_backend`. A leaked application credential therefore cannot silence another process that logs in with the same role; code that decides on the absence of a report checks that the policy holds (`kernel.backend_signals_restricted()`). Added 2026-09-30, review finding P50 round 4.
   - An **evidence listener role** per installation kind (`ebmr_listener`, `ebmr_sandbox_listener`; kernel 0980) is the only login that may write what an edition's device listener receives and its own record that everything received was put on record; database code that decides on the absence of such evidence trusts only that record and refuses without it. The application roles carry a connection limit that keeps a share of the database's connections free for it, and the listener role is limited to that share, so its credential, if stolen, can take no more. Added 2026-10-01, review finding P50 follow-up round 4 and its final verification.
2. **State transitions** run only through SECURITY DEFINER functions that check the allowed-transition table. That table is generated from the XState machine definitions; a test fails if they differ.
3. **Signatures** are inserted only by a SECURITY DEFINER signing function that consumes an unused authentication event of the same person for the same challenge, runs the guards (role, delegation, segregation on the person, qualification, performer is not verifier, record state), inserts the signature row with its content hash, changes state and writes audit and outbox rows in one transaction, and seals the row with a KMS/HSM-held key. A seal-verification job flags any signature whose seal does not verify.
4. **Function hardening:** every SECURITY DEFINER function is owned by a NOLOGIN role, sets a fixed `search_path`, has EXECUTE revoked from PUBLIC and granted to named roles only, and is reviewed as a migration.
5. **Row-level security** protects client-owned content (MBRs, formulas, batch data) in contract-manufacturing tenancies; site-owned resources stay visible to everyone working at the site.
6. **Administrator separation:** no person holds an administrator role and a GMP role anywhere in the installation; a person's administrator account never acts on that person's own GMP account or grants.
7. **Break-glass** superuser access needs two people, is time-boxed and is logged by pgaudit to a sink that administrators cannot write.
8. **Every invariant** has an application guard, a database enforcement (constraint, trigger, privilege or SECURITY DEFINER function), a bypass test that attacks it with raw SQL under the application role, and an invariant query that must return zero rows; production runs those queries on a schedule. Bypass tests are split into **prevented** (raw SQL cannot update a data point, delete an audit row, overlap occupancy, update a status column, insert a signature or authentication event, write from the sandbox role, or insert a shared-device data point without an authentication event) and **detected** (a superuser rewrite caught by chain verification; a transplanted or forged signature caught by seal verification).
9. **Reads limited to authorised persons** (tablets 0410, Phase 2 exit review F34): what a session may read is decided
   in the database for the session whose cookie token the server presents (an active session in a role granted now).
   RECORD-class records need RECORD.READ; GOVERNANCE-class records (investigations, disposals, restores, any type not
   named) need a governance or audit role and are never shown to the person an investigation is about. Content to be
   signed and signature lists are served only through such token-checked SECURITY DEFINER functions; the application
   role keeps token-free readers for RECORD-class records only and sees only RECORD-class rows of `esig.signature` and
   `esig.challenge` (row-level security). The audit trail is read the same way (tablets 0420, review F35): the viewer's
   chains, events, person filter and verification go through token-checked functions that apply the same classes to
   chains (account, person, investigation and the other governance chains need a governance or audit role), and the
   application role has no SELECT on `kernel.audit_event` and `kernel.audit_chain_head`. Review round 2 closed the
   kernel's other doors to the same data. Tablets 0430: the application role no longer executes the evidence package,
   the chain extract, an investigation's scoping report, a person's activity or the chain lists, no longer selects the
   anchors, checkpoints, verification runs or retention holds, and sees only RECORD-class rows of the signature seals,
   the signature-ID register, the content changes, the invalidations and the signing failures. Tablets 0450: it no
   longer selects the disposal approvals, tombstones, restores and restore approvals nor lists signatures through the
   integrity jobs, so it finds no id of a GOVERNANCE-class signature to ask `esig.signature_state` about. Tablets 0440:
   the person an investigation is about, whatever their role, is also refused the hold chains it creates, the hold
   entries it writes on the held records' chains, and the account and person chains and the activity of the persons who
   opened and lead it. Review round 3, tablets 0460: the application role no longer asks the kernel what blocks a
   record (`records.open_blockers` and the disposition flag, disposal refusals, retention status and blocker counter
   built on it), which named the investigation and its concern for the account of the person investigated. Not closed
   in Phase 2: the application role still selects the identity, incident, retention and continuity tables directly
   (owner residual F34.2 in docs/decisions/phase-2-open-questions.md), because the kernel's own code and the server read
   several of them as that role; moving those reads behind session-checked functions is a kernel change for both
   editions.

## Consequences

### Positive

- Defence in depth: a compromised application role cannot forge signatures, skip transitions or rewrite records.
- Transition rules in the database cannot drift from the machine definitions.
- The protection is demonstrated by bypass tests, which become validation evidence.

### Negative

- Some rules exist twice (application guard and database enforcement) and must be kept consistent; generation from one definition and tests reduce, but do not remove, that cost.
- Part of the logic lives in PL/pgSQL, which needs SQL review skills (CODEOWNERS second review on migrations) and is harder to debug.
- A superuser can still rewrite data; that is detected, not prevented.
- Seal keys require KMS/HSM infrastructure and key rotation with an archive of public keys; the demo uses a local key file labelled demo-only.

## Alternatives considered

- **Application-only enforcement.** Rejected: any bug or leaked credential becomes a loophole.
- **Triggers only, without privilege separation.** Rejected: the table owner can disable triggers, and "only through a transition" is clearer as a missing UPDATE right plus a function.
- **Separate database or service per role.** Rejected: loses single-transaction atomicity across records.
- **Ledger database.** Rejected (ADR-0002).

## Related controls and invariants

- Controls: DI-05 (sandbox segregation), DI-13 (security baseline, non-repudiation), DI-14 (no shared write accounts), DI-17 (authority checks and segregation), DI-18 (administrator segregation), DI-19 (credential protection), DI-23 (immutable audit trail), DI-37 (signature linking and invalidation), DI-38 (signature components).
- Invariants: INV-03, INV-06, INV-09, INV-10, INV-11, INV-18, INV-40; the database enforcement of every INV-xx in outline 5.3.

## References

- Build outline v0.2: sections 4.4 (Privileges, Tenancy), 4.7, 5.2 (introduction), 5.3, 5.5, 7.1, 9.1 (Database bypass), 11 Phase 1.
- Architecture research: 5.1 (privilege separation), 5.2, 8.4.
