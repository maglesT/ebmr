# Phase 7: validation pack and hardening (Batchwright Tablets, to v1.0-rc)

Plan written 17 October 2026, before building, for the owner's record and for the builders. Phase 7 is the last phase
before Tablets v1.0 (decision 0010). It turns what Phases 1 to 6A built and tested into a release candidate that a
manufacturer can validate: the generated validation pack, the security and scope fixes the owner asked for, the
hardening list, the performance, restore, security and accessibility records, the product's branding and its guides.

The rules come from these documents:
- Build outline section 11, the Phase 7 row: the generated URS, risk assessment, specifications, trace matrix, IQ/OQ
  scripts, PQ templates and summary report; load and soak tests, including release under concurrent ingestion; the
  restore drill and its record; penetration testing and hardening verification; the accessibility audit; the user and
  administrator guides; v1.0-rc. Its exit line is reconciled with decisions 0008 and 0019 in **D-P7-1** (below) and in
  [decision 0024](../../decisions/0024-phase-7-scope-and-exit.md).
- Outline 9.1 (the non-functional layer: a 50,000-entry batch review under 5 s, p95 command under 300 ms on the site
  LAN, release under concurrent ingestion without repeated retries, the restore drill, accessibility, dependency and
  licence scans), 9.2 (validation approach and the generated deliverables), 4.7 (security architecture; L-56: Phase 7
  keeps penetration testing and hardening verification only, the threat model and ASVS level 2 design review were
  Phase 1's), 7.4 (accessibility target WCAG 2.2 AA) and the risk table, row 6 (Phase 7 load tests against SLOs).
- Decision 0008 sets the depth: tests with every feature, green CI, one review pass per slice, at most 2 fix rounds per
  finding, then a residual for the owner; database enforcement for the regulation-required core; validation-grade
  testing belongs to deployment.
- Decision 0019 sets the limits of any mutation work: priorities, one first run and at most one confirmation run per
  group, a time box, never a loosened test.
- Decision 0020: the product is Batchwright by Medhanta; branding in Phase 7; GMP records keep the manufacturer's
  identity; code names do not change.
- Decision 0021: no demo at the Phase 7 exit; one demo when the product is there (v1.0).
- Decision 0022: the first items of Phase 7 (6jc-R9, R10, R2, the rest of R16, the dead overload, the smaller items).
- Decision 0023 and D-6A-15: Phase 7 is built in this cloud session; the heavy runs, including the Phase 6A final run,
  are one combined run on the pod at the Phase 7 exit.
- Decision 0017: up to five agents at a time; independent slices overlap in their own worktrees.
- Owner, 15 October: every decision is taken by the lead and recorded; only the hard rules stay the owner's.

Regulations are paraphrased throughout. The generated pack cites clause references (for example 21 CFR 11.10(e), EU
Annex 11 section 9, Schedule M Part I section 20) and the register's own paraphrased `behaviour` text; it never
reproduces regulation or guidance text, GAMP 5 included.

Specs searched, not read whole: outline sections 4.7, 7.4, 9.1, 9.2, 11 and the risk table; the Phase 6 plan's 6j
review and mutation sections; the Phase 6 and 6A review backlogs; the Phase 4 trace deferrals; the Phase 4 and Phase 6
mutation results; `docs/security/threat-model.md` and `asvs-l2-review.md`; `docs/operations/ha-and-restore.md`.

## Starting point (checked on main ddf3dfe and on PR #50's head; PR #50 merged as bc46d55, 17 October)

- **Phases:** Phase 6 is closed (`phase.yaml` at 6, `editions: [tablets]`). Phase 6A's slices 6A-0 to 6A-6 are on main
  (PRs #43 to #49). The 6A exit, slice 6A-7, is merged (PR #50, main bc46d55): kernel 1280 to 1282, the four drafts'
  23 clauses proven at a phase-7 dry run, `pnpm trace` at 6 ok with 151 of 246 controls; residuals P6A7-4 to 9 in
  `docs/build-plan/phase-6a/review-backlog.md` (dispositions in slice 7b-1).
- **Highest migrations (before PR #50, and on main after it):** kernel 1271 (1282), site-services 1002 (1002), recipe-core 1170 (1170),
  tablets 1330 (1330). The 6A-7 ranges stay reserved for 6A exit fixes: kernel 1280-1289, site-services 1050-1059,
  recipe-core 1190-1199, tablets 1380-1389.
- **The register (counted by script over `compliance/controls/*.yaml`, on main and on PR #50; the same numbers):**
  - 246 controls. `expert_decision`: 246 PENDING, 0 FOLLOW, 0 MODIFY, 0 DONT_FOLLOW. `build_status`: 25 IMPLEMENTED,
    221 SPECIFIED, **0 VERIFIED**.
  - The Tablets gate (a control whose editions include tablets; target phase at most 7) holds **155 controls**:
    target 1: 23, 2: 13, 3: 16, 4: 95, 6: 4, 7: 4. Of these:
    - 136 have no deferred part and are not drafts;
    - 11 have clauses deferred to Phase 7 (12 clauses; table in slice 7f below);
    - 3 have a part deferred to Phase 5, the Injectables edition (PR-15 scope, PR-26, PR-28; not started while the gate
      leaves injectables out);
    - 5 are drafts with status U (IN-53, and the 6A drafts DI-51, DI-52, DI-53, PR-61).
  - So the outline's literal exit test, "every FOLLOW/MODIFY control VERIFIED", has **no control in its scope today**:
    the expert has decided none. D-P7-1 sets what the build proves instead.
  - What VERIFIED means is not written anywhere. The schema allows SPECIFIED, IMPLEMENTED and VERIFIED, and
    `validate.ts` only forbids anything above SPECIFIED while a part is deferred. D-P7-2 defines it.
- **Validation pack:** `packages/validation-kit` is the Phase 0 skeleton (package identity only). The trace matrix is
  written by `tools/register` (`writeMatrix`, Markdown). Test evidence exists as `.reports/vitest.json`,
  `vitest-golden.json` and `playwright.json`; the browser suite already writes per-step evidence.
- **Restore:** the kernel continuity module has the restore drill from Phase 1 (`packages/kernel/src/continuity/`,
  `drill-cli.ts`, `restore.ts`, anchors, ledger); the report template is `docs/operations/restore-drill-report-template.md`;
  RPO and RTO are proposals awaiting the owner (`docs/operations/ha-and-restore.md` section 3).
- **Security:** threat model (STRIDE per component) and the ASVS 4.0.3 level 2 design review are Phase 1's
  (`docs/security/`). Open there for Phase 7: signed release artefacts and SBOM (V10.3, V14.2).
- **Performance:** soak tests exist for the 6a adapters (`apps/tablets-server/test/integrations/erp-wms/soak.test.ts`
  and the feed adapters); no load test against the outline's SLOs exists. Known heavy paths: about 50 triggers per
  execution-state change (Phase 3 backlog), the analytics runner reading whole inputs on the primary (P6A7-4) and the
  flag views grouping the whole flag table (P6A7-5).
- **Accessibility:** axe checks run in the browser suite (`tools/e2e`); there is no audit record.
- **Branding:** the files are in `docs/brand/` (Batchwright logo, Tablets and Injectables lockups, icon, each SVG with a
  PNG; the Medhanta logo at 278 x 148 px only). The web app's title is still "eBMR Tablets".
- **Owner items carried in (decision 0022):** 6jc-R9, R10, R2, the rest of R16, the dead 2-argument
  `recipe.check_engine_roles` (recipe-core 0210, replaced in 0270; no caller since recipe-core 1100), and the smaller
  items: reconciliation never runs (O-T12-1), a gateway crash loses samples of an open chunk, the misleading "Nothing
  was saved" (O-T13-1). IN-53 stays a draft, PENDING.

## Slices (each a branch `phase-7/slice-x` and a PR; parallel after 7-0 as the order section says)

Each slice ends with green GitHub CI, its one quick review, its handbook pages, `pnpm handbook` regenerated and
`pnpm handbook:check` green, and the code map regenerated. Tests that prove a control carry its ID.

| Slice | Content | Controls proven or touched (drafts in italics) | Needs |
|---|---|---|---|
| 7-0 | Interface commit (the lead): [slice-7-0-interfaces.md](slice-7-0-interfaces.md) into code; the migration-order CI check (6jc-R4) | DI-31 (contract only), DI-03, DI-06 (entries) | none |
| 7a | Decision 0022 security and scope fixes: R9 (signed gateway feed, mutual TLS), R10 (QA approval), R2 (controlled reads), the rest of R16 (batch scope), the overload drop | DI-31, DI-20, PR-27, *IN-53*, IN-04, DI-17, DI-21 | 7-0 |
| 7b-1 | Hardening list and residuals worth fixing (Phase 6 and 6A medium items, chosen lows) | DI-31, DI-32, IN-30, DI-18, IN-29, PR-57, *DI-51*, *DI-53* | 7-0 |
| 7b-2 | Records deferrals: the stand-alone viewer of a full export, the periodic evaluation pack and the readability report | DI-08, DI-11, DI-44 | 7-0 |
| 7c | Validation pack generators from the register, the code and the tests; the validation-summary interlock; the approved system description and its drift alarm; the AI feature inventory; the build-status tool | DI-03, DI-06, IN-12, PR-60, DI-04 (input) | 7-0 |
| 7d | Performance (load and soak against SLOs, release under concurrent ingestion); restore drill, upgrade drill and migration dry run with their records; security verification; accessibility audit | DI-02, IN-09, DI-46, DI-48, DI-13, DI-20 (verification) | 7a (for the mTLS set-up), 7c (records feed the pack) |
| 7e | Branding (decision 0020) and the user and administrator guides | none (no GMP behaviour changes) | 7-0 |
| 7f | Exit and v1.0-rc: trace at 7, one review pass, the combined heavy run on the pod with 6A's (D-6A-15), the focused mutation campaign, build statuses from the rc evidence, the release-candidate checklist | all of the gate | all |

### Slice 7-0: interfaces (the lead; the commit before any builder starts)

- The notes [slice-7-0-interfaces.md](slice-7-0-interfaces.md) become code:
  - the evidence bundle's JSON schema and its TypeScript types in `packages/validation-kit/src/bundle/`, with one small
    example bundle in `packages/validation-kit/fixtures/`;
  - the gateway feed signature's message builder in `@ebmr/integration-sdk/adapter` (`feedSignatureMessage`) with its
    test vectors, and the adapter TLS settings type;
  - kernel 1300 to 1304: the release identity (`platform.schema_release()`), the table and functions of the
    validation-summary approval and of the approved system description (configuration area `SYSTEM_DESCRIPTION`),
    the new messages, the new permissions (`VALIDATION.APPROVE_SUMMARY`, `CONTROLLED.READ`);
  - recipe-core 1200 to 1204 and tablets 1400 to 1404: the role grants of the new permissions for the Tablets roles;
  - the test-kit helpers `approveValidationSummary(db)` and `approveSystemDescription(db, interfaces)` that every GMP
    test database, golden set-up and browser set-up calls, so slice 7c's interlocks do not break other slices' tests;
  - the handbook module entries for `validation-kit` and `tools/validation` in `docs/handbook/modules.yaml`.
- **The migration-order check (6jc-R4, low):** a CI `[meta]` test that every migration added by a branch sorts after
  every migration of its source on `origin/main`. With it, slices merge in range order (D-P7-9).
- **File ownership (decision 0017 point 3):** each slice owns its folders and migration range (section "Migration
  ranges"). Shared files change only through the lead: `ns/*.ts` namespace owners and `routes.ts`, `modules.yaml`,
  `compliance/phase.yaml`, `tools/sql-mutation/src/targets.ts`, the evidence bundle schema, and `PROGRESS.md`.

### Slice 7a: the decision 0022 security and scope fixes

All five are regulated core (access, signatures, inbound data); each gets database enforcement, a bypass test where a
role could go around it, tests tagged with the control, and a new migration. The fix-finding skill applies (reproduce
first, then the guard, then the test that failed before the fix).

- **6jc-R9 (DI-31, DI-20): the gateway signs its feed; the adapters use mutual TLS.** Required before any networked
  site.
  - The site gateway signs each OPC UA feed envelope (series chunks, alarms, equipment events, endpoint sessions) with
    the gateway's Ed25519 key, over the message fixed in the interfaces (section 2 there), and journals the signature
    with the envelope, so a restart serves the same signed bytes.
  - The database verifies it: an envelope of the gateway feed reaches `plant.receive_*` only through
    `tab.accept_gateway_envelope`, which checks the signature against the gateway's ACTIVE key in `tab.gateway_key`
    (small-order keys already refused, tablets 0702) and that the key's gateway is the one bound to the adapter. A
    missing, wrong or replayed signature is refused with an integration alarm (EBMR-INT-030 to 033) and leaves nothing. The
    `plant.receive_*` functions, which the EMS adapter also calls, refuse an OPCUA envelope that did not pass this check
    in the same transaction (an edition-neutral kernel marker; interfaces section 2), so a direct call by the
    integration identity is refused (bypass test).
  - Mutual TLS for every adapter base URL that is not loopback: the server presents its client certificate and pins
    the adapter's CA and name; a GMP installation refuses to start an adapter whose base URL is plain HTTP and not
    loopback (EBMR-INT-034 at start-up, and the health page says why). The peer certificate's SHA-256 fingerprint is
    recorded with each pulled page (`transport_peer` on the inbound record, additive). The simulators get test
    certificates from a test CA generated at test time (no key material committed).
  - Tests: a forged, unsigned, re-signed-by-another-gateway and replayed envelope each refused with an alarm; a good
    one accepted; the plain-HTTP non-loopback refusal; an mTLS handshake with a wrong CA refused; the restart serving the
    same signed bytes.
- **6jc-R10 (PR-27): the penicillin facility rule and the beta-lactam classification take effect only with QA
  approval.** Same pattern as the hazard-class dedication (recipe-core 0912): `plant.set_facility_rule` and
  `plant.classify_beta_lactam` become proposals by MASTERDATA.CHANGE; the change takes effect only when a QA person
  other than the proposer signs it (meaning `QA_APPROVED`); until then the rule in force is the earlier one. Tests: a
  steward alone changes nothing; the proposer cannot approve; QA's signature brings it into force; the plant rules read
  the approved value only.
- **6jc-R2 (IN-53, draft): controlled-substance reads limited to the CONTROLLED roles and QA.** The custody records,
  batch balance and register extracts need `CONTROLLED.READ` in scope (granted to the roles that hold any CONTROLLED.*
  permission and to QA) in the database read functions and in the server routes. The product flag and the draft banner
  stay as they are; IN-53's text and `expert_decision` do not change.
- **6jc-R16, the rest (IN-04, DI-17, DI-21): the remaining batch acts are evaluated in the batch's {site, product}
  scope**, as recipe-core 1100 did for steps and signatures: the alarm acknowledgment (`plant.acknowledge_alarm`,
  recipe-core 0976; this also settles O-T1-1: a product-scoped person acknowledges alarms bound only to batches of that
  product), the disposition proposals (0331), the exception-register acts (0721), the review freeze (0713), the
  deviation references (0601), the dispensing consumption (0430, 0700) and the batch issue (the order's product). Each
  replaced function is compared line by line with its last definition: no check is dropped. Tests per act: another
  product's requirement no longer refuses it; this product's requirement still applies; a requirement without a product
  limit still applies; a stale qualification source is still refused.
- **The dead overload:** a new recipe-core migration drops `recipe.check_engine_roles(jsonb, jsonb)` (the 2-argument
  form of 0210 and 0270). No existing migration is edited. Before the drop: a `[meta]` test proves no function body and
  no TypeScript calls it; the lead removes it from the `execution-commands` group in `tools/sql-mutation/src/targets.ts`
  (its 27 survivors leave the record with the reason "dropped, recipe-core 12xx") and the handbook is regenerated.
- **Migrations:** kernel 1305-1319, site-services 1100-1109, recipe-core 1205-1224, tablets 1405-1424.
- **Handbook:** `modules/integration-sdk.md`, `modules/site-gateway.md` (feed signature), `modules/recipe-core.md`
  (batch scope), `10-runbooks.md` (gateway key and adapter certificates), `08-defect-log.md`.

### Slice 7b-1: the hardening list and the review residuals worth fixing

Rule for choosing: a residual is fixed here when it touches access, attribution or silent loss, or is cheap and removes
a misleading answer; the rest stay in the backlogs with a line in the pack's known issues (D-P7-6).

| Item | Source | Fix | Control |
|---|---|---|---|
| Reconciliation never runs | O-T12-1, decision 0022 | The adapter worker submits `AdapterWorker.reconcile` for every closed period (hourly, after a grace of 10 minutes) for each adapter with a reconciliation endpoint; a mismatch raises RECONCILIATION_MISMATCH (existing `platform.record_reconciliation`); the health page shows the last reconciled period | DI-31 |
| A gateway crash loses samples of an open chunk | T12 observation, decision 0022 | The gateway journals each sample of an open chunk on receipt (a spool beside the feed journal, fsync in batches of at most 1 s); at restart it completes the chunk from the spool, and a gap it cannot fill raises a SERIES_GAP alarm naming unit, tag and interval | DI-32, DI-31 |
| "Nothing was saved" when only the answer failed | O-T13-1, decision 0022 | Routes that commit a command and then read the answer outside it answer "Saved; the result could not be shown, reload" with the command id when the commit succeeded; a `[meta]` test lists every route built on `withIdempotentActorCommand` with a later read | none (message accuracy) |
| Gap-alarm acknowledgment by an operator marks a blocking mirror fresh | 6jc-R11 (low) | For a SEQUENCE_GAP on a blocking mirror's adapter, only the system owner or QA acknowledges | DI-31 |
| Contract-giver reviewer's scope in the database | 6jc-R3 (low) | `tab.record_read_problem` refuses CONTRACT_GIVER_REVIEWER outside its loan licence | IN-30 |
| DSC functions without the administrator check | 6jc-R6 (low) | `iam.assert_not_administrator()` in `esig.enrol_dsc_certificate` and `esig.record_dsc_signature` | DI-18 |
| Authorization meta scans miss five schemas | 6jc-R7 (low) | Widen the scans to `plant`, `tab`, `iam`, `esig`, `sandbox` | access (meta) |
| `site.erp_outbound_message` not insert-only | 6jc-R5 (low) | Insert-only trigger | DI-31 |
| Mock recall: failed forward read taken as "no destinations"; peers asked before the permission check | 6jc-R12 (low) | Fail the run as incomplete on a read failure; check RECALL.MOCK_RUN first | IN-29, PR-57 |
| Missing OPC UA timestamp set to epoch 0 | 6jc-R13 (low) | The gateway marks such a sample BAD with a reason; `plant.source_time_or_raise` refuses source times older than the endpoint session's start minus the allowed skew | DI-32 |
| Training attempt read does not check whose attempt | 6jc-R15 (low) | Check the actor (sandbox only, cheap) | DI-05 |
| Stale-mirror refusal does not name the mirror | F-6jb-2 | The floor's message names the mirror, its age and the system owner to call | DI-31 |
| Runner does not check its own role | P6A7-8 (low) | Start-up check that `current_user` is `ebmr_analytics` with no elevated attribute, else the runner does not start | *DI-51* |
| Top reasons hint at a hidden term | P6A7-6 (low) | Choose the top reasons among the visible terms, then add the audit-trail reason for DI_REVIEW holders | *DI-53* |
| Audit-trail methods' counts shown to every ANALYTICS.VIEW holder | P6A7-7 (low) | `analytics.method_monitor_v1` and `analytics.run_v1` (re-created in a new kernel migration) show the flag counts of the audit-trail methods only to `ANALYTICS.DI_REVIEW` holders; others see the run without them | *DI-53* |
| A record lock counts as a change since review | F-6jb-g1 (medium, fail-safe) | Fixed only if the database can tell a lock-only epoch bump from an evidence change without loosening any other change detection; otherwise a residual (D-P7-7) | IN-05, INV-05 (release) |

- **The Phase 6A residuals (P6A7-4 to 9), one disposition each:**
  - P6A7-4 (medium; whole inputs read on the GMP primary, sorted and hashed in the server's event loop) and P6A7-5
    (medium; the flag table grows by a row per hit and run, and the flag views group it whole): the backlog asks for a
    measurement on a real site's history; 7d's load test on a generated year of history (D-P7-4) is that measurement,
    with two SLOs of their own (the nightly run within 30 minutes, no event-loop block over 200 ms; a flag view under
    1 s). If either fails, 7d fixes it the way the backlog suggests: a recency bound in the input views (as
    `report.series_ref_v1` has) or the runner in its own worker process for P6A7-4, a stored group column or an index
    for P6A7-5. If both pass, they are known issues with the measured values.
  - P6A7-6, P6A7-7 and P6A7-8 (low, restricted reads and the runner's role): fixed in the table above, because they
    touch access (D-P7-6).
  - P6A7-9 (low; the audit-trail flag key leaves out the method version, 6A-4's design): stays, with its reason in the
    known issues. A verdict covering a later version's identical hit is the intended reading of the key; a new
    `ATA.RULES` version that changes a rule's meaning is approved under change control, where the reviewer decides
    whether old verdicts carry over.
  - The carried 6A-3 item (two SPC reference sets in force for one chart, the screen shows the newest): stays; the
    administrator guide says to retire the older set when approving a new one.
- The Phase 3 trigger load is measured by 7d's load test too and fixed in 7d only if an SLO fails.
- **Stay residuals (listed in the known issues):** 6jc-R14 (fails closed), P6A7-9 and the 6A-3 SPC item (above), R-6c-1 (the specimens in the true copy would move the golden hashes; v1.1), R-6g-1 to R-6g-4, the
  Phase 6 slice residuals (the live QMS fetch needs a QMS that signs its answers; DSC revocation needs a licensed CA;
  federation one hop), D-P6j-T3-4 (microsecond conversion through double precision, exact for 2023 to 2036), the
  mutation residuals of the Phase 4 and Phase 6 records.
- **Migrations:** kernel 1320-1334, site-services 1110-1119, recipe-core 1225-1239, tablets 1425-1439.
- **Handbook:** `08-defect-log.md`, the touched module guides, `10-runbooks.md` (reconciliation and series gaps).

### Slice 7b-2: records deferrals (stand-alone viewer, periodic evaluation pack, readability report)

- **DI-08 clause 2: the stand-alone viewer.** A full export of the installation (every closed record's archive package,
  its audit trail and its signature manifestations, with the export manifest and hashes) opens in a stand-alone viewer:
  a static, offline HTML and JavaScript bundle shipped with the release (`apps/record-viewer`, no server, no network).
  It verifies the manifest hashes and the seals before it shows anything, and says plainly when a check fails. It reads
  only; it cannot change or re-export. Test: export a database with the golden batches, open it in the viewer under
  Playwright, and see the audit trails and signature manifestations of each record intact; a tampered file is shown as
  failed.
- **DI-11 clause 1: the periodic evaluation pack.** For a chosen period the installation generates the evaluation pack:
  changes and configuration changes, deviations and incidents linked to the system, audit-trail reviews done, access
  recertifications, backups and restore drills, alarms of the integrations, open known issues; each entry names its
  source log and row. It is read through the reporting path (`ebmr_report`), stored with its hash, and signed off by QA.
  Test: generate for a test period and trace 5 sampled entries per topic back to their source logs.
- **DI-44 clause 1: the periodic readability report**, part of the same pack: a sample of closed records (seeded, so
  repeatable), each opened and rendered with its audit trail, the result and the render hash listed per record.
- **Classes:** the pack's sign-off and storage are core (signature bound to the pack hash); the selection and layout are
  other.
- **Migrations:** kernel 1335-1349, site-services 1120-1129, recipe-core 1240-1249, tablets 1440-1449.
- **Handbook:** `modules/record-viewer.md` (new), `modules/kernel.md` (records), `10-runbooks.md` (running the periodic
  evaluation).

### Slice 7c: the validation pack generators

- **Architecture:** `tools/validation` builds the evidence bundle (interfaces section 1) from the register, the
  requirement rows, the trace report, the test reports, the database inventory of a migrated database, the SBOM and the
  records of 7d. `packages/validation-kit` holds pure generators: bundle in, documents out. Product code never imports
  `tools/` (boundary rule kept). The output is deterministic: the same bundle gives the same bytes, and the pack's
  manifest lists each document's SHA-256.
- **Documents, per edition (Tablets now; Injectables when Phase 5 lands):**
  - **URS:** one user requirement per control and requirement row, written from the control's paraphrased `behaviour`,
    with the control's sources as citations, its type and editions; drafts marked DRAFT and PENDING.
  - **Risk assessment** in the manner of ICH Q9(R1): per requirement, the harm, severity, probability and detectability
    from fixed rules (outline 9.2's high-risk functions; the control's class core or other; whether the database enforces
    it), giving a risk class (high, medium, low) and the test rigour it calls for. The rules are in the generator, so the
    customer can review them.
  - **Functional specification** from the code: modules, screens and routes per role, block catalog, rule keys, the
    life-cycle state charts drawn from their XState definitions.
  - **Design specification** from the code and the database inventory: guard tables, the permission matrix (roles by
    permissions by scope), the constraint, privilege, trigger and SECURITY DEFINER inventory, the audit event catalogue,
    the message catalogue (EBMR-*), the architecture boundaries.
  - **Trace matrix:** clause, control, user requirement, design element, test, result and run, both ways; it shows the
    boundary-test evidence for every critical limit (DI-06 clause 2, from `compliance/validation/critical-limits.yaml`).
  - **IQ script and record:** an executable check (`pnpm validation:iq`) of an installation: the release identity
    (migration ledger hash equals the release's), package and image versions and digests against the SBOM, every
    expected trigger, constraint and privilege enabled, the roles' attributes, locked settings (demo keys refused, plain
    HTTP refused, TLS and password settings of PostgreSQL), the adapters against the approved system description. It
    writes the IQ record with each check's expected and actual value.
  - **OQ protocol and record:** the regression suite, golden batches and browser suite run against the customer's
    installation (`pnpm validation:oq`), with the browser suite's per-step evidence; the record lists every test with its
    control IDs and result.
  - **PQ templates** for the customer's own MBRs: per MBR, the verification steps (DI-04: qualifying the platform does
    not prove a given master is right), the acceptance criteria to fill in, the signature blocks.
  - **Validation summary report** template, filled from the run: scope, what was run, deviations, residuals and known
    issues, the open expert decisions; the conclusion is left for the customer's QA.
  - **Release notes with requirement-level impact** (the delta against the previous release's bundle: controls whose
    implementation, tests or results changed), the **SBOM** (CycloneDX) and the **known issues** (from the backlogs).
  - **Site master file paragraph** describing the computerised system for the customer's SMF (IN-12 clause 1).
  - **AI feature inventory** (PR-60 clause 1) from the analytics method registry: each method, its intended use, its
    version, `changesGmpData: false`, and the human e-signature on every disposition; the generator fails if a
    registered method says otherwise.
- **The interlocks (core, database-enforced, kernel range of this slice):**
  - **DI-03 clause 2:** a GMP batch is refused on a release that has no approved validation summary in that
    installation. QA approves the summary of `platform.schema_release()` with a signature bound to the summary's hash
    (`VALIDATION.APPROVE_SUMMARY`); the batch issue on a GMP installation checks it (EBMR-VAL-001). The sandbox and
    training mode are not GMP and are not gated.
  - **DI-06 clause 1:** the approved system description (configuration area `SYSTEM_DESCRIPTION`, under change
    control, kernel 1195) lists the enabled interfaces. An inbound message, or an adapter start, for an interface not in
    the approved description raises the INTERFACE_DRIFT alarm and is refused.
- **The build-status tool:** `pnpm register:status --bundle <file>` computes each control's build status by D-P7-2 from
  a bundle and writes it to the control files (only `build_status`); `register:validate` refuses a VERIFIED control that
  the rule does not allow. It runs for real only in 7f, on the release candidate's bundle.
- **Tests:** each document generated from the example bundle and from a real bundle of a migrated database; the
  determinism test (two runs, same bytes); the IN-12 manifest test; the PR-60 inventory test; the IQ script against a
  correct installation (all pass) and against one with a dropped trigger, a revoked privilege and a demo key (each
  fails, by name); the interlock tests with their bypass tests.
- **Migrations:** kernel 1350-1364, site-services 1130-1139, recipe-core 1250-1259, tablets 1450-1459.
- **Handbook:** `modules/validation-kit.md` (new), `modules/tools-validation.md` (new), `06-testing-and-debugging.md`
  (generating the pack), `10-runbooks.md` (approving a validation summary and the system description).

### Slice 7d: performance, restore, security verification, accessibility

- **Load and soak (`tools/load`, a TypeScript driver over the HTTP API and the adapter feeds; no new load tool).**
  - Reference site (D-P7-4): 100 batches a day and 20,000 data points per batch (outline 4.4), 50 shop-floor sessions,
    the OPC UA feed at 50 tags, the EMS feed, alarms and the ERP/WMS, QMS, LIMS, LMS and CMMS simulators, on a
    database seeded with a year of history (generated batches, not golden ones).
  - SLOs: a 50,000-entry batch review opens under 5 s; p95 command under 300 ms (on the pod's loopback, recorded as an
    upper bound for a site LAN); a release commits under concurrent ingestion with at most one serialisation retry in
    99 of 100 releases; no message lost or duplicated (counts and checksums equal at the end); the nightly analytics run
    finishes within 30 minutes and blocks the event loop for no more than 200 ms at a time; each analytics flag view
    answers under 1 s (P6A7-4, P6A7-5).
  - Soak: 4 hours at three times the reference rate on the pod: memory steady after warm-up (RSS growth under 10 %), no
    connection or file-handle leak, journal and spool sizes bounded, no error in the logs.
  - In the cloud session a 10-minute smoke of the same driver; the measured run is on the pod at the exit (7f).
  - If an SLO fails: the fix follows the fix-finding skill (P6A7-4, P6A7-5 and the trigger load are the first
    suspects), at most 2 fix rounds, then a residual for the owner.
- **Restore drill and record (DI-02 clause 1, IN-09 clause 3):** on a database with the golden batches: back up,
  restore into an isolated instance, verify the chains against the anchors, record the signed restore event, render a
  closed batch completely; export a batch and restore it into an isolated environment. The drill writes its record from
  the template (`docs/operations/restore-drill-report-template.md`) with the measured RPO and RTO beside the proposals.
- **Upgrade drill (DI-46 clause 2):** take a database at the Phase 6A state (main at the start of Phase 7) with closed
  records, upgrade it to the release candidate, then retrieve and render the records: content, audit trail and
  signatures intact, hashes equal.
- **Migration dry run (DI-48 clause 1):** the same upgrade run as a dry run on a copy: row counts and hashes per GMP
  table before and after equal, and spot checks of audit trails, e-signature meaning and date-time and units unchanged.
  This proves the clause for the release's own data migration; a migration of a customer's legacy data is a deployment
  item (D-P7-8).
- **Security verification (`docs/security/pentest-checklist.md`, from the threat model and ASVS level 2):** every item
  marked AUTOMATED (with the test that proves it), INTERNAL (checked by hand here, with the record) or EXTERNAL (needs a
  penetration tester at deployment). Automated here:
  - a route-by-role authorization matrix test over every route (unauthenticated 401, every role without the right
    403, the right role allowed);
  - session cookie flags, CSRF refusal, session fixation, idle and absolute timeouts, rate limits on authentication and
    signing;
  - security headers and the content security policy on every page;
  - TLS settings of the adapters' mutual TLS and of the server, refusal of plain HTTP off loopback;
  - input fuzzing of the routes with fast-check (malformed bodies refused with 400, never a 500 with a stack);
  - dependency audit, licence scan, secret scan and the SBOM in CI; the release manifest and SBOM signed with the
    release key (ASVS V10.3, V14.2; a demo key here, a KMS key at deployment);
  - hardening verification of the installation, shared with the IQ script (PostgreSQL settings, roles, demo keys,
    open ports).
  Findings are rated by D-P6j-c-1; critical and high are fixed with tests in this slice.
- **Accessibility audit (WCAG 2.2 AA, outline 7.4):** axe on every screen of the browser suite (zero serious or critical
  violations); keyboard-only flows for the office screens; shop-floor targets at least 44 x 44 CSS px measured on every
  floor screen; state shown by colour, icon and word; contrast at least 4.5:1; the inactivity warning. The record is
  `docs/validation/accessibility-audit.md`, with each WCAG criterion marked automated, checked by hand, or left to a
  screen-reader user test at deployment.
- **Migrations:** kernel 1365-1374, site-services 1140-1149, recipe-core 1260-1269, tablets 1460-1469 (fixes only).
- **Handbook:** `06-testing-and-debugging.md` (load, soak, drills), `10-runbooks.md` (restore, upgrade), the security
  checklist linked from `03-architecture.md`.

### Slice 7e: branding and the guides

- **Branding (decision 0020), text and assets users see; code names unchanged:**
  - the sign-in page: the Batchwright Tablets lockup and "by Medhanta" with the Medhanta logo;
  - the application header and the about page (product, edition, version, maker);
  - the web app's title ("Batchwright Tablets") and icon (from `batchwright-icon.svg`, with the PNG sizes the browser
    and the installed app need);
  - the handbook cover and the product documents (the guides, the validation pack's cover pages): Batchwright with the
    Medhanta logo;
  - screen texts that say "eBMR" as a product name (not as a term for the record) become "Batchwright".
  - **GMP records keep the manufacturer's identity:** no vendor logo or name on a batch record, true copy, label,
    report or certificate; a test asserts that the golden batches' records and true copies carry no "Batchwright" and
    no "Medhanta" and that the golden outputs are unchanged. The optional "Batchwright" version line on a true copy's
    metadata is not added in v1.0 (D-P7-11).
  - The colours sampled in decision 0020 become tokens in `ui-kit`; contrast is checked by 7d's audit.
- **User guide** (`docs/guides/user-guide/`, by role): operator and shift supervisor on the floor, QA reviewer, the
  authorised person and market releases, the master-data steward, the MBR author, the DI lead (audit-trail review and
  analytics flags), the controlled-substance roles (draft banner). Each task names the screen, the right it needs and
  the signature meaning it asks for. The permission and screen lists are generated from the code.
- **Administrator guide** (`docs/guides/admin-guide/`): installation and the IQ, configuration and change control,
  users, roles and recertification, devices, gateways and their keys, adapters with mutual TLS and the approved system
  description, the analytics runner and its role, backups, the restore and upgrade drills, monitoring and the health
  page, the periodic evaluation pack, the validation summary approval, incident handling (CERT-In reporting step as
  built), and known issues.
- Both guides are Markdown with a build to self-contained HTML and to PDF (`tools/guides`, printing through the browser
  suite's Playwright); `handbook:check` checks their links.
- **Migrations:** none expected (kernel 1375-1379 and tablets 1470-1474 reserved).
- **Handbook:** the cover page and `README.md`; `modules/tablets-web.md` (branding tokens).

### Slice 7f: the Phase 7 exit and v1.0-rc

- **Trace at 7:** `phase.yaml` goes to 7 in this slice's PR. Every Phase 7 deferral is proven by its slice (table
  below); none is left deferred to 7, because the schema's last phase is 7. The slice that proves a clause maps it in its own
  PR (the `deferred` entry replaced by the clause's tests; the clause text, catalog test and target phase unchanged).
  The four 6A drafts become due and pass. Every
  tagged test is listed (`register:sync-tests`). `docs/build-plan/phase-4/trace-deferrals.md` gets its "Phase 7 exit"
  section.

  | Control | Clause (short) | Proven in | How |
  |---|---|---|---|
  | DI-02 | 1, export a batch and restore it into an isolated environment | 7d | restore drill |
  | DI-03 | 2, GMP batch refused without an approved validation summary | 7c | validation-summary interlock |
  | DI-06 | 1, drift alarm for an interface not in the approved description | 7c | approved system description |
  | DI-06 | 2, boundary-test evidence for every critical limit in the matrix | 7c | trace matrix with critical-limits list |
  | DI-08 | 2, full export re-opens in the stand-alone viewer | 7b-2 | record viewer |
  | DI-11 | 1, periodic evaluation pack traced to source logs | 7b-2 | periodic evaluation pack |
  | DI-44 | 1, periodic readability report | 7b-2 | readability report |
  | DI-46 | 2, upgrade the test environment, retrieve and render | 7d | upgrade drill |
  | DI-48 | 1, migration dry run | 7d | upgrade dry run (D-P7-8) |
  | IN-09 | 3, restore a backup to a test instance; a closed batch renders | 7d | restore drill |
  | IN-12 | 1, the package holds each listed artefact and the SMF paragraph | 7c | pack manifest |
  | PR-60 | 1, AI feature inventory | 7c | generated inventory |

- **Review:** one review pass over Phase 7 (design and serious defects; regulated core probed on a migrated database,
  the rest read; D-P6j-c-1 for the rating). Critical and high fixed with tests, at most 2 fix rounds each; the rest go to
  `docs/build-plan/phase-7/review-backlog.md`.
- **The combined heavy run on the pod (D-6A-15, decision 0023; D-P7-3 for the order and box):**
  1. Final run 1 on the release-candidate commit: static checks, the full suite, golden batches GB-T-01 to GB-T-03,
     the browser suite, `pnpm trace` at 7, `handbook:check`. This is also Phase 6A's heavy final run.
  2. The load test, the 4-hour soak, the restore, upgrade and migration drills, the security automation and the IQ
     script on the pod installation; their records go into the bundle.
  3. The focused mutation campaign (D-P7-1 item 4).
  4. The new tests and fixes, then final run 2, all green in one run; the OQ record is this run.
  5. `pnpm validation:bundle` on final run 2's reports, then `pnpm register:status` (D-P7-2) and the generated pack.
- **Release candidate checklist** (`docs/build-plan/phase-7/v1.0-rc-checklist.md`, written in this slice):
  - every slice merged with green CI and its review; the exit review done; no open critical or high finding in any
    backlog (Phases 3 to 7);
  - final run 2 green in one run; the trace at 7 ok;
  - the build statuses of D-P7-1 item 1 reached and listed;
  - the SLO, soak, restore, upgrade, migration, security and accessibility records written, each SLO met or its
    residual written for the owner;
  - the mutation campaign's record with its residuals; no unfixed Priority 1 defect;
  - the validation pack generated, its manifest hashes recorded; the SBOM and release manifest signed;
  - the release notes, known issues and the open expert decisions listed;
  - versions: `apps/tablets-server` and `apps/tablets-web` at `1.0.0-rc.1` (shared packages keep their versions and
    exact pins); the tag `batchwright-tablets-v1.0.0-rc.1` on the merge commit;
  - PROGRESS.md and history updated. No demo (decision 0021); the v1.0 demo follows the release candidate.
- **Migrations:** kernel 1390-1399, site-services 1190-1199, recipe-core 1290-1299, tablets 1490-1499 (exit fixes only).

## Interfaces fixed up front (in 7-0; changed only through the lead)

[slice-7-0-interfaces.md](slice-7-0-interfaces.md):
- the evidence bundle v1 (what the generators read) and the critical-limits list;
- the gateway feed signature format and its verification point; the adapter TLS settings;
- the release identity, the validation-summary approval and the approved system description;
- the batch-scope pattern for the rest of R16 and the `CONTROLLED.READ` permission;
- the tool commands, the record files and their places;
- the test-kit helpers and the fixed test titles.

Every change after 7-0 is additive: a new optional field, a new document, a new check.

## Controls and their class (decision 0008 section 2)

| Slice | Core (database-enforced, full tests, control ids in names) | Other (application code allowed, with tests) |
|---|---|---|
| 7a | gateway feed signature checked in the database, direct receive path closed to the integration role (DI-31, DI-20); QA approval before a facility rule or beta-lactam classification takes effect (PR-27); controlled reads gated (IN-53); batch-scope evaluation of the remaining batch acts (IN-04, DI-17, DI-21) | mTLS set-up and start-up refusal in the server; health page text |
| 7b-1 | gap acknowledgment only by system owner or QA; contract-giver scope; DSC administrator check; insert-only outbound table; source-time lower bound; series gap alarm in the database | scheduled reconciliation, gateway spool, route answers, messages, meta scans, runner start-up check, reason order |
| 7b-2 | the evaluation pack's QA sign-off bound to its hash; the viewer cannot write | pack selection and layout, viewer screens |
| 7c | validation-summary interlock at batch issue (DI-03); interface drift refused and alarmed (DI-06) | generators, bundle, IQ/OQ scripts, build-status tool, inventory |
| 7d | (fixes only, if a finding needs one) | load and soak driver, drills' records, security automation, accessibility audit |
| 7e | (none; GMP records unchanged, tested) | branding, guides |

No control text, catalog test, target phase or `expert_decision` is changed by this plan or by any slice. A control that
seems wrong is written up for the owner.

## Migration ranges (each builder only in its own)

| Source (highest on main / in PR #50) | 7-0 | 7a | 7b-1 | 7b-2 | 7c | 7d | 7e | 7f |
|---|---|---|---|---|---|---|---|---|
| kernel (1271 / 1282) | 1300-1304 | 1305-1319 | 1320-1334 | 1335-1349 | 1350-1364 | 1365-1374 | 1375-1379 (reserved) | 1390-1399 |
| site-services (1002 / 1002) | none | 1100-1109 | 1110-1119 | 1120-1129 | 1130-1139 | 1140-1149 | none | 1190-1199 |
| recipe-core (1170 / 1170) | 1200-1204 | 1205-1224 | 1225-1239 | 1240-1249 | 1250-1259 | 1260-1269 | none | 1290-1299 |
| tablets (1330 / 1330) | 1400-1404 | 1405-1424 | 1425-1439 | 1440-1449 | 1450-1459 | 1460-1469 | 1470-1474 (reserved) | 1490-1499 |

The gaps stay free: kernel 1283-1299 and 1380-1389, site-services 1003-1099 (6A's reserved 1010-1059 inside it) and
1150-1189, recipe-core 1171-1199 (6A-7's 1190-1199 inside it) and 1270-1289, tablets 1331-1399 (6A-7's 1380-1389 inside
it) and 1475-1489. Each file carries its `-- Handbook:` line in its first 10 lines. Never edit a merged migration;
replace a function in a new one. Ranges ascend in the merge order of D-P7-9, so the migration-order check holds.

## Decisions with defaults (owner rule: no questions asked; each default is the decision, the owner may change it)

- **D-P7-1 The reconciled exit criteria (decision 0024).** The outline asks for every FOLLOW/MODIFY control VERIFIED,
  mutation targets met and no open high-severity finding. Decision 0008 puts validation-grade testing at deployment;
  decision 0019 ran a time-boxed campaign. At v1.0-rc:
  1. **Controls.** No control has an expert decision yet (246 PENDING), so for the build every PENDING control of the
     Tablets gate is treated as FOLLOW, the stricter reading. Of the 155:
     - the 147 that are neither drafts nor partly deferred to Phase 5 (136, plus the 11 whose Phase 7 clauses this
       phase proves) reach **VERIFIED** (D-P7-2);
     - the 5 drafts (IN-53, DI-51, DI-52, DI-53, PR-61) reach **IMPLEMENTED** with every clause proven, and are held
       there until the expert has checked their draft texts;
     - the 3 controls with a part deferred to Phase 5 (PR-15, PR-26, PR-28) stay **SPECIFIED** (the validator's rule),
       with every Tablets clause proven, and are listed in the pack.
     A control the expert later sets to MODIFY is re-verified against the modification at deployment; one set to
     DONT_FOLLOW leaves the gate by the existing rule.
  2. **At deployment validation, not at v1.0-rc:** the expert's FOLLOW, MODIFY or DONT_FOLLOW on every control; the
     customer's IQ, OQ and PQ on its own installation from the generated pack; the mutation targets of decision 0008
     section 2.3 (at least 90 % in the high-risk groups, 70 % elsewhere) on the validated build; the external
     penetration test; the screen-reader user test; the whole SQL re-run and the kill confirmations left by Phases 4
     and 6.
  3. **Findings.** No open critical or high finding in any backlog at v1.0-rc (strict, as the outline says); medium
     and low are listed in the known issues.
  4. **Mutation at the exit (focused, decision 0019's rules):** the SQL harness on every database function added or
     re-created in Phase 7 and in Phase 6A (kernel 1240 to 1282 and Phase 7's ranges; recipe-core 1110 to 1170 and
     Phase 7's); Stryker on `packages/analytics`, the runner (`apps/tablets-server/src/analytics/`), the gateway feed
     signing, the adapter TLS code, the IQ checks and the build-status tool. Priority 1 (always fixed): access checks,
     e-signature binding, the audit trail, the gateway feed signature and mTLS refusal, the validation-summary and
     interface-drift interlocks, analytics segregation (no GMP write) and the restricted audit-trail flags. Priority 2:
     the rest of the high-risk zone, about 1 hour per survivor or cluster. Priority 3: recorded only. One first run and
     at most one confirmation run per group. **Time box: 6 pod hours for SQL and 4 for Stryker.** If the box allows, the
     two small groups Phase 6 did not run (bulk-and-bright-stock, execution-complete-forms) run last. Scores are
     reported against the targets; a missed target never blocks the release candidate; only an unfixed Priority 1
     defect does, and it goes to the owner.
  5. **One review pass at the exit; the full suite, golden batches, browser suite and trace at 7 green in one final
     run; at most two final runs** (one before the campaign, one after it).
  Why: the build cannot make the expert's decisions; treating PENDING as FOLLOW proves the whole register as written;
  drafts are not called verified while their regulatory text is unchecked; the time-boxed campaign of decision 0019
  covers the code not yet mutated (6A and Phase 7) without re-running what Phase 6 measured.
- **D-P7-2 What the build statuses mean** (written into REPO-GUIDE.md and enforced by `register:validate` from 7c):
  - SPECIFIED: in the register; some part not yet proven or deferred.
  - IMPLEMENTED: every clause names listed tests that passed in the trace's run, nothing deferred.
  - VERIFIED: IMPLEMENTED on the release candidate's final run, with the evidence in the pack's bundle (each clause's
    tests passed on that commit, with run id and report hashes); the control lies in code covered by a review pass
    (slice review or exit review); no open critical or high finding names it; a core-class control has a database test
    (a guard or bypass test) among its tests; a control with a critical limit has its boundary tests listed. The status
    is set only by `register:status` from a bundle, never by hand.
- **D-P7-3 Order and box of the pod run:** the order of slice 7f; the whole pod session is boxed at 24 pod hours
  (final runs about 3 hours each, load and drills about 3, soak 4, mutation 10, fixes the rest). A container restart's
  lost time counts. When the box ends, what is left is a residual for the owner.
- **D-P7-4 Reference site for the SLOs:** 100 batches a day and 20,000 data points a batch (outline 4.4 sizing), 50
  shop-floor sessions, 50 OPC UA tags at 1 Hz, the EMS feed and every 6a adapter at its simulator's default rate, a
  year of generated history. The pod's hardware is recorded with the results; the customer's PQ repeats the measurement
  on its own hardware.
- **D-P7-5 Soak:** 4 hours at three times the reference rate. Why: long enough to show leaks and growth at the cost the
  box allows; the owner may ask for 24 hours at deployment.
- **D-P7-6 Which residuals are fixed in Phase 7:** those touching access, attribution or silent loss, and cheap ones
  that remove a misleading answer (slice 7b-1's table). The rest are known issues.
- **D-P7-7 F-6jb-g1:** fixed only if a lock-only epoch bump can be told apart in the database with no other change
  detection loosened; otherwise it stays (it fails safe: the next market's signer acknowledges the items again).
- **D-P7-8 DI-48:** the migration dry run is the release's own upgrade, run as a dry run with counts and hashes and the
  spot checks of the clause. A migration of a customer's data from another system is a deployment item, recorded in the
  pack's known issues and the administrator guide. Why: the build has no legacy source to migrate from; the upgrade
  path is the migration the product itself performs.
- **D-P7-9 Merge order and migration order:** slices merge in the order 7-0, 7a, 7b-1, 7b-2, 7c, 7d, 7e, 7f, so their
  ascending ranges merge in numeric order and the 6jc-R4 check passes. A slice ready early either waits or, before it
  merges, moves its unmerged migrations to the next free numbers above main (an unmerged file may be renumbered; a
  merged one never).
- **D-P7-10 Gateway feed security:** both a signature and mutual TLS. The signature makes each envelope's origin
  checkable in the database and after the fact (it is journalled and stored); mutual TLS protects every adapter's
  channel, including those whose source cannot sign. Loopback stays allowed without TLS for a gateway on the server's
  own host.
- **D-P7-11 No "Batchwright" version line on GMP records in v1.0.** Decision 0020 allows one where the system
  identifies itself, with the golden outputs taken again. The release identity is already in the IQ record and the
  validation summary; adding the line now would move the golden hashes in the release candidate for little gain. It can
  come in v1.1 with the golden outputs taken again on purpose.
- **D-P7-12 Validation-summary and drift interlocks in tests:** every GMP test database, golden set-up and browser
  set-up approves a validation summary and a system description through the test-kit helpers (7-0), with real signed
  acts. If a golden output moves because of the approval's audit entries, it is taken again once, on purpose, with the
  reason in the defect log.
- **D-P7-13 Pack formats:** Markdown and self-contained HTML for every document, PDF through the browser suite's
  print; the generated pack is not committed (it is rebuilt from the bundle); the release candidate's pack and bundle
  are kept on the branch `phase-7/rc-evidence` with their hashes in the checklist.
- **D-P7-14 Product version:** `1.0.0-rc.1` on the two Tablets apps and in the release manifest; shared packages keep
  their versions and exact pins (ADR 0015).
- **D-P7-15 External penetration test and screen-reader test** are deployment items (the outline's "cannot here"
  list); the checklist marks each EXTERNAL item so the tester starts from it.
- **D-P7-16 Default ids:** plan defaults `D-P7-n`; interface defaults `D-P7-0-n`; a slice's own defaults
  `D-P7a-n`, `D-P7b1-n`, `D-P7b2-n`, `D-P7c-n`, `D-P7d-n`, `D-P7e-n`, `D-P7f-n`.

## For the owner's attention (no questions asked; the defaults stand)

1. **The expert's decisions.** All 246 controls are PENDING (pack version 0.9). The release candidate proves the
   register as written (D-P7-1); deployment needs the expert's FOLLOW, MODIFY or DONT_FOLLOW, and IN-53 and the four 6A
   drafts need someone qualified to check their draft texts. This is the owner's to arrange; nothing in Phase 7 sets an
   `expert_decision`.
2. **External penetration test and screen-reader test** before the first networked site (D-P7-15).
3. **A larger Medhanta logo** (SVG, or a PNG of 1000 px or more) for the handbook cover and printed documents
   (decision 0020); until it comes, the cover uses the 278 x 148 file at its natural size. The trademark search stays
   the owner's (decision 0020).
4. **RPO and RTO** are still proposals (`docs/operations/ha-and-restore.md` section 3); the restore drill records the
   measured values beside them.

## Order, agents and close

- 7-0 first (the lead). Then 7a, 7b-1, 7b-2, 7c and 7e in parallel in their own worktrees (they share no files outside
  the lead's shared files): up to five agents at a time (decision 0017), model by task as CLAUDE.md says. 7d starts when
  7a has merged (it needs the mTLS set-up) and uses 7c's bundle when it lands. Merges follow D-P7-9.
- Each builder has its own spare cluster (local-ci skill) and runs the changed folders locally; GitHub CI is the merge
  gate. The cloud session runs the smoke versions of load and soak only.
- PR #50 (the 6A exit) merged first (bc46d55); this plan's branch took main with a merge commit.
- 7f last: trace at 7, exit review, then the pod run (D-P7-3), then the release-candidate PR.
- Per slice: done when it has its tests, green CI, its module guide and `08-defect-log.md` updated, `pnpm handbook`
  regenerated and `pnpm handbook:check` green. One quick review, then one PR, then PROGRESS.md and
  `docs/build-plan/phase-7/review-backlog.md` at each merge.
