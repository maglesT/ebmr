# ADR-0016: Validated actor context and SECURITY DEFINER hardening

- **Status:** Accepted (2026-09-27); decision items 1 to 3 corrected 2026-09-28 (Phase 1 exit review, finding F1)
- **Deciders:** lead engineer, under the owner's delegation to build Phase 1 (decision record 0001); refines ADR-0012
- **Supersedes:** none (extends ADR-0012 decision items 4 and 8)

## Context

- Every GMP write is attributed to the actor that `kernel.begin_command` validated (ADR-0007, ADR-0012). The actor
  context is kept in the transaction-local setting `ebmr.ctx`, so that triggers and SECURITY DEFINER functions can read
  it without it being passed through every call.
- PostgreSQL lets any session write any custom setting with `set_config`. The identity module's review showed that a
  session holding the application role could set `ebmr.ctx` itself, skip `begin_command`, and have a write to an
  audited table attributed to another person (a forged attribution, DI-14, DI-22, INV-07, INV-40).
- The time-and-state module's review showed a second gap: when a function's `search_path` does not name `pg_temp`,
  PostgreSQL searches the session's temporary schema first for tables and views. A session that can create temporary
  tables could shadow `pg_trigger`, `pg_proc` or a module table and make a privileged function read attacker data, for
  example to defeat `kernel.audit_triggers_ok()` (DI-23).
- Both attacks need nothing but the application's own database credentials, which ADR-0012 assumes may leak.

## Decision

1. **One validated context per connection.** `kernel.begin_command` validates the context (shape, then the identity
   module's `kernel.validate_actor_context`) and installs it through `kernel.set_actor_context`, which keeps exactly
   one marker per connection in `kernel.command_marker`: the backend pid (primary key), the current transaction id
   and the SHA-256 of the context. Installing a context replaces the connection's marker; `set_actor_context(NULL)`
   removes it. So only the context installed last in the transaction is validated: a context that kernel code
   switched away from (a co-signer's at a shared terminal, an internal actor's, an earlier command's in the same
   transaction) stops counting at once, and `set_config` cannot bring it back even with its exact text. A savepoint
   rollback restores the previous marker together with the previous `ebmr.ctx`, so the two never disagree. Only
   `ebmr_owner` can write the table or call `set_actor_context`.
2. **Switching and restoring go through the kernel.** Module SECURITY DEFINER code that must switch context inside a
   command (an internal actor, an added reason, a co-signer's own signature entries) calls `set_actor_context`, and
   restores the command's context by calling it again with the context `kernel.current_actor()` returned before the
   switch (NULL when there was none, which clears the context). It never restores with `set_config`: that would
   leave the switched-to context as the only validated one and the restored text unvalidated. `iam.authn_change_secret`
   and `iam.bootstrap_installation` restore this way.
3. **Readers trust only the current marker.** `kernel.current_actor()` returns the context only when the
   connection's marker names the current transaction and the hash of what `ebmr.ctx` holds now; otherwise NULL. A
   transaction without a transaction id cannot own a marker, so a context in it is rejected without reading the
   table. The audit writer and the audit trigger refuse a write when a context is present but not the current
   validated one (EBMR-AUDIT-009). The identity module's `iam.assert_validated_actor()` requires the same
   (EBMR-IAM-002). The table is UNLOGGED (a marker is meaningful only inside its live transaction) and holds at
   most one row per connection.
4. **`pg_temp` last.** Every SECURITY DEFINER function owned by `ebmr_owner` sets `search_path = pg_catalog, <its
   schemas>, pg_temp`, with `pg_temp` explicitly last, and qualifies catalog tables where practical. A repository-wide
   test (`packages/kernel/test/security/definer-hardening.test.ts`) fails the build for any definer function that does
   not.
5. **No temporary objects for the application.** Kernel migration 0001 revokes TEMPORARY on the database from PUBLIC.
   Database-level privileges are not copied from a template database, so the test harness re-applies the revoke to
   every test database, and deployment must apply 0001 to the production database itself (it does, as the first
   migration).

## Consequences

### Positive

- `set_config` alone can no longer attribute a write to anyone, nor can a context validated in one transaction be
  replayed in another, nor can a validated command swap in another person's context mid-transaction (bypass test in
  `packages/kernel/test/identity/attribution.test.ts`), nor can the application reinstall a context that kernel code
  installed earlier in the same transaction and then switched away from, such as a co-signer's after a co-signature
  or an account's earlier context after it was disabled (bypass tests in `packages/kernel/test/review/f1.test.ts`,
  `f68.test.ts`, `f74.test.ts` and `packages/kernel/test/mutation/audit-trail.test.ts`).
- The first design of this ADR (2026-09-27) added one marker per installed context and kept all of them until
  commit. The Phase 1 exit review (finding F1, 2026-09-28) showed that every context marked in a transaction then
  stayed valid, so after a co-signature the application could reinstall the co-signer's context with `set_config`.
  Items 1 to 3 above are the corrected mechanism.
- Shadowing catalog or module tables is refused twice: the application cannot create temporary objects, and even if it
  could, definer functions never consult `pg_temp` first (bypass tests in platform, records and continuity).

### Negative

- One upsert per command or context switch and one primary-key lookup per audited row; negligible next to the audit
  insert itself.
- Module code that switches context must restore through `kernel.set_actor_context`; a restore with `set_config`
  now fails closed (the command's later writes are refused with EBMR-AUDIT-009), which is the safe direction.
- `kernel.current_actor()` is now VOLATILE (it reads the transaction id), so the planner cannot fold it; callers read it
  once into a variable.
- A superuser can still call `kernel.set_actor_context`; that residual risk stays with break-glass logging and chain
  verification (ADR-0007, ADR-0012 item 7).

## Alternatives considered

- **Pass the actor explicitly to every function.** Rejected: every trigger would still need a trusted source, and a
  forgotten parameter would silently attribute nothing.
- **A session-level secret nonce in a setting.** Rejected: any session can read any setting, so the nonce is not secret.
- **Temporary table owned by the definer as the marker.** Rejected: needs TEMPORARY for the owner inside the
  application's session and is harder to reason about than a plain owner-only table.
- **Advisory locks as markers.** Rejected: advisory locks carry no privileges; the application can take the same lock.

## Related controls and invariants

- Controls: DI-13, DI-14, DI-22, DI-23.
- Invariants: INV-07, INV-40.

## References

- Kernel migrations 0001 and 0010; identity migrations 0100 (`iam.assert_validated_actor`, `iam.set_internal_actor`),
  0160 (`iam.authn_change_secret`) and 0180 (`iam.bootstrap_installation`); e-signature 0230 (`esig.sign`, the
  co-signature); platform 0550 (`platform.engine_reason`).
- PostgreSQL documentation, "Writing SECURITY DEFINER Functions Safely" (search_path and pg_temp).
