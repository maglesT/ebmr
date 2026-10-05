# eBMR project — progress & resume notes

Last updated: 2026-09-28 11:45 UTC. Keep this file current after every milestone.
Scratchpad root: /tmp/claude-0/-home-user/0f393df3-64ef-5de6-9328-48ce9ce2b1a5/scratchpad
Durable backup: private artifact "eBMR Project Backup" https://claude.ai/artifact/3c6jFm4psAH5KZoz7GHChK
(files under backup/…; restore with Artifact action "read" + paths). Republish after every milestone:
re-run the files map from /tmp/claude-0/backup-map.json (regenerate via the snippet in section 7) and publish backup-page.html to the same URL.

## 1. What the user wants (decisions, in order — the latest wins)
- Build an electronic Batch Manufacturing Record (eBMR) system. "Hardest project". Research first, then build.
- NO repo: work is session-only (do not touch maglesT/ds or maglesT/deep-learning-for-earth-observation).
- TWO separate products: TABLETS edition (customisable within tablet manufacturing) and INJECTABLES edition
  (customisable within sterile injectables). NOT one general system. Shared internal compliance kernel
  (audit trail / e-sign / access) was proposed; architect also recommends sharing `recipe-core` — user decision PENDING.
- Target customers: INDIAN pharma manufacturers, many exporting. Rules: Revised Schedule M (mandatory) + US FDA + EU GMP
  per target market; stricter wins. (WHO-GMP not added; user only said "add revised sch m".)
- Scale: design for large companies, but logic must be "completely perfect"; very user-friendly UI; all important
  features + helpful extras.
- Accuracy over token cost ("dont worry about tokens accuracy should be there"). Use Opus for anything accuracy-critical.
- User's sample BMR (Atorvastatin tablets, Pharmaguideline) is an EXAMPLE only, not a template.
- User wanted a guidelines document for an external expert to verify -> PDF only ("leave excel just do pdf neat").
- User wants progress saved so work can resume after token/usage limits.

## 2. Done
- Research (web + user-uploaded official texts): see research/, verify/, primary/.
- Official texts supplied by user (extracted in primary/): 21 CFR 11, 21 CFR 211 (eCFR 24 Sep 2026), EU Ch.4 (2011), Ch.5 (2015),
  Annex 11 (2011), Annex 1 (2022), FDA DI Q&A (2018), FDA aseptic guidance (2004), Revised Schedule M (compressed copy, pages missing).
- Requirements register: register/requirements.jsonl (678 rows; stable row numbers n; 587 checked vs official text).
  Built by tools/merge_register.py (keeps n stable via requirements-v1.jsonl) and split by tools/split_register.py.
- Control catalogs (Opus, every row traced; check with tools/check_coverage.py):
  digest/digest-data-integrity.md (DI-01..50), digest/digest-production.md (PR-01..60), digest/digest-sterile-controls.md (ST-01..79),
  digest/digest-india.md (IN-01..52). 667/678 rows mapped to controls; 11 are not eBMR functions (discussed in notes).
- Architecture research: research/architecture.md (graph verdict: PostgreSQL system of record + recursive CTE genealogy,
  benchmarked; TypeScript end to end; Fastify, Zod, Kysely, React+Vite+React Flow, XState 5, fast-check, Vitest, Playwright;
  pnpm monorepo packages/{kernel,expr,recipe-core,...} apps/{tablets,injectables}-{server,web}; separate DB per edition).
- REVIEW PACK PDF delivered: eBMR-Regulatory-Requirements-Review-Pack-v0.9.pdf (154 pp). Builder: pdf/build_review_pack.py
  + pdf/style.css + pdf/render.js (node playwright, fonts from pdf/node_modules/@fontsource). Rebuild:
  `cd pdf && python3 build_review_pack.py && NODE_PATH=$(npm root -g) node render.js <out.pdf>`.
  Download page artifact: https://claude.ai/artifact/BPsgxDgzCAdi1CyACc7qpA (page pdf/review-pack-page.html + PDF file).

## 3. In progress (background agents; outputs appear in digest/)
- DONE: digest/digest-tablets-process.md (141 KB; 50 blocks = 26 kernel K-xx + 24 TB-xx; formulas incl. worked potency example; pharmacopoeia values flagged for QA verification; sample-BMR coverage + gaps).
- DONE: digest/digest-injectables-process.md (204 KB; 49 blocks = 19 KB-xx kernel + 30 IB-xx; 29 calculations; limit tables; all ST and IN-40..51 mapped; 24 conflicts, 13 gaps).
- DONE: digest/digest-features-ux-config.md (140 KB; 29 kernel roles, 32 separations, modules, 25 extras, 23 screens, config model, 10-gate MBR verification). Note: two agents reported an outside rewrite of their files mid-run (facts re-checked); have critics fact-check digests.
If any is missing/partial after a reset: relaunch that agent with the same brief (prompts: see section 6); they append
section by section and resume from where the file stops.

## 3b. Outline status (2026-09-27 ~18:50 UTC)
- v1 outline: outline/build-outline.md (96 KB, pushed as docs/outline/build-outline.md).
- Critiques: outline/critique-regulatory.md (R-01..35: 1 critical, 19 major, 15 minor) and outline/critique-logic.md
  (L-01..68: 7 critical, 43 major, 18 minor). Both pushed to docs/outline/.
- DONE: outline v2 (178 KB, 49-page PDF eBMR-Build-Outline-v0.2.pdf; all 103 issues resolved: 93 fixed, 10 fixed differently).
  Pushed as docs/outline/build-outline.md (+ resolution-log.md, pdf/). Download page updated with both PDFs.
  WAITING ON USER: approve outline + answer 14 decisions (section 13); expert decisions on review pack.
- (old) revision agent wrote outline/build-outline-v2.md + outline/resolution-log.md (every R/L id FIXED / FIXED-DIFFERENTLY /
  REJECTED). If interrupted: relaunch with the same brief; it appends section by section.
- Then: check resolution log covers all 103 ids, push v2, send user summary + decisions (section 13).

## 3c. Build status
- Owner approved outline v0.2 with ALL recommendations (docs/decisions/0001-outline-v0.2-decisions.md).
- Phase 0 on branch phase-0/scaffold: workspace, register (241 YAML), boundaries, pins, trace matrix, CI, REPO-GUIDE, CLAUDE.md done;
  ADRs 0001-0015 being written by an agent into docs/adr/. Then: PR -> CI green -> merge -> Phase 1 (kernel).

## 4. Next steps
1. When the 3 specs finish: write the BUILD OUTLINE (Opus) from digests + architecture.md; save to outline/build-outline.md.
2. Two critics (Opus): regulatory completeness vs control catalogs; logic loopholes & UX. Apply fixes.
3. Deliver outline to user (chat summary + file). Optionally add pharmacopoeia appendix to PDF as v0.9.1 (offered, not yet asked).
4. Wait for user's expert decisions on the PDF (Follow / Don't follow / Modify) and adjust.
5. Only after approval: build. Open decisions for user: share recipe-core between editions?; FDA APS tiers on US-only lines?;
   DSC/eSign for Indian e-signatures (legal counsel); pressure-difference default; missing Schedule M pages.

## 5. File index
- research/: us-regs.json, tablets.json, injectables.json, features-ux.json, configurability.jsonl, intl-*.jsonl,
  schedule-m.jsonl, architecture.md, sample-bmr-analysis.md
- verify/: *-verified.jsonl (checks vs official text), aseptic-requirements.jsonl, annex1-requirements.jsonl
- register/: requirements.jsonl (+ v1/v2), bucket-*.jsonl
- digest/: control catalogs + process/feature specs; _blocks-*.json, _guardrails.json, _sterile-blocks-and-limits.json
- primary/: extracted official texts
- tools/: merge_register.py, split_register.py, check_coverage.py
- pdf/: review pack builder and download page

## 6. Agent briefs (for relaunch)
Each brief = role + scope (two editions, India+US+EU, stricter wins, accuracy first) + inputs (paths above) + output file
+ rules (paraphrase, never >10 consecutive words from sources; append incrementally; never invent clause numbers).

## 7. Backup procedure
- Map: python3 snippet (see conversation) writes /tmp/claude-0/backup-map.json = {"backup/<rel>": {"from": <abs>, "contentType": ...}}
  for PROGRESS.md, research/*, verify/*.jsonl, register/requirements*.jsonl (current + v1), digest/*, primary/*.txt, tools/*.py, pdf scripts.
- NEVER back up src/ (third-party USP/PDA texts fetched by an agent; copyrighted) or work/.
- Also copy PROGRESS.md to /home/user/eBMR-review/PROGRESS.md.
- Backups so far: v1 17:50 UTC (partial specs); v2 ~18:10 UTC (all 7 specs complete; outline in progress).

## 8. GitHub
- User approved a NEW private repo for the code (2026-09-27). Creating it via API failed (403: integration cannot create repos).
  User created github.com/maglesT/ebmr (private). Cloned to /home/user/ebmr (add_repo push access; registered as repo root).
  Commit ff6f280 on main (2026-09-27 ~18:15 UTC): docs/regulatory (review pack, catalogs, register, verification, research,
  sources-extracted), docs/design (architecture, edition specs, features/UX, sample analysis), tools/regulatory, PROGRESS.md.
  From now on: keep PROGRESS.md in the repo root current and push after each milestone (repo is the primary backup;
  the artifact backup is secondary). Code work: feature branch per phase + PR. OWNER AUTHORISED AUTO-MERGE (2026-09-27): merge each PR myself once all CI checks pass.

## 9. Phase 1 (compliance kernel): status and resume notes
- Phase 0 merged to main (PR maglesT/ebmr#1). Branch `phase-1/kernel` holds the audit-trail foundation (commit 2bea679):
  migrations 0001 (roles ebmr_owner/ebmr_app, schema kernel) and 0010 (hash-chained audit trail, begin_command actor context,
  checkpoints, anchors, DDL log), migrate.ts, withCommand, DB test harness (template DB per run, EBMR_MIGRATIONS filter).
- Module agents work in parallel in the same tree, each in its own schema, migration range and folders. Briefs are in
  docs/build-plan/phase-1/ (00-common-brief.md + one per module). Launched 2026-09-27: B1 identity (iam, 0100-0199),
  B3 market engine (market, 0300-0399, compliance/rule-tables), B4 records (records, 0400-0499), B5 time/idempotency/outbox/
  state machines (platform, 0500-0599), B6 security/continuity (continuity 0600-0699 + site-services sql 0600-0699, docs/security,
  docs/operations, ops/). B2 e-signatures (esig, 0200-0299) starts after B1 reports.
- Integration steps for the lead after the agents report: switch every module's `testActor` helper and the audit-trail tests to
  B1's `seedActor` (identity enforcement in kernel.validate_actor_context); wire platform.raise_time_incident -> records.raise_incident;
  wire B6 kiosk attestation into B1 device enrolment; retention rule values -> market rule keys; cross-module FKs if wanted;
  export modules from packages/kernel/src/index.ts; add the DI-13 evidence-package test after B2; run `pnpm run ci`; set
  compliance/phase.yaml current_phase: 1 once all phase-1 controls pass; PR; merge when green (authorised).
- Design note: identity lives in the kernel for Phase 1 (one DB in tests). Per ADR 0001 site services is the system of record for
  persons/accounts/devices; edition DBs will hold mirrors plus local sessions and auth events (auth events must be consumed in the
  edition transaction that signs). Build the mirror sync in Phase 3.
- Dependencies added: fast-check 4.10.2 (root dev), yaml 2.9.1 (kernel).
- 2026-09-27: B5 (time, idempotency, outbox, state machines) finished: 91 tests, DI-27 IMPLEMENTED.
  Security finding from B5 fixed in the foundation: SECURITY DEFINER functions must list pg_temp last in search_path
  (else a session's temp table can shadow catalog/module tables); 0010 fixed, 0001 revokes TEMP from PUBLIC (the test
  harness re-applies it per test DB, since database ACLs are not copied from templates); repo-wide test
  packages/kernel/test/security/definer-hardening.test.ts enforces it; running agents told to comply.
  B5 integration items: register AUTHORITY hook (over iam authority evaluation) and SIGNATURE hook (over esig) with
  platform.register_hook; add permissions platform.settings.change, platform.time_source.manage, platform.alarm.clear,
  sample_record.{submit,check,approve,retire} to the role catalogue; consume outbox topic incident.requested into
  records.raise_incident plus a reconciliation check; export ./time ./commands ./state; register platform.state_history.id
  and platform.outbox.id as protected sequences; consider a dedicated outbox relay role. Owner questions from B5
  (device-skew tolerance on occurred_at <= recorded_at; which trusts count as late entry; REFERENCE_LOST severity) go
  into the Phase 1 owner-questions list.
- 2026-09-27: B4 (records) finished: 69 tests; DI-01, DI-12, DI-47, DI-50 IMPLEMENTED (INV-22 proven).
  Retention logic authoritative in SQL (rule set RET-2026.1), TS mirror proven equal by a property test.
  B4 integration items: export as namespace `records` (name clashes with market); nightly/verifyAllChains must use
  records.verify_chain/verify_anchor (purge-aware) combined with B6 restore-event coverage; replace purge's
  ALTER TABLE ... DISABLE TRIGGER with a purge authorisation row checked by kernel.reject_mutation (row in a table only the
  purge function writes, keyed by txid; never a session setting); fixtures testgmp.* grant DELETE to ebmr_app (accepted
  for audit tests; B4 tests filter them); add permissions RECORD.DISPOSAL_APPROVE, RECORD.LEGAL_HOLD, INCIDENT.CLOSE and a
  register-approval permission and check them via iam.evaluate_authority; signature ids -> esig; retention values -> market
  rule keys (proposedRuleKey); optional index on audit_event actor person_id for DI scoping.
  Owner/expert questions from B4: MAJOR incidents also need root cause + CAPA (peak severity counts); DERIVED class refused
  for decision data (stricter than "not informational"); retention stays OPEN when inputs are missing; design-default rules
  for aborted and never-certified EU batches; CERT-In 6 h and Form 25/28 periods unverified.
- 2026-09-27: B3 (market-profile engine) finished: 105 tests; IN-52 IMPLEMENTED; INV-28 (fast-check, TS and SQL
  engines agree), INV-29, INV-47 proven. Rule tables in compliance/rule-tables/{kernel,tablets,sterile}/*.v1.yaml.
  B3 integration items: export as namespace `market`; publish seed rule tables at install/upgrade via
  syncRuleTables(pool, actor, 'compliance/rule-tables') (not in a migration: needs an actor); permission-gate
  publish_rule_table, set_site_value, define_policy/set_policy_version, apply_policy_tightening via iam; approval uuids
  -> esig; B4 retention to read kernel.retention.* keys; optional FKs (published_by etc. -> iam.person).
  Owner/expert questions from B3: DESIGN values refused as site-value loosening (locks APS acceptance per Decision 2 and
  6-month HEPA A/B per outline 5.9 #17) but IN-43's catalog test expects India-only warn at 6 / block at 12 months;
  seed-data interpretations (B-01 mfg + 5 y for every licence form; EU test records as batch documentation; management
  review and EU PUPSIT typed GUIDANCE; FDA 2004 values GUIDANCE; unverified rows flagged S/U/GK; unverifiable effective
  dates default to 2023-12-28).
- 2026-09-27: B6 (continuity) finished: 50 tests; DI-45 IMPLEMENTED; DI-13 partly (TLS, kiosk hardening;
  formula-permission line due Phase 2, evidence-package test after esig); INV-27 and the restore part of INV-08 proven with
  a real pg_dump/pg_restore disaster simulation. Site-services batch-number register (schema site) with IN-18 tests.
  Docs: docs/security/{threat-model,asvs-l2-review,security-baseline}.md, docs/operations/{ha-and-restore,
  restore-drill-report-template}.md; scripts ops/backup/{backup,drill}.sh.
  B6 integration items: export continuity; register other modules' identifier sequences in a migration >= 0690
  (records incident/investigation numbers, platform outbox/state_history ids, iam ids); iam.register_device ->
  continuity.assert_device_hardened for SHARED/GRADE_A_B; restore approval via esig; lost_window -> records incident;
  continuity.alarm -> platform alarms; iam permission checks on restore/attestation/alarm functions; CI needs
  pg_dump/pg_restore 16 on the runner. Owner decisions: RPO/RTO and backup schedule proposals, WORM storage product,
  DB-admin vs storage-admin separation. Residual risk: data-only reload keeps DB incarnation (caught by ledger check only).
- 2026-09-27: B1 (identity and access) finished: 94 tests; DI-14..DI-21 IMPLEMENTED; INV-11, INV-26, INV-40 and
  the login-name part of INV-27 proven. New login role ebmr_authn (dev password; production needs a vault credential).
  kernel.validate_actor_context replaced (0190). B2 (e-signatures) launched with identity notes appended to its brief.
  B1 integration items: SECURITY GAP: any role can set_config('ebmr.ctx') and skip begin_command, forging attribution on
  tables the app writes directly -> kernel.current_actor/append_audit_event must require a validated command
  (iam.assert_validated_actor / command_log); switch every module's testActor to seedActor/seedServiceActor; export
  identity; wire iam.assert_not_administrator into GMP write paths; B6 device hardening into iam.register_device/open_session
  (add INSTRUMENT class to continuity's list); optional FKs to iam tables; IAM policy values may move into market policies.
- 2026-09-27: integration started (lead). Kernel fix for B1's finding: kernel.begin_command now leaves a marker
  (transaction, backend, context hash) in kernel.command_marker (owner-only); kernel.current_actor() ignores a context
  without its marker and the audit writer refuses it (EBMR-AUDIT-009), so set_config('ebmr.ctx') forges nothing. Module
  code switches context only via kernel.set_actor_context (owner-only). All module test helpers now seed real identities
  (test/support/seeded-actor.ts). src/index.ts exports every module as a namespace. Full suite: 456 tests pass; typecheck,
  lint, boundaries, pins, register clean. Trace at phase 1 lacks only DI-35..DI-38 (B2 running).
- 2026-09-27: kernel 0900 integration wiring: protected sequences for incident/DI-investigation numbers, outbox and
  state-history ids (INV-27); sessions on SHARED/GRADE_A_B terminals refused without a current hardening attestation
  (DI-13; test seeding attests devices via attestDevice); time faults raise a records incident in the alarm's transaction
  (DI-27). 433 tests pass.
- 2026-09-27: B2 (e-signatures) finished: 68 tests; DI-35..DI-38 IMPLEMENTED; INV-03, INV-09, INV-10 and the
  signature-id part of INV-27 proven; DI-13 evidence package test added. 48 vendor minimum meaning types; HMAC and
  Ed25519 seals with key ring; generic invalidation via esig.register_signed_table. Kernel 0910 registers the platform
  SIGNATURE hook and makes the platform sample record signable; esig exported.
  B2 follow-ups (after B7): map meaning types to B7 permissions (new catalogue versions: RECORD_TYPE_APPROVED,
  RECORD_DISPOSAL_APPROVED, DI_INVESTIGATION_CLOSED, new RESTORE_APPROVED); records approve_record_type /
  close_di_investigation / approve_purge and continuity restore approval must verify their signature ids with
  esig.assert_signature (signer = actor) and need content providers; DI-38 relaxation needs an iam session-bound
  password/PIN-only authentication method (relaxation is OFF by default, so not blocking); decide retention of
  signature rows when a record is purged (Phase 4); RLS checks in content_for_signing/evidence_package when tenancy lands.

- 2026-09-27: B7 (authorization wiring) finished: every app-callable writer in market, records, continuity and the site
  batch-number register checks iam.assert_not_administrator (GMP data) and iam.require_permission; platform AUTHORITY
  hook = iam.platform_authority (location scope from the session); permissions and role map in kernel 0700 (table in
  the module READMEs and test/integration/authorization.test.ts); a regression test fails if any app-callable writer lacks
  the checks. Approvals (record type, disposal, DI-investigation closure, restore) now require a real e-signature by the
  approver (esig.assert_signature; kernel 0720 content providers and meaning-type versions; vendor type RESTORE_APPROVED).
  Lead fixes: platform.record_drift_check only for source SYSTEM with PLATFORM.TIME_CHECK_RECORD (a person could have
  declared the clock healthy and cleared an alarm); esig DI_INVESTIGATION_CLOSED source corrected to DI-50; `pnpm ci` is
  a reserved pnpm command: docs now say `pnpm run ci`; DI-22/23/24 register entries filled, with new tests for delete
  with reason, no disable path, entry naming, and the system log (failed login, role change, configuration change).
- PHASE 1 STATUS: compliance/phase.yaml current_phase: 1. `pnpm run ci` green locally: 560 tests, trace ok for phase 1
  (all 23 phase-1 controls have passing tests; build_status IMPLEMENTED except DI-13 and DI-24, whose remaining catalog
  lines are due in Phase 2 (formula confidentiality) and Phase 4 (PDF/review list)).
  Phase 1 exit items still open (outline section 11): kernel mutation targets (StrykerJS on the pure TS modules: market
  resolve, records retention rules, time instants, esig canonical JSON) -> next PR before Phase 2; design review sign-off
  (threat model, ASVS L2, HA/restore design in docs/security and docs/operations) -> owner/expert.
  Follow-ups carried into Phase 2: split SERVICE_ACCOUNT into per-service roles (time monitor, backup agent, retention
  job, interface) for least privilege; revoke kernel.audit_business_event/checkpoint_chain/create_anchor from the app or
  gate them (today any validated actor may add a business entry to any chain, attributed to itself); gate
  platform.enqueue topics per integration before any consumer exists; replace records.purge's ALTER TABLE ... DISABLE
  TRIGGER with an owner-only purge authorisation row checked by kernel.reject_mutation; DI-38 session relaxation needs an
  iam session-bound single-component method (policy is OFF); DI-investigation closure signature should cover the
  conclusion (proposed-closure step); restore runbook signing step; retention of signature rows on purge (Phase 4);
  per-aggregate scope lookup in the AUTHORITY adapter when editions arrive; module-filtered test runs no longer work
  (modules call iam/esig) - use full runs.
  Open questions for the owner: docs/decisions/phase-1-open-questions.md (plus B7 role choices: rule tables published by
  the master-data steward, source corrections by the regulatory signer, policies by the QA MBR approver, CERT-In by
  QA/CSV-DI lead, CSV_DI_LEAD is a GMP role).
- 2026-09-28: PR maglesT/ebmr#2 (Phase 1) merged (merge ff630ae). Branch phase-1/mutation-testing: StrykerJS 10 for the
  kernel's pure TypeScript (stryker.config.mjs, vitest.mutation.config.ts) and tools/sql-mutation (mutates
  database-enforced guard functions: guard removal, relational, logical, not, boolean; 9 groups, 1,284 mutants; target 90 %).
  Weekly workflow .github/workflows/mutation.yml. Stryker's vitest runner builds test names joined with ' ' while Vitest 5
  matches the name filter against 'suite > test'; every test inside a describe block was skipped and mutants counted as
  survived (first run: 22 % with zero tests per mutant). Fixed with a pnpm patch (patches/@stryker-mutator__vitest-runner@10.0.0.patch,
  both test-helpers.js and stryker-setup.js). Full runs in progress; results and any added tests go into the PR.
- 2026-09-28: OWNER DECISION (docs/decisions/0002): Tablets edition first; Injectables edition deferred (Phase 5 on hold).
  Architecture unchanged (shared packages stay edition-neutral; injectables skeletons, docs and sterile data kept).
  Phase 2 agents told: no injectables-only calculations or sterile validator rules; tablets fixtures only.
- 2026-09-28: Phase 2 started in worktree /home/user/ebmr-p2 (branch phase-2/recipe-core): A1 expression language
  (packages/expr), A2 flow model/validator/limits/simulator (packages/recipe-core). Briefs in docs/build-plan/phase-2/.
  Ultracode adversarial review of the merged Phase 1 kernel running as a workflow in worktree /home/user/ebmr-review
  (read-only; reproducers write packages/kernel/test/review-tmp/*.test.ts there). SQL mutation run in /home/user/ebmr
  (branch phase-1/mutation-testing) in progress: audit-trail 74.5 %, actor-validation 92.7 %, signing 85.4 %,
  signature-invalidation 76.2 % (target 90 %; tests to be added for survivors).
- 2026-09-28: SQL mutation run 1 (1,284 mutants): audit-trail 74.5, actor-validation 92.7, signing 85.4,
  signature-invalidation 76.2, segregation-and-grants 53.9, authentication-events 65.9, retention-and-purge 82.5,
  site-values-and-policies 73.2, protected-numbers 60.3 (%; target 90). 254 survivors. Harness now supports per-group
  kill tests (packages/kernel/test/mutation/<group>.test.ts), --only <ids>, and reviewed equivalent mutants
  (tools/sql-mutation/equivalent.json, excluded from the score). An ultracode workflow writes kill tests per group,
  a skeptic challenges every equivalence claim, and mutants that reveal defects are reported, not locked in.
- 2026-09-28: OWNER DECISION (docs/decisions/0003): testing = logic and execution only (unit, property, model-based,
  golden batch, bypass, correctness-under-concurrency, mutation, end-to-end through screens). No load/soak/performance
  testing, no deployment/HA/pen-test work: deployment is a separate system design.
- 2026-09-28: A1 (expression language, packages/expr) finished: 214 tests (property tests, golden vectors for every
  library function, unit table generated with exact factors and cross-checked with ucum-lhc); DI-33 kept SPECIFIED
  (reprocessing half is Phase 3); INV-25 calculation part proven. Injectables-only functions deferred (F0, fill
  volume/weight, vial counts). ucum-lhc moved to devDependencies (generator/tests only). Lead to add a cross-check
  test of expr canonicalJson/sha256Hex against kernel esig. Owner/QA questions: docs/decisions/phase-2-open-questions.md.
- 2026-09-28: OWNER DECISION 0004: defaults for every open question (phase-1 and phase-2 open-question files; later
  questions too). Decision 0005 (core-compliance-only scope) was proposed and WITHDRAWN by the owner the same day:
  the full register and outline v0.2 remain the scope; the triage workflow was stopped with no changes; agents follow
  their original briefs.
- 2026-09-28: A2 (recipe-core flow model, validator, limits, simulator) finished: 191 tests; DI-34, PR-03, PR-08, IN-02,
  DI-04 static parts (build_status SPECIFIED until the execution-time parts land); INV-19, INV-20 and INV-34 (generic)
  proven; two tablet fixture MBRs (granulation/compression with every construct; blister packaging). Defaults recorded in
  docs/decisions/phase-2-open-questions.md (F1-F15). Lead added a cross-check test: expr canonical JSON/SHA-256 equal the
  kernel's. Note for the designer UI: flow/canonical.ts imports esig from the kernel root (node-only deps): a
  browser-safe kernel subpath export is needed later.
- 2026-09-28: A4 (sandbox, DI-05 IMPLEMENTED, INV-18 test half proven; 37 tests) finished. Wired: sandbox exported from
  the kernel; identifier guards on iam.issued_identifier, iam.person, iam.device (kernel 0920) and site batch numbers
  (site-services 0690); the test harness re-applies the database CONNECT policy on every test database. Follow-ups:
  installation stamp in the true-copy manifest and assertGmpOrigin on import (records); simulator report watermark;
  Phase 3 batch issue calls sandbox.assert_batch_issue_allowed after recipe.select_version_for_issue; GMP-only paths
  call sandbox.assert_gmp_installation; restore runbook re-applies apply_connect_policy; production CONNECT grants for
  backup/monitoring roles (deployment design).
  B1 (execution engine and engine-level generic blocks) launched.
- 2026-09-28: CONTAINER RESTART stopped the review workflow, the engine agent (B1) and the lifecycle agent's (A3)
  background test runs. Files survived; snapshot 2bba0bd. Resumed: review workflow wf_2867a725-d77 from its journal
  (script copied to scratchpad/workflows/review.js; 55 agent results reused), B1 and A3 agents via SendMessage.
  SQL mutation gap-closing finished before the restart: kill tests on branch phase-1/mutation-testing (bd1cd5f);
  9 reviewed equivalent mutants in tools/sql-mutation/equivalent.json; defects found (to fix with the review's
  confirmed findings): HIGH iam.role_permission_guard race lets a role mix administration and GMP permissions (INV-11);
  HIGH esig.check_witness fails open when the act terminal has no room (NULL logic); MEDIUM check_witness with an unknown
  act device; MEDIUM iam.assert_validated_actor does not re-check account/session later in the same transaction;
  MEDIUM platform sample_record no-op save vs INV-09; LOW: stale check instants in segregation guards, after_restore
  partial setval on refusal, test harness drop race, transient hash on sample-record invalidation, open_session races
  with device block and lockout. Details: scratchpad/kill-results.json.
- 2026-09-28: B1 (execution engine and engine-level generic blocks G-01..G-05, G-07, G-08, G-11..G-20, G-22..G-24)
  finished: pure engine step(state, command, clock) with 21 commands, sweep for time breaches, corrections (correct,
  void, invalidate), limit-tier exceptions, hold points, stage sign-off; golden runs of both tablet fixtures;
  model-based invariant checks; simulator/engine agreement. Full suite 129 files / 1,192 tests passing. Kernel 0930 adds
  the six engine signature meanings (HOLD_POINT_NOT_RELEASED, STAGE_SIGNED_OFF, CORRECTION_APPROVED,
  INVALIDATION_APPROVED, BATCH_ABORT_APPROVED, BATCH_CANCELLED). Engine defaults recorded in engine/README.md.
  Phase 3 items: DB-backed execution, esig ceremony at run time, INV-03 in SQL, site-services status checks,
  hand-over, G-06/G-09/G-10/G-21/G-25 blocks, rendering parts, edition blocks.
- 2026-09-28: A3 (MBR life cycle, recipe schema 0100-0180) finished: 68 tests; PR-02, PR-04, PR-05, PR-06 IMPLEMENTED;
  PR-07 and DI-04 SPECIFIED (one later-phase line each); INV-01, INV-02, INV-04, INV-17 proven with bypass and
  model-based tests (version machine through the real engine; selection vs model after every command). Defaults L1-L11
  in docs/decisions/phase-2-open-questions.md. Follow-ups: kernel option for "administrative change, not a data entry"
  on returns to DRAFT (L10); platform AUTHORITY adapter to pass product scope (product-limited grants cannot transition
  versions today); btree_gist extension is created in recipe 0100 (needs superuser at migration time: note for the
  deployment design); SANDBOX_RUN evidence cross-check against the sandbox store (import of sandbox run results).
- 2026-09-28: Phase 2 app design workflow running (wf_253d23e7-749; script copy scratchpad/workflows/app-design.js):
  three architects (operator, compliance, delivery), two judges, synthesis into module briefs for the tablets server,
  tablets web (document-first designer, shop-floor step screen, sandbox runs, audit trail), site gateway + scale
  simulator and Playwright end-to-end tests. Goal: first clickable version early.
  Resume notes: review workflow wf_2867a725-d77 (script scratchpad/workflows/review.js).
- 2026-09-28: App design finished (winner: operator-first proposal, with grafts from the compliance and delivery
  proposals; both judges agreed). Plan and module briefs saved in docs/build-plan/phase-2/apps/ (00-plan, 01-build-order,
  02-dependencies, M1-C0 spine .. M6-C5 gateway, judges.json). Wave 0 (C0 spine: dependencies, frozen api-contract,
  browser-safe recipe-core, test-kit, server/web skeletons with session core, demo tooling, Playwright harness)
  delegated to one agent with lead permissions (installs and root configs allowed; no commits). Wave 1 (C1 access/esig/
  audit, C2 designer, C3 execution store and sandbox runs, C4 shop-floor web, C5 gateway and scale simulator) starts
  when exit A0 is green. First clickable version = journey spec fcv.spec.ts (login, designer, validate/simulate, send to
  sandbox, issue TEST- batch, kiosk entries with badge taps, scale capture, limits/exceptions, PERFORMED/VERIFIED
  ceremony, hold point, stage sign-off, replay, audit trail on both installations).
- 2026-09-28: PHASE 1 REVIEW DONE (wf_2867a725-d77): 88 findings -> 55 confirmed with failing reproducers (4 critical,
  15 high, 36 medium), 14 plausible, 19 rejected; critic added 4. Critical: (1) co-signature leaves the co-signer's
  context re-installable for the rest of the transaction (ADR 0016 marker flaw; F1=F68=F74=F12); (2) ALL_APPLY
  strictness compared criterion ids only (F20). On branch phase-1/mutation-testing (/home/user/ebmr):
  docs/build-plan/phase-1-exit/ (results, fix briefs K/E/I/M/R/P/C), reproducers packages/kernel/test/review/*.test.ts.
  Fix agents running: K audit core, E esig, I identity, M market. Next: R records, P platform, C continuity.
- 2026-09-28: C0 SPINE (wave 0 of the Phase 2 apps) done by the lead's delegate in /home/user/ebmr-p2; exit A0 green
  (`pnpm demo:setup && pnpm demo` serves both installations with the demo picker and login, sandbox watermarked
  TEST, NOT GMP; `pnpm run ci` green: 140 files, 1,265 tests, trace ok; smoke and security E2E 6/6). Uncommitted
  on top of df9df7c (which already swept in a mid-way snapshot): the lead reviews and commits.
  Built: dependencies from apps/02-dependencies.md (exact versions); root configs (vitest projects db/server/dom,
  four tsc projects, eslint for React, dependency-cruiser rules with fixtures, CI e2e job, trace reads Playwright
  JSON); `@ebmr/api-contract` (CONTRACT_VERSION 1.0.0, frozen; 47 routes in 8 namespaces, views, strict client intents with an
  exhaustive engine-command classification, 24 example fixtures, typed client); recipe-core `./pure`, MBR
  numbering, canonical JSON, execution stub; `@ebmr/test-kit` (template DBs, staged sandbox provisioning, keys,
  DEMO-ONLY personas and terminals, seeding, kernel sessions); tablets-server skeleton (config, two installations,
  tab schema 0001, security layer: exact Origin, Sec-Fetch-Site, CSRF, CSP, rate limits, opaque device-bound
  session tokens, device proofs, change tickets; session/meta features; stub namespaces answering 501; set-up and
  OpenAPI CLIs); tablets-web (Vite, TanStack Router/Query, boot, shell, demo picker, office and kiosk login, ports
  for ceremony/badge/scale, fixture mode, strict CSP) and ui-kit (tokens, primitives, i18n); tools/demo and
  tools/e2e (Playwright fixtures, evidence reporter, smoke and security specs). Docs: ADR 0017, decisions D1-D11
  and C0-1..C0-8 (docs/decisions/phase-2-open-questions.md), wave briefs docs/build-plan/phase-2/C0..C5-*.md,
  docs/demo/phase-2-first-clickable.md.
  Lead items: kernel migration so iam.bootstrap_installation uses TEST- labels in a sandbox (C0-1; test-kit
  provisions in two stages until then); review D1's departure from ADR 0006 item 4; commit; then start wave 1
  (C1..C5) with the briefs.
- 2026-09-28: C0 committed (b0ef9d9). WAVE 1 STARTED (background agents in /home/user/ebmr-p2, no commits by agents;
  the lead reviews, runs `pnpm run ci` and E2E, commits): C1 access/esig ceremony/audit viewer, C2 MBR designer
  (dc-mini spike report first), C3 execution store + G-09/G-10 v1 + sandbox runs + ENGINE_COMMAND (critical
  path), C4 floor web (fixtures first), C5 gateway/MT-SICS simulator/readings/live gauge. Agents were told to code
  for the Phase 1 exit kernel changes (reason code AND text on audited UPDATE/DELETE; restore contexts only via
  kernel.set_actor_context). Contract and lead-owned change requests come to the lead by message.
- 2026-09-28: Phase 1 exit: fix agent K (audit core) DONE in /home/user/ebmr: F1/F68/F74/F12 fixed (one marker row
  per backend; only the last installed context is valid; 0160/0180 restore via set_actor_context), F2-F8, F77,
  session-independent kernel.row_json, kernel.run_chain_verification with integrity alarm notify, ADR 0016
  rewritten. Cross-module follow-ups handed on: F6 (reason text required) breaks 6 platform/records tests
  (platform.engine_reason must overlay text; records.purge must require text); records true-copy and purge digest
  must use kernel.row_json; continuity backup drill must use kernel.verify_all_chains. Notes in the lead's
  scratchpad fix-handoffs.md and in the R/C launch prompts. P (platform) started; R and C start when E/I/M free CPU.
- 2026-09-28: PHASE 1 EXIT FIXES (branch phase-1/mutation-testing). Fix agents K, E, I, M, R, P done; C (continuity) running.
  Supersedes the 2026-09-27 marker entry above: kernel.command_marker now holds ONE row per backend (F1: only the most
  recently installed actor context is valid; a saved context is restored only via kernel.set_actor_context). Other
  cross-cutting kernel rules now in force: UPDATE/DELETE of audited rows needs a non-blank reason code AND text (F6);
  kernel.validate_actor_context refuses a site_zone other than policy site.zone (EBMR-IAM-118; F46/F84/F27);
  kernel.row_json for session-independent row rendering; role permissions are added by request + approval (F70);
  role grants are approved only for ACTIVE accounts (IAM-026); badge events die with the badge (IAM-097); every
  state machine declares a create_permission and every transition a permission (F45/F78); time sources need a second
  person's confirmation (F49); market approvals are e-signatures (F24/F76, new 0360); retention only on declared
  aggregate types (F29/F75); a legal/investigation hold voids earlier purge approvals (REC-041, owner decision 0004
  default). SQL mutation targets extended with the new guards (1,573 mutants in 9 groups). Next: C done -> full kernel
  suite, SQL mutation run + Stryker, `pnpm run ci`, PR, merge; then merge main into phase-2/recipe-core (merge risks
  listed in the lead's scratchpad fix-handoffs.md: four-eyes role permissions in migrations, IAM-118 zone in contexts,
  create_permission on Phase 2 machines, protected sequences for new schemas, retention declarations, IAM-026 order).
- 2026-09-28: WAVE 1 DONE (C1-C5 all reported). Lead integration so far (each committed with tests): badge-tap port takes
  the exact request (+ offerSwitch, session banner slot); session reports TAP/TAP_PIN per class; tap proof over the body
  minus attribution; non-owning Kysely read pool; tab.bind_session refuses service/instrument sessions (TAB-016); gateway
  key in the seed context; scale slot band; service-key file terminalKey; CSP style hash for react-aria's WebKit overscroll
  rule (pinned by a test against installed react-aria); 64 KiB request headers (disposition proposal in the esig preview
  query; Hindi justification signed end to end); hold-point decisions sign the per-disposition action; tap limit 30/min
  (decision C0-9); rule tables published on both installations by the set-up CLI; route coverage test; recipe execution
  event log and shipped configuration audited, execution rows on database time. Decisions during the wave: the proposed
  exception disposition is inside the signed content (prepareForChallenge + proposal table); timestamps of facts computed
  at signing stay out of the signed text; phase content stored when first worked on. `pnpm run ci` green: 187 files,
  1,640 tests, trace 72/241 controls. E2E 15 passed; the 3 live floor tests skip without a package -> the FCV journey
  agent (running) makes them self-sufficient, writes tools/e2e/specs/journey/fcv.spec.ts, fixes integration defects,
  records video/screenshots for the owner (owner asked for video + screenshots only) and completes the demo guide.
  Lead TODO after that: more shared examples (issue form, timeline, replay, command result, lot) and fixture-mode session
  answers; TemplateView.batchSizes; tsx at bundling; Login.tsx adopting the ui-kit PinPad/BadgePrompt; merge the Phase 1
  exit fixes (merge risks in the lead's notes: four-eyes role permissions, IAM-118 zone, create_permission on machines,
  protected sequences, retention declarations, IAM-026 order, witness next_step_started from providers).
- 2026-09-28: SQL MUTATION RUN 2 (1,712 mutants in 9 groups, after the fix agents): 83 survivors; audit-trail 98.0,
  actor-validation 96.6, signing 95.7, signature-invalidation 100, segregation-and-grants 94.3, authentication-events
  94.3, retention-and-purge 89.2, site-values-and-policies 97.3, protected-numbers 86.4 (report in
  docs/build-plan/phase-1-exit/sql-mutation-run2/). Three kill agents then brought EVERY group to 100 %: 75 survivors
  killed by new tests in packages/kernel/test/mutation/*, 8 recorded as equivalent (tools/sql-mutation/equivalent.json,
  now 17 entries), 1 DEFECT fixed (continuity.external_anchor_problems compared the Merkle root with <>, so an external
  anchor with an incomplete head had a NULL root, no mismatch was reported and it was classed DISCARDABLE instead of
  UNEXPLAINED; now `is distinct from`, test fails before the fix). Workflow wf_6280ca34-a8e challenges the 8 new
  equivalence claims (two skeptics each). Follow-ups noted: site.zone policy accepts any text (validate as IANA zone);
  ALL_APPLY criteria compared in order (reorder = TIGHTER); f55 reproducer can fail under heavy WAL load
  (pg_basebackup "requested WAL segment has already been removed"; passes alone). Remaining for the Phase 1 PR:
  equivalence verdicts, the TypeScript (Stryker) run, full `pnpm run ci`, PR, merge.
- 2026-09-28: FIRST CLICKABLE VERSION (checkpoints D5/D6) DONE. tools/e2e/specs/journey/fcv.spec.ts drives the real
  screens from the GMP designer (dc-mini family, 0 errors, simulation 100 %, test package sent) through sandbox import
  and TEST- issue, both kiosk stages (badge + PIN, taps, G-10/G-09/G-03, scale capture on TEST-BAL-01, PERFORMED /
  VERIFIED by different people, self-verify greyed, stage sign-offs with system summaries, charge-in by scan, G-04
  action-limit breach blocking until the supervisor links DEV-TEST-0001, QA dispositions, hold point released,
  manual two-person G-22) to Execution complete, "Replay identical", and both audit chains intact. Full E2E 19/19 (live
  floor tests self-sufficient through fixtures/test-package.ts). Ten integration defects fixed with tests (views:
  primary action order and greyed reasons incl. the command permission map, stage sign-off on step cards, prospective
  stage summary, raiser names; web: reads reset on user switch, template form race, hold-point decisions listed with
  reasons). Owner received the 6 videos and 26 captioned screenshots (scratchpad fcv-media/, not committed). Demo guide
  docs/demo/phase-2-first-clickable.md Part A1. OPEN (Phase 2 exit list): PRINTOUT-evidence parameters accepted as manual
  entries with no evidence (decide); computed weights lose trailing zeros ("50 kg" not "50.000 kg": keep the balance
  resolution); run-level exceptions cannot be dispositioned from the run overview; engine texts show internal ids;
  BLEND-1 has no simulated balance. Adversarial review workflow wf_915b8c27-4a5 running on the wave-1 commit.
- 2026-09-28: MIGRATION EDITED IN PLACE while merging main (Phase 1 exit) into phase-2/recipe-core: recipe-core
  `0140_machine_mbr_version_v1.sql` (generated from `packages/recipe-core/src/lifecycle/machine.ts`; the seed test
  compares the two) now declares `create_permission: mbr.author`. The sealed definition_hash of machine mbr_version
  version 1 changed (b73add75... -> b7ecdfa2...), and so did the file's migration checksum (519557f5... -> dfbaed05...).
  WHY IN PLACE: the Phase 1 exit kernel refuses to publish a machine version that names no create permission
  (kernel 0550, EBMR-PLAT-062, DI-17). The old 0140 therefore fails on every fresh database, and no later migration can
  stand in for it: versions publish in sequence, so a version 2 still needs a version 1 that publishes. No earlier one can
  either. Checked on a scratch database (current kernel, site services, recipe-core 0100-0130; dropped afterwards): the
  old file fails with the create_permission error, and after a version 1 published first it fails with "1 is not next".
  OWNER ACKNOWLEDGEMENT: the edit contradicts the migration rule the 0230/0240 headers restate, so it is written up as
  docs/decisions/phase-2-open-questions.md O1. Decided by default under decision 0004 (the owner was told and did not
  object): the edit is acknowledged, and from the Phase 2 release on a released migration is never edited. WHY IT IS
  ACCEPTABLE: the runner's rule (`packages/kernel/src/db/migrate.ts`) is that a RELEASED migration is never edited. Phase 2 has never
  been released or merged to main, and no database outside development, test and demo has applied it (the Phase 1 exit
  edited 38 unreleased kernel and site-services migrations the same way, 0550 among them). The recipe-core 0230 header
  ("applied migrations are never edited") states the rule that holds from release on; 0140 is the one Phase 2 file the
  kernel forced. From the Phase 2 release on, a changed machine gets a new version in a new migration (the recipe
  write-seeds reports `differs` for an edited seed). THE CONTROL IS NOT WEAKER: `mbr.author` is the narrowest
  permission there is (the author creates the version; recipe.create_version and recipe.derive_version already require
  MBR.AUTHOR, and platform.create_aggregate_state now checks it again through the AUTHORITY hook), and the kernel refuses
  administrators there (DI-18). CONSEQUENCE, REBUILD: every database built before this merge must be dropped and built
  again, not migrated. Migrating one stops with "migration <namespace>/<file> changed after it was applied" (at kernel
  0550 first, then at recipe-core 0140); nothing upgrades one silently, because the server does not run migrations at
  start. On this machine that means `ebmr_tablets_demo`, `ebmr_sandbox_tablets_demo` and the two `*_probe_demo` databases
  (checked 2026-09-28: they hold the old 0140 checksum 519557f5... and the old kernel 0550). Run `pnpm demo:setup`
  (it drops and re-creates both demo databases) before the next demo. They were left in place here because other work
  may be using them. Test and E2E databases are unaffected: each run builds its own under a new name.
- 2026-09-28: MERGE OF MAIN (PHASE 1 EXIT) INTO phase-2/recipe-core DONE. Merge commit 08c7c0d, then the adaptation of
  Phase 2 to the stricter kernel (workflow wf_2dfdc7c8-5b0: triage, 3 fix rounds, an adversarial verifier each round).
  Final verification: `pnpm run ci` green (259/259 files, 2020/2020 tests, trace ok), E2E 19/19 (FCV journey included),
  no failure cluster left. Main adaptations: mbr_version create_permission (O1 above); INV-27 protected sequences and
  DI-27 db time for the Phase 2 tables (recipe-core 0220, tablets 0260); recipe reasons need both halves and a white-space
  code is refused (0230); draft edits, batch issue and batch status need the user's own reason (0250); TEST- batch
  numbers never cut short (0240); the sweeper holds a SERVICE-only EXECUTION_SWEEPER role (0260) and names its person's
  current legal name; the server reads site.zone from the policy, refuses a non-IANA value and latches SITE_ZONE_CHANGED
  on a change; a refusal before signing is logged with the signer's authentication event (kernel item K2); the kernel
  backup-drill tests got a 120 s limit (load only; the change reaches main with this branch). Kernel items K1 (site.zone
  IANA check) and K2 (signing_misuse vs the attempt's own command) are in docs/decisions/phase-2-open-questions.md.
  OPEN from the final verifier, for the Phase 2 review-fix workflow: (1) activate_market_authorisation still writes a
  system reason (MBR_SUPERSEDED) for the superseded cell when the command gave none (0160 via recipe.push_reason); the
  stricter default is to require the user's own reason there as 0250 does; (2) the test-kit gateway TEST-gw holds the
  broad SERVICE_ACCOUNT role although the seed test calls it least privilege; give it an INTERFACE.WRITE-only role or stop
  the claim. A backup of the unverified adaptation is on the branch wip/phase-2-merge-adaptation (kept; not for merging).
- 2026-09-30: PHASE 2 REVIEW FIXES (review wf_915b8c27-4a5: 27 confirmed, 13 plausible, 2 critic findings, plus merge
  leftovers V1/V2 and kernel items K1/K2 = 46 items). Workflows: wf_a6702877-416 (13 fix clusters in lanes, a skeptic
  attack per fix and a second attempt where it broke, verifier round 1, 3 repairs) and, after a container restart, the
  strictly sequential continuation wf_ec853157-518 (15 more round-1 repairs, verifier rounds 2-4 with 6 + 1 repairs).
  RESULT: 45 of 46 closed with regression tests that fail without the fix (mutation-checked). Final verifier (round 4):
  `pnpm run ci` green (325 files, 2493 tests, trace ok 80/241; one of three runs had a teardown race, see below), E2E
  20/20 (one of two runs had the device-nonce load failure, see below), no migration existing at b5b7d40 edited, no
  weakening found, only the intended new EXECUTE grants for ebmr_app.
  Main changes (all new migrations; nothing at b5b7d40 edited): execution guards in the database (engine role evidence
  evaluated in the declared role/location/map P22; signatures fail closed, exact meaning, made in this transaction
  P24/P37; dispositions and hold-point decisions bound to the signed proposal P25/P26/P38; system facts recorded as the
  system's and proven from the MBR P28/P35; SCAN only when attested, recorded state bound to its command P34/P58/P36;
  operator and limit exceptions derived from the command and the MBR; initial issue state checked), recipe-core
  0270-0305; devices (Ed25519 and raw-line binding in the database P48, kiosk room from the session P49, reading age incl.
  server wait P53, manual-weighing gate in the database P50, scale readiness P51, gateway journal fail-safe P52), tablets
  0270-0340; designer (market codes P13, export audit/file consistency P14/P65, justifications bound to the revision
  P15/P59, simulation role and caps P18/P20); spine (sign-out P5, secrets never in React state or the DOM P1/CN2, audit
  view only from chain-covered data P7, encoded API paths P8, audit paging P11); floor web (resend P42/P45, per-person
  views P43/P44, E2E tests reach their checks P46/P47); kernel 0940 (site.zone must be an IANA zone, K1), 0950 (a refused
  signing's own command is not re-use, K2), 0960 (visible reason text); V1 activation needs the user's own reason; V2
  the gateway has its own least-privilege role (tablets 0290). Defaults X1-X14 recorded in
  docs/decisions/phase-2-open-questions.md (decision 0004).
  STILL OPEN (next, before the draft PR): (1) P50 residual: a holder of the application role's DB credentials can starve
  or cancel the gateway listener's heartbeat queries (advisory room locks; pg_cancel_backend on same-role backends), so a
  working scale reads OFFLINE and the manual path opens. Proposed: owner-only row locks instead of advisory locks, a
  dedicated DB login role for the listener (or revoke pg_cancel_backend/pg_terminate_backend from PUBLIC). (2) E2E load
  failure: the device-nonce rate limit (apps/tablets-server/src/features/session/index.ts, 120/min keyed only by IP)
  trips when parallel kiosk specs run from 127.0.0.1; key it by device + IP, keep the brute-force protection. (3) test-kit
  teardown race: FATAL 57P01 from a pool client still ending when `drop database ... with (force)` runs (seed.test.ts,
  signed-content-hold-point.test.ts); vitest counts it as an unhandled error. Also a load-sensitive test:
  apps/site-gateway/test/delivery-readiness.test.ts.
  RESTART LESSONS: parallel lanes do not resume deterministically (the agent-call order differs), so continuation
  workflows are strictly sequential; agents' `until ! pgrep -f "<pattern>"` wait loops match their own shell and never
  end (killed by hand). Backups of the unverified work were kept on branches wip/phase-2-merge-adaptation and
  wip/phase-2-review-fixes (not for merging; kept on the owner's instruction not to delete things).
- 2026-09-30: P50 RESIDUAL NARROWED, NOT CLOSED (follow-up item p50-gate-vs-app-role, round 1; STILL OPEN item (1)
  above; this entry first said CLOSED, which its verifier refuted: see rounds 2 and 3 below for what stayed open, and
  round 4 (2026-10-01), which makes the gate fail closed when the listener cannot put its evidence on record).
  Tablets 0350 and kernel 0970: the room locks are rows of the owner-only tab.scale_room_lock (no advisory lock); no
  role but a superuser may cancel or end another connection (sandbox.apply_connect_policy revokes
  pg_cancel_backend/pg_terminate_backend; kernel.backend_signals_restricted(), and the gate refuses while it is false);
  the listener records every heartbeat as received (tab.heartbeat_receipt) before its command, on a pool of its own
  with a 4 s limit on each statement (each one, not a heartbeat as a whole: round 2), and a missing heartbeat counts
  only when none was received; a not-online state counts once recorded for 10 s with no ONLINE heartbeat
  received since (X12 route (a), stricter); the API report counts from when it was first seen and only while the API
  has not answered (tab.gateway_api_answer; the server's probes record each answer first and never wait for the
  monitor's command, which runs one at a time); the gate refuses outside READ COMMITTED; p50_noadmin killed by a DI-18
  structural test. Defaults X15-X21 in docs/decisions/phase-2-open-questions.md (X11/X12 replaced by X19/X18). Tests:
  apps/tablets-server/test/devices/manual-weighing-interference.test.ts, packages/kernel/test/security/backend-signals.test.ts.
  No dedicated listener login role (X16). Items (2) and (3) above are not part of this follow-up.
- 2026-09-30: E2E DEVICE-NONCE LIMIT CLOSED (follow-up item e2e-device-nonce-limit, second attempt after an adversarial
  review of the first; STILL OPEN item (2) above). The first attempt let a claimed, unproven public key choose the count,
  so a caller holding no private key got 480 nonces a minute from one address, nonces were not bound to a key, and a
  flood of invented keys from a second address reset a terminal's count. Now: every nonce is bound to the key it is asked
  for (`spki`, required; the HMAC covers the key's fingerprint, nonces.ts), so only that key's proof can use it, and the
  gateway listener's login nonce (unbound, no rate limit) no longer serves a browser proof. A request counts as a
  terminal of its own only with a proof ticket (`lastNonce`: the nonce of that key's last successful proof as an ACTIVE
  browser terminal, 10 minutes, once; `ProofTickets` in device-proof.ts; the key still enrolled when shown). bind.ts
  `by: 'DEVICE'`: with a ticket 120/min per key and address first (a noisy terminal costs nothing else), then 480/min per
  address; without one the request is unproven whatever key it names: refused at once when its key's count is full, else
  120/min shared by the address's unproven requests, then 480/min, then its key's count, so every nonce bound to one key
  counts toward that key's 120. IPv6 by /64; x-ratelimit-* headers and Retry-After as the plugin sent them; refusals
  logged at warn. Web client and test harness send `lastNonce`. Defaults X22-X27 in
  docs/decisions/phase-2-open-questions.md. Tests: apps/tablets-server/test/session/device-nonce-limit.test.ts (13,
  including the reviewer's three attacks), apps/tablets-web/test/api.test.ts; 21 mutations of the new code all killed.
  E2E twice (EBMR_E2E_ECHO=1, server logs at warn): 20/20 both (3.0 min each), no device-nonce, 429 or RATE_LIMITED
  line (a pretty warn line does reach the echoed log: checked with the server's own logger options). Snapshots of the
  E2E databases taken every 3 s: the sandbox server minted up to 122 nonces in any 60 s over all terminals (240 in the
  run); the GMP server minted up to 19. This entry first gave the busiest terminal's authentication events (73 in 60 s
  for TEST-KIOSK-DISP-1) as its nonce count, which undercounts (a page identifying its terminal at start-up asks for a
  nonce and makes no authentication event); the direct counts per key are in ROUND 2 below (TEST-KIOSK-DISP-1 up to 85
  in the rate limit's own windows and 95 in the worst 60 s, against 120). Item (3) above is not part of this follow-up.
- 2026-09-30: TEST-KIT TEARDOWN RACE CLOSED (follow-up item test-kit-teardown-race, second attempt after an adversarial
  review of the first; STILL OPEN item (3) above, the teardown part). Root cause: pg-pool 3.14's end() takes its idle
  clients off its list, asks each to end and resolves at once, before their sockets close; `DatabaseHandle.close()`
  therefore returned while a backend could still be waiting to read its client's Terminate message, the forced drop that
  followed terminated it (FATAL 57P01), the client, still ending, got the error while idle, and the pool re-emitted it as
  an 'error' event with no listener, which Vitest counts as an unhandled error. Now every pool the test-kit makes comes
  from `openPool` and is ended by `endPool` (packages/test-kit/src/db.ts), which resolves once the socket of every
  connection the pool opened has closed: for a connection ended cleanly PostgreSQL closes it only when the backend has
  exited; a connection pg cuts itself (broken, or a query still running) is not waited for, but its closed socket can
  receive nothing from the drop (the first attempt's docs claimed every backend had exited; corrected in db.ts, the
  tests and M1-C0-spine.md). A pool made by `openPool` refuses its own `end()` (no caller used it), and `endPool` refuses
  a pool it cannot follow. `openDatabase().close()` and `bootstrapInstallation` use it. The review found the same race,
  with no error listener, in kernel test helpers of the db project: `openSandbox().drop()` and the restored copy of
  `restoreCopy()` (and a pool ended in the last test of mutation/signature-invalidation.test.ts before the file's drop).
  The kernel may import nothing outside itself, so its tests have their own copy (packages/kernel/test/harness/pools.ts),
  used there and by the kernel tests that end a pool of their own (signing, signature-invalidation, true-copy,
  retention-purge, sandbox provision). No error listener was added and nothing is caught. Tests (`[meta]`):
  packages/test-kit/test/teardown.test.ts (12) and packages/kernel/test/harness/teardown.test.ts (10), through
  packages/kernel/test/harness/relay.ts, a TCP relay that keeps back each client's Terminate message and lets the
  connections go one at a time. The shared check gives every pool two idle connections, holds their Terminates, requires
  the teardown to stay pending for 500 ms and after each connection let go (once its pool has removed the client), with
  500 ms more while only the last is held, and runs once per pool let go last; each handle is checked to have exactly the
  pools the cases name. A teardown that ends pools and nothing else (`close()`, the kernel's `endPool`) must also have
  resolved by the next macrotask once the last client is removed, so a fixed wait of any length fails, not only one under
  about a second; a drop() that drops too early ends a backend still held, which its pool reports as an unhandled 57P01.
  `bootstrapInstallation` stays pending until its last connection has closed. Structural checks: outside the listed files
  (with reasons) no test code makes a pg.Pool without `openPool`. Mutations, each run 3 times, all killed on every run
  (93 of 93): endPool waiting for one connection per pool, a fixed 150 ms or 3000 ms wait, no wait (test-kit and kernel
  copies); close() ending any one of its three pools, or all, with pg-pool's own end(), leaving out a pool, not awaiting;
  the refusal of end() removed, endPool taking any pool, openPool making a plain pool; bootstrap with pg-pool's end(), not
  awaited, the original code; both kernel drop()s ending either pool with pg-pool's end(), not awaiting, the original
  code. The original close() and drop() with the tests' refusal checks removed are killed by the relay check alone (6 of
  6). Without the new resolves-at-once check the 3000 ms wait survives (the reviewer's 150 ms one does not). Reverting
  any of the nine files moved to `openPool` fails a structural check. Left open: the kernel's test/support/db.ts (not
  touched, per the Phase 2 plan) still silences its two pools' errors before its drop; kernel/test/identity/helpers.ts
  `authnLoginPool` has its own no-op error listener; review/f55.test.ts ends the pools of its restored cluster with
  pg-pool's end() before stopping that cluster (no forced drop); the tablets devices runtime ends its reports pool with
  pg-pool's end() under its own listener for idle errors; the bootstrap check cannot see the pool inside
  `bootstrapInstallation`, so only `endPool` itself is checked to resolve at once; the load-sensitive
  apps/site-gateway/test/delivery-readiness.test.ts is not part of this follow-up. No owner-facing default was taken.
  Round 2 (the verifier's minor points; the item stays CLOSED). (a) No case covered a client that pg-pool's idle timeout
  had already removed (10 s by default in the pools of `openDatabase`) and that was still ending when `endPool` started:
  pg-pool's own end() no longer sees it, and an `endPool` that waited only for the clients pg-pool still listed passed
  all the cases. New shared check `expectEndPoolWaitsForIdleRemovedClient` (relay.ts), run on both copies of `endPool`,
  each with the removed client alone and with another still idle in the pool (let go first): idle timeout 100 ms, every
  Terminate held from before the release; `endPool` must stay pending until the removed client is let go and resolve
  by the next macrotask once its pool reports it removed. Mutation: that weaker `endPool` in both copies passes the 18
  earlier cases and fails the 4 new ones (at the first 500 ms check alone, after the idle client is let go with it);
  `FollowedPool` itself is unchanged (it already followed every connection it opened), only its docs name the case.
  (b) apps/tablets-server/test/platform/read-db.test.ts ended the pools of its server itself and never dropped its copy
  of the GMP template, so every run left one `ebmr_t_*` database behind: it now ends them and drops the copy in its
  `finally`, and checks that the copy is gone (killed with the drop removed). It had also stopped proving what it is
  for: a pool made by `openPool` refuses its own end() and the app's close() lets an error of the read database's
  destroy() go, so Kysely handed the application pool (or a view whose end() ends it) left the pool usable and the test
  passed. It now watches the pool's end() and fails with either mutation of `createReadDb`. Copies leaked by earlier
  runs are still on the development server (58 `ebmr_t_*` databases when this round started); they were left alone, as
  another run may be using a copy of that name pattern. No owner-facing default was taken.
- 2026-09-30: GATEWAY DELIVERY-READINESS TIMING, ROUND 1: NOT CLOSED (follow-up item gateway-delivery-readiness-timing;
  the load-sensitive test named in STILL OPEN item (3) above; second attempt, after a skeptic's review of the first fix;
  this entry first said CLOSED, which its verifier refuted: the pipelined watermark writer below let a write made on
  what the server said before a login land after it; see ROUND 2 below).
  Symptom: in a full parallel run the restart case of apps/site-gateway/test/delivery-readiness.test.ts once got
  uplinked:false from its last capture (18.4 s); alone it passes. Root cause, a race in the gateway rather than the
  test: a capture waits at most 5 s for the server's acknowledgement (Uplink.waitForAck), but at base the waiters were
  told only after the acknowledgement watermark had been written (writeAtomic: open, fsync, rename, directory fsync),
  and the upload pass waited for that write before it sent the next batch, so the 5 s raced the gateway's own disk.
  Evidence: inside that wait the base code does two HTTP exchanges with the in-process fake server (a few ms under
  load) and one watermark write (0.4-3.4 s in probes of that very write under three disk-heavy profiles, load average
  15-22). The restart flow timed phase by phase under 4 CPU hogs and 20 writers of 256 MB with fsync (load average
  about 25): the whole case takes 22-30 s on base and fixed code alike (the first login alone 3-11 s: five fsyncs). On
  base code 28 such rounds never answered uplinked:false (the original failure was not reproduced unaided here, nor by
  the fixer or the skeptic; I/O throttling with cgroups is not permitted in this sandbox), but the flush just before
  the last capture, the same work its wait covers at base (an upload and one watermark write), took up to 4.7 s of the
  5 s, and the last capture up to 5.8 s with its journal write. With the fix the last capture answered uplinked:true
  in all 16 rounds, one of them after 6.4 s. The named-pipe tests below make the base code give the failing answer
  deterministically. First fix (reviewed): a waiter stopped its clock at the acknowledgement and answered after the
  write however long it took. The skeptic showed: (a) a capture queued behind another reading's upload still waited
  for that reading's watermark write before it was even sent (uplinked:false at 5.26 s, deterministic); (b) the answer
  had no bound, so a disk stalled for some seconds could push it past the 20 s of the server's capture request
  (apps/tablets-server/src/features/devices/runtime.ts) and have the server record a working gateway's API as
  unreachable (SCALE_OFFLINE, the manual path may open), where the base code answered uplinked:false at 5 s and the
  server found its row; (c) the docs overclaimed "only the server's answer is timed"; (d) a login whose head covers a
  waiting capture's reading did not tell it. Fix (apps/site-gateway/src/uplink.ts, gateway.ts): no upload waits for a
  watermark write (serverHoldsUpTo starts it on a single-flight writer, one write at a time, the last writing what the
  server holds by then; the loop sends the next batch from the in-memory deliveredSeq); flush() releases its single
  flight when its uploads end, so a pass started meanwhile sends at once, and still settles only after the writes they
  started (`await flush()` still means recorded, or failed and alarmed); a login whose head is a reading of the
  journal's chain tells the waiters it covers before its own write; waiters are keyed by chain (a re-enrolment's new
  chain never answers a waiter of the old one true; at base an acknowledgement of the same sequence number did); an
  acknowledged waiter answers once the write has settled but never after its 5 s from the journalling
  (CAPTURE_ACK_WAIT_MS), so the answer is bounded as at base and a slow disk never turns an acknowledged reading into
  uplinked:false; stop() answers an acknowledged waiter true at once. The one disk write left inside the wait is that
  of a login during it (the server ended the session), which writes the server's head before any upload and fails when
  it cannot (P51). Tests in delivery-readiness.test.ts (the watermark's temporary file made a named pipe, so its write
  hangs): an acknowledged reading answered uplinked when its 5 s end while the write hangs (not later, not false); a
  capture queued behind another reading in the same pass sent and acknowledged while that reading's write hangs (the
  fake server holds the challenge until the capture is journalled: the skeptic's case without timing); a pass started
  while an earlier pass's write hangs sends at once; a lost upload answer, then a new login, answers uplinked; a
  waiter of a replaced chain stays false; stop answers an acknowledged capture at once. The first fix's test is
  replaced by the first of these (it required no answer during the stall, i.e. the unbounded wait). Test support:
  FakeServer.challengeGate and loseUploadAnswers. Mutations (each reverted, the file compared byte for byte): base
  uplink.ts fails all 6 new tests, the first fix all 6; a pass that keeps its single flight until its writes settle
  fails the pass test; awaiting the write in the loop fails 2; no bound after the acknowledgement fails the first;
  answering at the acknowledgement without waiting for the write fails gateway.test.ts (watermark written at the
  answer); no login notice, waiters not keyed by chain (notice or early answer), stop not answering, no retry of a
  failed write at the start of a pass, and flush not awaiting the writes each fail at least one test. Load runs of
  delivery-readiness.test.ts with gateway.test.ts: 10 times alongside 8 CPU hogs on 4 CPUs (load average about 9):
  10/10, all 24 tests. 10 times alongside 4 CPU hogs and 20 writers of 256 MB with fsync (load average about 25; the
  load paused while the db project builds its template): the six new tests and gateway.test.ts 10/10; the restart case
  8/10 (22.7-28.9 s), twice it reached the 30 s test timeout, never a wrong answer; the 51-append test timed out
  10/10. Default X28 rewritten in docs/decisions/phase-2-open-questions.md; M6-C5-gateway-scale.md updated. Left open:
  (1) Under that disk profile each fsync takes about 1-2 s: the restart case (about 14 fsyncs and the 5 s its refused
  capture must wait) runs 22-30 s on base and fixed code alike, and the first test of the file (51 appends, one fsync
  each) runs past 30 s; disk throughput, not a race; no timeout raised, no test changed for it. (2) A disk slower than
  the rest of the 5 s makes the capture answer true before the watermark is on disk, so gateway.test.ts's check of the
  watermark at the answer would fail then (at base its uplinked:true check failed under the same condition). (3) Not
  changed, found on the way: the server names no stability timeout in its capture request and allows 20 s, while a
  gateway may be configured with a stability timeout of up to 30 s, so an unstable balance on such a gateway can
  outlast the server's request.
- 2026-09-30: P50 RESIDUAL, FOLLOW-UP ROUND 2 (item p50-gate-vs-app-role, reopened by its round-1 verifier: "not by
  starving reports" was still open). The 4 s statement limit bounded each statement of a heartbeat, not the heartbeat:
  its waits (a connection of the 4-connection reports pool, kernel.begin_command on the session's row,
  tab.record_heartbeat on the room's row, the commit) added up, and the gateway sends its next heartbeat only after the
  answer, so the gap between receipts followed their sum; the RELOGIN branch after a restart ran on the application
  pool with no limit; and every listener request, authenticated or not, used the reports pool first (the time-zone
  check, then the receipt before the session lookup). Now (apps/tablets-server/src/features/devices/listener.ts,
  runtime.ts): every heartbeat is answered within 3 s (HEARTBEAT_ANSWER_MS; 503 HEARTBEAT_PENDING while its command goes
  on in the background), one command per gateway at a time with only the latest heartbeat waiting its turn; the receipt
  is one statement on a receipts pool of its own (1 s to get a connection, 2 s per statement) that also reads the
  session and site.zone (SiteZoneGuard.observe), so a heartbeat asks nothing else first; tokens this process did not
  hand out take their turn there one at a time; other listener requests check the zone on the application pool; the
  reports pool also limits the wait for a connection to 4 s; the RELOGIN branch (unbind, then end the session, once per
  session) runs under the same deadline. The test written to the verifier's brief, with the gateway's own timing, then
  showed a second lever: every command locks its account FOR SHARE and the kernel's authentication takes it FOR UPDATE,
  so a command of the application role built on the old session holds the gateway's new login up, and the gateway sent
  nothing while it logged in (after a restart, and whenever its session ends or expires, every 12 h). The site
  gateway's uplink (apps/site-gateway/src/uplink.ts) now keeps sending heartbeats with the last login's token while a
  new login gets no answer, which the server receives (not records); a refused or locally failed login ends that (P51
  unchanged); one login at a time. Defaults X29-X31 in docs/decisions/phase-2-open-questions.md (X17 points to them);
  0350's header comment and M6-C5-gateway-scale.md updated. Tests: manual-weighing-interference.test.ts, describe
  "follow-up round 2" (3; the uplink's timing and login handling reproduced in the test: an interval of 5 s, one at a
  time, 15 s per request): the command's wait points held in turn, 10.5 s in all (receipt gaps about 5 s, every answer
  within 3 s, the gate's verdict never OFFLINE though nothing was recorded for over 10 s, at most one connection of the
  reports pool in use); after a restart the old session's row held for 15 s (the same); a flood of 60 heartbeats with
  made-up tokens, 30 challenges and 30 unknown paths (at most one receipts connection taken, none waited for, no
  receipt written, the gateway's own heartbeat recorded). delivery-readiness.test.ts: while a new login is held or its
  connection cut, heartbeats go on without a pause; a refused login stops them. Mutations (each reverted, compared byte
  for byte): no deadline fails the first two (receipt gaps 10.2 s and 12.0 s); no lane for unverified tokens, and the
  time-zone check back on the receipts pool, fail the third; commands not one at a time fail the first; the uplink
  waiting for its login, dropping the last token on any failed login, or keeping it after a refusal each fail the
  gateway test. Before the uplink change the restart case failed with a receipt gap of 7.1 s (its login held until the
  row was let go). scale-readiness.test.ts: a heartbeat held up in its command is now answered 503 HEARTBEAT_PENDING
  after 3 s (it was 500 when its 4 s statement limit ended it). Runs: every tablets-server devices test with
  startup.test.ts and security-encoded-path.test.ts (13 files, 142 tests; the one failure, that expectation, fixed and
  its file rerun, 7/7); every site-gateway test (7 files, 46); E2E 20/20 (3.0 min); typecheck, lint, deps:check,
  register:validate. Left
  open (X31): a flood of made-up tokens can hold up the first heartbeat after a restart until
  its answer is due (no rate limit on the listener); a gateway that never logged in since it started sends nothing
  until its first login.
- 2026-09-30: P50 RESIDUAL, FOLLOW-UP ROUND 3 (item p50-gate-vs-app-role, docs and hidden errors, from its round-1
  verifier). The docs claimed more than the code delivers: the round-1 entry above said CLOSED; M6-C5-gateway-scale.md
  said nothing a holder of the application role's credentials can do makes a working scale count as unusable; the
  listener's header promised receipts inside the window, although only single statements are bounded (a receipt or an
  API answer by the receipts pool's 1 s and 2 s, each wait and statement of a command by 4 s, never a command as a
  whole). And the devices runtime swallowed two failures with no log: a kept connection of its report pools failing
  while idle, and an answer of the gateway's API it could not record (a lost answer lets a report that the API cannot
  be reached count as unanswered until a later answer is recorded). Now: the round-1 entry reads NARROWED, NOT CLOSED;
  M6-C5, the headers of listener.ts, runtime.ts and tablets 0350 (comments only; unreleased), the interference test's
  header and titles, and X21/X29 state the per-statement bounds and the levers still open: a database under enough load
  that a receipt's or an answer's statement runs past 2 s, or with no free connection when a report pool must open
  one, loses it, so the manual path can still open beside a working scale; anyone who can load the database or take
  its connections can bring that about, a holder of the application role's credentials among them. Default X32 in
  docs/decisions/phase-2-open-questions.md. The runtime logs at warn through the server's own log (AppContext.log, new:
  the Fastify instance's logger): each answer not recorded (gatewayCode, the error and its SQLSTATE; also when the
  gateway has no ACTIVE key), and each kept connection of either report pool that fails while idle (pool, the
  gatewayCodes it carries, the error and its SQLSTATE). Tests: apps/tablets-server/test/devices/report-pools-log.test.ts
  (2): a superuser's lock on tab.gateway_api_answer holds the probe's answer past the 2 s limit, and the loss is logged
  at warn with TEST-GW-01 and 57014, no answer row is written, and the next heartbeat's probe records its answer with
  nothing more logged; an answer for a gateway without an ACTIVE key is logged; the idle connection of each pool ended
  by pg_terminate_backend is logged at warn with the pool, [TEST-GW-01] and 57P01, and the pool opens another.
  Mutations (each reverted, the file compared byte for byte): the original silent catch fails the first test; no log
  for a key not ACTIVE fails it; the original no-op pool listener fails the second; info instead of warn, and no
  gateway code, fail both. Runs: every tablets-server devices and platform test (18 files, 160 tests); typecheck,
  eslint of the changed files, deps:check, register:validate; E2E 20/20 (3.0 min). Left open (X32): the load and
  connection levers above (per-role connection limits are an operations matter); the server logs no failed receipt
  and no failed heartbeat command (the gateway listener keeps no log; the gateway gets the error, or nothing after the
  answer's deadline); a 503 HEARTBEAT_PENDING says the heartbeat was received also when its receipt was still waiting
  (the lane of unverified tokens, or a receipt ending after the deadline); the monitor's command that fails twice is
  not logged either (the next probe observes again).
- 2026-09-30: GATEWAY DELIVERY-READINESS TIMING, ROUND 2 (item gateway-delivery-readiness-timing, reopened by its
  round-1 verifier, who reproduced a regression of round 1 deterministically; a first repair attempt was killed by a
  machine reboot, and its partial edits were reviewed, corrected and finished here). Round 1 writes the watermark one
  write at a time beside the uploads, and a write asked for during a running one follows it; writeWatermark compared the
  chain outside the journal lock and journal.acknowledge did not compare it again inside, while a login's
  adoptServerChain changes the chain only inside the lock. So a re-enrolment login whose adoption waited behind a hung
  watermark write was overtaken by the old chain's follow-up acknowledgement: it failed on the new chain after logIn had
  cleared watermarkFailure and serverHolds, a false ACK_WRITE_FAILED stayed ('the server acknowledged reading N with a
  hash this journal does not hold'), nothing retried it, and captures answered NOT_READY until the next login. The same
  missing check let a reconciliation waiting behind the hung write, or a heartbeat's answer showing divergence, adopt
  the old chain after the login (chain.json switched back), and on the same chain let a waiting acknowledgement move the
  watermark past a login's lower head (a server restored from a backup: the readings after it were not sent again).
  Found on the way, the same class: an upload's answer was recorded against the chain current when it arrived (at base
  too), so after a re-enrolment the old chain's answer marked the new chain's reading of the same number as delivered
  (never sent, its capture answered uplinked:true); and in the interrupted attempt's partial fix an answer that arrived
  after the login was still kept in memory until its write came back STALE, so the same upload pass sent the next
  reading after what that answer named, out of sequence for a restored server (a false READING_REFUSED).
  Fix (apps/site-gateway/src/journal.ts, uplink.ts): the journal counts each adoption a login asks for, when it is asked
  (WatermarkBasis: the chain and that count); every other watermark change names the basis taken when its request went
  out (an upload's with its batch, a heartbeat's before it is sent). Uplink.serverHoldsUpTo drops, on arrival, an answer
  whose basis is no longer the journal's (Journal.isCurrent): nothing kept in memory, written or told to a waiting
  capture. A write asked for earlier and still waiting is checked again under the journal lock: acknowledge and the new
  reconcile (which never switches the chain; the reconciliation and the writer's move back used adoptServerChain) return
  STALE and write nothing; the uplink drops a STALE write without a failure (the login writes the server's head and
  resets the rest). Default X33 in docs/decisions/phase-2-open-questions.md; M6-C5-gateway-scale.md updated.
  Tests (delivery-readiness.test.ts, describe "round 2", deterministic: the watermark's temporary file a named pipe,
  FakeServer.reenrol/restoreTo, and the login's adoption observed with a spy before the pipe is let go): a re-enrolment
  login with the old chain's write waiting behind the hung one (the verifier's R4: no watermark failure, the only
  ACK_WRITE_FAILED the hung write's own, ONLINE, a capture delivered); a login whose own adoption cannot be written (the
  pipe replaced by a directory, as with no free inodes) with a write waiting (that write STALE, the failure stands,
  captures NOT_READY until a later login writes the head); a reconciliation waiting, then a re-enrolment (R6: journal
  and chain.json on the new chain); a heartbeat answer showing divergence during a re-enrolment login (not switched
  back, no DIVERGED); a login continuing the chain from a lower head with a write waiting (the watermark stays at the
  head, readings 2-5 sent again); an upload's answer held up until after such a login (the same pass sends 2-6, nothing
  refused); a heartbeat answered before a login and handled after it (nothing sent again); an old chain's upload answer
  after a re-enrolment (the new chain's reading delivered before its capture answers uplinked). From the verifier's
  list: a capture whose write settles within its 5 s is answered only after the write (the pipe let go about 1 s after
  the acknowledgement; now the test that kills an answer at the acknowledgement); gateway.test.ts waits for the
  watermark instead of asserting it at the answer (X28 allows the answer first on a disk slower than the 5 s). Test
  support: FakeServer.uploadTakes, uploadAnswerGate, heartbeatGate, restoreTo; stallWatermark's thenBlocked.
  Mutations (a scratchpad driver; each reverted, both source files compared byte for byte by SHA-256), run against
  delivery-readiness.test.ts and gateway.test.ts (33 tests before the adoption-failure test was added): the round-1
  uplink.ts with the base journal.ts fails all 7 round-2 tests it then had; acknowledge without the check fails 2 (R4,
  the lower head); reconcile without it 2 (R6, the divergence); a check by chain only (the verifier's first option
  alone) 3 (the lower head, the held upload answer, the late heartbeat); serverHoldsUpTo without its drop 1 (the held
  upload answer); an upload's basis taken at its answer 2 (the held upload answer, the old chain's answer); the
  heartbeat's divergence back on adoptServerChain 1; the heartbeat's basis taken at its answer 1 (the late heartbeat);
  the writer's move back with adoptServerChain 1 (R6); answering at the acknowledgement 1 (the wait test;
  gateway.test.ts no longer catches it, by design); a STALE write that clears the failure survived all 33, so the
  adoption-failure test was added and kills it (1 of 24 in delivery-readiness.test.ts); the adoption counted when it
  runs instead of when it is asked for survives (see left open).
  Runs: every site-gateway test (7 files, 55 tests); delivery-readiness.test.ts with gateway.test.ts 5 times in a row
  (34 of 34 each time); the verifier's probe (51 readings, a re-enrolment login during the hung write) now ends with no
  watermark failure and the journal and chain.json on the new chain; the E2E suite (20 of 20, its devices and journey
  specs with the real gateway); typecheck (root tsconfig) and eslint of the changed files. Owner-facing default: X33
  (the killed attempt's row, corrected: an answer dropped on arrival, and a dropped write that leaves an earlier failure
  standing).
  Left open: when the adoption is counted (when it is asked for, not when it runs) is not told apart by any test: it
  differs only for an answer to a request sent after a login's answer arrived and before its adoption ran, and a login
  runs only while the uplink has no session token (ensureLogin), so an upload meanwhile carries none and a heartbeat
  carries the ended session's, which the server refuses (a test reaches it only by calling logIn with a live session);
  while such an adoption waits behind a hung write, deliveredSeq still reads what the server said before the login
  (nothing is uploaded meanwhile, as just said); the heartbeat still raises its UPLINK_FAILED alarm ('sending them
  again') for an answer it then drops (X33). Round 1's item (2) is closed by the gateway.test.ts change; its items (1)
  and (3) stand.
- 2026-09-30: E2E DEVICE-NONCE LIMIT, ROUND 2 (item e2e-device-nonce-limit, docs and one test, from its round-1
  verifier, who found the flake and the controls closed: both E2E runs without a 429, the limit re-keyed, nonces bound
  to their key, the skeptic's mutants killed, no weakening). The docs claimed more than the design gives: X22 said a
  terminal past its count cannot starve the others behind its address, which holds only for requests with its own key.
  A caller at the address who holds no private key but knows a terminal's public key fills that key's 120 with
  ticketless requests (they count toward the key's count so that a private-key holder gets no more than 120 usable
  nonces), and the terminal then gets 429 TERMINAL; 120 ticketless requests a minute with any keys fill the unproven
  count and so block every terminal's first request after a reload, a lapsed ticket or a restart. Behind a proxy any
  browser at the site can do both. Now stated: X22-X24 and X26 corrected; X34 (both ways, why the default keeps them,
  the owner's routes: mTLS, a proxy passing each terminal's address, a per-key count for ticketless requests with its
  own cost, an alarm) and X35 (deployment: `spki` is required, so a page loaded before the upgrade gets 400 SCHEMA and
  cannot log in, tap, sign, unlock or switch until reloaded; upgrade when no step is in progress and reload every
  terminal; no transition period, as that would mint unbound nonces) in docs/decisions/phase-2-open-questions.md; the
  same in the comments of bind.ts (DeviceRateLimitSpec) and session/index.ts (comments only), 00-plan.md section 5 and
  M1-C0-spine.md. The two ways are already pinned by existing tests ("whoever holds one terminal key" fills a key's
  count with ticketless requests that need no private key; "a proof ticket counts once" is refused at UNPROVEN once
  invented keys fill that count); the test file's header now says so.
  Headroom, corrected: the first entry gave authentication events (73 in 60 s). Measured directly this round with an
  out-of-tree probe (a NODE_OPTIONS --import module in the scratchpad, nothing in the repo) that logged every key-bound
  nonce HMAC the two E2E servers computed (mint, consume, ticket record and take) with the key's fingerprint; the rate
  limit's own fixed windows (a window opens at its first hit) emulated from them, and tickets reconstructed from the
  recorded and taken HMACs. Two runs, 20/20 each (2.9 min), no 429 and no refusal line: TEST-KIOSK-DISP-1 85 and 85 in
  the limiter's windows (95 and 95 in the worst 60 s) of 120; TEST-KIOSK-BLEND-1 44 and 81; the sandbox address's
  unproven requests 53 and 53 of 120; the sandbox address 121 and 120 (125 sliding) of 480; GMP at most 18 per key and
  21 in all. The verifier's own count (84 fixed, 95 sliding) agrees. X22 carries these figures.
  Test: `[DI-19][DI-20] a good proof by a key enrolled to a device that signs in through no browser (SERVER,
  INSTRUMENT) leaves no ticket ...` (device-nonce-limit.test.ts, now 14; a SERVER and an INSTRUMENT device enrolled
  with P-256 keys; each proves successfully, its ticket request is refused at UNPROVEN, the provider holds no ticket for
  a second good proof while a PERSONAL terminal's good proof leaves one, and the address still has exactly 360 for
  three proven terminals). Mutations (each reverted, device-proof.ts compared byte for byte): a ticket recorded for any
  class (the verifier's survivor) fails it, and still fails it with the provider check neutralised (358 of 360, the
  ceiling arithmetic); SERVER added to the browser classes fails it; INSTRUMENT added fails it.
  Runs: tablets-server session, platform, access and contract tests (12 files, 97 tests); tablets-web api.test.ts (4);
  typecheck (root tsconfig); eslint of the changed code files; register:validate; E2E twice with the probe as above
  and once without it (20/20, 2.9 min, no refusal line). Owner-facing
  defaults: X34, X35. Left open (X34): the two ways themselves (the owner's routes above); nothing is alarmed.
- 2026-10-01: P50 RESIDUAL, FOLLOW-UP ROUND 4: THE GATE FAILS CLOSED (item p50-gate-vs-app-role, from its round-2
  verifier: the item as defined was still reachable by the repo's own account, X32 saying the manual path "can still
  open beside a working scale" when the database is too loaded for a receipt's 2 s statement or has no free
  connection). Root cause: the database gate took the absence of receipts (and of API answers) as proof that a scale
  cannot be used, so it failed open when evidence could not be written; receipts were best-effort writes on an
  application-role pool that opened connections only when needed, the listener shared the ebmr_app login, and no role
  had a connection limit. Now: (1) kernel 0980 (new): the listener's own login roles ebmr_listener (GMP) and
  ebmr_sandbox_listener (sandbox; mirrored, segregated, CONNECT only on databases of its kind, members of nothing and
  with no members), and CONNECTION LIMIT on ebmr_app and ebmr_sandbox = the cluster's ordinary slots less 8 (the
  listener's share; computed at migration, serialised on pg_authid; EBMR-SBX-036 when there is no room);
  apply_connect_policy, mirror_application_privileges and segregation_problems cover the listener roles. Tablets 0350
  (unreleased, edited): only ebmr_listener may call tab.record_heartbeat_receipt, tab.record_gateway_api_answer and the
  new tab.record_listener_tick (ebmr_app no longer may); (2) the receipts pool and the watch's connection log in with
  the listener's login (EBMR_DB_LISTENER_URL, required in production with EBMR_GATEWAY_LISTEN), are all opened before
  the listener listens (no start without them) and a lost one is opened again at once; (3) every heartbeat request and
  every API answer is an arrival of the listener's epoch (apps/tablets-server/src/features/devices/watch.ts); every
  500 ms a tick (owner-only tab.listener_tick) closes the previous one with whether everything that arrived was put on
  record (a failed, timed-out or never-run receipt or answer, a heartbeat refused for a changed time zone, a failed
  tick: unclean); tab.listener_attested_from vouches for a window only from one run's clean ticks without a gap, the
  latest closed at most 2 s old, spanning a full 10 s, with no second run ticking; tab.manual_path_verdict counts
  silence, a scale never reported, a state not ONLINE, and an unanswered API report only over a vouched window, and the
  gate otherwise refuses (EBMR-EXE-074, why UNATTESTED); the basis records attestedFromUs per scale. Defaults X36-X39
  (decision 0004) in docs/decisions/phase-2-open-questions.md; X16, X21, X32 updated; M6-C5, ADR 0012, the kernel
  sandbox README, docs/design/sandbox.md, the apps plan topology and ops/postgres/pg_hba.conf.template (listener rules)
  updated. Tests: manual-weighing-interference.test.ts describe "follow-up round 4" (a superuser's EXCLUSIVE lock on
  tab.heartbeat_receipt for 14 s while the gateway keeps sending ONLINE: every receipt fails, the scale reads OFFLINE,
  the gate never counts it unusable in about 50 samples and refuses through the server and past it, the listener's
  ticks unclean; the application role refused receipts, answers and ticks, the listener's login everything else);
  scale-readiness.test.ts (every API answer lost under a lock on tab.gateway_api_answer, the monitor's reachable report
  held up: the API report never counts); listener-watch.test.ts (4: the vouched window's rules on ticks written by
  hand, the tick function, the listener's connections and start, which requests count as lost);
  packages/kernel/test/security/listener-roles.test.ts (3: roles, segregation and mirror, connection limits); kernel
  segregation tests now also expect the sandbox listener reported where PUBLIC may connect. Adapted (stricter rule,
  no weakening): the rig waits until the listener vouches before its cases (a just-started listener vouches for nothing
  for 10 s); waits that open the manual path after a state change are GATE_WINDOW_MS (12 s, was 10.5 s); tests that
  wrote receipts or answers as the application role now use the listener's pool; the X11 case that put a receipt in
  the report's own transaction runs it on a superuser's connection, after showing the application role is refused.
  Mutations (each reverted, compared byte for byte): the gate taking every window as vouched fails both lock tests (the
  weight keyed by hand through the server was accepted beside the working scale); failed receipts, or lost answers,
  not counted lost each fail their test the same way; a zone refusal not counted lost, or a missing token counted lost,
  fail listener-watch; no warm-up, or no reopening, fail it; dropping the freshness, second-run, gap or clean check of
  tab.listener_attested_from, or vouching from the gate's own window start only, each fail it; the listener functions
  granted to ebmr_app again fail two tests; kernel 0980 without the connection limits (the cluster's limits reset by
  hand first), the listener mirror, the listener's CONNECT, or the membership check each fail listener-roles.
  Runs: the whole server project (64 files, 490 tests) and the whole db project (229 files, 1843 tests), both green;
  E2E 20/20 (2.9 min); typecheck, eslint of the changed files, deps:check, register:validate. Left open (X39): a
  denial of the fallback by whoever can load the database or take the listener's connections; two listeners on one
  database vouch for nothing; the connection limits are set from the cluster's settings at migration time; the
  listener's credential is a new secret for operations; no alarm is raised from the warnings yet (X32).
- 2026-10-01: FINAL RESIDUALS (workflow wf_ef851f19-eed, base 6154f46) verified: `pnpm run ci` green twice (333 files,
  2580 tests, no unhandled error, trace ok) and E2E 20/20 twice (0 flaky, 0 retries); P50, the device-nonce E2E load
  failure, the test-kit teardown race (57P01) and the gateway delivery-readiness race all closed with tests. The final
  verifier left five items for the next commit: (1) agreement.test.ts skips generated flows above 2,000 paths, which is
  narrower than the out-of-memory fix needed (flows of 2,000-50,000 paths used to be checked): restore them (memory-bound
  budget or streamed membership check); (2) X30 still says the receipts pool uses the application role (it uses the
  listener's login, X36/X38); (3) X36 overstates what a stolen listener credential can do under database load: bound it
  (CONNECTION LIMIT on the listener roles, lost-tick handling) and record the residual in X39; (4) ProofTickets defaults
  its clock to Date.now (outside platform/clock.ts): use uptimeMs; (5) read-db.test.ts name lacks its [meta] tag.
- 2026-10-01: AGREEMENT PROPERTY BUDGET (item (1) above, agreement-property-budget). Root cause: the out-of-memory fix
  in b3b2315 made both generated-shape properties of agreement.test.ts skip every flow above 2,000 simulator paths
  (fc.pre), although only collecting hundreds of thousands of paths exhausts the heap; flows of 2,000 to tens of
  thousands of paths, which the base enumerated, went unchecked. Now no generated flow is skipped. Simulator paths are
  streamed (each checked and dropped, none kept); the first 12 are followed through the engine as before; and for every
  flow the random engine completion is shown to be a simulator path by replaying the engine's own decisions
  (run.state.decisions) through the simulator's runOnce: the replayed path must have the engine's steps, and a decision
  the engine did not take, an outcome the simulator does not offer there, or an engine decision the simulator never
  meets fails the test. Every path of a flow is still run (each to its end, as many as the closed form, the completion
  among them) up to FULL_RUN_BUDGET = 100,000 paths, a bound on time only (measured: 0.16-0.46 ms a path on 4 CPUs, so
  at most about 46 s; resident memory flat at about 150 MB through 200,000 paths of a 6.5-million-path shape); 23
  shapes in 100,000 (fc.sample seed 42) have more, and 190 more than 2,000. The second property streams its first 4
  exhausting paths, searching at most the same budget (each of the 28 shapes above 2,000 paths in a sample of 20,000
  had its 4th among its first 16 paths); above the budget, if fewer than 4 were found, it adds the runs that drive each
  loop to exhaustion (targetedRun). Tests (agreement.test.ts, 7, was 5): the first property runs the 3,263,696-path
  HEAVY_SHAPE (12 paths followed, completion replayed, no run of every path) and a 21,904-path shape (every path run,
  completion found among them) as pinned examples before its 60 random shapes, and asserts all 62 were checked; the
  second runs HEAVY_SHAPE (4 exhausting paths within its first 10) before its 40; new: the replay's three refusals,
  and the targeted runs beyond the budget (a 12-path flow searched with a budget of 8). The file passes with a 192 MB
  worker heap (NODE_OPTIONS=--max-old-space-size=192; 47 MB used after the first property). Mutations (each reverted,
  compared byte for byte), all killed: fc.pre(<= 2,000) back in either property; the budget back at 2,000; paths
  collected instead of streamed (V8 out of memory, worker SIGABRT, under the same 192 MB heap); no early return above
  the budget; no replay; the replay taking the first option always, or silently for a missing decision or an outcome
  not offered, or not checking that every engine decision was met; no search for the completion in the full run; no
  targeted runs; no cap on the exhausting-path search; one path followed instead of 12. Engine README figure updated;
  DI-34 lists the two new tests. Runs: agreement.test.ts (7 passed, also under the 192 MB heap); a stress copy in the
  scratchpad (outside the repo) with 3,000 shapes per property: the first property green (the replay never refused);
  typecheck; eslint of the changed file; register:validate.
  Found, not changed (it predates this item and needs its own fix): the second property fails on about 1 generated
  shape in 1,500-10,000 (1 in the 3,000-shape stress run, 1 in 10,000 with seed 42), for example
  par[loop(hold, max 2), loop(phase, max 1)] (6 paths, so every version checks it; the committed version fails on it
  too). The engine raises the max-1 loop's exhaustion first, and that open exception rightly blocks QA's release of
  the hold point in the other loop's second iteration (ENG-HOLD-OPEN-EXCEPTIONS), so the engine never reaches the
  simulator's first exception (loop3@loop3=2); the check assumes it does. With 40 shapes a run, about 0.4-2.7 % of CI
  runs can fail on it. Possible fixes: check the engine's exceptions against all of the path's exceptions, or have QA
  disposition exceptions so the engine continues. (Fixed both ways: AGREEMENT EXHAUSTION CHECK below.)
- 2026-10-01: LISTENER CREDENTIAL BOUND (items (2) and (3) above, listener-credential-bound). Docs: X30 rewritten (the
  receipts pool (4) and the watch's connection (1) log in with the listener's own role, X36/X38, are opened before the
  listener listens and reopened at once; only the reports pool, for heartbeat commands and token unbinding, uses the
  application role; the timeouts and the lane for tokens this process did not hand out kept). X36 corrected: a holder of
  the listener's credentials only keeps the path shut while the real listener's ticks land; by keeping them from landing
  (load past the real listener's 2 s limits, or holding the role's slots once its connections dropped) and ticking a run
  of its own clean, it made the database vouch for that run alone over a window whose receipts were lost. Reproduced
  (manual-weighing-interference.test.ts, new case): a superuser's locks hold the real run's open tick and the receipts,
  a listener-login pool ticks its own run clean for 15 s, and without the fix the weight keyed by hand beside the
  working scale is accepted ('ok'); with it, 422 EBMR-EXE-074 UNATTESTED. Bound, two new defaults (decision 0004):
  X41, kernel 0980 (unreleased, edited): kernel.apply_listener_share(p_share) gives each listener role CONNECTION LIMIT =
  the listener's share (8 for one listener) and its application role the cluster's slots less the share; null keeps a
  declared share (>= 8), below 8 is refused (EBMR-SBX-037), no room is refused (EBMR-SBX-036); superuser only; the
  migration runs it. The server tests' global setup declares a share of 40 (their files run listeners side by side; with
  8 only one could open its connections), which stays on a development cluster (app roles then 57 of 97). X40, tablets
  0350 (unreleased, edited) item 6: tab.listener_tick.closed_at; tab.end_listener_run (listener role only) closes a run's
  open tick with whether everything up to the end was on record, and a tick of an ended run is refused (EBMR-DEV-076);
  tab.listener_attested_from also vouches for nothing while another run ended inside the window (closed_at) or another
  run's latest tick is still open and less than an hour old (stopped without being ended: possibly a listener still
  receiving whose ticks cannot land). The devices runtime's close ends its run (watch.ts end(), one settle limit for what
  is out; RUN_NOT_ENDED_LOG at warn when it cannot). Cost: after a killed or crashed server nothing is keyed by hand
  beside gateway scales for up to an hour, unless the scale is taken out of service in the registry. What remains is
  X39 (6): a holder of the listener's credentials who keeps the real listener from landing any tick for over an hour
  (holding the role's slots after its connections dropped, or sustained load with the 3 connections beside it) still
  makes the database vouch; the database cannot tell the listener from that holder; routes for the owner listed there.
  X37, X38 and X39 (1), (2) updated; 0980 and 0350 headers, runtime.ts and watch.ts comments, kernel sandbox README
  (SBX-037), ADR 0012, docs/design/sandbox.md and M6-C5 updated.
  Tests: listener-roles.test.ts (3; the limits test rewritten: it asserted the listener roles unlimited (-1), now each
  must hold a share of at least 8 with its application role at slots less that share, and, in a rolled-back
  transaction, an unlimited role gets 8, a declared share is kept, 7 and the whole slot count are refused, ebmr_app
  cannot call the function. Not stricter in a full run, as first written here: the server tests' set-up declares its
  share before any test file runs, so the check of the cluster as it stands then reads only that declaration, where at
  base only the migration could have set what it read; corrected by LISTENER SHARE CHECK below); listener-watch.test.ts (9, was 4: lost runs hold for an hour and no longer, also for a gate
  whose window reaches back over an hour; a run that ended inside the window holds, one that ended before does not; the
  end function, its refusal of later ticks and who may call it; the server's close ends its run; a failed end is logged
  and leaves the run open, holding a clean run beside it; what the watch's end says after a loss, with an arrival still
  out, and called twice); manual-weighing-interference.test.ts (20, was 19: the case above). Mutations (each reverted,
  compared byte for byte), all killed: no hour hold (2 listener-watch tests, and the interference case: weight
  accepted); no ended-in-window rule; no ticked-since rule (only the over-an-hour gate window catches it now); the hold
  at 10 minutes, or at 2 hours; ticks allowed after the end; an end without a flag counted clean; the end function
  granted to ebmr_app; the runtime's close only stopping the watch; a failed end not logged; the end's flag always true,
  or ignoring the epoch since the last tick, or not waiting for arrivals still out; end not idempotent; kernel: no limit
  set on the listener roles; a declared share ignored; a share below 8 accepted; a declared share not kept by the next
  migration. Killed only with listener-roles.test.ts run alone, not in a full run (claimed killed here at first;
  corrected by LISTENER SHARE CHECK below): the migration not applying the share (cluster limits reset by hand first,
  restored after); with the server project in the same run its set-up's declaration masked it (the verifier's mutant
  passed 4 CI-style runs out of 4).
  Runs: the whole server project (64 files, 496 tests) and the whole db project (229 files, 1845 tests), both green;
  E2E 20/20 (2.8 min); typecheck; eslint of the changed TypeScript files. Afterwards the cluster still had 88 databases
  and no test process was left running. The development cluster now holds the test share (listener roles 40,
  application roles 57).
- 2026-10-01: CLOCK AND TAG (items (4) and (5) above, clock-and-tag). (4) ProofTickets
  (apps/tablets-server/src/platform/auth/device-proof.ts) now defaults its clock to uptimeMs from platform/clock.ts, as
  change-tickets.ts does, instead of Date.now passed by reference (a read of the process clock outside clock.ts); the
  clock stays injectable for the [DI-19] TTL test. The ESLint clock ban (eslint.config.js) now matches Date.now as a
  member access (`Date.now`, `Date['now']`), so a reference (`= Date.now`, `.map(Date.now)`, `Date.now.bind(...)`) is
  caught as well as a call, each once; `eslint .` passes with it. X26 says which clock the ten minutes run on;
  REPO-GUIDE's clock rule and the tools/boundaries package description updated. (5) read-db.test.ts's test is tagged
  [meta]. Tests: apps/tablets-server/test/session/proof-ticket-clock.test.ts (1, [DI-19]: with platform/clock.ts
  replaced, a ticket made without a clock lapses on the uptime's ten minutes); tools/boundaries/test/clock-ban.test.ts
  (9, [meta]: the rule as the repository computes it for a server file reports each of seven Date.now forms exactly once
  and an argument-less new Date(), not new Date(0), Date.parse, Date.UTC, performance.now, another object's now or a
  type query; it is on for five app and package files and off for the three app clock modules, the kernel's time
  module, a test, a tool and the simulators). Mutations (each reverted, compared byte for byte), killed: the Date.now
  default back fails proof-ticket-clock (the ticket outlived the uptime's ten minutes) and `eslint` of device-proof.ts;
  the call-only selector back fails 5 clock-ban cases (default clock, assigned, callback, bound copy, computed member),
  and with it `eslint` reports nothing on the Date.now default (the verifier's hole). Runs: clock-ban and boundaries
  (12), proof-ticket-clock, read-db and device-nonce-limit (16), all green; typecheck (tsconfig.json); `eslint .`;
  deps:check.
  Found, not changed: uptimeMs is Date.now() less the start time, so a step of the host's wall clock still moves both
  ticket TTLs (a monotonic source such as performance.now() would not); the ban does not see `Date()` called without
  new, `globalThis.Date.now` or `const { now } = Date` (none is used today). Both fixed by CLOCK AND TAG, ROUND 2 below.
- 2026-10-01: LISTENER SHARE CHECK (final verification, listener-credential-bound: item not closed). Root cause: the
  server tests' global setup declares a listener share of 40 (kernel.apply_listener_share) before any test file runs,
  and the [DI-17][DI-30][PR-20] limits test read the cluster as it stands, so in a full run it checked only what the
  set-up wrote: kernel 0980 without its `select kernel.apply_listener_share();` passed every CI-style run and failed
  only alone (the verifier's mutant). Now two checks a run can fail, neither a new default (X41 updated):
  (1) packages/kernel/test/security/listener-roles.test.ts (4, was 3), new [DI-17][DI-30][PR-20] test: a fresh database
  is migrated with every kernel migration before 0980; then each listener role is given a share above the one it holds
  (+1 GMP, +2 sandbox) and both application roles no limit, the rest of the kernel migrations run, and each listener
  role must keep its share and each application role come back at the cluster's slots less its own listener role's
  share; the limits as they were are put back in one transaction (also when the test fails) and the database dropped.
  Harmless to tests running beside it (the listener roles may open more, the application roles at most two fewer, and
  any migration meanwhile keeps the shares and levels the application roles). It shows the migration applying the
  share on any cluster, also one that already holds a declared share. (2) apps/tablets-server/test/support/global-setup.ts
  reads the four roles' limits after migrating its templates and before declaring its share (readRoleLimits), and
  fails the run, dropping both templates, when a listener role holds less than 8 or an application role anything but
  the slots less its listener role's share (listenerShareProblems); on a fresh cluster (CI) only the migration can have
  set them, as at base. New apps/tablets-server/test/devices/listener-share-setup.test.ts (2, [meta]): the check on
  limits given to it (a fresh cluster's -1s, a listener role at 7, application roles unlimited or one slot off, a
  missing role, and levelled shares of 8, 40 and 48 passing) without changing any role, and the read seeing all four
  roles, at least the declared share on each listener role (the kernel test raises it for a moment) and the cluster's
  slots. Mutations (each reverted, compared byte for byte), all killed: 0980 without
  the call, roles reset to -1, the set-up's check off: the old limits test alone still passed in a CI-style run (the
  masking reproduced), the new kernel test failed (application roles left at -1); the same with the check on: the run
  failed in the set-up before any test file started, also as a full `pnpm vitest run` (all projects), with no database
  left behind; 0980 without the call on a cluster that holds the test share (40/57): the new kernel test failed CI-style
  and alone; 0980 declaring 8 instead of keeping the held share: the new kernel test failed alone (listener roles 8, not
  9 and 10); the check returning nothing, without its application-role rule, without its floor of 8, or the read
  missing the listener roles: listener-share-setup.test.ts failed (the last in the set-up). Runs: listener-roles.test.ts
  and listener-share-setup.test.ts; packages/kernel/test/security and /sandbox, apps/tablets-server/test/devices and
  read-db.test.ts together (CI-style, both projects); typecheck; eslint of the changed files. Afterwards the cluster had
  88 databases, the test share (40/57) and no test process left.
- 2026-10-01: LISTENER SESSION DEFAULTS (round-1 verification of listener-credential-bound, problem
  listener-credential-bound-x39-alter-role). Root cause: the listener's own login may set its session defaults (ALTER
  ROLE ebmr_listener [IN DATABASE x] SET ..., e.g. default_transaction_read_only = on or an idle_session_timeout) and
  its password (it is refused CONNECTION LIMIT and VALID UNTIL); the listener's pools fixed only statement_timeout in
  their connection options, so one such statement, with no load and no slot held, reached the real listener's sessions
  at its next reconnection: it landed no tick, and once its last tick was an hour old a run of the holder's own was
  vouched for. X39 (6), X40 and the 0350 header left this out, and X40's reason for the hour (a shorter hold only
  shortens what a holder must sustain) does not hold where nothing is sustained. Now, new default X42 (decision 0004):
  (a) tablets 0350 (unreleased, edited) tab.listener_attested_from vouches for nothing while pg_db_role_setting holds a
  default of a listener login that may connect to the database (has_database_privilege CONNECT), set for this database
  or for every database (a default for another database, or of the other kind's login, reaches no session here and does
  not count); (b) runtime.ts LISTENER_SESSION_PINS: the receipts and watch pools fix default_transaction_read_only=off,
  idle_session_timeout=0 and idle_in_transaction_session_timeout=0 in their startup options beside statement_timeout
  (startup options take precedence over role and database defaults), so the listener keeps recording receipts and ticks
  while such a default stands. The password route is not bounded in the database: recorded in X39 (6) with the owner's
  routes (an alarm on TICK_FAILED_LOG and REWARM_FAILED_LOG; a credential bound to the server's host, by pg_hba address
  and client certificate). X36, X39 (6) and X40's reason corrected; 0350 header and function comment, runtime.ts and
  watch.ts comments, M6-C5 updated.
  Tests: listener-watch.test.ts (11, was 9): the rule on ticks written by hand (the listener's own login sets a default
  for its database: none, removed: vouched; a default for every database counts, one for another database or of the GMP
  login does not, unless that login is given CONNECT here; the cluster-wide forms in rolled-back transactions, since
  other test files run listeners beside it); a server whose listener login has read-only and idle-timeout defaults (set
  by that login itself) starts its listener, its receipts sessions run with the fixed settings, it ticks clean for 12 s
  on the same connections (none lost to the 1 s idle timeout), vouches for nothing while the defaults stand and at once
  when they are removed. manual-weighing-interference.test.ts (21, was 20), the verifier's case: the holder sets
  read-only transactions for its login in the database (and leaves it standing), the real listener's connections are
  ended one at a time, a second apart, and reopened under it, the holder ticks its own run clean on a connection that
  fixes its own setting for 13 s and the real run's earlier ticks are aged an hour; the weight keyed by hand beside the
  working scale is refused (422 EBMR-EXE-074), the real run ticked 20+ times since reopening and the scale reads ONLINE.
  Mutations (each reverted, compared byte for byte), all killed: no catalog rule (both listener-watch tests; the
  interference case still refused by the fixed settings, as designed); no fixed settings (the listener-watch start test:
  first tick refused read-only; the interference case: no real tick since reopening); neither (the interference case:
  weight accepted, 'ok'); each of the three settings left out (read-only: start refused; idle: settings check, and with
  that check removed the kept connections are ended by the timeout and not all reopened; idle in transaction: settings
  check); settings fixed on one pool only (either); the rule for every database only, for this database only, for any
  database, without the CONNECT filter, or for the sandbox login only.
  Runs: apps/tablets-server/test/devices (14 files, 145 tests; the new interference case failed there once, as first
  written: it expected the listener to hold all 5 connections, which earlier cases leave short, see (1) below; fixed and
  the whole interference file rerun, 21 passed); listener-watch.test.ts, device-nonce-limit.test.ts and
  apps/tablets-server/test/execution together (23 files, 169 tests); typecheck; eslint of the changed TypeScript files.
  Afterwards the cluster had 88 databases, no entry in pg_db_role_setting and no test process.
  Found, not changed (they predate this item): (1) the listener's pools do not always hold the 5 connections X38 says: a
  statement that fails drops its connection (pg-pool) and nothing opens another until one is needed, and when several
  fail while idle at once DevicesRuntime.rewarm runs one attempt at a time and starts none for a failure that arrives
  while one runs (seen with the idle-timeout mutant, 3 of 6 listener-login connections left, and in the interference
  file, 2 listener connections left after its earlier cases); (2) once, ending all five of the listener's connections in
  one statement raised an uncaught 'terminating connection due to administrator command' error in the test process (not
  reproduced in a second run); a likely cause is openAll, which holds the connections it checks out with no 'error'
  listener, so one that dies in that window is unhandled. The interference case therefore ends them one at a time.
- 2026-10-01: LISTENER RUN KEY (round-1 verification of listener-credential-bound, problem
  listener-credential-bound-docs-no-listener). Root cause: a run of the listener that ended on record held the others
  only for the window that holds its end, and with no listener running nothing held them; the database cannot tell a
  listener started again from a holder of its credentials. So after a planned restart or deploy, or on a server started
  without EBMR_GATEWAY_LISTEN, a holder of the listener's credentials who ticked a run of its own clean for 10 s made
  the database vouch with nothing to wait out (listener-watch.test.ts asserted it: 'a run started later vouches once it
  has ticked clean for 10 s'), while X37 said nothing is keyed by hand with no listener running and the 0350 header,
  X39 (6) and M6-C5 named only the hour-long route. Bounded, not only documented; new default X43 (decision 0004).
  Tablets 0350 (unreleased, edited): tab.listener_run (owner-only: the run, the SHA-256 of its run key, began_at);
  tab.begin_listener_run(uuid, bytea) (the listener role only; once and only before the run's first tick, EBMR-DEV-078;
  a 32-byte key, EBMR-DEV-077; answers heldUntilUs; prunes runs that began over an hour ago with no tick left);
  tab.listener_attested_from also vouches for nothing while another run whose key differs, or that has none, or any
  other run when this one has none, closed a tick within the last hour. Server: watch.ts listenerRunKey (HMAC-SHA-256
  of a fixed label under the secrets file's nonceKey), start() begins the run before its first tick and returns the
  answer; runtime.ts startWatch passes the key and logs RUN_HELD_BY_OTHER_KEY_LOG at warn when the run is held; the
  config.ts comment on EBMR_SECRETS_FILE says so. Consequences (X43): after a change of the nonce key, or a development
  server without EBMR_SECRETS_FILE started again, the manual path beside the gateway's scales stays shut until an hour
  after the old key's last tick; a holder's run that ticked holds the server's run for an hour (a denial, as before).
  What remains (X39 (6)): once no run of the server's key has ticked for over an hour (none ever ran on the database, a
  server runs without EBMR_GATEWAY_LISTEN or stays down that long, or the real listener is kept out that long), a run of
  someone holding the listener's credentials vouches after 10 s; someone holding the server's secrets as well needs no
  hour. Docs: 0350 header (item 6, what stays open, privileges) and function comments, X36, X37 (the vouching rule; the
  floor consequence with no listener running corrected), X39 (6) (the route left out and its bound; among the owner's
  routes the run key registered by the operator replaces "a run that proves it succeeds a lost one"), X40, the new X43
  section, M6-C5 (gate, still open, tests), watch.ts and runtime.ts comments.
  Tests: listener-watch.test.ts (14, was 11). Runs written by hand begin with one test key unless a case says otherwise,
  so the earlier rules are shown on runs of one server. New [DI-30][PR-20][DI-17] key rule: an ended run of the same key
  before the window does not hold; one of another key or none holds, still at 59 minutes, not at 61; after the server's
  run ended 20 s ago, holder runs of their own key or none ticking clean 12 s are not vouched for, even after a run of
  the holder's own key ended before; after the hour they are; a run with no key is held by another with none. New
  [DI-17][DI-30] start function: the key's SHA-256 kept, not the key; once; not after a tick; 32 bytes; a run named
  (075); heldUntilUs an hour after another key's last closed tick, not counting the same key; pruning; ebmr_app refused.
  The server-close test rewritten (it asserted the verifier's route): after the server's close, a holder's run begun
  with a key of its own (told it is held) and one never begun, each ticking clean 12 s, are not vouched for; a
  DevicesRuntime on the same app (the server started again with the same secrets) vouches within 15 s with no warning;
  with another nonce key its start is logged at warn with the time an hour after the old key's last tick, its run ticks
  clean 12 s and is not vouched for until the old key's runs are aged 61 minutes. The X40 test's run now begins with the
  server's key, so only the open run holds it. New [DI-30][PR-20][DI-17] watch test: start() begins with [id, key]
  before the first tick, once, and returns the answer; listenerRunKey is 32 bytes, the same for the same nonce key
  whatever the CSRF key, another for another nonce key, neither the nonce key nor its plain SHA-256.
  manual-weighing-interference.test.ts (22, was 21): new [PR-20][DI-30][DI-17] case, the verifier's route end to end:
  the real run is ended on record (a superuser holds its open row while it ends it, as the server's close would), no
  heartbeat is sent, and a holder's run begun with a key of its own ticks clean for 13 s; TEST-BAL-01 reads OFFLINE (no
  heartbeat in 10 s) and the weight keyed by hand is refused (422 EBMR-EXE-074, UNATTESTED, through the server and as a
  forged row). It is the file's last case that needs the listener (its watch is refused every tick afterwards; its
  receipts still land). The X40 and X42 holder cases now begin the holder's run with the server's run key (a holder of
  the server's secrets too), so each still shows its own decision and its clean-up is unchanged.
  Mutations (each reverted, compared byte for byte; the tree's checksum matched afterwards), all killed: no key rule
  (2 listener-watch tests; the new interference case: weight accepted, 'ok'); the key rule's hour at 10 minutes; a run
  with no key taken as matching another with none; runs with no key exempt from the rule; the raw key kept instead of
  its hash; a second start re-keying the run; a start after a tick; a key of any length; heldUntilUs always null, or
  counting runs of the same key; pruning runs that still have ticks, or no pruning; the start granted to ebmr_app; the
  watch not beginning its run; beginning after the first tick; a random key per run; a constant key; the key as the
  nonce key's plain SHA-256; the warning not logged. Also, with the holders on the server's key: without X40's hour hold
  the X40 interference case accepts the weight ('ok'), and without both halves of X42 the X42 case does.
  Runs: listener-watch.test.ts (14) and manual-weighing-interference.test.ts (22), each green; the whole server project
  (66 files, 506 tests) green; E2E 20/20 (3.0 min); typecheck; eslint of the changed TypeScript files. Afterwards the
  cluster had 88 databases, no entry in pg_db_role_setting and no test process left.
- 2026-10-01: LISTENER SHARE WORDING (round-1 verification of listener-credential-bound, problem
  listener-credential-bound-share-wording; no new default). Root cause: X38 and X41 called one listener's share of 8
  "its 5 and room to replace them" and the kernel 0980 header said the listener "may need about as many again"; it is
  the 5 connections the listener keeps plus 3 spare. With the hard limit the listener cannot open its 5 when backends a
  network fault left half-open still count, or when the old and new servers of a rolling deploy overlap (5 + 5 > 8); it
  then fails closed (REWARM_FAILED at warn, or the server refuses to start), which no row said, and no test ran a
  listener under the share of 8 (the server tests' cluster declares 40). Docs: X41 (the 8 as 5 kept and 3 spare; the
  two cases and their fail-closed consequences: past the 3 spare a lost connection is not opened again, a receipt
  needing one is lost, ticks fail once the watch's connection is lost, nothing is vouched for and nothing keyed by hand
  beside the gateway's scales until the half-open backends end (TCP keepalive: over two hours on Linux's defaults unless
  the database's tcp_keepalives_* are set; no idle timeout, X42; or a superuser ends them); a server started meanwhile,
  or the new server of an overlapping deploy, refuses to start; a cluster that deploys with overlap declares 16 with
  `select kernel.apply_listener_share(16);` or stops the old server first; 8k counts both servers of an overlapping
  deploy; a correction note), X38 (the share's wording, pointer to X41), the kernel 0980 header (unreleased, edited:
  the same, and the 8k rule), M6-C5 (still open; tests), the global set-up's header. Kernel 0980's EBMR-SBX-037 message
  said "room to replace them": now "the 5 connections it keeps open and 3 spare to replace lost ones".
  Tests: packages/kernel/test/security/listener-roles.test.ts (4) asserts the SBX-037 message's wording. New
  apps/tablets-server/test/devices/listener-one-share.test.ts (3, [DI-30][PR-20]): the listener runs on a login of its
  own (t_listener_share_<hex>, outside the ebmr_ names; dropped after the file) holding in its database exactly
  ebmr_sandbox_listener's privileges (sandbox.role_mirror_differences, empty afterwards) and limited to the share kernel
  0980 gives where none was declared (read from kernel.apply_listener_share in a transaction that is rolled back, taking
  pg_authid's lock first as the function does, so a test changing roles beside it waits rather than deadlocks), since
  the real listener roles hold the test cluster's 40. (1) The share is RECEIPTS_POOL_MAX + WATCH_POOL_MAX + 3; beside
  4 other connections of the login the server's listener does not start (too many connections for role) and keeps
  nothing open; beside 3 it starts and fills the share. (2) Through a TCP relay that cuts the listener's side of a
  connection and keeps the database's open (a half-open backend): after 10 s clean the database vouches; 3 receipts
  connections cut one at a time are each replaced at once, the share is full and it still vouches; a 4th is not
  (REWARM_FAILED_LOG at warn, SQLSTATE 53300); with the watch's connection cut too, TICK_FAILED_LOG at warn, no tick
  lands and nothing is vouched for; once the half-open backends end, ticks land and it vouches again. (3) Beside an old
  server's running listener the new server's listener does not start and the old one goes on ticking; with the login's
  limit at 16 (what kernel.apply_listener_share(16) sets on the listener roles) it starts beside it. Mutations (each
  reverted, compared byte for byte), all killed: the SBX-037 message back to "room to replace them" (the kernel test);
  kernel 0980's least share 9 instead of 8 (all three cases); a refused start that leaves its pools open (case 1); a
  failed rewarm not logged (case 2 alone); and, of the test itself, a relay that closes the database's side too (no
  half-open backend: case 2 alone). Runs: listener-one-share.test.ts and listener-share-setup.test.ts;
  listener-roles.test.ts; apps/tablets-server/test/devices and packages/kernel/test/security together (both projects,
  18 files, 161 tests); typecheck; eslint of the changed TypeScript files. Afterwards the cluster had 88 databases, the
  test share (40/57), no t_listener_share_ login and no test process left.
- 2026-10-01: AGREEMENT EXHAUSTION CHECK (round-1 verification of agreement-property-budget, problem
  agreement-property-budget; no new default). Root cause: the second generated-shape property of agreement.test.ts
  followed an exhausting simulator path through the engine with no one deciding its LOOP_EXHAUSTED exceptions, and
  checked only that the engine raised the path's first exception. On a path that exhausts two loops side by side the
  engine may raise the other loop's exhaustion first; while that one is open QA rightly may not release a hold point in
  the first loop (ENG-HOLD-OPEN-EXCEPTIONS), so the engine stopped before the path's first exception and the property
  failed on about 1 generated shape in 1,500-10,000 (par[loop(hold, max 2), loop(phase, max 1)], recorded above as
  found, not changed). Fixed without loosening: the autopilot (test/engine/support.ts) takes an opt-in
  Scenario.qaDecides; each open exception it accepts is decided by QA as soon as it is raised (a deviation linked where
  one is required, then QA's signed disposition); without it the autopilot is unchanged (a blocking exception stops the
  run). The second property has QA decide each LOOP_EXHAUSTED and now requires (1) the engine's LOOP_EXHAUSTED
  exceptions to equal all of the path's exceptions, one at each place (loop and context, so the iteration), whatever
  the order of raising: stricter than containing the first; (2) the run to complete; (3) its steps to be the path's
  (the first property skips exhausting paths, so their steps were never compared). The two-loop shape is pinned
  (TWO_LOOPS_SHAPE) after HEAVY_SHAPE, so every run checks it: 6 paths, all searched, 4 exhausting paths checked, one
  with both loops exhausted (the property asserts the per-path exception counts [1, 1, 1, 2]; HEAVY_SHAPE [1, 1, 1, 1]).
  Test renamed ('... is an engine run with exactly its LOOP_EXHAUSTED exceptions, one at each place, and with QA
  deciding each it completes with the path's steps'), DI-34 updated; the file header and the engine README describe the
  check, and the README now says that above 100,000 paths the search for exhausting paths is capped there and runs
  driven to exhaustion at each loop are added when it finds fewer than 4.
  Mutations (each reverted, compared byte for byte), all killed: the check as it was (first exception only, no QA
  decision), with the pinned shape: "expected [ 'loop8@loop8=1' ] to include 'loop3@loop3=2'", the CI failure; no QA
  decision (HEAVY_SHAPE stops, STUCK), or that with only the equality checked (pinned shape: [loop8] against [loop3,
  loop8]); the autopilot ignoring qaDecides (STUCK); the simulator keeping only a path's first exception (pinned shape:
  [loop3, loop8] against [loop3]); with the check comparing only the first exception, that simulator mutant passes the
  property and is caught only by the pinned shape's counts.
  Runs: agreement.test.ts (7 passed, 18-20 s, was 15 s: exhausting paths now run to completion);
  packages/recipe-core/test/engine (18 files, 118 tests); a stress copy of the second property in the scratchpad
  (outside the repo), the pinned shape first: 4,000 shapes with each of seeds 42, 1952514567 (the earlier failing stress
  run's) and 7, and 10,000 with each of seeds 42, 1952514567 and 99, all green (each 10,000-shape run checked 5,773-6,093
  exhausting paths, in 269-302 shapes a path exhausting 2 loops); typecheck; eslint of the changed TypeScript files;
  register:validate (241 controls); the DI-34 entry matches the test's full name in a JSON report.
- 2026-10-01: CLOCK AND TAG, ROUND 2 (round-1 verification of clock-and-tag; new default X44). Root cause:
  platform/clock.ts's uptimeMs was Date.now() less the start time, so both lifetimes of the tickets the server keeps in
  memory (proof tickets, ten minutes, X26; first-login change tickets, two minutes, C0-2) followed the host's wall
  clock: a clock set back let a ticket outlive its lifetime, and X26's "counted on the server's uptime" read as a
  monotonic clock. Now clock.ts reads each moment from the monotonic clock (performance.now()) and the wall clock
  (Date.now()), and elapsedMs is the larger of what the two say (X44): a clock set back does not lengthen a ticket, nor
  does a suspended host (the wall clock counts that time); a clock set forward shortens the tickets made before the step
  (the stricter side; tickets made after it live their full time). ProofTickets keeps each ticket's moment of proof and
  still takes a clock of its own (device-nonce-limit.test.ts now passes a moment with both clocks equal; its assertions
  are unchanged); ChangeTicketStore keeps each ticket's moment of issue (CHANGE_TICKET_TTL_MS exported). uptimeMs had no
  other user and is gone. The ESLint clock ban (eslint.config.js) now allows Date only where it cannot read the clock
  (new Date(value), Date.parse, Date.UTC, Date.prototype, instanceof, types, member and key names), so Date() without
  new (with or without arguments, optional call too), Date.call, a copy of Date, Date passed as a value, a subclass of
  Date and `const { now } = Date` (renamed, in an assignment or a parameter default) are caught; Date as a member of
  any object (globalThis.Date, globalThis['Date'], a copy of globalThis) is caught; new Date() with spread arguments is
  caught. Each form is reported once. No file of the repository uses any of these forms (`eslint .` passes). X26 and
  C0-2 point to X44; REPO-GUIDE's clock rule updated.
  Tests: apps/tablets-server/test/session/proof-ticket-clock.test.ts (3, was 1, [DI-19]; clock.ts is no longer mocked:
  performance and Date are faked, and vi.setSystemTime steps the wall clock alone): ten minutes with both clocks
  running; with the wall clock set back an hour the ticket still lapses after ten minutes of the monotonic clock; with
  it set forward ten minutes (less the second that passed) it lapses at once, and a ticket proven after the step lives
  its ten minutes. New change-ticket-clock.test.ts (3, [DI-15]): the same for the two minutes.
  tools/boundaries/test/clock-ban.test.ts (30, was 9, [meta]): the seven Date.now forms (bind(Date) now also reports
  Date passed as a value), 21 other forms each caught once by the selector named, 14 allowed forms not caught, and the
  files the ban is on and off for (unchanged). Mutations (each reverted, compared byte for byte), all killed: elapsedMs on
  the wall clock alone (the behaviour before): both set-back tests; on the monotonic clock alone (the verifier's
  proposal): both set-forward tests; ProofTickets' default clock reading the wall clock for both: the proof set-back
  test; the ban as the round before left it (the Date.now member and argument-less new Date only): 20 clock-ban tests;
  without the value selector: 14; without the member selector: 5; without the spread case: 1; the value selector
  without its Date.now exclusion (each Date.now form reported twice): 7.
  Runs: the whole server project (68 files, 514 tests) and tools/boundaries/test (2 files, 33 tests), both green;
  typecheck (tsconfig.json); `eslint .` (clean with the extended ban).
  Found, not changed: a syntactic rule sees names, not values: a name built at run time (Reflect.get(globalThis,
  'Da' + 'te')) is not seen. The member selector also flags a member named Date of any object (none in the
  repository). Clock reads other than through Date are outside the ban: performance.timeOrigin (a wall-clock time),
  Intl's format() without a date, and the monotonic performance.now() and process.hrtime, which domain code may use for
  intervals (the tap rate limit, the kiosk signing's badge); a grep finds none of the first two in the apps or packages.
- 2026-10-01: LISTENER SHARE EXACT (round-1 verification, problem weakening-1: the [DI-17][DI-30][PR-20] limits test
  could no longer fail in CI on a kernel 0980 that applies no share; no new default). Root cause: the server tests'
  global set-up declares a share of 40 before any test file runs, so the limits of the cluster as it stands are the
  declaration's, and the rewritten test checked them only for being levelled (listener role 8 or more, application
  role at the slots less that share), where at base it required exact values (ebmr_app at the slots less 8); its
  rolled-back part calls kernel.apply_listener_share directly, which shows the function, not that the migration calls
  it. LISTENER SHARE CHECK (above) added a check in the set-up that fails a fresh cluster's run, and a committed
  migration of a database to 0980 with larger declared shares; neither requires the exact values, and neither runs the
  path a fresh cluster takes (the migration creating the listener roles), so a 0980 that gave a fresh cluster another
  share, or applied it only where one was already declared, still passed every run. Now the [DI-17][DI-30][PR-20]
  migration test of packages/kernel/test/security/listener-roles.test.ts (still 4 tests) first runs kernel 0980 as
  written (the file's text, as the runner applies it) on the database the previous kernel version left, in a
  transaction rolled back at the end, with pg_authid's lock taken first as 0980 takes it, twice from a savepoint: on a
  fresh cluster's roles (both listener roles renamed aside for the transaction, since other databases hold privileges
  for them and they cannot be dropped, so the migration creates them; both application roles unlimited) and on the four
  roles existing with no limit. Both must come out exactly: ebmr_listener and ebmr_sandbox_listener 8, ebmr_app and
  ebmr_sandbox the slots less 8 (the base test's exact value for the application roles; the listener roles' -1 of the
  base is the hole X41 closed); 0980 not yet applied to the database, and the cluster's limits unchanged afterwards.
  The committed migration with declared shares follows as before. The check of the cluster as it stands stays a
  levelling check and now says so (the exact values are required of the migration). No production file changed.
  Mutations of kernel 0980 (each reverted, compared byte for byte by checksum), each in a CI-style run
  (listener-roles.test.ts and read-db.test.ts, `--project db --project server`) on the development cluster holding the
  test share (40/57), with the new part and with it removed: without the `select kernel.apply_listener_share();`
  (the verifier's mutant): failed with it ('a fresh cluster': all four -1) and without it (the committed migration
  leaves the application roles at -1); the call made only where a listener role already holds 8 or more: failed with
  it (all four -1), passed 5/5 without it; the listener roles created with CONNECTION LIMIT 16: failed with it (16 and
  81 for 8 and 89), passed 5/5 without it (on a fresh cluster the set-up's check passes it too: 16 is at least 8 and
  levelled). Unmutated baseline CI-style 5/5. Runs: listener-roles.test.ts alone (4); packages/kernel/test/security
  and /sandbox with apps/tablets-server/test/devices/listener-watch, listener-one-share, listener-share-setup and
  read-db (CI-style, both projects, 12 files, 66 tests), green; typecheck (tsconfig.json); eslint of the changed file.
  Docs: X41 (what listener-roles.test.ts requires), M6-C5, the kernel sandbox README, the server set-up's header.
  Afterwards the cluster had 88 databases, the test share (40/57), no t_aside_ role and no test process left.
- 2026-10-01: PHASE 1 TYPESCRIPT MUTATION TESTING (branch phase-1/ts-mutation-kill; workflow wf_a43da513-f00: one fixer
  per file group, a skeptic re-running Stryker and checking every equivalence claim, then a full verify). Stryker on the
  16 kernel targets: 98.40 % overall (3,848 killed + 23 timeout of 3,934 scored; 56 survived, 7 no coverage; 35
  mutants disabled by a justified one-line comment each, all re-checked). Every file is at least 90 %; strict worst
  case without doubtful kills: instant.ts 92.4 %, keys.ts 98.95 %. 13 new test files, two extended. `pnpm run ci`
  passes (147 files, 1,254 tests). Defects found and fixed, each with a test that fails on 2da5ba1:
  state/extract.ts accepted transition targets and initial states that are not own states of the machine (lookalike
  objects, inherited names such as __proto__), actions on the initial transition and eventless root transitions;
  time/instant.ts read the years 0000-0099 as 1900-1999 (Date.UTC quirk). Follow-ups noted, not changed here:
  protected-numbers.test.ts '[DI-45] a completed restore event…' depends on earlier tests (false kills under Stryker);
  security-baseline confValue matches postgresql.conf names case-sensitively (PostgreSQL does not: 'SSL = off' after
  'ssl = on' passes the template check); validateRuleTableDocument throws EBMR-MKT-020 instead of returning a problem
  for a method/type mismatch with a hard floor (still fails closed); verifyTrueCopyBundleText ignores a leading UTF-8
  BOM; Instant.parse truncates 7-9 fractional digits where PostgreSQL rounds; canonicalJson writes Date/Map/Set as {};
  generateSecret('PIN') loops for pinLength <= 1. Next: PR to main, merge, merge main into phase-2/recipe-core.
- 2026-10-02: PHASE 1 FOLLOW-UPS, TEST SET-UP AND DEMO FINDINGS (branch phase-2/recipe-core, done by hand while the
  workflow agents waited for their usage limit; each change with a test that fails on the code before it, Stryker on
  every changed kernel function at 100 %). Security baseline: the postgresql.conf template check now reads the file as
  PostgreSQL does (names in any ASCII case, "=" optional, quoted values and their escapes, Boolean and enum values as
  the server reads them, the last setting winning); include directives (EBMR-SEC-053) and lines the server cannot read
  (EBMR-SEC-054) are findings. Compared with postgres -C on 464 files: no file passes that the server would run
  without TLS, TLS 1.2+ and SCRAM. The TLS template's header recommended include_if_exists, which starts the server
  without TLS when the file is missing; it now says include, as the last line. Canonical JSON (e-signature content,
  expression evidence and request hashes, continuity ledger, command hashes, market rules): a Date, Map, Set, typed
  array, class instance, array hole or undefined element is refused instead of written as {} or an empty position;
  the market writer also refuses NaN and the infinities; a ledger entry that cannot be written rejects append() and
  leaves the file untouched. generateSecret refuses a PIN length below 2 or not whole, and a password minimum that is
  not a number (EBMR-IAM-110), instead of looping or giving an empty password. Instant.parse rounds 7-9 fractional
  digits as PostgreSQL does (double times a million, ties to even, carry into the next second; compared with
  '...'::timestamptz on 13,493 fractions, no difference). True copy: a byte order mark added in front of a bundle is
  an alteration. Market rule validation: a key whose method misfits its value type is reported (EBMR-MKT-015), never
  thrown out of validateRuleTableDocument as EBMR-MKT-020. protected-numbers.test.ts: a test whose earlier step of
  the restore history did not run is skipped (Stryker runs only the covering tests); a full run is unchanged. Test
  set-up (task 19): the kernel test template is created from template0 as UTF8; the server harness passes the test
  cluster's host and port to the configuration (the listener's own login went to 5432); checked on a cluster on 5433
  with a SQL_ASCII template0. Owner's demo findings: the live gauge reopens a failed stream (1 s doubling to 15 s), lets
  it go while the page is hidden (six connections per server for all tabs) and never shows a weight whose stream has
  gone; a Save that cannot be pressed says what is still needed; a gross not above the tare is said before anything is
  sent (a refused entry uses its readings up); a reload asks first while a form holds unsaved values; the "Saved" note
  goes once the step has moved past the save; an address that does not exist gets a plain page offering it without a
  stray full stop. Still open from the demo: the first signing tap refused (EBMR-IAM-140): needs the owner's
  iam.authn_attempt rows. Also fixed: session-control.test.tsx checked the session before the session control had
  registered itself (an effect a loaded runner can run after the text the test waits for); the checks now repeat until
  they have their effect. `pnpm run ci` (357 files, 3,027 tests) passed apart from that test, fixed and re-run under
  load; end-to-end 20/20. The Phase 2 exit review read the code before these commits: each of its findings is
  re-checked against this branch before it is fixed.
- 2026-10-02: OWNER DECISION (docs/decisions/0006, by default): a company formulation library with "Choose a product"
  in Phase 3 (quantities computed with the potency, assay and LOD adjustment, TB-01); an example generics pack from
  public sources in Phase 6, labelled as examples and never issuable for a GMP batch until a site approves one as its
  own formula. No real company's formula ships.
- 2026-10-02: PHASE 2 EXIT FIX, Rules the database must enforce (branch phase-2/recipe-core; findings F11, F66, F67,
  F37, F38, F12, F58 of the exit review; each fix with a test that fails on the code before it). F11: a person who
  worked in the step that raised an exception could disposition it through the store (the content provider named
  only the raiser); now the provider names the step's performers, data enterers, correctors and PERFORMED signers
  (the kernel refuses the signature), check_disposition_state refuses the row (EBMR-EXE-087) and the invariant query
  reports it (recipe-core 0306). F66 (critic, reproduced): the database let a row enable a step the token could not
  have reached, and the server then started the dispensing during the line clearance; now every new step instance is
  checked against the MBR's flow (steps before it finished, stages signed off, loops ended, decisions taken, frames
  right) and the completion marks and stage sign-offs it reads are bound to their rows (recipe-core 0307,
  EBMR-EXE-129). F67 (critic, reproduced): a PERFORMED signature before a 1 h minimum, and one of a step blocked by its
  open action-limit breach, were stored through the store; now minimum durations, exception blocks and hold-point
  release with open exceptions are refused in the database (recipe-core 0308, EBMR-EXE-130/131). F37: a second QA
  user's proposal made during a signing landed on the signed content version (the signature read CONTENT_MISMATCH);
  the proposal functions now take the batch's lock first and never propose on a signed version (recipe-core 0309).
  F38: the reading age was the caller's word (up to 1 h); now the platform setting device.reading_max_age_s (120 s,
  only tightened) caps it (tablets 0360). F12: a real previous batch number was recorded in a test run; the server
  and the database (tablets 0370, EBMR-EXE-078) now accept only TEST- identifiers in entries (NONE for no previous
  batch) and only registered test lots as the register holds them. F58: a weighing refused as stale spent its
  readings; the server now checks the version before it claims anything, and the floor form keeps its captures after a
  stale answer. Tests: recipe-core step-order-sql, step-acts-sql, sql-guards and signing-content; server
  db-guards-disposition-involvement, db-guards-step-order, db-guards-step-acts, db-guards-proposal-race,
  db-guards-entry-identifiers, devices/reading-age-policy and devices/stale-weighing-readings; web entries.test.tsx.
  Defaults taken are in docs/decisions/phase-2-open-questions.md (F66.1, F66.2, F67.1, F37.1, F38.1, F12.1, F58.1).
  Round 2 (after the adversarial verification): the database now reads involvement from the accepted command rows
  (F11, 0310), binds a step's status changes to the act that makes them (F66, 0311), the start and end events to the
  acts and token arrivals that make them (F67, 0312, 0314) and a stored entry to its command and test identifiers
  (F12, 0313, tablets 0380); each with a test that fails without its migration.
  Round 3: the step an exception was raised at is also read from the row that raised it, not only from the source the
  writer stores (F11, 0315; a person involved in either step is excluded, default F11.1); the row that finishes what an
  operation, parallel, alternative or replicate section holds records its END wherever it lies, the last one of the
  batch included (F67, 0316); a container a row registers is the one its entry names and a test identifier (F12, 0317,
  tablets 0390); each with a test that fails without its migration.
- 2026-10-02: PHASE 2 EXIT FIX, What is signed and what the signer sees (branch phase-2/recipe-core; findings F01, F02,
  F03, F40, F39 of the exit review; each fix with a test that fails on the code before it). F01: a stage sign-off's
  meaning confirms the stage record and its summary, but the summary was in neither the signed content nor the
  signature dialog, so an alert raised or a QA disposition made after the supervisor's preview changed what the sign-off
  recorded without refusing the signature; now the summary (statement, step counts, exceptions, deviations, yields) is
  part of the signed text, derived by one function for the sign-off and the content and by the database's provider
  from the stored state (recipe-core 0319), shown as signed in the dialog; a change after the preview refuses the
  challenge or the signature as changed content, and the database refuses a sign-off row recording another summary
  (EBMR-EXE-135); sign-offs made before 0319 keep the text they were signed on. F02: a time-limit breach's disposition
  dialog said "Not raised at a step" while the signed content names the step and the constraint; now it names both, and
  step counts of open exceptions include such breaches. F03: the header shown as signed took the family, product name
  and version from the test package's own metadata; now it names the MBR content's family and product, shows the
  version label apart as not signed, and the server and the database (recipe-core 0318, EBMR-EXE-134) refuse a package
  whose metadata differs from its content. F40: a kiosk sign request resent after its signing succeeded was told
  "Nothing was signed"; now it is told the request was used (ESIG_ALREADY_SIGNED, or ESIG_REQUEST_USED while another
  request's signing runs or was refused). F39: a switch from the lock screen (or one the session poll finds) left the
  previous person's signing dialog open, and the new person signed the previous person's decision; now any change of
  person or the end of the session ends the signing with nothing signed. Tests: server signed-content-stage-summary,
  db-guards-stage-summary, db-guards-package-header, signed-content (F02, F03), esig ceremony (F40); recipe-core
  stage-summary-sql; ui-kit signable-content; web ceremony-person-change and step-screen; Playwright journey and access
  specs re-run. Defaults taken are in docs/decisions/phase-2-open-questions.md (F01.1, F03.1).
  Round 2 (F01): the list of sign-offs made before 0319 was owner-only and not audited, so the recipe privilege test
  failed, and the sign-off check compared only the summary's canonical form, so a row could add a member of its own (a
  step count, a yield verdict), list a deviation twice or forge the end time, signer or time under a valid signature;
  recipe-core 0320 refuses any sign-off that is not exactly what the engine records (EBMR-EXE-135) and makes the list
  an audited, insert-only record of its batch the application reads. Tests: server db-guards-stage-sign-off and
  db-guards-stage-summary, recipe-core stage-summary-sql and lifecycle authorization.
- 2026-10-02: PHASE 2 EXIT FIX, Read authorisation and the cross-installation surface (branch phase-2/recipe-core;
  findings F34, F35, F36, F41, F42, F43 of the exit review; each fix with a test that fails on the code before it).
  F34: the signing preview served the kernel's content of any record for any meaning to any session (a data-integrity
  investigation reached the person it investigates) and the signature list of any record; now the database decides for
  the request's session (tablets 0410): RECORD-class records with RECORD.READ, investigations, disposals, restores and
  any type not named only in a governance or audit role and never to an investigation's subject, a preview only with a
  meaning the role signs (on the shop floor the person who taps is checked at signing), the kernel's provider only for
  the pairs signed that way here; the application role lost the kernel's content and signature readers, the
  investigation tables and the GOVERNANCE-class rows of the signatures and signing requests. F35: the audit viewer
  served every chain, and a colleague's activity across chains, to every role; now the database serves only the chains
  the session may read (tablets 0420, same classes), a person filter on another person needs a governance or audit
  role, verification only of a readable chain, and the application role has no SELECT on the audit tables. F36: a
  revoked or expired role kept reading and the session could be kept alive or unlocked; now such a session resolves no
  role, ends at its next request, cannot be kept alive or unlocked (tablets 0400, EBMR-TAB-017), and an account with no
  role opens no session. F41: a page on another port could plant a copy of the session cookie that the server took
  first (lock-out or another person's session); now a doubled session or CSRF cookie is served as nobody, the copies
  are removed and the page sends the request once more. F42: the sign-out mark was also a cookie any port could write
  or delete (forced logouts, a pending sign-out looking finished); now it lives in site storage and this origin's
  broadcast channel only. F43: the gate's own refusals (403 ORIGIN, the non-literal /api 404) and Fastify's bad-URL
  answer carried no security headers; now helmet runs first and the framework errors carry its headers. Tests: server
  security, session role-withdrawn and sign-out, esig and audit read-authorisation; web api and sign-out screens;
  Playwright security spec (two new browser tests), esig, audit and journey specs re-run. Defaults F34.1, F35.1, F36.1
  and F42.1 are in docs/decisions/phase-2-open-questions.md; ADR 0012 item 9 and ADR 0017 record the rules.
  Round 2 (F34, F35): with no session token the application role still read investigations, chains and GOVERNANCE-class
  signatures through the kernel's own readers (scoping report, a person's activity, chain extract, evidence package,
  chain lists, anchor heads) and the signatures' side tables, and a subject with a governance role still read the holds
  an investigation places, the hold entries on their own records and the account chains and activity of the persons
  investigating them. Tablets 0430 revokes those readers and tables and limits the seals, ID register, content changes,
  invalidations and signing failures to RECORD-class rows; 0450 takes away the disposal, tombstone and restore registers
  and the integrity lists that named GOVERNANCE-class signature ids; 0440 withholds all of the above from an
  investigation's subject whatever their role (open or closed), and refuses a person filter on its opener or lead.
  Tests: server esig and audit read-authorisation (a QA reviewer as subject; database refusals on both installations);
  audit Playwright spec re-run. Defaults F34.2 (owner residual: the identity, incident and retention tables the
  application role still selects directly) and F35.2 recorded; F34.1, F35.1 and ADR 0012 item 9 corrected.
  Round 3 (F34, F35): without a session the application role still asked the kernel what blocks a record (on the
  account of the person investigated: the investigation, its concern and its hold), who acted on a chain or a row (the
  opener), whether a chain exists (checkpointing a hold chain told who is held), the entries of a time fault and the
  persons excluded from a signing; and a subject's chain verification still named the accounts and terminals of
  entries withheld from them. Tablets 0460 and 0470 revoke those functions and tables from the application role (both
  installations) and filter the subject's registry chains. Tests: server esig and audit read-authorisation (each door
  'permission denied', the owner still reads; the subject's registry chains without the withheld actors); audit
  Playwright spec re-run. F34.1, F34.2, F35.1, F35.2 and ADR 0012 item 9 corrected.
- 2026-10-02: PHASE 2 EXIT FIX, Login, PIN, session and audit screens (branch phase-2/recipe-core; findings F04, F05,
  F06, F07, F08, F09, F10 and F56 of the exit review, and lead TODO T1; each fix with a test that fails on the code
  before it). F56, the owner's refused first signing tap (EBMR-IAM-140): the signing dialog's focused Badge field
  sent whatever was keyed into it (the PIN) as the badge UID, and any refusal of the tap ended the signing with Close
  only; now the ui-kit badge prompt takes only a reader's tap (a key more than 100 ms after the previous one starts
  the field afresh, so a stray key is never part of the badge) and sends nothing that cannot be a badge UID by the
  kernel's rule (it says "That is not a badge. Nothing was sent"), and a tap the server refuses returns to the tap with
  the refusal shown in the prompt. T1: the kiosk sign-in uses the same ui-kit BadgePrompt and PinPad as unlock, switch
  and signing. F04: a first-login PIN change left open on a shared kiosk let the next person choose the absent
  person's PIN; now the kiosk keeps no badge UID for it, wipes it after 30 s without input, names whose PIN it sets and
  asks for the badge again to confirm, and the database refuses the change on a shared terminal once its
  authentication is older than the terminal's attribution window (kernel 0990). F05: a PIN longer than the 12 digits
  every pad takes was accepted and could never be typed; the kernel now refuses it (one maximum for the pads, the
  contract and the kernel). F06: a chain whose head row was deleted vanished from the chain list and "Verify chain"
  said it never existed; now it is listed and verified, and the kernel names the deleted head (tablets 0490). F07: a
  failed re-verification left the earlier green "Chain intact" beside the error; now only the latest answer shows.
  F08: a sign-in, PIN change, unlock, switch or signing that could not get a device nonce failed without a word; now
  it says nothing was sent and why. F09: the kiosk sign-in said "Sandbox" on the GMP installation. F10: an account
  with no live role saw an empty role choice; now it is told why and who handles role grants, and the database binds
  no session for it (tablets 0480). Tests: web session (sign-in-screens, secret-inputs), access (keyed-badge,
  no-device-proof) and audit screens; ui-kit identity, audit and ceremony machine; server session (kiosk-secret-change,
  pin-length, no-role-binding, change tickets) and audit view-integrity; kernel identity secrets and credentials.
  Stryker on the changed lines of identity/secrets.ts: no survivor. Playwright audit, access, esig, smoke, floor,
  devices and journey specs re-run: all passed. Defaults F04.1, F05.1 and F56.1 are in
  docs/decisions/phase-2-open-questions.md.
- 2026-10-02: PHASE 2 EXIT FIX, U+0000 and lone surrogates in free text (branch phase-2/recipe-core; findings F30,
  F31, F32 and F33 of the exit review; each fix with a test that fails on the code before it). What was wrong: the API
  contract took any string, so a U+0000 or a UTF-16 surrogate without its other half in free text (an exception's
  description, a previous batch, a deviation number, a hold reason, a TEXT value, an MBR step name, a save note, a
  product name, a justification, a disposition justification or hold-point comment in the signing preview) reached a
  jsonb or text bind; PostgreSQL refused it without an EBMR code and the server answered 500 INTERNAL, wrote no
  refused row, and had already shown the signer a hash for content it could never store. A hold reason with U+0000
  was accepted and stored escaped. A lone surrogate sent as a text parameter, and bytes that are not UTF-8, were turned
  into U+FFFD on the way, so a justification was stored with a character its author never sent. Both TypeScript
  canonical JSON writers wrote such text and disagreed on the order of such keys. What changed: canonicalJson in expr
  and in the kernel refuses such text in strings and member names (UnstorableTextError, EBMR-ESIG-004), so no client
  hashes what the server cannot store (Stryker on esig/canonical.ts: 100 %). The contract (defineRoute, storableText)
  refuses it in the params, query and body of every route, at any depth, with 400 INVALID_INPUT naming the field and
  never the text; the preview's decision is decoded as strict UTF-8 and checked; request bodies that are not UTF-8 are
  refused before they are read; the server's pools refuse a query parameter holding such text before the driver
  encodes it; the error mapper answers the database's refusals (22P05, 22P02, 22021) and the guard's 400, never 500;
  flow.parseMbr names each place; a kiosk refuses such a body before it asks for a nonce; the gateway login refuses it
  as SCHEMA, and a heartbeat the database refuses for it is answered 400 with its receipt still lost. The database's
  refusal stays the last line. Tests: kernel esig canonical and signing (TS against SQL), expr evidence, recipe-core
  canonical-json and flow model, api-contract contract; server execution/free-text, designer/free-text,
  platform/unstorable-text and devices/gateway-free-text; web api. Playwright smoke re-run: passed. Defaults F30.1,
  F30.2, F30.3, F31.1 and F33.1 are in docs/decisions/phase-2-open-questions.md.
  Round 2 (after the adversarial verification): the execution store README did not list the new free-text test, so its
  README test failed; it is listed now. The web designer hashed the content it shows while it rendered, so a title
  holding U+0000 brought the whole editor down; its edit operations now refuse such text before it enters the content,
  naming the field (web designer free-text and ops tests). The gateway listener, a Fastify server of its own, still
  read JSON bodies with U+FFFD in place of bytes that are not UTF-8 (a heartbeat reason recorded, a login name looked
  up and its alarm stored holding it) and answered unreadable requests 500; it now reads them as strict UTF-8 and
  answers 400 SCHEMA, a heartbeat with a token whose bytes are not UTF-8 counting as lost (gateway free-text tests; the
  designer test now sends F0 9F 98, a sequence the old reader did read). Defaults F31.2 and F33.2 added.
- 2026-10-02: PHASE 2 EXIT FIX, Shop-floor screens under real use (branch phase-2/recipe-core; findings F57, F59, F60,
  F61, F62, F63, F64 and F65 of the exit review, and lead TODOs T2, T3 and T4; each fix with a test that fails on the code
  before it). F57: the "Saved" note fix reset a saved entry once the step moved on, which brought a still-open floor
  dialog back with the same words and Send enabled (a second Send raised a duplicate exception or hold); now only the
  note under a step form goes and a dialog stays done until it is closed. F59: after any refusal the weighing form
  threw both captured readings away, though only an engine refusal (committed with its claims) spends them; now the
  server names the readings an engine refusal used, the form drops exactly those (or the one a claim refusal names) and
  keeps them after a badge or PIN not accepted, a locked session or an unknown lot; tare and gross from two scales or
  in two units are said before sending, and each capture shows its age against the 120 s. F60: a send with no answer
  stayed "Saving..." for good; a floor entry, an issue, an import and a signature now give up after 30 s, abort the
  request and count it as lost (NOT SAVED with resend under the same key; a signature reads the signatures again).
  F61: each capture slot opened its own live stream (two per weighing form against the browser's six connections per
  server); now one stream per scale and page serves every gauge. F62: after an unlock the gauge waited up to 15 s for
  its next retry; now the stream stops at the lock and opens at once at the unlock or a switch. F63: the reload guard
  covered the step entry forms only; the four command dialogs, the hold-point and disposition dialogs and the issue
  form now ask first too. F64: a value card's greyed Save said nothing; it now names what is still needed (or that the
  number ends with its decimal point). F65: a run or step link with a sentence's full stop got a refusal no reload could
  fix or a PENDING screen for a key no step can have; such floor addresses are now the not-found page with the offer
  (search and fragment kept), and the server answers a step key not in the engine's form 404. T3: run-level
  exceptions are linked to a deviation and dispositioned by QA from the run overview. T4: screens name a step by its
  number and name and items and persons by their names where the engine's text names their ids (display only; the
  record and the signed content keep the engine's text). T2: a computed net and a total of nets keep the resolution
  of the weighings ("50.000 kg", not "50 kg"); this changes the engine's output, so it is engine 1.2.0 and test batches
  issued under 1.1.0 (the owner's demo database) are neither continued nor replayed: issue a new test batch; the
  database checks every new weighing's net (recipe-core 0321, EBMR-EXE-136). T5 (a simulated balance in BLEND-1) is
  still open: it changes what the scripted demo shows in BLEND-1 (the two-person manual path today) and needs the demo
  set-up, which this lane may not run against the owner's demo databases. Tests: web floor dialog-saved-stays-done,
  readings-after-refusal, send-deadline, draft-guard, entries, deep-link-punctuation, run-exceptions; web devices
  live-shared; web access ports; web app not-found; server devices refused-weighing-readings; server execution
  step-address, people-text, db-guards-weighing-net; recipe-core blocks material and engine version. Playwright floor,
  devices, esig and journey specs re-run: all passed. Defaults F59.1, F59.2, F60.1, T2.1 and T4.1 are in
  docs/decisions/phase-2-open-questions.md.
  Round 2 (T2, T5): a weight weighed in another unit than its quantity lost its resolution in the total (9250.0 g -
  1250.0 g on a quantity in kg was recorded as 8, not 8.0000) and the database checked neither a weighing's label (a
  label "50 kg" for a net of 50.000 kg was stored) nor the total; now each net counts at the resolution it was weighed
  at, carried through the conversion, a weighing is counted only in its quantity's unit or when both are metric mass
  units (else G07-UNIT, G22-UNIT), which is engine 1.3.0 (1.2.0 batches are no longer continued: issue a new test
  batch), and recipe-core 0322 refuses another label (EBMR-EXE-137) and a total other than the sum of all the step's
  weighings at their resolution, or a step signed performed without it (EBMR-EXE-138). T5 stays open for the owner,
  now recorded as default T5.1 with its plan. Tests: recipe-core blocks material and engine version; server execution
  db-guards-weighing-record; Playwright journey re-run: passed. Defaults T2.2, T2.3 and T5.1.
  Round 3 (T2): the database still took the quantity a weighing counts into from the entry's own item, so a second
  dispensed container stored without item (and an output container with item null) was left out of the signed total;
  now recipe-core 0323 decides it from the MBR (a dispensed container only at a G-07 step and into a mass quantity its
  phase records, an output container only at a G-22 step and into the first one; a compound unit fails closed) and
  refuses any other (EBMR-EXE-139). Tests: server execution db-guards-weighing-record (round 3), recipe-core execution
  weighing-item-sql; both fail without 0323. Default T2.3 corrected, T2.4 added.
- 2026-10-02: OWNER DECISION (amendment to docs/decisions/0006): the example generics pack (Phase 6) is dropped; no
  example formulas are built or used. The Phase 3 company formulation library and the potency-adjusted dispensing
  (TB-01) stay.
- 2026-10-03: OWNER DECISION (docs/decisions/0007): no designer usability test with three QA and production authors.
  Phase 2 exits on its tested criteria, the exit review's fixes, the SQL mutation run on the Phase 2 guards and the
  trace gate at phase 2.
- 2026-10-02: PHASE 2 EXIT FIX, Designer: what the document shows (branch phase-2/recipe-core; findings F44, F45, F46,
  F47, F48, F49 and F51 of the exit review; each fix with a test that fails on the code before it). The document view
  is what the author, checker and approver read, so it now shows every member of the saved master that decides how a
  batch runs, exactly as written. F44: it left out acceptance schemes, calculation limits, criticality and risk class,
  readings per capture, market rules, breach handling, time-constraint breach, warning and pauses, hold-time storage,
  specimens, market predicates, golden-case values and most of a step's facts; now each section renders them, and a
  completeness test walks every member of dc-mini, both tablet fixtures and a fixture setting every optional member
  and finds each value in its own place. F47: an exclusive limit bound read "3.5 %" like an inclusive one, and a
  cleared exclusive bound typed again came back inclusive; now every bound says "at least / more than / at most /
  less than" in every mode, the author sets it next to the value, and a bound is created only with its comparison.
  F45: the procedure hid an alternative's conditions, "otherwise" branch, variant values and choosing roles, a loop's
  endpoint and a replicate's sub-lot prefix, and ran branch bodies together; now the construct rows state the rules
  and each branch has its own row. F46: the steps a library call brings in had no row (2.4.2 jumped to 2.4.4) and a
  finding on one went nowhere; now they are shown read-only under their numbers with the call's bindings, findings
  lead to them, and content that cannot be numbered no longer brings the designer down. F51: a step's configuration
  was missing from the document and lists were cut at 120 characters; now it is shown in full in the panel and in
  every procedure row, with the system's recipe and version. F48, F49: a QA hold point could be released by any role,
  and a role no session carries (QA_SHOP_FLOOR, shown like QA) passed the gate; now the designer offers QA only and
  marks unknown roles, the validator (FLOW-ROLES, validator 1.1.0) and the engine's definition (ENG-DEF-HOLD-ROLE)
  fail the gate, and the database refuses such content in a revision or a test package (recipe-core 0324,
  EBMR-RCP-123). Tests: web designer limit-bounds, document-complete, procedure-constructs, config-shown, roles;
  server designer finding-locations and roles, execution db-guards-content-roles; recipe-core validator roles.
  Playwright designer and floor specs re-run: passed. Defaults F47.1, F48.1, F49.1 and F46.1 are in
  docs/decisions/phase-2-open-questions.md.
- 2026-10-02: PHASE 2 EXIT FIX, Designer: forms, drafts, simulation, contract examples (branch phase-2/recipe-core;
  findings F50, F52, F53, F54 and F55 of the exit review, lead TODOs T6 and T7; each fix with a test that fails on the
  code before it). F50: a leftover unsaved draft (D7) was keyed by version only, survived sign-out and was offered on
  any version, so a checker could restore another author's limits under "it can no longer be edited"; now a draft is
  the signed-in person's (format 2, key with the person id), a version that is not a DRAFT always shows its saved
  content (the author's own leftover draft can only be discarded), and every designer draft goes at sign-out. F52: an
  optional yes/no member shown as an unticked box was applied as yes by the block (G-05 blockOnUnexpected, G-23
  witness, G-08 chargeAll, G-14 showFormula), and "no" could never be recorded; now each optional boolean declares what
  its absence means (outside the registry fingerprint) and the form offers block default (value), yes or no; the
  document lists the members left to the default. F53: a whole number the form did not take was dropped silently and
  left on screen; now it is refused in words with the schema's range and nothing is committed. F54: the simulation
  report showed every path as an exception-free COMPLETED run (180 of 600 granulation paths exhaust the drying loop)
  and listed targeted runs twice; now each run names its LOOP_EXHAUSTED exceptions and the panel counts them and says
  when a list shows only its first 50. F55: the designer's contract examples were hand-written shapes the server
  never gives (non-MBR content, wrong hash, "1.0", ":" keys, contradicting evidence, no palette in fixture mode); now
  they are the server's own answers for dc-mini, compared with the server by a test, the step and run examples keep
  to the template's limits and their own asOf, and the designer says when the palette is missing. T6: TemplateView
  lists the template's approved batch sizes and the new-family form starts from them. T7: issue form, command answer,
  timeline, replay and lot examples from the sandbox server's answers; fixture mode answers them and the session.
  Tests: web designer editor, config-form, simulation-panel, new-from-template, app sign-out-screen, api
  contract-examples; server designer simulation-runs, contract-examples, routes; execution contract-examples;
  recipe-core blocks optional-defaults. Playwright designer, journey, floor and smoke specs re-run: passed. Defaults
  F50.1, F52.1, F55.1 and T7.1 are in docs/decisions/phase-2-open-questions.md. Open for the owner: the VALIDATOR
  evidence of start of verification counts only the static validator's warnings (F55.1); showFormula and
  showResidueYield have no reader yet (F52.1).
- 2026-10-02: PHASE 2 EXIT FIX, Tests that claim more than they check (server, engine, store) (branch
  phase-2/recipe-core; findings F13, F16, F17, F18, F19, F20, F21, F22, F23, F24, F25 and F29 of the exit review; each
  strengthened test fails when the guard it claims is removed, shown with a temporary mutant). The tests were green
  for the wrong reason: a refusal checked only as "some failure" or "some ENG- code", a guard reached only through a
  TypeScript pre-check, a rule shown only through another rule that fires first, made-up ids that never reach the
  branch named in the title, a substring two messages share, a model check once per step group, a sweep that may have
  skipped the batch, events compared by count, tags for a release screen and a dashboard that do not exist. What
  changed: F18 the computed value is typed into the step that computes it (ENG-DERIVED-TYPED, nothing else changes);
  F20 a stale screen writes nothing (rows, state, version); F21 the operator's deviation link is the database's
  EBMR-IAM-040 with nothing recorded; F25 the views test reads the timeline and the TEST, NOT GMP watermark; F16 the
  import writer's own refusals are tested without the server's pre-check, and the import passes the database the
  inbox file's real name (the file-name rule was the server's alone); F17 each list of the verifier rule (started,
  entered data, corrected, signed performed) is shown on its own, with a real data-enterer and corrector forgery;
  F19 real stored evaluations that were denied, made for another person, of another permission or in another command
  are refused with their own reason; F22 a test batch held by GMP is reported under its own message; F23 the golden
  run checks the model after every command, challenge and signature, and every signature is valid; F24 the sweeper
  reports what it found per batch (SweepResult.outcomes) and the tests show the batch was evaluated; F29 the engine's
  replay compares the events in full; F13 the raiser of an exception is refused its disposition by the kernel
  (EBMR-ESIG-044) and an involved person by the server (ENG-SEGREGATION), the PR-08 and PR-05 titles say what they
  test, and two unread literals left the limit evaluation. Tests: server execution store, db-guards-roles,
  db-guards-disposition-involvement, golden, sweeper, commands, import-db-guard; esig disposition; recipe-core engine
  golden, limits tiers, lifecycle review-inventory. Defaults F13.1-F13.3 are in docs/decisions/phase-2-open-questions.md
  (PR-08 release screen open until Phase 4, PR-05 dashboard open until Phase 6, the engine itself does not refuse a
  run-level exception's raiser).
  Round 2 (regressions): the limit module's README still documented operatorMayClear, which F13 removed; it now
  says the operator cannot clear a breach because the engine (ENG-ROLE) and the database's QA permission refuse it,
  and recipe-core limits/readme.test.ts fails on any name in the README that the module's code does not have.
- 2026-10-02: PHASE 2 EXIT FIX, E2E claims and the control register (branch phase-2/recipe-core; findings F26, F27,
  F28, F14 and F15 of the exit review; each fix with a test that fails on the code before it). What was wrong: the
  E2E evidence record wrote every passed step's expected text as its observed result ("as expected"), so the
  validation pack stated results nobody measured; the kiosk no-tap test claimed "records nothing" without reading
  the database, on an entry that did not exist; the other-room [DI-20] test checked only the screen text and an
  anonymous request, and still passed with the server's room gate removed; two package steps claimed a write-once
  file they never checked; the register never checked the tests a control lists (four named tests that no longer
  existed; DI-20 listed 28 of its tests) and counted one tagged test as proof of a whole catalog test, with
  deferrals kept only in PROGRESS.md. What changed: the evidence record lists the assertions each step made (with
  source lines and outcomes) and the facts it measured, and says "not checked" for a step that asserted nothing;
  access.spec sends its tapless signing request for a stub entry that exists and compares challenges, audit
  entries and authentication events before and after; devices.spec asks the server, from the BLEND-1 session, for a capture from and the live view of
  TEST-BAL-01 (403 SCALE_NOT_IN_ROOM, no reading added); `register validate` refuses a listed test its file does
  not declare and the trace one the run did not report or did not run; every control due by Phase 2 maps its
  catalog test, word for word, to clauses with listed tests or a deferral to a later phase (`clauses`,
  `deferred_scope`), and the trace fails a clause with no passing test and no deferral, or a deferral whose phase
  has started; a control with anything deferred is SPECIFIED (PR-05 and DI-12 went back). Deferred: PR-01
  packaging orders, DI-04 PLC mismatch, DI-13 formula permission (owner question), DI-24 delete/void offer, IN-02
  deviation classification, DI-33 reprocessing (Phase 3); DI-34 disposition before review, PR-07 repeated
  deviations, PR-08 release screen, DI-12 disposition screen, DI-24 review list and PDF (Phase 4); PR-05 dashboard
  (Phase 6). Tests: e2e evidence-record and spec-claims; register listed-tests-and-clauses and register. Playwright
  access, devices (also failing with the room gate removed, where the old test passed) and designer: passed.
  Defaults F14.1-F14.5, F15.1, F15.2 and F28.1 are in docs/decisions/phase-2-open-questions.md.
  Round 2 (F15): a control's tests list need not have named every test tagged with it (default F15.1, the weaker
  option), so 2,134 tagged tests were missing from 65 lists and nothing kept a list complete; CI never traced the
  E2E report. Now the trace refuses a passing tagged test its control does not list (from the run's names, so
  data-built titles count), `pnpm register:sync-tests` adds them from the reports, the lists are completed (2,134
  entries), and a CI traceability job runs the trace on both reports with the Playwright report required
  (`pnpm trace:e2e`). F15.1 and F15.2 rewritten. Tests: register listed-tests-and-clauses ("every passing tagged
  test is listed").
  Round 3 (regressions): a test that skips itself at run time (DI-47 retain-until on 29 February, DI-13 without TLS,
  DI-37 platform hook, DI-45 restore steps: 13 tests) had to be listed, but the trace refused it listed when skipped.
  Now the register reads from the source whether a test runs always, conditionally or never; the trace accepts a
  listed test skipped only when its source may skip it at run time, counts it as no proof and names it in its
  output. Default F15.3. Tests: register listed-tests-and-clauses ("a listed test that skips itself at run time").
- 2026-10-02: PHASE 2 EXIT FIX, Lead leftovers (branch phase-2/recipe-core; lead TODOs T8-T13; each fix with a test that
  fails on the code before it). T8 (decision C0-1): the installation bootstrap wrote three labels of its own ("Installation
  qualification", BOOTSTRAP-CONSOLE-1/-2) that a sandbox's identifier guard refuses, so the test kit applied the kernel in
  two stages and every sandbox kept three real-looking labels. Kernel 1000 gives the bootstrap TEST- labels in a sandbox
  (GMP keeps its labels) and its actor context the site policy's zone only (EBMR-IAM-118, nothing written); the test kit
  provisions a sandbox in one stage (every migration, then the bootstrap). T9: a site value of a set-valued key (ALL_APPLY
  criteria, SET_UNION) listed in another order than the resolved value was recorded and evaluated as TIGHTER instead of
  EQUAL; kernel 1010 adds market.same_value (sets by their elements, criteria by their full definition) used by
  market.assess_site_value, with the TypeScript twin isSameValue (Stryker on the changed lines 19/19, SQL mutation group
  site-values-and-policies 115/115 detected). T10: the site.zone policy check itself was already in kernel 0940 (K1);
  the same defect elsewhere: besides the bootstrap context, batch-number rules and registered numbers took any zone the
  database knows (Etc/GMT+5, another site's) to date {YY}/{MM} and the register; site-services 0700 refuses any but the
  site policy's (EBMR-SITE-002). T11 ("tsx at bundling"): the server's simulation worker and every app process load their
  TypeScript through tsx, which only the repository root declared as a development dependency, so an install of an app's
  runtime dependencies alone could not start it or simulate; tsx is now a runtime dependency of the tablets server, the
  site gateway and the simulators at the root's pin. T12 (decided by default T12.1): a critical value typed by hand whose
  MBR names a printout or photo as its evidence carried none (no attachment store yet), yet its step was completed by a
  later review (VERIFIED) that the validator allows only because the printout would be there; now such a step's check is a
  witness (WITNESSED) in engine 1.4.0 and in the database (recipe-core 0325, EBMR-EXE-051), the screen offers Witness and
  the FCV journey witnesses the blend step. T13: the pg_basebackup reproducer already reserved its WAL with a replication
  slot (692d013; re-checked under a WAL load generator: the version before failed 2 of 2 runs, the current one passed 3 of
  3); it now also drops the slots of earlier runs that ended without their clean-up. Tests: kernel sandbox/bootstrap,
  mutation/site-values-and-policies, market/inv28.property, market/engine, review/f55; test-kit seed; site-services
  batch-number-register; recipe-core engine meanings and engine-version; server execution witness-without-printout and
  designer simulation-loader; tools/boundaries runtime-loader; web step-screen, switch-reads, app-person-change.
  Playwright smoke (3/3, after T8), FCV journey and floor (6/6, after T12): passed. Defaults T8.1, T10.1, T11.1 and
  T12.1 are in docs/decisions/phase-2-open-questions.md.
- 2026-10-03: PHASE 2 EXIT FOLLOW-UP, A stale-screen refusal is recorded (branch phase-2/recipe-core; follow-up F58.1
  of F58; the fix with tests that fail on the code before it). What was wrong: since the F58 fix a run command from a
  screen that showed an older version of the run (409 ENG-STALE) was answered before anything was written, so its scale
  readings were not spent, but the attempt was no longer a row of the run, against DI-34's rule that a refused engine
  call is a row with its refusal; and the database never held the engine's version check at all (an accepted command
  from an older screen, or an ENG-STALE refusal at the run's own version, was recorded). Recording it with the readings
  claimed would spend them again, and a savepoint that rolls the claims back leaves a row tablets 0300 refuses. What
  changed: the server resolves a stale request as any other and records the engine's refusal with what was entered and
  the version the screen showed; the readings of a stale weighing are named, not used (tab.peek_readings makes the claim
  with every check in a subtransaction and rolls it back; the row lists them as namedReadings), so the resend from the
  reloaded screen uses them. Recipe-core 0326 (EBMR-EXE-140) records a command from an older screen only as the refusal
  ENG-STALE, that refusal only for such a command, and a stale refusal only with the state before it (the time sweep's
  findings apart); tablets 0500 (EBMR-EXE-124) keeps 0300's rule for every other row and holds a stale refusal to using
  no reading and to naming genuine readings a claim would accept now. The ENG-STALE guidance, the comments of the route,
  the intents, the reading port and the floor form, the execution README and DI-34 now say the refusal is recorded and
  no reading is used. Defaults F58.2 and F58.3 (the signing challenge still answers a stale screen before the PIN without
  a row) replace F58.1 in docs/decisions/phase-2-open-questions.md. Tests: server devices/stale-weighing-readings and
  execution/db-guards-stale-row (new: every forgery of the version check, of a stale refusal's state and of a stale
  weighing's readings refused at the database), execution/commands (stale and concurrent commands recorded). Floor
  Playwright spec 5/5 passed.
  Round 2 (3 Oct): two gaps closed. (1) Tablets 0500 checked each reading of a stale weighing alone, so one reading
  taken for no stated purpose, named as both tare and gross, was recorded as a stale row although the command's own
  claims refuse it (EBMR-DEV-105); tablets 0510 checks the pair as the claims of the command would, tare then gross in
  one rolled-back subtransaction (tab.peek_weighing_readings, also used by the server, which now gives that request the
  answer the current screen gets before anything is written), and drops the per-purpose tab.peek_readings. (2) The
  floor's stale notice still said "Nothing was saved"; it now says the entry was not saved, the refusal is recorded and
  no scale reading was used, and other stale answers (a badge tap too old, for one) say nothing of the entry is in the
  record (round 1 had changed only code comments there, not the notice). Tests: server db-guards-stale-row and
  devices/stale-weighing-readings (one reading as both, at the database and through the server), web step-screen (both
  notices) and entries (the weighing's notice); each fails on bbb83d0.
  Round 3 (3 Oct): the "uses no reading" rule held only for claims made before the stale row in its own transaction;
  the round-2 verifier recorded the honest stale weighing and then claimed its readings under its correlation id, and
  the record said the stale command used them. Tablets 0520 checks it at commit on both sides (deferred constraint
  triggers on the stale row and on every claim, meeting on one key of tab.reading_claim_mark): no claim under a stale
  row's correlation id commits, before or after the row, in any transaction, or concurrently (a serialization failure
  under REPEATABLE READ); it also binds evidence.namedReadings to exactly the stored tare and gross of a stale device
  weighing. The contract now refuses a run version beyond the integer a run's version is stored in (400 before anything
  is written, not 422 EBMR-EXE-140). Residual in F58.2: a command that claims readings and writes no row is still not
  refused. Tests: server execution/db-guards-stale-row-commit (new), devices/stale-weighing-readings,
  execution/commands, api-contract contract; each new one fails on 8c3496a.
- 2026-10-03: PHASE 2 EXIT FOLLOW-UP, Rules the database must enforce, round 4 (branch phase-2/recipe-core; F11, F12,
  F37.R and the REPLAY-GATE design item; each fix with tests that fail on the code before it). F11: the database read
  the step an exception was raised at from the stored source and the command's own step, so a correction of the blend
  time that made a later step's calculation fail could store its CALCULATION_FAILED without that step and let the person
  who worked only in the later step disposition it; exceptions raised in a preparation row or a refused PERFORMED, and
  step exceptions added by a row that acts on no step, had the same hole. Recipe-core 0327 binds the source of every
  exception a row adds to the step the engine raises it at (the row's own step, or for a correction or invalidation a
  step its change reaches as the engine's propagation does; EBMR-EXE-044), reads preparation and refused rows as raising
  rows, and the invariant query reports an exception naming no step instance (decisions F11.1 corrected, F11.2). F12: a
  container held what its entry named, never compared with the MBR, so an output holding L2409-0017 was stored;
  recipe-core 0328 binds a weighing's or lot charge's BOM line, an output's intermediate, a container charge (container,
  contents, plan, sub-lot, this batch's label, the containers consumed) and an equipment check to the step's MBR node
  (EBMR-EXE-126; decision F12.2). F37.R: 0309 serialised proposals only on the batch's lock, which a signer outside the
  server's path does not take; recipe-core 0329 also takes the record's own signing lock, so a proposal waits for any
  open signing of the record and is refused, and a signing waits for an open proposal and is refused (EBMR-ESIG-012);
  0309's claim and decision F37.1 corrected. REPLAY-GATE: decided by default (REPLAY-GATE.1) that the release gate G-REL,
  built in Phase 4, replays the stored rows with the engine pinned to the batch and stays NOT_READY on any difference;
  a Phase 2 test shows a computed value forged through the application role is stored and the replay finds it. Tests:
  server execution/db-guards-disposition-involvement (round 4), db-guards-entry-identifiers (round 4),
  db-guards-proposal-race (F37.R, two connections), golden (REPLAY-GATE); recipe-core execution/exception-source-sql
  (new) and entry-data-sql (round 4).
  Round 2 of the lane (F12, F37.R): the database compared only what an entry's command sent, so an acknowledgement
  naming sop B24-0001 / L2409-0017 was stored; recipe-core 0330 holds every new entry to exactly the data its block
  builds (SOP reference, sample id and label, source-addition case, the person, passed flags, the whole command where
  kept, the entry's own id, time and event, the second-person check it asks for) and to the blocks' accept rules that
  read only the MBR, the batch and the entry (checklist answers, sampling plan, lot usability, disposals, source
  additions, reprocessing authorisation; EBMR-EXE-126; decision F12.3, F12.2 corrected). The proposal and signing locks
  serialised only in READ COMMITTED: a proposal or signing in REPEATABLE READ or SERIALIZABLE, and a change of an
  exception's signed content, still ended in a CONTENT_MISMATCH signature; recipe-core 0331 and kernel 1020 refuse them
  in any other isolation level (EBMR-EXE-084, EBMR-ESIG-015; decision F37.2, F37.1 corrected). Tests: server
  db-guards-entry-identifiers (round 5) and db-guards-proposal-race (round 2, both levels, both orders, exception and
  hold point, change side); recipe-core entry-data-sql (round 5); kernel esig/isolation (new).
  Round 3 of the lane (F12): the database never applied a block's data schema, so a weighing whose command and data
  both carried lotNumber L2409-0017, a clearance answered NO stored as passed, and G-24 start data without its
  references were stored; recipe-core 0332 holds every entry, start data and refused row to the schema of its step's
  block version and refuses a kind the block does not record (EBMR-EXE-126; decision F12.4, F12.3 and T2.3/T2.4
  corrected). Tests: server db-guards-entry-identifiers (round 6); recipe-core entry-data-sql (round 6).
- 2026-10-03: PHASE 2 EXIT FOLLOW-UP, Read authorisation and sessions, round 4 (branch phase-2/recipe-core; F34, F35,
  HIGH-WATER, SSE-SESSION, F41.R). F34/F35: without a session the application role still learned who is under
  investigation: kernel.verify_chain from a position past the end of record_hold:account:<id> named the chain's length
  for a held account only, and continuity.compare_external_anchors called a forged one-head anchor UNEXPLAINED for a
  held account and DISCARDABLE for another; and the subject of an investigation in a governance role was told about it
  by the session-checked reads ("not shown to the person of this session", 403) where a colleague in the same role got
  an empty list or 404. Tablets 0530 takes the verification and the anchor comparison from the application role on
  both installations (the viewer verifies through the session-checked tab.audit_verify_chain) and answers everything
  withheld from the subject as what is not there, on the audit and signing routes and functions (decision F35.3; F34.1,
  F34.2, F35.1, F35.2, the DI-17/DI-50 guards, ADR 0012 and the 0470 test title corrected). HIGH-WATER: tablets 0540
  takes continuity.sequence_high_water and continuity.sequence_bump from the application role (they showed when and how
  many investigations and holds were opened). SSE-SESSION: the live display stream asks the request gate again every
  2 s and ends at a lock, an idle lock, a sign-out or a withdrawn role (decision SSE-SESSION.1). F41.R: the page names
  its terminal key and the person its session started with on every request, and the server serves another terminal's
  or person's session as nobody (tablets 0550); the page shows the sign-in form or says its sign-in changed; the
  re-planting lock-out and the other residuals are recorded (ADR 0017, decision F41.1), and the E2E title says what it
  proves. Tests: server audit/read-authorisation and esig/read-authorisation (0530, 0540, on GMP and the sandbox),
  devices/live-session (new), platform/security (page binding); web app/page-binding (new); E2E security (new test).
  Lane round 2 (F35, HIGH-WATER): the subject's own account chain still counted and dated the hold the investigation
  notes on it (9 entries listed and verified, 8 shown; a colleague 8 of 8); tablets 0560 counts, dates and orders a
  chain for that person by the entries shown, and the residual (hashed sequence numbers and event ids skip the withheld
  entry) is default F35.4 (F35.2, F35.3(a)/(c), guards corrected). The table statistics (pg_stat_user_tables and the
  other counters, relation sizes) still told every role when and how many investigations and holds were opened; tablets
  0570 takes them from PUBLIC on both installations, and what the server needs (pg_stat_activity, pg_locks) is default
  HW.1. Tests: audit/read-authorisation (tablets 0560, 4 tests) and esig/read-authorisation (tablets 0570).
  Lane round 3 (HIGH-WATER): the stored authority evaluations (iam.authority_evaluation, granted to the application
  role by kernel 0130) still told it when and how many investigations were opened, linked, refreshed and closed and
  legal holds placed and released, and which lead or QA reviewer acted; tablets 0580 takes the table from the
  application role on both installations (every reader is SECURITY DEFINER; the role still evaluates), default HW.2,
  HW.1 and F34.2 corrected. Test: esig/read-authorisation (tablets 0580).
- 2026-10-03: PHASE 2 EXIT FOLLOW-UP, Shop-floor record and checks, round 4 (branch phase-2/recipe-core; T2, T12.LATE,
  T12.DOC, COMPOUND-UNIT, BADGE-AUTOFILL; each fix with tests that fail on the code before it). T2: recipe-core 0332
  already refuses a weighing stored under a kind its step's block does not record; tests now show it at a dispensing and
  an output step, and that the honest signed total names every container. T12.LATE: a witness more than 5 minutes late,
  or after the run moved on, was refused by the kernel and nothing else completed the step, so the run was stuck for
  good. Engine 1.5.0 and recipe-core 0333: once no witness is possible the step is completed by its later review
  (VERIFIED), which raises WITNESS_LATE for QA; a late signature never counts as a witness and the window is not
  widened; the database holds the same rule (EBMR-EXE-141; decision T12.2, T12.1 corrected). T12.DOC: the validator
  and the designer showed "verified" where the floor asks for a timed witness; rule GMP-WITNESS-NO-ATTACHMENT warns,
  the document and step properties say how the check runs, and the dc-mini template asks for the witness itself
  (decision T12.3). COMPOUND-UNIT: an MBR whose G-22 step records a quantity in a compound unit before its net, or
  whose G-07 step weighs into a mass written so, had every container refused by the database (EBMR-EXE-139) with no
  warning before approval; rule DATA-WEIGHED-UNITS warns, reading units as the database does (decision
  COMPOUND-UNIT.1). BADGE-AUTOFILL: a ten-digit secret a password manager filled into the kiosk Badge field was sent
  as a badge UID, and a filled or pasted new kiosk PIN was taken; those fields now ask managers to leave them alone and
  send nothing that was not typed key by key (decision BADGE-AUTOFILL.1). Tests: server execution/
  db-guards-weighing-record (round 4), execution/witness-without-printout (T12.LATE), designer/weighed-units (new);
  recipe-core engine/late-witness (new), execution/late-witness-sql (new), execution/weighed-units-sql (new),
  execution/entry-data-sql, validator/content and data, engine-version (1.5.0); web designer/check-in-release (new),
  session/badge-autofill (new), access/keyed-badge; ui-kit identity/badge-autofill (new). E2E smoke, fcv journey,
  floor, esig, access and designer pass; the floor spec's PR-08 variant, which types a value by hand from its printout,
  now asks for the witness itself to pass the gate.
  Lane round 2 (T12.LATE, T12.DOC, BADGE-AUTOFILL): 0333 decided when a witness could be replaced from a step's end
  time, other steps' start times, values' times and the pinned witness window, all written unbound by the application
  role (an end stored 400 s back, or a batch pinned with a 1 microsecond window, let the later review replace the
  witness at once); recipe-core 0334 binds each to its own act at the row's trusted time (EBMR-EXE-142 to 145) and the
  window to no shorter than the site's kernel window (EBMR-EXE-146; default T12.4, T12.2 corrected). The validator and
  the designer warned only for MANUAL capture, while every value is typed by hand in this release; they now warn for
  every capture except a weighing step's computed quantities (T12.3 corrected). A password manager that "types" a saved
  secret with script events was read as a reader; untrusted key and input events now count as a fill
  (BADGE-AUTOFILL.1 corrected). Tests: recipe-core execution/step-times-sql (new), validator/content; server
  execution/witness-without-printout, refusals-and-room-views; web designer/check-in-release; ui-kit
  identity/badge-autofill. E2E floor and esig pass.
  Lane round 3 (T12.DOC, BADGE-AUTOFILL): a phase whose MBR names no check gave no warning and showed "—" as its check,
  while the engine checks a critical value typed by hand from its printout by a timed witness (fallback verifier
  roles), then by the later review with WITNESS_LATE; the validator now warns for it with any capture and the
  document and step properties say how it is checked (T12.3 corrected; the MANUAL_ENTRY_FALLBACK review of a value
  whose MBR names another capture is left to the owner there). The kiosk new-PIN fields took a trusted insertion with
  no key before it (document.execCommand) and a value set with no event; every noAutofill field now takes only what
  trusted keys brought and checks the length they left (BADGE-AUTOFILL.1 corrected; checked in real Chromium). Tests:
  recipe-core validator/content, web designer/check-in-release, ui-kit identity/badge-autofill, web
  session/badge-autofill and sign-in-screens (F05 reaches its digits check by typing). E2E access passes.
- 2026-10-04: PHASE 2 EXIT FOLLOW-UP, Rules the database must enforce, round 5 (F12) (branch phase-2/recipe-core;
  the round-6 verification of F12; DI-05, DI-30, DI-31, DI-32, DI-34, DI-10). What was wrong: recipe-core 0332 read
  only the entry of a RECORD_ENTRY and the start data of a START_STEP, and only where they had the JSON type their block
  declares. The rest of a row was read by nothing, and the engine ignores a member it does not know, so the release
  gate's replay would not flag it either. Through the application role a real-format lot number (L2409-0017) was stored
  in a test run's record:
  - at the top of a command, accepted or refused;
  - in an entry carried by a START_STEP;
  - in a refused entry whose answers were a text or a list of lists, or in start data on an entry;
  - in the evidence stored with a row;
  - in the actor, frames and signatures of a command, and in a preparation, a sweep or an issue request;
  - in the policy a batch pins;
  - in the refusal of a row;
  - in the raw line of a scale reading a weighing used;
  - as the batch size, a market, a variant or an input of an issue request.
  What changed:
  - recipe-core 0335: every COMMAND, PREPARE, SWEEP and ISSUE row's command holds exactly the members its type
    declares, each of its JSON type (21 engine command types, a preparation, a sweep, an issue request). A refused
    entry and start data keep the JSON types their block declares. The command id is one the server gives. A signature
    names a signature id or the dry run's placeholder, a kernel meaning and the person who gives it. The evidence holds
    only what the server records, bound to the row: lot, room, balance, scanned label, signature, package, a UUID
    idempotency key, test device labels. A batch pins exactly the engine policy, with engine roles.
  - recipe-core 0336: a refused row records the engine's refusal {code, message, controls} and an accepted row none.
  - recipe-core 0337: a batch is issued only with a request its MBR accepts (size, markets, variants, inputs).
  - tablets 0590: the readings a device weighing uses are its tare and gross exactly as stored.
  - All four are new migrations (EBMR-EXE-126; 124 for the readings).
  - 0335's header corrects 0332's claim. Decision F12.4 is corrected, and F12.5 records the default: free text a
    type declares is not read as an identifier (reasons, descriptions, TEXT values, units, what a refused row sent:
    the verification's probe H).
  - A device test fixture no longer stores evidence the server never writes.
  Tests (each fails with its migration moved aside):
  - apps/tablets-server/test/execution/db-guards-row-shape.test.ts (new, 7 tests through the application role: the
    verification's probes A, C, D, E and F and the same hole elsewhere);
  - apps/tablets-server/test/execution/db-guards-used-readings.test.ts (new);
  - packages/recipe-core/test/execution/entry-data-sql.test.ts, round 7 (8 tests): the shapes equal the engine's
    TypeScript types at compile time; every command of the engine's runs and of the 21 types passes; a member forged
    into, or retyped at, every place is refused; refusal codes and controls are checked against the engine's and the
    blocks' sources; issue requests.
  Server execution, device, esig and designer regression files (55 files, 328 tests) and the E2E fcv journey pass.
  Still open, reported in F12.5:
  - a member of its own in the state or an event (REPLAY-GATE.1 covers it);
  - a signable content version superseded before the replay, which nothing reads;
  - the origin of an imported test package, which is the package's own claim.
  - Lane round 2 (F12 round 8): recipe-core 0338 holds a command's context to the frames of a step instance, stage
    frame or decision of the state (no context for a step-less RAISE_EXCEPTION), a preparation's target to a signed
    command type and a step instance of the state, every content version to an aggregate of its row's state under its
    own key with exactly its kind's members, a hand-keyed value to its parameter's form, and an engine version to
    major.minor.patch matching the batch's state. recipe-core 0339 names what a row brings into the state as the engine
    names it (EX/EN/DP/DV/HOLD ids, stage frames, decisions, sub-lots). The replay now reads every stored content
    version (F12.5 and REPLAY-GATE.1 corrected; decision F12.6). The challenge answers 404 for a step instance the run
    does not have. Tests: apps/tablets-server/test/execution/db-guards-row-context.test.ts (7) and
    packages/recipe-core/test/execution/row-context-sql.test.ts (7), each failing with its migration moved aside.
    Still open (F12.6): free text F12.5 names; tab.sandbox_lot material code and name and tab.reading_use purpose; the
    kernel sandbox stub lot code and batch number (a DI-05 kernel item for the lead). The E2E fcv journey failed on a
    client-side badge tap this lane does not touch.
  - Lane round 3 (F12 round 9): the round-2 verification stored L2409-0017 as a role of the approver of an accepted
    correction (check_engine_roles binds the actor's roles only). recipe-core 0340 now holds an accepted row's approver
    roles to the engine roles the approver holds through the authority behind their own signature, and a refused row's
    to engine roles; 0342 holds the approver to a person of the installation. tablets 0600 claims readings as TARE or
    GROSS only and refuses a weighing or lot charge whose lot is of a material the batch's MBR does not name; recipe-core
    0341 puts the sandbox identifier rule on a stub batch's number. The self-review found accepted deviation links and
    hold releases naming L2409-0017 stored 'ok'; 0343 binds them to an exception or hold of the state they change.
    Tests (each fails with its migration moved aside): db-guards-approver-roles, db-guards-act-targets and
    db-guards-sandbox-registers (server, new), devices claim.test.ts, recipe-core row-context-sql (round 9). Decision
    F12.7; F12.6 corrected. Still open: the lot register may hold such a material code (owner: set-up order), the
    kernel stub tables and the sandbox's MBR life-cycle writers (reported to the lead), F12.5's free text and refused
    rows as sent, the imported test package.
- 2026-10-04: PHASE 2 EXIT FOLLOW-UP, Read authorisation, round 5 (HIGH-WATER) (branch phase-2/recipe-core; the
  verification of lane round 3; DI-17, DI-50, DI-38, DI-19). What was wrong: since tablets 0410 and 0430 the application
  roles kept SELECT on the signing requests, the signatures and their side tables (esig.challenge, signature,
  signature_seal, signature_id_register, content_change, signature_invalidation, signing_failure) under row-level
  security that hid the GOVERNANCE-class rows. The planner did not hide them: EXPLAIN ANALYZE reported how many rows the
  policy removed ("Rows Removed by Filter: 2" after one closure was requested twice and signed once), narrowed to
  investigations by a range on the indexed aggregate reference; the row estimates, the row positions and id gaps of
  the visible rows, and pg_class's reltuples and relpages, which every role reads, told the same. Polled, they told when
  and how many investigations' closures were requested and signed. Looking for the same defect elsewhere: the kernel's
  signing-failure log, which the application role ran without a session, given a request id it reads in
  iam.auth_event and another person's authentication, raised an alert naming the request's record and meaning
  (di_investigation:<id>, DI_INVESTIGATION_CLOSED). Tablets 0580's test title and header, HW.1 and the DI-17/DI-50
  guard of 0580 said or implied otherwise. What changed:
  - tablets 0610: the application roles select none of the seven tables (the server reads its own requests through the
    session-checked tab.session_challenge: ceremony read-back, F40 resend check, hold-point decision correlation), and
    no role but the owner and the superusers selects pg_class's reltuples, relpages and relallvisible (EBMR-TAB-024,
    EBMR-TAB-025 self-checks);
  - tablets 0620: the application role no longer runs esig.record_signing_failure; the server logs every failure
    through the session-checked tab.record_signing_failure (a request of the session the token is or was bound to, so
    a failure after a sign-out is still logged), and the kernel's logSigningFailure takes that recorder (EBMR-TAB-026);
  - 0610's header corrects 0580's; the 0580 test title now says the evaluations, not the role, tell neither when nor
    how many; HW.1 (correction, (3) closed, (2), (4) and (5) rewritten), F34.2, ADR 0012 item 9 and the DI-17/DI-50
    guards corrected; new default HW.3; DI-38 and DI-19 list the new guards and tests.
  Still read by the application roles (HW.1): its own connections' statements, the locks of any signing, the
  installation-wide counters, the signing authentications and their uses (a person authenticated to sign something,
  and when; not which record or kind), the session activity and the audit horizon. Tests (each fails with its
  migration moved aside or the old source): esig/read-authorisation.test.ts "HIGH-WATER: the planner's view of the
  signing requests and signatures (tablets 0610)" (2 tests, GMP and sandbox) and "HIGH-WATER: the signing-failure log
  of a signing request (tablets 0620)" (GMP and sandbox), the 0410 and 0430 tests made strict (refusal instead of
  RECORD-class rows), and the kernel's signing-failure-own-command.test.ts recorder test. Hand-run mutants of both
  migrations' self-checks and of both functions' conditions are killed. Server esig, execution signing and access
  regression files and the E2E esig spec pass.
- 2026-10-04: PHASE 2 EXIT FOLLOW-UP, Designer document and kiosk secrets, round 5 (T12.DOC, BADGE-AUTOFILL) (branch
  phase-2/recipe-core; the verification of the shop-floor lane's round 3; DI-30, PR-14, DI-35, PR-03, INV-26, DI-17,
  DI-14, DI-15, DI-19, DI-38). What was wrong: T12.DOC: where the MBR names no check, the validator's warning, the
  designer's "Checked by" cell and the step's properties named a production verifier, a production supervisor or QA
  (shop floor) for the timed witness and said the later review then completes the step. The run accepts fewer: the
  kernel signs a witness only in a role holding STEP.WITNESS and a later review only in one holding STEP.VERIFY, so it
  refused a supervisor's witness and the later review of a supervisor or of QA. The web test held the words only to the
  engine's policy, and T12.3 said the same. A check the MBR itself gives to a role that may not sign it passed the gate
  too. BADGE-AUTOFILL: the kiosk's new-PIN fields took their count of typed characters back from the text at every
  input event and let any deletion through without a key, so a PIN set silently and finished with one real key, a real
  Backspace or a script's execCommand('delete') was taken and sent. What changed:
  - recipe-core: flow checkersInRun narrows the roles a check names to those of the installation that may give each
    check; the validator's role port carries the installation's checker roles, GMP-WITNESS-NO-ATTACHMENT names the
    people the run accepts with the permission each check needs (and the site's witness window, 5 minutes by default),
    and the new error GMP-CHECK-PERMISSION refuses a check no role carrying its role may sign;
  - server: the designer reads the checker roles from tab.engine_role_map and the kernel role permissions, as the
    floor's list of who may help does; api-contract CHECKER_ROLES mirrors the delivered ones for the document, whose
    cell and properties now name a production verifier or QA (shop floor) for the witness and a production verifier
    for the later review;
  - ui-kit SecretInput: the count is never taken from the field's text. An accepted key adds what it brought and an
    accepted deletion takes away what it removed, in place of the selection the key went down on; a deletion needs a
    trusted key too and may take only what that key may remove; every trusted key first compares the field's length
    with the count;
  - docs: T12.3 and BADGE-AUTOFILL.1 corrected (round 4), default T12.5 (with a dead end left to the owner: a witness
    the MBR gives to QA cannot be replaced by a later review or re-verified after a correction, as QA shop floor holds
    no STEP.VERIFY), the SecretInput header and the validator README.
  Tests (each fails on the code before it, except the two server refusal tests, which tie the names to what the
  database already refused): recipe-core validator/content "T12.DOC round 4" (2); web designer/check-in-release round
  3 (title corrected) and round 4; server execution/witness-without-printout "T12.DOC round 4" (4: the named roles
  equal the role map with the kernel permissions; at the database and on the floor a supervisor's witness and the
  later review of QA or a supervisor are refused, QA's witness and the verifier's review are taken); ui-kit identity/badge-autofill "BADGE-AUTOFILL round 4" (2, the verifier's probes and each check
  on its own); web session/badge-autofill round 4 (the verifier's '73190' plus a typed '4' is not sent). Checked in
  Chromium 1194 with the real field; E2E access passes. SecretInput's changed lines, mutated one mutant at a time (Stryker
  does not activate mutants under happy-dom): 191 of 205 killed, the 14 left equivalent or redundant with the count.
  Also fixed: a race in web access/ports.test (the switch request was read before it was sent; it failed about one
  run in ten before and after this change).
- 2026-10-04: PHASE 2 EXIT FOLLOW-UP, Rules the database must enforce, round 6 (F12 closed structurally) (branch
  phase-2/recipe-core; F12 and F12.KERNEL; DI-05, DI-30, INV-18, PR-47, PR-23, DI-32). What was wrong: each round of
  F12 bound the members a verification found, and the next one found another. Through the application role the
  round-10 verification stored the real-format lot number L2409-0017, accepted with an identical replay, as the
  authoriser of a reprocessing's start data (G-24 authorisedBy) and, over HTTP, as the equipment of an equipment status
  at a step listing no equipment. Decision F12.5 let every free-text member (comment, reason, answer, deviation
  reference, refusal message, what a refused row sent) hold it. In the kernel, the market stubs took real batch and lot
  numbers in a sandbox, nothing read the identifier rule inside a text, and a test lot's material name was read by
  nothing. What changed:
  - kernel 1030: the identifier rule read in text (sandbox.identifier_words, real_identifier_parts,
    real_identifiers): words of the identifier alphabet with a letter and a digit (NFKC, percent and backslash escapes
    read, longer words read part by part) that 0810's rule accepts with TEST- in front and refuses as they stand; no
    second definition. Trigger function sandbox.guard_free_text (EBMR-SBX-024, names the column, never the word).
    guard_identifier on market.stub_batch, stub_material_lot and stub_pack; guard_free_text on the stubs' free text
    (F12.KERNEL).
  - tablets 0630: a test lot's material name is read (EBMR-SBX-024).
  - recipe-core 0344: deferred constraint triggers on every execution table the application role writes and on the
    run's audit chains read every text, text[] and jsonb column, every string and member name at any depth, at commit
    (EBMR-EXE-147). Words are allowed only from bound sources (the imported MBR, the batch number, site and room, the
    engine's names and compounds). The refusal names the column and JSON path, never the word. Server guidance for
    EBMR-EXE-147 (422).
  - recipe-core 0345: an accepted START_STEP records no start data, and on every row a start-data authoriser is a
    person of the installation; an equipment status at a step listing no equipment names equipment the MBR binds where
    the step runs (EBMR-EXE-126).
  - Defaults (decision F12.8): the reading is the strict side. A test run refuses code-like words that are not
    identifiers (QA1, LBL-1, E2E, DEV-TEST-0001): a test run names a deviation, label or lot by a TEST- number. Test
    fixtures, two E2E specs (floor, journey) and the owner's demo script now use TEST- numbers. The reading cannot see
    digits-only identifiers, ones broken by spaces or written in words, or non-ASCII digits. F12.1, F12.5, F12.6 and
    F12.7 corrected. Inventory of the 185 tables the application role writes in a sandbox, each text column classed
    (docs/design/sandbox.md section 7). 134 tables of sandbox administration, logs and derived values hold free text
    nothing reads for the rule; none is part of a test run's record. Reported to the owner and the lead.
  Tests (each fails with its migration moved aside): server execution/db-guards-free-text-identifiers (3: the round-10
  probes, L2409-0017 in every member over HTTP and on the store path, every real format), db-guards-kernel-stubs (2,
  both installations), db-guards-sandbox-registers and db-guards-row-context (round 10), devices/claim (round 10);
  kernel sandbox/identifier-words (4). Fixtures that wrote code-like words (LBL-1, P25 sources, DEV refs, QA1) now
  write TEST- numbers or prose. E2E: floor PR-08 and PR-13 (deviation links with TEST- numbers), esig and devices
  pass. The journey spec failed in four runs at a badge switch of user under the machine's load (at a different step
  each time, never at a refusal of this lane). Floor INV-03 fails at the designer gate (GMP-CHECK-PERMISSION, since
  T12.DOC round 4; not this lane).
- 2026-10-04: E2E INV-03 rebuilt (branch phase-2/e2e-inv03). The floor spec's [INV-03] test broke at f04ef7b: its MBR
  variant gave p-disp-clear's check to the performing role, which the T12.5 gate now refuses (GMP-CHECK-PERMISSION). The
  test-kit now seeds one kiosk persona holding OPERATOR and VERIFIER (TEST-Deepa Pillai, two approved grants); on the
  standard dc-mini record it performs the clearance as OPERATOR, signs in again as VERIFIER (one role per session) and is
  refused Verify by the segregation rule (ENG-SEGREGATION; INV-03), not by the role rule. Also: every E2E badge tap now
  stamps the reader's keys 5 ms apart (readerTap), so a loaded machine no longer splits a tap and sends the UID's tail.
- 2026-10-04: OWNER CONTEXT (no plan change): products the owner plans later, separate from this build: e-logbooks,
  e-qualification protocols, engineering work orders, investigation management, eQMS, material management,
  productivity, hiring, and training modules for SME development (the owner's list starts at 2 = eBMR; item 1 is not
  named). The owner's instruction: build the BMR only for now; the others can come later. Nothing in the phase plan
  changes for them.
- 2026-10-04: PHASE 2 EXIT, review backlog (docs/build-plan/phase-2-exit/review-backlog.md): what the exit review did
  not cover and what its follow-ups left open on purpose: the critic's uncovered areas, checked against rounds 4 to 6
  (closed items listed with what closed them); the areas no reviewer has checked yet, by the phase that takes them;
  the residuals that owner decisions accept (REPLAY-GATE.1, F34.2, HW.1-HW.3, F12.5 onwards, T5.1); and the defects
  the SQL mutation kill agents reported. Each later phase's exit review starts from the items that name it.
  Round 2 of the lane (round 11 of F12): the verification found the class still open. Engine-name words passed by
  their form (S24090017, EX-24090017, G24-LOT, E2409/0017 recorded over HTTP), a person's name was read nowhere (a
  rename to TEST-Priya L2409-0017 reached the run's rows, signature and audit), an escape hid the identifier after it
  (50%B24-0001), a reading's chain was read only in its reason, and a refusal repeated a member name holding a
  real-format word. Now kernel 1040 reads text as written too and guards the sandbox's person names, references and
  logins; recipe-core 0346 and 0347 allow such words only as the run has them (its MBR, batch number and location, the
  engine's registers in the new table recipe.engine_name, the record ids its state holds, its flow's edges, compounds,
  held sample and container ids), read the actor's name, chain keys and a reading's chain in full, and never repeat the
  word in a refusal. Tests: server db-guards-free-text-bound-names (5), recipe-core engine-names-sql (3), kernel
  identifier-words (2 more); each fails with its migration moved aside. Decision F12.9; F12.5, F12.8 and sandbox.md
  section 7 corrected. A request naming a record the run does not have is now refused and not recorded.
  Reported: a G-12 plan given only as a number of locations names points L1 to Ln that the reading refuses.
  Round 3 of the lane (round 12 of F12): the verification found the basis of a hand-keyed weighing
  (tab.manual_weighing_basis), keyed to a run's row, read by nothing: a fake gateway's not-ready text or serial
  L2409-0017 was recorded there over HTTP. A number in a compound also passed by its form (BATCH/2409/0017, QA/2409/0017
  recorded). Now tablets 0640 reads the basis at commit with the identifier rule, allowing the installation's own error
  codes (EBMR-DEV-048). In a sandbox a weighing whose basis would quote such a word is refused, an honest serial like
  SIM-9999 included (default F12.10). Recipe-core 0348 lets a compound pass by its parts only when each part holds a
  letter, and allows a number only in the engine's shapes (context fragments within the section's maximum, held ids).
  Tests: server db-guards-free-text-weighing-basis (2) and -compounds (2), recipe-core engine-names-sql (golden runs);
  each fails with its migration moved aside. Decision F12.10; F12.8, F12.9 and sandbox.md section 7 corrected.
- 2026-10-03: SQL MUTATION HARNESS FOR THE PHASE 2 GUARDS (branch phase-2/sql-mutation from 979e747; the full run and
  the kill tests are the next step). tools/sql-mutation knew only the Phase 1 kernel. Definitions now come from every
  SQL directory in migration order (kernel, site services, recipe-core, tablets), a function identified as PostgreSQL
  does (name and input argument types), DROP FUNCTION followed (tab.chain_readable and the old signatures of
  recipe.end_open_cells and tab.ingest_reading were stale). Templates are built by the set-ups' own builders: the
  kernel set-up's (with recipe-core) for the db project, the server set-up's GMP and sandbox pair (seeded) for the
  server project, which now also takes prepared templates from EBMR_SERVER_TEMPLATES (a JSON file of templates and
  seeds, used as is and kept; unset, nothing changes). Per mutant the harness copies each template the group's tests
  use, with the template's database privileges (a plain CREATE DATABASE ... TEMPLATE copy is open to PUBLIC, and
  kernel sandbox/installation.test.ts reads the template's own privileges: the first smoke run "killed" two mutants
  that way), applies the mutant where the function exists, as its owner, and runs each Vitest project with its own
  files (a failure in either kills). The prepared-templates file holds the seeds' DEMO-ONLY keys: mode 0600, in a
  mkdtemp directory removed at the end. Before the first mutant every target function is placed and re-applied
  unmutated in a rolled-back transaction: its pg_proc row must not change (all 408: owner ebmr_owner everywhere, so
  `set local role ebmr_owner` was right). Timeouts per group and project: max(240 s, 3 x baseline). Databases the
  tests leave behind when --bail cancels a file in its set-up are dropped between groups. Mutators: the last
  character of ->> #>> @> => and the first of <@ (2,727 mutants over all definitions; in PL/pgSQL an operator that
  does not exist fails only at run time, so any test calling the function "killed" it: 251 of the Phase 1 groups'
  1,714, and five Phase 1 functions had no other mutant) and the = of a RAISE ... USING option (always INVALID) are
  no longer mutated; ids are kept, so equivalent.json still names the same 17 mutants. Targets: 23 new groups,
  5,898 mutants in 32 groups (Phase 1's nine now 1,038): mbr-lifecycle 384, market-authorisation-and-issue 493,
  execution-commands 209, execution-state-binding 333, evidence-source-and-entries 191, execution-steps-and-order
  461, system-facts-and-time 333, exceptions-and-dispositions 234, limit-exceptions 223, involvement-and-independence
  128, weighing 156, signed-content 222, sandbox-and-import 113, device-readings 375, evidence-listener 87,
  manual-weighing-gate 256, read-authorisation 134, tablets-sessions 114, designer-guards 94, site-zone 33,
  signing-failure-and-reasons 43, connection-roles 91, batch-number-register 153 (site-services 0600, never in a
  run). Baselines 3-51 s per project, manual-weighing-gate 99 s; devices/manual-weighing-interference.test.ts (330 s
  alone) is left out of the per-mutant runs. Smoke run on the spare cluster (--workers 1, 70 mutants, 3 per new
  group plus tab.record_signatures#2): 58 killed, 12 survived, mean 17 s per mutant; every guard removal killed but
  tab.content_for_signing#8 (TAB-020 tested only through the server, which refuses first). Estimate of the full run:
  about 21 h with 2 workers on 4 shared CPUs. Weekly workflow lists every group.
- 2026-10-04: PHASE 2 EXIT, SQL mutation kill tests integrated (24 groups): branch phase-2/kill-integration from
  093ee58 merges phase-2/sql-mutation (the harness; PROGRESS kept from both sides, the test set-ups take the harness's
  template support unchanged) and kill/<group> for mbr-lifecycle, market-authorisation-and-issue,
  execution-state-binding, system-facts-and-time, execution-steps-and-order, manual-weighing-gate,
  batch-number-register, limit-exceptions, sandbox-and-import, connection-roles, designer-guards, tablets-sessions,
  evidence-listener, signing-failure-and-reasons, site-zone, exceptions-and-dispositions, execution-row-shape,
  execution-commands, weighing, involvement-and-independence, read-authorisation, exception-source,
  late-witness-and-step-times and stale-commands-and-readings (device-readings, evidence-source-and-entries,
  entry-references-and-schema and signed-content are still being worked on). The five kill fix migrations moved into
  ranges kept for the kill work, in their branches' order: recipe-core 0344 loop-exit limit verdicts -> 0370, 0345
  market-authorisation family -> 0371, tablets 0640 API answer at the report's instant -> 0700, 0650 sandbox lot
  identity test -> 0701, kernel 1030 segregation query with missing roles -> 1100; none of their functions is
  redefined on the PR branch after the body each fix was built on. 445 kill tests in 33 files (271 db, 174 server) pass
  on the integrated tree, and register sync-tests from that run lists them under the 54 controls they are tagged with
  (726 entries). Two were adapted, nothing loosened: the execution-state-binding start-data test (recipe-core
  0345 now refuses every accepted start carrying start data; the test asserts that refusal and reaches the 0300 entry
  rule the two ways left, keeping execution_state_binding_check#98 killed, checked with the harness) and the
  execution-commands role-map test (an exception description "D4 kill test" read as a lot number by EBMR-EXE-147; now
  prose). equivalent.json records the 94 equivalence claims the skeptics upheld, under their current ids (17 -> 111
  entries); activate_market_authorisation#56 was claimed only after the skeptic's review and is not recorded. Batch
  scores, kills, equivalents and the 15 defects the kill agents reported (5 fixed by the migrations above, 10 open for
  the lead: start of a minimum at a token arrival, a loop exit without its context, a signature's missing validity,
  signatures of other steps invalidated by any row, market activation rows written around the command, the kernel
  state history forged with the session flag, nested loops on one endpoint, the listener hold measured from the
  close, and two refusal messages) are in docs/build-plan/phase-2-exit/sql-mutation-kill-results.md. Harness smoke on
  this tree: site-zone 25/33 before the kill tests, 33/33 after.
- 2026-10-04: PHASE 2 EXIT FOLLOW-UP, Rules the database must enforce, round 7 (F12: what a text shows is what the rule
  reads) (branch phase-2/recipe-core; F12; DI-05, DI-30, INV-18). What was wrong: the identifier reading (kernel 1030
  and 1040) took the words of a text from its stored NFKC form, where a character that shows nothing, a look-alike
  letter, digit or slash, and a bidi control were all separators. Over HTTP the honest server recorded L2409-0017 with a
  soft hyphen, a zero-width space or joiner, a combining grapheme joiner, a variation selector or a word joiner after
  the L, L 7100-9042 under a right-to-left override (shown as L2409-0017), and BATCH/2409/0017 with a division or
  fraction slash, in exception descriptions, hold reasons and business entries. Our own attack found the same with no
  control at all: a Hebrew letter between L and 2409-0017 shows L2409-0017 in a left-to-right line (Chromium 141), and
  Cyrillic or Greek letters and Devanagari or Arabic-Indic digits were read as nothing. What changed:
  - kernel 1050: every text, as stored, as written and with its escapes read, is also read as it shows (the combining
    marks and what kernel.is_blank counts as showing nothing removed, spaces kept) and with its look-alikes read (new
    table sandbox.look_alike, data from Unicode's confusables.txt and character database 18.0.0: digits of every script
    by value, look-alike letters, dashes, slashes and full stops). A text that can display in another order (a
    right-to-left letter, an Arabic digit, a bidi control or mark) is read in every arrangement of its runs. The stored
    text never changes. Every user of the reading is covered at once: a test run's record, the kernel's stubs, the
    person register, a test lot's material name and the weighing basis.
  - recipe-core 0349: the run's bound words and a refusal's path read the same forms, so the run's own words still
    match (also written with a non-ASCII hyphen).
  - Defaults (decision F12.11): Urdu, Arabic or Hebrew text with a number is refused in a test run (the display order
    cannot be read; refusing only the override controls would leave the implicit reordering open); digits of any script
    are read by value; punctuation stays a separator (the Hindi danda passes); a symbol that looks like a letter (the
    multiplication sign, a slashed O) counts as that letter. Still not read: digits only, an identifier broken by a
    space or a visible non-look-alike character, spelled out in words, or drawn in an image. F12.8, F12.9, F12.10,
    kernel 1040's header and sandbox.md section 7 A corrected.
  Tests (each fails with kernel 1050 and recipe-core 0349 moved aside): kernel sandbox/identifier-words (5 new: what
  shows nothing, look-alikes and reordered text read; every look-alike folded; the person register; honest emoji,
  soft hyphen, Hindi, Tamil, Greek, Japanese and Korean prose not read); server execution/db-guards-free-text-shown (2:
  the probes over HTTP and in business entries three levels down refused with nothing stored, honest texts recorded);
  db-guards-kernel-stubs (1 new). Regressions run: free-text identifiers, bound names, compounds, weighing basis,
  golden, free text, kernel stubs, sandbox registers, device claim, recipe-core engine-names-sql, test-kit, and the
  sandbox set-up with three persona sets.
  Attacking 1050 ourselves found letters and digits no table read (a small capital L, a regional indicator or negative
  squared L, dingbat circled digits): kernel 1060 reads the 372 characters with no decomposition whose Unicode names
  make them a Latin letter or a digit as named (kernel identifier-words test, fails with 1060 moved aside).
  Round 2 (verification of round 7): the em dash's own look-alikes were not read (Unicode's confusables data gives the
  box-drawing line, the Japanese prolonged sound mark and CJK one the em dash's prototype), nor dashes and slashes drawn
  as such, an L with a middle dot inside it, or a hair space: LOT─2409─0017, LOTー2409ー0017, LOT⎯2409⎯0017,
  B─24─0001 and Ŀ2409-0017 were recorded over HTTP. Kernel 1070 reads the look-alikes as a class (every member of a
  confusables class another member of which is read by its look, a letter drawn with a dot, dashes and solidi by name or
  as Chromium draws them, the Ogham space mark, compatibility forms PostgreSQL 16 does not know) and a space narrower
  than the thin space as nothing; kernel 1080, from our own attack, the full stops drawn as such. Decision F12.12 states
  each group left out and the residual; F12.8, F12.10, F12.11 and sandbox.md corrected. Tests: kernel identifier-words
  (5 new, each fails with 1070 or 1080 moved aside), server db-guards-free-text-shown (1 new: 13 probes over HTTP and in
  business entries refused, honest Japanese, Chinese and Korean prose recorded).
  Round 3 (verification of round 7, lane round 2): what Chromium lays out with no room (U+FFFC, the spacing marks of
  Indian and other scripts) and letters it draws as the alphabet that Unicode's confusables data does not list (an
  Armenian and a Canadian letter drawn as L) still hid L2409-0017 over HTTP. Kernel 1090 reads every spacing mark and
  the characters a scan of the browser's layout found with no advance as nothing (the audit trail's blank-reason test
  is kept as it is, and why is recorded); kernel 1101 reads the letters and digits the browser draws closer to an ASCII
  letter or digit than any two of those are drawn, and kernel 1102, from our own attack on 1101, does the same in the
  semibold and bold the product shows free text in, with a complete comparison. Our attack also found a test that
  failed by chance when an id held 2409; it now ignores numbers inside hex ids. Decision F12.13 states the defaults and
  what remains; F12.8, F12.10, F12.12 (wrong space widths, a Japanese sentence that is refused, the drawing used for
  separators only) and sandbox.md corrected. Tests: kernel identifier-words (9 new), server db-guards-free-text-shown
  (3 new) and db-guards-kernel-stubs (3 new), each failing with its migration moved aside; honest Hindi, Tamil, Telugu,
  Greek, Japanese, Chinese and Korean prose recorded; the sandbox set-up with three persona sets reads none of its 33
  persons.
- 2026-10-04: PHASE 2 EXIT FOLLOW-UP, Rules the database must enforce, round 8 (F12: a word that holds a digit is plain
  ASCII) (branch phase-2/recipe-core; F12; DI-05, DI-30, INV-18). What was wrong: round 7 read a character outside ASCII
  as a letter or digit only when a table listed it (Unicode's confusables data, character names, two drawing scans of
  the product's sans-serif face). The verification found 18 more characters no table lists that the product draws as
  Latin letters or digits, among them a Cyrillic omega drawn as W and a Cyrillic iota as I in bold, and, in the
  monospace face the signature dialog shows the signed text in (never scanned), a Georgian letter drawn as d and an
  archaic koppa as Q. Over HTTP the honest server kept W24-0001 and I2409-0017 written with them in an exception's
  description, a hold reason and a business entry three levels down, and qa1 signed a disposition whose justification
  held d2409-0017. It also showed that the drawing line the docs stated was not the one the scans drew. Chasing glyphs
  has no end, so the class is closed by structure (decision F12.14, the verification's own alternative). What changed:
  - kernel 1120: in a sandbox a word that holds a digit (an ASCII digit or any character the look-alike table reads as
    one) is written with ASCII letters, ASCII digits, '/', '.' and '-' only, as stored and in every reading of round 7.
    A word ends only at a space of any kind or at ASCII punctuation other than '/', '.' and '-', so an invisible
    character, a mark, a bidi control or a letter or digit of another script inside it makes it such a word. The
    reading gives that word whole and reads it as a real identifier, so every guard of the rule refuses it with no
    change of its own: a test run's record and its audit chains (EBMR-EXE-147), the kernel's stubs, a person's employee
    reference and a test lot's material name (EBMR-SBX-024, with a message that says to write the digits 0 to 9 and a
    space); person and device labels were already ASCII only after TEST-. A GMP installation is unchanged.
  - recipe-core 0350: such a word is allowed in a test run's record only as its MBR or header holds it, whole (the
    server copies the MBR's step names into the signed content, so an MBR with a step named "at 22°C, ±2" still runs);
    a real-format identifier is named first; the refusal says what to write. The server's guidance for EBMR-EXE-147
    says the same.
  - Defaults (F12.14): the run's own codes written with a hyphen look-alike (DISP‐1) are refused; the honest screens
    never write them. Accepted cost, refused in a test run although honest: digits of other scripts (Hindi २५), a
    number joined to a word of another script or a sign (२४किलो, 25वां, 3개, 25°C, ±0.1), a vulgar fraction, a keycap
    emoji, Russian or Armenian words with a letter a table reads as a digit. Still not read: digits only, an
    identifier broken by a space or by an ASCII mark, one whose every digit is drawn with a character no table reads as
    a digit, words, images. F12.13 (3), (4) and (6), the 1050 to 1102 headers (in 1120's), 0349 (in 0350's) and
    sandbox.md section 7 corrected.
  Tests (each fails with kernel 1120 moved aside; the MBR one also with recipe-core 0350 moved aside): kernel
  identifier-words (3 new: the 18 characters read as nothing alone and whole when glued to digits, invisible, bidi and
  mark characters inside a word with a digit, the word boundary; honest prose not read and the accepted cost read;
  guard_free_text, a person label and an employee reference refused, GMP keeps them), server
  db-guards-free-text-shown (2 new: the five probes over HTTP in a description, a hold reason, a business entry three
  levels down and a disposition's justification refused with nothing stored and the advice to use ASCII digits; honest
  Hindi, Tamil, Japanese, Korean and Greek prose, emoji, soft hyphen, TEST- identifiers, the run's codes, dates and
  quantities recorded; an MBR step name holding 22°C signed and kept, 23°C refused). Round-7 tests whose honest text
  joined digits to another script now write the numbers apart, or assert the refusal (their titles and the controls'
  lists updated). Regressions: kernel sandbox tests, test-kit, recipe-core engine-names-sql, server free-text,
  free-text-identifiers, bound names, compounds, weighing basis, kernel stubs, sandbox registers, entry identifiers,
  golden, people text, disposition, header limit, device claim, refusals and room views, row context; the sandbox
  set-up with three persona sets (27 personas, none of its 33 persons read; the -wA and -wB names pass).
  Lane round 2 (2026-10-05, kernel 1130, decision F12.15): the verification found a reordered line still hid such a
  word: a right-to-left mark or letter between a Cyrillic omega and a space made 'बैच Ѡ 24-0001' show as Ѡ24-0001, and
  round 7's arrangement joined only ASCII letters to the digits, so a hold reason and a business entry kept it. Now a
  text that can display in another order also joins every run of other characters to every run of digits, so the
  rule refuses it in a sandbox (cost: Urdu, Arabic or Hebrew prose with a number, or a text with a direction mark and a
  number; the refusal says to write the number in words). Tests: kernel identifier-words (3 new) and server
  db-guards-free-text-shown (1 new), each failing with 1130 moved aside; F12.14 (1), (2), (6) and (7) corrected.
  Lane round 3 (2026-10-05, kernel 1140, decision F12.16): the verification found the class of characters that can
  reorder a line was Unicode 18's, while the E2E browser (Chromium 141, ICU 74, Unicode 15.1) treats 61 more code points
  as right-to-left letters (a Hebrew point, Garay marks, Arabic ligature signs that later Unicode versions made marks or
  symbols), so 'Drum of L<U+05C8> 2409-0017 set aside', shown as L2409-0017, was kept over HTTP, also in a signed
  disposition. Now the class is every code point of the ranges reserved for right-to-left scripts plus the bidi controls
  and marks (checked against ICU 74, Unicode 14 and 18 over every code point); cost: a number next to a mark or sign of a
  right-to-left script is refused in a test run. Tests: kernel identifier-words (4 new) and server
  db-guards-free-text-shown (1 new), each failing with 1140 moved aside; F12.14 (7), F12.15 (1), (4), (6) corrected.
