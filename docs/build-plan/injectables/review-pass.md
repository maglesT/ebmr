# Injectables review pass (I-6): database items and browser-test stalls

Branches `inj/i6-review-db` and `inj/i6-review-e2e-stalls`, combined in `inj/i6-review-pass`, 14 November 2026. Three
database items from the lead's review list, then the browser-test stalls (item 4). Regulations are paraphrased.

## 1. Intermittent [DI-20] enrolment failure in CI shard 7 (fixed)

**Symptom.** Run 43266879234, shard 7: `opcua-endpoint-identity.test.ts > [DI-20] enrolment ...` expected
`EBMR-EQD-032` and got `duplicate key value violates unique constraint "device_code_key"`.

**Root cause: test data, not product.** `device_code_key` is the unique code of `iam.device` (kernel 0140). The failing
line called the test helper `enrolEndpoint`, which runs two separate commands: `iam.register_device` with a generated
code, then `plant.enrol_opcua_endpoint`. The generated code was `OPC-` plus `randomBytes(3)`, only 24 bits, while every
other device helper draws 40 bits or more. When two registrations in the file's database drew the same code, the
registry refused the second one before the enrolment command ran, so the enrolment guard under test never ran. Nothing
else in that call can raise `device_code_key`: the fingerprint is 256 random bits and has its own constraint, the
database is per file (cloned from the template, which holds no `OPC-` devices), and the helper passes no fixed code. A
24-bit collision among the handful of endpoints in one file is rare per run. That fits a single failure across many
runs, and it is the only path that can raise this error.

**Is the guard order a product defect? No.** `EBMR-EQD-032` belongs to the enrolment command and is checked before its
first insert. It concerns a device registered outside the plant's rooms and lines. A duplicate device code is refused by
the registry, which is a different command with its own unique constraint. It is never an enrolment, so it has no
`EBMR-EQD-032` path to bypass. A second enrolment of an already enrolled device is not a duplicate either: by design it
is a new version, serialised by the advisory lock and the `(device_id, version)` key. No SQL change.

Possible follow-up for the kernel, not needed here: `iam.register_device` reports a duplicate code as the raw 23505 and
not as an `EBMR-IAM-` domain message. The refusal itself is correct.

**Fix (tests only).** `endpointCode()` now draws 64 bits. A new `registerEndpoint` helper registers without enrolling,
and the enrolment test registers first and then expects `EBMR-EQD-032` from `enrol` alone, so its assertion depends
only on the guard. New test `[DI-20] a second registration under an enrolled endpoint's code is refused by the registry
and leaves its enrolment as it was; test endpoint codes carry 64 random bits`, added to DI-20's list.

## 2. Kernel `platform.change_record_content` reading `plant.aps_required_line` (moved to its own PR)

**Lead ruling, 14 November 2026.** The first build (tablets 1914, below) re-registered the `config_change_record`
provider row, and the DI-48 upgrade drill refuses an upgrade that changes an earlier catalogue row. Loosening the drill
was rejected. 1914 left this PR. The next PR builds a kernel extension point instead:
- `esig.content_extension`, with database guards and its own SQL mutation group;
- the provider row unchanged;
- the extensions' output merged in a fixed order (by extension key);
- the pre-1914 hash test kept, and a test that the APS lines reach the signed content;
- the drill passing unchanged.

The text below records the first build, kept on branch `inj/i6-content-extension`.

**Finding.** Tablets 1910 replaced the kernel's provider function (kernel 1195) with a copy that reads the plant module's
table. This gives two problems. First, the kernel's database object depends on an edition table, which is the layering
that ADR-0018 keeps out of the kernel ("the kernel stays free of process logic and works on its own"). Second, any later
kernel change to 1195's content would be silently overwritten by the copy, or would silently overwrite the copy,
depending on migration order.

**The seam already exists.** `esig.provide` calls whichever function `esig.content_provider` names for an aggregate
type, and `esig.register_content_provider` (kernel 0200) upserts that row; providers are registered by migrations only.
So a module can contribute content by wrapping the kernel's answer, as ADR-0018's SCOPE hook does. The kernel function
does not need to change.

**Built: tablets 1914 `aps_lines_content_provider`.** It does three things:
- It restores `platform.change_record_content` to 1195's body exactly.
- It adds `plant.change_record_content(text)`, which takes the kernel's answer and adds the sorted `aps_lines` to
  `content` only when the record lists units, as 1910 did.
- It registers this function as the `config_change_record` provider.

The output is the same key for key (jsonb has no key order), so the content hash of every signature already given is
unchanged (INV-09). A list changed after QA signs still fails the approval. Test `[ST-29] the APS list reaches the
signed content through the plant content provider; the kernel content of a change record reads no module table (tablets
1914)` is added to ST-29's list. It checks the registry row, the kernel's six content keys, that the provider output
equals the kernel output plus `aps_lines`, that a record without a list gets the kernel output exactly, and that the
approval signs and withdraws the lines.

**Constraint to note.** There is one provider per aggregate type. If a second module ever needs to add to
`config_change_record`, it must compose with `plant.change_record_content`, as ADR-0018 says for the SCOPE hook. The SQL
mutation target list (`tools/sql-mutation/src/targets.ts`) still names the kernel function. It should add the plant
provider at the deployment mutation run (decision 0008).

## 3. Database re-check of expected yes/no answers (assessment only)

**Gap.** Recipe-core 1862 has the database re-judge a library block's numbers, timers, calculated figures and test
results against the formulation's limits, and require exactly the `LIB_LIMIT_BREACH` exceptions they call for. The
engine (`library/block-version.ts`) also raises:
- `LIB_UNEXPECTED_ANSWER` for a YES_NO field answered other than its `expected` (ACTION, deviation required, step
  blocked; with `unexpectedCritical`, CRITICAL, QA only, step and downstream blocked, release blocked);
- `LIB_NOT_ALLOWED_CHOICE` for a CHOICE that is not allowed.

The database checks neither. A write through the application role that stores "no" for an expected "yes" and omits the
exception is accepted. No deviation opens and no release interlock fires.

**Where the data are.** Each block definition in the master's snapshot (`recipe.library_definition(content, block)`,
already read by 1862) has `sections[].fields[]` with `type`, `expected`, `unexpectedCritical`, `notAllowed` and
`showWhen`. The answer is in the entry's `data`. The seed library has about 190 expected answers (one `unexpectedCritical`).

**How it would be done.** It would take one new recipe-core migration that does `CREATE OR REPLACE` of
`recipe.library_limits_problem` from its 1862 text. In the section loop it adds a pass over YES_NO and CHOICE fields:
- It skips a field that its `showWhen` hides, and skips the UNTIL_PASS endpoint as the engine does (a YES_NO endpoint is
  judged by the loop logic only).
- For a value other than the expected one, it appends the required exception record to `v_want`. That record holds the
  type, category, PR-29, severity, deviation need, block, QA-only and release flags, and the source and raiser, built as
  `recipe.library_breach_record` builds them.
- The existing one-for-one matching then refuses an omitted exception, a weakened one, or one raised with no unexpected
  answer.

Tests: one engine/database parity sweep over every seeded expected answer and not-allowed choice, plus bypass tests for
an omitted, a downgraded (critical stored as ACTION) and a spurious exception. Estimate: about 60 to 100 lines of SQL in
a carried-forward function of about 280 lines, and one working day with tests.

**Risks.**
- Carrying forward a long function risks regressing 1862. The 1862 tests and the SQL mutation harness cover it.
- The engine and the database could judge differently (`showWhen`, loop endpoints, the critical flag). The parity sweep
  covers this.
- Records written before the change are not re-judged, because the trigger acts on new entries.
- Run-time cost is negligible: one pass over fields already loaded.

**Binding clauses (paraphrased).**
- 21 CFR 211.188(b): the batch record documents each significant step and in-process control result.
- 21 CFR 211.192: any unexplained discrepancy, or a failure of a batch or component to meet its specifications, is
  thoroughly investigated before release, whether or not the batch is distributed. An expected-answer check that fails
  is such a failure: the exception is the record that starts the investigation and holds release.
- 21 CFR 211.68(b) and EU Annex 11 (built-in checks for the correct entry and processing of critical data; accuracy
  checks): the system must not let a critical result bypass its check.
- Revised Schedule M: deviations from instructions are recorded and investigated, and computerised systems carry the
  same data checks as Annex 11.
- Decision 0008 section 2 puts "limits, calculations and recorded data points" and the release interlocks in the
  database-enforced core. An expected answer is a binary acceptance criterion, which is a limit.

**Recommendation: yes.** Build it with `LIB_NOT_ALLOWED_CHOICE` in the same migration, because it has the same gap,
the same function and the same clauses. It passes the owner's test of minimum compliance: there is a binding clause
(211.192 investigation before release) and a real record-integrity need (otherwise the application role alone decides
whether a failed check holds release, which is the threat 1862 already closes for numeric limits). It adds no new
refusal for the operator: the engine already raises these exceptions. The database would only refuse a write that
leaves them out.

**Lead's ruling (14 November 2026).** Build item 3 as its own PR after the injectables exit PR. Three conditions:
- 1862's body is carried forward, and the diff against it shows nothing removed.
- A parity test shows the engine and the database agree on every seeded expected answer, hidden-field cases included.
- The SQL mutation group covers the new branch.

## Item 3 follow-up: a value in a field its condition hides (recipe-core 1927)

**Gap.** The engine refuses an entry that gives a value to a field its condition (`showWhen`) hides (LIB-ENTRY-HIDDEN,
"leave it empty"). 1924 judges answers only in fields the entry shows and 1862 refuses a hidden calculated value, but no
database check refused a recorded value in a hidden field. A write through the application role could store, for
example, a rework quantity with rework answered "no".

**Built (lead's ruling, 14 November 2026: same pattern as item 3).**
- `recipe.library_hidden_problem` and the trigger `zzh_library_entry_hidden` (after update on `recipe.execution_state`):
  an entry the row adds or changes, of a library step, that stores a value in a field of its section whose condition is
  not met in the stored data is refused (EBMR-LIB-025, the message names the field and LIB-ENTRY-HIDDEN). Calculated
  fields stay with 1862 (`computed`); timers are their own entries. No earlier function is replaced.
- Parity: `packages/recipe-core/test/library/entry-hidden-db.test.ts` records every seeded condition through the engine,
  met and not met; the engine's rows are accepted, the engine refuses the hidden value, and the database refuses the
  engine's row with the value put back.
- Bypass: the trigger itself, through the application role (`apps/tablets-server/test/mutation/library-blocks.test.ts`).
- SQL mutation group `library-entry-hidden`.

## Item 2 addendum: signatures given before 1914 (with item 2, in its own PR)

Test `[ST-29][DI-37] a change record approved under the 1910 content keeps its signed content and hash under the 1914
provider, with and without listed units`. It registers 1910's own function text (read from that migration) as the
provider and has QA approve a record with units and one without. It then restores the 1914 provider. Both records give
the same content and the same e-signature content hash (`esig.content_hash_of`) as the stored signatures, and
`esig.verify_signatures()` reports no problem for either.

## 4. Browser tests that held to the 1 h test timeout (guarded; root cause open)

- **What happened.** The `endorseOnLicence` fill (library-inj-aseptic) and the 'API' radio in #248 hung until the
  test timeout. The CI traces show one event in both: the page's main thread answered a snapshot about 1.3 s after
  load, then never answered again. The app code shows nothing that would spin (`DefineForm`, `LicencesPage`,
  `ChoiceGroup`, `Field`, the app timers). **What freezes the renderer is still open.**
- **Why the action timeout did not end it.** The click timed out at 30 s, but Playwright's trace recorder (1.56.1,
  `onAfterCall`) then takes an "after" snapshot by running script in the same frozen page, with no timeout.
- **Guard.** `tools/e2e/fixtures/renderer-watchdog.ts` checks each page over its own CDP session every 5 s. If an
  answer is 30 s late (the action timeout), it attaches where the page is stuck and closes the page, so the pending
  action fails at once. Retries are 0 in every Playwright config and nothing in CI passes `--retries`, so a watchdog
  close is always a failed test, never a pass on retry (lead, 14 November 2026). Tests: the watchdog unit test with a
  fake clock, and a real-browser smoke spec where a click handler that never returns fails in about 5 s.
- **Real race found on the way (fixed).** Demotab 12's `choose(Accept)` left the radio unchecked: the item's detail
  (`RegisterPage.tsx` `ItemDetail`) appeared above the choices between press and release, so the release landed
  elsewhere. A person's tap would be lost the same way. The answer and disposition controls now appear only once the
  item has finished opening. A component test fails without the fix and passes with it.

- **The same race in the reserve-lot form (fixed).** The exit PR's run (#255, own-demotab, Demotab 6) failed on
  "Reserve the lot": the call log says the Quantity label intercepted the press, then the click held to the test
  timeout (the freeze above). Choosing a batch loads the potency preview (`PotencyPreview`) above the quantity and the
  button, and its arrival pushed them down under the pointer. `LotHandling.tsx` now offers the quantity, the reserve
  date and the button only once the chosen batch's preview has arrived (the same query, one request). A component test
  in `test/receipt/potency.test.tsx` holds the preview's response: it fails without the fix and passes with it.

## Residuals

- Browser tests: find what freezes the renderer, using the stack the watchdog attaches at the next freeze.

- Kernel: `iam.register_device` should report a duplicate device code with an `EBMR-IAM-` message, not the raw
  unique-violation error. Not needed now (lead, 14 November 2026).
