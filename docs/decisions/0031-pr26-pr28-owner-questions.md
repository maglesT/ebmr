# Decision record 0031: owner questions on PR-26 clause 2 and PR-28 clause 2 (deferred until answered)

- **Date:** 13 November 2026
- **Decided by:** the lead (session_01PybpFrP72XuwyG8S3H3NJS), for the injectables edition exit (I-6). The lead puts the
  two questions below to the owner in plain words. Prepared by build session 17.
- **Concerns:** PR-26, catalog-test clause 2 ("Scanning a hose to the wrong destination blocks the transfer."), and PR-28,
  catalog-test clause 2 ("An open EM excursion appears on the QP screen."). Both are deferred to phase 8 with the reason
  "owner question, decision 0031" until the owner answers. Their `expert_decision` stays PENDING. Only the owner sets it.

## Context

Both clauses were deferred to phase 5, the Injectables edition (decision 0011, `docs/build-plan/phase-4/trace-deferrals.md`).
The I-6 exit adds `injectables` to `compliance/phase.yaml`, so the trace gate counts phase 5 as started and needs each
clause tested, or `not_required` (which needs a MODIFY `expert_decision`), or deferred to a later phase. Neither clause is
built as worded, and neither control has an owner decision. So each clause is deferred to phase 8 and stays visible as
DEFERRED in the matrix until the owner answers.

The lead may apply the owner's minimum-compliance rule (19 October 2026; 7 November 2026: only binding clauses) once each
clause is checked against `docs/regulatory/sources-extracted/`. Where no binding clause asks for the missing piece, the
lead's recommendation is `not_required`, but the change of `expert_decision` to MODIFY stays the owner's. Clause
references below are paraphrased.

## Question 1: PR-26 clause 2, the transfer-route scan

- **Binding clauses.**
  - Schedule M (revised) Part I 18.4.7 requires checks that pipelines and other equipment used to move product between
    areas are connected correctly.
  - EU GMP Chapter 5 5.14 asks the same.
  - Neither prescribes how the check is made. A scan of the source, the route components and the destination is the
    catalogue's design choice (PR-26 behaviour), not a clause.
- **What exists.**
  - PR-26 clause 1, the room clearance before a start, is tested.
  - Containers carry labels and are scanned to their destination (IN-26, PR-21).
  - Equipment fields name the vessels and lines a step uses and refuse a unit of the wrong class or fitness: INJ-COMPOUND's
    compounding vessel, INJ-STERILE-FILTER's receiving vessel, INJ-FILL's filling line.
  - The capsule liquid-fill block asks a yes/no check of its line connections (EU 5.14).
- **What is missing.** No injectables block asks the connection check of a product transfer through pipework or a hose.
  Nothing scans the hose or transfer panel and compares it with a route in the master.
- **Options.**
  - (a) A yes/no connection check ("transfer line connected from <source> to <destination> as the master says"), with a
    second-person check, in INJ-STERILE-FILTER, as a v1 edit before the first install. This meets 18.4.7 and 5.14.
    Effort: under half a day with tests. Recommended as the minimum.
  - (b) The full route scan: route components as master data, a scan of each, refused on mismatch. A new slot kind and
    plant data. Effort: several days. Beyond the binding clauses.
  - (c) Neither: `not_required` for the scan, with (a) recorded as the minimum the firm adds through its own block.

## Question 2: PR-28 clause 2, an open EM excursion on the QP screen

- **Binding clauses (EU-market product; Annex 1 is binding for the EU, owner Q0).**
  - Annex 1 3.2 asks that non-conformities, environmental monitoring excursions among them, are investigated before the
    batch is certified or released.
  - Annex 1 9.3 asks that monitoring information is used in routine batch certification or release.
  - Schedule M lists environmental monitoring among the sterile-area controls but names no certification screen.
  - 21 CFR 211.192 asks that unexplained discrepancies are investigated before release.
  - No clause names a QP screen.
- **What exists.**
  - The batch's EM results are in its record (INJ-EM, INJ-EM-COUNTS), with alert and action tiers.
  - An action-tier breach is an exception that holds the step until QA dispositions it under a deviation.
  - A linked deviation that is open keeps release refused (decision 0029; ST-36).
  - The release gate is RED while the batch's EM counts are not in (ST-24).
  - So an excursion recorded in the batch record cannot be passed over at release.
- **What is missing.**
  - A dedicated list of open EM excursions on the certification screen. The QP package is frozen (decision 0026).
  - Excursions recorded outside the batch: the room-level EM logbook between batches, deferred by the owner on
    13 November 2026 ("not now").
- **Options.**
  - (a) Accept the release gate's hold as meeting 3.2 and 9.3. The excursion's deviation and the gate item show on the
    release screen, and no separate QP view is built. Recommended as the minimum: `not_required` for the screen itself.
  - (b) Add an "EM excursions of the batch" item to the release checklist that lists each action-tier breach and its
    deviation state. Effort: about one day with tests.
  - (c) Build it with the room EM logbook, when the owner takes that up.

## Consequences

- PR-26 and PR-28 stay SPECIFIED, and their clause 2 shows DEFERRED (phase 8) in the trace and the matrix.
- When the owner answers, a follow-up either builds the chosen option with its `[PR-26]` or `[PR-28]` test, or records
  the MODIFY decision and marks the clause `not_required` citing this record.
