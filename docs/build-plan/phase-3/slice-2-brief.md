# Slice 2 builder brief (common to the slice 2 builders)

Repository /home/user/ebmr, branch phase-3/slice-2. Read CLAUDE.md, docs/build-plan/phase-3/slice-2-plan.md (scope,
classes, defaults D-S2-1..3) and docs/build-plan/phase-3/slice-1-brief.md (patterns and rules; they all apply here).
Search outline 5.2.2 to 5.2.4 and 5.3 (INV-31, INV-41); never read the big docs whole.

Execution facts (verified):
- Engine: packages/recipe-core/src/engine (types.ts BatchStatus/StepStatus/exception status; corrections.ts
  correctEntry/voidAttempt/invalidateResult/sendBackForReverification; exceptions.ts types, tierDraft, blockingExceptions;
  data.ts repeat-after-fail). Limits: src/limits (LIMIT_TIERS, ActionBreachMode, evaluate.ts TIER_REQUIREMENTS).
- Database: recipe-core sql 0200_execution_store.sql (batch_execution, execution_command, execution_event,
  execution_state, execution_command_permission rows at :88-107, execution_signature_meaning), 0210 (execution_actor,
  sandbox-only; EBMR-EXE-003 refuses commands without a permission row), 0303 recorded-state binding, 0311 step status
  transitions, 0298/0305 exception facts, 0382 signature invalidation (only the engine's three paths).
- Execution is sandbox-only (D-S2-1): keep it so; tests run against the sandbox installation like the existing
  execution tests (find their support helpers in packages/recipe-core/test and apps/tablets-server/test/execution).
- Existing sweeps that will catch you: recipe-core lifecycle/authorization.test.ts (every app-callable writer refuses
  administrators then checks a catalogued permission), lifecycle/audit-reason.test.ts (no system-written reasons; an
  update of an audited row needs the person's own reason), kernel security/definer-hardening, machine consistency.
  Run them before reporting.

Rules: as slice-1-brief.md. Number ranges in packages/recipe-core/sql: builder A 0440-0449, builder B 0450-0459,
builder C 0460-0469 (site-services 0720-0729 for C). Do not commit. Report in at most 25 lines.
