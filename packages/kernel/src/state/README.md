# State-machine engine (kernel module B5, part 3)

Build outline 5.2 (introduction), 4.4 "Privileges"; ADR 0012 decision 2; ADR 0010 (pinning).
Schema `platform`, migrations `0550` (engine), `0551` (sample record), `0552` (generated seed of the
sample machine), `1110` (state and history rows checked whoever writes them). Tests:
`test/platform/{state-machine,machine-consistency}.test.ts`, `test/mutation/state-engine-rows.test.ts`.

## One definition, two enforcements

1. **Define the machine in XState 5** (`machines/*.ts`).
   - It is flat: atomic and final states only.
   - Each state has one transition per event, and there are no actions, delays or eventless
     transitions.
   - GMP data goes on each transition with `gmp(target, { guards, signature, permission })`. Every
     transition names its permission, and the descriptor names `createPermission`, the permission that
     creates an aggregate (DI-17); the extractor and publication refuse a definition without them.
2. **Generate the seed.** `write-seeds.ts` writes a migration that calls
   `platform.publish_machine_version(<json>)`. The JSON includes a hash of the canonical definition;
   the database recomputes it and refuses a mismatch.
   - Run `npx tsx packages/kernel/src/state/write-seeds.ts` to write missing seeds, `--check` to verify.
   - An existing seed is never overwritten. A changed machine gets a new version and a new seed file,
     listed in `machines/index.ts`.
3. **Consistency tests prove the two agree** (`machine-consistency.test.ts`):
   - the committed seed equals the generator output;
   - the database rows equal the XState transitions;
   - XState's next state equals the table's for every state and event;
   - the engine accepts an event in each reachable state exactly when XState does (model-based run).

## Database side

- **Definitions.**
  - `platform.machine` and `platform.machine_version` hold the states, the initial and final states
    and the sealed `definition_hash`.
  - `platform.machine_transition` holds (from, event, to, guard codes, signature meaning, permission).
  - Publication validates the definition: versions in sequence, reachable states, no dead-end
    non-final states, registered guards, one transition per (state, event), a permission on every
    transition and a create permission (stored in `machine_version.create_permission`, part of the
    canonical text and hash).
  - A published version is immutable (EBMR-PLAT-061), and `machine_integrity_violations()` re-checks
    the hash.
- **Guards.** `platform.state_guard` maps a code to a SQL function
  `(aggregate_type text, aggregate_id uuid, transition jsonb, payload jsonb, actor jsonb) returns text`,
  which returns NULL for pass or a reason for failure. Guards are registered with
  `platform.register_guard` (migrations only). A built-in guard, `platform.reason_given`, is included: the
  command carries the reason code and the reason text of the person who makes the transition, neither blank by
  `kernel.is_blank` (0960; before it, the code alone was checked).
  - **Blank.** `kernel.is_blank` counts a text as blank when it is NULL or holds only characters that show nothing
    on their own: C0 and C1 controls, Unicode white space, format characters (zero-width space and joiners,
    bidirectional marks, word joiner, byte order mark, interlinear annotation marks, and the like),
    default-ignorable code points and the Braille blank, as explicit code points of Unicode 17 (0960). The audit
    trigger (EBMR-AUDIT-002), `records.is_blank` and the guard use it; the recipe-core execution engine holds the same
    class.
  - **Locking rule.** The transition holds the state row FOR UPDATE while its guards run. Every trigger
    or function that changes content a guard reads, and allows it only in some states, reads the state
    row FOR SHARE before it decides (`platform.stub_record_edit_guard`). An edit and a transition of the
    same record then serialise: neither can decide on data the other is about to change.
- **`platform.create_aggregate_state(machine, aggregate_type, aggregate_id)`** creates the state at the
  initial state of the newest published version. The actor needs the version's create permission and
  must not be an administrator (DI-17, DI-18). The aggregate keeps that version for its whole life.
  Only module code (owner level) may pin another version, with
  `platform.create_aggregate_state_at(machine, type, id, version)`: an older version needs the command's
  reason (EBMR-PLAT-069), which the history row and the audit entry keep (ADR 0010: a tightening ships as
  a new version for new records).
- **`platform.transition(machine, aggregate_type, aggregate_id, event, expected_version, payload)`** runs
  in the caller's transaction:
  0. Refuses an administrator (DI-18, EBMR-IAM-042).
  1. Locks the state row.
  2. Checks the expected version (EBMR-PLAT-066).
  3. Checks that the transition exists in the pinned version (067).
  4. Checks the permission through the AUTHORITY hook (005/006).
  5. Checks `payload.signature_id` through the SIGNATURE hook when a meaning is required (007/008).
     A signature authorises one transition only; replaying it is refused (075). The hook registered in
     kernel 0910 (`platform.transition_signature_check`) accepts only a signature applied in the state
     the transition leaves, during the record's current stay in it (after the transition that entered
     it, by audit position): an unused signature from before a RETURN and a new SUBMIT is refused.
  6. Runs every guard (068).
  7. Updates the state and version, and writes `platform.state_history` (insert-only, audited, with a
     per-aggregate counter).
  8. Writes a plain-language audit entry on the aggregate's own chain (`<type>:<id>`).
  9. Writes the outbox message `state.transitioned`.

  The audit trail needs a reason code and text for the state-row UPDATE: where the command gave none,
  the code `STATE_TRANSITION` and the event (`SUBMIT: DRAFT -> SUBMITTED`) as text fill the gap, and the
  command's own context is restored straight after (through `kernel.set_actor_context`). This happens only on
  a transition that needs no reason (a new event such as SUBMIT): where `platform.reason_given` guards the
  transition, it has refused any blank half with the same test on the same context, so the engine writes no
  part of that reason and the audit entry records the person's own.
- **Bypass protection.**
  - The application role has only SELECT on state and history (the sandbox role mirrors it). Only the
    table owner and superusers may write either table, and the only owner-level code that does is the
    engine (`create_aggregate_state_at`, `transition`), which computes every value it writes.
  - The trigger `platform.guard_state_row` refuses a write made without the engine flag (EBMR-PLAT-072).
    The flag is a session setting any role can set, so it is not enough on its own (kernel 1110, defect
    D11 of the Phase 2 exit), and whoever writes:
    - a state row starts at version 1 in the initial state of a published machine version that governs
      its aggregate type, and changes only along a published transition, one version at a time
      (EBMR-PLAT-072);
    - a history row is a published transition of the pinned version (from, event, to), records the
      permission and signature meaning that transition publishes and a signature id exactly when it needs
      one, continues the aggregate's latest history row, and is what the aggregate's state row records;
      a creation row starts a published version, records its create permission and is the first row
      (EBMR-PLAT-077);
    - at commit, every state row written equals its latest history row (EBMR-PLAT-078, a deferred
      constraint trigger: a transaction that sets its constraints IMMEDIATE before a transition has it
      refused).
  - What remains: owner-level code that forges the flag can still make a published transition the engine
    would make, with both rows agreeing, without the engine's permission, signature and guard checks (the
    guard sees rows, not the code that wrote them); a signature id on such a row is not verified by the
    guard.
  - `platform.state_violations()` detects a superuser rewrite with triggers disabled (the state row
    differs from the history).
- **Hooks** (`platform.register_hook`). AUTHORITY and SIGNATURE are provided by the identity and
  e-signature modules. Without a registered provider, a transition that needs one is refused
  (fail closed).

## TypeScript

`createAggregateState(client, machine, ref [, version])`, `transition(client, request)` and
`getAggregateState(db, ref)` in `engine.ts` all run inside a command. They raise `KernelError` with
the code.

## Sample machine

`sample_record` v1: DRAFT -> SUBMITTED -> CHECKED -> APPROVED -> SUPERSEDED or RETIRED, with RETURN to
DRAFT (reason) and signatures CHECKED and APPROVED; created with `sample_record.submit` (the author's
permission). Its stub table `platform.stub_record` accepts content edits only in DRAFT and keeps a
stored `content_version`, raised only when title or body change, which the e-signature content provider
(0910) reports: a save that changes nothing keeps every signature valid (INV-09). It stands in for the
controlled records built in later phases.
