# Module brief A3: MBR life cycle, per-market effectivity and change control (`packages/recipe-core`, lifecycle part)

Schema: `recipe` (in each edition database; ADR 0011). Migrations: packages/recipe-core/sql/0100_*.sql .. 0199_*.sql
(create the folder; the test harness applies packages/recipe-core/sql after the kernel and site-services migrations, as
namespace 'recipe-core'). Source: packages/recipe-core/src/lifecycle/**. Tests: packages/recipe-core/test/lifecycle/**.
You may add export lines for your module to packages/recipe-core/src/index.ts in one clearly marked block (the flow agent
has its own block).
Controls: PR-02 (preparation, independent check, QU approval), PR-04 (registration conformity and market validity), PR-05
(versioning, supersession, periodic review, retirement, document inventory), PR-06 (change control for masters and
linked GMP objects), PR-07 (QRM linkage for risk-based settings), DI-04 (the life-cycle part: verification evidence bound
to the content hash). Invariants: INV-01 (a GMP batch pins exactly one immutable MBR version that at issue was CURRENT or
BRIDGING for every market in its set: build the selection function and the pin record; batches themselves arrive in
Phase 3, so use a stub batch table named stub_batch), INV-02 (the issued control-recipe snapshot never changes; its hash
matches: snapshot table + hash + immutability, again against stub_batch), INV-04 (no person who edited content since it
last entered DRAFT signs CHECKED or APPROVED; author, checker and approver distinct; checker = approver only if the S4
switch allows), INV-17 (at most one CURRENT version per MBR family, scope and market; BRIDGING only through a signed,
time-limited market-authorisation record).
Read: outline 5.2.1 (the MBR version machine: follow it exactly), 5.2.2 PLANNED->ISSUED (what issue needs from you),
3.3.3-3.3.5 (market sets, rule-table updates reaching approved MBRs), 5.8, 6.5 (versioning, where-used, delta verification,
bulk approval), 7.1-7.2 (segregation S1-S4); ADR 0014 (per-market effectivity), 0010, 0011, 0012, 0016; decisions 0001,
0002 (tablets first); the kernel READMEs for identity (permissions, iam.require_permission, assert_not_administrator),
esig (content providers, create_challenge/sign, register_signed_table, meanings PREPARED/CHECKED/APPROVED and others),
platform state engine (machines from XState, platform.transition, hooks), market (resolution, policies), records
(record types, retention). Use those kernel functions; do not re-implement them.

Build:
1. Tables: MBR family (product, strength, batch size set, dosage form, edition), MBR version (content JSON, canonical
   content hash, version number, state pinned to a published platform machine, author, derived-from version, change
   record ref, effective date, periodic-review due date), content edit log (who edited since the last entry into DRAFT:
   the basis of INV-04), verification evidence bound to a content hash (validator result, simulation/coverage report,
   confirmed test vectors, sandbox run references; any edit to content voids it), market-authorisation records (version,
   market, scope {site, line, batch size}, state CURRENT/BRIDGING/SUPERSEDED/WITHDRAWN, effective from/to, approvals
   and regulatory references, signatures), in-flight disposition records (CONTINUE, HOLD_FOR_ASSESSMENT,
   CANCEL_UNSTARTED) for issued/running stub batches of a predecessor, change records (stub: id, class, validation link,
   Established Condition reporting category) and risk assessment links (stub: id, risk class, rationale ref), document
   inventory view (every version with state, dates, reviews). Register GMP tables with kernel.register_audited_table;
   content and evidence are insert-only.
2. The MBR version state machine as an XState definition generated into the platform transition table (follow the
   platform state README: generator + consistency test), with guards registered through platform.register_guard: DRAFT ->
   IN_VERIFICATION (static gates pass with zero errors, warnings justified: call the validator through a port; the flow
   agent's validator in packages/recipe-core/src/validator is the implementation: run it in TypeScript before the
   command and store its signed-off result with the content hash; the DB guard checks a stored PASS result exists for
   this exact hash), -> SUBMITTED (evidence complete for the hash; Sig PREPARED by the author), -> CHECKED (Sig CHECKED by
   an independent checker; INV-04), -> APPROVED (Sig APPROVED by QA; not an editor; not the checker unless S4; effective
   date present; in-flight disposition recorded for every running batch of the predecessor), any -> DRAFT with reason
   (signatures invalidated through esig), RETIRED, WITHDRAWN. Signatures through esig with content providers for the MBR
   version (content = hash + key fields) so a content change invalidates them (INV-09 applies automatically).
3. Per-market authorisation: an approved version becomes CURRENT for a market and scope through a signed
   market-authorisation record (QA + regulatory signer); the predecessor becomes SUPERSEDED for that market and scope in
   the same transaction; partial scope leaves the predecessor CURRENT for the rest; BRIDGING validity signed and
   time-limited, usable only by batches whose market set includes a market where the successor is not yet CURRENT.
   INV-17 enforced by a constraint (exclusion or unique partial index over family, market and scope) plus bypass tests.
4. Selection at issue (INV-01): `recipe.select_version_for_issue(family, market set, scope, at)` returns the newest
   version CURRENT for every market, else CURRENT-or-BRIDGING for every market, else refuses with an explanation naming
   each market. Pin record for a stub batch with version id + content hash + table versions resolved; the control-recipe
   snapshot (INV-02) insert-only with its hash verified by a function and by a bypass test.
5. PR-04: a registered CPP range widened without a variation/registration reference is blocked (compare the new
   version's registered tiers with the predecessor's); a batch for a market not linked to the master is refused (the
   selection function). PR-05: periodic-review due dates and an overdue list; after v2 is CURRENT, pinning a new stub
   batch to v1 is refused; inventory export. PR-06: an APPROVED/CURRENT version's content can never change (edits only by
   deriving a new DRAFT version); a process-impacting change with no validation link cannot be approved; a structured
   diff between versions (use the flow agent's diff if available, else a field-level JSON diff). PR-07: submitting a
   version with a critical parameter and no linked risk assessment is blocked (the "three deviations re-review task"
   line needs deviations: Phase 4; say so).
6. Permissions: add the permissions you need (MBR.AUTHOR, MBR.CHECK, MBR.APPROVE may already exist in the iam
   catalogue: reuse; add new ones in your own migration under the SOFTWARE_RELEASE identity the way kernel 0700 does),
   iam.assert_not_administrator on every GMP write, iam.require_permission on every writer.
Tests: every catalog_test line of your controls that belongs to Phase 2, bypass tests for INV-01, INV-02, INV-04 and
INV-17 through the application role, and a model-based test of the version machine (all state/event pairs through the
real engine). Use packages/kernel/test/support (createTestDatabase, seededTestActor) and packages/kernel/test/identity/seed.ts
and packages/kernel/test/esig/helpers.ts from your recipe-core tests (relative imports are fine).
