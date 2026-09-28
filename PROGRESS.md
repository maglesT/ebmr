# eBMR project — progress & resume notes

Last updated: 2026-09-27 17:45 UTC. Keep this file current after every milestone.
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
- 2026-09-28: SQL mutation run 1 (1,284 mutants): audit-trail 74.5, actor-validation 92.7, signing 85.4,
  signature-invalidation 76.2, segregation-and-grants 53.9, authentication-events 65.9, retention-and-purge 82.5,
  site-values-and-policies 73.2, protected-numbers 60.3 (%; target 90). 254 survivors. Harness now supports per-group
  kill tests (packages/kernel/test/mutation/<group>.test.ts), --only <ids>, and reviewed equivalent mutants
  (tools/sql-mutation/equivalent.json, excluded from the score). An ultracode workflow writes kill tests per group,
  a skeptic challenges every equivalence claim, and mutants that reveal defects are reported, not locked in.
