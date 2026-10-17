# Phase 6A: analytics (Tablets edition)

Plan written 17 October 2026, before building, for the owner's record and for the builders. Owner decision 0023: the
analytics features of decision 0016 (items 1, 2, 3, 8, 9 and 10) are built now, between Phase 6 and Phase 7, so v1.0
ships with them and the Phase 7 validation pack covers them once. Item 16, the scheduler, is dropped. Phase 7 follows 6A
in this session and is not planned here.

The rules come from these documents:
- Decision 0015 is the rule set. Analytics is advisory only, runs in a separate read-only module, and keeps versioned,
  validated outputs. Statistics come first, and QA's feedback is stored.
- Decision 0008 sets the depth: tests with every feature and one review pass per slice. A finding gets at most 2 fix
  rounds. The regulation-required core is enforced in the database.
- Decision 0017: up to five agents at a time, and independent slices may overlap in their own worktrees.
- Decision 0021: no demo at the exit.
- ADR 0020 is the architecture. Interfaces are fixed in [slice-6A-0-interfaces.md](slice-6A-0-interfaces.md).

Specs searched, not read whole:
- outline 7.3 (dashboards, never for GMP decisions), 8 (rank 17 CPV/SPC, rank 20 and 21 AI hints) and 9.2 (RBE,
  validation);
- the Phase 6 plan's slices 6b (`plant.series`, trend viewer) and 6g (the `report` path, `ebmr_report`, training mode),
  and its section "Left ready for the analytics work".

## Starting point (checked on main e0bc24e, 17 October)

- Phase 6 is closed. `phase.yaml` is at 6, with `editions: [tablets]`. The trace passes at 6 with 146 of 242 controls.
- Highest migrations: kernel 1230, site-services 1002, recipe-core 1100, tablets 1320. Every new migration carries
  a `-- Handbook: <page>` line in its first 10 lines.
- **Inputs ready:**
  - The `report` views v1 (recipe-core 1070) with `read_at` and `data_as_of`, and the role `ebmr_report`, which can only
    SELECT (kernel 1210; a bypass test proves it).
  - `plant.series` with `plant.series_in_context(batch, step, tag)` (recipe-core 0960): raw decimal text with source
    times and status.
  - The typed CPP extract `recipe.pqr_cpp_of` and `recipe.pqr_extract_v2` (recipe-core 1062).
  - The alarm log and `report.alarm_v1`, deviations with their links (`site.deviation`, `site.deviation_link`), and
    the kernel audit trail (`kernel.audit_event`) and `iam.auth_event`.
  - The review queue (`review.queue`, `apps/tablets-server/src/features/review/reads.ts`), today ordered by batch
    number.
  - Configuration change control (kernel 1195, 1196): a table registered as a configuration area refuses a row
    without an APPROVED change record.
- **Controls that touch analytics today:**
  - PR-60, forward compatibility with Annex 22: no AI or ML output changes GMP data without a human e-signature. It is a
    DESIGN_CHOICE with no tests.
  - DI-25: audit-trail review may order or highlight entries but never excludes them.
  - DI-26: review by exception (RBE) and risk-based review of system logs.
  - DI-09: change and configuration management.
  - PR-09: CPP data exported for CPV trending.
  - PR-58 and IN-01: PQR data.
  - PR-52: every exception is dispositioned individually.
  - DI-49: alarms are trended.
  - All of them have `expert_decision` PENDING. None is changed by this plan.
- **No control states the analytics rules themselves.** Four draft controls are proposed below (status U, PENDING).

## Slices (each a branch `phase-6a/slice-N` and a PR; parallel after 6A-0 and 6A-1 as the order section says)

Each slice ends with:
- green GitHub CI and its quick review;
- its handbook pages and `pnpm handbook:check` green;
- the code map regenerated.

Every screen shows the advisory band ("Advisory analytics, not for GMP decisions"), the method and version, and the
data age.

| Slice | Content | Controls proven (draft in italics) | Needs |
|---|---|---|---|
| 6A-0 | Interface commit (the lead): schema, role, tables, record functions, contract skeleton, fixtures, draft controls into the register | *DI-51*, *DI-52*, *DI-53*, *PR-61* (entries only) | none |
| 6A-1 | Foundation: runner, input views, segregation and dependency proofs, method change control, dispositions, monitoring, methods and flags screens | *DI-51*, *DI-52*, PR-60, DI-09, DI-22 | 6A-0 |
| 6A-2 | SPC and capability with drift alerts (item 1); deviation-rate comparisons with confidence intervals (item 3) | *DI-51*, *DI-52*, PR-09, PR-58, DI-49 (input) | 6A-1 |
| 6A-3 | Multivariate monitoring: PCA, Hotelling's T-squared, Q residuals, contributions (item 2) | *DI-51*, *DI-52*, DI-09 (reference sets) | 6A-1 (6A-2's batch vectors) |
| 6A-4 | Audit-trail anomaly detection: rules, then per-user baselines (item 8; no ML) | *DI-53*, *DI-52*, DI-25, DI-26 | 6A-1 |
| 6A-5 | Review priority: the scored and ordered QA review queue (item 9) | *PR-61*, DI-25, PR-52 | 6A-2, 6A-4 |
| 6A-6 | Golden batch profile on the OPC UA series (item 10) | *DI-51*, *DI-52*, DI-32 (input) | 6A-1 |
| 6A-7 | Exit: one review pass, clauses of the drafts, trace at 6, handbook; heavy run per D-6A-15 | all above | all |

### Slice 6A-0: interfaces (the lead; the commit before any builder starts)

- The notes [slice-6A-0-interfaces.md](slice-6A-0-interfaces.md) become code:
  - kernel 1240 to 1244: the schema `analytics`, the role `ebmr_analytics`, the tables, the record functions, the read
    views, the permissions `ANALYTICS.*`, and the configuration areas `ANALYTICS_METHOD` and `ANALYTICS_REFERENCE`;
  - recipe-core 1110 to 1114: the four draft control names in `recipe.engine_name`;
  - tablets 1330 to 1334: the role-permission grants for the Tablets roles.
- **The package and contract skeleton:**
  - the package skeleton `packages/analytics` with `statOf`, the method registry types and canonical hashing;
  - the dependency-cruiser rules of ADR 0020, each with its fixture;
  - contract files `ns/analytics*.ts` with every route declared and an example in `fixtures/`;
  - the module entry in `docs/handbook/modules.yaml`.
- **The synthetic history fixture** `analyticsHistory` (test-kit), so slices run in parallel without waiting for each
  other's views.
- **The draft controls** move from `draft-controls/` into `compliance/controls/`: DI-51, DI-52, DI-53, PR-61, with
  requirement row n680. The counts go to 246 controls and 680 rows in `register.ts`, `validate.ts` (DI 53, PR 61), the
  `[meta]` test, the engine-name test and REPO-GUIDE (D-6A-3).
- **File ownership (decision 0017 point 3):** each slice owns its own contract file, server folder
  (`features/analytics/<slice>/`), screens folder (`features/analytics/<slice>/` in tablets-web), method files
  (`packages/analytics/src/methods/<family>/`) and migration range. Shared files (`ns/analytics.ts`, `routes.ts`,
  `NAMESPACE_OWNERS`, `modules.yaml`) change only through the lead.

### Slice 6A-1: foundation

- **Runner** (`apps/tablets-server/src/analytics/`), started with the server on the GMP installation only (D-6A-6):
  - It runs on a nightly schedule and when it sees newly completed batches (it polls `report.batch_outcome_v1`; no
    trigger from GMP tables).
  - It runs each method version that is EFFECTIVE at database time.
  - It reads inputs in one REPEATABLE READ READ ONLY snapshot as `ebmr_analytics`.
  - It records `begin_run`, outputs, flags and `finish_run`, or `fail_run` with the error. A failed run leaves no
    output.
  - Time comes from the database clock, never `Date`.
- **Input views v1** (recipe-core 1115 to 1129; listed in `analytics.input_catalog_v1`):
  - `report.cpp_value_v1`: each critical value with its limits from the issued master, as decimal text, built on
    `recipe.pqr_cpp_of`;
  - `report.batch_fact_v1`: the batch with its product, MBR version, family and completion time;
  - `report.step_use_v1`: step, equipment, room, start and end, persons, material lots.
- **Proofs [DI-51]:**
  - The segregation check and the bypass test for `ebmr_analytics`.
  - The dependency scan: no GMP foreign key into `analytics`, and no function, view or trigger outside `analytics` and
    the read views that depends on `analytics`.
  - No floating column outside `analytics`.
  - The dependency-cruiser fixtures.
  - The golden batches GB-T-01 to GB-T-03 run with the runner on and keep their exact outputs (record hash, exception
    report, true copy).
- **Method change control [DI-52] [DI-09]:** a method version or reference set is written only under an APPROVED
  change record that lists its area. `platform.config_as_of` shows the methods in force at any past instant. The
  methods page lists each version with its intended use, parameters hash, validation reference and validity.
- **Dispositions [DI-52]:**
  - `analytics.record_disposition` through the server, as the person (ADR 0016 actor context).
  - The verdict is TRUE_SIGNAL, FALSE_ALARM or NOT_ASSESSABLE, with a cause and an optional deviation reference.
  - A later disposition supersedes the earlier one and needs a reason.
  - Rows are insert-only and audited.
- **Monitoring:** `analytics.method_monitor_v1` gives runs, failures, flags, the dispositioned share and the
  false-alarm rate per method version and month. It is shown on the methods page.
- **PR-60 inventory:** `analytics.catalog` lists every analytics feature with its intended use and "changes GMP data:
  no". A test checks the list against the registry.
- **Screens:**
  - `/analytics`: the overview, with the advisory band;
  - `/analytics/methods`;
  - `/analytics/flags`: the open flags the person may see, with the disposition dialog.
- **Tests:**
  - `[DI-51] the analytics role cannot write: no insert, update or delete outside analytics, no command, and the
    segregation check reports any extra grant`
  - `[DI-51] no GMP table, function, view or trigger depends on the analytics schema`
  - `[DI-51] no floating-point column exists outside the analytics schema`
  - `[DI-51] the golden batches keep their exact outputs with the analytics runner on`
  - `[DI-51] analytics tables refuse update and delete, whoever writes`
  - `[DI-52] a method version without an approved change record is refused`
  - `[DI-52] every output names its run, method version and input references; a re-run reproduces it`
  - `[DI-52] a disposition is recorded by the person who gave it, audited, and superseded only with a reason`
  - `[PR-60] the analytics catalogue lists every method and none changes GMP data`
  - `statOf refuses text that is not a decimal and converts exact decimals`
  - Runner tests: a run on one snapshot, a failed run, and the poll that sees a newly completed batch.
- **Migrations:** kernel 1245 to 1259, site-services 1010 to 1019 (reserved), recipe-core 1115 to 1129, tablets 1335 to
  1339.

#### 6A-1 as built (17 October)

- **Migrations:** kernel 1245 (method change control, the screens' views, restricted dispositions); recipe-core 1115
  (input views v1, registered with `report.batch_outcome_v1`). Tablets 1335-1339 and site-services 1010-1019 are not
  used.
- **Server:** the runner `apps/tablets-server/src/analytics/` (started in `buildApp` on GMP with `EBMR_ANALYTICS=on`),
  the feature `features/analytics/` binding `analytics` (joined to `routes.ts` and `NAMESPACE_OWNERS` as `P6A`, per
  D-6A-0-4) and the new namespace `analyticsConfig` (D-6A-1-1). Screens in `tablets-web/src/features/analytics/`.
- **Tests:** kernel `test/analytics/method-change.test.ts`; recipe-core `test/analytics/input-views.test.ts`; server
  `test/analytics/runner.test.ts` and `routes.test.ts`; web `test/analytics/analytics.test.tsx`; the `[meta]` lint
  proof `tools/boundaries/test/number-ban.test.ts`; the golden test `[DI-51] the golden batches keep their exact
  outputs with the analytics runner on` in GB-T-01 to GB-T-03. The 6A-0 tests that listed exact sets (readable tables,
  app-callable functions, FRESH_ON_SHARED routes, route uniqueness) now include 6A-1's objects.
- **Mutation groups:** `analytics-method-change` and `analytics-inputs` (90 %), jobs in `mutation.yml`.

Defaults of 6A-1 (taken without asking, as the owner's rule says; each is the decision until the owner changes it):

- **D-6A-1-1** Method versions and reference sets are written through a new namespace `analyticsConfig`
  (`ns/analytics-config.ts`: POST `/api/analytics/method-versions` and `/api/analytics/reference-sets`). The config
  namespace has no generic write route; its areas, history and differences list the analytics areas unchanged. These are
  configuration writes, so they carry no advisory envelope and are not in `ANALYTICS_NAMESPACES`.
- **D-6A-1-2** `cpp_value_v1` gives the limits of the outermost tier the master states, in the order REGISTERED,
  VALIDATED, INTERNAL_ACTION, ALERT, and names that tier (`limit_tier`, an added column).
- **D-6A-1-3** Only DECIMAL, COUNT and SERIES values appear; a SERIES gives one row per reading (`reading`, added); a
  calculation's role is null.
- **D-6A-1-4** `step_use_v1` has one row per executed step and bound unit (a step without a binding: one row, no unit).
  The room is the unit's room, else the room the batch occupied when the step started, else the batch's own room. The
  persons are the performers, data enterers and correctors. The lots come from the consumptions the step's entries
  name. Added columns: `batch_number`, `step_id`.
- **D-6A-1-5** The input views hold GMP batches only. They are report views like the 6g ones: in the report catalogue,
  readable by the reporting role and the dashboards' documented export, and on the analytics role's allow-list.
- **D-6A-1-6** A method version or reference set never changes. A later row of the same version (or set id) may only
  retire it, and a retired one stays retired. Table triggers enforce this for every writer, the release included
  (EBMR-ANA-013, -014).
- **D-6A-1-7** The server computes the parameters' SHA-256 and the code identity `@ebmr/analytics <version> (commit
  <EBMR_COMMIT>)`. Before each run the runner checks the hash, the parameter schema and the package version again. A
  mismatch is a FAILED run with the reason.
- **D-6A-1-8** `analytics.run_v1` shows a run unended an hour after its start as FAILED, as the monitor counts it.
- **D-6A-1-9** The dispositions of a restricted flag are read through the definer `analytics.person_flag_dispositions`
  (ANALYTICS.DI_REVIEW).
- **D-6A-1-10** `IMPLEMENTATIONS` is empty in 6A-1. A version in force that no implementation covers is skipped and
  logged, not recorded as a failed run.
- **D-6A-1-11** The input hash covers each row without `read_at` and `data_as_of`, with the rows sorted by canonical
  text. The method gets the rows in that order.
- **D-6A-1-12** The runner holds one connection. Times, dates and numbers come back as text. When the role's
  connection limit (4) is reached, the runner waits up to 10 seconds.
- **D-6A-1-13** The catalogue route lists the package registry through the runner folder's `catalog.ts`. The feature
  never imports `@ebmr/analytics` itself.
- **D-6A-1-14** The poll's baseline is kept in memory and set by the first poll. A batch completed while the server was
  down is covered by the next nightly run. A start after 02:00 waits for the next day's run.
- **D-6A-1-15** Configuration: `EBMR_ANALYTICS` (on or off, default on, GMP only), `EBMR_DB_ANALYTICS_URL` (required in
  production) and `EBMR_COMMIT` (default `development`). Server tests run with it off because the role has 4
  connections on the whole cluster. The runner tests and the golden batches turn it on.
- **D-6A-1-16** A flag is linked to the run's first output about the same subject, if there is one.
- **D-6A-1-17** The flags list shows flags about a person or an account only when asked for by kind. Without a period,
  the list shows the open flags, those without a disposition.
- **D-6A-1-18** A method version's parameters and acceptance criteria travel as JSON text. The request hash is canonical
  JSON, and it refuses fractional numbers.
- **D-6A-1-19** Libraries (D-6A-23): `ml-matrix` 6.15.0 and the @stdlib quantile packages (beta, chi-square, F and t
  0.2.3, normal 0.3.1, all published by February 2026). They are pinned exactly, recorded with every run
  (`RUNTIME_LIBRARIES`, equal to package.json by a test) and wrapped in `numeric/quantiles.ts` and `numeric/linalg.ts`.
- **D-6A-1-20** Every analytics read needs ANALYTICS.VIEW. The database checks it in a command
  (`iam.require_permission`); the refusal is EBMR-IAM-040, answered 422 as everywhere.
- **D-6A-1-21** In the golden batches the runner is on all along (it polls every minute) and runs once more on demand
  before the outputs are read. The run uses the test's probe method, because no production method exists yet.
- **D-6A-1-22** A flag the person may not see answers 404 (EBMR-ANA-016), which does not reveal that a restricted flag
  exists.

### Slice 6A-2: SPC, capability, drift alerts and deviation-rate comparisons (items 1 and 3)

- **Control charts** per product, MBR family and critical item (`report.cpp_value_v1`):
  - I-MR for one value per batch; Xbar-S for an IPC with two or more readings per batch.
  - Limits come from the approved reference set, or from the first 20 batches (Phase I) when no set exists, and say
    which (D-6A-7).
  - Run rules: Nelson 1, 2, 3 and 5 (D-6A-7). A rule hit is a flag with its rule, points and reason.
- **Capability:** Ppk (overall sigma) and Cpk (within sigma from the mean moving range) with 95 % intervals, against
  the master's specification limits (decimal text echoed unchanged). Shown from 25 batches, with an Anderson-Darling
  normality note (D-6A-8).
- **Drift alerts:**
  - a significant slope over the last 10 batches projected to cross a specification limit within 5 batches;
  - or an EWMA signal (lambda 0.2, L 2.7).
  - Either raises an ATTENTION flag (D-6A-9).
- **Deviation rates:**
  - Groups: step, equipment, supplier lot, room and shift (input views over `site.deviation_link` and
    `report.step_use_v1`; the shift comes from a site setting, D-6A-10).
  - The share of batches with a deviation per group gets a Wilson 95 % interval. Deviations per 100 batches get an
    exact Poisson (Garwood) interval.
  - Each group is compared with the rest, with Benjamini-Hochberg control at 10 % across groups. A group needs at least
    5 batches.
  - A funnel view shows the groups against the comparison limits.
- **PQR and CPV:** the PQR screen links to the charts for the same product and period as an advisory annex. The PQR
  extract and its signed content do not change (D-6A-18; PR-09, PR-58).
- **Alarm trend** (DI-49, 6g) stays as built; the rate method can take `report.alarm_v1` as a group input.
- **Screens:** `/analytics/spc` (chart, rules, capability panel), `/analytics/rates` (table, funnel).
- **Tests:**
  - reference values against published worked examples and the offline reference fixture (charts, Cpk and Ppk with
    intervals, Wilson, Garwood, Benjamini-Hochberg);
  - `[DI-52] the SPC run on the synthetic history flags the seeded shift at batch 24 with Nelson rule 2 and names its
    reasons`;
  - `[DI-52] capability is not shown below 25 batches`;
  - `[DI-51] the SPC response echoes the master's limits as the source's decimal text and types statistics as
    StatNumber`;
  - `[DI-52] the deviation-rate comparison finds the seeded room and keeps the others within limits`;
  - `[DI-51] the PQR extract's content and hash are unchanged with analytics present`.
- **Migrations:** site-services 1020 to 1029 (reserved), recipe-core 1130 to 1139, tablets 1340 to 1344.

### Slice 6A-3: multivariate monitoring (item 2)

- **Model:** per product and MBR family (D-6A-11):
  - The batch vector holds the critical items, one value or the mean per batch, from 6A-2's vectors; the variables
    are autoscaled.
  - PCA by SVD (`ml-matrix`), keeping components to 90 % cumulative variance, at most 5.
  - For a reference batch the Hotelling T-squared limit uses the beta distribution; for a new batch it uses F. Both are
    at 99 %. The Q (SPE) limit uses Jackson-Mudholkar at 99 %.
  - The contributions of each variable to T-squared and Q are shown for a flagged batch.
- **Reference set:**
  - The runner fits a candidate on the batches QA proposes: released, with no critical deviation, at least 15.
  - The candidate is an output with its model hash.
  - QA makes it effective as an `ANALYTICS_REFERENCE` row under an approved change record. The database checks that the
    model hash equals the candidate's.
  - A batch with a missing variable is skipped, with that reason.
- **Screens:** `/analytics/mspc`: T-squared and Q charts, a scores plot, and a contribution bar chart that drills to
  the batch record.
- **Tests:**
  - PCA, limits and contributions against the offline reference fixture;
  - `[DI-52] the multivariate run flags the seeded batch 27 within every limit and names the top contributing
    variables`;
  - `[DI-52] a reference set whose model hash differs from its candidate is refused`;
  - `[DI-09] a reference set without an approved change record is refused`;
  - `fewer than 15 reference batches gives no model and says why`.
- **Migrations:** recipe-core 1140 to 1149, tablets 1345 to 1349.

### Slice 6A-4: audit-trail anomaly detection (item 8)

- **Inputs** (kernel 1260 to 1269): `report.audit_fact_v1`, one row per audit event. Each row holds:
  - person, account, role, terminal or device, action, table and field;
  - whether the event is a correction (an update or void after first commit), and its reason code;
  - recorded time, and the claimed or source time where the record has one.
  - Old and new values are not exported, only whether they changed.
- `report.auth_fact_v1` holds logins, failures and lockouts with terminal and time.
- **Rules first** (method `ATA.RULES` v1, thresholds in its parameters, D-6A-12):
  - a late entry (recorded more than 15 minutes after its claimed or source time);
  - a back-dated entry (claimed time before the previous entry of the same step);
  - correction counts per person and week above the site's 95th percentile;
  - one account on two terminals within 2 minutes;
  - values too regular (a terminal-digit chi-square test over a person's manual entries, at least 50 entries);
  - a test repeated until it passes (two or more failed attempts of the same IPC or result before a pass, with no
    deviation);
  - configuration changes outside the site's working hours.
- **Then per-user baselines** (`ATA.BASELINE` v1): weekly metrics per person (entries, corrections, late entries,
  failed logins) as a robust z (median and MAD) against the person's own trailing 13 weeks. A person needs 6 weeks of
  history. The flag is at |z| above 3.5.
- **No machine learning** (decision 0023). Isolation forest and LOF wait for a real site's history.
- **A flag is never an accusation** [DI-53]:
  - It shows its rule and its reasons with links to the audit entries.
  - It is readable only by holders of `ANALYTICS.DI_REVIEW` (QA data-integrity reviewers) through a definer function.
  - It sends no notification to the person or their line.
  - A disposition is required to close it; a confirmed problem is raised as a deviation in the GMP path.
- In the batch audit-trail review panel (DI-25), flagged entries are highlighted and listed first. No entry is hidden,
  and the review task is unchanged.
- **Screens:** `/analytics/audit-flags`: the list, the flag detail with its reasons and entries, the disposition.
- **Tests:**
  - `[DI-53] each seeded anomaly of the synthetic history raises its rule's flag with its reasons, and the clean
    persons raise none`;
  - `[DI-53] a person flag is unreadable without ANALYTICS.DI_REVIEW, also through the app role directly`;
  - `[DI-53] a flag sends no notification and closes only with a disposition`;
  - `[DI-25] the audit-trail review panel orders flagged entries first and still lists every entry`;
  - `[DI-53] the baseline gives no flag below 6 weeks of history`;
  - `[DI-51] the audit fact view exports no old or new value`.
- **Migrations:** kernel 1260 to 1269, site-services 1030 to 1039 (reserved), recipe-core 1150 to 1159, tablets 1350 to
  1354.

### Slice 6A-5: review priority (item 9)

- **Score** (method `REVIEW.PRIORITY` v1): a transparent weighted sum per completed batch record (weights in D-6A-13).
  - Exceptions by severity, values near a limit (from 6A-2), and post-entry corrections.
  - Open audit-trail flags on the batch (from 6A-4).
  - A new operator on the product, new or recently maintained equipment, unusual step durations (robust z), and
    linked deviations.
  - Each term is capped. The score comes with its top three reasons.
- **It orders the queue and never skips a review** [PR-61]:
  - `review.queue` lists exactly the records it lists today. The priority is a new optional field.
  - Unscored records come first; then come scored records by score, ties by completion time (D-6A-14).
  - Nothing in review, the exception register, the audit-trail review task or release reads the score (the 6A-1
    dependency scan).
  - The score never marks anything reviewed. It never changes what the reviewer must open, and never touches the
    DI-26 RBE rule set.
- **Outcomes kept for later:** the review outcome (findings, reopenings) is read from the review acts and stored with
  the score, for learned weights later (decision 0016 item 9). They are not learned in 6A.
- **Screens:** the review queue in the existing `review` feature shows the priority column with its reasons and the
  advisory band (an additive change).
- **Tests:**
  - `[PR-61] the review queue lists the same records with scores, without scores and with the runner down`;
  - `[PR-61] an unscored record is listed first`;
  - `[PR-61] a record with the lowest score still needs the full review and the audit-trail review before release`;
  - `[PR-61] no review, register or release function depends on the review priority`;
  - `[PR-52] every exception of a low-priority record is still dispositioned individually`;
  - `[DI-52] the score on the synthetic history ranks the seeded exception-rich batch first and shows its three
    reasons`.
- **Migrations:** recipe-core 1160 to 1169, tablets 1355 to 1359.

### Slice 6A-6: golden batch profile (item 10)

- **Inputs:**
  - `report.series_ref_v1`: the batch, step, equipment, tag and chunk ids, from `plant.series_in_context`;
  - `report.series_samples_v1(batch, step, tag)`: samples as decimal text with source time and status. BAD samples are
    dropped and counted.
  - It applies only to connected equipment. A step without a series has no profile.
- **Profile** (method `GBP.DTW_BAND` v1, D-6A-16), per equipment type, MBR step and tag:
  - The reference batches are released, with no deviation or alarm on that step. QA selects at least 10, under an
    `ANALYTICS_REFERENCE` change record.
  - Each curve is resampled to 200 points of normalised step time and aligned to the medoid by DTW, with a
    Sakoe-Chiba band of 10 %.
  - The band is the pointwise 5th to 95th percentile of the aligned references.
  - A new batch is flagged when more than 10 % of its points fall outside the band, or its DTW distance exceeds the
    references' 99th percentile.
- **Screens:** the 6b trend viewer gains an overlay of the band, the reference and the batch, labelled advisory, plus
  `/analytics/profiles`.
- **Tests:**
  - DTW and band against hand-worked examples;
  - `[DI-52] the seeded abnormal press curve is flagged and the 20 normal ones are not`;
  - `[DI-51] the profile reads the native series and never changes plant.series or the record's dynamic data refs`;
  - `a step without a series gives no profile`;
  - `[DI-32] the overlay shows the raw values as recorded`.
- **Migrations:** recipe-core 1170 to 1179, tablets 1360 to 1364.

### Slice 6A-7: Phase 6A exit

- **Trace:**
  - The four drafts map their catalog tests word for word to `clauses`, each with passing listed tests.
  - Their `target_phase` is 7 (D-6A-3), so `pnpm trace` at 6 does not gate them yet. The exit dry-runs `buildTrace` at
    phase 7 over the 6A tests for the four drafts only (as D-P6j-a-1).
  - Every tagged test is listed (`register:sync-tests`). `phase.yaml` stays at 6.
  - PR-60, DI-25, DI-26, DI-09, PR-52 and PR-58 gain the new tagged tests in their lists. No clause, behaviour or
    `expert_decision` changes.
- **Review:** one review pass over 6A, for serious defects only. Critical and high findings are fixed with tests, at
  most 2 fix rounds each; the rest are residuals for the owner in `review-backlog.md`.
- **Golden batches** GB-T-01 to GB-T-03 keep their exact outputs with the runner on (6A-1's test). There is no new
  golden batch; analytics is proven on the synthetic history and the reference fixtures (D-6A-17).
- **Browser flows:**
  - an SPC chart with the advisory band and its drill to the record;
  - QA's disposition of an audit-trail flag;
  - the review queue ordered by priority with its reasons, where opening the lowest-priority record still asks for the
    full review;
  - the golden profile overlay in the trend viewer.
- **Handbook:** `modules/analytics.md`, `03-architecture.md` (the analytics path beside the reporting path),
  `05-database.md` (role and schema), `10-runbooks.md` (approving a method version or a reference set),
  `08-defect-log.md`. Then `pnpm handbook` and `pnpm handbook:check`.
- **Final run:** per D-6A-15.
- **Migrations:** kernel 1280 to 1289, site-services 1050 to 1059, recipe-core 1190 to 1199, tablets 1380 to 1389 (exit
  fixes only).

## Draft controls (status U, `expert_decision` PENDING; for the owner and the expert)

Written as register entries in IN-53's style, with the requirement row n680 (FDA's AI guidance, unverified). They
entered `compliance/controls/` (and n680 `compliance/requirements/requirements.jsonl`) in the 6A-0 commit (D-6A-3). The regulations are paraphrased, and both AI texts are drafts (U).

| Id | Title | Class | Why it is new |
|---|---|---|---|
| DI-51 | Analytics outputs are advisory and never change a GMP record | core | PR-60 states the AI rule as a design choice without enforcement; 6A adds a module that writes outputs into the GMP database |
| DI-52 | Analytics methods: versioned, change-controlled, reproducible, with QA feedback and monitoring | core (change control, insert-only, audit) / other (monitoring view) | Annex 22 draft and FDA's AI guidance expect a defined intended use, a locked version, change control and monitoring; no control states this for analytics |
| DI-53 | Audit-trail anomaly flags: reasons shown, restricted, never an automatic finding | core (restricted read, disposition) / other (rules) | Item 8 reads people's activity; DI-25 and DI-26 cover review, not flags about a person |
| PR-61 | Review priority orders the QA review queue and never skips or narrows a review | core | Item 9 adds an ordering beside DI-26's RBE; the rule that the review stays complete must hold in the database |

## Interfaces fixed up front (in 6A-0; changed only through the lead)

[slice-6A-0-interfaces.md](slice-6A-0-interfaces.md):
- the contract namespace `analytics` (one file per slice) and the advisory response envelope;
- the shared SQL signatures: `analytics.begin_run`, `record_output`, `record_flag`, `finish_run`, `fail_run`,
  `record_disposition`, `person_flags`, the read views and the input catalogue;
- the output table shapes;
- the method ids and the package API;
- the fixtures (`analyticsHistory` and the contract examples).

Every contract change is additive: new namespaces, routes and optional fields, with nothing renamed or removed.

## Controls and their class (decision 0008 section 2)

| Slice | Core (database-enforced, full tests, control ids in names) | Other (application code allowed, with tests) |
|---|---|---|
| 6A-0 / 6A-1 | `ebmr_analytics` cannot write GMP data (segregation, bypass); analytics tables insert-only and audited; no GMP dependency on `analytics`; no floating column outside it; method and reference set only under an approved change record; disposition by the person, audited | runner schedule and polling, `statOf`, method registry, catalogue, monitoring view, screens |
| 6A-2 | (inherits 6A-1's) | charts, rules, capability, drift, rate intervals, funnel, PQR link |
| 6A-3 | reference set's model hash equal to its candidate | PCA, limits, contributions, screens |
| 6A-4 | person flags readable only with `ANALYTICS.DI_REVIEW`; a flag closes only with a disposition; the audit fact view exports no values | rules, baselines, highlight order in the DI-25 panel |
| 6A-5 | the queue's record set independent of scores; no review, register or release function depends on the score | weights, reasons, column |
| 6A-6 | (inherits 6A-1's; the series stays unchanged) | resampling, DTW, band, overlay |

## Migration ranges (each builder only in its own)

| Source (highest on main) | 6A-0 | 6A-1 | 6A-2 | 6A-3 | 6A-4 | 6A-5 | 6A-6 | 6A-7 |
|---|---|---|---|---|---|---|---|---|
| kernel (1230) | 1240-1244 | 1245-1259 | none | none | 1260-1269 | none | none | 1280-1289 |
| site-services (1002) | none | 1010-1019 (reserved) | 1020-1029 (reserved) | none | 1030-1039 (reserved) | none | none | 1050-1059 |
| recipe-core (1100) | 1110-1114 | 1115-1129 | 1130-1139 | 1140-1149 | 1150-1159 | 1160-1169 | 1170-1179 | 1190-1199 |
| tablets (1320) | 1330-1334 | 1335-1339 | 1340-1344 | 1345-1349 | 1350-1354 | 1355-1359 | 1360-1364 | 1380-1389 |

The gaps are kept free: kernel 1231-1239 and 1270-1279, site-services 1040-1049, recipe-core 1101-1109 and 1180-1189,
tablets 1321-1329 and 1365-1379. Phase 7 takes numbers above these ranges, or the gaps, when it is planned. Each file
carries its `-- Handbook:` line. Never edit a merged migration; replace a function in a new one.

## Decisions with defaults (owner rule: no questions asked; each default is the decision, the owner may change it)

- **D-6A-1** Default ids are `D-6A-n`, with a capital A. Phase 4's `D-6a-n` and Phase 6's `D-P6a-n` are different
  series.
- **D-6A-2** Slice order and overlap are as the order section says. Why: 6A-1 holds the role, tables and runner every
  method uses; 6A-3 reuses 6A-2's batch vectors, and 6A-5 reuses 6A-2's near-limit counts and 6A-4's flags.
- **D-6A-3** The four drafts enter the register in the 6A-0 commit, not in this planning commit, with `target_phase`
  7, status U and PENDING. The 6A exit proves their clauses by a dry run at 7.
  - Why the 6A-0 commit: adding a control file needs a migration in the same change, because the engine-name database
    test compares `recipe.engine_name` with the register.
  - Why phase 7: the schema's phases are whole numbers, `phase.yaml` stays at 6 through 6A, and target 6 would fail the
    trace before a test exists. Phase 7's trace then gates them with the rest of v1.0.
- **D-6A-4** A dedicated role `ebmr_analytics`, not `ebmr_report` (ADR 0020 point 3).
- **D-6A-5** In v1 the runner reads the primary in one REPEATABLE READ READ ONLY snapshot and records `data_as_of`.
  Pointing it at a replica is a connection setting. Writes go to the primary.
- **D-6A-6** The runner is part of the tablets server, on the GMP installation only. The sandbox and training mode run
  no analytics, and their analytics routes answer 404, as the dashboards do. It runs nightly at 02:00 site time and
  polls every 5 minutes for newly completed batches.
- **D-6A-7** SPC uses I-MR for one value per batch and Xbar-S for subgrouped IPC readings. Limits come from the
  approved reference set, or Phase I limits from the first 20 batches, labelled as such. The rules are Nelson 1, 2, 3
  and 5 only, to keep false alarms low.
- **D-6A-8** Capability: Cpk and Ppk with 95 % intervals (Bissell), from 25 batches, with an Anderson-Darling note. No
  transformation of non-normal data in v1.
- **D-6A-9** Drift: either a significant slope (p < 0.05) over the last 10 batches projected to cross a limit within 5,
  or EWMA (lambda 0.2, L 2.7).
- **D-6A-10** Shifts come from a platform setting under change control (`analytics.shift_boundaries`, default 06:00,
  14:00 and 22:00 site time, A, B and C). A deviation linked to a batch without a step counts as unattributed for step,
  equipment and room. Rates need at least 5 batches per group, with Benjamini-Hochberg at 10 %.
- **D-6A-11** Multivariate: per product and MBR family, with autoscaling and up to 5 components (90 % variance). T-squared
  and Q limits are at 99 %, with at least 15 reference batches chosen by QA under change control.
- **D-6A-12** Audit-trail rules and thresholds are as slice 6A-4. They are parameters of `ATA.RULES` v1, so a site
  changes them only with a new method version. The baseline needs 6 weeks of history and flags at |robust z| above 3.5.
  Flags about a person are restricted to `ANALYTICS.DI_REVIEW` and send no notifications.
- **D-6A-13** Review-priority weights v1:
  - each critical exception 5, major 3, minor 1;
  - a value within 10 % of the range from a limit 1 each, capped at 5;
  - a correction 1 each, capped at 5;
  - an open audit-trail flag 3 each;
  - a new operator on the product 2; new or recently maintained equipment 2;
  - a step duration with |z| above 3 1 each, capped at 3;
  - a linked deviation 4.
- **D-6A-14** Unscored records head the review queue. Why: no information means attention, not delay.
- **D-6A-15** **The heavy final run is combined with the Phase 7 exit run on the pod** (owner's order of 17 October:
  6A, then Phase 7 here, then the heavy testing on the pod).
  - The 6A exit closes on:
    - one review pass;
    - the four drafts' clauses proven (the dry run at 7);
    - targeted tests run here for each slice;
    - green GitHub CI on every slice PR and on the exit PR. GitHub CI already runs the static checks, the full suite in
      six shards, the golden batches, the browser suite and `pnpm trace` at 6.
  - The pod's single final run then proves 6A and Phase 7 together: the full suite, golden batches, browser suite, trace
    and `handbook:check`, all green in one run.
  - Why: Phase 7 starts at once and changes code 6A touches (decision 0022: the batch-scope authority of R16 and the
    signed gateway feed of R9). One pod run instead of two saves a full run without losing a gate, because GitHub CI
    runs the same gates on each PR.
  - Fallback: if GitHub CI cannot complete the 6A exit PR (runner time or a flaky environment), the 6A final run is
    done on the pod at the 6A exit.
- **D-6A-16** Golden profile: 200 resampled points, a DTW Sakoe-Chiba band of 10 % and a 5th to 95th percentile band.
  A batch is flagged when more than 10 % of its points fall outside the band, or its distance is above the references'
  99th percentile. At least 10 reference batches.
- **D-6A-17** No new golden batch. Analytics is proven on the synthetic history (a seeded generator with known shifts
  and anomalies) and on reference values computed offline, stored with their script. GB-T-01 to GB-T-03 prove that
  nothing is written back.
- **D-6A-18** The PQR stays as built (PR-58, IN-01). Its screen links to the analytics charts as an advisory annex, and
  the signed extract does not include them.
- **D-6A-19** Analytics records are kept as long as the batch records they concern. They are a non-GMP record class
  in the records register, and no purge applies before the batch record's retention ends.
- **D-6A-20** Learned review weights (decision 0016 item 9, "later") and the machine-learning stage of item 8 are not in
  6A. Review outcomes are stored now, so later learning has data.
- **D-6A-21** The package is edition-neutral. The Injectables inputs (EM trends, interventions, inspection rejects)
  are wired with Phase 5.
- **D-6A-22** Re-running a method reproduces it when the flags are identical and the values agree within a relative
  1e-9. The output hash covers canonical text at 12 significant digits.
- **D-6A-23** Libraries: `ml-matrix` and the `@stdlib` distribution packages, pinned exactly in 6A-1 at versions at
  least two weeks old. The candidate is `ml-matrix` 6.15.0 (MIT, 5 August 2026).

## Owner questions

None asked (owner rule: take the defaults). For the owner's attention:
1. **The four draft controls** (status U, PENDING; Annex 22 and FDA's AI guidance are drafts) need the expert's
   decision with the rest of the pack. Until then they are built and tested as written.
2. **D-6A-15:** the heavy run is combined with the Phase 7 exit run on the pod.
3. **D-6A-12:** flags about a person stay within QA data-integrity review. A site's works council or data-protection
   duties (for example India's DPDP Act 2023, not verified, U) may require more at deployment.

## Order, agents and close

- 6A-0 comes first (the lead), then 6A-1 (one builder; its screens may be a second builder on fixtures).
- After 6A-1 merges, 6A-2, 6A-4 and 6A-6 run in parallel in their own worktrees (they share no files outside the lead's
  shared files). 6A-3 follows 6A-2, and 6A-5 follows 6A-2 and 6A-4. 6A-7 comes last.
- Up to five agents at a time (decision 0017), model by task as CLAUDE.md says. Each builder has its own spare cluster
  (local-ci skill) and runs the changed folders locally; GitHub CI is the merge gate.
- Per slice: the slice is done when it has tests, green CI, the module guide and `08-defect-log.md` updated, `pnpm
  handbook` regenerated and `pnpm handbook:check` green. One quick review, then one PR, then PROGRESS.md and
  `docs/build-plan/phase-6a/review-backlog.md` at each merge.
