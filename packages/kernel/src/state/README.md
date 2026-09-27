# State-machine engine (kernel module B5, part 3)

Build outline 5.2 (introduction), 4.4 "Privileges"; ADR 0012 decision 2; ADR 0010 (pinning).
Schema `platform`, migrations `0550` (engine), `0551` (sample record), `0552` (generated seed of the
sample machine). Tests: `test/platform/{state-machine,machine-consistency}.test.ts`.

## One definition, two enforcements

1. **Define the machine in XState 5** (`machines/*.ts`).
   - It is flat: atomic and final states only.
   - Each state has one transition per event, and there are no actions, delays or eventless
     transitions.
   - GMP data goes on each transition with `gmp(target, { guards, signature, permission })`.
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
    non-final states, registered guards, one transition per (state, event).
  - A published version is immutable (EBMR-PLAT-061), and `machine_integrity_violations()` re-checks
    the hash.
- **Guards.** `platform.state_guard` maps a code to a SQL function
  `(aggregate_type text, aggregate_id uuid, transition jsonb, payload jsonb, actor jsonb) returns text`,
  which returns NULL for pass or a reason for failure. Guards are registered with
  `platform.register_guard` (migrations only). A built-in guard, `platform.reason_given`, is included.
- **`platform.create_aggregate_state(machine, aggregate_type, aggregate_id [, version])`** creates the state
  at the initial state of the newest (or the given) published version. The aggregate keeps that
  version for its whole life.
- **`platform.transition(machine, aggregate_type, aggregate_id, event, expected_version, payload)`** runs
  in the caller's transaction:
  1. Locks the state row.
  2. Checks the expected version (EBMR-PLAT-066).
  3. Checks that the transition exists in the pinned version (067).
  4. Checks the permission through the AUTHORITY hook (005/006).
  5. Checks `payload.signature_id` through the SIGNATURE hook when a meaning is required (007/008).
     A signature authorises one transition only; replaying it is refused (075).
  6. Runs every guard (068).
  7. Updates the state and version, and writes `platform.state_history` (insert-only, audited, with a
     per-aggregate counter).
  8. Writes a plain-language audit entry on the aggregate's own chain (`<type>:<id>`).
  9. Writes the outbox message `state.transitioned`.

  When the command gave no reason, the state-row UPDATE is audited with reason `STATE_TRANSITION`,
  and the command's own context is restored straight after.
- **Bypass protection.**
  - The application role has only SELECT on state and history.
  - The trigger `platform.guard_state_row` refuses any write that does not come from the engine, and
    any state change that is not a published transition, even from owner-level code (EBMR-PLAT-072).
  - `platform.state_violations()` detects a superuser rewrite (the state row differs from the history).
- **Hooks** (`platform.register_hook`). AUTHORITY and SIGNATURE are provided by the identity and
  e-signature modules. Without a registered provider, a transition that needs one is refused
  (fail closed).

## TypeScript

`createAggregateState(client, machine, ref)`, `transition(client, request)` and
`getAggregateState(db, ref)` in `engine.ts` all run inside a command. They raise `KernelError` with
the code.

## Sample machine

`sample_record` v1: DRAFT -> SUBMITTED -> CHECKED -> APPROVED -> SUPERSEDED or RETIRED, with RETURN to
DRAFT (reason) and signatures CHECKED and APPROVED. Its stub table `platform.stub_record` accepts
content edits only in DRAFT. It stands in for the controlled records built in later phases.
