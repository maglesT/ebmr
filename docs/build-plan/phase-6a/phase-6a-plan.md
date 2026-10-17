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
- **D-6A-1-23** A retirement through the route keeps what the version in force recorded: its parameters, their hash,
  its intended use and its code identity. A version validated with an earlier build can then still be retired after
  an upgrade (found in the slice's own review).

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

#### 6A-2 as built (17 October)

- **Methods** (`packages/analytics/src/methods/spc`, `capability`, `drift`, `rates`): SPC.IMR, SPC.XBAR_S, CAP.INDEX,
  DRIFT.TREND, RATE.DEVIATION version 1. Known answers in `packages/analytics/test/spc-methods.test.ts`: limits checked by
  hand, the published examples (Newcombe's Wilson intervals, the tea-tasting Fisher table, Benjamini and Hochberg's
  fifteen p-values, the c4, d2 and D4 table values) and `test/reference/spc-reference.json`, written by
  `spc_reference.py` (Python 3.13, NumPy 2.2.6, SciPy 1.14.1).
- **Runner:** `apps/tablets-server/src/analytics/spc.ts` (the assembly from the views and `SPC_METHOD_DEFINITIONS`, the
  version 1 rows QA puts in force under a change record), one line in `IMPLEMENTATIONS`.
- **Migration:** recipe-core 1130 (`report.deviation_fact_v1`, `report.step_shift_v1`, `report.shift_of`, the setting
  `site.shift_boundaries` and its check). Tablets 1340-1344 and site-services 1020-1029 are not used.
- **Server and screens:** feature `analytics-spc` (`features/analytics/spc/`, joined to `routes.ts` and
  `NAMESPACE_OWNERS` as `P6A`); screens `tablets-web/src/features/analytics/spc/` (`/analytics/spc` with the
  capability panel, `/analytics/rates` with the funnel); the PQR extract screen's advisory annex links.
- **Tests:** the five plan titles (`[DI-52]` Nelson rule 2 at batch 24 and the seeded room on the synthetic history,
  run end to end through the runner in `apps/tablets-server/test/analytics/spc.test.ts`; `[DI-52]` capability below 25
  batches; `[DI-51]` the SPC response's decimal text and StatNumber; `[DI-51]` the PQR extract unchanged in
  `packages/recipe-core/test/analytics/rate-inputs.test.ts`), the rate inputs over GMP records, and the screens.
- **Mutation group:** `analytics-rate-inputs` (90 %), job in `mutation.yml`.
- **Golden batches:** not run; the change does not touch the batch outputs (the golden runner uses its probe method,
  and the new trigger acts only on the `site.shift_boundaries` setting).

Defaults of 6A-2 (taken without asking, as the owner's rule says; each is the decision until the owner changes it):

- **D-6A-2-1** Reference-set limits: the SPC methods take a reference model `{subjectRef, chart, centre, sigma}` and
  then say REFERENCE_SET (tested). In v1 no run passes one, so every chart is PHASE_I and labelled: the analytics role
  cannot read the effective reference sets (no EXECUTE on `analytics.effective_reference_sets`, a kernel grant), and the
  interfaces table gives SPC no MODEL_CANDIDATE output to approve a set from. Both are lead changes (6A-3 meets the same
  need); written up here for the lead.
- **D-6A-2-2** The charted value of a batch is its last attempt of the item (highest attempt, then latest recorded):
  earlier failed attempts are 6A-4's repeat-until-pass. Only completed GMP batches, in completion order.
- **D-6A-2-3** One chart per product, MBR family and item (subject PRODUCT_ITEM `<product>|<family>|<item>`); the
  specification echoed is the newest batch's master's.
- **D-6A-2-4** Xbar-S: a point of n readings has sigma / sqrt(n); the drawn limits are for the most frequent subgroup
  size; a batch with fewer readings than `minSubgroup` is left out and named. The rules run on every point, Phase I
  included; one flag per rule and chart, one reason per hit naming its batches, severity ATTENTION.
- **D-6A-2-5** Drift: the EWMA starts at the master's target (else the mean of every batch) with sigma from the mean
  moving range of every batch; both signals concern the newest batch (a current drift, not a past one); the slope
  projection uses the fitted line.
- **D-6A-2-6** Rates are per product (the route takes the product): one output per group, subject GROUP
  `<product>|<grouping>:<group>`, so a flag names its own output. The history's expected `ROOM:R-2` is that ref with the
  product in front.
- **D-6A-2-7** The shifts are the platform setting `site.shift_boundaries` (not `analytics.shift_boundaries`): the shift
  pattern is a site fact, and a routine outside the analytics schema naming `analytics.` would break the DI-51
  dependency proof. Format `NAME=HH:MM,...`, rising; anything else is refused by a trigger for every writer
  (EBMR-ANA-020). It is under change control as every platform setting (area PLATFORM_SETTING).
- **D-6A-2-8** Attribution: a deviation counts for the step of an exception it was linked (DEVIATION_LINKED) or escalated
  (ESCALATED) to, with that step's units, rooms and consumed lots; its shift is the exception's time, else the
  deviation's. Cancelled deviations are left out. A batch's shifts are those its steps started in
  (`report.step_shift_v1`, added to the method's inputs in the registry).
- **D-6A-2-9** The comparison: one-sided Fisher of the group against the product's batches not exposed to it, counting
  only deviations attributed within the grouping (unattributed ones are counted apart); Benjamini-Hochberg within a
  product and grouping; funnel limits by the normal approximation at the product's share. `report.alarm_v1` as a group
  input is not wired in v1 (DI-49's trend stays as built).
- **D-6A-2-10** The normal distribution function is `@stdlib/math-base-special-erfc` 0.2.5, pinned and in
  `RUNTIME_LIBRARIES` (the normal quantile loses precision below 1e-16; defect log P6A2-1).
- **D-6A-2-11** 6A-2's messages are EBMR-ANA-020 to -029, so the parallel slices do not collide.
- **D-6A-2-12** A comparison covers every completed batch of the product in the run; `from` and `to` pick the newest
  comparison whose batches all completed within them, else 404 (EBMR-ANA-021).
- **D-6A-2-13** An output's batch ids and recorded values travel as comma-joined text (output values are numbers, number
  arrays or text); the route joins the batch numbers and completion times from `report.batch_fact_v1`.
- **D-6A-2-14** No migration writes a method version: QA puts the version 1 definitions in force under a change record
  (the server test does it through the route).
- **D-6A-2-15** Additive optional contract fields: `spreadChart` on the chart, `overall.unattributedDeviations` and
  `groups[].funnel` on the rates.

Residuals for the lead (not 6A-2's files): every run raises its flags again, and `analytics.open_flag_v1` lists each
run's flags, so a nightly run repeats an open rule hit until it is dispositioned; D-6A-2-1's two changes.

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

#### 6A-3 as built (17 October)

- **Method** (`packages/analytics/src/methods/mspc`): MSPC.PCA version 1. Known answers in
  `packages/analytics/test/mspc.test.ts` against `test/reference/mspc-reference.json`, written by `mspc_reference.py`
  (Python 3.13, NumPy 2.2.6, SciPy 1.14.1): autoscaling, eigenvalues, components, signed loadings, scores, T-squared and
  Q with both contributions, the beta and F T-squared limits, the Jackson-Mudholkar and Box Q limits, the candidate's
  trimming and refit. The synthetic history's batch 27 is caught by Q with hardness and thickness named, while each of
  its values is within the master's limits and inside its own I-MR limits.
- **Runner:** `apps/tablets-server/src/analytics/mspc.ts` (the assembly, `MSPC_METHOD_DEFINITION`), one line in
  `IMPLEMENTATIONS`. The SPC implementations (`spc.ts`) read reference sets the same way.
- **Migrations:** kernel 1270 (a reference set carries its candidate's model and batches, EBMR-ANA-030) and 1271 (an
  open flag raised again is listed once). Recipe-core 1140-1149 and tablets 1345-1349 are not used.
- **Server and screens:** feature `analytics-mspc` (`features/analytics/mspc/`, joined to `routes.ts` and
  `NAMESPACE_OWNERS` as `P6A`); screens `tablets-web/src/features/analytics/mspc/` (`/analytics/mspc` with the T-squared
  and Q charts, the scores plot, the batches and the candidates; `/analytics/mspc/batches/:batchId` with the
  contribution bars, drilling to the batch record). The SPC screen offers a chart's Phase I limits as its reference set;
  the flags list says how often a hit was raised.
- **Tests:** the plan titles (`[DI-52]` batch 27, in the package and end to end in
  `apps/tablets-server/test/analytics/mspc.test.ts`; `[DI-52]` the hash refusal; `[DI-09]` the change record; the 15
  batches), the lead items (kernel `test/analytics/repeats-and-candidates.test.ts`; the SPC reference set and the
  repeated flag end to end), and the screens.
- **Mutation group:** `analytics-mspc-reference` (90 %; 100 % locally), job in `mutation.yml`.
- **Golden batches:** not run; the change does not touch the batch outputs.
- **Base:** the branch merges `phase-6a/slice-6` (head 6822120) to reuse its reference-set mechanism, as the lead asked.

Defaults of 6A-3 (taken without asking, as the owner's rule says; each is the decision until the owner changes it):

- **D-6A-3-1** The batch vector. Its variables are the critical items of the scope's newest completed batch. A
  variable is one value per batch (the last attempt, D-6A-2-2), or the mean of a subgroup item's readings; a one-value
  item wins over a subgroup item of the same name. A batch missing a variable is left out of the candidate, or not
  scored, with the reason. A variable without variation among the reference batches is left out of the model, named.
  A model needs two variables and more batches than variables plus one.
- **D-6A-3-2** "The batches QA proposes": released, no CRITICAL deviation linked (`report.deviation_fact_v1`), every
  variable recorded, the newest 100 (`maxReferenceBatches`). QA proposes by making a candidate the reference set, or
  not. There is no batch-picking screen in v1; another choice is a new method version's parameters. The minimum of 15
  applies before and after trimming.
- **D-6A-3-3** Trimming: the first fit's Phase I limits (T-squared by beta, Q by Jackson-Mudholkar, 99 %) leave out the
  batches beyond them, each named with its values, and the model is fitted once more on the rest. Why: an unusual batch
  inside the reference widens the limits it is judged by (batch 27 raises the history's Q limit from 0.28 to 1.14), and
  as a reference batch it would not be flagged at all (D-6A-3-4).
- **D-6A-3-4** Scoring. For each reference set in force, a run scores the reference batches (against the beta limit) and
  the newest 50 other batches (`scoredBatches`, against the F limit), so a run's outputs stay bounded. It flags
  T2_ABOVE and Q_ABOVE, severity ATTENTION, only on batches outside the set (QA approved the set). A score's subject is
  BATCH; a candidate's is PRODUCT_ITEM `<product>|<family>`.
- **D-6A-3-5** The arithmetic. Components: the fewest reaching 90 %, at most 5 and at most p - 1, so a residual and Q
  remain. A loading vector is signed so its largest element is positive. Q's limit falls back to Box's g chi-square when
  Jackson-Mudholkar's h0 is not positive. Contributions: to T-squared, z_j times the sum of t_a p_ja / lambda_a (they sum
  to T-squared and can be negative); to Q, the squared residual. A flag names the largest positive contributors until
  they cover 80 %, at most three.
- **D-6A-3-6** A model records its fit parameters. A set is scored only by a version with the same ones (as D-6A-6-6),
  else skipped with the reason; a malformed model fails the run.
- **D-6A-3-7 Reference sets in runs (lead item a, from D-6A-2-1).** The lead's direction: 6A-6's mechanism, not an
  EXECUTE grant on `analytics.effective_reference_sets`. The view `report.analytics_reference_v1` fits as it is (a
  method filter, the scope and the model), so it is not extended.
  - SPC.IMR and SPC.XBAR_S give each chart with complete Phase I limits a MODEL_CANDIDATE: the model `{subjectRef,
    chart, centre, sigma, batchIds, phaseOneBatches}` and its SHA-256. QA makes it the chart's reference set (scope
    `{product, family, item, chart}`) under a change record. The registry adds MODEL_CANDIDATE and the view to both.
  - The run without a set leaves a chart a set covers to that set's run (skipped with the reason). A run with a set
    reads only its product, family and item, and charts REFERENCE_SET limits. A set whose scope or batches are not its
    model's fails its run with the reason. MSPC.PCA runs the same way, narrowed to the set's product and family.
  - The SPC chart route adds `referenceSet` and `candidate`; the SPC screen offers the candidate to QA.
- **D-6A-3-8** Kernel 1270, EBMR-ANA-030: a reference set carries its candidate's own model and batches, not only its
  hash, for every writer. It adds to the core control; 6A-6's candidates record both, so they pass it.
- **D-6A-3-9 Repeated flags (lead item b, from 6A-2's residual).** The views group the raises; the runner keeps
  recording every flag. A flag's signal is its method, version, subject, rule, severity and reasons, evidence included.
  - `analytics.open_flag_v1` (replaced in kernel 1271) lists each open signal once: its latest raise, with
    `raised_count` and `first_raised_at` added at the end.
  - A disposition on any raise closes the signal, including the same hit raised again later. A hit that differs in
    anything is its own signal and is listed on its own.
  - `analytics.flag_v1` and the audit trail keep every raise. The monitor counts each raise with its signal's latest
    current disposition.
  - Why the view, not the runner: a run's record and output hash stay a pure function of its inputs (D-6A-22), the
    analytics role cannot read flags, and nothing is dropped. The restricted flags of 6A-4 are grouped by its own
    `analytics.audit_flags`; `analytics.person_flags` is unchanged.
  - Kernel 1270-1279, a free gap, is assigned to 6A-3 for the lead items.
- **D-6A-3-10** Contract additions, all optional, made before any consumer. In `ns/analytics-mspc.ts`: the reference
  T-squared limit and the Q method; each batch's limit and completion; the candidate's batches, variables, variance
  and limits; a batch's scope and set. A subgroup variable's value is null, with its readings. In the shared files:
  `FlagView.raisedCount` and `firstRaisedAt`, and `SpcChartView.referenceSet` and `candidate`.
- **D-6A-3-11** 6A-3's messages are EBMR-ANA-030 to -039: 030 the kernel 1270 refusal, 031 no chart, 032 no batch score.

Residuals for the lead: the restricted flags read through `analytics.person_flags` still list each run's raise, outside
6A-4's methods; two SPC reference sets in force for one chart both chart it, and the newest is shown.

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

#### 6A-4 as built (17 October)

- **Migrations:** kernel 1260 (`report.auth_fact_v1`), 1261 (flag keys, `analytics.audit_flags`); recipe-core 1150
  (`report.audit_fact_v1`, `report.manual_digit_v1`), 1151 (`analytics.audit_flag_entries`,
  `analytics.audit_flagged_entries`). Tablets 1350-1354 and site-services 1030-1039 are not used.
- **Package:** `packages/analytics/src/methods/audit/` (`ATA.RULES` v1, `ATA.BASELINE` v1); the registry gains three
  parameters (D-6A-4-3, -4, -6) and the input `report.manual_digit_v1`.
- **Runner:** `apps/tablets-server/src/analytics/audit.ts`, listed in `IMPLEMENTATIONS`.
- **Server and screens:** `features/analytics/audit/` binds `analyticsAudit` (joined to `routes.ts` and
  `NAMESPACE_OWNERS` as `P6A`), with the additive route `analyticsAudit.entries` and the optional `repeats`/`repeat`
  fields; screens `tablets-web/src/features/analytics-audit/`; the review feature's `AuditTrailPanel` orders flagged
  entries first for the DI lead.
- **Tests:** package `test/audit.test.ts` (each seeded anomaly of `analyticsHistory` and the clean persons, the rules the
  history does not seed, the baseline below and above 6 weeks); recipe-core `test/analytics/audit-inputs.test.ts`
  (no values, the facts, the roles); server `test/analytics/audit.test.ts` (runner end to end, DI_REVIEW, no
  notification, keys and dispositions, the entries route); web `test/analytics-audit/audit.test.tsx` (the panel, the
  screens). The 6g catalogue test now requires every view the reporting or application role can read to be catalogued
  (D-6A-4-2). Mutation group `analytics-audit` (90 %).

Defaults of 6A-4 (taken without asking, as the owner's rule says; each is the decision until the owner changes it):

- **D-6A-4-1** The audit facts are in recipe-core (a batch record's entries, their item, step, attempt, failure and
  claimed time, live in the execution store; D-6A-0-1); the authentication facts are in the kernel. Both cover the last
  26 weeks. Added columns: `chain_key`, `recorded_local` (site wall clock), `command_type`, `attempt`, `failed`,
  `deviation_linked`, `config_area`; `event_ref` and `at_local` for logins. A correction is an UPDATE or DELETE, or the
  commands CORRECT_ENTRY, VOID_ATTEMPT and INVALIDATE_RESULT. Events of the nil person (release, system) are left out;
  for an update the field is the list of changed column names.
- **D-6A-4-2** The three fact views describe persons: they are on the analytics role's allow-list only, not in the
  report catalogue, and neither the application role, the reporting role nor the dashboards' export reads them.
- **D-6A-4-3** BACK_DATED compares an entry's claimed time with the step's previous entry in recording order, with a
  tolerance `backDatedMinutes` of 2 (device clocks and keying order differ by less). A late entry is reported once, by
  LATE_ENTRY.
- **D-6A-4-4** CORRECTIONS_HIGH counts completed site weeks only (the latest week of the input is in progress). The
  percentile is the linear one (type 7) over the active person-weeks, and needs `correctionsMinPersonWeeks` (20) of them.
- **D-6A-4-5** One flag per hit. A flag's key is its method, rule, subject and the first evidence of its first reason;
  the lists show the latest flag per key, and a disposition on any flag of a key closes it, for later repeats too. The
  flag table grows by one row per hit and run; to be measured at a real site.
- **D-6A-4-6** The baseline assesses completed weeks from the person's first week in the input; a week without activity
  counts zero. When the MAD is zero the scale is 1.2533 times the mean absolute deviation; when that is zero the week is
  not assessable for that metric. Late entries use `lateEntryMinutes` (15), added to the baseline's parameters.
- **D-6A-4-7** The restricted readers are definers that refuse administrators and need `ANALYTICS.DI_REVIEW`
  (EBMR-ANA-007): `analytics.audit_flags` in the kernel, the entry readers in recipe-core (they read the audit facts).
  Lists keep 500 keys, with the open-only and key filters applied before the limit.
- **D-6A-4-8** The terminal-digit test reads only the last digit of each value keyed by hand (DECIMAL or COUNT, source
  MANUAL) from `report.manual_digit_v1`; the value itself is not exported. Chi-square on 9 degrees of freedom at
  `digitTestAlpha` (0.01), with the quantile from @stdlib.
- **D-6A-4-9** In the review panel only a data-integrity reviewer sees the highlight (the flags are restricted). Every
  entry is still listed, and the review's scope, mark, hash and signature are unchanged. A dispositioned key's entries
  are still highlighted, with their verdict.
- **D-6A-4-10** Severity is INFO for a single-entry hit (late, back-dated, off-hours configuration) and ATTENTION for a
  pattern, never HIGH. Evidence is `AUDIT_EVENT <chain>#<id>`, `AUTH_EVENT`, `WEEK`, `DIGIT_TEST` or `BASELINE_WEEK`,
  with at most 20 entries named per flag.
- **D-6A-4-11** No migration writes the version 1 rows, because a version names the code identity (the build's
  commit). QA makes them effective with the defaults under a change record (`analyticsConfig.setMethodVersion`), and the
  tests write them as the release.

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

#### 6A-5 as built (17 October)

- **Merge:** `phase-6a/slice-2` (6A-2) merged into the branch first (every registry conflict kept both sides; generated
  pages regenerated).
- **Migration:** recipe-core 1160 (`report.review_fact_v1` and its helpers `report.review_ended_at`,
  `report.review_fact_batches`, `report.review_novelty`; in the report catalogue and on the analytics role's allow-list).
  Tablets 1355-1359 are not used; no kernel migration (none needed, see D-6A-5-4).
- **Package:** `packages/analytics/src/methods/review/` (`REVIEW.PRIORITY` v1); the registry entry reads the five
  inputs it uses and gains the parameter `durationMinBatches` (D-6A-5-5).
- **Runner:** `apps/tablets-server/src/analytics/review.ts` (the assembly and `REVIEW_METHOD_DEFINITIONS`), one line in
  `IMPLEMENTATIONS`.
- **Server and screens:** feature `analytics-review` (`features/analytics/review/`, binds `analyticsReview`, joined to
  `routes.ts` and `NAMESPACE_OWNERS` as `P6A`); the review feature's `review.queue` gains the optional `priority` per
  record and the optional `ordering` (D-6A-5-8), read from `analytics.review_priority_v1` by SQL; screens
  `tablets-web/src/features/analytics-review/` (the queue's note and band, used by `ReviewQueuePage`, and
  `/analytics/review-priority/$batchId`).
- **Tests:** package `test/review-priority.test.ts` (known answers); recipe-core `test/analytics/review-inputs.test.ts`
  (the facts over GMP records, the allow-list, `[PR-61] no review, register or release function depends on the review
  priority`); server `test/analytics/review-priority.test.ts` (`[DI-52]` the synthetic history through the runner's
  assembly and the queue's order) and `test/analytics/review.test.ts` (the queue with scores, without, with the runner
  stopped and the view unreadable; an unscored record first; the lowest score still needs the full review; `[PR-52]`
  each exception dispositioned on its own); web `test/analytics-review/review.test.tsx`. Test-kit
  `analyticsReviewFacts` derives the history's review facts without drawing from its PRNG.
- **Mutation group:** `analytics-review-inputs` (90 %), job in `mutation.yml`.

Defaults of 6A-5 (taken without asking, as the owner's rule says; each is the decision until the owner changes it):

- **D-6A-5-1** Severities: the register's CRITICAL, ACTION and ALERT are the plan's critical, major and minor exceptions.
  Corrections are the accepted CORRECT_ENTRY, VOID_ATTEMPT and INVALIDATE_RESULT commands (as D-6A-4-1); deviations are
  the linked ones not cancelled (as 1130); findings are the exceptions QA queried or escalated, reopenings the REOPENED
  acts.
- **D-6A-5-2** The facts cover the records in the review queue (EXECUTION_COMPLETE or ABORTED) that await QA review, and
  those QA reviewed in the last 30 days, so the outcome is stored with a last score (D-6A-20). One output per scored
  record per run; the output table grows with the runs (to be measured at a real site).
- **D-6A-5-3** A person is new on the record of their first step on the product (performers, data enterers and
  correctors of `report.step_use_v1`, any GMP record). A unit is new on the record of its first GMP use, or recently
  maintained when it was QUALIFIED, had MAINTENANCE_ENDED or was REPAIRED, or a CMMS work order COMPLETED, in the 7 days
  before its use. Both terms count once (2 points) however many; the view names units, never persons.
- **D-6A-5-4** "Open audit-trail flags on the batch": no report view may read the analytics schema (the DI-51 dependency
  proof) and the analytics role reads only catalogued report views (as D-6A-2-1), so REVIEW.PRIORITY runs the ATA.RULES
  version 1 rules (their default thresholds) over the same snapshot's `report.audit_fact_v1` and counts the hits whose
  evidence names an entry of the record. A disposition does not lower the term in v1. The reason gives the count only:
  no person, rule or entry (DI-53). For the lead: a catalogued input of the open flag keys per batch would need a kernel
  change. Only a holder of `ANALYTICS.DI_REVIEW` sees the term and its reason; anyone else sees, and is ordered by, the
  score without it (the slice's own review, P6A5-1).
- **D-6A-5-5** Near a limit: the last attempt of each item (every reading of a series), compared exactly on the decimal
  text; a value without both limits is not assessed and is named in the run's skipped list. A step's duration runs from
  its first start to its last end over its units, compared as a robust z (ATA.BASELINE's scaling) with the same product,
  MBR family and step of every GMP record in the input, from `durationMinBatches` (5) records on; fewer, or no variation,
  is named as not assessed.
- **D-6A-5-6** "Each term is capped" is read as the D-6A-13 caps (near limit 5, corrections 5, durations 3) and the
  yes-or-no terms counted once; exceptions, audit-trail hits and deviations are not capped in v1, because each is a
  reason for attention a cap would hide. The top three reasons are the larger points first, then the term order.
- **D-6A-5-7** The queue's order, for a holder of `ANALYTICS.VIEW` (checked by the database): the records awaiting QA
  review first, the unscored ones first (by completion time, then batch number), then the scored ones by score, ties
  by completion time (the longer waiting first) and batch number; then the QA-reviewed records by batch number. Without
  the permission, or when the priority cannot be read (logged), the queue is exactly as before (batch-number order).
  The set of records is the queue's own query either way.
- **D-6A-5-8** The lead had not yet added `priority` to `review.queue` items; this slice adds it (optional and
  nullable: null is "not scored yet", absent is "not shown") with the optional `ordering` of the response. Additive.
- **D-6A-5-9** 6A-5's messages are EBMR-ANA-040 to -049 (040: the one-record route's batch is no GMP record). An
  unscored record answers 200 with `priority: null`.
- **D-6A-5-10** No migration writes the version 1 row (as D-6A-4-11): QA puts `REVIEW_METHOD_DEFINITIONS` in force
  under a change record; the tests write it as the release.
- **D-6A-5-11** Golden batches not run: the slice adds an input view and orders the queue; the golden runner uses its
  probe method and the record outputs do not change (as 6A-2).

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

#### 6A-6 as built (17 October)

- **Migrations.** Recipe-core 1170 holds `report.series_ref_v1`, `report.series_samples_v1(uuid,text,text)` and
  `report.analytics_reference_v1`, with their row functions and the step windows. Tablets 1360-1364 are not used. There is
  no kernel or site-services migration (D-6A-6-7).
- **Package.** `packages/analytics/src/methods/profile/`: `curves.ts` (resampling, DTW, alignment, medoid, percentiles,
  band) and `gbp.ts` (GBP.DTW_BAND v1). The registry entry gained three parameters (D-6A-6-3, D-6A-6-5). `OutputDraft`
  values may now be objects and text lists (D-6A-6-10).
- **Runner.**
  - `profile.ts` is the implementation, listed in `IMPLEMENTATIONS`.
  - `inputs.ts` reads row function inputs (`InputSpec.call`).
  - `runner.ts` runs a method with `references` once per reference set in force (D-6A-6-8).
  - The implementation shapes moved to `method-types.ts` to avoid an import cycle (re-exported).
- **Server and screens.**
  - The feature is `features/analytics/profile/` (`analytics-profile`; `analyticsProfile` joins `routes.ts` and
    `NAMESPACE_OWNERS`).
  - The screens are `/analytics/profiles` (`features/analytics/profile/`) and the overlay under the 6b trend viewer's
    chart.
- **Tests.**
  - Package `test/profile.test.ts`, with the offline reference `test/reference/profile-dtw.json` and its script.
  - Recipe-core `test/analytics/series-inputs.test.ts`.
  - Server `test/analytics/profile.test.ts`.
  - Web `test/analytics/profile.test.tsx`.
- **Mutation group.** `analytics-profile-inputs` (90 %), with its job in `mutation.yml`.
- **Messages.** EBMR-ANA-060 and -061 (the range 060 to 069 is 6A-6's).

Quick review (one pass, serious defects only): one high fixed with tests, the unbounded reads and outputs of D-6A-6-12.
There was no critical finding.

Defaults of 6A-6 (taken without asking, as the owner's rule says; each is the decision until the owner changes it):

- **D-6A-6-1 Scope.** A profile is per product code, family, equipment type, step and tag.
  - The equipment type is the unit's class, as `report.step_use_v1` names it.
  - The MBR step is the step key bound to the unit (`plant.step_equipment`).
  - A candidate's subject is `product|family|type|step|tag` (EQUIPMENT_STEP_TAG). A profile's subject is the batch
    (BATCH), with the step and tag in its values.
  - A step that ran on two units of the type gives two curves; that batch is not a reference batch.
- **D-6A-6-2 Reference batches.** A batch may be a reference batch when it is released, has no deviation linked to it
  and has no alarm bound to it on the step or on no step.
  - Deviations carry no step, so any linked deviation counts against every step of the batch.
  - The runner fits one candidate per scope on every such batch, and needs at least 10. It lists the batches it leaves
    out, with why.
  - QA selects by approving a candidate as a whole under an ANALYTICS_REFERENCE change record. A candidate on a
    narrower selection would need a new route; that is left for later, as an additive change.
  - Before scoring, the runner checks that the set's batches and scope are the model's.
  - Why: a model's hash must equal its candidate's (EBMR-ANA-010), so the batches QA approves are the candidate's. The
    percentile band and the log-normal limit stay robust to one abnormal reference curve, and the test shows it.
- **D-6A-6-3 Band tolerance.** The band at point j spans the lowest 5th and highest 95th percentile within j ± 1 point
  (parameter `bandTolerancePoints`, default 1, one resampling step).
  - Why: taken literally, a pointwise 5 % to 95 % band leaves about 10 % of every reference curve's points outside it,
    which is exactly the flag threshold. On the synthetic history, half the normal curves would have been flagged.
  - With one point of tolerance, the normal curves have at most 5.5 % of their points outside and the abnormal curve
    31 %.
  - The 5 %, 95 % and 10 % of D-6A-16 are unchanged.
- **D-6A-6-4 Distance limit.** The references' 99th percentile of DTW distance to the medoid is estimated as a
  log-normal prediction limit for one new batch: exp(m + t(0.99, n - 1) s sqrt(1 + 1/n)), over the positive distances.
  With fewer than three positive distances, the limit is the largest distance.
  - Why: the empirical 99th percentile of 10 to 50 distances lies below the largest one, so a reference would be
    flagged against its own set.
- **D-6A-6-5 Samples.**
  - BAD samples, and samples without a shown value, are dropped and counted. UNCERTAIN samples (a stale or last-usable
    value) are used and counted. A repeated source time keeps its first sample.
  - A curve is not assessed, with the reason, when its step's window has not ended, when it has fewer than `minSamples`
    (20) usable samples, or when a gap between usable samples is longer than `maxGapShare` (5 %) of its time.
  - Normalised step time runs from the first to the last usable sample. Resampling is linear.
  - Only steps whose window has ended are read (`ended = true`).
- **D-6A-6-6 Fit parameters.** A reference set is scored only by a method version with the same fit parameters (points,
  band, percentiles, tolerance, distance percentile). Otherwise its curves are skipped with the reason. A malformed
  model, or one that does not hash to its recorded SHA-256, fails the run.
- **D-6A-6-7 No kernel range.** The runner reads the reference sets in force through a recipe-core report view over
  the configuration store (`platform.config_version`, area ANALYTICS_REFERENCE).
  - It is catalogued like every report view, so the reporting and application roles may read it too. The models are
    advisory configuration, not GMP data.
  - Why: `analytics.effective_reference_sets()` is owner only (kernel 1242), and a grant would need a kernel migration.
    The view does not depend on the analytics schema, so the DI-51 dependency proof is unchanged.
  - The lead may later replace it with a kernel grant; 6A-3 can reuse it with a method filter.
- **D-6A-6-8 Runs and results.**
  - A method with reference sets runs once without one (the model candidates) and then once per reference set in force.
  - The scoring run gives one PROFILE_DISTANCE per curve: PROFILED, or NOT_ASSESSED with the reason. Its flags are
    ATTENTION.
  - The samples function is also EXECUTE to the application role, so that the overlay shows the samples the profile
    read.
  - The trend viewer's overlay appears on request, behind a button, under the native chart.
- **D-6A-6-9 Row function inputs.** A FUNCTION input is called once per distinct argument list taken from the rows of a
  view input, in the same snapshot. Its rows carry the arguments, and the input record covers all of its rows. A sample
  belongs to the unit whose chunk holds it.
- **D-6A-6-10 Output values.** `OutputDraft.values` also takes text lists and plain objects (a candidate's model). This
  is an additive widening of the package type.
- **D-6A-6-11 Contract.** `ns/analytics-profile.ts` (6A-6's own file) gained, before any consumer:
  - the samples as recorded and the status with its reason;
  - the counts and the reference batches;
  - the candidate's scope, batches and medoid.
  The routes answer EBMR-ANA-060 for a step without a series and EBMR-ANA-061 when no profile exists yet.
- **D-6A-6-12 Bounded reads.** Each run reads the latest 50 ended curves of each scope (`report.series_ref_v1`
  column `recency`; the runner's new `InputSpec.atMost` bound, recorded in the run's input filter as `recency<=`).
  - The candidate is fitted on the reference batches among them. A scoring run scores them, and an older batch keeps
    the profile it was given.
  - Why (found in the slice's own review): every completed batch triggers a run, and a run that reads and scores every
    curve of the site's history would grow without bound, both in its reads of the GMP primary and in its outputs.

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

#### 6A-7 as built: trace, browser flows and handbook (17 October, branch `phase-6a/slice-7`)

The review pass and its fixes are on `phase-6a/slice-7-review`, merged into this branch at the exit; the final run follows D-6A-15.

- **Local checks (17 October).** The full Vitest suite on one spare cluster: 6,882 passed, 0 failed, 44 skipped. The
  golden batches GB-T-01 to GB-T-03 on a golden clock cluster with the runner on: 44 of 44 passed. The four browser
  flows through the E2E configuration: 4 of 4 passed. `pnpm trace` at phase 6: ok, 151 of 246 controls with passing
  tests. The dry run at phase 7 (D-6A-7-b-3): every one of the drafts' 23 clauses has a passing listed test, no error.
  Typecheck, lint, `deps:check`, `pins:check`, `register:validate`, the `[meta]` tests and `handbook:check` pass.

- **Trace.** DI-51, DI-52, DI-53 and PR-61 map their catalog tests word for word to `clauses` (6, 8, 5 and 4 clauses),
  each naming passing listed tests; `target_phase` stays 7 and `phase.yaml` stays at 6. `register:sync-tests` added the
  four browser flows to the drafts, DI-25 and DI-26, and the retitled no-value test to DI-53. PR-60, DI-09, PR-52 and
  PR-58 already listed every 6A test tagged with them (nothing to add; PR-58 has none in the 6A files).
- **Browser flows** `tools/e2e/specs/phase6a/analytics.spec.ts` (support `support.ts`): the SPC chart with the advisory
  band and its drill to the record; the data-integrity reviewer's disposition of an audit-trail flag, then the batch's
  audit-trail review with the flagged entry first; the review queue by priority with its reasons, the lowest record
  still asking for its full review; the golden profile overlay in the trend viewer.
- **Handbook.** `modules/analytics.md` complete (pharma context, tables, state machines, testing, pitfalls);
  `03-architecture.md` the analytics path beside the reporting path; `05-database.md` the role and the schema;
  `10-runbooks.md` method versions and reference sets under change control; `08-defect-log.md` the 6A entries grouped.
- **No migration.**

Defaults of 6A-7 (trace, browser and handbook half; taken without asking, as the owner's rule says):

- **D-6A-7-b-1** The analytics browser flows run on their own copy of the E2E GMP database, made with the kernel's backup
  path (continuity dump and restore, as the DI-32 trend spec does), with their own GMP server. Their fixtures (records
  copied from the review batch, the synthetic history's batch facts, a press series of the review batch) never reach the
  database the other specs share. Why: the E2E stack has no completed GMP batch with critical values or an equipment
  series, and fixture records in the shared database would change what other specs see.
- **D-6A-7-b-2** The runs the flows show are recorded as the runner records one: as `ebmr_analytics`, through
  `analytics.begin_run`, `record_output`, `record_flag` and `finish_run`. Their method versions are put in force by a
  QA person under the approved E2E change record (`analytics.set_method_version`), and the golden profile's reference
  set is approved by QA from its candidate (`analytics.set_reference_set`). Why: the runner runs on a batch completion
  (a five-minute poll) or nightly, and has no on-demand route. The versions carry a code identity that is not the
  running build's, so the copy's own runner would record a FAILED run rather than outputs. The fixture's numbers come
  from textbook formulas in the support file (I-MR limits, Nelson rules 1 and 2; a resampled percentile band and a DTW
  distance) over the synthetic history, so the screens show self-consistent values; the methods are proven by the
  package and server tests.
- **D-6A-7-b-3** The dry run of the trace at phase 7 for the four drafts is a scratch helper calling `buildTrace` at
  phase 7 with the four controls only, over the full Vitest report, the golden report and the browser flows' report;
  `phase.yaml` is not touched (as D-P6j-a-1).
- **D-6A-7-b-4** A clause is one action with its expected result: the catalog test is cut after each result's semicolon.
- **D-6A-7-b-5** DI-53's clause "the audit facts carry no old or new value" is proven by the recipe-core test that checks
  it; its title gains the `[DI-53]` tag (`[DI-51][DI-53] the audit fact view exports no old or new value`; body
  unchanged), and that file's results in the local report come from a re-run of the file.
- **D-6A-7-b-6** PROGRESS.md is brought back under its 150 lines: the Phase 4, Phase 6 and Phase 6A slice notes move
  verbatim to `docs/progress/history.md` ("PROGRESS.md condensed at the Phase 6A exit").
- **D-6A-7-b-7** The defect log's 6A entries are grouped under one heading in slice order, and P6A2-1 takes the entry
  shape of the others; no entry's content changes.

#### 6A-7 review (17 October; one pass over e0bc24e..ddf3dfe, serious defects only, decision 0008)

Scope: the 6A migrations (kernel 1240-1271, recipe-core 1110-1170, tablets 1330), `packages/analytics`, the runner and
the analytics features, checked against a fully migrated GMP database (catalogue queries over every privilege of
`ebmr_analytics`, `ebmr_app` and `ebmr_report` in the `analytics` and `report` schemas) as well as by reading. Branch
`phase-6a/slice-7-review`; the residuals are in [review-backlog.md](review-backlog.md).

Checked and found sound:
- **DI-51.** `ebmr_analytics` holds USAGE on `report` and `analytics`, SELECT on its 12 catalogued views and the
  catalogue, EXECUTE on the six runner functions and the report row functions those views read, and no INSERT, UPDATE,
  DELETE, TRUNCATE, REFERENCES or TRIGGER anywhere. Every volatile function it can run is a runner writer, and those
  write only the analytics tables (and, through their triggers, the audit trail on analytics chains, which no batch's
  review scope or evidence epoch reads). The runner reads in a REPEATABLE READ READ ONLY snapshot and calls only the
  record functions. The segregation check is clean, and no GMP object depends on the analytics schema.
- **DI-53.** The audit, authentication and digit facts are on the analytics role's allow-list only. Neither the report
  catalogue, `ebmr_report` nor `ebmr_app` reads them. Every person flag and its dispositions and entries are read
  through definers that need ANALYTICS.DI_REVIEW. The unrestricted views leave PERSON and ACCOUNT subjects out.
- **PR-61.** The queue's record set is its own query, `priorityOrder` returns every record once, and nothing in review,
  the register, the audit-trail review or release reads the score.
- **Definers.** Every app-callable 6A definer refuses administrators before `iam.require_permission`. Method versions
  and reference sets are written only through the change-controlled configuration areas, and never change (DI-09).
- **Numbers.** `statOf` is the only conversion of a decimal to a number (one `Number()`, in `from-decimal.ts`). The
  chart and profile responses give the recorded values as decimal text beside the statistics.

Findings:
- **P6A7-1 (high, fixed; DI-52, DI-53): two flag-grouping designs, and a group's verdict could be replaced without
  superseding it.** 6A-4 grouped the audit-trail flags by key (kernel 1261) and 6A-3 grouped the other flags by
  signal (kernel 1271). Both closed the group with a disposition on any raise, but `analytics.record_disposition` kept
  its rules per flag.
  - Reproduced: a later raise of a dispositioned hit took a fresh first disposition. That gave the group a second
    current verdict, with no supersede and no reason.
  - The period list (`analytics.flag_v1`), the generic flag detail and `analytics.person_flag_dispositions` showed a
    later raise as undispositioned. `/analytics/flags?kind=PERSON` listed it as open.
  - The monitor grouped the audit-trail flags by signal, so a key's verdict did not count for the key's drifting
    raises.
  - Fixed in **kernel 1280**, one design (D-6A-7-R1). `analytics.flag_group` is 6A-4's key for ATA.* and 6A-3's signal
    otherwise. The group is the unit of the verdict in the writer and in every reader. 6A-4's behaviour stays: a key's
    disposition closes its later raises, and the restricted flags stay restricted.
  - The server reads a flag's dispositions by group: `analytics.flag_group_disposition_v1`, and the restricted
    dispositions under the flag asked about.
  - Tests: kernel `test/analytics/exit-review.test.ts`, the three `[DI-52]`/`[DI-53]` grouping tests. Server
    `test/analytics/audit.test.ts`, "[DI-52][DI-53] a later raise of a dispositioned key ...". They failed before the
    fix. One fix round.
- **P6A7-2 (high, fixed; DI-53): the review priority's audit-trail term was restricted in the server only.** The slice's
  own fix (P6A5-1) filtered the OPEN_AUDIT_FLAG term in `features/common/review-priority.ts`. The application role
  still read the full score, the term's count and points and its reason from `analytics.review_priority_v1` and
  `analytics.output_v1` (reproduced, with no person in context).
  - Fixed in **kernel 1281** (D-6A-7-R2): both views leave the term out unless `analytics.viewer_holds_di_review()`
    says the command's person holds ANALYTICS.DI_REVIEW. That function refuses administrators first and fails closed.
  - Test: kernel "[DI-53] the audit-trail term of a review priority is unreadable without ANALYTICS.DI_REVIEW, also
    through the app role directly". One fix round.
- **P6A7-3 (high, fixed; DI-51, DI-52): runs grew with the site's history.** Every completed batch reran every method
  in force.
  - Each SPC.IMR and SPC.XBAR_S run recorded every chart with all its batches, and rule flags naming hits over the
    whole history.
  - RATE.DEVIATION recorded one output per group ever, every material lot included.
  - The audit-trail methods re-raised every hit of 26 weeks on each completed batch.
  - The output, flag and audit tables are insert-only, so the database would grow by runs times history. 6A-6's
    review found the same for the profile (D-6A-6-12).
  - Fixed in the package and the runner (D-6A-7-R3):
    - `chartBatches` (100): a chart shows and flags its newest batches, with the Phase I limits of the first ones.
    - `windowBatches` (200): a rate comparison covers the product's newest batches.
    - The audit-trail methods run nightly and on demand, not on a completed batch (`onBatchComplete: false`).
  - No migration: there is no GMP rule to guard in the database.
  - Tests: package `spc-methods.test.ts` (the chart window, the rate window) and server `runner.test.ts` ("[DI-52] a
    completed batch runs the methods it can change ..."). One fix round.
  - Left: the reads themselves (P6A7-4).
- **P6A5-2 (lead item, fixed; DI-52): a QA false alarm did not lower the review priority.** Fixed in **kernel 1282**
  (D-6A-7-R4, D-6A-7-R5): `analytics.audit_key_verdict_v1` gives the current verdict per audit-trail key.
  - It lives in the analytics schema, so the DI-51 dependency proof is unchanged. It is SELECT to the analytics role
    only, catalogued in its input registry and not in the report catalogue.
  - REVIEW.PRIORITY reads it and leaves out a hit whose key QA dispositioned FALSE_ALARM. TRUE_SIGNAL and
    NOT_ASSESSABLE still count.
  - Tests: package `review-priority.test.ts` and server `review-priority.test.ts` (the verdicts), kernel "[DI-51][DI-53]
    the analytics role reads the current verdict of each audit-trail key ...", and the key spelling against
    `analytics.flag_key` for every flag the runner raised (server `audit.test.ts`).

Residuals (medium and low; [review-backlog.md](review-backlog.md)): P6A7-4 full input reads per run; P6A7-5 the flag
table's growth and whole-table grouping; P6A7-6 the top reasons hint at a hidden term; P6A7-7 the monitor's counts of
person flags; P6A7-8 the runner does not check its login; P6A7-9 the key leaves out the method version.

Mutation: new group `analytics-exit` (kernel 1280, 1281) at 100 % locally, with one equivalent mutant recorded. The
groups holding the replaced `record_disposition` and `person_flag_dispositions` (`analytics-foundation`,
`analytics-method-change`) also run the new test file; their local re-run did not finish within the session's 30-minute
limit and is left to the mutation workflow.

Defaults of the 6A-7 review (taken without asking, as the owner's rule says; each is the decision until the owner
changes it):

- **D-6A-7-R1 One grouping design.** A flag's group is 6A-4's key for the audit-trail methods (method, rule, subject,
  first evidence; no version) and 6A-3's signal for every other method (method, version, subject, rule, severity,
  reasons). The audit-trail reasons drift as the window moves, while another method's differing reasons are another hit.
  - The verdict is the group's. A first disposition is taken only when the group has none. A later one, on any raise,
    supersedes the group's current one, with a reason.
  - Concurrent verdicts on one group are serialised by a transaction lock.
  - Where earlier data hold two current verdicts, the latest is the group's, as both designs read it.
- **D-6A-7-R2 The audit-trail term in the database.** Without ANALYTICS.DI_REVIEW the views give the score less the
  term's points (not below 0) and leave out the term's values and reason. No validated person, an administrator or a
  read-only transaction reads as "not held". The server's filter stays and finds nothing to take out.
- **D-6A-7-R3 Bounded runs.**
  - SPC charts: `chartBatches` 100. The moving ranges and subgroups are those of the window, and an output names the
    series length (`seriesBatches`) when the window leaves batches out.
  - Rate comparisons: `windowBatches` 200, newest by completion time.
  - Version 1 of these methods is not yet in force anywhere (QA puts it in force), so the version 1 parameters gain
    these defaults rather than a version 2.
  - The audit-trail methods are not run on a completed batch.
- **D-6A-7-R4 Which verdicts lower the review priority.** Only FALSE_ALARM. A true signal is still worth the reviewer's
  attention (its deviation counts on its own), and a hit that could not be assessed is not cleared.
- **D-6A-7-R5 An analytics-schema input.** The input registry's name check admits `analytics.<name>_v<n>` beside the
  report names, and the runner's view-name check likewise. The key is spelled with operators in the view, so the role
  needs no function grant, and a test keeps it equal to `analytics.flag_key`.

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
