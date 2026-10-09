# Module C3-execution-sandbox-runs: Execution store, SANDBOX_ONLY G-09/G-10 v1, signing content and prepare, availableActions, replay, sandbox test-run server API and ENGINE_COMMAND signable

Depends on: C0-spine

## Paths owned

**packages/recipe-core**
- `src/engine/engine.ts`: refactor the pre-dispatch part of `step()` into a shared `prepare()`, and export `prepareForSignature(def, state, target, actor, clock) → {state, events, changed}`.
- New engine files: `src/engine/{codec,signing-content,actions,replay}.ts`.
- `src/engine/{definition.ts,index.ts,README.md}`: the `installation` option, ENG-DEF-SANDBOX-ONLY, exports, docs.
- `src/blocks/{contract.ts (availability), registry.ts, generic/status.ts (G-09@1, G-10@1), generic/index.ts, README.md}`.
- `src/execution/**` (node-only; replaces the C0 stub): issue, lock, append, load, `replayExecution`, content-provider helpers.
- `sql/0200-0249`.
- Tests:
  - `test/engine/support.ts`: remove the G-09/G-10 stand-ins and pass `installation: 'SANDBOX'`;
  - `test/blocks/golden.test.ts` (updated expectations), `test/blocks/status.test.ts`;
  - `test/engine/{signing-content,actions,codec,replay}.test.ts`;
  - `test/execution/**`.

**apps/tablets-server**
- `src/features/execution/**` (`index.ts` replaces the stub):
  - package inbox and import;
  - issue;
  - views (StepScreenView, RunView, WorkQueue composers);
  - the command endpoint;
  - the ENGINE_COMMAND SignableActionHandler (`previewContent`, `prepareForChallenge`, `dryRun`, `apply`);
  - role derivation, lot resolution, sweeper, timeline, replay endpoint;
  - guidance entries;
  - seed (sandbox lots).
- `sql/0200-0249`: `tab.sandbox_lot` (TEST- lots, insert-only; `tab.resolve_lot`) and `tab.engine_role_map` (rows from plan section 7).
- `test/execution/**`.

**Compliance**
- Control YAMLs of the controls below.

## A1 deliverables (in this order)

1. **Blocks.**
   - `availability?: 'ALL' | 'SANDBOX_ONLY'` on BlockVersion.
   - `DefineOptions.installation` (default 'GMP'); `defineBatch` refuses SANDBOX_ONLY versions in GMP with ENG-DEF-SANDBOX-ONLY and a plain message naming Phase 3.
   - G-09@1 and G-10@1 exactly as in plan section 7, with the full contract (configuration and data schemas, handler, exception rules, simulator model, golden fixtures). They accept `config: {}`.
   - The existing fixtures run with `installation: 'SANDBOX'`; `blocks/golden.test.ts` asserts the GMP refusal.
2. **Pure engine.**
   - `prepareForSignature`, shared with `step()`.
   - `stepSigningContent` and `stageSigningContent`, with the include and exclude lists from plan section 6 and an `enteredBy` helper.
   - `availableActions` by dry-run through `engine.step` with placeholder SignatureRefs (never re-implementing guards).
   - `codec`: bigint as `{"$u":"…"}`; `stateHash` over expr canonical JSON.
   - `replay`: pure; ISSUE, COMMAND, PREPARE and SWEEP rows at their stored clocks; accepted flag, events hash and state hash per row; `checkInvariants`; first difference reported.
3. **SQL** (plan section 7): all tables, definer functions and checks.
   - `lock_execution` writes the clock marker.
   - `append_execution` checks: validated actor, not an administrator, mapped permission, marker equality, seq and prev_row_hash, SQL state hash, unique command id, actor equality, INV-03 on VERIFY/WITNESS from the prior state, `esig.assert_signature`.
   - The INV-40 constraint trigger.
   - The `batch_step` and `batch_stage` providers, registered with `esig.register_content_provider` and `esig.register_signed_table`, so a new content version supersedes signatures (INV-09).
   - `issue_execution`: sandbox only, BATCH.ISSUE.
   - `import_test_package`: sandbox only, BATCH.ISSUE, hash recomputed in SQL.
   - `execution_violations()`.
   - The app and sandbox roles have SELECT only.
4. **Server.**
   - `GET /api/test-packages` (exchange inbox + imported) and `POST /api/test-packages/:id/import`: packageHash, GMP stamp, content hash in TypeScript and SQL, `parseMbr`, `defineBatch(SANDBOX)`.
   - `GET /api/test-packages/:id/issue-form`.
   - `POST /api/test-runs`: TEST- number allocated; policy pinned with its hash; registry fingerprint; engine version.
   - `GET /api/test-runs`, `GET /api/test-runs/:id` (RunView), `GET /api/test-runs/:id/steps/:stepKey` (StepScreenView built with `flow/numbering`, limits with sources, echoes, exceptions with guidance, `actions` from `availableActions`), `GET /api/work-queue` (for the device's room), `GET /api/test-runs/:id/timeline`, `POST /api/test-runs/:id/verify-replay`, `GET /api/lots/:code`.
   - `POST /api/test-runs/:id/commands`, which is `FRESH_ON_SHARED` with an Idempotency-Key:
     1. `lock_execution`;
     2. engine roles from the role map via stored authority;
     3. ClientIntent → engine Command: lot facts from `tab.sandbox_lot`; readings via `DeviceReadingPort.claim` with `source DEVICE` and trust set by the server; manual fallback flagged;
     4. `engine.step`;
     5. `append_execution`, refusals included.
   - The ENGINE_COMMAND signable handler for SIGN_PERFORMED, VERIFY, DISPOSITION_HOLD_POINT, SIGN_OFF_STAGE and DISPOSITION_EXCEPTION:
     - `previewContent` (pure preview);
     - `prepareForChallenge` (PREPARE row when the state changed);
     - `dryRun` (placeholder ref; persisted refusal; post-dry-run content hash must equal the challenged hash, otherwise CONTENT_CHANGED);
     - `apply` (real ref; asserts the content is unchanged).
   - LRU caches for definitions and decoded state.
   - The sweeper: 15 s, `TEST-sweeper` identity, SKIP LOCKED, SWEEP rows only when events were produced.

## A2
- Run report (coverage, replay, invariants, pass/fail), signed with the sandbox Ed25519 exchange key into `to-gmp`.
- Correction, void and invalidation; skip; abort and cancel routes.
- Alternative, replicate-count and loop-iteration intents.
- Server-side support for PERSONAL co-signature.
- Snapshot checkpoints (with Phase 3 in mind).

## Contract
- **Consumes:** the frozen `execution` namespace, `DeviceReadingPort` (C5 implements it; a fake in tests), the SignableActionRegistry and ports (C0), and C2's template (from day 2; the fixtures before then).
- **Provides:** the live sandbox API that C4 uses, and ENGINE_COMMAND.

## Tests (IDs in names)

**Pure engine**
- `[INV-09][DI-37]`:
  - an accepted SIGN_PERFORMED, VERIFY, hold point or sign-off never changes the prepared signing content;
  - any data, finalisation or exception change does.
- `availableActions` agrees with `step()` on random states from `model-support.ts`.
- Codec round trip with fast-check.
- `[DI-34][INV-19][INV-20][INV-25]` Replay of both fixtures and of `dc-mini` is identical; a tampered row, clock or state is reported at that row.
- G-09/G-10 v1 golden fixtures; `[DI-05][INV-18]` `defineBatch` refuses them in GMP.

**Database**
- `[INV-18][DI-05]`:
  - GMP refuses `issue_execution` and `import_test_package`;
  - the sandbox refuses non-TEST numbers;
  - no SANDBOX_ONLY block ever lands in GMP (a violations row).
- `[INV-40]` A raw insert or append of a shared-device command without the current auth event is refused.
- `[INV-16]` An append with a clock that is not the marker is refused.
- `[INV-03]` An append carrying a fabricated accepted VERIFY by an involved person is refused in SQL.
- `[INV-10]` A dry-run refusal leaves no signature; a failed sign leaves the run state unchanged.
- `[INV-09]` A correction after VERIFY supersedes the signatures in esig, and the engine agrees.
- `[INV-26]` Engine roles come from stored evaluations.
- A role-map test: every template role maps from a kernel role holding each needed permission.
- Bypass as `ebmr_app` and `ebmr_sandbox`: no INSERT, UPDATE or DELETE on execution tables.

**Server behaviour**
- `[DI-34]` START of a later step is refused, persisted as a refusal, and shown with its reason.
- `[PR-08]` The action tier blocks until ATTACH_DEVIATION.
- `[INV-25]` A typed computed value is refused.
- `[INV-20]` The sweeper raises exactly one maximum-breach exception.
- ENG-STALE gives 409.
- An idempotent replay.
- Two-connection serialisation.

**Persistence model and golden run**
- The persistence model test: after every command, `execution_violations()` is empty, the esig valid set equals the engine valid set, and replay equals the head.
- **The golden HTTP run of `dc-mini` to EXECUTION_COMPLETE**, recording the signature count (the signature-budget baseline).

## Controls
DI-05, DI-34, DI-37 (execution part), PR-08 (execution), INV-03, INV-09, INV-10, INV-16, INV-18, INV-19, INV-20, INV-25, INV-26, INV-40.

## Must not
- Touch web code, the contract or the kernel.
- Let the browser supply lot facts, device values, actor, roles or signatures.
- Issue GMP executions in Phase 2.
- Register G-09/G-10 v1 as available in GMP.
- Keep the test stand-ins for G-09/G-10.
