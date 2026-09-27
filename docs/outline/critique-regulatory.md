# Regulatory critique of build-outline.md v0.1

Reviewer stance: GMP compliance auditor (Revised Schedule M, 21 CFR 210/211 and Part 11, EU GMP Ch.4/5 and Annexes 1/11/16). This lists problems only. Regulation text is paraphrased. "O:NNN" means build-outline.md line NNN. Catalog references use the control ID plus the file name. Primary-text references give the file in `primary/` and a line number.

Severity: **critical** = as written, the build would release product in breach of binding law or would block a legal release route. **major** = a control is omitted, weakened or contradicted, or the engine logic gives a wrong result in a reachable case. **minor** = wording, a citation, a consistency point, or a missing detail with low direct risk.

---

## A. Release models and market dispositions

### R-01 [critical] Market dispositions are modelled as independent, but India AP certification must come before any market's release
- **Outline section:** 5.2 Market disposition (O:286-288); INV-39 (O:352); S32 "markets are independent" (O:288, O:497).
- **Problem:** "India" is modelled as one more peer market. Its disposition cannot affect the US or EU disposition (INV-39). But the Indian AP release is not a domestic-market decision. It is the licence holder's certification that must exist before the lot is sold or supplied anywhere, exports included. As written:
  - a US QCU disposition by a separate QCU signer can reach RELEASED before, or without, the AP's certification;
  - an AP rejection does not stop a US or EU release;
  - the "one signing act records both meanings" shortcut (O:287) puts two dispositions in one signature row. INV-39 then cannot hold, because invalidating one market's disposition (UNDER_AMENDMENT, O:283) either invalidates the shared signature or leaves a signature covering content it no longer matches.
- **Evidence:**
  - Schedule M Part I 11.3.8: no batch released for sale or supply before AP certification (primary/india-schedule-m-2023.txt:157-158).
  - Schedule M section 1 PQS list, item (i): products not sold or supplied before the AP certifies (india-schedule-m-2023.txt:997-999).
  - IN-05(a)-(c) and B-23 (digest-india.md) make the AP release the gate for every batch.
  - Features A.6 describes the US case as an AP release that *also* meets 211.192; it is not a separate peer.
- **Fix:**
  1. Split the disposition model into a lot-level **manufacturer release (India AP, always)** and per-market dispositions (US QCU, EU QP reference).
  2. Add to G-REL for US and EU: "India AP release for this lot is RELEASED and not invalidated".
  3. Add a cascade: an AP rejection, or invalidation of the AP release, moves every dependent market disposition to NOT_READY or REJECTED in the same transaction.
  4. Rewrite INV-39 as "one market's disposition never changes another market's; the India AP release is a precondition of all, never a peer".
  5. Replace "one signing act records both meanings" with one signing ceremony that writes **two signature rows**, each with its own meaning, manifestation, content hash and invalidation lifecycle (11.50(a)(3); DI-35 lists QU disposition as its own signature type).

### R-02 [major] The ERP interlock blocks every EU export, because EU certification happens after importation
- **Outline section:** 4.6 ERP row, "no shipment of unreleased or uncertified stock" (O:237); 5.2, "ERP cannot ship unreleased or uncertified stock (DI-39)" (O:288); Assumption 2 (O:93).
- **Problem:** The outline itself says the EU importer's QP certifies after importation, outside this system. An Indian lot can therefore never be "certified" while it is still in India. If ERP refuses to ship uncertified stock, EU-destined lots can never leave the site. Sites will then work around the interlock, for example by releasing to a fake market, and the quarantine control is lost.
- **Evidence:**
  - PR (b) "EU: QP certification": for third-country batches the importer's QP certifies after importation.
  - India correction 8 (digest-india.md:24).
  - DI-39's interlock is about stock moving to *saleable* status, not about the export shipment.
- **Fix:** Define a lot status "AP-released, EU-certification pending". ERP may ship lots in this status only to the EU MIA holder named in the technical agreement, as quarantined goods. The EU market status stays AWAITING_QP_CERTIFICATION, and ERP/WMS must never turn it into saleable EU stock. State the rule as: "no shipment to a **customer** or **saleable location** of a lot without AP release, and for the EU without a recorded QP certification; shipment of AP-released lots to the EU importer under quarantine is allowed."

### R-03 [major] The EU QP batch package is missing, and the certification reference is typed in by hand
- **Outline section:** 5.2 EU branch (O:287); 7.3 release cockpit ("EU tab ... with the reference field"); Phase 4 (O:605).
- **Problem:** With the in-system QP switch OFF (the default), the outline gives the EU importer's QP no defined way to see the complete record, the audit trail, or flags on changes to critical data. The outline only captures a reference that QA types in, which is a transcription of a third-party decision with no verification.
- **Evidence:**
  - EU Ch.4 4.27: all records available to the QP, plus a system that shows special observations and changes to critical data (primary/eu-ch4-2011.txt:350-353).
  - PR (b) EU bullet list ("give the QP the complete record, plus flags and audit trails").
  - DI-39: notice of certification arrives as a structured, signed, acknowledged message defined in the technical agreement.
  - DI-30: transcribed values need second-person verification.
- **Fix:**
  - Add a Phase 4 deliverable, the "EU QP batch package". It is a signed true-copy bundle (DI-41) of the processing and packaging records, the audit-trail review record, a list of every post-entry change to critical data, deviations with their per-market assessments, and the AP release. It can be delivered as a package or through a read-only, time-boxed QP account scoped to the lot.
  - Take in the QP certification as a structured, signed message (certifier name, MIA number, date, lot). A manual entry is allowed only as a fallback flagged "transcribed" and verified by a second person.
  - Add the manufacturer's batch certificate/CoA required by the technical agreement to the package (Annex 16 content is not in the uploaded texts: verify).

### R-04 [major] G-REL leaves out Schedule M 11.3.9 AP checks and 11.3.7 finished-pack examination
- **Outline section:** G-REL (O:286); India branch (O:287).
- **Problem:** G-REL has no check that:
  - licence and product-approval conditions are met for the batch;
  - principal manufacturing and test processes are validated;
  - planned changes or deviations were notified through the reporting system (and to the licensing authority where needed) before release;
  - any extra sampling or tests triggered by changes or deviations were done;
  - the finished pack was examined.

  IN-05(c)-(d) also requires the release checklist to be stored with the release record. Separately, UNDER_AMENDMENT on a released lot (O:283) only says "QA decides on released stock". It does not trigger a recall/market-impact assessment by the AP, who under Schedule M section 7 owns recalls.
- **Evidence:**
  - Schedule M 11.3.9(a), (c), (e), (f) (india-schedule-m-2023.txt:212-214, 223-227).
  - Schedule M 11.3.7, examination of the finished pack (india-schedule-m-2023.txt:148-153).
  - IN-05(c)-(d); IN-29 (AP owns recall execution).
- **Fix:**
  - Add G-REL items: "licence/approval conformity for this product, strength, pack and market"; "regulatory-notification assessment recorded for every linked change and deviation, with licensing-authority reference where required"; "extra sampling/tests for linked changes and deviations complete"; "finished-pack examination recorded (TB-24 or injectables equivalent)".
  - Store the evaluated checklist with the release signature.
  - Make an amendment of a released lot open an AP-signed market-impact/recall assessment for each released market.

### R-05 [major] The justified open-investigation release path (PR-53) is not excluded for sterility-assurance investigations
- **Outline section:** G-REL (O:286); 3.5 policy switch "release with an open investigation by e-signed justification" (O:149).
- **Problem:** The only exclusions are reconciliation discrepancies and registered-specification failures. In the Injectables edition a tenant that turns the switch on could release a sterile lot while any of these is still open:
  - a Grade A growth investigation;
  - an EM action-excursion investigation;
  - an APS-failure impact review;
  - a filter-integrity failure;
  - a sterilisation-cycle deviation;
  - a sterility-positive investigation.

  INV-23 only says release waits for excursion *assessments*, so it does not stop this either.
- **Evidence:**
  - ST-21: release blocked until the Grade A investigation closes with a batch-impact disposition.
  - ST-68 [EU hard]: a passing sterility test never overrides an open nonconformance.
  - ST-71: sterile release needs each investigation closed or formally assessed as not affecting the batch.
  - ST-33 and Annex 1 9.46(iv)(b), (v) (primary/eu-annex1-2022.txt:2866-2874).
  - Features F.2 A14 already adds the [I] exception that the outline dropped.
- **Fix:**
  - In the Injectables edition, lock PR-53 closed for every investigation of these classes: sterility-assurance, EM/PM action, APS, filter integrity, sterilisation/depyrogenation/SIP, CCI, sterility or endotoxin.
  - Change INV-23 to "release waits for all EM results, and every linked sterility-assurance investigation is closed or formally concluded no-impact for this batch".
  - Add a bypass test that tries the justification path on an open Grade A investigation.

### R-06 [major] "Approved technical staff" (S17) is configurable, although every batch is made under an Indian licence
- **Outline section:** 7.2 Configurable, S17 (O:498); Assumption 1 (O:92).
- **Problem:** The outline assumes every batch is India-licensed, yet S17 can be switched off. Turning it off would let people outside the licensing-authority-approved staff register sign production-supervisor and QC-approval steps on every batch.
- **Evidence:**
  - IN-04(d): only registered approved staff sign these steps on India-licensed batches.
  - Drugs Rules 71/76 (status S) and Schedule M 11.3.2.
  - Features A.5 lists S17 as CONFIG only "for India-licensed sites", and under Assumption 1 that means all sites.
- **Fix:** Move S17 to Locked (O:497) and add it to the E.2 "never changeable" list (O:52). Keep only the register content configurable. Mark the Drugs Rules basis "S, confirm".

---
## B. Market-profile engine logic

### R-07 [major] A market-set change after issue only triggers "re-resolve + QA review"; rules already executed cannot be satisfied afterwards
- **Outline section:** 3.3 Stored (O:133); Phase 4 demo, "a market-set change forces QA review" (O:605).
- **Problem:** Re-resolving at release time does not change what happened on the floor. Examples:
  - US is added after single-verifier dispensing or charge-in under S5a (211.101(c)-(d)).
  - EU is added after a filter was used across two lots, or after PUPSIT was skipped (Annex 1 8.87, 8.94).
  - EU is added after a lot released on India's vendor-history route (identity test only per EU 5.35) was consumed.
  - US or EU is added to a batch whose MBR version was never valid for that market.

  "QA review" makes this a discretionary acceptance. The outline also does not guard **removal** of US or EU after a failure against that market's stricter rule ("market shopping"), and does not require the processing batch's market set to cover every packaging order's destination.
- **Evidence:**
  - IN-52 (re-resolve on change).
  - PR (b) "One batch for several markets" 1-2: the master must be effective for every market, and the process must run inside the intersection of registrations.
  - 211.101(c)-(d); EU 5.35; Annex 1 8.87/8.94; INV-01 (MBR in scope at issue).
- **Fix:** Specify a **market-add evaluation**. It re-runs every resolved rule for the new set against the *recorded* data, including:
  - verifier counts per step;
  - filter use and PUPSIT records;
  - identity-test route of every consumed lot;
  - MBR validity per market;
  - IPC intervals;
  - line APS/EM status under the new acceptance rules.

  Any unmet rule blocks that market's disposition (a hard G-REL item, not QA discretion). Also:
  - Market removal after execution needs a linked deviation and QA e-signature. The original resolution is kept, and the removal is shown in the release cockpit and the PQR extract.
  - A packaging order can only be created for destinations inside the batch's market set; otherwise the market-add evaluation runs first.
  - Add these as IN-52 tests.

### R-08 [major] Line/room/person tightening does not re-evaluate evidence gathered under the looser rule, and loosening is undefined
- **Outline section:** 3.3 Resolution (O:132); 5.2 APS status (O:304).
- **Problem:** When the first EU product is qualified on a line, the outline switches APS acceptance to "any contaminated unit fails" and only raises a QA review task. But the line's current APS qualification may rest on runs that were accepted under the FDA/India tiers, for example 1 positive in 12,000 units recorded as "investigate only". Under the new rule those runs are failures, so the line is not qualified for EU product. The same applies to:
  - per-shift coverage (EU 9.38 counts shifts; FDA counts per line);
  - EM limits (ISO 8 100/50 vs Grade D 200/100);
  - HEPA/requalification intervals;
  - operator APS participation.

  The reverse case (a product or market removed from a line) is not specified. It must never retroactively turn a failed evaluation into a pass.
- **Evidence:**
  - ST conventions (digest-sterile-controls.md:9): line-level rules use the strictest rule across every product on the line.
  - ST-33; Annex 1 9.38, 9.46 (eu-annex1-2022.txt:2788-2797, 2856-2878).
  - ST-01: each evaluation is stamped with its limit version.
- **Fix:**
  - Make qualifying a product with a stricter market a **gated** event. Before the first batch for that market is issued, the engine re-evaluates the line/room/person evidence inside the current qualification window (the last APS runs back to the most recent initial or repeat validation, EM trends, requalification dates, operator records) against the new rule.
  - If any item fails, the line is NOT_QUALIFIED for that market until requalified, for example with 3 consecutive APS.
  - Loosening happens only through change control. It is effective only for runs and results after the effective date, and never re-labels past evaluations.
  - Add both cases to the IN-52 resolution test matrix.

### R-09 [major] Resolution scopes miss MATERIAL LOT and EQUIPMENT, and cannot express conditions within one market
- **Outline section:** 3.3 Rule table scopes (O:131); Material lot machine and consumption guard (O:300).
- **Problem:**
  1. A material lot is released once but consumed by batches with different market sets. "Identity test as resolved" at lot release has no batch context. The consumption guard (right item, usable status, dates, container, quantity, hold) never checks the lot's release route against the consuming batch's market set. A lot released under India's vendor-history route could therefore enter a US or EU batch.
  2. Equipment-level rules have no scope. Examples: steriliser chamber leak test weekly when EU is served (B-18) versus India's "regular"; filter lot-count reuse on US-only lines (ST-53); lyophiliser sterilisation frequency.
  3. The rule table has one value per market. Several values depend on other attributes *inside* a market:
     - India retention depends on licence form (Form 25 via Rule 74 vs Form 28 via Rule 78, reportedly expiry + 2 y for test records, U);
     - US retention changes for OTC products exempt from expiry dating (distribution + 3 y);
     - EU APS frequency changes for manual aseptic processes (per operator, ST-30);
     - Schedule H2 applicability depends on the product category and the pack date.
- **Evidence:**
  - IN-24(c) and its test (dispense a vendor-history lot into an {IN, US} batch: blocked).
  - B-09; 211.84(d)(1)-(2); EU 5.35.
  - B-18; ST-53; IN-08(ii)-(iii); 211.180(a) (primary/21cfr211.txt:1246-1249).
- **Fix:**
  - Add scopes MATERIAL_LOT (resolved at consumption against the consuming batch's set) and EQUIPMENT (union over the markets of products qualified on the equipment).
  - Add to the consumption guard: "lot release route satisfies the consuming batch's resolved identity-test rule".
  - Allow rule values to carry predicates on product and site attributes (licence form, OTC-exempt flag, manual-aseptic flag, H2 category and date) inside each market column, and store which predicate branch applied.

### R-10 [major] Two "behaviours as keys" are keyed to US/EU although India requires them for every batch
- **Outline section:** 3.3 Behaviours as keys (O:136).
- **Problem:**
  - **Area logbooks "when EU is in the set".** Schedule M requires chronological records of the use of major and critical equipment **and of the areas where products were processed**. India always applies, so this must be on for every batch. It is also a ROOM-scope record: a logbook that is active only during EU batches leaves gaps in the area's chronology, which fails EU 4.31 as well.
  - **Label specimens in the packaging master "when US is in the set".** IN-14 (ENFORCED) blocks a packaging order unless every printed component has an approved specimen, for every profile. Schedule M 17.3.7(e) itself says "where appropriate", so this is the catalog's stricter design, but the outline contradicts the catalog without recording a MODIFY.
  - A related point: IN-21 requires an electronic clearance checklist before each processing operation. PR D-5 makes the processing checklist only "CONFIGURABLE (default on)", and the outline does not lock it for India.
- **Evidence:**
  - Schedule M 17.3.10.17 (P~): chronological records of equipment and area use (primary/india-schedule-m-2023.txt:1507-1508).
  - IN-25(a); IN-14; Schedule M packaging-instructions item (e) (india-schedule-m-2023.txt:1285-1287); IN-21.
  - INV-28, no resolved value looser than India's (O:341).
- **Fix:**
  - Make area logbooks unconditional and ROOM-scoped.
  - Make packaging-master specimens mandatory in all profiles (N/A only by a recorded MODIFY decision on IN-14).
  - Lock the processing-clearance checklist ON.
  - Add a CI check that every behaviour key's IN column has been reviewed against the India catalog, so a PR-catalog "(US in set)" or "(EU in set)" resolution never ships unless India's value was examined.

### R-11 [major] "Stricter" is undefined for composite and non-orderable rules; export label content is the clearest failure
- **Outline section:** 3.3 comparator list (O:131); label rule (O:22, O:135 "uncoded manufacturing date on India-domestic packs only").
- **Problem:** The four comparators (smaller, larger, ordered list, required-if-any) cannot express three kinds of rule:
  - **Composite rules**, where each market is stricter on a different dimension.
    - Reserve samples: India's quantity includes sterility tests but its period is shorter; the US period is longer and adds a yearly visual check.
    - Grade A particles: India's 5 µm number is lower (20 vs 29), but EU is stricter on method (continuous monitoring at 28 L/min or more, per-sample correlation).
    - EM microbial limits: India's values are averages, EU's are per-sample maxima.
    - Filters: FDA counts validated lots, India limits to one working day, EU limits to one batch.
    - Room classes: EU grade and FDA ISO class do not map one-to-one (Grade D is ISO 8 at rest only, while FDA's ISO 8 limit applies in operation).
  - **Set-valued rules**, where the result is a union: sterility pull points (start/middle/end, per load); time-limit lists; record content items.
  - **Non-orderable rules**: label content.
    - An India-export pack must carry the Rule 94 particulars (U).
    - The Schedule M 17.3.1 label list is not limited to domestic packs in the text; the "domestic only" reading rests on the unverified Rule 94 question G-9.
    - A US or EU pack must match the approved labelling, so the engine cannot simply "add the stricter field".

  The outline states "manufacturing date on India-domestic packs only" as settled. INV-28 ("no resolved value looser than India's") is also undefined for composite values.
- **Evidence:**
  - B-02, B-26, B-13, B-12, B-17 (digest-india.md:51-66).
  - ST-20 (ISO 8 vs Grade D), ST-66 (union of sterility pulls).
  - IN-31 and G-9 (Rule 94 status U).
  - Features F.2 A23/A24.
- **Fix:**
  - Require every rule-table key to be **atomic** (one dimension, one unit). Composite regulatory rules become several keys, each with its own comparator.
  - Add a **set-union** comparator.
  - Add a **"not orderable: per-destination determination"** comparator that makes the author choose the governing source and blocks approval until a regulatory decision reference is attached.
  - Store the floor type (hard / guidance / example) per market *value*, not per row, because the same key can be hard in one market and guidance in another.
  - For export packs, keep a mandatory "India export particulars" checklist (Rule 94 plus any Schedule M 17.3.1 items that counsel says apply to exports) alongside the destination's approved artwork.
  - Mark B-15 "U" in the outline until G-9 is answered.
  - Define INV-28 as "for every atomic key, the resolved value is at least as strict as India's".

### R-12 [major] The retention rule is incomplete and would under-retain some records
- **Outline section:** 3.3 Examples, retention (O:135); 5.1 retention rules; INV-22.
- **Problem:** The only formula given is max(expiry + 1 y, manufacture + 5 y, QP certification + 5 y). It leaves out:
  - the US rule for OTC products exempt from expiry dating (3 years after distribution);
  - India Form 28 (Rule 78) test records at expiry + 2 y (U), which beats manufacture + 5 y for shelf lives over 36 months;
  - DSCSA serial/transaction data (6 years, s);
  - EU batches that are never certified (rejected at import), which would stay "open" forever;
  - EU 4.12 raw data supporting the MA (PPQ/validation), kept while the MA is in force and at least as long as the batches released on that validation;
  - **shared and supporting records.** APS runs, EM sessions, equipment and area logbooks, component/closure/labelling records (211.180(b): expiry of the last lot that used them), MBR versions and configuration must inherit the latest retention end of every dependent batch. The market-profile engine resolves per batch and has no "max over dependants" rule.
  - Audit trails must be kept at least as long as their record.
- **Evidence:**
  - 211.180(a)-(b) (primary/21cfr211.txt:1246-1254); 11.10(e) (audit trail retention); EU Ch.4 4.11-4.12 (primary/eu-ch4-2011.txt:171-190).
  - DI-47 (lists all of the above); PR-59 and PR F-2; IN-08(ii).
- **Fix:**
  - Replace the example with the full DI-47/PR-59/IN-08 rule set.
  - Add a RETENTION_DEPENDENCY rule: the retain-until of a shared record is the maximum of its dependants, recomputed when a dependant's expiry or certification date changes.
  - Add the never-certified EU default: the later of expiry + 1 y and disposition + 5 y, pending QA confirmation.
  - Add an INV-22 test for a component lot used by two batches with different expiries.

---
## C. Sterile controls (Injectables)

### R-13 [major] An EM action excursion is linked only to batches that overlap the sampling window, not every batch up to when the result is reported
- **Outline section:** 5.2 EM result (O:302).
- **Problem:** Viable results arrive days after sampling. Batches processed in the same room/zone between sampling and reporting are exposed to the same possible contamination source, but under the outline's rule they are not linked, not held, and can be released. The sterile catalog names this as a runner-up "most likely to be implemented wrongly" item. The outline also contradicts its own input spec.
- **Evidence:**
  - ST-21: link every batch processed in that room/zone from sampling time until the result was reported, and hold them.
  - digest-injectables-process.md:426 and :675 ("window from sampling to reporting").
  - digest-sterile-controls.md:1686 (runner-up list).
- **Fix:** Replace the O:302 wording with: "action excursion (any grade) -> deviation linked to every batch whose processing in that room/zone falls between the sampling time and the result-reported time; linked unreleased batches go ON_HOLD; any Grade A/ISO 5 growth also links every batch whose aseptic window overlaps the sample." Add a golden-batch negative test: sample on day 1, result on day 5, batches on days 2-4 are held.

### R-14 [major] The APS status engine omits initial 3-run validation, triggers that force revalidation, repeats after a failure, and manual per-operator qualification
- **Outline section:** 5.2 APS status (O:304); Operator qualification (O:306).
- **Problem:** The machine only goes NOT_QUALIFIED -> QUALIFIED -> DUE -> EXPIRED/SUSPENDED. It does not define:
  1. At least 3 consecutive successful APS covering every shift before a line/process first becomes QUALIFIED.
  2. Automatic return to "initial validation required" on any of these: a change that affects sterility assurance (HVAC, equipment, process, number of shifts or personnel, major shutdown); a new container or closure combination; inactivity beyond a site-set period.
  3. After an EU-rule failure, normally at least 3 consecutive successful repeats, and production resuming only after revalidation.
  4. Flagging already-released batches since the last good APS for a documented market-impact decision.
  5. Manual aseptic operations: each operator × container × closure × equipment train needs 3 initial runs, then one about every 6 months *per operator*. O:306 only states the 12-month participation rule (ST-08), which is weaker. ST-29/ST-30 are the #2 item on the catalog's "most likely to be implemented wrongly" list.
- **Evidence:**
  - Annex 1 9.38, 9.39, 9.46(iii) and (vii), 9.49 (primary/eu-annex1-2022.txt:2788-2802, 2863-2878, 2895-2900).
  - FDA 2004 IX.A.2: three consecutive initial runs (primary/fda-aseptic-processing-2004.txt:1227).
  - IN-45(b); ST-29, ST-30, ST-33, ST-03.
- **Fix:**
  - Add states INITIAL_VALIDATION_IN_PROGRESS (a counter of consecutive passes per shift) and REVALIDATION_REQUIRED (entered from change control flagged "affects aseptic process", a new container-closure, inactivity > site parameter, or FDA triggers such as an EM anomaly, sterility positive, staffing change or extended shutdown).
  - On an EU-rule failure: SUSPENDED -> REPEATS_IN_PROGRESS (at least 3 consecutive by default) -> QUALIFIED.
  - Add a per-operator manual-APS qualification (operator × configuration, 6-month interval) checked at signing of manual aseptic steps.
  - Add a released-batch impact task.
  - List the related tests under Phase 5 exit.

### R-15 [major] The APS envelope is checked only at issue and fill start; most envelope parameters can only be breached during the fill
- **Outline section:** 5.2 APS status, "checked at issue and fill start" (O:304).
- **Problem:** Several parameters are only known during or at the end of filling:
  - duration;
  - peak headcount and operator time in the cleanroom;
  - intervention counts and durations;
  - line speed;
  - holds of exposed product and equipment;
  - lyophiliser loading duration.

  Checking only at issue and start lets a fill that runs past the demonstrated envelope finish with no deviation. The outline also leaves out the rule that for batches under 5,000 units the APS must contain at least as many units as the batch, and the envelope's shift and hold items.
- **Evidence:**
  - ST-31: exceeding duration, headcount, intervention occurrences, speed or holds raises a deviation before release; for batches under 5,000 units the APS unit count must be at least the batch size.
  - ST-36; IB-15 (digest-injectables-process.md:536-541); Annex 1 9.40 (eu-annex1-2022.txt:2805-2808).
- **Fix:** Change O:304 to "envelope checked at issue (container size, batch size vs APS unit count), at fill start (line, shift, format, operator participation), continuously during the fill (duration, headcount, intervention counts, speed, holds) and at fill end; any exceedance raises a deviation that blocks release until QA assesses it". List all envelope dimensions from IB-15.

### R-16 [minor] Other catalog "most likely wrong" specifics are not pinned in the outline as invariants or named tests
- **Outline section:** 6.3 Injectables gates (O:423); INV-36 (O:349); Phase 5 exit (O:606).
- **Problem:** The outline covers them only through the blanket "every ST control maps to a block". It does not state:
  - ST-52 filter-train logic: in a redundant train, test the backup only if the primary fails post-use; in a serially validated train, every filter must pass;
  - ST-32: all integral units incubated, including cosmetic rejects; removal capped at the catalogue number and never more than in production [EU hard]; FDA incubation numbers (20-35 °C, ±2.5 °C, ≥14 d, ≥7 d per temperature, lower first) labelled as FDA, not Annex 1;
  - ST-64: vacuum-retention test before certification; visual inspection never accepted as a CCI method;
  - ST-58: a manual-open lyophiliser needs a new sterilisation before every load (from 25 Aug 2024);
  - ST-19: continuous Grade A counting at 28 L/min or more from equipment assembly onward;
  - ST-20: FDA ISO 8 (100/50) is stricter than Grade D (200/100) for US product.
- **Evidence:** digest-sterile-controls.md:1677-1686; Annex 1 8.123, 9.17 (eu-annex1-2022.txt:2201, 2512-2515).
- **Fix:** Add these as named invariants or Phase 5 exit tests (e.g. INV-40 "post-use test precedes removal; redundant/serial logic"; INV-41 "APS reconciliation filled = incubated + justified non-incubated, zero unexplained"; INV-42 "fusion-sealed ≤100 mL → 100% CCI; VI never a CCI method").

---
## D. Data integrity, audit trail and e-signatures

### R-17 [major] The batch audit-trail review leaves out changes to linked records and audit events added after the review
- **Outline section:** 5.4 Review (O:362); 5.2 QA_REVIEWED and G-REL (O:282, O:286). This gap is also missing from the DI catalog.
- **Problem:** Hash chains and review reports are per aggregate: batch, lot, equipment, user, configuration (O:361-362). A "batch" review therefore misses post-entry changes to records the batch relies on:
  - corrections to equipment or area logbook entries (cleaning, calibration) for the equipment used;
  - revisions to EM/PM results for the fill window;
  - material-lot status changes and re-released lots;
  - revised LIMS results;
  - sterilisation-cycle record edits;
  - rule-table re-resolutions.

  These are part of the production and control records the QU must review before release. Also, audit events can be added to the batch after QA_REVIEWED, for example late EM links, deviation updates or attachments. G-REL checks the *content* hash, but nothing proves the audit-trail review covered events up to the disposition.
- **Evidence:**
  - 211.192 (QU reviews all production and control records before release).
  - FDA DI Q&A Q7-Q8, which DI-25 reads as: reviewers of a record review the audit trail of its data, at the data's review frequency.
  - DI-25 scope covers batch data plus system events only; ST-70 (a later source change forces re-review).
- **Fix:**
  - Define the batch audit-trail review scope as the batch aggregate plus the audit events, within the batch window, of every linked record the batch consumed or relied on. Use the genealogy/occupancy/EM/lot/cycle links, and add a "linked-record changes" section to the review report.
  - Store a high-water mark (the last audit event ID per included chain) with the review signature.
  - Add a G-REL item: no GMP audit event in scope after the high-water mark, otherwise a signed delta review is required.
  - Add a DI-25 test that corrects a cleaning-log entry for used equipment after QA review; disposition must stay blocked.

### R-18 [major] The outline does not separate "correct/void and repeat" from invalidating a genuine failing result, so testing into compliance is possible on shop-floor IPCs
- **Outline section:** 5.2 Step execution, "VOIDED plus a new attempt for a legitimate repeat" and "Correct before QA review" (O:290); S28 (O:498).
- **Problem:**
  - A failing IPC can be voided and repeated with only a reason and (by default) QA approval of the void. Examples: tablet weight or hardness against an in-process specification, fill weight, pH, disintegration.
  - "Correct" can replace an entered value.
  - Nothing requires an OOS-type investigation before a genuine result is invalidated.
  - The only OOS handling in the outline is a status imported from LIMS (O:238).
- **Evidence:**
  - DI-29: invalidation needs a documented investigation; a repeat-until-pass pattern is flagged.
  - IN-20(c): IPC specification tests follow the OOS workflow; the original stays; a passing re-entry never replaces it (Schedule M 19.6.7).
  - DI-24: correction of an entry error is a different path.
  - 211.192; FDA DI Q&A Q13 (via DI-29).
- **Fix:**
  - Add three separate paths:
    - (a) *entry-error correction*: a transcription/keying error, where the device raw value proves the error; needs a reason, re-verification and the S25 approval level;
    - (b) *void of an attempt*: a procedural abort before any result exists;
    - (c) *invalidation of a result*: allowed only with a linked OOS/deviation investigation that concludes an assignable cause.
  - A failing result can only leave the record through (c).
  - Every attempt after a failing result is flagged in RBE.
  - Add INV-43 "a failing specification result is never superseded without a closed or approved invalidation investigation", with a bypass test.

### R-19 [major] E-signature session rules are underspecified in ways that can breach 11.200(a)
- **Outline section:** 5.5 (O:369-371); 3.5 relaxation switch (O:149); 7.4 kiosk sign-in (O:510).
- **Problem:**
  1. The QA-approved relaxation for routine signings does not say which component remains. 11.200(a)(1)(i) requires it to be the component only the individual can execute (the PIN or password). A badge or user ID alone does not qualify.
  2. On shared kiosks the verifier signs "in the same dialog" as the performer. That is not the verifier's continuous session, so 11.200(a)(1)(ii) requires *all* components, and the relaxation must never apply. The outline does not say this.
  3. The continuous session is not defined: which events end it, such as lock, timeout, logout or a terminal switch.
  4. Badge + biometric sign-in on kiosks is offered, but whether biometrics can be used for *signing* is not stated. If they can, 11.200(b) and anti-spoofing apply.
- **Evidence:**
  - 21 CFR 11.200(a)(1)(i)-(ii), (b) (primary/21cfr11.txt:303-320).
  - DI-38: the continuous session ends at lock, timeout, logout or terminal switch; the performer's session never supplies the verifier's signature; biometric liveness.
- **Fix:** Add to 5.5:
  - "relaxation leaves only the private component (PIN/password), never badge or ID alone";
  - "any signature by a person other than the session owner always requires all components";
  - "the continuous session ends at lock, inactivity timeout, logout or terminal change";
  - "biometric signing only with 11.200(b) evidence (liveness, owner-only), else sign-in only".

  Add a test where the verifier signs in the performer's kiosk session with PIN only: refused.

### R-20 [minor] Part 11 administrative controls are missing or wrongly scoped
- **Outline section:** 5.5 (O:371).
- **Problem:**
  - The 11.100(c) certification is tied to "US tenants". It actually applies to any company whose records support US-market batches, which is typically an Indian exporter. Nothing blocks US-market signatures when no certification is on file.
  - Only lockout is described. The outline lacks:
    - 11.300(c) loss management for badges and tokens, which are signature components here;
    - 11.300(d) immediate, urgent reporting of attempted misuse to the security unit;
    - 11.300(b) periodic checking of credential issuance;
    - 11.200(a)(3), which requires that an administrator's password reset cannot let one person use another's signature. This needs forced change at first use and no admin-known final secret.
- **Evidence:** 21 CFR 11.100(c) (21cfr11.txt:279-285); 11.300(b)-(d) (21cfr11.txt:329-339); 11.200(a)(3) (21cfr11.txt:316-317); DI-19.
- **Fix:**
  - Make the 11.100(c) record a tenant prerequisite whenever US is in any market set, and refuse to issue a US-market batch without it.
  - Add badge revocation and replacement workflows, a real-time misuse alert to the security role and QA, forced secret change after an administrator reset, and periodic credential review.

### R-21 [minor] Attribution and the original record are unclear for paper-contingency back-entry
- **Outline section:** 4.2 Network loss (O:177).
- **Problem:** The outline says entries are back-entered as "transcribed from paper" with a scan and a second-person check. It does not say:
  - that the electronic entry is attributed to the person who performed the work on paper, with the transcriber and verifier recorded separately;
  - that the signed paper form stays the original record for that step (a hybrid point) unless it is replaced by a verified true copy;
  - that the performer's handwritten signature is not replaced by the transcriber's e-signature.
- **Evidence:** DI-43 (hybrid points in the register; back-entry flagged and verified; paper true-copied); DI-01 (official-record register); DI-37 (avoid hybrid signing); 211.180(d).
- **Fix:**
  - Record three identities on each back-entered value: performer (from paper), transcriber, verifier.
  - Declare the contingency form a hybrid point in the DI-01 register.
  - Keep the paper original, or a DI-41 verified true copy, linked to the record.

---
## E. Coverage gaps and internal contradictions

### R-22 [major] The PQR/APR data feed is deferred to v1.1 although three ENFORCED controls require it in v1
- **Outline section:** 8, extras rank 17 "CPV/APR feed ... v1.1" (O:534). No phase exit names IN-01, PR-58 or ST-73.
- **Problem:** The annual product review is binding in all three regimes. The catalog controls make the eBMR's structured, reproducible, reconcilable extract ENFORCED. IN-01 also requires export-only batches in the extract and the AP's sign-off. Deferring the feed means these controls' tests fail in v1.
- **Evidence:**
  - 211.180(e) (primary/21cfr211.txt:1276-1283); Schedule M 2.3.1-2.3.3 (via IN-01); EU Ch.1 1.10 (s).
  - IN-01 (ENFORCED; test includes export-only batches); PR-58 (ENFORCED; the extract reconciles to registers); ST-73.
- **Fix:** Move the PQR/APR extract into Phase 4, as a structured extract per product and period, reproducible, reconciled to the batch, deviation and CAPA registers, including export-only SKUs, with AP sign-off. Keep only the CPV/SPC dashboards as a v1.1 extra. Add IN-01, PR-58 and ST-73 to the Phase 4/5 exits.

### R-23 [minor] S10 (reviewer and disposition-signer independence) is "Locked" in 7.2 but a switch in 3.5 and INV-35
- **Outline section:** 3.5 (O:149); INV-35 "(default policy)" (O:348); 7.2 Locked list (O:497).
- **Problem:** An invariant cannot depend on a policy. The features spec (A.5, S10) says LOCKED.
- **Evidence:** digest-features-ux-config.md:153 (S10 LOCKED); DI (c)23 (the rule is a design choice, not 211.22 text).
- **Fix:** Pick one. Recommended: S10 stays LOCKED and is removed from the 3.5 switch list. Only the open "does in-process QA count as involved" question remains configurable (DI (f)13). Delete "(default policy)" from INV-35.

### R-24 [minor] The HEPA/requalification interval reads as market-conditional in 3.3 but is flat in 5.2
- **Outline section:** 3.3 example "HEPA test every 6 months for A/B when US or EU is in the set" (O:135) vs 5.2 clean area "requalification within 6 months for A/B and 12 months for C/D" (O:302).
- **Problem:** Two different rules are stated.
  - ST-14 locks A/B at 6 months or less for every profile, and Annex 1 4.32 counts filter integrity testing as part of requalification.
  - B-16 lets India-only rooms warn at 6 months and block at 12.

  The outline must state which applies to India-only rooms, and that the flat 6-month rule is the product choice.
- **Evidence:** Annex 1 4.32 (eu-annex1-2022.txt:759-777); ST-14; B-16; IN-43 test.
- **Fix:** State: "A/B requalification including the filter leak test at 6 months or less in all profiles (product choice, stricter than India-only B-16); C/D at 12 months or less". Change the 3.3 example to cite this, or drop it.

### R-25 [minor] Decision 3 defaults DSC/eSign ON for key signatures, but no licensed provider is in v1
- **Outline section:** 13 Decision 3 (O:643); 8 rank 13 (O:532); 5.5 (O:371).
- **Problem:** With the default ON and only a test certificate authority, the AP release and MBR approval either cannot be signed in production or are signed with certificates that have no legal standing under IT Act s.5.
- **Evidence:** India D.4(2); IN-10(b); IT Act s.3A, s.5 (status S).
- **Fix:** Default OFF until a licensed CA/ESP is configured. The system shows a banner on India-licensed tenants that the counsel question (D.5 Q1-Q3) is open. Switching it on then needs the provider's certificate chain to validate to the CCA root in OQ.

### R-26 [minor] Decision 4 labels FDA's 12.5 Pa as a "hard value", but FDA gives it as an example in guidance
- **Outline section:** 13 Decision 4 (O:644).
- **Problem:**
  - FDA's 2004 guidance gives "at least 12.5 Pa" as an e.g. for aseptic room to unclassified room, and it is non-binding.
  - Calling it "hard" in the ST-01 floor table misstates its legal status.
  - It also applies it to every profile, although FDA is its only source.
  - Separately, "meets FDA's 10-15 Pa" is optimistic. FDA says at least 10-15 Pa, and a 10 Pa floor only meets the low end.
- **Evidence:** primary/fda-aseptic-processing-2004.txt:457 and 465-467; ST-17 (12.5 Pa "comes from FDA").
- **Fix:** Store 12.5 Pa as floor type "FDA guidance example, adopted as product default for all profiles" (a DESIGN-CHOICE, loosening needs QA plus CCS). Reword Decision 4 to "10 Pa satisfies Annex 1's minimum guidance value and the lower end of FDA's 10-15 Pa recommendation".

### R-27 [minor] Decision 5's reasoning is inaccurate
- **Outline section:** 13 Decision 5 (O:645).
- **Problem:**
  - "No text defines it" is not quite right. Annex 1 9.17 requires each individual sample result to be correlated with alert and action limits, and Table 5 Note 2 lets isolated ≥5 µm counts be treated as possible false counts while consecutive or regular low counts are investigated.
  - A single count in a 28.3 L sample (about 35/m3) exceeds EU's 29/m3 as well as India's 20/m3, so the problem is not India-specific.
- **Evidence:** primary/eu-annex1-2022.txt:2502-2515; B-13.
- **Fix:** Rewrite the rationale: each sample is evaluated individually (9.17); isolated single ≥5 µm counts are annotated under Note 2 (text Annex 1 and, per India's structure, WHO-derived); consecutive or recurring counts escalate. The ≥0.5 µm and the India 5 µm limits still apply per sample. Keep option B.

### R-28 [minor] "EU/PIC/S" is used without a PIC/S market code
- **Outline section:** 5.2 APS (O:304); Decision 2 (O:642).
- **Problem:** The market model has only IN, US and EU (2.4 defers other markets). "EU/PIC/S product" cannot be evaluated by the engine, and UK/PIC/S destinations would silently fall back to FDA/India tiers.
- **Evidence:** ST-33 (the "EU/PIC/S" trigger); O:88 (other markets out of scope).
- **Fix:** Say "EU-market product" in v1. Add a product-master flag "PIC/S-member destination" that is treated as EU for line-level sterile rules until those markets are added.

### R-29 [minor] Decision 8 and S5a say "US-market" two-person default, while S5 applies the US rule to all markets
- **Outline section:** 7.2 S5 and S5a (O:497-498); Decision 8 (O:648).
- **Problem:** The reader cannot tell whether single-verifier automated dispensing is ON by default for {IN} and {IN, EU} batches. If it is, adding US later is impossible without a violation (see R-07). The regulatory position is fine either way: IN-23 and Annex 11 §6 accept validated electronic checks. The inconsistency is the problem.
- **Evidence:** 211.101(c)-(d), 211.68(c) (primary/21cfr211.txt:435-439, 646-657); IN-23; PR D-3/D-15.
- **Fix:** Define S5a's default per step type across all profiles, e.g. "two persons by default everywhere; one-verifier mode per step type after documented regulatory position". State that a batch run in one-verifier mode cannot later add US unless the step types qualify under 211.68(c).

### R-30 [minor] Several register controls have no module, block or phase in the outline
- **Outline section:** 3.1-3.2 trace chain; 11 phase exits.
- **Problem:** The following are never cited or assigned:
  - DI-01: record-type, official-record and hybrid register (needed for R-21);
  - DI-50: DI investigations, with ENFORCED holds, per-user scoping reports and immediate revocation;
  - IN-02: ENFORCED rationale for any risk-based reduction;
  - IN-30: loan licence. The header needs both licence numbers, and the release workflow must show which party's AP releases (Schedule M Part I 9.x).

  Phase 7's "every FOLLOW control VERIFIED" catches them too late to plan.
- **Evidence:** digest-data-integrity.md:22, :893; digest-india.md IN-02, IN-30.
- **Fix:** Assign DI-01 and DI-50 to Phase 1 (kernel). Assign IN-02 to Phase 2 (MBR designer: a risk-class field and a rationale gate on S5a/S24/RBE/IPC-frequency reductions). Assign IN-30 to Phase 4 (header fields, party model, release authority per contract). Add all four to the phase-exit test lists.

### R-31 [minor] The station-wise compression check at fixed intervals on multi-point presses is missing
- **Outline section:** 6.3 Tablets (O:422); INV-34.
- **Problem:** The outline requires only a station-wise *start* check and the 30-minute ceiling. Schedule M Part VIII 3.4 also requires tablets from each compression station or point to be examined **at fixed intervals** on machines with multiple compression points.
- **Evidence:** primary/india-schedule-m-2023.txt:5585-5590 (Part VIII 3.4); IN-35(b); B-03.
- **Fix:** Add to 6.3 and INV-34: "multi-point presses: station/point-wise check at a fixed MBR interval during the run (validator rejects an MBR without it)". Add the IN-35 test "16-station press, periodic station-wise set incomplete, flagged".

---

## F. Items regulators would expect that neither the outline nor the catalogs mention

### R-32 [major] No accountability model for controlled substances (India NDPS; importing-market controls) in the Tablets edition
- **Outline section:** 2.2 Modes (O:65); 5.1 entities; G-07/G-20.
- **Problem:** Indian exporters commonly make formulations containing narcotic or psychotropic substances. The NDPS Act 1985 and NDPS Rules (Chapter VII-A for psychotropic substances) place licence, manufacturing-record and stock-account duties on the manufacturer. Regulators expect the batch record to support:
  - mass balance of the controlled API from dispensing to finished packs;
  - losses and wastage accounted for with a witnessed destruction;
  - restricted dispensing roles;
  - a link to the statutory stock registers.

  The outline and catalogs mention NDPS only as a Schedule H2 QR category (IN E).
- **Evidence:** No catalog control. digest-india.md:585 and 641 (H2 only). Primary NDPS text is not in the inputs, so verify the specific rules and forms before citing them.
- **Fix:** Add a product-master flag "controlled substance (India NDPS schedule; destination controls)". It inserts:
  - dual-custody dispensing;
  - zero-unexplained-difference reconciliation of the controlled API at each yield checkpoint;
  - witnessed destruction of rejects;
  - an export of the quantities needed for the statutory registers.

  Add a control (e.g. IN-53) with status S/U until NDPS Rules text is verified. At minimum, list it as an explicit v1 scope decision.

### R-33 [minor] Indian personal-data and cyber-security law is not addressed
- **Outline section:** 5.1 kernel entities (qualifications incl. eyesight, health-related entries); 5.5 eSign; 7.4 biometrics; 5.6 time.
- **Problem:**
  - The system holds employee personal data: eyesight and health declarations (ST-10), biometrics, and Aadhaar-linked eSign. It keeps them for GMP retention periods.
  - The Digital Personal Data Protection Act 2023 (with its Rules, phased commencement) needs a documented lawful basis, notice, and purpose-limited retention that the GMP retention exception must justify.
  - CERT-In Directions (Apr 2022, IT Act s.70B) require reporting cyber incidents within 6 hours, keeping ICT logs in India for 180 days, and synchronising clocks to NIC/NPL NTP or traceable sources.
  - The outline's time monitor does not record or constrain the reference time source.
- **Evidence:** Not in any catalog (DI-13 mentions only confidentiality). Primary texts are not in the inputs: verify before citing.
- **Fix:**
  - Add to the watch list and to IN-09/DI-13 notes: a DPDP data inventory for personal fields, a retention justification tied to GMP rules, and a biometric/Aadhaar data-minimisation design (store only templates or ESP transaction references).
  - Make the time-reference source a validated configuration item, defaulting to an NPL/NIC-traceable NTP for Indian sites, and record it with drift samples.
  - Include CERT-In reporting in the incident workflow (DI-12).

### R-34 [minor] No rule on the language of free-text GMP entries
- **Outline section:** 7.4 Languages (O:511).
- **Problem:** The outline controls MBR translations and display language, but operators can type deviation descriptions, comments and justifications in Hindi or regional scripts. US and EU inspectors and the EU importer's QP must be able to read the record, and 4.27 says all records must be available to the QP. Retrospective translation of GMP free text is itself a transcription that needs control.
- **Evidence:** EU Ch.4 4.27 (eu-ch4-2011.txt:350-353); 211.180(c) (records available for inspection and copying). No catalog control covers this.
- **Fix:** Add a tenant policy: for any batch with US or EU in the market set, free-text GMP fields are entered in English, or carry a verified English translation (translator, verifier, both texts kept) before production approval. Add this to the RBE exception types ("untranslated free text").

### R-35 [minor] Export-specific Indian permissions are not captured at issue or release (verify)
- **Outline section:** 5.2 PLANNED -> ISSUED (O:277); G-REL (O:286); India fields (Phase 4).
- **Problem:** For products made only for export and not approved in India, Indian practice needs a CDSCO/licensing-authority permission (commonly called an export NOC or licence endorsement). The export pack then carries Rule 94 particulars. The batch header and G-REL do not record or check this permission. The India catalog raises it only as a labelling open question (G-9).
- **Evidence:** digest-india.md:690 (G-9); IN-31(a) (India-export template class). The primary text is not in the inputs.
- **Fix:** Add a product/market field "Indian export permission reference and validity (destination, product, strength)". Block issue of an export-only batch without it, and add it to the AP release checklist (R-04). Mark it S/U until counsel or CDSCO confirms (India G-9, G-10).

---

## Summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 1 | R-01 |
| Major | 19 | R-02 to R-15, R-17 to R-19, R-22, R-32 |
| Minor | 15 | R-16, R-20, R-21, R-23 to R-31, R-33 to R-35 |

Most important:
1. R-01: India AP certification must gate every market's release; INV-39 and the "one signature, two meanings" shortcut contradict Schedule M 11.3.8.
2. R-07: adding or removing a market after execution needs a hard re-evaluation against recorded data, not QA discretion.
3. R-13: EM action excursions must link every batch from sampling to reporting, not only batches overlapping the sampling window.
4. R-05: the justified open-investigation release path must be locked closed for sterility-assurance investigations.
5. R-10: area logbooks and packaging specimens are keyed to US/EU although India requires them always; this breaks INV-28.
