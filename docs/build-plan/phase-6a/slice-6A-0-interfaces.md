# Slice 6A-0: analytics interfaces (fixed 17 October 2026)

These are the interface notes of Phase 6A. The plan is [phase-6a-plan.md](phase-6a-plan.md), the architecture
[ADR 0020](../../adr/0020-analytics-module-read-only-advisory.md). The lead's 6A-0 commit turns them into code before
any builder starts. After that every change is additive: a new view version, a new route, a new optional field or a
new method version. Nothing is renamed or removed. Messages are `EBMR-ANA-001` and up.

## 1. The package `@ebmr/analytics` (pure; imports nothing in the repository)

| Module | Fixed API |
|---|---|
| `numeric/from-decimal.ts` | `type DecimalText = string & {__decimal}`; `statOf(text: DecimalText): number` checks `^-?\d+(\.\d+)?$` and throws `AnalyticsInputError` otherwise. It is the only conversion from a GMP value to a `number` |
| `numeric/canonical.ts` | `canonicalText(value: unknown): string` writes sorted keys, with numbers at 12 significant digits and `null` for a non-finite number; `outputHash(outputs, flags): string` is the SHA-256 of that text in hex. It is implemented without node core, using the package's own SHA-256 |
| `method.ts` | `MethodId`, `MethodVersion {id, version, parameters, parametersSha256}`. `Method<I, P>` has `id`, `versions` and `run(input: I, params: P, ref: ReferenceModel or null): MethodResult`. `MethodResult` is `{outputs: OutputDraft[], flags: FlagDraft[], skipped: {subject, reason}[]}` |
| `registry.ts` | `METHODS`: one entry per method id (section 4) with its input kind, its parameter schema and `changesGmpData: false` (PR-60) |
| `types.ts` | `OutputDraft {subjectKind, subjectRef, kind, values: Record<string, number or number[] or string>, reasons: Reason[]}`; `FlagDraft {subjectKind, subjectRef, rule, severity: 'INFO' or 'ATTENTION' or 'HIGH', reasons: Reason[] (at least one)}`; `Reason {code, text, weight?, evidence?: {kind, ref}[]}` |
| `methods/<family>/` | One folder per slice: `spc`, `capability`, `drift`, `rates` (6A-2); `mspc` (6A-3); `audit` (6A-4); `review` (6A-5); `profile` (6A-6) |

Each method is a pure function of its inputs, its parameters and its reference model. Methods read no clock, use no
randomness, and do no I/O.

## 2. Database: schema `analytics` and role `ebmr_analytics` (kernel 1240 to 1244)

**Role `ebmr_analytics`.**
- It is LOGIN and NOINHERIT, a member of nothing, and has no elevated attribute. The development password is
  `ebmr_analytics`; production uses a vault credential.
- It may CONNECT to GMP databases only (`sandbox.apply_connect_policy`). It has USAGE on `report` and `analytics`.
- It may SELECT the views named in `analytics.input_catalog_v1`.
- It may EXECUTE `report.series_samples_v1`, `analytics.begin_run`, `record_output`, `record_flag`, `finish_run`,
  `fail_run` and `effective_methods`, and nothing else.
- `sandbox.segregation_problems()` reports any other grant. In a sandbox, it reports the role being able to connect.

**Tables.** All are owned by `ebmr_owner`, refuse UPDATE and DELETE (`EBMR-AUDIT-004`) and are registered in
`kernel.audited_table`.

| Table | Columns |
|---|---|
| `analytics.method_version` (config area `ANALYTICS_METHOD`) | `method text`, `version integer`, `status text` (EFFECTIVE, RETIRED), `title text`, `intended_use text`, `acceptance jsonb`, `parameters jsonb`, `parameters_sha256 text`, `code_identity text` (package version and commit), `validation_ref text`, `valid_from timestamptz`; unique (`method`, `version`, `valid_from`) |
| `analytics.reference_set` (config area `ANALYTICS_REFERENCE`) | `id uuid`, `method text`, `scope jsonb` (product, family, and for profiles the equipment type, step and tag), `batch_ids uuid[]`, `candidate_output uuid`, `model jsonb`, `model_sha256 text` (must equal the candidate's: `EBMR-ANA-010`), `status text` (EFFECTIVE, RETIRED), `valid_from timestamptz` |
| `analytics.run` | `id uuid`, `method text`, `version integer`, `reference_set uuid null`, `trigger text` (SCHEDULED, BATCH_COMPLETE, ON_DEMAND), `inputs jsonb` (a list of view, version, filter, `data_as_of`, rows and `sha256`), `runtime jsonb` (package, commit, node, libraries), `started_at timestamptz` (database clock) |
| `analytics.run_end` | `run uuid` (unique), `status text` (DONE, FAILED), `output_sha256 text null`, `counts jsonb`, `error text null`, `ended_at timestamptz` |
| `analytics.output` | `id uuid`, `run uuid`, `subject_kind text` (BATCH, PRODUCT_ITEM, GROUP, EQUIPMENT_STEP_TAG, PERSON, ACCOUNT, METHOD), `subject_ref text`, `kind text` (section 4), `values jsonb`, `reasons jsonb`, `recorded_at` |
| `analytics.flag` | `id uuid`, `run uuid`, `output uuid null`, `subject_kind`, `subject_ref`, `rule text`, `severity text`, `reasons jsonb` (a non-empty array: `EBMR-ANA-004`), `restricted boolean` (true when `subject_kind` is PERSON or ACCOUNT), `raised_at` |
| `analytics.flag_disposition` | `id uuid`, `flag uuid`, `verdict text` (TRUE_SIGNAL, FALSE_ALARM, NOT_ASSESSABLE), `cause text` (at least 10 characters), `deviation_ref text null`, `supersedes uuid null`, `reason text null` (required with `supersedes`), `person_id uuid`, `account_id uuid`, `recorded_at` |

**Functions.** All are SECURITY DEFINER with `search_path = pg_catalog, pg_temp`.

| Signature | Behaviour |
|---|---|
| `analytics.effective_methods() returns setof analytics.method_version` | The versions EFFECTIVE at statement time (`platform.config_as_of`) |
| `analytics.begin_run(p_method text, p_version integer, p_reference_set uuid, p_trigger text, p_inputs jsonb, p_runtime jsonb) returns uuid` | Refused unless the version and the reference set are EFFECTIVE now (`EBMR-ANA-001`, `-002`) or the inputs miss a field (`-003`). EXECUTE to `ebmr_analytics` |
| `analytics.record_output(p_run uuid, p_subject_kind text, p_subject_ref text, p_kind text, p_values jsonb, p_reasons jsonb) returns uuid` | Refused for a run that has ended (`-005`). EXECUTE to `ebmr_analytics` |
| `analytics.record_flag(p_run uuid, p_output uuid, p_subject_kind text, p_subject_ref text, p_rule text, p_severity text, p_reasons jsonb) returns uuid` | Refused with empty reasons (`-004`) or for an ended run (`-005`). EXECUTE to `ebmr_analytics` |
| `analytics.finish_run(p_run uuid, p_output_sha256 text, p_counts jsonb) returns void`, `analytics.fail_run(p_run uuid, p_error text) returns void` | Once per run (`-006`). The views ignore the outputs of a FAILED or unended run. EXECUTE to `ebmr_analytics` |
| `analytics.record_disposition(p_flag uuid, p_verdict text, p_cause text, p_deviation_ref text, p_supersedes uuid, p_reason text) returns uuid` | Runs within `kernel.begin_command` (ADR 0016). Needs `ANALYTICS.DISPOSITION`, and `ANALYTICS.DI_REVIEW` for a restricted flag (`-007`). Refuses superseding without a reason or across flags (`-008`). EXECUTE to `ebmr_app` |
| `analytics.person_flags(p_from timestamptz, p_to timestamptz) returns setof analytics.flag` | Restricted flags, only when the command's person holds `ANALYTICS.DI_REVIEW` (`-007`). EXECUTE to `ebmr_app` |

**Read views** (SELECT to `ebmr_app`; the screens read only these):
- `analytics.output_v1`: outputs of DONE runs, with method, version, `data_as_of` and `advisory = true`.
- `analytics.open_flag_v1`: unrestricted flags without a current disposition.
- `analytics.review_priority_v1`: per batch, the latest REVIEW_PRIORITY output with its score, reasons, method version
  and `scored_at` (6A-5 fills it).
- `analytics.method_monitor_v1`: per method version and month, the runs, failures, flags, the dispositioned share and
  the false-alarm rate.
- `analytics.input_catalog_v1`: the view name, version, owner slice and grain of every input the role may read.

**Permissions** (kernel catalogue):
- `ANALYTICS.VIEW` (READ): QA, production head, QP.
- `ANALYTICS.DISPOSITION` (WRITE): QA.
- `ANALYTICS.DI_REVIEW` (READ): QA data-integrity reviewers.
- `ANALYTICS.METHOD` (WRITE, under a change record): QA and the system owner.
- The Tablets role grants are made in tablets 1330.

**Proofs fixed for 6A-1:**
- no foreign key from outside `analytics` into it;
- no `pg_depend` edge and no function body outside `analytics` and the read views that names `analytics.`;
- no column of type `real` or `double precision` outside `analytics`.

## 3. Input views (in the `report` schema; versioned by name; each row carries `read_at` and `data_as_of`)

| View or function | Slice (migration) | Grain and columns (values as decimal text) |
|---|---|---|
| `report.batch_fact_v1` | 6A-1 (recipe-core 1115+) | GMP batch: `batch_id`, `batch_number`, `product_code`, `strength`, `mbr_version_id`, `family_code`, `status`, `issued_at`, `completed_at`, `released` |
| `report.cpp_value_v1` | 6A-1 | critical value: `batch_id`, `kind` (PARAMETER, CALCULATION), `item`, `step`, `attempt`, `role` (PROCESS_PARAMETER, IPC, PROCESS_ENDPOINT), `value_text`, `unit`, `lower_text`, `upper_text`, `target_text`, `failed`, `recorded_at` (from `recipe.pqr_cpp_of` and the master's limits) |
| `report.step_use_v1` | 6A-1 | step execution: `batch_id`, `step`, `equipment_code`, `equipment_type`, `room_code`, `started_at`, `ended_at`, `person_ids`, `material_lots` (lot code and supplier code pairs) |
| `report.deviation_fact_v1` | 6A-2 (recipe-core 1130+) | deviation link: `deviation_id`, `classification`, `raised_at`, `batch_id`, `step` (null when it is linked to the batch only), `equipment_code`, `room_code`, `material_lot`, `supplier_code`, `shift` (from `analytics.shift_boundaries`) |
| `report.audit_fact_v1` | 6A-4 (kernel 1260+) | audit event: `event_id`, `recorded_at`, `claimed_at`, `person_id`, `account_id`, `role`, `terminal`, `action`, `table_name`, `field`, `is_correction`, `reason_code`, `batch_id`, `step`. No old or new values |
| `report.auth_fact_v1` | 6A-4 | authentication event: `account_id`, `person_id`, `terminal`, `kind` (LOGIN, FAILED, LOCKOUT), `at` |
| `report.review_fact_v1` | 6A-5 (recipe-core 1160+) | completed record: `batch_id`, `exceptions_critical`, `exceptions_major`, `exceptions_minor`, `corrections`, `deviations`, `new_operator`, `new_equipment`, `review_outcome` (findings, reopened) |
| `report.series_ref_v1` | 6A-6 (recipe-core 1170+) | `batch_id`, `step`, `equipment_code`, `equipment_type`, `tag`, `unit`, `chunk_ids` |
| `report.series_samples_v1(p_batch uuid, p_step text, p_tag text)` | 6A-6 | `source_time`, `raw_text`, `status` (GOOD, UNCERTAIN, BAD); STABLE, SECURITY DEFINER, EXECUTE to `ebmr_analytics` |

## 4. Methods v1 (each a `method_version` row; the parameters as the plan's defaults)

| Method id | Slice | Output kinds | Flag rules |
|---|---|---|---|
| `SPC.IMR`, `SPC.XBAR_S` | 6A-2 | CONTROL_CHART | `NELSON_1`, `NELSON_2`, `NELSON_3`, `NELSON_5` |
| `CAP.INDEX` | 6A-2 | CAPABILITY | none (shown, not flagged) |
| `DRIFT.TREND` | 6A-2 | DRIFT | `DRIFT_SLOPE`, `DRIFT_EWMA` |
| `RATE.DEVIATION` | 6A-2 | RATE_COMPARISON | `RATE_ABOVE` |
| `MSPC.PCA` | 6A-3 | MODEL_CANDIDATE, MSPC_SCORE | `T2_ABOVE`, `Q_ABOVE` |
| `ATA.RULES` | 6A-4 | AUDIT_RULE_HIT | `LATE_ENTRY`, `BACK_DATED`, `CORRECTIONS_HIGH`, `TWO_TERMINALS`, `TOO_REGULAR`, `REPEAT_UNTIL_PASS`, `OFF_HOURS_CONFIG` |
| `ATA.BASELINE` | 6A-4 | AUDIT_BASELINE | `BASELINE_Z` |
| `REVIEW.PRIORITY` | 6A-5 | REVIEW_PRIORITY | none (it orders, never flags) |
| `GBP.DTW_BAND` | 6A-6 | MODEL_CANDIDATE, PROFILE_DISTANCE | `OUT_OF_BAND`, `DTW_DISTANCE` |

## 5. Contract (GMP installation only; SESSION; `/api/analytics/...`; 404 on the sandbox)

Every response carries the advisory envelope:
- `advisory: true` and `notForGmpDecisions: true`;
- `method {id, version}`, `run {id, dataAsOf, finishedAt}`;
- `dataAgeSeconds`.

Statistics are `StatNumber`, a finite JSON number. It exists only in `analytics*` namespace files. A GMP value echoed
(a recorded value, a limit) is the source's decimal text.

| File (owner) | Routes |
|---|---|
| `ns/analytics.ts` (6A-0, then the lead) | `analytics.catalog` GET `/api/analytics/catalog`; `analytics.methods` GET `/methods`; `analytics.monitor` GET `/monitor`; `analytics.flags` GET `/flags?from&to&kind`; `analytics.flag` GET `/flags/:flagId`; `analytics.dispose` POST `/flags/:flagId/dispositions` |
| `ns/analytics-spc.ts` (6A-2) | `analyticsSpc.chart` GET `/api/analytics/spc?product&family&item`; `analyticsSpc.capability` GET `/spc/capability?...`; `analyticsSpc.rates` GET `/api/analytics/rates?product&by&from&to` |
| `ns/analytics-mspc.ts` (6A-3) | `analyticsMspc.chart` GET `/api/analytics/mspc?product&family`; `analyticsMspc.batch` GET `/mspc/batches/:batchId`; `analyticsMspc.candidates` GET `/mspc/candidates` |
| `ns/analytics-audit.ts` (6A-4) | `analyticsAudit.flags` GET `/api/analytics/audit-flags?from&to` (needs `ANALYTICS.DI_REVIEW`); `analyticsAudit.flag` GET `/audit-flags/:flagId` (the flag, its reasons and its audit entries) |
| `ns/analytics-review.ts` (6A-5) | `analyticsReview.priority` GET `/api/analytics/review-priority/:batchId`. The optional `priority {score, reasons, methodVersion, scoredAt}` field is added to `review.queue` items by the lead |
| `ns/analytics-profile.ts` (6A-6) | `analyticsProfile.batch` GET `/api/analytics/profiles?batch&step&tag`; `analyticsProfile.candidates` GET `/profiles/candidates` |

Making a method version or a reference set effective goes through the 6f configuration change routes (`config`
namespace), with the analytics areas added. It is not a new route.

## 6. Fixtures (so slices build in parallel)

- **`packages/test-kit/src/analytics-history.ts`** is `analyticsHistory(seed = 6)`, a deterministic generator (seeded
  PRNG, decimal text out). For GB-T-01's product it gives:
  - 30 batches;
  - a mean shift of one sigma from batch 24 on the granulation end-point;
  - batch 27 within every limit but with the hardness-thickness correlation broken;
  - deviations with room R-2 at three times the others' rate;
  - audit events with one late entry, one back-dated entry, one two-terminal login within 1 minute, one person with
    terminal-digit preference, one repeat-until-pass, and clean persons;
  - 20 normal press-force curves and one abnormal curve.
- The generator writes the rows the input views read, as SQL fixtures for database tests and as typed arrays for unit
  tests. Its expected flags are listed beside it.
- **Reference values:** `packages/analytics/test/reference/*.json`, computed offline with the script stored beside
  them (its tool and version recorded), for the charts, capability, intervals, PCA and DTW.
- **Contract examples:** `packages/api-contract/fixtures/analytics*.json`. Each route has one, and each parses.

## 7. Test titles (fixed; the plan's slice sections list them in full)

- `[DI-51] the analytics role cannot write: no insert, update or delete outside analytics, no command, and the
  segregation check reports any extra grant`
- `[DI-51] no GMP table, function, view or trigger depends on the analytics schema`
- `[DI-51] no floating-point column exists outside the analytics schema`
- `[DI-51] the golden batches keep their exact outputs with the analytics runner on`
- `[DI-52] a method version without an approved change record is refused`
- `[DI-52] every output names its run, method version and input references; a re-run reproduces it`
- `[DI-52] a disposition is recorded by the person who gave it, audited, and superseded only with a reason`
- `[DI-53] a person flag is unreadable without ANALYTICS.DI_REVIEW, also through the app role directly`
- `[PR-61] the review queue lists the same records with scores, without scores and with the runner down`
- `[PR-61] no review, register or release function depends on the review priority`
- `[PR-60] the analytics catalogue lists every method and none changes GMP data`

## 8. Defaults of the interfaces

- **D-6A-0-1:** the analytics tables are in the kernel, because the role, the audit registration, the configuration
  areas and the permissions are kernel objects. Input views over recipe-core and site-services tables are in
  recipe-core, as 6g's are; views over kernel tables are in the kernel.
- **D-6A-0-2:** parameterised inputs (the series samples) are row functions with EXECUTE to `ebmr_analytics` only. Every
  other input is a parameterless view.
- **D-6A-0-3:** a run's outputs count only after `finish_run`. A crash leaves an unended run that the views ignore and
  the monitor counts as failed after 1 hour.
