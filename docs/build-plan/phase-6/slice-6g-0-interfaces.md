# Slice 6g-0: reporting path, dashboards, change impact and training mode (fixed 16 October 2026)

The interface commit of slice 6g (plan: [phase-6-plan.md](phase-6-plan.md), "Slice 6g", "Left ready for the analytics
work"). Everything below is fixed for the slice; changes are additive (new views as new versions, new routes, new
optional fields). Branch `phase-6/slice-6g`.

Code: kernel `1210_reporting_role.sql` (role, schema, connect policy, segregation check) and `1211_training_attempts.sql`;
recipe-core `1070_reporting_views.sql` and `1071_change_impact.sql`; contract namespaces `dashboards`, `changeImpact`
(GMP) and `training` (SANDBOX), fixtures `dashboards.json`, `change-impact.json`, `training.json`.

## 1. The reporting path (core: the reporting role cannot write)

| Object | Behaviour |
|---|---|
| role `ebmr_report` | LOGIN, NOINHERIT, member of nothing, no elevated attribute (development password `ebmr_report`; production a vault credential). CONNECT on GMP databases only (`sandbox.apply_connect_policy`); USAGE on schema `report` only; SELECT on the `report` views only; EXECUTE only on the non-volatile `report` row functions |
| schema `report` | Owned by `ebmr_owner`. Each view `report.<name>_v<N>` selects from its row function `report.<name>_rows_v<N>()` (SQL, STABLE, SECURITY DEFINER, owner `ebmr_owner`): a view's functions run with the reader's EXECUTE right, so the reader is given the row function and nothing else |
| columns on every row | `read_at timestamptz` (statement time of the read) and `data_as_of timestamptz` (on a primary the read's transaction time; on a streaming replica the last replayed commit). Data age = `read_at - data_as_of` |
| `report.catalog_v1` | One row per view: `view_name`, `version`, `grain`, `description`, `columns` (jsonb array of name and type, from the catalogue) |
| `sandbox.segregation_problems()` | Also reports, in a GMP database: `ebmr_report` missing, elevated, a member of a role, holding any privilege but the ones above, a default privilege granting to it, a volatile function it may execute; in a sandbox: `ebmr_report` able to connect |
| `ebmr_app` | SELECT on the `report` views and EXECUTE on their row functions (the dashboards read the same views; the sandbox role mirrors it inside a sandbox) |

Views (recipe-core 1070; one row per grain):

| View | Grain | Columns (besides `read_at`, `data_as_of`) |
|---|---|---|
| `report.batch_outcome_v1` | GMP batch | `batch_id`, `batch_number`, `product_code`, `strength`, `record_kind`, `status`, `issued_at`, `completed_at`, `qa_reviewed_at`, `review_cycles`, `exception_count`, `deviation_count`, `right_first_time` |
| `report.exception_v1` | register exception | `batch_id`, `batch_number`, `exception_id`, `exception_type`, `category`, `severity`, `raised_at` |
| `report.deviation_ageing_v1` | deviation | `deviation_id`, `ref`, `kind`, `classification`, `state`, `raised_at`, `closed_at`, `age_days` |
| `report.hold_time_risk_v1` | closed bulk container | `container_id`, `label_code`, `batch_id`, `batch_number`, `product_code`, `strength`, `disposition`, `closed_at`, `max_hold_hours`, `held_hours` (decimal text, two places) |
| `report.overdue_review_v1` | APPROVED MBR version past its review date | `version_id`, `family_code`, `version_number`, `document_id`, `review_due`, `days_overdue`, `last_review_at`, `in_use` |
| `report.press_counter_v1` | press and GMP batch | `equipment_id`, `equipment_code`, `batch_id`, `batch_number`, `first_event_at`, `last_event_at`, `running_seconds`, `observed_seconds`, `tablets`, `rejects` (decimal text; counter deltas of `tablet.count` and `reject.count`) |
| `report.alarm_v1` | plant alarm | `alarm_id`, `source`, `alarm_code`, `gmp_critical`, `subject_kind`, `subject_code`, `raised_at` (source time), `received_at`, `acked_at`, `batch_count`, `batch_numbers` |

## 2. Change impact (recipe-core 1071)

`recipe.change_impact(kind text, ref text) returns setof (impact text, id uuid, label text, detail text, via text)`;
STABLE, SECURITY DEFINER, EXECUTE to `ebmr_app`; writes nothing. `kind`: `MATERIAL` (material code), `SPECIFICATION`
(specification id), `EQUIPMENT` (equipment code), `MBR_VERSION` (version id), `SITE_VALUE` (rule-table site value key),
`SUPPLIER` (manufacturer code). An unknown kind EBMR-CIM-001; an unknown subject EBMR-CIM-002. `impact` is one of
`MBR_VERSION`, `OPEN_BATCH`, `RELEASED_LOT`, `MARKET`, `CONFIG_HISTORY`. Derivation (D-P6g-0-8):

- MBR versions: MATERIAL and SPECIFICATION (its material) - versions not RETIRED or WITHDRAWN whose pinned formula has
  the material; SUPPLIER - the same for every material the manufacturer is approved for (not withdrawn); EQUIPMENT - the
  versions of the GMP batches that used the equipment; MBR_VERSION - itself; SITE_VALUE - APPROVED versions with a
  CURRENT or BRIDGING authorisation cell in a market of the value's market set.
- Open batches: GMP batches (not ABORTED or CANCELLED, not QA_REVIEWED) of those versions; for MATERIAL, SPECIFICATION
  and SUPPLIER also those that consumed a lot of the material (of the manufacturer); for EQUIPMENT those that used it.
- Released lots: finished lots in RELEASED forward (recipe.genealogy_forward_set) of the affected batches and lots.
- Markets: the markets of the released lots and of the versions' CURRENT or BRIDGING cells.
- Configuration history: for SITE_VALUE the `platform.config_version` rows of area SITE_VALUE for that key (6f).

## 3. Training mode (core: training cannot reach GMP)

- Training is the sandbox installation (DI-05, kernel 0800) with the training seed (D-P6g-2): the same server and
  screens, the sandbox login role, the TEST, NOT GMP band and watermark of the shell, the reserved TEST- identifiers.
- Personas: the sandbox persona catalogue of the test kit (TEST- legal names), shown with their roles.
- Exercises: scripted, versioned definitions in the server (`features/training/exercises.ts`): code, version, title,
  persona keys, steps (instruction and the screen path).
- `sandbox.training_attempt` and `sandbox.training_step` (kernel 1211): an attempt and the steps marked done, by the
  person of the session. `sandbox.start_training(exercise text, version integer, steps integer) returns uuid` and
  `sandbox.complete_training_step(attempt uuid, step integer)`: refused in a GMP database (EBMR-SBX-039) by a guard on
  both tables, whoever writes; a step outside the attempt or by another person EBMR-SBX-040; twice is accepted once.

## 4. Contract

`dashboards` (GMP, SESSION, read-only): `rightFirstTime`, `exceptionPareto`, `reviewCycleTime`, `deviationAgeing`,
`holdTimeRisk`, `overdueReviews`, `pressOee`, `alarmTrend` (GET `/api/dashboards/<name>?from&to`, site-zone dates,
default the last 90 days), `catalog` (GET `/api/dashboards/catalog`), `export` (GET `/api/dashboards/export?view`).
Every dashboard response: `dataAsOf`, `readAt`, `dataAgeSeconds`, `period`, `notForGmpDecisions: true`, its rows with a
`drill` path to the record screen. Ratios and quantities are decimal text.

`changeImpact` (GMP, SESSION, read-only): `query` (GET `/api/change-impact?kind&ref`): the rows grouped by impact,
`counts`, `generatedAt` and `contentHash` (SHA-256 of the canonical JSON of the rows) for the change record.

`training` (SANDBOX, SESSION): `overview` (GET `/api/training`: watermark text, personas, exercises, the person's
attempts), `start` (POST `/api/training/attempts`), `completeStep` (POST `/api/training/attempts/:attemptId/steps`).

## 5. Test titles (fixed)

- `[PR-05] an overdue review appears on the dashboard`
- `[DI-49] the alarm trend counts every alarm of the period`
- `[DI-05] a training session cannot write to the GMP database`
- `[DI-05] the training attempts are refused in a GMP database, whoever writes`
- `[DI-05] training routes answer 404 on the GMP installation and the dashboards 404 on the sandbox`
- `[DI-05] the training screen carries the TEST, NOT GMP watermark`
- `the reporting role cannot write: no insert, update, delete, command or other schema, and the segregation check
  reports any extra grant`
- `dashboards show their data age and refresh it`
- `change impact matches an independent query for each kind`

## 6. Defaults

- **D-P6g-1**, **D-P6g-2**: as the plan.
- **D-P6g-0-1** Live views, not snapshots: no refresh job to fail; on a replica the data age is the replay lag.
  Why: the plan asks for data age on every row and allows a replica; a materialised copy would add a second store.
- **D-P6g-0-2** Views are versioned by name (`_v1`); a change of columns or meaning is a new version; old versions stay
  until the analytics module has moved. Why: the analytics module of decisions 0015 and 0016 binds to a version.
- **D-P6g-0-3** The dashboards read the report views through the application role, aggregate in the server's SQL and
  are shown to any signed-in person (as the genealogy explorer). Why: they show nothing the review screens do not.
- **D-P6g-0-4** Right first time: QA reviewed in its first review cycle (no REOPENED act), no register exception, no
  deviation linked. Review cycle time: first EXECUTION_COMPLETE to the latest QA_REVIEWED act.
- **D-P6g-0-5** Deviation ageing buckets 0-30, 31-60, 61-90 and over 90 days for open deviations (not CLOSED or
  CANCELLED). Hold-time risk: closed containers left (not issued, merged, charged or rejected) with a bright-stock
  maximum hold; at risk from 80 % of the maximum, over it past 100 %.
- **D-P6g-0-6** Press OEE shows availability (RUNNING time over the observed time of the batch's state events) times
  quality (good over counted) only; performance needs a rated speed that master data does not hold (residual).
- **D-P6g-0-7** Alarm trend: every alarm raised (source time) in the period counted once, by site-zone day and code,
  whatever number of batches it is bound to.
- **D-P6g-0-8** Change impact as section 2; a rule-table site value is taken as used by every version authorised in
  its markets (MBR content does not name rule keys).
- **D-P6g-0-10** Migration ranges (lead, 16 October): kernel 1210-1214, recipe-core 1070-1079, tablets 1310-1319 (unused);
  checked against the open slices 6c, 6e and 6i. Why: they run in parallel.
- **D-P6g-0-9** Training exercises live in server code, attempts in the sandbox only; no training state in a GMP
  database (the tables exist there, empty and guarded).
