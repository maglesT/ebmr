# Phase 7 review backlog

The findings and residuals of the Phase 7 slice reviews (one quick review per slice, decision 0008; at most 2 fix
rounds per finding, then a residual). Fixed findings also have an entry in the
[defect log](../../handbook/08-defect-log.md).

## Slice 7a (the decision 0022 fixes; review of 17 October 2026)

One read-only pass over the merged slice (parts R9, R10, R2, R16) for bypasses, dropped checks in re-created
functions, definer hardening, the signature check and mutual TLS. Checked without a finding: the verification marker
(keyed on the transaction and the envelope hash, used once, granted to nobody), every `plant.receive_*` passing
through `platform.accept_inbound_detail`, proposer self-approval refused, the in-force plant-rule readers, every
re-created function only adding or narrowing checks (the alarm acknowledgment's unscoped check for batch-bound alarms
is replaced by the batch's scope, as intended), `set search_path` on every new definer, the key lookup bound to the
adapter's gateway, the payload checked against its hash on the raw text, the pinned CA and server name.

| Id | Severity | Finding | Outcome |
|---|---|---|---|
| P7A-1 | high (IN-53, draft) | Controlled-substance entries were readable through the audit-trail viewer: the controlled chains fell to the governance class, custody rows sat in lot chains and checkpoint rows in batch chains, open to any record reader. | Fixed (tablets 1415): the four controlled chain kinds need CONTROLLED.READ in scope to be read, listed, counted or verified; controlled tables' entries on lot and batch chains are hidden from other readers; QA still sees everything. Limit: a lot or batch chain's length and verification still count the hidden entries (that entries exist, not what they say). |
| P7A-2 | low | Four controlled write routes read back through the gated reads, so a writer without CONTROLLED.READ in that scope would get a refusal after a committed write. | Fixed (server): the read-back runs inside the write's transaction, so a refused writer gets 403 and nothing is committed. |
| P7A-3 | low | The register extract list had no site filter. | Fixed (tablets 1415): extracts carry no site and cover every site's lots, so they are read only with a grant without a site or product limit, the scope the export runs in. |
| P7A-4 | low-medium (DI-31) | The signature does not name the adapter: two OPC UA adapters bound to one gateway could replay each other's signed envelopes. | Fixed (tablets 1406): one live binding per gateway; a second adapter is refused (EBMR-DEV-179). The test failed before the fix. |
| P7A-5 | low (DI-31) | `transport_peer` comes from a session setting any application session can set. | Fixed (kernel 1306): the column already took only 64-hex values; its comment, the handbook and the runbook say it is advisory, recorded by the server's adapter worker, not evidence by itself. |
| P7A-6 | low (DI-31) | The v1 feed signature does not cover the envelope's `sourceTimestamp` and `sourceRecordId`. | Residual (lead): the receive functions take every GMP time from the payload, which the signed payload hash covers; the two envelope fields are stored metadata. The v1 format was fixed in 7-0 and stays; a v2 that adds them is an option for a later release. |
| P7A-7 | high (DI-47; regression from 1214) | Revoking the application role's SELECT on the controlled tables broke every true copy of a batch, lot or controlled product (the builder reads every registered table of the chain as the application role), so archiving and disposal failed (review/f34). | Fixed (recipe-core 1215): the application role, the server's own identity, reads the tables as it reads all GMP data, so true copies and archives stay complete; IN-53's database gate stays on every person-facing path (the gated definers of tablets 1413 to 1415, the audit viewer) and the routes; the old read functions stay closed to it. |

Residuals of the parts (from the builders):
- R10: on upgrade, every earlier plant-rule version counts as a pending proposal: a material declassified before 7a
  stays beta-lactam until QA approves the declassification (stricter, intended).
- R9: a gateway journal written before 7a is refused (EBMR-INT-030); the runbook says to start with a fresh journal.
  The kernel test helper `receive()` delivers OPC UA envelopes through a TEST-ONLY verifier made in the test's own
  database (a deliberate test seam).
- R16: the hold-point proposal tests stop at the act's own state check (EBMR-EXE-084); a sandbox test run's issue and
  site consumption keep the stricter location or site scope (no order to give the product); the issuer's engine roles
  at a GMP issue stay location-only (BATCH_ISSUER maps no engine role).
- Lead: `recipe.check_engine_roles` stays in the `execution-commands` mutation group: recipe-core 1224 drops only its
  2-argument form; the 3-argument form remains and is mutated by name.

## Slice 7b-1 (the hardening list; review of 18 October 2026)

Built in two parts (7b-1a database and access items, 7b-1b worker, gateway and message items). One read-only pass for
bypasses, dropped checks in re-created functions, definer hardening, silent data loss and the "saved" answer. Checked
without a finding: the gap-alarm acknowledgment (kernel 1320), the DSC functions (1321), the insert-only outbound table
(site-services 1110), the restricted analytics counts (1322), every re-created function (only the intended lines
changed), `set search_path` and the administrator check first in every new definer, SAVED_NOT_SHOWN answered only after
a committed command.

| Id | Severity | Finding | Outcome |
|---|---|---|---|
| P7B1-1 | medium (DI-32) | The 5-minute lower bound on OPC UA source times (recipe-core 1233) also refused alarms and equipment events that happened while the gateway was down and arrived at reconnect, and (found by GB-T-03) the current value of a tag that never changes, which an OPC UA server sends dated at its last change. | Fixed (kernel 1330, recipe-core 1234, 1235): series, alarms and events are refused only when older than the session start minus the gateway's offline buffer (`integration.opcua_offline_buffer_s`, default 7 days, change-controlled); a 1970 time is still refused; the gateway uses the same window. The round-2 fix came from the golden run. |
| P7B1-2 | medium (IN-30) | The contract-giver reviewer was refused only by `tab.record_read_problem`; the audit-trail reads granted on RECORD.READ, so its session read any batch's audit chain at database level. | Fixed (tablets 1426): every audit-trail read refuses the contract giver's reviewer at database level; QA still reads. |
| P7B1-3 | low-medium (DI-32, DI-31) | The gateway spool could lose samples without a SERIES_GAP: a crash just after a chunk closed, a spooled chunk failing validation, and a signing error that let the spool be truncated. | Fixed (gateway): the gap starts at the series' last journalled chunk end; dropped chunks are reported as a gap; the spool is truncated only when every recovery publish succeeded. |
| P7B1-4 | low (DI-32) | An endpoint session reported with a gateway clock near 1970 made the lower bound near 0. | Fixed (recipe-core 1234): a session is refused when it starts more than the offline buffer before the database clock (not 5 minutes: a server outage would otherwise refuse the sessions pulled after it). |
| P7B1-5 | low | The slow tag's baseline sample was dropped at every reconnect. | Settled by P7B1-1's fix (the window is the offline buffer). |
| P7B1-6 | low (DI-31) | A reconciliation whose commit succeeded but whose follow-up read failed was reported again on the next run. | Fixed (adapter framework): the result is read in the same statement as the insert. |

Residuals of the parts:
- F-6jb-g1 (medium, fail-safe): a record lock still counts as a change since review; the epoch rows carry no cause and
  the lock's bump shares `record_lock_append` with amendment and reconciliation bumps, so it cannot be told apart
  without loosening other change detection (D-P7-7; defect log).
- Ten writers refuse administrators just after their permission check rather than before (both before anything is
  written); listed by the wider authorization scan (6jc-R7), not re-created.

## Slice 7b-2 (the stand-alone viewer and the periodic evaluation pack; review of 18 October 2026)

One read-only pass. Checked without a finding: XSS and network in the viewer (record text set as text, CSP
`default-src 'none'` with pinned script and style), the four definers' `search_path`, administrator check and grants,
no `Date.now()` or JavaScript numbers for GMP values. Every finding was fixed in one round, each with a test that fails
on the earlier code (the slice's migrations were not yet merged, so kernel 1335, 1336, site-services 1120 and
recipe-core 1240 were corrected in place).

| Id | Severity | Finding | Outcome |
|---|---|---|---|
| P7B2-1 | high (DI-11) | The pack store compared only each entry's identity with the source logs, so a generator could change a restore-drill result, a deviation's classification or an integrity count and QA would sign the hash of a falsified pack. | Fixed: every entry's full content, every topic's sources and every sampled record are compared with the database's own rows before the pack is stored. |
| P7B2-2 | medium-high (DI-08, DI-44) | "Closed" was the first move to a terminal status, not the record's current state, so a reopened batch, or one still in review, was exported and sampled as closed. | Fixed: a batch is closed only while its record is locked, or it is aborted or cancelled; the latest such event is its close time. |
| P7B2-3 | medium (DI-08) | Amendments of a locked record (`record_lock`) and their signatures were missing from the export. | Fixed. |
| P7B2-4 | medium (DI-08) | The export's registration trusted the client's chains and head hashes. | Fixed: the export is a run with its scope fixed and audited, paged, written to disk as it goes; registration must match the run's records, chains and heads, each head hash checked in the database. |
| P7B2-5 | medium (DI-08) | Without the registered export hash, the viewer showed "All checks passed". | Fixed: it shows "NOT ANCHORED — origin unverified" and says where the registered hash is found. |
| P7B2-6 | medium (IN-53) | Batch and lot chains holding controlled-substance rows were exported and sampled for a holder without CONTROLLED.READ. | Fixed: such an export or sample is refused, not trimmed (an export must be complete). |
| P7B2-7 | medium (scale) | Unindexed signature lookups, the closed-record set recomputed per call, the whole export held in memory. | Fixed: a range index, the scope computed once per run, keyset paging, files streamed to disk and loaded by the viewer on demand. 7d's load test measures it. |
| P7B2-8 | low | The reporting reader was not checked; a malformed part left the viewer on "Checking…"; the sample's seed and size were free. | Fixed: the reader must be `ebmr_report`; viewer errors are a failed verdict; the sample is at least the smaller of 10 and the closed records, with its seed and size in the signed pack. |

Residuals of the slice: no screen yet for QA's sign-off of the pack (slice 7g-3, decision 0025); an HMAC-sealed
installation's seals are checked by the installation, not offline (Ed25519 sealing is checked offline; D-7b2-1).

## Slice 7c (validation pack generators and the DI-03 and DI-06 interlocks; review of 18 October 2026)

One read-only quick pass, no findings. Checked: kernel 1350 against main's latest definitions (`accept_inbound_detail`
from kernel 1305 and `record_inbound_refusal` from 1180 differ only by the drift check; the alarm-kind check keeps
SERIES_GAP and adds INTERFACE_DRIFT, matching the SDK's list); recipe-core 1250's `gmp_issue_problem` is 0891's body
plus the validation-summary check first; every new definer has a fixed `search_path`, the internal functions are
revoked from public and only `check_adapter_start` is granted to `ebmr_app`; no `Date.now()` or JavaScript numbers for
GMP values; the DI-06 tests exercise the alarm, the refusal without a stored message, the start check and the bypasses.
The golden batches pass unchanged (44/44): no golden output was re-taken.

## Slice 7d (drills, security, load, inactivity warning, accessibility; review of 18 October 2026)

One read-only quick pass, no findings. Checked: the analytics runner in a worker thread keeps main's P6A7-8 role check
(a wrong or unreadable role, or a worker that fails to load, logs the DI-51 error and never starts a run; the server
keeps serving as on main); tablets 1460's `tab.resolve_session` is tablets 0550's body plus the idle-lock and end
countdowns (definer, `search_path`, role-withdrawn logic and grant kept); the route-by-role matrix refuses any 5xx and
any GMP write by the system administrator or the read-only auditor, and its re-recording after the merge only removed
rights (7b-1's tightening of four routes); no secrets in the drill, security and load tools; the two accessibility-spec
changes (`page.goBack()` for a browser key headless Chromium does not receive, a hidden radio measured by its label)
keep the checks. The accessibility run found A11Y-4 to A11Y-7, fixed in the app (`docs/validation/accessibility-audit.md`).

## Slice 7e (branding, guides and `tools/guides`; review of 18 October 2026)

One read-only quick pass. Checked without a finding: the Markdown converter escapes raw HTML in text, alt text, code,
headings and table cells; images are limited to .svg and .png and links outside a guide become text, so no file
outside the guide is read; the tools write only under `docs/guides/reference` and `.reports/guides`; the catalogue
reads a throwaway database built from the migrations; the guides' rights, signature meanings and functions are checked
against that database by the tests; no verbatim regulation passages; the UI changes are branding only.

| Id | Severity | Finding | Outcome |
|---|---|---|---|
| P7E-1 | low | A link target with any scheme (for example `javascript:`) became a live link in the built guide (repository-authored Markdown only). | Fixed: only http, https and mailto stay links; any other scheme is shown as text (`externalHref`), with a test. |

## Slice 7g-5 (finding of 18 October 2026)

- **7g5-F1 (high; DI-15): the US e-signature certification was enforced on no batch-issue path.** Kernel 0170's
  `iam.assert_us_esig_certification` (policy `esig.us_certification_mode`, BLOCK by default) was called by nothing, so a
  US-market GMP batch was issued with no 21 CFR 11.100(c) letter on file. **Fixed** in recipe-core 1260:
  `recipe.gmp_issue_problem` (rebuilt from 1250) refuses a batch with US in its market set when the holder of the
  manufacturing licence it is issued under (`site.licence_basis`, the host licence for a loan-licence batch) has no letter
  on file (EBMR-IAM-170), and a BEFORE INSERT trigger on `recipe.batch_execution` calls the kernel's assert for every
  writer of a GMP batch row. Tests: `packages/recipe-core/test/lifecycle/us-esig-certification.test.ts` (2) and
  `apps/tablets-server/test/execution/us-esig-certification-issue.test.ts` (1), failing before the migration. Test
  fixtures (`World.licenceFor` for a US market) and the demo seed record the letter (process owner; DEMO-ONLY).
  For the owner: the legal entity is read as the licence holder's name as recorded on the licence, so the letter must be
  recorded under exactly that name; whether a loan licensee's letter is also needed stays with the expert decision on DI-15.

## Slice 7g (review of 19 October 2026)

| ID | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| P7G-1 | medium | `route-matrix.test.ts` exempted the whole `people` and `deviceRegistry` namespaces from "the system administrator never succeeds at a write". | Fixed (D-P7R-9): an explicit per-route list (person, account, credential, badge, device, gateway, empty-role and attribution routes), each with its reason; a listed route must exist and be a write. New tests: an administrator cannot approve a grant to their own account requested by another administrator, nor a permission for a role they hold (both already refused by kernel 0120, EBMR-IAM-032; no guard added). Whether the administrator keeps IAM.GRANT_APPROVE and IAM.ROLE_MANAGE is an open question for the DI-18 expert decision. |
| P7G-2 | low | The web client's write signal (`onWrite`) fired for POSTs to routes without a session (device nonce, identify), pushing the idle estimate out. | Fixed: auth-NONE routes are ignored (`apps/tablets-web/src/api/client.ts`); test `test/api/on-write.test.ts`, failing before. |
| P7G-3 | low (regulatory) | recipe-core 1260 `recipe.us_esig_issue_entity` returned NULL for a US-market batch whose licence holder could not be resolved, so the gate and the trigger skipped the certification check. | Fixed in place (1260 is not on main): it returns '' for that case and both the gate and the trigger refuse it (EBMR-IAM-170), in BLOCK and FLAG mode; `[DI-15]` test in `packages/recipe-core/test/lifecycle/us-esig-certification.test.ts`, failing before. |
| P7G-4 | low | The upgrade drill's `fromRelease` (any text up to 200 characters) became a command-line value of the drill tool; a leading dash would read as an option. | Fixed: the contract accepts only `^[A-Za-z0-9._+][A-Za-z0-9._+-]{0,199}$`, and `startUpgradeDrill` checks it again; contract test `packages/api-contract/test/operations-drills.test.ts`. |
| P7G-5 | low | tablets 1485 `tab.installation_contents()` and 1491 `tab.disposal_aggregate_id()` were granted to the application role with no check inside. | Fixed in place: both take the session token; the first needs an active session in a granted role (EBMR-TAB-018), the second a records reader as `tab.record_retention` (EBMR-TAB-018, EBMR-TAB-020); the signing handlers pass the session's token. Test `apps/tablets-server/test/operations/session-checked-reads.test.ts`. |
| D-P7R-8 | - | The segregation check failed for `validation.startFullExport` as the auditor (RECORD.EXPORT, kernel 1335). | Owner decision recorded: audited exports or copies are audited reads for the auditor (explicit list: startFullExport, archive.assembleExport, controlled.runRegister); the administrator stays refused. |
| 7g-W1 | low | The designer's save dialog kept the change note in the editor's state: every key re-rendered the whole editor (28 renders for a 28-character note). | Fixed as the justify dialog was (f9fe0d55): the note is the dialog's own state (`SaveRevisionDialog`); test `apps/tablets-web/test/designer/save-note-render.test.tsx` counts the editor's renders while typing (28 before, at most 2 now). |

## Phase 7 exit review (slice 7f; review of 19 October 2026)

One review pass over Phase 7 (`bc46d55..` the 7f branch, PRs #52 to #60): design and serious defects, the regulated core
read and the rest skimmed (D-P6j-c-1). No critical or high finding, so none needed a probe on a migrated database.
Checked without a finding: the 48 functions Phase 7 re-created, each against the definition before it (every removed
line is a permission check rewritten with batch or product scope, or kept in another form; the final
`tab.kernel_signing_meanings`, tablets 1525, keeps every earlier meaning); `set search_path` on every Phase 7 definer;
no table write granted to the application role; the DI-03 gate (a signature bound to the release and the document hash,
never an administrator; in the issue path and the insert trigger); the US e-signature gate of recipe-core 1260; the feed
signature's one-use, transaction-bound mark and one live binding per adapter and gateway; the signer checks of every new
signing consumer; the first-run set-up token; the operations acts; the route exemptions of D-P7R-8 and D-P7R-9; the
session idle rule of tablets 1460.

| Id | Severity | Finding | Outcome |
|---|---|---|---|
| P7X-1 | medium (DI-06) | The drift interlock (kernel 1350 `platform.interface_drift_problem`) checks only that the adapter code is described; the description's endpoint host, transport (LOOPBACK or MTLS) and source system are not compared with the adapter's registration or the base URL and TLS the server runs it on. A described adapter moved to another host, or run without the mTLS its description names, raises no drift alarm. | Known issue for v1.0-rc (owner rule of 19 October: the less strict option; the alarm still fires for every undescribed or withdrawn interface, and the system owner sees the endpoint on the validation screens). Comparing the running endpoint with the description is listed for v1.1. |
| P7X-2 | low (DI-06) | Commands that run under an adapter's identity outside the inbound path (site-services 0912 and 0916 outbound ERP postings; kernel 1180 `record_reconciliation`, 1182 `record_mirror_sync`; the WMS location question of site-services 0915) do not call the drift check, so an undescribed adapter could still claim or settle outbound postings. The server starts no such worker and the alarm fires at enable and at start. | Known issue (no GMP write against a control; the server never runs the worker). |

## Slice 7h (one review pass, 20 October 2026)

- P7H-1 (fixed): the press set-up panel charged the hopper with a fixed stage `COMPRESSION` instead of the step's own
  stage; it now sends the step's stage. Revised (D2 in the full browser suite): the step's stage is the master's stage id
  (S-COMP), which the contract's stage code refuses (every charge answered 400); a charge names the plant stage the
  container goes into, as containers name theirs, so the press set-up step charges `COMPRESSION` again.
- P7H-2 (residual, non-blocking): the start of the verification runs the designer's simulation before its idempotent
  command, so a resend of a committed start re-runs the simulation and can be refused as busy or timed out instead of
  returning the stored answer; the evidence stays right.
- P7H-3 (residual, owner rule): exporting a sandbox test-run result needs a session only (no permission of its own, no
  audit row); the file is write-once under its hash and GMP re-checks everything on import (D-P7R-20). A RUN.EXPORT
  permission can come with deployment if the owner wants one.
- P7H-4 (residual, found by the D2 browser test): the processing plan form does not send the ERP order the planner
  clicked; the server takes the oldest open ERP order of the family. The contract has no order field for a processing
  plan (the packaging plan has one); adding it touches the plan command, so it is left for a follow-up.
  **Fixed in slice 7i:** `execution.planBatch` takes `erpOrder`, the plan form sends the clicked order, the database
  checks it (gmp-batch.test.ts "G2 (slice 7i, P7H-4)", planning.test.tsx).
- P7H-5 (residual, found by the D2 browser test): a database refusal of a step entry was shown as "The sign-in could not
  be completed" with advice that the run had changed; the refusal's own words should be shown.
  **Fixed in slice 7i:** the session's `EBMR-TAB-*` guidance caught the block guards' EBMR-TAB codes; it now covers the
  session-binding codes only, the rest of the family is a 422 refusal with the database's message, and the floor's stale
  notice shows the message and code (tab-guidance.test.ts, entries.test.tsx).

## Slice 7j (one review pass, 22 October 2026)

- P7J-1 (fixed): `site.master_entry` (site-services 1530) had no explicit insert-only and no-truncate triggers. Added in
  1530 itself (not yet merged, so no new migration); test `master-entry.test.ts` (update, delete and truncate refused).
- P7J-2 (fixed): a master from a formula fell back to the typed product name when the product master in effect had no
  screen entry. The name now always comes from the product master in effect; the dosage form is the master's, or
  'Tablet' when it carries none (ERP products; D-7j-11); a master stating a non-tablet dosage form is refused
  (DESIGNER_PRODUCT_MASTER); test `designer/from-formula.test.ts`.
- P7J-3 (fixed): a test with a salt factor and an overage on a potency-adjusted active shows the skeleton's BOM, batch
  mass, target calculation and golden case agree with the 0640 batch quantity and the validator; `designer/from-formula.test.ts`.

## Slice 7k (one review pass, 23 October 2026)

- P7K-1 (residual, owner rule): on a demo installation, any signed-in person can read the DEMO-ONLY credential card
  (`operations.credentialCard`). This is by design, so a presenter can find the demo sign-ins. A PLATFORM.OPERATE
  check would restrict it. The card reads the seed file, so it can show a password the administrator has changed
  since. Outside a demo it is refused (DEMO_ONLY).
- P7K-2 (residual): "Send a production order" commits its demo act before the ERP post. A retry with the same
  idempotency key replays the stored reply without posting the order again. The Operations screen sends a fresh key
  on each press.
- P7K-3 (fixed): a tablet count that was not a valid decimal (for example `1e5`) skipped the 10 % tolerance check at
  issue. The GMP_BATCH_ISSUE contract already refuses a COUNT that is not a whole number. As defence in depth,
  `unconfirmedCounts` now marks such a count as malformed: it is refused with EBMR-EXE-700, and no reason can confirm
  it. Test `execution/issue-expectations.test.ts` ([PR-04] P7K-3, both the contract and the check).
- P7K-4 (fixed, CI): two floor races broke the browser runs. (1) A saved entry form showed "Saved" while still open
  and closed only after the step was read again; it now closes in the same render (fcv journey; test
  `demo-trial-fixes.test.tsx`). (2) The printed-lot panel handed the lot to the ISSUE form again whenever the step
  choices changed, so a saved issue form reopened at once with the same lot (and the effect re-ran without end). It
  now hands it over once per "Take the lot" (gmp-kiosk-batch 6, route W 9; test `step-plant-acts.test.tsx`).
- P7K-5 (fixed, CI): the browser suite passed 74 of 74 but reached the end-to-end job's 75-minute limit before it
  finished (run 39964635168). The suite now runs in groups on separate runners (route W, D and S
  each alone, the GMP batches, the rest; `E2E_GROUPS`), and a merge job turns their blob reports into the Playwright
  and evidence reports the trace reads.

## Slice 7l (one review pass, 23 October 2026)

Nothing blocking. The manual fallback for automated values keeps the exception and the second person (DI-30, PR-14);
flow acts go through the badge tap (INV-40); the route seeding stays on demo databases.
- P7L-1 (residual, carried to 7m): with no gateway scale and no declared balance, a manual weighing takes the room's one
  instrument booked for the batch as its balance; the operator never names it. The weighing stays MANUAL (exception and
  second person), but the stored evidence should mark the balance as inferred, or the form should ask for it.
  **Fixed in 7m**: the stored evidence records `manual.balanceInferred: true` (recipe-core 1650: the database refuses it
  beside a declared balance), and the entry's summary on the step and record screens adds "balance not named: the
  room's one balance booked for the batch" (tests: tb-01-gmp.test.ts G-07, execution-row-shape.test.ts).
- P7L-2 (residual, cosmetic): the potency calculation form stays open after its entry; its lot is typed, not scanned
  (the server validates lot and assay).
- P7L-3 (residual): a named-entry picker with an id pattern outside NAMED_KINDS offers entries of every kind; the block
  and the database refuse a wrong pick.

## Slice 7m (one review pass, 23 October 2026)

Nothing blocking.

- P7M-1 (fixed in 7m): the TB-16 layer-charge panel still offered "Record the charge" for a charge the step had
  recorded. It now offers only charges no entry of the step names (`step-plant-acts.test.tsx`); a second entry of a
  charge was already refused by the database (TB16-CHARGE, `forming/db-guards.test.ts`).
- P7M-2 (residual): recipe-core 1650 refuses `balanceInferred: true` beside a declared balance but does not check
  `false` against a missing one; the server sets the member only when no balance was declared.
- P7M-3 (follow-up): QA dispositioning 25 like exceptions one by one on a kiosk (route S's keyed coater values) meets
  the sign-in limit; a bulk disposition of like exceptions would spare the presenter.

## Slice 7q (R8 capabilities C1, C2, C8, C9, C10; 23 October 2026)

- 7q-1 (follow-up, for the R8 products): the lot assay register's writer `tab.record_lot_assay` (percent assays and,
  since tablets 1662, enzyme activities in U/mg) has no route or screen; the demo seed records the results. A QC screen
  that records a lot's approved result from its LIMS results is needed before P4, P7 or any potency-adjusted product
  runs on GMP through the screens.
- 7q-2 (no follow-up, C9): TB-16 already takes two or three layers; a trilayer product needs no custom block.
- 7q-3 (follow-up): browser proofs of C1 and C2 (P7, P1), C8 (P8) and C10 (P1) come with those products.
- P7Q-4 (fixed): the GMP activity test also refuses an ACTIVITY result that is not approved, one that fails its limits
  and one of another lot (`tb-01-gmp.test.ts`).
- P7Q-5 (fixed): `recipe.formula_mbr_problem` compares a BOM line's overage with the formula's as numbers ("2.0" states
  "2"; `recipe.bom_overage_matches`, recipe-core 1660); `designer/from-formula.test.ts`.
- P7Q-6 (fixed): an `overage` on a BOM line that is no formula line is refused instead of skipped (recipe-core 1660);
  `designer/from-formula.test.ts`.
