# Phase 4 review backlog

## Slice 1 quick review (12 October 2026)

Fixed in slice 1 with regression tests: container work in the INV-35 involvement set; the batch evidence epoch moves
when a consumed lot's status or LIMS results change; epoch bumps limited to the audit review's scope and window; the
high-water mark taken from the signed content; item dispositions re-opened with the review cycle; QUERIED, RESPONDED
and ESCALATED gated on GMP; a weighed close from one balance within the container's window; audit scope widened to
IPC checks, device readings, campaigns and a packaging order's parent containers.

Backlog:
- Low: the epoch triggers run a lookup on every `kernel.audit_event` insert (measure with the performance baseline).
- Low (by design): `container_release_problem` skips ALERT-severity exceptions with no deviation.
- Deployment: the GMP sweeper's secret is written to a plaintext demo file (`gmp-service-keys.json`); production needs a
  secret store.
- Test gap (slice 1 fix 6): the rule that a critical item is escalated only after its detail was opened (EBMR-REV-055)
  has no test yet; add it with the slice 1c screens or in slice 2.
- Note: recipe-core 0719 sets `check_function_bodies = off` because it names a table that recipe-core 0740 creates;
  apply order is by file number within a source, so 0719's functions are only called after 0740 exists.

## Slice 2b open items (builder report, 12 October 2026)

- For slice 3 (G-REL): wire `site.extra_testing_problem`, `site.lot_sample_problem`, `tab.finished_lot_of` and the
  release of a finished lot out of QUARANTINE into the release evaluator.
- Residuals: MBR IPC limits are not part of the pharmacopoeia-edition review; API retention "one year after the last
  product lot containing it" and the US annual visual examination of reserve samples are not built; return to stock
  and the chemical-recovery act of returned goods wait for the release model and reprocessing.

## Slice 2c open items (builder report, 12 October 2026)

- The e2e demo seed `--gmp-packaging` marks its second batch released for packing with a demo shortcut (a superuser
  update with triggers off and a placeholder hold-point signature in the stored state). It is test data only, but it
  must be replaced by the real H-PACK signature through the routes in slice 3 (with the release cockpit) so no demo
  record carries a placeholder signature.
- The deviation screens take the owner as a typed person id; the deviation contract needs person names (slice 3
  screens).

## Slice 2 quick review (12 October 2026)

Fixed in slice 2 with regression tests: evidence matched by hash alone in recipe-core 0601 and 0716 (now the stored
bytes must match, DI-24); the deviation classifier and the impact recorder excluded from concluding, closing and
signing the impact; the demo-shortcut seeds refuse a non-demo database; a link with CONFIRMED impact keeps release
blocked after the deviation closes (D-2a-9, open for the owner); the OOS cited on a RELEASE-result revision must be
about that test.

Backlog:
- Medium: `packaging_master_problem` (recipe-core 0761) accepts TB-24 anywhere in the procedure, including an optional
  branch; require it on every completing path (slice 3 or the flow validator).
- Medium (Injectables): `recipe.packaging_completion_block` has only the Tablets row, so an Injectables packaging order
  is refused until its edition adds one (Phase 5).
- Low: `tab.post_finished_lot` does not check the posted quantity against the packed counts (slice 3, with
  reconciliation at release); pharmacopoeia edition marking is a role check without a signature; `tab.reels_in_use` is
  declared immutable but calls recipe functions.

## Slice 3c open items (builder report, 12 October 2026)

- Residual (lead's decision, option b): the `--gmp-packaging` demo seed keeps its labelled DEMO SHORTCUT for the bulk
  parent's H-PACK (behind the two-step demo gate). A real H-PACK through the routes needs a valid GMP master run to its
  end: the designer gate requires every BOM line consumed, a clearance and a yield per material stage (GMP-BOM-CONSUMED,
  GMP-STAGE-CLEARANCE, GMP-STAGE-YIELD), and the ERP order needs at least one BOM line matching the master exactly
  (recipe-core 0602), so a short "hold point only" master is refused. GB-T-01 proves the real path (golden batch
  `stages.ts`); the slice 7 golden batch GB-T-02, which runs to release, gives the e2e packaging demo a real parent.
- Residual (lead's decision): the release e2e covers the flow up to a signed REJECTION of a NOT_READY lot (queue, red
  and green items with evidence, since-review acknowledgement where one exists, the signed rejection, both departments
  notified and acknowledging). The green-items release path in the browser waits for GB-T-02 (slice 7); it is proven
  in the database (recipe-core release tests) and on the contract examples (web tests).

## Slice 3b open items (builder report, 12 October 2026)

- `since_review` is false on every Tablets edition item until slice 3a's epoch comparison feeds it.
- No server route or screen yet for the compendial rule-set verification (slice 3c or slice 4 screens).
- IN-17 clause 2 stays deferred in its control file; the slice 7a mapping cites `grel-tablets-items.test.ts`.
- Test names carry the tags [L-30] and [TB-11], which are not control files (outline rule and block ids); the register
  ignores them. Keep or retitle at the slice 7a mapping.
## Slice 3a (builder report, 12 October 2026)

- Ticked: the slice 2b items for slice 3 (extra testing, samples, finished lot out of quarantine through the release).
- Open: `tab.post_finished_lot` quantity against the packed counts stays with 3b's reconciliation item (group 4).

## Slice 3a open items (builder report, 12 October 2026)

- Open for the owner (D-P4-6): with India treated as the EU, a process-validation (PPQ) batch's manufacturer release
  always waits for the validation outcome; concurrent release applies to US-only batches.
- Residuals: ancestor intermediates are not in the G-REL evidence set (the packaging batch and its processing parent
  are); critical alarms (DI-49) are not read by G-REL; the extra sampling for linked changes and deviations (11.3.9 (f))
  is not checked; finished lots posted before material-lot machine version 2 cannot be released (the gate says why).
- Kernel note: `esig.signature_state` does not return the signer role or delegation; the release act reads them from
  `esig.signature`.

## Slice 3a open items (builder report, 12 October 2026)

- Open for the owner (D-P4-6): with India treated as the EU, a process-validation (PPQ) batch's manufacturer release
  always waits for the validation outcome; concurrent release applies to US-only batches.
- Residuals: ancestor intermediates are not in the G-REL evidence set (the packaging batch and its processing parent
  are); critical alarms (DI-49) are not read by G-REL; the extra sampling for linked changes and deviations (11.3.9 (f))
  is not checked; finished lots posted before material-lot machine version 2 cannot be released (the gate says why).
- Kernel note: `esig.signature_state` does not return the signer role or delegation; the release act reads them from
  `esig.signature`.

## Slice 3 quick review (12 October 2026)

No critical or high findings: RED items block every release path, the evaluation and signing race is closed by the
epoch locks, the signer, delegation, involvement and since-review rules hold, a finished lot leaves quarantine only
through the release decision, the edition hook fails closed, PPQ concurrent release is US-only, and no signing meaning
or guard was lost. Fixed in slice 3 with tests: every deviation link checked structurally under PR-53 (no message-text
matching); CONFIRMED impact never justifiable (D-3a-10, open for the owner); escalated exceptions count as linked;
Tablets items carry since_review; the printed-tablet QC reads the live signature state; rule sets, printed tablets in a
library call and a printing master without a G-21 instance fail closed (RED) instead of NA.

Backlog (low): G6.PPQ and `record_ppq_outcome` default the purpose to COMMERCIAL when the header has none (the
validator should require it); `recipe.release_lots` and `release_lot_facts` are readable by any session (read-only).

## Slice 3c open items (builder report, 12 October 2026)

- G-11 environment excursion notifications are still recorded only in the engine, not in the notification centre.
- IN-39 clause 2 stays deferred in its control file until the slice 7a mapping cites `notification-centre.test.ts`.
- Default: the PRODUCTION department is HEAD_OF_PRODUCTION and SHIFT_SUPERVISOR; QA is AUTHORISED_PERSON, QA_REVIEWER,
  QA_SHOP_FLOOR and QA_MBR_APPROVER (notification routing).

## Slice 4a open items (builder report, 12 October 2026)

- `recipe.suspend_release` stays the 4-0 stub: slice 5 builds the manufacturer suspension and must call
  `recipe.cascade_market_dispositions(lot, cause)` in the same transaction (decided markets already read
  RELEASE_SUSPENDED while the manufacturer release is not RELEASED).
- No route or screen registers EU importers or QPs (`recipe.register_eu_importer`, `recipe.register_qp`, QA signed); the
  seed has no US QCU or EU QP persona (4c, demo).
- Residuals: market-add items for stricter step keys, label rules, retention and the injectables items; the identity item
  has no test with consumed lots (golden batch, slice 7); the message acknowledgement is not signed by the server.

## Slice 4a and 4b open items (builder reports, 12 October 2026)

- `recipe.suspend_release` is a stub until slice 5, which calls `recipe.cascade_market_dispositions`.
- No route registers EU importers or QPs (database acts only); the screens and seed add what the demo needs.
- Market-add evaluation does not yet cover stricter per-step keys, label rules, retention and the Injectables items.
- The DI-39 acknowledgement is not signed by the server.
- The QP package is stored in full in an audited row, so its size grows the audit trail (measure with the
  performance baseline).
- Defaults: D-4a-1 (one authentication per challenge for the two-row release), D-4a-3 (controlled release from the
  master's dosage form; release-rate test per active), D-4a-8 (EU certification not gated on the QP package);
  D-4b-3 (a CERTIFIED EU lot may ship to the named importer outside quarantine; before certification it ships only in
  quarantine), D-4b-4 (post-entry change list from UPDATE events; the CoA from the lot's current results).
- Kernel fix in 4b: true copies of insert-only tables without an `id` column now match each row to its own INSERT
  event (records true-copy verifier).
