# Phase 6 mutation results (decision 0019)

Decision 0019 runs a full mutation campaign at the Phase 6 exit, on the pod, after the first final run is green and
before the Phase 6 PR. Part 1 is all Phase 6 code (main 8331e94 plus slice 6j); part 2 is the Phase 4 leftovers that
decision 0012 left to deployment. Targets are those of build outline 9.1: at least 90 % on guards, signature
invalidation, limits, rounding, flow validation and release gating, 80 % elsewhere. Priorities, the per-group run limit
(one first run, at most one confirmation run) and the time box (part 1 at most 12 pod hours, part 2 at most 8) are those
of decision 0019. Scores come from the harness and Stryker reports of the runs (`report.json`, `summary.md`,
`.reports/stryker-phase6/<feature>.json`); a score no report holds is marked so and not estimated.

This page was prepared before the campaign (branch `phase-6/slice-6j-mutation`, 16 October): the groups, the features,
the run plan and the time estimates are in place; every result is **pending**.

## Summary

| Part | Scope | First-run survivors | Outcome after the new tests | Real defects fixed |
|---|---|---|---|---|
| 1, SQL | 14 Phase 6 groups (3,981 mutants) and the 11 re-created functions of earlier groups (202 mutants) | pending | pending | pending |
| 1, Stryker | 20 Phase 6 features | pending | pending | pending |
| 2 | Phase 4 leftovers (below) | pending | pending | pending |

## Part 1, SQL: the Phase 6 groups

The groups are in `tools/sql-mutation/src/targets.ts` (header: inclusion rule, what is left out, why every group
targets 90 %; decisions D-P6j-M-1 to 3 in the Phase 6 plan). Mutant counts from `pnpm mutation:sql --count`; baselines
(one run of the group's tests on unmutated templates, all green) from `--baseline` on the 5433 cluster.

| Group | Decision 0019 area | Functions | Mutants | Baseline db / server (s) | Target | First run detected / valid | Score | Survivors | Equivalent | After |
|---|---|---|---|---|---|---|---|---|---|---|
| inbound-adapters-and-mirrors | adapters and mirrors | 21 | 310 | 17 / - | 90 % | pending | | | | |
| erp-wms-receipt-and-stock | adapters and mirrors | 41 | 351 | 37 / 6 | 90 % | pending | | | | |
| qms-capa-lims-cmms | adapters and mirrors | 38 | 401 | 12 / 5 | 90 % | pending | | | | |
| equipment-data-and-alarms | equipment, alarms, plant rules | 28 | 469 | 41 / 5 | 90 % | 307 / 469 | 65.5 % | 162 | 2 | 447 / 467, 95.7 % (confirmation 140 / 140) |
| plant-rules | equipment, alarms, plant rules | 26 | 221 | 16 / 5 | 90 % | 163 / 221 | 73.8 % | 58 | 1 | 174 / 220, 79.1 % (confirmation 11 / 11; 191 / 220 with T1's unconfirmed tests) |
| packaging-labels-and-line-completion | packaging and serialisation | 34 | 352 | 3 / 14 | 90 % | pending | | | | |
| serialisation-l3 | packaging and serialisation | 7 | 112 | - / 5 | 90 % | pending | | | | |
| genealogy-and-recall | genealogy and recall | 23 | 440 | 45 / 4 | 90 % | pending | | | | |
| controlled-substance-mode | controlled-substance mode | 34 | 311 | 5 / 3 | 90 % | pending | | | | |
| governance-change-control | governance, change control, DSC | 19 | 117 | 7 / 3 | 90 % | 84 / 117 (smoke run) | 71.8 % | 33 | not triaged | |
| governance-support-and-contract-giver | governance, change control, DSC | 21 | 228 | 12 / 4 | 90 % | pending | | | | |
| india-dsc | governance, change control, DSC | 19 | 127 | 2 / 4 | 90 % | 75 / 127 | 59.1 % | 52 | 0 | 104 / 127, 81.9 % (confirmation 29 / 29) |
| reporting-and-training | reporting and training mode | 14 | 149 | 3 / 3 | 90 % | pending | | | | |
| transfer-and-federation | inter-site transfer and federation | 49 | 393 | 30 / 7 | 90 % | pending | | | | |

Functions Phase 6 re-created in earlier groups (run alone with `--functions`, 202 mutants; the group keeps its
earlier score for its other functions):

| Group | Re-created functions | Mutants | Result |
|---|---|---|---|
| plant-equipment-and-areas | plant.fitness_problems, plant.record_calibration (recipe-core 0950) | 13 | pending |
| release-gate | recipe.grel_evaluate (recipe-core 0951) | 14 | pending |
| tablets-release-items | tab.grel_recon_serial (tablets 1231) | 2 | pending |
| read-authorisation | tab.record_read_problem (tablets 1276, 1290) | 11 | pending |
| connection-roles | sandbox.apply_connect_policy, sandbox.segregation_problems (kernel 1210) | 115 | pending |
| mbr-lifecycle | recipe.guard_critical_elements_risk_assessed (recipe-core 1050) | 6 | pending |
| after-release-suspension | recipe.genealogy_downstream_lots (recipe-core 1011) | 33 | pending |
| pqr-extract | recipe.pqr_run_query (recipe-core 1062) | 5 | pending |
| lots-and-lims | site.lot_available (site services 0980) | 3 | pending |

### Smoke run (preparation)

governance-change-control, the whole group, `--workers 3 --own-cluster` on 5433 with nothing else on the cluster:
117 mutants in 411 s wall (templates, the definition check and the baseline included), 8.8 s of worker time per
mutant on average (median 5.9 s, longest 21 s; a killed mutant stops at its first failing file, a survivor runs every
file of both projects). Score 71.8 % (84 / 117), 33 survivors in 11 functions, among them removed raises in
`platform.approve_change_record` (4), `platform.register_config_area` (11) and `platform.is_release_actor` (6). The
report (`report.json`) is the group's first run; the campaign triages it rather than running the group again. A
`--resume` of the same report with 7 results removed ran only those 7 and gave the same summary (60 s).

## Part 1, Stryker: the Phase 6 TypeScript

`stryker.phase6.config.mjs` holds the features (`node stryker.phase6.config.mjs --list`): the files each mutates, its
90 % zone (guards, signatures, seals, stale-mirror refusal, flow validation, release and serial gating) and its 80 %
zone (reads for a screen, guidance text, simulators, worker wiring and retry timing), and its test files.
`vitest.stryker-phase6.config.ts` runs only those tests with their set-up (none, the kernel template, or the server
templates). `node stryker.phase6.config.mjs --summary` scores each zone from the feature's JSON report.

A feature's tests must be in the package of its files: Stryker's sandbox links each package's `node_modules`, so a
workspace import (`@ebmr/kernel`, `@ebmr/integration-sdk`) from another package loads the unmutated original. The
kernel's Phase 6 modules are therefore their own feature with the kernel's tests, and the SDK's adapter code is scored
by the SDK's own tests only (its behaviour through the server is covered by the SQL groups and the server features).

| Feature | Kind | 90 % zone | 80 % zone | First run (90 % / 80 %) | After |
|---|---|---|---|---|---|
| sdk-adapter | unit | envelope, errors, mirror, reconciliation, systems/* | contract | 23.3 % overall (smoke run) | |
| sdk-equipment-data | unit | adapter/equipment-data, serialisation/wire | process/wire | pending | |
| gateway-opcua | unit | drivers/opcua, opcua-feed | drivers/opcua-node, process-uplink, config, gateway | pending | |
| server-integrations | server | adapters/framework, adapters/erp-wms/*, adapters/qms | the other adapters, start, reads, guidance | pending | |
| kernel-config-and-dsc | db | config/change-control, esig/dsc | esig/dsc-test-ca | pending | |
| server-alarms | server | alarms/index | reads, guidance | pending | |
| server-plant-rules | server | plant-rules/index | reads, guidance | pending | |
| server-equipment-data | server | - | equipment-data/index, reads | pending | |
| server-capa | server | capa/index, signables | reads, guidance | pending | |
| server-config-change | server | config-change/index, signables | reads, guidance | pending | |
| server-controlled | server | controlled/index | reads | pending | |
| server-dashboards-and-training | server | training/index | training/exercises, dashboards/* | pending | |
| server-designer-hazard | server | designer/hazard | - | pending | |
| server-genealogy | server | genealogy/index, signables | reads, guidance | pending | |
| server-governance | server | governance/index, esig/dsc | - | pending | |
| server-labels | server | labels/index | - | pending | |
| server-quality-receipt | server | quality/receipt | quality/lims | pending | |
| server-serialisation | server | serialisation/index | - | 80.2 % / - (smoke run) | |
| server-transfers | server | transfers/federation, index, keys, signables | reads, guidance | pending | |
| simulators | unit | - | opcua, erp, system-feed, serialisation servers and models | pending | |

Left out (Phase 6 touched a few lines of a file of an earlier phase; the file's own mutation is deployment's): the
server's `cli/*`, `config.ts`, `platform/http/*`, `devices/listener.ts`, `execution/seed-gmp.ts`,
`release/signables.ts`, `pqr/reads.ts`, `notifications/index.ts`, `designer/index.ts`, `esig/{index,content,guidance}.ts`;
kernel `db/command.ts`; recipe-core `flow/*`, `validator/rules-content.ts`; the simulators' `*/main.ts` entry points.

### Smoke run (preparation)

- `sdk-adapter` (unit, concurrency 4): 626 mutants in 21 s. Score 23.3 % (146 killed, 415 survived, 65 without
  coverage). With the base setting `ignoreStatic: true` 485 of them were skipped: the system contracts and the mirror
  classes are module-level zod schemas. The SDK's own tests (9) check little of the schemas; their behaviour is tested
  through the database (`platform.accept_inbound` validates the same envelope) and the server's adapter tests, which
  Stryker cannot connect to the SDK's mutants (above). Priority 2 work for the campaign: SDK-level tests of the
  envelope, mirror and system payload schemas.
- `server-serialisation` (server, concurrency 2): 159 mutants (38 static, skipped) in 330 s, of which about 30 s for
  the dry run with the server templates. Score 80.2 % (97 killed, 24 without coverage) against 90 %.

## Part 1, Stryker: triage (T7)

Triage of the first-run survivors and NoCoverage mutants in the 90 % zone of each feature, under the owner's rule of
17 October (important issues only; no re-testing of minor ones; no Stryker re-run). The question for each: is the
TypeScript the only place the rule is enforced? Where a database function or trigger enforces the same refusal
(decision 0008 section 2), the survivor is defence in depth and recorded in one line. First-run scores are from the
features' JSON reports (`node stryker.phase6.config.mjs --summary`), high-risk zone / other zone. Decisions D-P6j-T7-1
and D-P6j-T7-2 (phase-6 plan, slice 6j).

**Result: no Priority 1 defect.** Two rules were found enforced only in the TypeScript and untested; both now have
killing tests in their package's own test folder, each proved against the original (passes) and against the
hand-applied mutants (fails), then reverted. One more cluster is killed by an existing test outside the feature's test
list (D-P6j-T7-2). No confirmation run (owner, 17 October: optional; decision 0019 allows one, not used).

Common to every server feature (one line each, no test):
- `requireSession()` removed in a read handler: defence in depth; `bindRoutes` refuses a SESSION route without a live
  session before the handler runs (D-P6j-T7-1).
- Signable handlers' `previewContent` / `dryRun` not-found guards, `prepareForChallenge` (its result is not used: the
  kernel's `esig.create_challenge` computes and checks the hash) and `apply` return objects: the ceremony and the
  definer the handler calls (`esig.sign`, the act's own SQL function) are the enforcement; display and response shape.
- Refusal texts, `notFound` messages, `?? null` / `?? ''` defaults of parameters the SQL function validates again,
  view mapping of reads (people's names, instants, optional fields): display.

### server-controlled: 61.6 % / 61.9 %

- No TypeScript-only rule. Dual custody (IN-53), the flag approval and the balance sign-off are enforced by
  `recipe.sign_controlled_custody`, `plant.approve_controlled_product` and `recipe.sign_controlled_checkpoint`; the 33
  survivors and 28 NoCoverage of `controlled/index.ts` are the signable handler's preview/dry-run guards and response
  objects, `requireSession()` and not-found messages (above). P3, DB-enforced / display.

### server-transfers: 64.2 % / 53.9 %

- **Killed (new test): the federation's https-only rule in production (DI-13), `transfers/federation.ts:108`, 3
  NoCoverage.** The database keeps a peer's base URL as http or https and does not know the environment, so this
  refusal exists only in `askPeer`. Test `apps/tablets-server/test/transfers/federation-https.test.ts`: `[DI-13] [DI-31]
  production refuses a peer registered with an http address before anything is sent, and the refusal is logged` and
  `[DI-13] production calls a peer registered with an https address, and development an http one` (askPeer with a
  stand-in database client and fetch). Hand-applied mutants: the condition `false`, `endsWith`, the negation removed:
  all fail the test.
- Seals: DB-enforced. `site.seal_transfer_package` refuses a seal that does not verify under the installation's current
  key (`platform.own_seal_valid`, kernel 1220); `recipe.answer_federated_genealogy` and `recipe.record_federated_excerpt`
  verify the other side's seals. So `currentKey()`'s `serverHoldsKey` check (index.ts:77), `keys.ts` (the Ed25519 type
  check, `rawPublicKeyOf`, the key file read) and the `'utf8'` encodings at keys.ts:26 (equivalent: Node reads an empty
  encoding as utf8) are P3. federation.ts `reasonOf`, the failure-detail texts and the excerpt-to-view mapping:
  display. index.ts:152 (the refusal code taken from the reason): message.

### server-governance: 28.2 % (high-risk zone only)

- **Killed (new test): the DSC trust anchor must be a self-signed certification-authority root (IN-10),
  `esig/dsc.ts:48`, 2 survivors and the 422 refusal's NoCoverage.** The database stores the anchor's DER and subject but
  does not parse X.509, so `subjectOf` is the only check. Test in
  `apps/tablets-server/test/governance/governance-routes.test.ts`: `[IN-10] a trust anchor is only a self-signed
  certification-authority root: a sub-CA, a signer's certificate or bytes that are no certificate are refused and
  nothing is stored`. Hand-applied mutants: the condition `false` and `||` to `&&`: both fail the test.
- Support grants (DI-08): `iam.request_support_grant`, `iam.approve_support_grant`, `iam.revoke_support_grant` enforce;
  the handler survivors are of the common kinds above. Contract giver (IN-30): `recipe.contract_giver_accesses`,
  `recipe.contract_giver_batches` and `recipe.read_contract_giver_batch` check the role, read-only use and the live access
  and log each read; the 212 NoCoverage of `governance/index.ts` are mostly the reviewer's batch views (no
  governance-folder test reads a batch through the route) and `decimalText`: display. DSC mode, meaning and enrolment
  routes (dsc.ts:37-111): reason codes and banner texts; `esig.set_policy`, `esig.set_dsc_meaning`, `esig.enrol_dsc_certificate`
  enforce. P3.

### server-config-change: 46.9 % / 80.0 %

- No TypeScript-only rule. The change-record requirement and the setting's validation are in
  `platform.set_setting` (through `kernelConfig.setPlatformSetting`) and `recipe.set_rbe_rule`. Note: the
  `setSetting` route body (`config-change/index.ts:82-86`) survives as a whole: no test in `test/config` calls the
  route; the kernel's own tests cover the function. P3 (route coverage, DB-enforced); the rest are `requireSession()`,
  the `state` filter of a list and not-found messages.

### server-labels: 43.8 %

- No TypeScript-only rule. Template approval, specimens, post-use inspection, line stops and the waiver are SQL
  functions (`recipe.declare_packaging_label`, `tab.record_*_specimen`, `tab.void_packaging_specimen`,
  `tab.record_post_use_inspection`, `tab.verify_post_use_inspection`, `tab.resolve_line_stop`,
  `tab.enable_reconciliation_waiver`); their routes are NoCoverage here (their behaviour is in the SQL group
  packaging-labels-and-line-completion). index.ts:116 (a label lot's material kind in a read) and the views: display.
  P3.

### server-quality-receipt: 62.2 % / 52.4 %

- No TypeScript-only rule. The receipt, approved-manufacturer and issue gates are SQL; `site.issue_gate_problem` at
  receipt.ts:82-84 is a read for the screen (the stale-mirror EBMR-INT-010 is caught to show it, the gate itself refuses
  in the database). The rest: view mapping. P3.

### sdk-adapter: 22.0 % / 41.9 %

- No TypeScript-only rule. `platform.accept_inbound` (kernel 1180) validates the envelope again: each field's pattern,
  the payload size (1 MiB), the idempotency key and hash, the sequence; the reconciliation report is validated by the
  database too (kernel 1180, the report's period, counts and checksum). Mirror freshness and the stale refusal are
  `platform.mirror_freshness` / `platform.mirror_fresh_or_raise`. So the survivors in `envelope.ts`, `mirror.ts`,
  `reconciliation.ts` and the system contracts `systems/*.ts` (zod schema shapes: regex anchors, enum members, min/max)
  are P3, schema shape re-validated by the database and the system's apply functions. `errors.ts`: the retry class of an
  error (TRANSPORT SQLSTATEs) is retry timing; a refusal retried is de-duplicated by the idempotency key. P3.

### sdk-equipment-data: 57.7 % / 53.9 %

- No signature is verified here (the gateway's readings carry none in these contracts; the scale reading's signature
  is in `scale/reading.ts`, not part of this campaign). The equipment-data rules are recomputed by the database
  (recipe-core 0960): `plant.raw_states_value` (the raw text states the shown value exactly, DI-32), the chunk hash
  (`plant.series_chunk_hash`), the sample order and quality. So `canonicalDecimal`, `shownValueProblem`, the regexes and
  the series-chunk refinements are P3, schema shape re-validated. `serialisation/wire.ts`: `poolReport`,
  `canonicalReportText` and `reportReconciles` are used only by the L3 simulator and tests (the serial release gate is
  in the database); the rest are path builders and schema shapes. P3, simulator / schema shape.

### server-genealogy: 29.4 % / 61.0 %

- **Killed by an existing test outside the feature's test list (D-P6j-T7-2): `recordRemote` and the outbound-transfer
  asking of a mock recall (`genealogy/index.ts:121-137`).** The feature runs only `test/genealogy`; the federation part
  of a mock recall is tested in `test/transfers/transfer-routes.test.ts` (`[IN-29] a mock recall with one site down is
  marked incomplete, ...`). Hand-applied `recordRemote` as a no-op: that file fails (2 of 6 tests). No new test.
- The rest: `requireSession()`, `refreshFederation` (NoCoverage here, covered by the same [IN-29] test), the default
  as-of and authority reference parameters (`recipe.run_mock_recall` validates), views. P3.

### Stryker triage, second pass (T9): kernel-config-and-dsc, server-alarms, server-capa, server-designer-hazard

Same method as T7 (the TypeScript matters only where it alone enforces a Priority 1 rule; no Stryker re-run). **No P1
defect.** One rule cluster was enforced only in the TypeScript and untested: the X.509 checks of the India DSC, which
the database cannot make. Killing tests were proved against the original (pass) and against the hand-applied mutants
(each fails), then reverted.

#### kernel-config-and-dsc: 68.9 % / 75.8 %

- **Killed (new tests): `esig/dsc.ts` `verifyDsc`, lines 88 (`at < validFrom` removed), 89 (`i > 0 && !c.ca` false) and
  93 (`leaf.ca` false).** The database records what the server verified (`esig.record_dsc_signature`,
  `esig.enrol_dsc_certificate`) and re-checks only the chain's ends (the last certificate is the live anchor, the first
  is the enrolled signer, 2 to 6 entries); a certificate not yet valid, an issuer that is not a CA and a signer
  certificate that is a CA are seen only here. Tests in `packages/kernel/test/esig/dsc.test.ts`, "India DSC chain
  verification in the server (IN-10)": `[IN-10] a well-formed chain verifies; a signer certificate not yet valid at the
  time of signing is refused`, `[IN-10] a signer certificate that is itself a certification authority is refused`,
  `[IN-10] an issuer in the chain that is not a certification authority is refused, even when its key signed the next
  certificate`. The last uses an end-entity issuer without a key-usage extension, so that only the CA check can refuse
  it; the test CA's `issueTestCertificate` gained the option `keyUsage: false` (test material, `dsc-test-ca.ts`).
- P3 (DB-enforced): line 81 (chain length; `chain_der` 2 to 6 and the `< 2` refusal), 85 (the chain's last certificate is
  the anchor: `esig.record_dsc_signature` and `esig.enrol_dsc_certificate` compare its SHA-256, same EBMR-ESIG-085), 86
  (the anchor self-signed: the anchor is QA's configured trust root under change control).
- P3: line 88's `<=` / `>=` (millisecond boundaries), 82 and 95 (labels; `'utf8'` is Node's default, equivalent), 59-60,
  104-109, 122-123, 142-143 (the requirement read's defaults and the verified fields' formatting, which the database
  stores as given and compares by SHA-256 of the DER). `config/change-control.ts` NoCoverage (`listConfigAreas` and the
  diff read's mapping): reads for a screen; the change control itself is the database's (governance-change-control
  above). `dsc-test-ca.ts` (other zone): the test CA's DER encoding, test material.

#### server-alarms: 68.8 % / 60.5 %

- No TypeScript-only rule. `alarms/index.ts`: `requireSession()` (D-P6j-T7-1) and `body.deviationRef ?? null` (the SQL
  function validates the argument). `alarms/reads.ts` (other zone): view mapping. P3.

#### server-capa: 49.2 % / 62.7 %

- No TypeScript-only rule. `capa/index.ts` NoCoverage: the link, schedule and cancel handlers only pass their arguments
  to `site.link_capa_deviation`, `site.link_capa_master_version`, `site.schedule_capa_effectiveness_check` and
  `site.cancel_capa`, which check permission, state and inputs. Line 64-65 (an effectiveness check of another CAPA,
  EBMR-CAPA-009): `site.record_capa_effectiveness` takes only the check id and records on that check's own CAPA; the
  refusal keeps the URL consistent (P3). `signables.ts:23` and `reads.ts`: response shape and view mapping. P3.

#### server-designer-hazard: 72.8 %

- No TypeScript-only Priority 1 rule. `designer/hazard.ts` is an authoring aid: the containment it proposes (only rooms
  and lines dedicated and contained for the product's classes) is enforced at issue by the database (recipe-core 0891,
  whatever the MBR says), and the protective-equipment and decontamination operations it inserts are reviewed in the
  MBR's QA approval like any other content. Survivors (the class read's defaults, the node walk, the insertion point,
  the reference-document lookup, messages) are P3. Owner note: no database rule requires those two operations in a
  hazardous product's MBR; they rest on the designer and on the QA approval (IN-27 containment itself is enforced).

### Stryker triage, third pass (T12): server-integrations and gateway-opcua (unmeasured)

Both features stopped in decision 0019's one-hour box even on their high-risk files (server-integrations-highrisk 305 of
631 mutants, no report; gateway-opcua 21 %, an incremental file only). Residuals under decision 0019; no re-run (owner,
17 October). The owner asked whether the unmeasured code hides a Priority 1 issue, so each high-risk file's P1
decisions were listed and checked by hand (D-P6j-T12-1): (a) the database enforces it too, one line; (b) only the
TypeScript does: the mutation applied by hand in the worktree, the narrowest test file run, then reverted. Mutant labels
below are those of the hand check.

**Verdict: no Priority 1 defect among the mutated decisions; there was a Priority 1 test gap, now closed. Writing its tests
found one high DI-31 defect next to them (M6-D2), fixed.** 30 mutants were
hand-applied against the features' whole test lists: 4 killed, 3 survivors are database-enforced (a), and 23 survivors of
TypeScript-only rules (17 gateway, 6 server) had no test. Nine new tests in the packages' own test files kill those 23
and 6 further variants applied afterwards; each passes on the original code. One P2 defect fixed (OPC UA ids cut before
keying, below); one high defect fixed on the lead's decision (M6-D2, DI-31, below) and two owner observations.

#### gateway-opcua (`drivers/opcua.ts`, `opcua-feed.ts`)

(a), defence in depth (one line each):
- Endpoint identity (DI-20): `certificateProblem` and the mismatch path (no subscription, session reported once): recipe-core
  0961 judges every reported session against the registry (CERTIFICATE_CHANGED, INSECURE, URL_CHANGED, RELOCATED,
  UNIT_NOT_SERVED) and `plant.opcua_data_guard` refuses series, events and alarms of a unit without a VALID session; process
  readings: `tab.ingest_opcua_readings` (tablets 1210, EBMR-DEV-174/175). The existing `[DI-20]` tests also kill the
  thumbprint compare and the once-per-certificate report.
- Series integrity (DI-32): the chunk hash, increasing source times in a chunk, value equal to raw, no value for a BAD sample
  (`plant.receive_series_chunk`, recipe-core 0960); a chunk number or source-time span recorded twice (EBMR-EQD-004/005).
- Duplicates (DI-31): an exact re-delivery is suppressed by the feed (killed by the existing test) and refused as DUPLICATE by
  `platform.accept_inbound_detail`; the same key with other content is published with FEED_DUPLICATE_KEY and refused by the
  database with an alarm. Sequence gaps and late messages: SEQUENCE_GAP / OUT_OF_ORDER alarms (kernel 1180).
- The constructor's enrolled-units check: UNIT_NOT_SERVED (0961). A doubtful setpoint read-back shown as GOOD: EBMR-DEV-173
  (1210); a new test kills it too (G-m).

(b), TypeScript only. Each survived the whole gateway test folder (13 files) and is killed by new tests in `apps/site-gateway/test/opcua-driver.test.ts`
(describe "what only the gateway can check (T12)"):
- `onChange` line 412 (G-g1, G-g2): a malformed data change, a setpoint value of a tag without a setpoint, a tag of another
  kind of unit alarm MALFORMED and are never chunked (removing the guard crashed the callback: a silent loss).
  `[DI-31] a malformed data change, a setpoint value of a tag without a setpoint and a tag of another kind of unit ...`
- `onAlarm` 458, 462 and `onEvent` 471 (G-h, G-i, G-i2, G-i3, G-j): a malformed alarm or event alarms MALFORMED; an alarm
  naming a unit the endpoint does not serve, or a room, is refused WRONG_UNIT. The database cannot make this check: one feed
  carries every endpoint of the gateway, so an alarm of endpoint A naming a unit of endpoint B would pass 0961's guard (DI-20).
  `[DI-31][DI-20] a malformed alarm or event alarms MALFORMED; an alarm naming a unit this endpoint does not serve, or a room, ...`
- `readUnit` 519, 526, 532, 541 (G-k, G-n, G-m, G-l, G-l2, G-l3): the process view refuses (OFFLINE) once the session is
  lost instead of serving the last values; a BAD sample shows no value; a doubtful setpoint is not shown; the active alarms of
  the unit's tags reach the process path (its ALARM readings, the G-06 ALARM entries and DI-49 acknowledgements stand on them).
  `[DI-31][DI-32] the process view: refused while the session is lost ...`
- `OpcuaFeed.open` 92 (G-a, G-a2): a torn last line is dropped; a damaged earlier line refuses to open (`true` silently
  truncated the journal and would have re-used its sequence numbers). `[DI-31] the feed journal at restart: ...`
- `publish` 143, 151-153 and `healthy` 127 (G-b, G-c, G-d, G-e): a journal write that fails alarms once, stops the feed (the
  head stays) and turns the heartbeat to 503. `[DI-31] a journal that cannot be written alarms once and stops the feed: ...`
- `page` 174-176 (G-f1, G-f2, G-f3): pages in order, without a gap or a repeat (`start - n` served empty pages for ever: the
  OPCUA adapter keeps no mirror class, so nothing would have aged). `[DI-31] the feed protocol pages the journal in order, ...`
- **P2 defect fixed (TypeScript only, no migration):** `sink()` cut `alarm/<occurrenceId>/<transition>` and `event/<eventId>`
  to 128 characters before the idempotency key was derived. The contract allows 128-character ids, so the RAISED and CLEARED
  transitions of a long occurrence id, or two events whose ids differ only at the end, shared a key: the second was published
  with FEED_DUPLICATE_KEY and refused by the database (alarmed, so not P1). The key now covers the whole id; only the
  envelope's sourceRecordId is cut, as `publish` did already; keys of shorter ids are unchanged. `[DI-31] the transitions of an
  alarm and distinct events with the longest ids the contract allows are each published, never taken for one another`
  (failed before the fix).
- P3, no test: alarm and message texts, the HTTP 400 limits of `serve` beyond those tested, `reconciliation`'s half-open
  bounds (a shift shows as a RECONCILIATION_MISMATCH, never hides a loss), the recipe-version read (killed by the existing
  test), the write-back's re-read (a failed parse keeps the last setpoint, which the process path compares with the target).
- Not re-reported: the feed is unauthenticated (residual 6jc-R9). Observation (design, not a mutation finding): samples of a
  chunk still open when the gateway process dies are not journalled (up to `chunkMaxSamples` or 60 s per tag); the gap stays
  visible in source time and the G-06 values travel journal-first as process readings, but no alarm names it. For the owner.

#### server-integrations (`adapters/framework.ts`, `adapters/erp-wms/*.ts`, `adapters/qms/index.ts`)

(a), defence in depth (one line each):
- Adapter identity and access: `openAdapterActor` goes through the kernel's SERVICE_KEY authentication bound to the
  terminal's key (kernel 1180), INTERFACE.WRITE and `platform.authorize('interface.write', ...)` in every receiving command;
  the legal name is the database's (DI-14).
- Cursor, gaps and order (DI-31): line 350 (the cursor), 354 (caught up): `platform.accept_inbound_detail` raises SEQUENCE_GAP
  and OUT_OF_ORDER; `platform.record_mirror_sync` refuses unless the adapter holds every number up to the head (kernel 1182,
  EBMR-INT-019/024).
- Classification, lines 431-432 and 440-442 (S3, S4, S5, survived): a TRANSPORT failure or an unclassified one recorded as a
  refusal is refused by `platform.record_inbound_refusal` (EBMR-INT-014, no such class), so the worker retries and the cursor
  stays; a refusal that cannot be recorded leaves a missing number (INT-024 / SEQUENCE_GAP).
- The payload's contract (line 413-419): each receiving command validates its payload (e.g. `plant.receive_series_chunk`,
  `site.erp_wms_receive`); unknown types EBMR-INT-004; `feedAdapterDefinition` without a command fails closed.
- QMS at release (`qmsReleaseFetch`, S9): `site.qms_release_problem` refuses a release without a fetch in the same
  transaction (EBMR-QMS-013), a stale one (014), an open deviation (015); a malformed answer EBMR-QMS-012 (site services 0925,
  recipe-core 0951).
- WMS move questions (`moves.ts`, S8 killed by the existing `[PR-46]` test): the answer is `site.wms_location_question`'s; a
  move made anyway raises the alarm and the exception (D-P6a-7).

(b), TypeScript only:
- Heartbeat gating of the mirror sync, lines 131 and 358 (S1, S2): killed by the existing stale-mirror tests (`[DI-31] stale
  mirror: ...` ERP/WMS, EMS, `[PR-42]` L3).
- Payload hash, line 410 (S6), and the refused-keys short-cut, line 407 (S10): survived. The database stores the payload and
  its stated hash as given, so this is the one check that a value was not altered in transit. New test in
  `apps/tablets-server/test/equipment-data/opcua-adapter.test.ts`: `[DI-31] a message whose payload is not the one its hash
  states is refused as malformed with an alarm and lands nowhere; a changed message the source then sends under the same key
  is not taken for the refused one`.
- ERP outbound (`outbound.ts`, S7a, S7a2, S7b, S7c, S7d): survived. The database lists pending messages in order but does not
  hold a lot's later message back, and records whatever reference it is given. New test in
  `apps/tablets-server/test/integrations/erp-wms/contract.test.ts`: `[DI-31] outbound: the messages of a lot keep their order
  while one waits; only a 200 answer naming the ERP's reference acknowledges a message`.
- P3, no test: refusal texts, counters of the cycle report, the `exchange` and page-shape checks (each failure ends as a
  TransportError, the cursor stays), `qmsLinkFromEnv` defaults.
- **Defect M6-D2 (high, DI-31; fixed in the worker, no migration; D-P6j-T12-3):** data loss on an interface, alarmed only at
  the first refusal. The worker remembered a refused message by the hash it *stated*. After a refusal because the payload
  did not match its hash, the intact message under the same key and hash was answered DUPLICATE in memory and never reached
  the database; the cursor moved on, reconciliation by (key, hash) matched the refusal, and only the first MALFORMED alarm
  was left. Found while writing the S6 test. Fix (`framework.ts`): the memory holds the SHA-256 of the whole item as
  received, checked before the envelope; only the very same item repeated is handled, anything else is checked and
  received anew (a tampered copy under a new sequence number is refused again and recorded). The database does not block
  the intact copy: `platform.accept_inbound_detail` (kernel 1180) looks for the key among accepted messages only, so a
  refusal does not reserve the key, and "same key, other content" stays EBMR-INT-005 for accepted messages (unchanged).
  Tests in `opcua-adapter.test.ts`: `[DI-31] M6-D2: after a message refused because its payload is not the one its hash
  states, the intact message under the same key lands, exactly once; the tampered payload sent again is refused again`
  (failed before the fix) and `[DI-31] M6-D2: a page that repeats a refused item unchanged is handled once; the refusal is
  not recorded twice` (keeps the de-duplication); both hand-mutated against the fix (the short-cut removed, the memory on
  the stated hash): each fails.
- **Owner observation O-T12-1:** `AdapterWorker.reconcile` (count and checksum per period, DI-31 "no silent loss") has no
  caller in the server: nothing submits a reconciliation on a period. Gaps, late messages and the mirror's caught-up check
  are enforced (above), so a loss inside the sequence is alarmed; a source that stops publishing its last messages is seen
  only on the health page (head ahead of cursor) for feeds without a mirror class (OPCUA, EMS, LIMS). Whether a scheduled
  reconciliation belongs to Phase 6 or to deployment is the owner's call.

### Not triaged

- `server-integrations-highrisk` (no report): checked by hand in T12 above. `kernel-config-and-dsc` (rc=1 at T7's pass) was re-run
  and is triaged above (T9).
- `gateway-opcua`: stopped at 21 % (rc=124), only an incremental file; no final report. Checked by hand in T12 above.
- Features outside this assignment (server-plant-rules, server-equipment-data, server-dashboards-and-training,
  server-serialisation, simulators) are not triaged here.

## Part 2: the Phase 4 leftovers

| Item | What runs | Result |
|---|---|---|
| Scope A kill confirmation (232) | release-gate, release-gate-market-items, manufacturer-release, tablets-release-items with `--only` on the survivors of the Phase 4 run (ids from that run's report; see the note on renumbering below) | pending |
| Scope B kill confirmation (118) | the six scope B groups with `--only` on the unconfirmed survivors | pending |
| us-disposition | first full run (146 mutants) | pending |
| qp-certification | first full run | pending |
| market-changes | first full run | pending |
| Stryker survivor triage | server release, records, India, archive and PQR features | triaged (T13, below): no Priority 1 rule left unenforced; 3 TypeScript-only clusters now tested; defect M6-D3 fixed |
| Whole SQL re-run | every group of `targets.ts`, under the decision 0009 organisation | pending |

Note on renumbering: a mutant id is `<function>#<n>`, numbered in the function's current definition. Phase 4's
`recipe.grel_core_items` survivors were numbered in recipe-core 0783 and the function is now 0932's; Phase 6 re-created
`recipe.grel_evaluate`. Before an `--only` confirmation, each survivor id is matched to the current mutant by its
line text, operator, original and replacement, not by number.

Equivalents to re-check before the whole re-run: `pnpm mutation:sql --audit-equivalents` lists 56 of the 248 entries
of `equivalent.json` that no longer fit their mutant (the place they cite is not the mutant's migration and line, or the
mutant number no longer exists), all from Phase 2 to 4 re-creations (recipe-core 0471, 0501, 0502, 0844, 0932; tablets
0702, 0715). A run applies only fitting entries and runs the others as ordinary mutants (D-P6j-M-4); each is moved to
its current number with its place updated, or dropped, by the part 2 triage.

### equipment-data-and-alarms (triage T1)

- **First run** (stream p6-1): 307 / 469 detected, **65.5 %**, 162 survivors (27 GUARD_REMOVED, 70 LOGICAL, 34
  RELATIONAL, 6 NOT_REMOVED, 1 BOOLEAN at the first read; the rest in the tablets 1218 bridges at the end of the run).
- **New tests:** `packages/recipe-core/test/mutation/equipment-data-and-alarms.test.ts` (18 cases) and
  `apps/tablets-server/test/mutation/equipment-data-and-alarms.test.ts` (4): each payload form (alarm, equipment event,
  series chunk and sample, endpoint session, device original, OPC UA native record) refused one malformed
  field at a time, with the boundary length taken; the binding windows of `plant.batch_context_at` read at the exact
  microseconds they open and close; the enrolment, retirement and step-binding refusals; the bridged ALARM_CLEARED;
  the OPC UA data guard on owner-level writes; tablets 1210's DEV-121/170/172 refusals, which the listener's wire
  validator otherwise shields. 140 survivors are aimed at (the `--only` list of the confirmation run).
- **Equivalent:** `plant.acknowledge_alarm#8` (EBMR-ALM-010 is unreachable: a SERVICE or INTEGRATION account is refused
  the ACKNOWLEDGE permission first), `plant.alarm_problem#10` (`having count(*) >= 0` returns NULL as the original does).
- **Real defects (P1):** none. The 27 removed guards were reachable refusals the suite did not exercise at database
  level, or refusals a later layer repeats with the same code (D-P6j-T1-1); none let a wrong GMP write through.
- **Residuals:**
  - `plant.source_time_or_raise#4` (0960:442, `>` to `>=`): P3, a tolerance against `clock_timestamp()` at microsecond
    resolution; the exact instant cannot be hit deterministically.
  - `plant.acknowledge_alarm#5` (0976:28): P2, the per-batch scope loop runs after an unscoped ALARM.ACKNOWLEDGE check
    that a product-scoped person already fails (owner item O-T1-1), so no test person reaches the loop with a scope it
    would refuse.
  - `plant.acknowledge_alarm#28` (0976:47): P2, needs a GMP (non-test-run) batch with a linked deviation-lite record
    (`site.deviation_ref_problem` refuses test runs); not done in the time box.
  - `plant.bind_step_equipment#14` (0960:496): P2, needs the same step bound to the same unit in an earlier use by
    another batch; time box.
  - `tab.bridge_process_alarm_ack#2, #6`, `tab.bridge_device_alarm#1-#5`, `tab.bridge_step_device#3, #5-#12` (tablets
    1218): P2, the last mutants of the run, reached after the time box; they need the gateway alarm and G-06
    acknowledgment world of `alarms/alarm-bridge.test.ts`.
- **Confirmation run** (`--only` on the 140 aimed at, 2034 s): **140 / 140 detected**. The group stands at 447 / 467
  valid (469 less 2 equivalent), **95.7 %**, with the 20 residuals below.
- **Owner item O-T1-1:** `plant.acknowledge_alarm` (recipe-core 0976) checks ALARM.ACKNOWLEDGE unscoped before the
  per-batch loop, so a person whose OPERATOR grant is scoped to one product is refused (EBMR-IAM-040 "in scope {}") even
  for an alarm bound only to a batch of that product. The Q-6b-1 test in `plant-rules/room-rules.test.ts` passes on that
  first check, not on the per-batch one. Stricter, never weaker; whether product-scoped people should acknowledge their
  own product's alarms is the owner's call.

### plant-rules (triage T1, then T5)

- **First run** (stream p6-3, finished): 163 detected / 221 valid, **73.8 %** (58 survivors).
- Scope (owner, 17 October): only survivors that could let a room or area start, or a step be signed, when it should
  be refused (PR-15, PR-22, PR-25, PR-27, PR-29, PR-35, DI-49) or that touch a release or review gate were chased.
- **Kill tests, T1:** `packages/kernel/test/mutation/plant-rules.test.ts` (an area authorisation read at the microseconds
  it is recorded, valid from, valid to and withdrawn: `iam.person_area_authorised#5, #7, #10, #13`) and
  `packages/site-services/test/mutation/plant-rules.test.ts` (a reagent lot refused one malformed field at a time, an
  expiry equal to the preparation, withdrawal of an unknown lot or without a reason, the lot read at the microseconds it
  is recorded, expires and is withdrawn: `site.record_reagent_lot#1, #5, #14, #17, #20, #23, #30`,
  `site.withdraw_reagent_lot#2, #6`, `site.reagent_lot_problem#2, #3, #5, #6`). Not re-run in the confirmation run
  (D-P6j-T5-3).
- **Kill tests, T5:** `packages/recipe-core/test/mutation/plant-rules.test.ts` (clean hold, beta-lactam predicate, step
  alarm), a reagent-use test in `packages/site-services/test/mutation/plant-rules.test.ts`, and one QA-review test in
  `packages/recipe-core/test/review/review.test.ts` (D-P6j-T5-1).
- **Confirmation run** (`--only` on the 11 survivors the T5 tests aim at): **11 / 11 killed** (100 %).
- **After triage:** 174 killed by confirmed runs, 1 equivalent: **79.1 %** (174 / 220); with T1's 17 kill tests (not confirmed by a harness run, D-P6j-T5-3) 191 / 220, 86.8 %. Below the 90 % target; the rest is recorded below or residual within the owner's scope.
- **Defects (P1):** none. Every room-start, signature or gate survivor was an untested input; the code was right.

Survivors, one line each (T5):
- P2 killed (clean hold, PR-25): `plant.room_start_problem#13` (a room with a clean hold that was never cleaned is
  refused), `#8, #10, #11` (another batch's occupancy, of this room or anywhere, does not lend its start to this batch,
  so an expired hold still refuses it).
- P2 killed (penicillin, PR-27): `plant.batch_beta_lactam#7, #8` (the MBR's betaLactam predicate alone makes the batch
  beta-lactam and its start at a non-penicillin site is refused; a predicate of false does not).
- P2 killed (DI-49): `plant.step_rules_problem#11` (an alarm bound to the step blocks its signature when the command
  names a room without alarms; the mutant let the room query overwrite the step alarm with nothing).
- P2 killed (PR-29): `plant.record_reagent_use#13` (the use is recorded against the lot used, not another in store).
- P2 killed (QA review gate, PR-49, PR-52): `recipe.review_gate_problems#18, #20, #22` (an exception whose deviation
  was cancelled is not covered by a later escalation of another exception to a linked deviation).
- Equivalent (`tools/sql-mutation/equivalent.json`): `plant.step_rules_problem#22` (`having count(*) >= 0`: an empty
  group's aggregate row concatenates to NULL, the same as no row).
- Recorded (a table check refuses the same input; only the message differs): `plant.set_area_rule#2, #3, #5, #6, #8`
  (not null and `clean_hold > 0` on plant.area_rule), `plant.define_area_adjacency#5`, `plant.set_facility_rule#1`,
  `plant.classify_beta_lactam#3, #4`.
- Recorded (lock only, the FOR UPDATE flag of plant.area_by_code): `plant.set_area_rule#1`, `plant.record_spill#11`,
  `plant.define_area_adjacency#1, #2`.
- Recorded (numbering of classification versions): `plant.classify_beta_lactam#9, #10, #11`.
- Recorded (a later layer refuses): `plant.record_spill#4` (an unknown batch fails the foreign key),
  `plant.record_spill#8`, `plant.record_reagent_use#3` (an integration identity holds neither LOGBOOK.ENTRY nor
  STEP.EXECUTE, EBMR-IAM-040 in `room-rules.test.ts` and `materials.test.ts`; a blank purpose fails the table check).
- Recorded (stricter only): `plant.step_rules_check#2, #5` (a refused command row is checked too and raises instead
  of being recorded as refused; nothing is let through).
- Recorded (clock microsecond boundaries): `plant.room_start_problem#4, #12, #14, #16`,
  `recipe.review_gate_problems#23`, `site.record_reagent_lot#34` (T1).
- Recorded (display): `recipe.review_gate_problems#27` (an unknown review act; every gate passes a constant act).
- Residual (P2, not chased): `recipe.review_gate_problems#11` (0974:155, the abort branch reads other batches' output
  containers: an aborted batch whose own container is still usable would pass production approval; the original is
  right, and a test needs a closed, usable container of an aborted batch, L-20).

### india-dsc (triage T5)

- **First run** (stream p6-3, finished): 75 detected / 127 valid, **59.1 %** (52 survivors).
- Scope: a DSC that would verify when it should not, or bind to the wrong signer, certificate, anchor or record, and the
  e-signature policy limits. The server verifies a DSC before the database stores it; the database's own checks were
  untested because every test went through the server. The kill tests call the database functions straight
  (D-P6j-T5-1).
- **Kill tests:** `packages/kernel/test/mutation/india-dsc.test.ts` (IN-10, DI-38, DI-09).
- **Confirmation run** (`--only` on the 29 survivors the tests aim at): **29 / 29 killed** (100 %).
- **After triage:** 104 killed, 0 equivalent: **81.9 %** (104 / 127). Below the 90 % target; the other 23 are recorded below (later layer, harmless, stricter, race or display).
- **Defects (P1):** none.

Survivors, one line each:
- P2 killed (enrolling account): `esig.enrol_dsc_certificate#4, #6, #9, #10, #11` (a SERVICE account and a break-glass
  account inside an open window are refused; a generic account is refused earlier by the actor context, EBMR-IAM-106).
- P2 killed (chain and leaf): `esig.enrol_dsc_certificate#25, #27` (a chain of another CA, and the anchor alone, are
  refused), `#31` (a claimed signer certificate that is not the chain's first); `esig.record_dsc_signature#24` (a
  signing DSC claiming the signer's enrolled certificate while its chain carries another certificate).
- P2 killed (one certificate, one person): `esig.enrol_dsc_certificate#39` (a certificate live for one person is not
  enrolled for another while other enrolments have ended), `#45, #47, #48` (a new enrolment ends the person's previous
  one under the same anchor).
- P2 killed (anchor): `esig.dsc_live_anchor#4` (after a new anchor is registered, a chain to the retired one is refused).
- P2 killed (policy limits; `esig.set_policy` as kernel 1203 re-creates it, D-P6j-T5-2): `#3, #7, #9, #13, #16, #18,
  #19, #20, #22, #23, #27, #28, #31, #34, #35` (an unknown key, a blank reason or change reference, not a whole number,
  below or above the limits, the limits themselves accepted, not true or false, not an allowed value).
- Recorded (a later check or a table constraint refuses the same input): `esig.enrol_dsc_certificate#15, #18, #21`,
  `esig.record_dsc_signature#11, #14`, `esig.register_dsc_anchor#5, #8, #9, #10, #11`, `esig.set_dsc_meaning#6, #7`,
  `esig.end_dsc_enrolment#7`, `esig.dsc_enrolment_input#2, #5` (a read; the enrolment itself refuses).
- Recorded (harmless): `esig.set_dsc_meaning#2, #3` (a setting for an unknown meaning is stored; no signature carries
  one); `esig.record_dsc_signature#8` (a DSC kept on a signature whose meaning does not need one now: stronger, not
  weaker).
- Recorded (stricter only): `esig.record_dsc_signature#17`, `esig.enrol_dsc_certificate#24` (a two-certificate chain,
  a leaf issued by the root, is refused by the mutant; the test CA always has a sub-CA).
- Recorded (race only): `esig.enrol_dsc_certificate#8` (the actor context, kernel 0190, refuses an account that is not
  ACTIVE or is generic at the command's start; only a suspension committed between that and this statement differs).
- Recorded (display): `esig.dsc_requirement#1` (an unknown challenge shows required), `esig.dsc_live_anchor#2` (differs
  only for a kind with no anchor, the mode OFF, where every caller has already returned; it shows only in the `live`
  flag of `esig.dsc_enrolments_of` while the option is off).

## Survivors

pending

### inbound-adapters-and-mirrors (triage T3)

- First run (stream p6-5): 198 detected / 299 valid, **66.2 %** (101 survivors, 11 invalid).
- Kill tests: `packages/kernel/test/mutation/inbound-adapters-and-mirrors.test.ts` (19 tests, DI-20, DI-31, INV-26).
- Confirmation run (`--only` on the 97 survivors the tests aim at): **96 / 97 killed**. The one left,
  `iam.lms_qualification_payload_problem#19`, is killed by one more assertion (a numeric `validTo`), checked against
  the mutant on the real server (original and mutant side by side in a scratch schema: the original refuses, the
  mutant returns NULL); no third run.
- After triage: 295 killed, 3 equivalent, 1 residual: **99.7 %** of the non-equivalent mutants (98.7 % counting the
  equivalents as survivors).
- Defects (P1): none. Every survivor showed a rule that holds but that no test took to its deciding input.

Survivors, one line each:
- P2 killed: `iam.integration_adapter_guard#3, #25` (registered ACTIVE; decommissioned is final), `#7, #13, #15, #17,
  #19` (each identifying column alone; `registered_at` is a database time kernel 0500 keeps on update, so its own
  clause cannot fire, and its neighbours' mutants are killed through the other columns).
- P2 killed: `iam.set_integration_adapter_status#2, #9` (reason; unknown adapter); `iam.current_integration_adapter#2`
  (an integration account acting with source SYSTEM is not an adapter).
- P2 killed: `platform.inbound_envelope_problem#10, #12` (the year-9999 timestamp and the 1 MiB payload at their
  limits); `platform.record_inbound_refusal#7, #18, #20` (refusal text; source time at and past the limit);
  `platform.acknowledge_integration_alarm#3` (unknown alarm).
- P2 killed: `platform.record_reconciliation#2, #3, #5, #7, #9, #11, #13, #15, #17, #18` (each malformed report alone,
  the period ending at the limit), `#25, #27, #28, #30, #32, #34, #36, #38` (the [from, to) period and what counts as
  received), `#39 to #50` (accepted and refused counts), `#53` (same count, other checksum).
- P2 killed (stale mirrors): `platform.record_mirror_sync#3` (unknown class), `#26, #27, #29` (the check starts after
  the same adapter's proof at head 0), `#28, #30` (another adapter's head does not shorten it), `#31` (D-P6j-T3-2),
  `#33 to #37` (the first held number is the adapter's own, refusals included, resends not), `#38` (the head alone),
  `#42, #44` (another adapter's refusals fill no hole), `#49, #51, #54` (only the adapter's own gap alarm over the
  whole hole covers it).
- P2 killed: `iam.qualification_source_fresh#4, #6, #10, #12` (the STAND_IN heartbeat and the MIRROR bound, each fresh
  up to and including its bound).
- P2 killed: `iam.lms_qualification_payload_problem#1 to #27` (11 survivors, each rule alone at its limits);
  `iam.receive_lms_qualification#2` (message type), `#49` (a state as old as the applied one), `#56, #61 to #69`
  (supersession by a new end date), `#75 to #81, #91 to #96` (withdrawal touches one person's row only).
- Equivalent (`tools/sql-mutation/equivalent.json`): `platform.accept_inbound_detail#47` (v_seq = v_max is refused as
  a taken number before), `platform.record_mirror_sync#19, #25` (every held sequence number is at least 1).
- Residual: `platform.mirror_freshness#10`, the one microsecond of the database clock where the age equals the bound
  (D-P6j-T3-3).
- Finding for the lead (not P1): `platform.epoch_us_to_timestamptz` goes through double precision (D-P6j-T3-4).

### packaging-labels-and-line-completion (triage T3)

- First run (stream p6-5): 274 detected / 352 valid, **77.8 %** (78 survivors).
- Kill tests: `packages/site-services/test/mutation/packaging-labels-and-line-completion.test.ts` (label store, PR-32),
  `packages/recipe-core/test/mutation/packaging-labels-and-line-completion.test.ts` (templates and declarations, IN-31,
  PR-36), `apps/tablets-server/test/mutation/packaging-labels-and-line-completion.test.ts` (specimens, waiver, line
  stops, post-use inspection; PR-16, PR-34, PR-36, PR-39, IN-16).
- Confirmation run (`--only` on the 74 survivors the tests aim at): **74 / 74 killed** (no survivor).
- After triage: 348 killed, 0 equivalent, 4 left (one of them with a kill test added after the run, below): **98.9 %**
  (99.1 % counting that test's kill, which follows from the code: the mutant lets the G-23 step through to EBMR-LBL-036).
- Defects (P1): none. The post-use inspection gate and the waiver rules hold; the survivors were untested inputs.

Survivors, one line each:
- P2 killed: `site.open_label_store_transaction#2, #4, #5, #7, #14` (each malformed transaction alone), `#52, #63` (an
  issue of exactly the balance, a return of exactly what the order holds).
- P2 killed: `recipe.label_layout_fields#1 to #32, #34` (13 survivors: each malformed layout or element alone, a text
  or default is a value, 40 elements and an 80-character caption at the limit); `recipe.create_label_template#1 to
  #17` (9: each malformed template alone); `recipe.label_template_status#1` (another template's retirement,
  D-P6j-T3-1).
- P2 killed: `recipe.declare_packaging_labelling#3, #14, #16, #17, #20, #32, #33` (unknown version, form, option and
  template refused by name); `recipe.packaging_labelling_problem#2` (a declared item the draft no longer prints);
  `recipe.master_labelling#1, #3` (the view's state is the version's own).
- P2 killed: `tab.g21_coding_applies#1, #3` (printer or coded item, never vision alone); `tab.record_coding_specimen#5,
  #7, #12` (each malformed specimen alone); `tab.record_label_specimen#7, #10, #11, #12, #16` (note limits; one item's
  specimen does not stand for another's); `tab.void_packaging_specimen#2, #8, #12, #13` (unknown, reason limit, twice,
  another's withdrawal); `tab.g21_specimen_problem#9` (an item judged on its own label specimen).
- P2 killed (release gating, PR-34): `tab.record_post_use_inspection#2` (no G-21 step), `#11, #13, #14` (extra or
  non-boolean answer), `#15 to #19` (note limits, 1000 characters accepted); `tab.verify_post_use_inspection#2` (unknown),
  `#14, #17` (an earlier inspection is not verified over a later one of the order; another order's does not block).
- P2 killed: `tab.vision_line_stop#7, #9` (a rejection opens a stop while another order's is open, and after its own
  was resolved); `tab.resolve_line_stop#2, #8` (unknown stop; reason limit); `tab.enable_reconciliation_waiver#35, #41`
  (an item on its own declaration; CUT_LABEL with ELECTRONIC_100 qualifies); `tab.print_job_rules#6` (a step declared
  without a template releases a job on its layout).
- Killed by a test added after the confirmation run (not confirmed by a run; decision 0019 allows no third):
  `tab.g21_specimen_step#3`, a G-23 step in progress takes no specimen (EBMR-LBL-030); under the mutant the call goes on
  to EBMR-LBL-036, which the test does not accept.
- Residual (P2, time box): `tab.enable_reconciliation_waiver#16, #18`, the challenge must come through the gateway the
  device is bound to now; killing it needs a device re-bound to another gateway after a passing challenge.
- Residual (P2): `tab.refuse_incomplete_packaging#3` (`tg_op = 'INSERT'` to `<>`): the mutant only adds the
  completion check to an update that leaves EXECUTION_COMPLETE unchanged, a stricter refusal; reaching it needs a
  completed order whose completion problem changes afterwards.

### erp-wms-receipt-and-stock (triage T2)

- **First run:** 207 / 350 detected (1 invalid), 59.1 %; 143 survivors (80 logical, 31 relational, 26 guard removals,
  4 not-removed, 2 boolean).
- **Killed by new tests (confirmation run, `--only` on 125 survivors): 118.** Tests in
  `packages/site-services/test/mutation/erp-wms-receipt-and-stock.test.ts`: every field of every ERP/WMS message type on
  its own (site.erp_payload_problem, 34), erp_source_value_ok and calendar_date_ok (4), receive_delivery and
  receive_supplier_batches' refusals and inclusive limits (2 + 28), record_lot_receipt (8), record_receipt_examination (3),
  receipt_problem (2), propose/approve/withdraw manufacturer (3 + 3 + 2), correct_lot_receipt_value and
  lot_receipt_effective per lot and field (10 + 5), the equal-timestamp WMS status (apply_wms_lot_status#12), the unit of
  a WMS move (apply_wms_stock_move#11), the lot named in the issue problem (erp_lot_status_problem#3), the WMS
  location question (3), resolve_lot_location_exception (3), the outbound queue (pending#2, delivered#3/#6,
  failed#3/#7, from_fact#2/#6).
- **Equivalent (7, in `equivalent.json`):** propose_approved_manufacturer#1, receive_supplier_batches#1,
  receive_delivery#1, record_lot_receipt#9, record_receipt_examination#15 (the first `or` of `p is null or not an object
  or <field check>` made `and`: for a non-object every field read is NULL, so the field check raises anyway);
  receive_supplier_batches#50 (mirror_freshness never returns a NULL 'stale'); erp_outbound_delivered#11 (only a stock
  block payload names a request, and a repeated delivery meets the conflict).
- **Defects (P1):** none from the survivors.
- **Defect M6-D1 (medium, fails safe; fixed in site services 1002):** found while writing the tests, not a survivor.
  site.receive_supplier_batches numbered generated lot codes from `count(*)` of the day's GR codes but advanced the
  counter for a batch whose lot code stores typed, so after a delivery with a typed code on a batch other than the last,
  the next generated code of the day already existed and every later receipt that day failed on
  `material_lot_site_code_lot_code_key`. No wrong record was written; receiving stopped until the next day. The fix takes
  the next number from the highest generated code of the day, advances it only for a batch without a typed code and skips
  a code already held (codes unique, never reused, gaps allowed; no cut to four digits past 9999). Test: `[PR-17] a lot
  code typed by stores on any batch never makes a later receipt of the day reuse a generated code` (failed before with
  the duplicate key, passes after); the kill test now types the code on the first batch again. Defect log entry in
  `docs/handbook/08-defect-log.md`. The equivalents receive_supplier_batches#1 and #50 now cite 1002:37 and 1002:67
  (the mutants keep their numbers; `--audit-equivalents` reports them fitting).
  - **D-P6j-T2-1 (lead):** M6-D1 is fixed now under decision 0008 although it is not Priority 1: it stops all receiving
    for the rest of the day. The function stays in erp-wms-receipt-and-stock; targets.ts is unchanged.
- **Residuals (18):**
  - approve_manufacturer#6-#10 (0910:301) and erp_outbound_delivered#13 (0916:57): the WHERE of a `for update` lock;
    only concurrent approvals or deliveries tell them apart (a two-session test was not reached in the time box).
  - approve_manufacturer#16 (0910:309, the signature-state refusal): the proposal's content and state do not change
    between signing and approving, so assert_signature or the already-approved check refuse first; not proven
    equivalent (approval and withdrawal rows vs the content provider not checked in the time box).
  - receive_supplier_batches#22, #24, #27, #29, #30, #31, #32 (0910:388-391, EBMR-SITE-105, a material known at the site
    as another kind or with a vendor route): needs a lot of the material under another kind; not reached (P2).
  - receive_supplier_batches#94 (0910:433, `<=` to `<` on expiry against clock_timestamp()): equal to the microsecond
    cannot be set up deterministically.
  - receive_supplier_batches#52 (0910:409, the daily code counter counting the site's other lots): codes stay unique but
    skip numbers (P3, numbering).
  - erp_outbound_from_fact#7 (0912:178, the yield message's lot): needs a finished lot; not reached (P2).
  - location_move_problem#18 (0916:212): the ' but <dates problem>' part of a message (P3).
- **Confirmation score:** 325 / 343 valid non-equivalent = 94.8 %.

### qms-capa-lims-cmms (triage T2)

- **First run:** 239 / 399 detected (2 invalid), 59.9 %; 160 survivors (51 guard removals, 48 logical, 42 relational,
  10 boolean, 9 not-removed).
- **Killed by new tests (confirmation run, `--only` on 149 survivors): 147.** Tests in
  `packages/site-services/test/mutation/qms-capa-lims-cmms.test.ts` (CAPA commands, resolver, QMS and LIMS receiving
  commands, the QMS fetch at release) and `packages/recipe-core/test/mutation/qms-capa-lims-cmms.test.ts` (CMMS
  commands and the maintenance rule, the QMS guard on QP certification and after-release reconfirmation, G-REL's QMS
  item). Killed by function: site.raise_capa (20), plant.receive_cmms_maintenance (14), plant.receive_cmms_calibration (9),
  site.receive_lims_sample_result (10), recipe.qms_release_guard (9), register_capa_master_resolver (7),
  schedule_capa_effectiveness_check (7), record_qms_release_fetch (7), capa_content (6), link_capa_deviation (6),
  cancel_capa (6), receive_qms_capa (6), record_capa_effectiveness (5), site.capa_master_version_facts (4),
  receive_qms_deviation_status (4), receive_qms_change_control (4), link_capa_master_version (3), lock_capa (2),
  record_capa_implemented (2), qms_payload_problem (2), close_capa (2), capa_view (2), plant.cmms_accept (2),
  recipe.grel_qms_item (2), recipe.capa_master_version_facts (2), capa_state, capa_close_problem, qms_accept,
  qms_assert_newest, plant.cmms_maintenance_problems (1 each).
- **Equivalent (4, in `equivalent.json`):** site.receive_lims_sample_result#11, plant.receive_cmms_calibration#2,
  plant.receive_cmms_maintenance#2 (the not-an-object guard: the stored payload is an object by constraint and the
  envelope check refuses any other first, kernel 1180); site.close_capa#6 (the signature-state refusal: a CAPA's state is
  in its signed content, so esig.assert_signature refuses a changed state first).
- **Defects (P1):** none. Every survivor was a correct rule without a test, or equivalent.
- **Killed after the confirmation run (not re-run, decision 0019 allows no third run):** site.receive_lims_sample_result#70
  (0926:106, `and` to `or` refuses every newer state of a sample and test); one assertion added: a newer state of the
  same sample and test is applied.
- **Residuals (8):**
  - site.qms_release_problem#10 (0927:100, `>` to `>=` on the fetch age against a running clock): equal to the
    microsecond cannot be set up deterministically.
  - plant.receive_cmms_calibration#55 (0950:156, `<=` to `<` on due start against clock_timestamp()): the same.
  - recipe.capa_master_version_facts#9 (0952:31, `>` to `>=` on effective_from against clock_timestamp()): the same.
  - site.close_capa#16 (0925:759, initiator guard): reached only with a CAPA_CLOSED signature by the initiator, which the
    meaning's entered-by exclusion refuses first (EBMR-ESIG-044, existing test); kept as defence in depth, not equivalent
    because the exclusion is policy data.
  - site.capa_view#7-#9 (0925:340, the batches of each linked deviation in the view and the CAPA_CLOSED content):
    needs a deviation linked to batches; not reached in the time box (P2).
  - site.raise_capa#88 (0925:545, the reference serial scoped by site and year): needs a CAPA of another site or year
    in the same database; not reached in the time box (P2, numbering only).
- **Confirmation score:** 386 / 395 valid non-equivalent = 97.7 % (98.0 % with #70).

### genealogy-and-recall (triage T4)

- First run (stream p6-2): 291 detected / 440 valid, **66.1 %** (149 survivors).
- Scope (owner, 17 October): only survivors that could let the genealogy or a mock recall silently drop a lot,
  consignee or depth level, or that touch the recall's sign-off (signature binding, the AP-only permission), were
  chased; the rest is recorded below in one line per kind.
- Kill tests: `packages/site-services/test/mutation/genealogy-and-recall.test.ts` (the instant world of D-P6j-T4-1:
  every edge kind as of the exact instant it happened, both directions, with decoys; node existence per kind; the
  recall's per-lot reconciliation and outbound transfer; the impact query; the sign-off; PR-57, IN-29, PR-50, DI-37).
- Confirmation run (`--only` on the 80 survivors the tests aim at): **79 / 80 killed** (98.8 %);
  `recipe.deviation_impact_batches#32` survived (below).
- After triage: 370 killed, 11 equivalent, 59 left: **86.2 %** (370 / 429; below the 90 % target, the rest recorded or
  residual within the owner's scope).
- Defects (P1): none. Every survivor that could drop a lot, consignee or depth level was an untested input
  (an as-of point exactly on an event, an edge kind no test built); the code was right.

Survivors, one line each:
- P2 killed (a recall could drop a node): `recipe.genealogy_step#5 to #130` (46: the inclusive as-of comparison of
  every edge kind both ways; the CHARGED edge's container, batch and purpose joins; the backward SHIPPED, TRANSFERRED,
  addition and MERGED joins; the forward TRANSFERRED edge's own seal); `recipe.genealogy_node_exists#3 to #24` (16: a
  node of each kind exists from its own instant, a batch by its issue or by its register link alone, no other node's
  row stands for it, an unsealed package is no node).
- P2 killed (recall content): `recipe.mock_recall_result_v1#9, #11, #12` (each lot's own deliveries and returns, a
  return at the as-of instant); `recipe.mock_recall_starts#6`, `recipe.run_mock_recall#13, #16` (a lot or deviation
  and its links at the as-of instant); `recipe.deviation_impact_batches#4, #9, #14, #20, #24, #31, #34` (the as-of
  instant for the deviation, links, lot posting and consumption; a future as-of refused).
- P2 killed (sign-off, IN-29, DI-37): `recipe.sign_off_mock_recall#2` (unknown run), `#11` (a run that no longer
  reproduces is refused even with a valid signature), `#16` (a signer holding the permission through another role is
  refused, D-P6j-T4-2); `recipe.mock_recall_content#3` (another run's sign-off does not change this run's state).
- Equivalent (11, `tools/sql-mutation/equivalent.json`): clock-microsecond boundaries `recipe.genealogy#11`,
  `recipe.run_mock_recall#6`, `recipe.deviation_impact_batches#8`, `recipe.deviation_recurrence#11`,
  `site.record_chemical_recovery#59`, `site.erp_apply_shipment#49`; `recipe.sign_off_mock_recall#20` (EBMR-RCL-014
  repeats the content check the VALID signature already passed, under the run's row lock); unreachable branches
  `recipe.genealogy_step#131`, `recipe.genealogy_node_exists#25`, `recipe.mock_recall_run_query#3`;
  `site.record_chemical_recovery#19` (a non-object payload also fails the next disjunct).
- Recorded (message only): `recipe.genealogy#1, #3, #6, #8` (an unknown kind or direction is still refused by the node
  check, EBMR-GEN-002, or the step, EBMR-GEN-001; only which refusal comes first differs); `recipe.run_mock_recall#15`
  (a deviation not raised by the as-of point is still refused, EBMR-RCL-004 instead of -003).
- Recorded (lock only): `recipe.sign_off_mock_recall#5` (the row lock; a second sign-off is still refused by the unique
  sign-off row).
- Residual (P2, not chased per the owner): `recipe.genealogy#30, #31` (the 200,000-edge cap: at the cap or with the
  guard removed the trace is answered in full, never cut short; a test needs 200,000 rows).
- Residual (P2, not chased): `site.record_chemical_recovery#5, #12` (recovery at another site, or of returned goods no
  longer in quarantine or rejected) and `#21 to #63` (16: each malformed field alone, the 200-character limits, a
  retest on the expiry); `site.erp_apply_shipment#2 to #29` (13: each malformed shipment field alone, the 200 and 500
  character limits, an explicit market).
- Residual (P2, not chased): `site.erp_shipment_distribution_fields#2`, `recipe.lot_dosage_form#2` (the strength and
  dosage form on a distribution record are another lot's when lots differ; every test lot is 500 mg tablets).
- Residual (P2, not chased): `recipe.deviation_of_product#3, #4, #6` (the recurrence count of deviations linked by
  batch rather than by lot, PR-49).
- Residual (P2, survived the confirmation run; no second run per decision 0019): `recipe.deviation_impact_batches#32`
  (`c.lot_id = any (v_lots)` to `<>`, 1012:351): the mutant adds every batch that consumed any other lot as SHARED_LOT,
  an over-inclusion that never drops a batch; killing it needs a batch consuming a lot no linked batch consumed.
- Recorded (display): `recipe.genealogy_node_views#12 to #28` (14: sub-kind, state and label of a node in the explorer
  and the federated excerpt).

### controlled-substance-mode (triage T6)

- First run (stream p6-5): 207 detected / 311 valid, **66.6 %** (104 survivors).
- Scope (owner, 17 October): possible P1 defects of draft control IN-53 (dual custody, the account closing at a stage
  sign-off and at batch completion) and untested high-risk rules (signatures, limits, the gate); the rest is recorded
  below, grouped, not chased.
- Kill tests: `packages/site-services/test/mutation/controlled-substance-mode.test.ts` (7 tests: custody, checkpoint
  and flag signatures recorded only by their signer and only in the state they were given in; the kernel's refusal of
  the first custodian as the second; a pending flag over an approved one; custody quantities against the lot and the
  batch's holding; a stage sign-off reads its own stage, batch and controlled API; IN-53, DI-35, INV-03).
- Confirmation run (`--only` on the 27 survivors the tests aim at): **27 / 27 killed**.
- After triage: 234 killed, 2 equivalent, 75 left: **75.7 %** (234 / 309; below the 90 % target, the rest recorded or
  residual within the owner's scope).
- Defects (P1): none. Checked: a second custodian who is the first or the proposer is refused by the kernel at signing
  (D-P6j-T6-1), with the command's EBMR-CSM-022 behind it; a dispensing, transfer, return or destruction without the
  countersignature is not counted or covered (the CONFIRMED checks of the consumption guard, the transfer cover and the
  balance were all killed); the checkpoint table itself keeps the account identity, non-negative figures and "a
  difference only with an explanation and the batch's deviation", so no checkpoint closes with an unexplained balance
  even with the command's checks removed. The stage-selection survivors (below) were untested, not wrong.
- Observation (not a defect): a countersignature given while the record is still PROPOSED is refused when recorded
  (EBMR-CSM-023), and the kernel then refuses that witness a second COUNTERSIGNED signature on the record (EBMR-ESIG-042);
  that record cannot be completed and a new one is proposed. The custody screen asks the second signature only in
  AWAITING_COUNTERSIGN, so this needs a direct call.

Survivors, one line each:
- P2 killed (signature binding, IN-53, DI-35): `recipe.sign_controlled_custody#24` (a countersignature given in
  PROPOSED), `#29` (a third custodian records the witness's signature); `recipe.sign_controlled_checkpoint#21`,
  `plant.approve_controlled_product#20` (another person records the signature).
- P2 killed (limits): `recipe.propose_controlled_custody#19, #21, #22, #25` (zero, seven decimals, another unit),
  `#47, #48, #72, #73` (a transfer or dispensing above the lot's quantity, and exactly at it), `#67, #69` (a dispensing
  into a completed batch), `#77, #79, #81, #84, #85` (a return counts this batch's own consumption of this lot, less its
  own returns awaiting or confirmed, never a proposal; exactly what is left may be returned).
- P2 killed (the stage gate): `recipe.controlled_checkpoint_problem#2, #4` (another stage's or another batch's signed
  checkpoint closed the stage); `recipe.controlled_moved_materials#1 to #4` (an API consumed before the flag; a batch
  that consumed only an excipient); `recipe.controlled_balance#2` (the excipient counted as dispensed API);
  `plant.controlled_materials#7` (a pending flag adding an API over an approved flag counts at once).
- Equivalent (2, `tools/sql-mutation/equivalent.json`): `plant.controlled_materials#2` (a not-controlled record names
  no material), `#12` (a pending record is never the approved one).
- Recorded (later layer): `recipe.sign_controlled_custody#17, #20` and `plant.approve_controlled_product#11` (the
  kernel's meanings refuse the signature, D-P6j-T6-1); `recipe.sign_controlled_custody#2`,
  `recipe.sign_controlled_checkpoint#2`, `plant.approve_controlled_product#2` (an unknown record: the signature
  assertion refuses); `recipe.sign_controlled_custody#7` (a third signature: the (custody, position) key);
  `recipe.sign_controlled_checkpoint#8` (a second signature: the checkpoint key; a superseded checkpoint is never read,
  the gate takes the latest), `#12` (a checkpoint the account has moved past: the gate re-checks it, EBMR-CSM-042),
  `#16` and `plant.approve_controlled_product#15` (the state problem after EBMR-CSM-039 / -005, which already refuse
  every changed state); `recipe.propose_controlled_custody#2, #4, #9, #13, #15, #34, #52` (lot, kind, location and
  batch shape: the cast, the table checks and the foreign keys); `recipe.record_controlled_checkpoint#1, #3, #14, #25,
  #27, #33` (batch, stage, decimal and unit shape: the cast, the foreign key and the table checks, negatives included).
- Recorded (fail-closed): `recipe.controlled_sign_off_guard#1, #4`, `recipe.controlled_batch_end_guard#1` (the guard
  runs on more rows); `plant.controlled_record_state#2` (a newer record of another product supersedes: approval refused).
- Recorded (record hygiene, no rule reads it): `recipe.propose_controlled_custody#30, #89, #90` (a batch named on a
  transfer is dropped; locations named on a batch act are stored); `recipe.record_controlled_checkpoint#20` (a checkpoint
  of a non-controlled material), `#64, #66, #67, #68, #71` (an explanation or deviation named with no difference; a blank
  explanation is stored as none); `plant.record_controlled_product#2, #3, #4, #7, #9, #15, #17` (flag shape: a duplicate
  material collapses, a mismatch of `controlled` and the list restricts nothing beyond what QA recorded and a second QA
  approved); `recipe.controlled_checkpoint_state#2, #4, #6` (which old checkpoint is marked superseded; the gate reads
  the latest); `recipe.controlled_moved_materials#5, #6, #7` (a material moved by a custody record alone has a zero
  account).
- Recorded (message, display, signed-content fields): `recipe.record_controlled_checkpoint#37`,
  `recipe.controlled_custody_content#2`, `recipe.controlled_checkpoint_content#2, #4`, `plant.controlled_product_state#1,
  #2`, `tab.controlled_preview#2, #6`, `tab.controlled_signing_content#2` (the preview's pair check; the commands assert
  the meaning).
- Residual (P2, not chased per the owner): `recipe.controlled_register_v1#3, #5, #7, #10 to #13` (the register's
  joins and filters: another material's or an unconfirmed movement; each test has one material) and
  `recipe.run_controlled_register#1 to #7` (the period's validation); reproducibility itself is killed.
- Residual (not chased): `recipe.sign_controlled_custody#34` (the batch epoch is bumped for a transfer instead of a batch
  act: the screens re-read on the next bump), `recipe.controlled_checkpoint_current#13` (an account in two units:
  recording a checkpoint is refused then, EBMR-CSM-034).

### serialisation-l3 (triage T6)

- First run (stream p6-5): 68 detected / 112 valid, **60.7 %** (44 survivors).
- The release gate and the stale mirror: `tab.l3_release_problem` and `tab.l3_tasks_of` have no survivors.
- Kill tests: three more steps in `apps/tablets-server/test/integrations/l3-adapter.test.ts` (the malformed and stale
  messages test): staleness is per task, an older state of the same task is refused, a repeat at the same change time
  lands (PR-42, DI-31).
- Confirmation run (`--only` on the 3 survivors the tests aim at): **3 / 3 killed**.
- After triage: 71 killed, 41 left: **63.4 %** (71 / 112; below the 90 % target; the rest is fail-closed, a later
  layer or display, recorded below).
- Defects (P1): none.

Survivors, one line each:
- P2 killed (stale mirror): `tab.receive_l3_message#114` (another task's later change refused a new OPEN task, so the
  release would not see it), `#120` (an older state of the same task), `#119` (same change time).
- Recorded (later layer): `tab.receive_l3_message#2, #4` (another message type: the decommission-task shape or the
  table checks refuse it), `#17, #19, #26, #28, #30, #72 to #90, #92` (each malformed field is still refused by a table
  check, event id, action, SSCC, counts, task id, state, or by the pool, shipper and order lookups; only unknown keys and
  the reason's characters and length are not), `#37, #97` (an unknown pool: the shipper lookup or the order comparison
  refuses, EBMR-L3-103); `tab.assert_pool_rejection#2` (its caller refuses an unknown pool).
- Recorded (fail-closed, D-P6j-T6-1): `tab.record_pool_rejection#2, #5 to #8, #10, #14 to #26` (it only records an
  OPEN task, a release block).
- Recorded: `tab.receive_l3_message#42` (message only), `#53` (an aggregation at the same event time: clock boundary),
  `#117` and `tab.record_pool_rejection#34` (the same task id in another pool; the L3 issues task ids per system);
  `tab.serial_lookup#1, #3, #9, #10` (the serial query's answer validation: a display read, not a release gate).

### transfer-and-federation (triage T8)

- First run (stream p6-4): 189 detected (188 killed, 1 time-out) / 393 valid, **48.1 %** (204 survivors). The group's
  own tests were the two scenario files only; no test anywhere acknowledged an installation alarm, revoked a peer,
  rotated the installation key, read a receipt's signed content or called `platform.ed25519_verify` with a known-answer
  vector.
- Scope (owner, 17 October): possible P1 defects (a tampered, misaddressed, replayed or untrusted package or answer let
  through; a QUARANTINE lot used without the signed acceptance or past its hold limit; a laxer rule winning) and
  untested high-risk guards; the rest is recorded below, grouped, not chased.
- Kill tests: `packages/site-services/test/mutation/transfer-and-federation.test.ts` (14 tests; DI-18, DI-31, DI-39,
  INV-13, PR-18, IN-29): Ed25519 against the RFC 8032 vectors 1 to 3 with a malleated S (S + L), one byte more or less on
  signature and key, NULL arguments and a key that is no point; under the neutral point S = L (refused) and S = 2^252
  (verifies only with every bit of the ladder) and no message (refused although R = [S]B); a seal for an unlisted
  purpose and a non-canonical base64 seal; 21 packages re-sealed by the trusted origin with one field wrong
  (MALFORMED, or WRONG_DESTINATION for another site); the received lot's retest instant and hold limit (the earliest of
  carried hold, retest and expiry) and the receipt's signed content; a revoked peer, the approval's signer, a second key
  for a trusted installation, key rotation, the identity and proposal shapes; the origin's request shape, a past stated
  hold, exactly the quantity left, the hold basis without a retest, an expired or retest-due lot; the federation
  request and query shapes (ok = false, the refusal logged against the request's own nonce), an unsealed package to the
  asker, and an answer differing from the request in one field (FED-018 / FED-019); an installation alarm's
  acknowledgment (once, with a note, never by an administrator), the seal by the preparer, and a mock recall's remote
  part (transfer reached, status, the destination's forward excerpt of that transfer).
- Confirmation run (`--only` on the 105 survivors the first tests aim at): **100 / 105 killed**; of the five
  left, `platform.propose_peer_installation#1` and `site.prepare_transfer_package#8` are equivalent,
  `platform.ed25519_verify#1` and `platform.set_installation_identity#22` are killed by the tests added after (below) and
  `site.prepare_transfer_package#54` is a later layer.
- Tests added after the confirmation run had started (verified to pass; counted as kills by reasoning, not run against
  the mutants, since decision 0019 allows one confirmation run per group, D-P6j-T8-1): `platform.acknowledge_installation_alarm#1, #2, #3, #6, #7, #9, #13, #14`, `site.seal_transfer_package#2,
  #7`, `recipe.record_mock_recall_remote#11, #14, #16, #21, #23, #25, #28`, `site.transfer_receipt_content#2, #4`,
  `platform.ed25519_verify#1`, `platform.set_installation_identity#22`.
- After triage: 289 detected (confirmed), 13 equivalent: **76.1 %** (289 / 380); 309 / 380, 81.3 %, with the 20 kills of
  the tests added after the run; below the 90 % target, the rest recorded or residual within the owner's scope.
- Defects (P1): none. Checked: every seal goes through `platform.seal_valid`, which refuses a key of small order or no
  point before `ed25519_verify` and a seal that is not canonical base64 of 64 bytes; S below L, the full ladder and the
  RFC vectors are now proven; trust is approved-and-not-revoked (`trusted_peer#6` now killed); an import is refused when
  the origin is untrusted, the seal fails, the installation or site differs, or the package was taken in (package id
  unique); the acceptance needs QA's signature by the signer and a hold limit ahead, and the hold limit is already the
  earliest of carried hold, retest and expiry, so the acceptance's own expiry and retest checks (`decide#30 to #35`)
  and its origin-state check (`#39, #40`, refused at import first) are a second layer; a carried rule is compared with
  the local one and only the stricter (or the union) is kept: the surviving `resolve_carried_rules` mutants can only add
  a stricter local value or skip an entry no origin database builds. The federation answer is bound to the request
  (installations, nonce, transfer, direction, as-of) and to an exchanged, sealed transfer (`answer#16`, an unsealed
  package, now killed).

Survivors, one line each:
- P2 killed (seals and keys, DI-31): `platform.ed25519_verify#2, #3, #5, #7 to #11`; `platform.seal_valid#4, #6, #7`;
  `platform.trusted_peer#6`, `platform.peer_installation_state#1` (a revoked peer); `platform.set_installation_identity#1
  to #3, #5, #8, #11 to #18, #21, #23` (shape, key, code, site and edition never change, the same key is no new
  version); `platform.propose_peer_installation#3 to #26` (shape, URL length, never its own peer);
  `platform.approve_peer_installation#11, #20` (a second key for a trusted installation; the signer records);
  `platform.revoke_peer_installation#2, #3, #6, #7`.
- P2 killed (import, DI-31, DI-39, PR-18): `site.import_transfer_package#5, #7, #8, #13, #21 to #54` (the format,
  origin, package id, destination site and every lot, status, hold, market and number field after the seal; a lot
  stated QUARANTINE or REJECTED at its origin), `#58, #59` (the retest instant kept, clamped to the expiry).
- P2 killed (origin, DI-39, INV-13, PR-18): `site.prepare_transfer_package#10 to #23` (the request shape),
  `#41, #42, #45` (an expired or retest-due lot), `#49` (exactly what is left), `#62` (a stated hold in the past).
- P2 killed (federation, DI-31, D-P6i-0-7, D-P6i-0-9): `platform.accept_federation_request#6 to #12` (request shape),
  `platform.refuse_federation_query#1, #2` (ok = false, logged against its own request),
  `recipe.answer_federated_genealogy#4, #9, #12, #16`, `recipe.record_federated_excerpt#10 to #26` (the answer's shape
  and its binding to the request; ok = false).
- Equivalent (13, `tools/sql-mutation/equivalent.json`): `platform.ed25519_verify#14` (one more doubling of the neutral
  point), `platform.seal_valid#1, #2, #3` (a NULL alone is refused further on), `#8` (a key that is no point: verify
  refuses it), `#10` and `platform.own_seal_valid#1`, `platform.peer_seal_valid#1` (never NULL),
  `platform.propose_peer_installation#1`, `site.prepare_transfer_package#8` (a non-object fails the next check of the
  same IF),
  `site.import_transfer_package#60` (retest equal to expiry), `site.resolve_carried_rules#23` (NULL both ways or
  neither), `recipe.answer_federated_genealogy#3` (ok is always a boolean).
- Recorded (cryptographically unreachable): `platform.ed25519_verify#13` (the ladder skips k's bit 252 only when k is
  at least 2^252, about 4e-39 for a hash; it can only refuse a good seal, and under a key of small order that bit
  changes nothing); `platform.ed25519_pow#1` timed out (detected).
- Recorded (later layer): `platform.approve_peer_installation#2` (unknown peer: the signature assertion), `#6` (the
  approval is keyed by the peer: approved once), `platform.acknowledge_installation_alarm` (the note check, the primary
  key and the foreign key of `installation_alarm_ack` refuse what its guards refuse); `site.import_transfer_package#18`
  (the receipt's package id is unique); `site.decide_transfer_receipt#2` (unknown receipt), `#7` (the acceptance's
  primary key and the kernel's second signature), `#10, #12` (the decision's table check), `#23` (a lot QA moved out of
  QUARANTINE: acceptance changes no state and the lot machine still gates use), `#30 to #35`, `#39, #40` (above);
  `site.prepare_transfer_package#1` (the permission is scoped to the lot's site), `#54` (a retest after the expiry
  would become the package's hold; the receiving site's limit is the least of hold, expiry and retest clamped to the
  expiry, 0981:353), `#4, #5` (an installation without an
  identity for this site: its key seals nothing, and the origin site in the package is its identity's);
  `recipe.issue_federated_request#1 to #25` (the asking site's own checks; the answering site refuses an untrusted,
  misdirected, future or unexchanged request); `recipe.record_federation_failure#2, #5, #7` (the failure's foreign key
  and status check); `recipe.record_federated_excerpt#2` (unknown nonce: FED-015 from the failure), `#6` (the
  excerpt's nonce is unique); `recipe.record_mock_recall_remote#2` (unknown recall: RCL-021).
- Recorded (content, messages, boundaries, locks): `site.prepare_transfer_package#55, #58, #59, #65` (the hold basis
  text when two limits are equal; the carried hold is never later than the lot's expiry or retest), `#67, #69, #71,
  #73` (which release decision and CoA rows the package shows; the receiving site tests the lot itself before its
  release), `#40, #44, #61` and `site.decide_transfer_receipt#17, #26`, `site.transfer_use_problem#3`,
  `platform.accept_federation_request#17`, `recipe.answer_federated_genealogy#26, #27` (exact-microsecond or 10-character
  boundaries, the as-of wait), `platform.acknowledge_installation_alarm#8` (1000 characters), `#12`,
  `platform.approve_peer_installation#9`, `platform.revoke_peer_installation#1`, `site.decide_transfer_receipt#5` (lock
  only), `site.transfer_use_problem#2` (message), `platform.accept_federation_request#24` (the query column of a refusal
  row), `site.transfer_rule_resolutions#2, #4` (a rule the market model does not apply is carried: the receiving site
  re-resolves and the stricter wins), `site.resolve_carried_rules#2, #5, #14, #16` (an entry without key or value; an
  inapplicable local value compared: only a stricter value can win), `platform.raw_public_key#1` (a key text in
  non-canonical base64 is decoded: the same 32 bytes).
- Residual (P2, not chased per the owner): `site.decide_transfer_receipt#44` and
  `platform.approve_peer_installation#15` (a signature whose record changed state after signing: needs a state change
  between signing and recording; the kernel's signature checks are proven in the signing groups);
  `recipe.record_federation_failure#1` (the failure and its alarm recorded against another request: audit attribution
  of a failed query).

### governance-change-control (triage T9)

- First run (stream p6-5): 84 killed / 117, **71.8 %** (33 survivors).
- Scope (owner, 17 October): an approval by the wrong person or without a valid bound signature, a change applied without
  an approved record (P1), and untested high-risk guards; the rest is recorded below, grouped, not chased.
- **No P1 defect.** The smoke run's "removed checks in `platform.approve_change_record`" are each covered by an earlier
  or later layer that the group's tests already prove:
  - `#18` (the raiser approves): the signature catalogue's performer exclusion refuses the raiser's
    `CONFIG_CHANGE_APPROVED` signature at signing (tested: "the raiser cannot approve"), so no valid signature of the
    raiser reaches the function.
  - `#6` (a record not OPEN): the signed content carries the state and the signature is bound to `OPEN`; a signature
    made while OPEN no longer matches once the record is APPROVED or CLOSED (EBMR-ESIG; tested for both).
  - `#2` (no such record), `#9` (no signature id): `esig.assert_signature` refuses a NULL id or a signature not bound to
    that record; `close_change_record#2` (no such record): the event row's NOT NULL change record id refuses it.
- Killed by a new test (in `packages/kernel/test/config/change-control.test.ts`, "[DI-09] a role definition, a
  permission added to a role and one removed from it each need a change record"): `platform.config_version_log#3, #4`
  (the version's valid-from: from the row's validity column on INSERT, from the moment of the change on UPDATE; the
  mutants dated a permission's removal back to when it was added, so a diff for a date in between lost the permission).
- P3, one line each:
  - `platform.is_release_actor#2, #3, #5, #6, #8, #9`: the software-release identity (nil person, SYSTEM, SOFTWARE_RELEASE)
    is set only by owner-level migration code; a command cannot claim it or a nil person (tested: "bypass attempts"),
    and every system actor (sweeper, devices) carries its own real person. Only owner-level code, which may write the
    tables anyway, reaches these clauses.
  - `platform.config_change_guard#1`: fail-closed (the release identity would be refused, no change let through).
  - `platform.require_change_record#2`: with no context the next check raises the same EBMR-CFG-001 (message only).
  - `platform.register_config_area#1, #2, #5-#13`: an install-time helper only migrations call as the owner; a wrong
    registration is caught by the DI-09 scan tests ("every registered configuration table carries the guard").
  - `recipe.rbe_rule_guard#9`: the only writer (`recipe.set_rbe_rule`) computes the next version; the application role
    cannot insert. `recipe.set_rbe_rule#13`: lock only.
  - `recipe.notify_departments_of_excursion#4, #5`: an excursion row always names an existing batch (foreign key) and
    is written in a command (unreachable branch).
  - `recipe.pqr_cpp_of#6, #24, #30`: the PQR's CPP extract (a reporting read; a state always carries `failed`, and a
    non-critical calculation in the extract is a reporting difference, not a GMP write).
- Residuals: none for the owner.
- Confirmation run (`--only platform.config_version_log#3, #4`): 2 of 2 detected, **100 %**; the group stands at
  86 / 117, **73.5 %**.

### governance-support-and-contract-giver (triage T9)

- First run (stream p6-5): 163 killed / 228, **71.5 %** (65 survivors).
- Scope: a support grant usable with one signature, past its time box or beyond its scope, a contract-giver reviewer
  able to write or to read outside its licence (P1), and untested high-risk guards.
- **No P1 defect.** The two-signature rule holds without the function's own checks where they survived:
  `iam.approve_support_grant#31` (the QA and IT approvers the same person): the meaning catalogue makes each meaning
  `independent_of` the other, so `esig` refuses the second signature by the same person (EBMR-ESIG-043);
  `#16` (the requester or the engineer approves): every role holding an approval permission (AUTHORISED_PERSON,
  PROCESS_OWNER, QA_MBR_APPROVER) is a GMP role, which the static segregation (INV-11) refuses to the person of an
  administrator (the requester is SYSTEM_ADMINISTRATOR) and of a support engineer (VENDOR_SUPPORT is an administration
  role), and a support account never authenticates to sign (SUPPORT_CANNOT_SIGN). A new test proves that layer.
  `#13` (a grant not PENDING): the per-kind duplicate check and the signature's binding to PENDING refuse it; a REVOKED
  grant stays closed (revocation wins in `iam.support_grant_open_at`).
- Killed by new tests (confirmation run below):
  - `packages/kernel/test/identity/support-grant.test.ts`: "[DI-08] the time box is 1 to the configured maximum of
    hours, both ends included; IT's administrator may end a grant early" (`iam.request_support_grant#24, #27`,
    `iam.revoke_support_grant#1`) and "[DI-08][INV-11] an approval is recorded by its own signer; the requester, an
    administrator, can never hold a role that approves" (`iam.approve_support_grant#10`, and the segregation behind #16).
  - `packages/recipe-core/test/release/india.test.ts`, "[IN-30] a contract-giver reviewer cannot edit": the record read
    is that batch's own execution state (`recipe.read_contract_giver_batch#17`); a reviewer account later given a role
    that writes gets no new access and reads nothing under a live one (`recipe.grant_contract_giver_access#27`,
    `recipe.contract_giver_batches#3`, `recipe.read_contract_giver_batch#3`); a generic (shared) account holding the
    reviewer role is refused (`recipe.grant_contract_giver_access#15, #16, #17`, the only check that keeps a shared
    account out: the role is read-only, so the DI-14 role segregation allows it).
  - `iam.authn_resolve` (18 survivors, re-created here from 0160): its refusals are tested in `identity/access.test.ts`,
    `identity/accounts.test.ts` and `mutation/authentication-events.test.ts`, which were not in the group's list; added
    to the group in `tools/sql-mutation/src/targets.ts` (D-P6j-T9-1). The confirmation run killed 8 with them (`#46,
    #57, #58, #60, #61, #62, #75, #77`).
  - `packages/kernel/test/identity/devices-sessions.test.ts`, "authentication methods and purposes": `[DI-14][DI-38] a
    badge tap only attributes an entry; a service key only logs in; a signature needs two components; an unknown method
    or purpose is refused` (`iam.authn_resolve#3, #5, #11, #15, #25`) and `[DI-14][DI-38] an account without an active
    credential of the method is refused before any secret is compared, whatever the secret` (`#73`). These two are the
    high-risk finds of the group: `iam.open_session` checks a login event's purpose but not its method, so `#11` would
    let a badge tap alone open a session, and with `#73` an account holding no credential of the method was answered
    "nothing to verify" and the server accepted any secret. The original refuses both; only the tests were missing.
    Written after the group's confirmation run had passed these mutants, so each was proved by hand instead (no second
    run, decision 0019): the mutant applied to a copy of kernel 1202 in the worktree, the test fails; reverted, it passes.
- P3, one line each:
  - Exact-microsecond window boundaries: `iam.support_grant_open_at#3, #5, #10`, `iam.support_grant_state#2`,
    `iam.session_state#2, #8`, `recipe.contract_giver_access_live#3, #5`, `recipe.grant_contract_giver_access#33, #35`.
  - `iam.support_grant_open_at#9`: fail-closed (any revocation anywhere closes every grant).
  - `iam.request_support_grant#2, #4, #6, #7, #8` (the account checks): a later layer: the VENDOR_SUPPORT role is held
    only by HUMAN, non-generic accounts (role account kinds, DI-14 segregation), and an inactive or break-glass support
    account is refused at authentication; `#17` (an administrator requesting for their own support account): the grant
    still needs the two customer signatures, neither of which the requester can give (above).
  - `iam.approve_support_grant#6`, `iam.revoke_support_grant#5, #12`, `recipe.revoke_contract_giver_access#3`: a later
    layer (the signature binding, the foreign key, the revocation's primary key / `on conflict`).
  - `recipe.grant_contract_giver_access#7`, `recipe.revoke_contract_giver_access#6` (blank reason): the table's CHECK.
  - `recipe.grant_contract_giver_access#22` (QA granting itself): QA's account is not read-only, so EBMR-CGA-003 refuses.
  - `recipe.grant_contract_giver_access#26` (an account without CONTRACT_GIVER.READ): every read requires that
    permission, so the access reads nothing. `#32`: a past or NULL end is refused by the table's CHECK / NOT NULL.
  - `iam.contract_giver_role_permission_guard#2, #3`: fail-closed (refuses more role permissions).
  - `iam.authn_resolve#45, #55` (an unknown identifier, an inactive account answered as not refused): the login is
    still refused later (no account to record an event for; `iam.open_session` and the command and signing checks
    refuse an account that is not ACTIVE, EBMR-IAM-103, tested), only the refusal's own record and alert are lost
    (logging); `#80, #83`: exact-microsecond expiry of a secret.
  - `recipe.grant_contract_giver_access#11, #13` (the first two of the account clauses): an unknown or non-HUMAN account
    cannot hold the reviewer role (EBMR-CGA-003 refuses), and an inactive account cannot log in to read.
  - `tab.support_grant_preview#2, #6`: the preview only shows the content; the signing command checks the permission
    again (`tab.support_grant_signing_content`, `iam.approve_support_grant`).
- Residuals: none for the owner.
- Confirmation run (`--only` on the 31 survivors the new tests and the widened list aim at): 19 of 31 detected; the 12
  left are `iam.authn_resolve#3, #5, #11, #15, #25, #73` (killed by hand since, above), `#45, #55, #80, #83` and
  `recipe.grant_contract_giver_access#11, #13` (P3, above). The group stands at 182 / 228 detected in the runs, **79.8 %**,
  and 188 / 228, **82.5 %**, counting the six hand-proved kills.

### reporting-and-training (triage T10)

- First run (stream p6-5): 110 killed / 149, **73.8 %** (39 survivors).
- Scope (owner, 17 October): P1 would be the report role able to write, or to read beyond the report views, or
  training able to run or write on a GMP installation. No survivor touches either: the report role's privileges and the
  segregation check are tested in `sandbox/reporting-and-training.test.ts` (every write refused by a privilege, the
  check reporting any extra grant), and training state in a GMP database is refused by the insert trigger
  `sandbox.training_sandbox_only` whoever writes (killed: no survivor there) before any command's own guard.
- Tests added (single lines, verified to pass; not run against the mutants, the owner's rule for minor survivors, so no
  confirmation run for this group): `complete_training_step` on a GMP database refuses with EBMR-SBX-039 (DI-05;
  `sandbox.complete_training_step#1`); an unknown supplier and a well-formed unknown MBR version are refused with
  EBMR-CIM-002 (`recipe.change_impact#29, #49`, and with them likely `#24 to #28`).
- Defects (P1): none.

Survivors, one line each:
- P2/P3, killed by reasoning with the lines above: `sandbox.complete_training_step#1` (guard removed: without it the
  call still refuses, EBMR-SBX-040, since no attempt can exist in a GMP database; now its own code is asserted);
  `recipe.change_impact#24 to #29` (unknown-supplier check), `#48, #49` (unknown MBR version check).
- P3 (sandbox only, refused by a later layer): `sandbox.complete_training_step#9` (`p_step is null and p_step < 1`): a
  step 0 or NULL is still refused by the table's check and not-null constraints; the step-range and other-person rules
  are proven through the training routes (`dashboards-routes.test.ts`).
- P3 (dashboard display; outline 7.3, the views write and decide nothing): `report.batch_version#1, #2` (the MBR version
  shown), `report.batch_outcome_rows_v1#2, #10 to #12, #18` (completion time, QA review time, deviation count filters),
  `report.press_counter_rows_v1#2, #4, #6, #7, #31` (event and series filters), `report.alarm_rows_v1#2` (the subject
  code shown).
- P3 (the change-impact explorer: a read that writes nothing and decides nothing; its rows are exported with their
  hash for the change record, where the person proposing the change reviews them): `recipe.change_impact#33, #35, #37`
  (approved and not withdrawn manufacturer filter), `#58 to #60` (authorisation cell filter for SITE_VALUE), `#70`
  (lot consumption join), `#81, #82` (released lot reach), `#85, #86` (authorisation markets), `#88 to #93` (config
  history filter).
- Residuals: none in the owner's scope.

### Functions Phase 6 re-created in earlier groups (stream p6-6b; triage T10)

- First run (stream p6-6b, only these functions in their groups): mbr-lifecycle 6/6 (100 %); execution-commands 91/129
  (**70.5 %**, 1 equivalent); read-authorisation 10/11 (90.9 %); connection-roles 107/115 (93.0 %);
  plant-equipment-and-areas 12/12 (100 %, 1 equivalent); lots-and-lims 3/3; release-gate 10/14 (**71.4 %**);
  tablets-release-items 2/2; after-release-suspension 30/32 (93.8 %, 1 equivalent); pqr-extract 5/5. 53 survivors.
- Scope (owner, 17 October): possible P1 defects in release gating, read authorisation, sandbox segregation, equipment
  fitness and calibration, lot availability, and the command permission and product scope of 6jc-R16 (a requirement
  for another product's batch applied or skipped wrongly; an evaluation made with another product accepted).
- Defects (P1): none. The 6jc-R16 batch forms (`require_command_permission(type, meaning, batch)`,
  `role_evaluation_problem(..., batch)`, `check_engine_roles(..., batch)`, `append_execution`) have every product-scope
  mutant killed: an evaluation with another product is refused, the batch's own product accepted, and the product
  reaches the signature scope through `with_batch_scope` (its one survivor only adds a scope to the answer for a record
  that does not exist, which nothing signs). The QMS item survivors of `grel_evaluate` showed an untested inclusion
  rule, not a laxer release: the release decision itself is guarded by `recipe.qms_release_guard` (killed).
- Kill tests (P2): `connection-roles`: the reporting role's segregation check reports each elevated attribute alone, a
  membership either way and a missing role, each change made in a rolled-back transaction since roles are cluster-wide
  (`kernel/test/sandbox/reporting-and-training.test.ts`; DI-17, DI-30). `read-authorisation`: a controlled-substance
  record is refused to a role holding neither the kind's permission nor a governance read permission, and read by each
  holder and a governance reader (`tablets-server/test/esig/read-authorisation.test.ts`; IN-53, DI-17).
  `execution-commands`: both forms of the engine-role evaluation check refuse another account of the same person, an
  evaluation of an earlier instant and one made in no role (`tablets-server/test/execution/db-guards-roles.test.ts`;
  INV-26, DI-17, D4). `release-gate`: G-REL carries the QMS item for a finished lot in MIRROR mode only (RED and not
  ready for an open deviation), none for a lot that is not a finished lot or in STAND_IN, and a lot that is not a
  finished lot gets no US market items (`recipe-core/test/integrations/cmms-qms-release.test.ts`; DI-31, PR-23).
  `after-release-suspension`: the suspension cascade follows only the recovery of a lot on the path
  (`site-services/test/genealogy/genealogy.test.ts`; IN-29).
- Confirmation runs (`--only` on the survivors the tests aim at; one per group): release-gate 4 / 4, connection-roles
  7 / 7, read-authorisation 1 / 1, execution-commands 10 / 10 (the `--only` ids name both overloads, so the five
  targets and five already killed), after-release-suspension 2 / 2: every target killed. After triage: release-gate
  14 / 14 (100 %), connection-roles 114 / 115 (99.1 %), read-authorisation 11 / 11, after-release-suspension 32 / 32,
  execution-commands 98 / 129 (76.0 %; the 27 unreachable `check_engine_roles` survivors of a dead overload are most of
  the rest).

Survivors, one line each:
- P2 killed (see above): `sandbox.segregation_problems#33, #36 to #40, #44`; `tab.record_read_problem#3`;
  `recipe.role_evaluation_problem#7` (batch form), `#10, #12, #15, #16` (location form); `recipe.grel_evaluate#8, #9,
  #10, #12`; `recipe.genealogy_downstream_lots#10, #11`.
- P3 unreachable: `recipe.check_engine_roles#1 to #60` (27 survivors, the 2-argument form of recipe-core 0270): since
  recipe-core 1100 no function calls it (`append_execution` calls the batch form; the issue paths never called it) and
  only the owner may execute it. Owner item: the dead overload could be dropped by a later migration.
- P3 unreachable: `recipe.require_command_permission#2` (2-argument form): every caller passes a catalogued type (a
  constant, or `propose_act`'s checked list), and an unknown type would still be refused by `iam.require_permission`;
  `#6` (`p_meaning <> 'WITNESSED'`): only a VERIFY reaches that branch, and VERIFY goes through the batch form since 1100.
- P3 fail-closed: `recipe.require_command_permission#8` (2-argument form, `p <> any (held)`): the mutant can only pick
  another permission of the same command's list, which the kernel then checks, so it can refuse a holder of a later
  permission but never admit anyone (the same mutant of the batch form is killed).
- P3 clock microsecond boundary: `recipe.role_evaluation_problem#11` (location form, `<= now()`), `#13` (batch form,
  `>= clock_timestamp()`).
- P3: `recipe.with_batch_scope#3` (`and` -> `or`): adds the batch's product to the answer for a record that does not
  exist; no signature or read accepts a record that does not exist.
- P3 race only: `sandbox.apply_connect_policy#24` (`coalesce(r.rolsuper, false)` -> `true`): `r` is NULL only for
  PUBLIC, because a grantee the cluster does not know is refused first (EBMR-SBX-038); only a role dropped between those
  two statements of the call tells them apart.
- Equivalent (marked by the harness): `recipe.role_evaluation_problem` (one), `plant.record_calibration#6`,
  `recipe.genealogy_downstream_lots#1`.
- Residuals: none in the owner's scope.

## Part 2, Stryker: triage (T13)

The four Phase 4 server features that decision 0012 left to deployment. Their Phase 4 reports were lost with that
container, so they ran again in this campaign (`stryker.phase6.config.mjs`, part 2). Same method as T7, T9 and T12
(D-P6j-T7-1, T7-2, T12-1): the TypeScript matters only where it is the sole enforcement point of a Priority 1 rule. Each
such survivor was checked by hand-applying the mutant, running the narrowest test file, then reverting. No Stryker
re-run (owner, 17 October). First-run scores are from `.reports/stryker-phase6/p4-server-*.json`, all zones:

| Feature | Score | Survived | No coverage | Phase 4 (one run, not triaged) |
|---|---|---|---|---|
| p4-server-release | 62.2 % | 24 high-risk zone (90 in all) | 240 high-risk zone (255 in all) | 90.3 % (after-release, index, signables) |
| p4-server-records | 59.1 % | 94 high-risk zone (141 in all) | 133 high-risk zone (203 in all) | records 71.7 %; archive and PQR 47.9 % |
| p4-server-india | 68.9 % | 27 | 66 | 64.6 % |
| p4-server-pqr | 78.9 % | 3 | 1 | (with the archive above) |

The release figure is lower than Phase 4's because the feature now also mutates `reads.ts`, and because `signables.ts`
holds acts that no server test runs (238 no-coverage mutants): the QP intake, its check and the in-system QP
certification, the PPQ outcome, the post-change evaluation, the open-investigation justification and the batch market
act. Each of those acts is a definer that computes the record id itself and checks the signature against it (below).

**Result: no Priority 1 rule was left unenforced, but one high defect was found and fixed (M6-D3).** Three rule clusters
were enforced only in the TypeScript and had no test. All three are now killed by new tests (23 hand-applied mutants
fail them; each test passes on the code). Writing the test for the stored retention found M6-D3.

Common to the four features (one line each, no test; see T7's common list): `requireSession()` (D-P6j-T7-1); the
`idempotencyKey ?? ''` default (`platform.claim_idempotency_key` refuses an empty key, EBMR-PLAT-040); refusal and not-found texts; `rows[0]?.x`
chains and `?? null` defaults of arguments the definer validates again; view mapping; and in
`india/index.ts` lines 376-410 the demo seed (DEMO-ONLY).

### p4-server-release

- **Killed (new test): the two-row release (D-P4-5) consumes both signatures, `signables.ts:240` (1 survivor), and
  the lines after it (241, 242).** The ceremony signs MANUFACTURER_RELEASE and the companion US_DISPOSITION in one
  command. `recipe.record_release_with_us_disposition` checks both signatures (EBMR-DSP-041/042). But nothing in the
  database requires a US_DISPOSITION signature to be consumed. So with the condition `false`, the handler would run the
  manufacturer release alone and leave a signed US disposition with no decision behind it. This is fail-safe for the
  US gate but false as a record. No server test completed a two-row release (a green lot needs a golden batch). Test
  `apps/tablets-server/test/release/release-act-apply.test.ts` (the handler's apply, with a stand-in client): `[IN-05][DI-37] a
  release with the US epoch runs the two-row act with both signatures ...` and `[IN-05][DI-37] a two-row release without
  its US signature runs no act ...`. Hand-applied: the condition `false` and `true`, the missing-companion check removed,
  the two signatures swapped. All four fail.
- DB-enforced, one line: every release act's record id, meaning and signer. `releaseActAggregateId`, `target`,
  `afterReleaseTarget`, `marketChangeTarget`, `witnessTarget` and the BATCH_MARKET_ACT target (survivors 105-106, 142-143,
  190, 302 and the no-coverage lines 79-162, 311-331) are re-derived by each act. `recipe.assert_release_signature` (or
  `esig.signature_problem` in `recipe.record_manufacturer_release`) is called with the id the act computes, in
  `record_qp_transcription`, `verify_qp_transcription`, `record_qp_certification` (outcome to meaning, recipe-core 0826),
  `record_ppq_outcome`, `record_post_change_evaluation`, `justify_open_investigation`, `check_us_disposition`,
  `record_market_change`, `record_disposal`, `witness_disposal` and `record_after_release_decision`. `inputRefusal` and
  the BATCH_MARKET_ACT precheck (lines 194-203, 317-324): the same definers refuse a missing epoch, reason, change record
  or deviation. Line 235 (the QMS fetch condition): `site.qms_release_problem` refuses a release without a fetch in the
  same transaction (EBMR-QMS-013, T12). Line 278 (the market change's reference): `record_market_change` takes a change
  record for ADD and a deviation for REMOVE. Line 248's `?.`: the reject's reason is required by the precheck
  (equivalent).
- `index.ts`: the reads and `requireSession()`; `qpMessage` (reported without coverage although the `[DI-39]` test in `market-routes.test.ts` calls
  the route; the database verifies the message and acknowledges it, `tab.take_qp_certification_message`). `after-release.ts`
  99, 113, 116 and `reads.ts` (other zone): view mapping. The G-REL "since review" acknowledgement shown in
  `reads.ts:66-81` is checked again at the act (`grel_acknowledgement` in recipe-core 0823 and 0826). P3.

### p4-server-records (records and archive)

- **Killed (new test): the retention facts of a batch, `archive/facts.ts` (39 survivors, 28 no coverage; other zone,
  but it feeds the high-risk `syncRetention`; D-P6j-T13-1).** The kernel's engine dates a record from the inputs it is
  given and stores them as given. It does not read the batch. So the market set, the licence form, the outcome, the
  abort or cancellation date and the EU state are derived only here. A dropped market loses that market's rules
  (DI-47: the floor is the maximum over every market's rules) and dates the record too early. Test
  `apps/tablets-server/test/records/archive-retention-facts.test.ts` (five cases, `[DI-47][IN-08]`, `batchFacts` with a
  stand-in client). Hand-applied: the market filter with `m !== 'IN'`, `&&` for `??`, no filter, `(IN && US) || EU`, the EU
  test negated, Form 25A dropped, ABORTED and EXECUTION_COMPLETE not mapped, the abort date `false` and `true`, the
  self-filter of `supports` removed, the rejected-EU branch `false`. All twelve fail.
- **Killed (new test): storing the retention and the dependency links, `archive/index.ts:339-366` (8 survivors, 14 no
  coverage).** Which records depend on which is decided only in the route (a processing record supports the packaging
  records packed from it, DI-47 dependency inheritance). The kernel links what it is told. The existing test reached
  only the refusal without an approved batch-record type. Test `apps/tablets-server/test/records/archive-retention-routes.test.ts`:
  `[DI-47][IN-08] QA stores each batch's retention from its record, a second sync updates it, and the processing record
  follows the packaging record packed from it, whichever is stored first`. Fixtures: an approved record type, a
  packaging allocation under its parent; D-P6j-T13-3. Hand-applied: the `exists` test `false`, `both === 2` `false`, the
  loop emptied, the link's direction swapped, each half of the pair list removed, the scheduled branch of the view
  `false`. All seven fail.
- **Defect M6-D3 (high; DI-41, DI-47, DI-17; fixed in the route, no migration; D-P6j-T13-2).** The retention view's
  scheduled branch (`archive/index.ts:91-102`, no coverage) read `records.retention_of` as the application role. Tablets
  0460 (F34) revoked that reader from the role on purpose: its refusals name a blocking data-integrity investigation.
  So once a batch's retention was stored, three things failed. `syncRetention` answered 500 "nothing was saved" after
  its command had committed the schedule. The archive's batch page answered 500. The batch's evidence export could not
  be assembled (`buildExport` puts the retention in the export's summary). Found while writing the test above, which
  failed with the 500 before the fix. Fix: the view reads the same own retention, effective retention and latest
  stored inputs from what the role may read: `records.evaluate_retention` over the latest `records.retention_input`
  (as `records.own_retention` does), and `records.compute_effective_retention`. F34 stands, and the second test checks
  that it does: `[DI-41][DI-47][DI-17] a batch whose retention is stored still opens in the archive and is exported with its stored
  retention, read without the investigation-revealing kernel reader`. Reverting to `retention_of` fails both tests.
- DB-enforced, one line: the archive's signed acts (ARCHIVE_ACT: `records.certify_evidence_export`,
  `records.sign_form_reconciliation`), the disposal request (`records.request_disposal`, RECORD.RETENTION_MANAGE), the
  contingency packs and form events (the `[DI-43]` test proves the database refuses a pack for an ended batch), the true
  copy (`records.true_copy_snapshot`, RECORD.TRUE_COPY_REGISTER) and the export file (`records.read_evidence_export`,
  EBMR-REC-127). The inspection workspace's TypeScript permission check (ARCHIVE.INSPECT, line 420) is the route's own
  gate and is killed by the existing `[DI-40]` test. Records: the record lock acts (`recipe.open_record_amendment`,
  `recipe.close_record_amendment`, both `assert_release_signature` with the id they compute, RECORD.QA_REVIEW), the
  amendment entries, the bulk reconciliation and the bright-stock hold (`recipe.append_amendment_entry`,
  `recipe.close_bulk_reconciliation`, `recipe.set_bright_stock_hold`). `records/signables.ts` had no survivors, and its
  15 no-coverage mutants are the targets and prechecks those definers re-derive.
- P3: `verify` (441, 450; the offline verifier is the kernel's, and a non-string hash finds no registration), the
  drift lines (99-101, display), `records/reads.ts` and the archive views.

### p4-server-india

- No TypeScript-only rule. INDIA_ACT: `site.approve_manufacturing_licence` and `site.approve_export_permission`
  (`esig.assert_signature` with the record's id, LICENCE.APPROVE), `plant.approve_product_hazard` and
  `plant.approve_area_dedication` (`plant.assert_hazard_approval`, second person, HAZARD.APPROVE). Licences, export
  permissions, stability bases, hazards, the H2 payload and its verification are definers. The `check` route is a
  pre-check shown on the screen; the issue gate refuses in the database (recipe-core issue gate, SQL group
  india-issue-gate). `label`'s particulars are the database's `recipe.india_label_particulars`, mapped for display.
  Line 361 (a hazard record with neither part): nothing is recorded either way. The 27 survivors are of the common
  kinds. P3.

### p4-server-pqr

- No TypeScript-only rule. `recipe.run_pqr_extract` and `recipe.sign_off_pqr` (`assert_release_signature`,
  PQR_SIGNED_OFF on the extract's own id). Survivors: `requireSession()` (25, 29) and the sign-off's response object
  (`signables.ts:23`). `reads.ts`: view mapping. P3.

### Owner observation

- O-T13-1: a route that commits its command and then builds its answer outside it says "Nothing was saved" when only
  the answer failed (M6-D3 showed it: the schedule was stored). This is the general pattern of the server's routes
  (`withIdempotentActorCommand`, then a read), and the idempotent replay returns the stored result. A wording or
  structure change across the routes is the owner's call; it is not a mutation finding.

## Equivalent mutants

pending (`tools/sql-mutation/equivalent.json`; Stryker equivalents listed here with the reason)

## Real defects fixed

pending

## Residuals for the owner

pending

## Run plan

### Constraints found while preparing

- **One cluster, one harness process with `--own-cluster`.** Between groups that process drops every `ebmr_%`
  database created since it started and not in use, which includes another run's templates on the same cluster. A
  second process on a cluster runs without `--own-cluster` (its own databases are still dropped at its end), and on
  5432, which other work shares, no process uses it.
- **About four test files per cluster at once.** The roles' connection limits are per cluster (kernel 0970:
  `ebmr_listener` and `ebmr_sandbox_listener` 40, `ebmr_app` and `ebmr_sandbox` 57, `ebmr_report` 4). Unlimited, Vitest
  runs a file per core, and the device-readings group's baseline fails with "too many connections for role
  ebmr_sandbox_listener" even alone on a cluster. `EBMR_MUTATION_VITEST_WORKERS` caps it: keep `--workers` times the
  cap at about 4 per cluster (`--workers 2` with a cap of 2), and Stryker's server features at concurrency 2 on a
  cluster no harness uses.
- **Separate report directories.** Each process writes its own `--out` directory (`report.json` after every mutant,
  `summary.md` at its end). Parallel runs never share one.
- **Resume.** A stopped process is started again with the same command plus `--resume`: the results its `report.json`
  holds for the same mutations are kept, the rest run (a fully kept group skips its baseline). A confirmation run
  (`--only`) uses a new `--out` directory and no `--resume` against the first run's report, which would keep the very
  results it is meant to replace. Stryker resumes by itself from the feature's incremental file (same command).

### Estimates

Worker time per mutant is taken as 0.9 times the group's baseline (db plus server, measured alone on 5433) and at least
6 s: the smoke run gave 8.8 s for a 10 s baseline, with 72 % killed (a killed mutant stops at its first failing file).
Running ten or more workers on 16 cores slows each one; the wall times below add a third for that.

| Group | Mutants | Baseline (s) | Worker hours |
|---|---|---|---|
| equipment-data-and-alarms | 469 | 46 | 5.4 |
| genealogy-and-recall | 440 | 49 | 5.4 |
| erp-wms-receipt-and-stock | 351 | 43 | 3.8 |
| transfer-and-federation | 393 | 37 | 3.6 |
| qms-capa-lims-cmms | 401 | 17 | 1.7 |
| packaging-labels-and-line-completion | 352 | 17 | 1.5 |
| inbound-adapters-and-mirrors | 310 | 17 | 1.3 |
| plant-rules | 221 | 21 | 1.2 |
| governance-support-and-contract-giver | 228 | 16 | 0.9 |
| controlled-substance-mode | 311 | 8 | 0.6 |
| governance-change-control | 117 | 10 | 0.3 (done in the smoke run) |
| reporting-and-training, india-dsc, serialisation-l3 | 388 | 5 to 6 | 0.7 |
| re-created functions in earlier groups (`--functions`) | 202 | 10 to 66 | about 0.8 |
| **Part 1 SQL** | **4,183** | | **about 27** |

Stryker, part 1: about 1.3 mutants per source line, three quarters of them tested (the rest static or not covered),
about 7 s of worker time per tested server mutant (`server-serialisation`: 97 tested in 330 s at concurrency 2,
including a 30 s dry run) and a few seconds per unit mutant whose tests start an OPC UA server (gateway, simulators;
the SDK's tests take a fraction of a second). The server features hold about 6,800 lines (about 13 worker hours),
the gateway and the simulators about 4,200 (about 4), the kernel's config and DSC modules 450 (about 1): **about 18
worker hours**.

With 12 workers, part 1 takes about **4 to 5 hours of wall time**, inside its 12-hour box; the triage and new tests
come on top, and one confirmation run per group (`--only` on the survivors that new tests aim at) is a fraction of the
first run.

Part 2 (baselines of all 80 earlier groups measured alone on 5433, all green with the cap of 4 test files):

| Item | Mutants | Worker hours |
|---|---|---|
| Scope A groups (release-gate, release-gate-market-items, manufacturer-release, tablets-release-items), run whole | 710 | 4.3 |
| Scope B groups (the six after-release, shipping, locking, bulk and form groups), run whole | 695 | 5.6 |
| us-disposition, qp-certification, market-changes, first runs | 481 | 4.3 |
| Stryker: server release feature (high-risk files first) and the triage of the Phase 4 survivors | | about 3 |
| **Whole SQL re-run of the 80 earlier groups** (scope A and B included) | **17,553** | **about 128** |

The scope A and B confirmations are best run as whole-group runs: the Phase 4 survivor lists are not in the repository
(the reports were lost with the container), several of their functions have been re-created since (their mutants are
renumbered), and a whole run of those ten groups costs about 10 worker hours. Those ten runs are also the first part of
the whole re-run.

**The whole re-run does not fit part 2's 8-hour box**: about 128 worker hours is 11 hours of wall time with 12 workers
before the slowdown, 14 with it. The largest groups are market-authorisation-and-issue (14 worker hours),
lots-and-lims (9), mbr-lifecycle (8), manual-weighing-gate (7) and tablets-ipc (6). Inside the box: the scope A and B
groups and the three Phase 4 groups first (about 2 hours of wall time), then the earlier groups in the order of decision
0019's Priority 1 subjects (signing, signature invalidation, audit trail, segregation and grants, release and serial
gating, limits), the rest a residual for the owner.

### Commands

From the worktree, after `pnpm install --frozen-lockfile`, in a shell that outlives the session (`tmux`, or each
stream under `nohup bash -c`). SQL, five processes of 2 workers each (cap 2 test files per
mutant), one per cluster:

```bash
export EBMR_MUTATION_VITEST_WORKERS=2 EBMR_MUTATION_TEST_TIMEOUT=120000
sql() { # <port> <out name> <groups> [extra flags]; runs in the foreground
  EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:$1/postgres \
    pnpm -s mutation:sql --group "$3" --workers 2 --out .reports/sql-mutation/$2 "${@:4}" > .reports/sql-mutation/$2.log 2>&1
}
mkdir -p .reports/sql-mutation
(sql 5434 p6-1 equipment-data-and-alarms --own-cluster) &
(sql 5436 p6-2 genealogy-and-recall --own-cluster) &
(sql 5437 p6-3 erp-wms-receipt-and-stock,plant-rules,india-dsc --own-cluster) &
(sql 5438 p6-4 transfer-and-federation,qms-capa-lims-cmms --own-cluster) &
# 5432 is shared: no --own-cluster; the functions Phase 6 re-created in earlier groups follow on the same stream.
(sql 5432 p6-5 inbound-adapters-and-mirrors,packaging-labels-and-line-completion,governance-support-and-contract-giver,controlled-substance-mode,reporting-and-training,serialisation-l3,governance-change-control
 sql 5432 p6-6 plant-equipment-and-areas,release-gate,tablets-release-items,read-authorisation,connection-roles,mbr-lifecycle,after-release-suspension,pqr-extract,lots-and-lims \
   --functions plant.fitness_problems,plant.record_calibration,recipe.grel_evaluate,tab.grel_recon_serial,tab.record_read_problem,sandbox.apply_connect_policy,sandbox.segregation_problems,recipe.guard_critical_elements_risk_assessed,recipe.genealogy_downstream_lots,recipe.pqr_run_query,site.lot_available) &
```

After a restart: the same stream with `--resume` added to each `sql` line. Progress: `grep -c . .reports/sql-mutation/<out>.log`
or the `n/N` lines; scores: `.reports/sql-mutation/<out>/summary.md`. governance-change-control runs again (7
minutes): the smoke run was on the preparation branch, before 6j-a and 6j-b were merged.

Stryker, two features at a time on 5433 (server and db features, concurrency 2), unit features alongside (no database):

```bash
st() { # <feature> [port]
  EBMR_STRYKER_FEATURE=$1 EBMR_STRYKER_CONCURRENCY=2 EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:${2:-5433}/postgres \
    nohup pnpm exec stryker run stryker.phase6.config.mjs > .reports/stryker-phase6/$1.log 2>&1
}
mkdir -p .reports/stryker-phase6
(for f in server-integrations server-transfers server-governance server-genealogy server-controlled server-labels \
          server-quality-receipt server-dashboards-and-training server-serialisation; do st $f 5433; done) &
(for f in kernel-config-and-dsc server-plant-rules server-config-change server-capa server-alarms server-equipment-data \
          server-designer-hazard; do st $f 5433; done) &
(for f in sdk-adapter sdk-equipment-data gateway-opcua simulators; do st $f; done) &
node stryker.phase6.config.mjs --summary      # per feature and zone, from the JSON reports
```

`server-serialisation` and `sdk-adapter` run again too (their smoke runs were on the preparation branch). A feature not done within an
hour is stopped and run again with `EBMR_STRYKER_HIGH_RISK_ONLY=1` (decision 0019); its incremental file keeps the
mutants already tested. When the SQL streams end, their clusters take the remaining server features (`st <feature>
5434`, and so on), one Stryker run per free cluster.

