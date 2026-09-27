# Control catalog: production, documentation and quality-system controls (US FDA + EU GMP)

Shared compliance kernel for the TABLETS and INJECTABLES eBMR editions. India Revised Schedule M is handled in the separate India catalog; the kernel merges catalogs with a stricter-wins rule, so any Schedule M obligation that is stricter than what is written here overrides it.

**Inputs:** register/bucket-production.jsonl (136 rows), digest/_guardrails.json (secondary), and the official texts in primary/ (21 CFR 211 and 11 as of 9/24/2026, EU GMP Ch.4 (2011), Ch.5 (2015), Annex 11 (2011)). Clauses that did not come from a register row (e.g. 211.122, 211.125, 211.186, 211.188(a), 211.22, 211.100, 211.165, 211.180(a)-(d), 4.20, 4.21, 4.31) were read directly in primary/.

**Citation markers:** no mark means the clause was checked against the official text in primary/. (s) means secondary source only, not in the uploaded texts. (u) means the row is unverified and clause numbering is approximate. (draft) means a draft that is not binding.

**Types:** ENFORCED means kernel behaviour that no tenant, site, MBR or admin setting can weaken. CONFIGURABLE means a safe default plus an allowed range. DESIGN-CHOICE means product behaviour that goes beyond the regulatory text. It is recommended but not required by the rule, unless the control says so.

**Market set:** every batch (and every packaging order) carries its destination markets, e.g. {US}, {EU} or {US, EU}. "Stricter wins" means the engine applies the union of the obligations of every market in the set. Where a control says "(EU in set)", the behaviour switches on only when EU is a destination.

**Edition tags:** [T] = Tablets, [I] = Injectables. Untagged controls apply to both editions.

---

## A. Master records (MBR / master formula, processing and packaging instructions)

### PR-01 Master record scope and keying
- Covers: n89, n91
- Type: ENFORCED
- Behaviour: A processing master (manufacturing formula plus processing instructions) is keyed by product code, strength and batch size. A packaging master is keyed by product, pack size and pack type. A batch can only be created for a batch size that an approved master lists explicitly, either as one size or as an approved set of discrete sizes. There is no free scaling at batch creation. Packaging masters are versioned and approved separately and reference the bulk product code.
- Citations: US: 211.186(a) (each product and each batch size) | EU: Ch.4 lead-in above 4.17 (each product and batch size); 4.19 (each product, pack size and type) | ICH/EMA/draft: none
- Jurisdiction: The two are equivalent for processing. EU states the packaging keying (pack size and type) explicitly, and the kernel applies it to every market.
- Test: Creating a batch at a size that no approved master lists is refused. A packaging order for a pack type with no approved packaging master is refused.

### PR-02 Master preparation, independent check and quality-unit approval
- Covers: n97, n618
- Type: ENFORCED (minimum route) + CONFIGURABLE (extra reviewers). Default: the checker and the QCU approver must be different users. Allowed: the checker may also be the QCU approver.
- Behaviour: Master lifecycle is Draft -> Checked -> Approved -> Effective. The minimum route is:
  - the preparer's dated e-signature;
  - an independent checker's dated e-signature (a different individual from the preparer);
  - a quality-unit approval e-signature.
  Before the checker can sign, automated consistency checks run: BOM total against batch size, unit consistency, formula syntax, limits within registered values, and a typed entry field for every data point. The effective date is mandatory, and approval does not make the master executable before that date. Every master and every rendered output carries a unique document ID and version. Customers may add signers but cannot remove the minimum. A "skip review" switch exists only in non-GMP test mode.
- Citations: US: 211.186(a); 211.100(a); 211.22(c); 11.1(c); 11.100(c) | EU: Ch.4 Principle (instructions error-free and in writing); 4.1; 4.2; 4.3; 4.4 | ICH/EMA/draft: none
- Jurisdiction: US explicitly requires an independent check of the master by a second person, so US is stricter here. EU requires approval, signature and dating by authorised persons, plus a defined effective date; EU is stricter on the effective date. 211.186(a) asks for a "full signature, handwritten". A Part 11-compliant e-signature counts as its equivalent (11.1(c)), provided the firm has filed the 11.100(c) certification with FDA.
- Test: When the same user tries to prepare and check a master, the check is refused. A master with no effective date cannot be approved. A seeded unit error is caught before the check signature.

### PR-03 MBR content completeness gate
- Covers: n90, n89, n91, n99, n37 (mapped from the data-integrity list; same obligation)
- Type: ENFORCED
- Behaviour: The MBR designer refuses submission for approval unless every item in Section (a)-1 (processing) or (a)-2 (packaging) is present, for the markets in the product's market set. Specifically:
  - every data-entry point has a typed field (unit, precision, range or list);
  - every CPP and IPC has limits;
  - every yield checkpoint has a theoretical basis and min/max limits;
  - every printed component has a specimen (see D-1).
  An item may be marked "not applicable" only if the rule itself makes it conditional ("where applicable", "where appropriate", "where necessary"), and only with a signed justification.
- Citations: US: 211.186(b)(1)-(9); 211.100(a); 211.101(a); 211.110(a)-(b); 211.111; 211.125(c) | EU: Ch.4 4.6; 4.17(a)-(d); 4.18(a)-(g); 4.19(a)-(i) | ICH/EMA/draft: none
- Jurisdiction: See Section (a). US is stricter on labeling specimens, active content per dosage unit, calculated excess and yield limits. EU is stricter on equipment preparation, pre-start clearance checks, bulk storage requirements and packaging-instruction detail.
- Test: Starting from a complete test master, delete one mandatory item at a time. Approval is refused each time, and the refusal names the missing item.

### PR-04 Registration (MA / application) conformity and market validity of masters
- Covers: n629, n187, n218, n219
- Type: CONFIGURABLE. Default: hard block when a registered-flagged limit is wider than the registered value, or when a registered element changes without a recorded regulatory action for that market. Allowed: warning only, for elements not flagged as registered or Established Condition.
- Behaviour:
  - Each master version holds the registration references for each target market (EU MA number and variation; US application number and supplement).
  - Any master element can be flagged as registered or as an Established Condition (EC), with its market and reporting category.
  - Approval requires a regulatory-conformity sign-off.
  - A version becomes effective for a market only when all required approvals or notifications for that market are recorded.
  - A batch can be created only from a version valid for every market in its market set.
  - The batch record shows the master version and the registration references used.
  - A change linked to a PACMP stays open until the protocol's acceptance criteria are met on the eBMR batches it names.
- Citations: US: 211.100(a); 211.186(b)(9) | EU: Ch.5 Principle; Ch.4 4.2 | ICH/EMA/draft: Annex 16 section 1 (s); ICH Q12 ch.3-5 (ECs, PACMP, PLCM) (s); EU Variations Guidelines applying from 15 Jan 2026 (s)
- Jurisdiction: EU text links production directly to the MA (Ch.5 Principle, 4.2). US reaches the application through 211.100(a) and FD&C Act filing rules (s). For a multi-market batch, the stricter rule is that both registrations must be satisfied at once, i.e. the process must run inside the intersection of the registered ranges.
- Test: Widening a registered CPP range with no variation reference is blocked. Creating a batch for a market not linked to the master is refused.

### PR-05 Master versioning, supersession, periodic review, retirement and document inventory
- Covers: n98, n627, n217
- Type: ENFORCED (supersession and retirement) + CONFIGURABLE (review interval, set by customer SOP; the texts give no number)
- Behaviour:
  - Once version n+1 becomes effective, no new batch can start on version n.
  - Batches already in progress follow a configured rule. Default: finish on the issued version; migration to the new version only under change control. The record shows which version governed each step.
  - Every master carries a periodic-review due date and an overdue alert.
  - A retired master blocks new batches, but every executed record stays retrievable and printable.
  - The system exports an inventory of its controlled documents (masters, templates, forms, label templates, embedded instructions) with ID, version, status, effective date and review date.
- Citations: US: 211.100(a); 211.186(a); 211.68(b) | EU: Ch.4 4.3; 4.5; 4.20; 4.21; 4.32; Annex 11 section 10 | ICH/EMA/draft: ICH Q10 1.6.1 and 3.1 (s)
- Jurisdiction: EU requires periodic review (4.5) and a document inventory (4.32) explicitly, so EU is stricter. Blocking superseded versions comes from 4.3 (effective date) and 4.20/4.21 (currently approved instructions), not from 4.5 (see D-11).
- Test: After v2 is effective, starting a batch on v1 is blocked. An overdue review appears on the dashboard. The inventory export reconciles with the site document list.

### PR-06 Change control for masters and linked GMP objects
- Covers: n215, n198, n143, n220, n606, n205
- Type: ENFORCED
- Behaviour: An Effective master cannot be edited. A new version needs a linked, approved change record that holds:
  - description and rationale;
  - a risk assessment whose formality matches the risk;
  - an impact assessment covering specifications, equipment, validation, cleaning, training, labels, products sharing the line, and other sites holding copies;
  - a regulatory-impact decision for each market;
  - a validation reference, for process-impacting changes (CPP ranges, equipment class, materials or suppliers, batch size, sequence, test method).
  A diff report lists the changed fields. Implementation is tracked per site. A post-implementation effectiveness review is scheduled automatically. Shop-floor test methods can only be changed through this route, with a reason and comparative data.
- Citations: US: 211.100(a); 211.22(c); 211.68(b); 211.194(b) | EU: Ch.5 5.24; 5.25; 5.26; Ch.4 4.29 (change control); Annex 11 section 10 | ICH/EMA/draft: ICH Q10 3.2.3 (s); ICH Q9(R1) 5.1 (s); ICH Q12 ch.6 (s); EU Annex 15 section 11 (u)
- Jurisdiction: The intent is equivalent. EU requires validation of significant process changes explicitly (5.25), and US requires QCU approval of changes to procedures (211.100(a)). The kernel applies both.
- Test: A direct edit of an Effective master is impossible. A process-impacting change with no validation link cannot be approved. The diff report lists exactly the changed fields.

### PR-07 Quality-risk-management linkage for risk-based settings
- Covers: n204, n205, n206, n207, n211, n210, n109
- Type: CONFIGURABLE. Default: every master element classified critical must cite an approved, versioned risk assessment. Allowed: extend the requirement to all elements. Not allowed: removing it for critical elements.
- Behaviour:
  - Scope: this applies to risk-based settings in a master, namely criticality, verification mode, IPC frequency and sample size, hard vs soft limits, review-by-exception scope, and campaign or concurrency rules. Each cites a risk assessment by ID and version.
  - Scoring scales are controlled master data.
  - Assessments store the formality level and its reasons, and keep hazard, harm, probability, severity and detectability as separate fields.
  - Linked events raise a re-review task, and review-by-exception for the affected step pauses until QA confirms. Linked events are repeated deviations on a step, a PQR finding, or a change.
  - Reducing IPC frequency requires change control that cites trend data.
- Citations: US: none binding (Q9 is FDA guidance (s)) | EU: Annex 11 section 6 (criticality via risk management); Ch.5 5.20-5.21 | ICH/EMA/draft: ICH Q9(R1) sections 3, 4.3, 4.6, 5.1-5.3, Annex II (s); EU Ch.4 draft 4.13 (draft)
- Jurisdiction: This is guidance level in both regions. EU GMP Part III incorporates Q9 (s). The default is a recommended configuration, not a legal minimum.
- Test: Submitting a master with a critical parameter and no linked assessment is blocked. Three deviations on a low-risk step open a re-review task and pause review-by-exception for that step.

### PR-08 CPP and IPC limit model (validated, registered and internal tiers)
- Covers: n195, n189, n90
- Type: ENFORCED (units, limits and source on every CPP/IPC; out-of-limit values stored and flagged) + CONFIGURABLE (limit tiers and breach action). Default: breaching a registered or action limit stops the next dependent step until a deviation is opened. Allowed: for internal (non-registered) limits, the step may continue with a deviation.
- Behaviour: Each CPP and IPC field stores its unit, precision, limits and source (validation report or registration). Limits are tiered: registered, internal action, and optional alert. A result outside a registered limit automatically creates a deviation flagged "registration-relevant", which appears on the QCU/QP release screen. Out-of-limit values are stored exactly as acquired. The operator cannot suppress the flag, and re-entry is a correction, not a replacement.
- Citations: US: 211.110(b); 211.186(b)(9); 211.100(b) | EU: Ch.4 4.18(d)-(e); Ch.5 5.43 | ICH/EMA/draft: EU Annex 15 section 5 (u); Annex 16 section 3 and EMA Q&A on Annex 16 (s)
- Jurisdiction: US is more explicit that in-process specifications must match final specifications and be derived statistically where possible (211.110(b)). Tagging registered limits serves the EU Annex 16 route (s), which has no US counterpart.
- Test: A value outside a registered limit creates a deviation with the registration flag, and it is visible on the release screen. The operator cannot clear the flag.

### PR-09 Process validation status and validation-batch flags
- Covers: n143, n197, n80, n196
- Type: CONFIGURABLE. Default: a batch made under a PPQ or concurrent-validation protocol is flagged, and cannot be certified or released until its validation outcome is recorded. Allowed: US-only batches may be released per an approved protocol that permits concurrent release. For EU certification there is no exception (Annex 15 (u)).
- Behaviour:
  - A master records its validation basis (report IDs).
  - Batches under a protocol carry a visible flag and an enhanced sampling plan.
  - The release screen shows the protocol and report status.
  - CPP and IPC data can be exported as structured data (with record counts or checksums) for CPV/OPV trending.
- Citations: US: 211.100(a); 211.110(a) | EU: Ch.5 5.23; 5.24; 5.25; 5.26; 5.42 | ICH/EMA/draft: FDA Process Validation guidance (2011) stages 2-3 (s); EU Annex 15 section 5 (OPV, concurrent validation) (u)
- Jurisdiction: EU expects the QP to have concurrent-validation results before certifying (Annex 15, (u)). For US this is at guidance level. EU is stricter.
- Test: A PPQ-flagged batch cannot be released or certified until the validation outcome is entered. CPP data exported for N batches and recomputed from the source records match exactly.

## B. Batch record issuance and execution

### PR-10 Batch record issuance and batch numbering
- Covers: n97, n1
- Type: ENFORCED
- Behaviour:
  - The batch record is generated programmatically from the Effective master version, with no retyping.
  - The system verifies that the instance matches the master (hash or field comparison).
  - An authorised issuer e-signs and dates the issued record, with signature meaning "issued, reproduction verified".
  - The batch number comes from a controlled sequence. It is unique per site and product and has a globally unique internal key.
  - The destination-market set is recorded at issue. Packaging orders may narrow it later under control.
  - Later master edits never change an issued record.
  - Test, simulation and training runs are segregated, watermarked and cannot become GMP records.
- Citations: US: 211.188(a); 211.186; 211.130(c); 210.3(b) lot-number definition (s) | EU: Ch.4 4.2 (working copies from masters must not introduce errors); 4.20 and 4.21 (records based on approved instructions) | ICH/EMA/draft: none
- Jurisdiction: US explicitly requires that the reproduction be checked for accuracy, dated and signed (211.188(a)), so US is stricter: the issuance signature is mandatory for all markets. EU requires only that the reproduction method cannot introduce errors.
- Test: An issued record matches the master hash and carries the issuance e-signature. A duplicate batch number is rejected. A record cannot be issued from a Draft master.

### PR-11 Contemporaneous recording, time stamps, late entries and paper fallback
- Covers: n100, n99, n618
- Type: ENFORCED (server-side time; no backdating) + CONFIGURABLE (what counts as late). Default: any entry made after the step's planned window has closed is flagged.
- Behaviour:
  - Action times come from a synchronised server clock (stored as UTC plus the site offset). A user can never set the time of an action.
  - Late entries go only through an explicit late-entry path. It records the actual activity time as a data field, the entry time and a reason, and the entry is flagged in the exception report.
  - Downtime fallback: printable instructions and forms are generated from the Effective master. Each carries a unique form ID, the batch ID, "page x of y" and a dedicated space for every entry.
  - Issued fallback forms are counted and reconciled on return. Their data are transcribed back with verification, and a scan of the form is linked to the record.
- Citations: US: 211.100(b) (documented at time of performance); 211.188; 11.10(e) | EU: Ch.4 4.1 (hybrid systems); 4.6; 4.7; 4.8; Annex 11 section 16 | ICH/EMA/draft: EMA data-integrity Q&A / PIC/S PI 041 for fallback-form reconciliation (s)
- Jurisdiction: Equivalent.
- Test: A backdating attempt is impossible. A late entry shows both times, the reason and an exception flag. Issued fallback forms reconcile to returned forms.

### PR-12 Corrections to recorded data
- Covers: n101
- Type: ENFORCED (never overwrite; reason mandatory) + CONFIGURABLE (approval level for critical-data corrections). Default: second person or QA approves. The approval requirement cannot be removed; this is a design choice beyond the text.
- Behaviour: A correction keeps the original value visible in the record and in review views. The audit trail captures the old and new values, the user, the server time and the reason (mandatory). A correction after step sign-off requires re-signature. Corrections to critical data (quantities, CPP values, IPC results, yields) need the configured approval. Every correction appears in the exception report.
- Citations: US: 11.10(e); 211.100(b) | EU: Ch.4 4.9; Annex 11 section 9 | ICH/EMA/draft: none
- Jurisdiction: 4.9 asks for a reason only "where appropriate", but Annex 11 section 9 requires one for any change to GMP-relevant data. EU is therefore stricter, and the kernel always requires a reason.
- Test: Correct a signed weight. The original stays visible, a reason is required, the step must be re-signed, and the correction is listed in the exception report. A correction without a reason is refused.

### PR-13 Step-sequence enforcement and the in-line deviation path
- Covers: n119
- Type: ENFORCED + CONFIGURABLE (deviation classes and routing). Default: the operator cannot approve their own deviation (a design choice).
- Behaviour: The engine enforces step order, prerequisites and branch conditions. A user cannot skip or reorder a mandatory step, or use equipment or material the master does not list. The only way around the defined flow is an in-line deviation record (description, immediate action, impact) approved by the e-signature of a user designated competent for that deviation class. Planned departures are approved before execution; unplanned events are approved after the fact. Quality-relevant classes are routed to QC/QA. The deviation ID is linked to the step and shown in the record.
- Citations: US: 211.100(b); 11.10(f) | EU: Ch.5 5.15; Ch.4 4.20(h); 4.21(g) | ICH/EMA/draft: none
- Jurisdiction: EU requires written approval by a competent person, with QC involved when appropriate. US requires the deviation to be recorded and justified. EU is stricter on approval, and the kernel applies it for all markets.
- Test: Skipping a mandatory step is blocked until a deviation is approved by an authorised role. A user cannot approve their own deviation.

### PR-14 Significant steps: performer plus checker, and the limited scope of single-person automated checking
- Covers: n9, n39
- Type: ENFORCED
- Behaviour: The master flags steps as significant. Each significant step records a performer and a checker or supervisor, who must be a different authenticated individual.
  - Where "automated performance" may apply: the mode may cut the humans involved to one checker only for step types mapped to 211.101(c), 211.101(d), 211.103, 211.182 and 211.188(b)(11).
  - Device conditions: the device must be current in its calibration/check programme (211.68(a)), and the automated function must be validated (211.68(b)).
  - What is recorded in that mode: the device ID and raw data, plus one checker's e-signature whose stated meaning is "automated operation checked".
  - If automation is unavailable, the step escalates automatically to two-person mode and the fallback appears as an exception. "Unavailable" means the device is offline, a value is keyed manually, or a barcode is overridden.
  - What the flag can never relax: any other two-person rule, such as the independent check of the master (211.186(a)), the second-person verification of the 100% visual check of hand-applied labeling (211.122(g)(3)), and second-person review of lab records (211.194(a)(8)).
- Citations: US: 211.68(a)-(c); 211.188(b)(11); 211.101(c)-(d); 211.103; 211.182 | EU: Ch.4 4.20(c); 4.21(c) (checker "where appropriate"); Annex 11 section 6 | ICH/EMA/draft: none
- Jurisdiction: US requires a checker on every significant step. EU requires one only where appropriate. US is stricter, and the kernel applies it to all markets.
- Test: With the scale disconnected during an automated dispense, the step demands a second, different user. Enabling automated mode on a 211.122(g)(3) step is refused at configuration time.

### PR-15 Competence, role and area authorisation
- Covers: n142, n4, n634
- Type: ENFORCED (role/authority check at the moment of each action) + CONFIGURABLE (training-currency interlock and restricted-area interlock). Default: both interlocks ON. Allowed: OFF only where the evidence is controlled in another validated system that the eBMR queries.
- Behaviour: A user can perform, verify or approve only if they hold a role permitted for that action, step type, MBR and site. Performer and verifier are separate permissions. Optional interlocks:
  - current training on the governing SOP or master version;
  - authorisation for the restricted area where the step runs.
  [I] Gowning and APS qualification for aseptic areas come from Annex 1 and the FDA 2004 aseptic guidance, not from 211.28 (see sterile catalog).
- Citations: US: 211.25(a)-(c); 211.28(c); 11.10(g) | EU: Ch.5 5.1; 5.2; 5.16; EU Ch.2 (s) | ICH/EMA/draft: EU Annex 1 (gowning) (s)
- Jurisdiction: EU 5.16 restricts access to all production premises. US 211.28(c) covers only areas designated as limited-access. EU is broader. Hygiene and illness rules in 211.28(a),(b),(d) are organisational controls, not eBMR controls.
- Test: A user whose training has lapsed is refused on the step. A user without area authorisation cannot sign a step in the filling suite.

### PR-16 Record completeness gate (processing complete / packaging complete)
- Covers: n39
- Type: ENFORCED
- Behaviour: "Processing complete" and "Packaging complete" are allowed only when two conditions hold.
  - Every step is in one of three states: executed; marked N/A by the system (branch not taken); or marked N/A by an authorised user with a reason and signature.
  - Every applicable item of Section (a)-3 or (a)-4 is present. The items are: dates and times; equipment unit IDs; component lots and quantities; IPC and lab results; packaging-area checks before and after use; yields; labeling specimens; container/closure description; sampling; performer and checker IDs; investigations; 211.134 results; the responsible production person's approval.
  Category checks depend on step type; for example, packaging-area checks apply only to packaging orders.
- Citations: US: 211.188(b)(1)-(13) | EU: Ch.4 4.20(a)-(i); 4.21(a)-(i) | ICH/EMA/draft: none
- Jurisdiction: See Section (a).
- Test: Removing one label specimen or one checker signature blocks completion, and the message names the gap.

## C. Materials: receipt, status, dispensing and charge-in

### PR-17 Receipt, lot identity and approved source
- Covers: n597, n598, n621, n630, n638, n632, n637, n631, n599, n35, n141 (mapped from the data-integrity list; same obligation)
- Type: ENFORCED at the eBMR boundary: a lot with an incomplete receipt record cannot be dispensed or issued. The receipt functions themselves are a DESIGN-CHOICE, used only if the eBMR/MES suite performs receipt; otherwise ERP/WMS does, over an interface.
- Behaviour:
  - Lot identity:
    - Each lot of each shipment gets a unique internal receiving/control code. The same supplier lot arriving in two shipments gets two codes.
    - Each supplier batch in a multi-batch delivery becomes a separate internal lot.
    - The receipt record holds: name on the delivery note and containers; in-house name/code; date received; supplier and manufacturer; manufacturer batch number; total quantity and number of containers; internal lot number; remarks.
  - Receiving checks and quarantine:
    - Each container (or container group) is visually examined for labeling, damage, seal integrity (including any tamper-evident seal) and contamination. The examiner's identity is recorded.
    - If documents or labels disagree with the approved manufacturer/supplier list, the lot is blocked and routed to QC.
    - New lots default to Quarantine.
  - Problems after receipt: a problem with a container found at storage, dispensing or charging raises a record to QC and blocks that container.
  - Sampling:
    - Sampled containers are marked as sampled.
    - Sample labels identify the material, lot, source container, date and sampler.
    - Stratified sub-samples cannot be composited.
  - Other rules:
    - Bought-in intermediates and bulk follow the same flow as starting materials.
    - The approved-source check is repeated at dispensing (design choice).
- Citations: US: 211.80(a),(d); 211.82(a)-(b); 211.84(a)-(c); 211.184(a)-(b) | EU: Ch.4 4.22; 4.23; Ch.5 5.3; 5.4; 5.6; 5.27; 5.29; 5.30; 5.31; 5.33; 5.45 | ICH/EMA/draft: none
- Jurisdiction: EU requires a check against approved manufacturer/supplier data at every delivery (5.30) and API supply-chain traceability (5.29). US requires a distinct code for each lot in each shipment (211.80(d)). The kernel applies both.
- Test: One delivery containing three supplier batches creates three lots. A supplier label naming an unapproved manufacturer blocks the lot. A lot with no complete receipt record cannot be issued.

### PR-18 Material status and usability gate at dispensing, issue and charge-in
- Covers: n13, n622, n620, n601, n633, n28 (mapped from the data-integrity list; same obligation)
- Type: ENFORCED (status, identity and retest/expiry block) + CONFIGURABLE (rotation rule). Default: oldest approved first. Allowed: first-expiry-first-out with a documented SOP rationale.
- Behaviour:
  - What can be used: only lots in Released status, within their retest or expiry date, and of the exact item called for by the master (plus grade and approved source where the master specifies them). This applies to dispensing, issue and charge-in.
  - Hard blocks: quarantined, on-test, rejected, expired, retest-overdue and blocked lots, with no operator override.
  - Identity: confirmed by scanning system-generated labels.
  - Status and labels: the status on screen and on the physical label must agree, so a status change triggers relabelling.
  - Stock rotation: the system proposes the oldest approved lot first. Picking another lot needs a reason, which appears in a rotation-exception report.
  - Storage conditions: storage-condition attributes stop a lot from being staged in an incompatible location.
- Citations: US: 211.80(d); 211.84(a); 211.86; 211.87; 211.89 | EU: Ch.4 4.14(e); 4.24; Ch.5 5.5; 5.7; 5.32; 5.34 | ICH/EMA/draft: none
- Jurisdiction: EU 5.34 allows only QC-released material within its retest period. US 211.87 requires retesting "as necessary". EU is stricter, so the date-based block applies to all markets (D-2).
- Test: Scanning a quarantined lot is blocked. A lot past its retest date is blocked. Picking a newer lot demands a reason.

### PR-19 Dispensing targets and dispensing execution
- Covers: n11, n12, n120, n118
- Type: ENFORCED (label content, tolerance, designated dispensers, 100% intent check) + CONFIGURABLE (potency-adjustment method, per master)
- Behaviour:
  - Who dispenses: only users holding the dispenser designation, following the procedure embedded in the step.
  - Targets:
    - Targets come from the master formula, including any stated calculated excess.
    - Where the master calls for it, the target is adjusted for potency or assay. The adjustment uses the approved result of the released lot (never a typed value), and a compensating excipient quantity is calculated.
    - A master or target that would deliver less than 100% of the labeled amount of active ingredient is refused.
  - Weighing: quantities are captured from a calibrated device and checked against tolerance. An out-of-tolerance quantity cannot be confirmed without a deviation.
  - Container labels: each dispensed container is labeled automatically with:
    - component name or item code;
    - receiving/control number;
    - quantity in the container;
    - the destination batch (product name, strength, lot number);
    - a unique container ID (a design choice).
  - Reprints need a reason and void the earlier label.
- Citations: US: 211.101(a)-(b); 211.186(b)(4)-(5) | EU: Ch.5 5.12; 5.13; 5.37 | ICH/EMA/draft: none
- Jurisdiction: The at-least-100% intent rule and the four label elements are explicit US requirements. EU requires designated dispensers and clean, correctly labelled containers. The kernel applies both. Potency adjustment is one way to meet 211.101(a), not a mandate.
- Test: An API lot assayed at 98.5% raises the target and lowers the filler, with an audit trail. The label shows all four required elements. A non-designated user is refused.

### PR-20 Independent check of each dispensed material
- Covers: n13, n120
- Type: ENFORCED (manual mode) + CONFIGURABLE (automated mode). Default in automated mode: one human verifier who is not the user who started the dispense. Allowed: the same user, but only when the dispense ran on a validated automated device under 211.68 (see F-1). No mode allows zero human verification.
- Behaviour: In manual weighing, a second, different individual confirms three things for each dispensed container: the component was released by the QCU; the quantity matches the batch record; the container is correctly identified. All three outcomes are recorded with both identities and timestamps. In automated mode (validated scale, barcode and status interlocks, device in its calibration programme), one human verifier signs. If the device goes offline, the step reverts to two-person mode.
- Citations: US: 211.101(c); 211.68(c) | EU: Ch.5 5.38; Annex 11 section 6 | ICH/EMA/draft: none
- Jurisdiction: US requires a second person unless the operation is automated, and then still one person. EU requires an independent, recorded check but does not require a second person. US is stricter because it always requires a human verification (D-3).
- Test: In manual mode, the same user dispensing and verifying is blocked. With the scale offline, the step switches to two-person mode.

### PR-21 Batch kit and charge-in verification
- Covers: n14, n120
- Type: ENFORCED + DESIGN-CHOICE. The design choice (default off) requires the verifier to sign within a set time window from a terminal registered to that room.
- Behaviour: Materials dispensed for a batch are grouped into a kit with a conspicuous batch label. A kit cannot be issued while a component is missing. Charge-in requires scanning every dispensed container, and each must match the batch, step and material, at the process point the master defines. A missing container blocks step completion, and an unplanned container is rejected. Every addition needs a performer and a different verifier, or one verifier when the addition is automated under 211.68.
- Citations: US: 211.101(d); 211.68(c); 211.188(b)(3)-(4) | EU: Ch.5 5.39; Ch.4 4.18(d) (sequence of addition); 4.20(d) | ICH/EMA/draft: none
- Jurisdiction: US explicitly requires second-person verification of each addition. EU requires kits kept together and labelled, and a defined order of addition. US is stricter on the witness, and the kernel applies it to all markets.
- Test: Omitting one container prevents completion. A wrong container is rejected. A verifier who is also the performer is blocked.

## D. Equipment, premises, cleaning and logs

### PR-22 Equipment and container identification
- Covers: n16, n118
- Type: ENFORCED (unit ID in the record; contents and status identification) + DESIGN-CHOICE (barcode/RFID; electronic status displays in place of paper labels)
- Behaviour:
  - Every major equipment item has a distinctive ID. The ID is recorded automatically in the batch record at unit level (not just the equipment class) and checked against the classes and units the master allows.
  - The following show product or material, strength, batch number and stage, in the company's approved label format: every compounding and storage container, bulk container, processing line and major equipment item, and rooms where appropriate. A physical label or a validated electronic display may be used.
  - Identification is updated on every state change.
  - Colour coding is optional.
- Citations: US: 211.105(a)-(b); 211.188(b)(2) | EU: Ch.5 5.12; 5.13; Ch.4 4.20(e); 4.21(e) | ICH/EMA/draft: none
- Jurisdiction: EU adds strength and, where appropriate, rooms. US adds the processing phase where necessary. The kernel applies the union of both.
- Test: A step with a unit the master does not allow is rejected. The batch report shows unit IDs. The status display matches the system state after each transition.

### PR-23 Equipment and instrument status gate before use
- Covers: n6, n605, n198, n199, n90
- Type: ENFORCED (checks run and block) + CONFIGURABLE (clean-hold and dirty-hold limits, campaign length and changeover matrix; values come from cleaning validation, not from the rule)
- Behaviour:
  - At step start, the engine checks that the scanned unit:
    - belongs to the required equipment class and capacity;
    - is qualified;
    - has no overdue calibration or preventive maintenance;
    - is Clean at the cleaning level the changeover matrix requires, and within its validated clean-hold time;
    - is not allocated to another batch.
  - The pre-use cleanliness inspection is recorded.
  - Measuring instruments are blocked when their calibration is overdue or failed. Examples: balances, pH meters, checkweighers, gauges and integrity testers.
  - A failed as-found calibration lists all batches and steps that used the device after its most recent passing calibration, for impact assessment.
  - End of use sets the unit to Dirty and starts the dirty-hold timer.
- Citations: US: 211.63; 211.67(a)-(c) (incl. (b)(6) pre-use cleanliness inspection); 211.68(a); 211.160(b)(4); 211.194(d) | EU: Ch.4 4.18(b)-(c); 4.30; 4.31 | ICH/EMA/draft: EU Annex 15 section 10 (cleaning hold times) and section 4 (re-qualification) (u)
- Jurisdiction: Hold-time limits come from cleaning validation (Annex 15, (u)), not from 211.67 or Ch.5, so their values are configurable. The block itself is enforced once a value exists. US states explicitly that out-of-specification instruments must not be used (211.160(b)(4)).
- Test: A Dirty unit is blocked. An expired clean-hold is blocked. A balance with overdue calibration is blocked. A failed as-found calibration produces the list of affected batches.

### PR-24 Equipment and area logbooks
- Covers: n34, n6, n635 (mapped from the data-integrity list; same obligation)
- Type: ENFORCED
- Behaviour:
  - Scope: electronic logbooks for each major production equipment item, each major or critical analytical instrument used on the shop floor, and (EU in set) each area where product is processed.
  - Content: logbooks are filled automatically from eBMR events:
    - use start and stop, with product, lot, date and time;
    - cleaning, with a performer plus a second person verifying, or a single verifier when a validated automated CIP/SIP did the cleaning;
    - maintenance other than routine lubrication and adjustment (from a CMMS link);
    - calibration;
    - repairs.
  - Order: entries are kept in chronological order. Late or out-of-sequence entries are flagged with a reason, and the original chronology is preserved.
  - US dedicated-equipment option: dedicated equipment may skip an individual log only when EU is not in the market set. In that case its cleaning, maintenance and use records are embedded in each batch record, and the lot-number sequence is checked.
- Citations: US: 211.67(c); 211.182; 211.180 | EU: Ch.4 4.29 (maintenance, cleaning); 4.31 | ICH/EMA/draft: none
- Jurisdiction: EU 4.31 reaches further: logbooks for areas and critical analytical equipment, including repairs and calibrations, with no dedicated-equipment exemption. US 211.182 is stricter on double-checked cleaning and maintenance signatures. The kernel applies the union of both (D-14).
- Test: Each batch appears in the logbook with its date, time, product and lot, consistent with the batch records. The same user performing and verifying a manual cleaning is blocked. A room logbook shows use and cleaning.

### PR-25 Room and area suitability, occupancy and sanitation status
- Covers: n117, n592, n595, n593
- Type: ENFORCED (occupancy, permitted area type, maintenance and cleaning status) + CONFIGURABLE (room-condition checks). Default: ON wherever the master states conditions. Concurrent use of a room needs a configuration that cites a risk assessment; QA approval of that configuration is a design choice.
- Behaviour:
  - Room master data: area type; permitted activities and material statuses; cleaning/sanitation status and schedule; maintenance status.
  - Step binding: each step is bound to permitted area types. Execution is blocked in an unapproved area, a room under maintenance, or a room overdue for cleaning.
  - Occupancy: a room occupied by one product refuses a second product unless it is configured for concurrent use. Consecutive use by another product requires cleaning and clearance first.
  - Room conditions: where the master states conditions (temperature/RH, pressure cascade, dust extraction), the engine reads BMS/EMS status at step start and during the step. A breach blocks the step or raises a deviation, as the master rule says. Readings for the step window are attached to the record.
- Citations: US: 211.42(b)-(c); 211.46(a)-(c); 211.56(a)-(d); 211.58 | EU: Ch.5 5.9; 5.10; EU Ch.3 (s) | ICH/EMA/draft: none
- Jurisdiction: US permits "other control systems" instead of separate areas. EU permits simultaneous or consecutive work only where it creates no mix-up or cross-contamination risk. The effect is equivalent.
- Test: Starting product Y in a room occupied by product X is blocked. RH above the master limit blocks the step or raises a deviation. A room overdue for cleaning is blocked.

### PR-26 Processing pre-start clearance and transfer-route checks
- Covers: n116, n90, n140
- Type: ENFORCED (clearance before each processing operation; route check before each transfer) + CONFIGURABLE (checklist format for processing clearance: default ON, allowed OFF; second verifier: default ON, allowed OFF; repeat clearance after an interruption: default ON)
- Behaviour:
  - Before each processing operation, the system checks electronically that:
    - the previous batch is closed in the room and equipment logs;
    - the equipment is Clean;
    - no materials of other orders are allocated to the room.
  - The operator then confirms that no foreign materials, products, residues or documents are physically present. The confirmation is e-signed into the record.
  - Before a product transfer through pipework, hoses or transfer panels, a connection check is recorded.
  - Design choice for the route check: scan the source, route components and destination and compare them with the master route. A mismatch blocks the transfer.
- Citations: US: 211.67(b)(6); 211.100(a) | EU: Ch.4 4.18(c); Ch.5 5.14; 5.40 | ICH/EMA/draft: none
- Jurisdiction: EU explicitly requires processing-area clearance (5.40, 4.18(c)) and transfer-connection checks (5.14). US requires only a pre-use cleanliness inspection of equipment. EU is stricter. A checklist is not required for processing clearance (D-5).
- Test: Starting compounding while the prior batch is not cleared is blocked. Scanning a hose to the wrong destination blocks the transfer.

### PR-27 Cross-contamination controls: dedication, changeover, campaigns, penicillin, dust and events
- Covers: n121, n139, n594, n636, n635 (mapped from the data-integrity list; same obligation)
- Type: ENFORCED (penicillin segregation; enforcement of whatever dedication and changeover rules are configured) + CONFIGURABLE (the QRM-derived values themselves)
- Behaviour:
  - QRM outputs on the product master:
    - reference to HBEL-based cleaning limits;
    - dedication flags for facility, area, equipment and product-contact parts (e.g. punches and dies [T]; filters and filling needles [I]);
    - allowed rooms and equipment, and campaign rules;
    - the cleaning level required for each changeover;
    - whether cleaning verification is needed after a campaign, for higher-risk products.
    The engine enforces all of these.
  - Penicillin:
    - Penicillin products and components can never be assigned to non-penicillin facilities or equipment, and vice versa.
    - A non-penicillin lot flagged as potentially exposed needs a penicillin test showing none detected before release.
  - Dust [T]: open handling of potent or sensitising dry materials requires containment or extraction prerequisites (a design choice).
  - Events:
    - An event log (spill, breakage, containment breach) is linked to the batch and to the room and equipment logbooks.
    - Logging an event sets the room or equipment to "cleaning required".
    - Events feed the deviation process and the periodic review of cross-contamination measures.
  - Non-medicinal products cannot be scheduled on medicinal equipment without a recorded justification.
- Citations: US: 211.42(d); 211.46(d); 211.176; 211.67(a) | EU: Ch.5 5.10; 5.11; 5.17; 5.18; 5.19; 5.20; 5.21; 5.22 | ICH/EMA/draft: EMA guideline on health-based exposure limits (s)
- Jurisdiction: EU requires a documented QRM, including a toxicological evaluation, to set dedication and control measures (5.20), and periodic review of them (5.22). US sets hard penicillin segregation and testing (211.42(d), 211.176). The kernel applies both. Cleaning verification at every changeover is not required (see C-7).
- Test: A potent product on non-dedicated equipment outside its allowed list is blocked. A penicillin component in a non-penicillin facility is blocked. A spill event sets the room to "cleaning required".

### PR-28 Microbiological-control and sterility-assurance prerequisites (kernel hook)
- Covers: n20, n626
- Type: ENFORCED [I] / CONFIGURABLE [T]
- Behaviour:
  - [I] Sterilised items: the engine blocks consumption of sterilised or depyrogenated items unless the cycle ran a validated recipe/version for that load and passed.
  - [I] Aseptic steps: the engine blocks them unless the line and its operators hold current APS qualification and the items are within validated hold times. The detailed rules are in the sterile catalog.
  - [I] Monitoring data: environmental and personnel monitoring results for the rooms and time window are linked to the batch. Open excursions appear at QA review and QP certification.
  - [T] Masters may define microbial controls, such as aqueous granulation hold limits and water-system status. Rooms and times used stay traceable so EM data can be retrieved.
- Citations: US: 211.113(a)-(b); 211.94(c) | EU: Ch.4 4.27; 4.29 (environmental monitoring); Ch.5 5.10 | ICH/EMA/draft: EU Annex 1 (2022) (s); FDA aseptic processing guidance (2004) (s)
- Jurisdiction: 211.113(b) requires validated aseptic and sterilisation processes. The specific gates come from Annex 1 and the FDA 2004 guidance, not from the text of 211.113.
- Test: A failed autoclave cycle prevents issue of the load's items. An open EM excursion appears on the QP screen.

## E. In-process controls, time limits and yields

### PR-29 In-process controls and sampling
- Covers: n604, n623, n133, n606, n18, n210
- Type: ENFORCED (plan execution, sample identity, result recording) + CONFIGURABLE (frequency and sample size per master, each citing a QRM reference)
- Behaviour:
  - IPC plans and samples:
    - Every IPC or sample is created from a plan defined in the master. The plan sets the sampling point, method, frequency, sample size or units, limits, procedure version, tool and precautions.
    - Each sample gets a unique ID and a label (product, lot, sampling point, date/time, sampler).
    - Sample quantities count in yield and reconciliation.
    - Taking fewer units than the plan requires, or missing an IPC in its interval, creates an exception or deviation.
  - Results:
    - Each result is recorded with its performer and method reference.
    - A repeat test is added as a new result and never overwrites the first.
    - Reagents, buffers and reference standards used in shop-floor tests are scanned by lot and checked for expiry and standardisation status.
  - Typical IPCs: [T] weight variation, hardness, thickness, disintegration, blend uniformity. [I] clarity, completeness or pH of solutions, bioburden, fill weight or volume.
  - [T] Failed IPC: a failed or missed periodic IPC holds, at container level, all output made after the most recent passing check.
  - PAT and models:
    - PAT or model results are accepted as IPC records carrying the model ID and version and the validity diagnostics.
    - A model output outside its validity domain requires a confirmatory test. This follows the FDA draft position (draft).
- Citations: US: 211.110(a)-(c); 211.160(b)(2)-(3); 211.165(c); 211.194(b)-(c); 211.188(b)(5),(10) | EU: Ch.4 4.18(e); 4.25; 4.26; Ch.5 5.43 | ICH/EMA/draft: FDA draft guidance "Considerations for Complying With 21 CFR 211.110" (Jan 2025) (draft)(s); ICH Q9(R1) Annex II (s)
- Jurisdiction: US is more prescriptive. It lists IPC categories that apply "where appropriate" (211.110(a)(1)-(6)) and wants in-process specifications derived from process averages and variability. EU requires IPC instructions with limits, and IPCs that are carried out and recorded.
- Test: Taking fewer units than the plan requires creates a deviation. Both results of a repeated IPC are visible. An expired pH buffer is blocked. [T] A skipped hardness check puts output since the last passing check on hold.

### PR-30 Time limits and hold times
- Covers: n19, n125
- Type: CONFIGURABLE. The master defines timers where appropriate, each with a validation or registration reference. Default on breach: a deviation is created and release is blocked until it is dispositioned. Timers are never evaluated from client clocks.
- Behaviour:
  - Named timers have start and end events. They run server-side from persisted timestamps.
  - A timer warns before expiry. On breach it creates a deviation that needs justification and a QA assessment.
  - Holds of intermediates and bulk record the container, location, storage condition and maximum hold time.
  - A maximum filling-to-labelling interval for unlabelled units is a design choice.
- Citations: US: 211.111; 211.110(c) | EU: Ch.4 4.18(f); Ch.5 5.41; 5.54 | ICH/EMA/draft: EU Annex 1 (s), for sterile-process timers
- Jurisdiction: US explicitly requires time limits where appropriate, and departures must be justified and documented. EU requires appropriate holding conditions and bulk storage requirements. US is stricter, and the kernel applies it to all markets.
- Test: A simulated breach creates a deviation automatically and flags the batch. After a client and server restart, the elapsed time is still correct.

### PR-31 Yield calculation, verification and investigation
- Covers: n15, n1, n115, n89
- Type: ENFORCED + DESIGN-CHOICE. Design choices: the verifier must not be the person who entered the quantities; optional alert limits.
- Behaviour:
  - Checkpoints: the master defines a yield checkpoint at each appropriate phase. Each has a theoretical basis (excluding materials flagged as lost in processing), a formula, a rounding rule and min/max limits.
  - Calculation: the system calculates actual yield and percent of theoretical from the captured quantities (inputs, outputs, samples, rejects, waste). Users cannot type a yield percentage.
  - Verification: every automated calculation is independently verified by one person. A manual calculation needs a performer and a second verifier.
  - Out of limits: a result outside the limits automatically creates an investigation and blocks release.
  - Corrections: changing any input quantity triggers an audit-trailed recalculation of the yield.
- Citations: US: 211.103; 211.186(b)(6)-(7); 211.188(b)(7); 211.192; 210.3(b) yield definitions (s) | EU: Ch.4 4.17(c)-(d); 4.20(g); Ch.5 5.8; 5.44 | ICH/EMA/draft: none
- Jurisdiction: US requires independent verification of every yield calculation and ties investigation to the master's min/max limits. EU requires an expected final yield with limits, and investigation of significant yield deviations. US is stricter (D-9).
- Test: A yield of 94.0% against limits of 95.0-101.0% creates an investigation automatically and blocks release. Without a verifier the step cannot complete. An independent recalculation matches the displayed yield.

## F. Packaging and labeling

### PR-32 Receipt, examination, segregated storage and access control for labeling and packaging materials
- Covers: n126, n22 (mapped from the data-integrity list; same obligation)
- Type: ENFORCED at the eBMR boundary (usable only when complete) + DESIGN-CHOICE (if the suite performs receipt itself)
- Behaviour:
  - Receipt and examination:
    - Every incoming lot of primary or printed packaging gets its own reference number.
    - Each shipment of labeling or packaging material is sampled representatively and examined or tested against its specification before use, including the text/artwork version.
    - A record shows the receipt, the examination and whether the shipment was accepted or rejected.
  - Storage and access:
    - Labels and labeling are stored separately for each product, strength, dosage form and quantity of contents, with identification, in access-controlled locations.
    - Cut labels and loose printed items are stored and moved in closed containers whose IDs are recorded.
  - Obsolete material: obsolete or outdated labels, labeling and packaging materials are blocked and routed to destruction with a record. This covers superseded artwork and material past its expiry or retest date.
  - Gang printing: gang-printed labeling for different products, strengths or net contents is refused unless it is differentiated by size, shape or colour.
- Citations: US: 211.122(a)-(f); 211.184(a),(b),(d),(e) | EU: Ch.4 4.14 (specimen of printed materials in the specification); 4.22; Ch.5 5.46; 5.47; 5.48 | ICH/EMA/draft: none
- Jurisdiction: US is explicit on separate storage by product, strength, form and quantity, and on the gang-printing prohibition. EU is explicit on closed containers for cut labels and on recording destruction. The kernel applies both.
- Test: Issuing a label lot with obsolete artwork is blocked. An unauthorised user cannot open a label-store transaction.

### PR-33 Labeling issuance and packaging-material verification at line start
- Covers: n24, n23, n124 (mapped from the data-integrity list; same obligation)
- Type: ENFORCED
- Behaviour:
  - Only an authorised role can issue packaging materials of any kind, following an approved procedure.
  - Labeling issued for a batch is scanned by its reference number. It is examined for identity and for conformity with the labeling the master specifies (artwork version, text, NDC/GTIN where applicable).
  - Issued quantities are recorded for reconciliation.
  - At line start, every packaging component and bulk container is scanned against the packaging master BOM (quantity, identity, conformity). The result is recorded in the packaging record before packaging can start.
- Citations: US: 211.125(a),(b),(f); 211.130(d); 211.184(d) | EU: Ch.5 5.46; 5.52; Ch.4 4.21(d),(h) | ICH/EMA/draft: none
- Jurisdiction: Equivalent.
- Test: Scanning a wrong carton code is blocked. Packaging cannot start until the issued quantity is recorded.

### PR-34 Packaging line clearance before and after use
- Covers: n123, n24, n39
- Type: ENFORCED (pre-use clearance against a checklist; post-use inspection) + CONFIGURABLE (second-person verifier). Default: ON. Allowed: OFF, unless the customer designates clearance a significant step under 211.188(b)(11), in which case it is ON.
- Behaviour:
  - Pre-use clearance:
    - The first step of every packaging order is line clearance against a line-specific checklist defined in the master. The checklist covers the work area, lines, printers and coders, vision recipes, reject bins and documents.
    - Clearance cannot be completed while the previous order on the line is still open or unreconciled, or while components of another order remain allocated to the line.
    - No packaging step, print job or line start is possible until clearance is signed.
  - Post-use inspection: at order end, an inspection of the packaging and labeling area after use is recorded in the packaging record.
- Citations: US: 211.130(e); 211.188(b)(6) | EU: Ch.4 4.19(f)-(g); Ch.5 5.50 | ICH/EMA/draft: none
- Jurisdiction: EU requires the clearance to follow a checklist (5.50). US requires an inspection before use, and documentation of inspections both before and after use (211.188(b)(6)). The kernel applies the union: checklist, before and after (D-4, D-5).
- Test: Starting packaging without a signed clearance is blocked. Closing an order without the post-use inspection is blocked.

### PR-35 Packaging segregation and line identification
- Covers: n122, n24
- Type: ENFORCED
- Behaviour: A line runs only one active packaging order (one product, strength and lot) at a time. A different product cannot start on an adjacent line that is not physically segregated; segregation is an attribute of lines and rooms. Every packaging station or line shows the product name and batch number of the active order (on an HMI or a line board). The display clears only after order close and line clearance.
- Citations: US: 211.130(a); 211.42(c)(6) | EU: Ch.5 5.49; 5.51 | ICH/EMA/draft: none
- Jurisdiction: US accepts physical or spatial separation. EU requires physical segregation for different products packaged close to each other. EU is stricter.
- Test: Starting product Y on an unsegregated adjacent line while product X runs is blocked. The station display shows the product and batch.

### PR-36 Printing, coding, variable data and cut-label controls
- Covers: n127, n84, n85, n128 (mapped from the data-integrity list; same obligation)
- Type: ENFORCED (variable data from the record; print checks; one of the 211.122(g) options whenever cut labeling is used) + CONFIGURABLE (print-check method). Default: 100% vision inspection. Allowed: start-up plus periodic checks with specimens.
- Behaviour:
  - Variable data:
    - Variable data are sent electronically from the batch record to printers and coders: lot, expiry, NDC/GTIN, serial number.
    - Manual keying is blocked, or detected by vision.
    - A print job is invalidated if batch data change after set-up.
  - Print checks:
    - Printing devices are monitored so every imprint matches the print specified in the record.
    - A start-up check is recorded before the line enters production mode, followed by periodic checks with specimen images.
    - Hand printing is re-checked at a configured interval.
  - Durability: printed and embossed information must be clear and durable against fading or erasure. This is confirmed when the artwork or specification is approved.
  - Cut labels on immediate containers, unit cartons or qualifying multi-unit cartons: the packaging master cannot be approved without one of these four controls:
    - a line dedicated to each strength of each product;
    - electronic or electromechanical 100% examination for correct labeling;
    - 100% visual examination of hand-applied labeling by one person, verified independently by a second (never reducible under 211.68(c));
    - an automated technique that physically prevents incorrect labeling.
    Off-line overprinting is flagged for extra controls.
  - US barcode: at least the NDC, in a linear or 2D symbology to a recognised standard. The NDC master holds 10- and 12-digit formats with effective dates, and the NDC recorded on a historical lot is never rewritten.
- Citations: US: 211.122(g)(1)-(4), (h); 211.130(c); 201.18 (s); 201.25 as revised by the March 5, 2026 NDC final rule (12-digit NDC effective March 7, 2033; transition to March 6, 2036) (s) | EU: Ch.5 5.55; 5.56; 5.57; 5.58; Ch.4 4.21(f) | ICH/EMA/draft: none
- Jurisdiction: US mandates one control from a closed list whenever cut labels are used, and requires monitoring of printing devices. EU requires every printing operation to be checked and recorded, prefers roll-fed labels, and asks for special care with cut labels. US is stricter on cut labels. The kernel applies the union.
- Test: Changing batch data after print set-up invalidates the job. A wrong expiry printed on a test unit is rejected by vision and stops the line. A packaging master using cut labels with no 211.122(g) option cannot be approved.

### PR-37 On-line packaging controls, label examinations and unusual events
- Covers: n129, n26, n130, n128 (mapped from the data-integrity list; same obligation)
- Type: ENFORCED + DESIGN-CHOICE. Design choices: the person who raises an event cannot approve its reintroduction; units not reintroduced default to reject.
- Behaviour:
  - Minimum IPC plan:
    - At a defined frequency, with pass/fail and sample counts, the packaging IPC plan checks at least: pack appearance; completeness; correct product and materials; correct overprint; correct functioning of line monitors (code readers, label counters, vision systems).
    - A missed IPC raises an alert and an exception.
  - Label examinations:
    - During finishing, packages are examined for the correct label.
    - At completion, a representative sample is visually examined for correct labeling. The sample size is set by SOP; AQL is optional.
    - Both results are recorded.
  - Samples: withdrawn samples are recorded by quantity and purpose. No transaction returns sampled units to the line.
  - Unusual events:
    - Units involved in an unusual event (jam, drop, suspected mix-up) are counted into a set-aside bucket linked to an event record.
    - They can be reintroduced only after a special inspection, a linked investigation and approval by an authorised role; every part of this is recorded in detail.
    - Set-aside quantities flow into reconciliation.
- Citations: US: 211.134(a)-(c); 211.188(b)(13); 211.100(b); 211.192 | EU: Ch.5 5.57; 5.59; 5.60; Ch.4 4.19(i); 4.21(d),(g) | ICH/EMA/draft: none
- Jurisdiction: US requires the end-of-run representative label examination. EU requires the minimum on-line checks, checks that devices work, and controlled reintroduction after unusual events. The kernel applies the union.
- Test: Skipping the end-of-run examination prevents order completion. Adding samples back to good output is impossible. Reintroducing 40 jammed units without approval is blocked.

### PR-38 Filled but unlabelled containers ("bright stock")
- Covers: n24, n125
- Type: ENFORCED + DESIGN-CHOICE (maximum unlabelled hold time, with an alert)
- Behaviour: Filled, unlabelled containers held for later labelling are tracked as quarantined intermediates at tray or container level. Their identification must be enough to determine name, strength, quantity and lot; each unit does not need its own label. Location and hold start are also recorded. A labelling order can consume only bright stock of the matching batch, verified by scan, and reconciles it at labelling. Containers must be clean before filling, and foreign-matter checks run where the master defines them.
- Citations: US: 211.130(b); 211.94(c) | EU: Ch.5 5.53; 5.54 | ICH/EMA/draft: EU Annex 1 (s) for depyrogenation and sterile holds [I]
- Jurisdiction: Equivalent. EU adds that labelling should normally follow filling as quickly as possible.
- Test: Labelling trays of batch A under an order for batch B is rejected. The unlabelled inventory reconciles to the labelling run.

### PR-39 Reconciliation of bulk, labeling, printed packaging materials and serials
- Covers: n131, n81, n23, n95 (mapped from the data-integrity list; same obligation)
- Type: ENFORCED (reconciliation, and investigation of discrepancies before release) + CONFIGURABLE (limits; labeling waiver). Default: no waiver.
- Behaviour:
  - Balance: at order close, for bulk and for each printed or labeling item, issued = used + destroyed + returned + samples + rejects + set-aside. This is reconciled against the units produced.
  - Limits: limits are narrow, preset in the master, and based on historical operating data.
  - Discrepancies: an out-of-limit or unusual discrepancy requires a linked investigation. Order close and release or certification stay blocked until it is satisfactorily explained.
  - Component lots: use of each component lot is reconciled and feeds the inventory records.
  - Serialised products: commissioned serials = packed + decommissioned, with zero unexplained serials.
  - Labeling waiver: labeling reconciliation may be switched off only when all of these hold:
    - the labeling is cut or roll labeling;
    - a validated 100% electronic examination under 211.122(g)(2) is active;
    - (EU in set) robust electronic controls are documented.
    Reconciliation of bulk and batch-coded printed material is never waived when EU is in the set.
- Citations: US: 211.125(c); 211.184(c); 211.192; DSCSA 581/582 (s) | EU: Ch.4 4.21(h); Ch.5 5.8; 5.61 | ICH/EMA/draft: none
- Jurisdiction: The US waiver is narrow (cut or roll labeling plus 211.122(g)(2)). EU 4.21(h) allows quantities to be left out of the record when electronic controls are robust, but 5.61 still requires discrepancies to be explained before release. The kernel applies the stricter combination (D-6).
- Test: 12 labels unaccounted for against a limit of 0 creates a deviation and blocks close and release. Enabling the waiver without a 211.122(g)(2) device is refused.

### PR-40 Packaging close-out: batch-coded leftovers and returns to stock
- Covers: n132
- Type: ENFORCED + DESIGN-CHOICE (witness signature on destruction)
- Behaviour: At order close, unused labeling and packaging materials that carry the batch code are destroyed, with quantity, method, date and performer recorded, and cannot be returned to stock. Uncoded printed leftovers can return only through a counted return-to-stock transaction, following the documented procedure, and are identified and stored to prevent mix-ups.
- Citations: US: 211.125(d)-(e) | EU: Ch.5 5.62; Ch.4 4.21(h) | ICH/EMA/draft: none
- Jurisdiction: Equivalent. EU requires the destruction to be recorded; US requires destruction of excess labeling that bears lot or control numbers.
- Test: No transaction exists to return batch-coded cartons to stock. A return of uncoded labels updates stock only after a count verification.

### PR-41 OTC tamper-evident packaging [T, US OTC retail only]
- Covers: n25
- Type: ENFORCED when the product master flag "US OTC retail" is true; not applicable otherwise
- Behaviour:
  - Required checks: the packaging master cannot be approved without steps that check the tamper-evident features (e.g. seal integrity, band presence).
  - Labeling-statement check: the statement must name every feature and any capsule-sealing technology, and refer to the identifying characteristic.
  - Capsules: two-piece hard capsules require verification of the sealing.
  - Failures: a failed seal check triggers segregation and a deviation.
- Citations: US: 211.132(a)-(c) (exemptions and related procedures in (d)-(f)) | EU: none in Ch.4/5 | ICH/EMA/draft: none
- Jurisdiction: US-only. The EU anti-tampering device for prescription products is a separate obligation (see PR-42).
- Test: An OTC packaging master without a tamper-evident check fails approval.

### PR-42 Serialisation, product identifiers and safety features
- Covers: n81, n82, n85
- Type: CONFIGURABLE per market (ON automatically when a market requires it)
- Behaviour:
  - US prescription packs (DSCSA):
    - Content: the product identifier is the NDC plus a serial of up to 20 characters, the lot and the expiry, in human- and machine-readable form.
    - Carriers: a 2D data matrix on packages; linear or 2D on homogeneous cases.
    - Before release, an automated check confirms that the lot and expiry encoded equal the record values.
    - Serial lifecycle events are recorded: allocated, commissioned, packed, decommissioned, sampled, destroyed.
    - A serial -> lot -> record lookup answers verification requests within 24 h (s).
  - EU prescription products in scope: a unique identifier and an anti-tampering device, per Directive 2011/62/EU and Delegated Regulation (EU) 2016/161 (s).
  - Release gate: release is blocked if serial reconciliation fails or serial events are missing.
- Citations: US: FD&C Act 581(14), 582(a)(9), 582(b) (s); FDA product-identifier Q&A (June 2021) (s); 201.25 (s) | EU: Directive 2011/62/EU; Delegated Regulation (EU) 2016/161 (s) | ICH/EMA/draft: none
- Jurisdiction: The two are separate obligations, one per market. A batch going to both markets needs separate market-specific packaging orders, each with its own identifier scheme.
- Test: A wrong expiry encoded in a test code is rejected. Serial reconciliation shows zero unexplained serials. A query on a commissioned serial returns its lot, expiry and status.

### PR-43 Expiry dating
- Covers: n607, n620, n27 (mapped from the data-integrity list; same obligation)
- Type: ENFORCED + CONFIGURABLE (start-of-shelf-life rule, set per product with QA approval; see F-9)
- Behaviour:
  - Calculation: the printed and recorded expiry is derived from the shelf life stated in the currently effective finished-product specification or product master, using the defined start-of-shelf-life rule. It is never typed.
  - Stability basis: the shelf life must reference approved stability data.
  - Labeling: storage conditions on the labeling are linked to the shelf life. Products reconstituted at dispensing carry both expiries.
  - Tentative dating: a shelf life based on accelerated data is flagged, so the batches made under it can be found.
  - Stability samples: samples drawn from a batch are recorded with quantity, container-closure, storage condition and study ID.
- Citations: US: 211.137(a)-(d); 211.166(a)-(b); 211.194(e) | EU: Ch.4 4.16 (shelf life in finished-product specification); 4.19(e) | ICH/EMA/draft: none
- Jurisdiction: Equivalent.
- Test: Changing the shelf life without a stability reference is blocked. A new shelf life applies only to batches made after its effective date.

### PR-44 Reserve samples
- Covers: n609, n610
- Type: ENFORCED (US in set) / CONFIGURABLE (EU rules; see F-8)
- Behaviour:
  - Product reserve samples (per lot):
    - The filling or packaging master includes a reserve-sample step for each lot.
    - Quantity: at least double the quantity required for all release tests, sterility and pyrogen tests excluded.
    - Container and storage: the marketed immediate container-closure (or one with essentially the same characteristics), labelled and stored as the labeling requires.
    - The reserve units count in yield and reconciliation.
  - Annual examination: the system schedules an annual visual examination of statistically selected lots. Deterioration found there opens an investigation.
  - Retention: disposal is blocked until 1 year after expiry (OTC products exempt from expiry dating: 3 years from distribution).
  - API reserve, where the suite handles receipt: the same 2x rule. It is kept until 1 year after the expiry of the last product lot containing that API.
- Citations: US: 211.170(a)-(b); 211.84(b) | EU: EU GMP Annex 19 (not in uploaded texts) (s) | ICH/EMA/draft: none
- Jurisdiction: US quantities and periods are verified here. EU reference and retention sample rules (Annex 19) were not verified; see F-8.
- Test: Packaging cannot complete without a reserve sample of at least the computed quantity. Disposal before 1 year after expiry is blocked.

## G. Material and product status: quarantine, rejected, reprocessed, recovered and returned

### PR-45 Quarantine and release status model
- Covers: n138, n592, n622, n28, n141 (mapped from the data-integrity list; same obligation)
- Type: ENFORCED
- Behaviour:
  - Every received lot starts in Quarantine at receipt. Every produced lot (intermediate, bulk, finished) starts in Quarantine when its output is posted.
  - A lot moves to Released only through a release transaction by an authorised QC/QCU role. EU finished product also needs QP certification (PR-55).
  - Interfaces to ERP and WMS cannot allocate or ship quarantined or rejected stock.
  - In-process materials are approved or rejected by the QCU at the significant phases the master defines.
  - Electronic (administrative) quarantine is accepted where the validated system enforces it, and physical labels show the same status.
  - Status changes are e-signed and audit-trailed.
  - Finished-lot status is held per market (PR-56).
- Citations: US: 211.42(c)(1),(7); 211.82(b); 211.110(c); 211.142(a) | EU: Ch.4 4.24; Ch.5 5.5; 5.63; 5.64; 5.65 | ICH/EMA/draft: none
- Jurisdiction: Both accept non-physical quarantine: US through "other control systems", EU through administrative quarantine. Equivalent.
- Test: Shipping a quarantined lot through the ERP interface is rejected. Using a quarantined intermediate in the next step is blocked.

### PR-46 Rejected materials and products
- Covers: n134
- Type: ENFORCED
- Behaviour:
  - Blocking: "Rejected" is a hard status. It blocks every consumption, issue, packaging and shipping transaction and appears on the label.
  - Segregation: rejected stock must be moved to a restricted, separate location. The system blocks moves to normal locations.
  - Disposition: return to supplier, reprocess or destroy. It needs approval from an authorised role; the action actually carried out and its quantities are recorded.
  - Rejects arising in-process (for example checkweigher or visual-inspection rejects) go into identified reject containers, are counted, and are handled the same way.
- Citations: US: 211.89; 211.110(d); 211.165(f); 211.184(e); 211.42(c)(2) | EU: Ch.5 5.66 | ICH/EMA/draft: none
- Jurisdiction: US accepts a quarantine system that prevents use. EU requires separate storage in restricted areas. EU is stricter, so the kernel requires both the electronic status and a physical restricted location (D-10).
- Test: Dispensing a rejected lot is blocked. Moving rejected stock to a released-stock location is blocked.

### PR-47 Reprocessing and recovery of earlier batches
- Covers: n21, n135, n136
- Type: ENFORCED + CONFIGURABLE (per product, reprocessing can be disabled, e.g. where the registration forbids it for a sterile product [I])
- Behaviour:
  - Reprocessing:
    - It runs only from a QCU-approved reprocessing procedure or master. That procedure is linked to the non-conforming batch, its investigation and a documented risk evaluation.
    - It creates a child execution record and genealogy edges.
    - The product must meet its specifications before acceptance.
    - It is flagged for review and PQR.
  - Recovery (adding conforming earlier batches of the same product at a defined stage):
    - The step type exists only where the master defines it, and only for the same product.
    - Prior authorisation is required, with a referenced risk evaluation that includes the effect on shelf life.
    - The source batch IDs and quantities are recorded, which also meets 4.20(d).
  - Additional testing: before release of any reprocessed or recovered-material batch, a QC decision on the need for additional testing is a mandatory field.
- Citations: US: 211.115(a)-(b); 211.165(f) | EU: Ch.5 5.67; 5.68; 5.69; Ch.4 4.20(d) | ICH/EMA/draft: none
- Jurisdiction: EU calls reprocessing exceptional and requires a risk evaluation and a QC decision on extra testing. US requires QCU review and approval. The kernel applies both. "Rework" is not a Part 211 term.
- Test: Starting reprocessing without QCU approval or a risk evaluation is blocked. Recovering material from a different product is blocked. A missing QC decision on additional testing blocks release.

### PR-48 Returned products
- Covers: n137
- Type: ENFORCED
- Behaviour:
  - Receipt: booking in returned goods creates a quarantined lot of type "returned", linked to its original batch.
  - Assessment: disposition requires a QC assessment record with a QC e-signature. It considers the product's nature, its storage requirements, its condition and history, and the time since issue.
  - Disposition rules: the default is destroy. If any doubt is recorded, the only options are destruction or chemical recovery of the active substance.
  - Record content: the record holds name, label potency, dosage form, lot, reason for return, quantity, disposition date and final disposition.
  - Investigation: if the reason for return implicates other batches, a 211.192 investigation is linked.
- Citations: US: 211.204; 211.208 | EU: Ch.5 5.70; Ch.4 4.29 (returns) | ICH/EMA/draft: none
- Jurisdiction: US lets examination or testing resolve doubts about storage conditions. EU does not allow re-issue or re-use once any doubt exists. EU is stricter, and the kernel applies it to all markets (D-12).
- Test: Repackaging returned units without a QC assessment is blocked. After a "doubt" assessment, only destroy or chemical recovery is offered.

## H. Deviations, investigations and CAPA

### PR-49 Deviation record, classification and approval
- Covers: n119, n214, n208, n189, n224
- Type: ENFORCED (record, approval, batch link, hold of linked batches) + CONFIGURABLE (deviation classes) + DESIGN-CHOICE (availability-impact field)
- Behaviour:
  - Creation: a deviation raised from a step pre-fills the batch, step, master version, equipment and materials.
  - Classification: planned or unplanned; impact on a registered detail, on GMP, or neither; severity.
  - Approval and holds: a competent person approves it, with QC involved for quality-relevant classes. Linked batches are placed on hold.
  - Annex 16 section 3 fields (EU in set), for certifying a batch with an unexpected deviation:
    - confirmation that registered specifications are met;
    - a QRM impact assessment;
    - root cause and actions;
    - an assessment of whether a variation is needed.
  - Recurrence and register: a counter warns when the same deviation recurs. A register of batches certified under this route is kept for the PQR.
  - Availability impact (design choice): an optional field for shortage-sensitive products. Availability can never override a quality disposition.
- Citations: US: 211.100(b); 211.192 | EU: Ch.5 5.15; Ch.4 4.20(h); 4.21(g); 4.29 | ICH/EMA/draft: Annex 16 section 3 and EMA Q&A on Annex 16 (s); ICH Q9(R1) 6.1 (s); EU GMP Ch.1 (s)
- Jurisdiction: The Annex 16 section 3 route has no US equivalent. In the US, a batch failing a specification is rejected (211.165(f)) and the failure is investigated (211.192).
- Test: A failure of a registered limit creates a deviation with the MA flag. The third recurrence shows a warning on the certification screen.

### PR-50 Investigation of discrepancies and failures
- Covers: n40, n211, n228, n214
- Type: ENFORCED
- Behaviour:
  - Triggers: an investigation opens for any unexplained discrepancy or specification failure, even after distribution. Unexplained discrepancies include yields outside master limits, reconciliation discrepancies and time-limit breaches.
  - Impact extension (mandatory step):
    - The system offers queries for other batches of the same product and for other products that shared component lots, intermediates, equipment (previous and next product), rooms, personnel, utilities or time windows.
    - Linked batches are held.
  - Closure: the written record requires conclusions and follow-up.
  - Root cause (major and critical investigations):
    - A root-cause category and the method used are required.
    - Concluding "human error" requires a documented assessment of process, procedure and system factors.
    - "Not determined" requires a most-probable cause and actions.
- Citations: US: 211.192; 211.188(b)(12); 211.198(b)(2); 211.204 | EU: Ch.4 4.29 (investigations); Ch.5 5.44; 5.61 | ICH/EMA/draft: EU GMP Ch.1 1.4(xiv) (s); ICH Q9(R1) 4.3 (s); ICH Q10 3.2.2 (s)
- Jurisdiction: US explicitly extends investigations to other batches and products, including after distribution. EU Ch.1 (s) is explicit about the depth of root-cause analysis and about justifying a human-error conclusion. The kernel applies both.
- Test: An investigation cannot close without conclusions and follow-up. The impact query returns the expected batch set, checked against an independent query. "Human error" without the system-factor assessment is blocked.

### PR-51 CAPA linkage and effectiveness
- Covers: n213
- Type: CONFIGURABLE. Default: CAPA completion does not block release, but the investigation's follow-up does. Allowed: QA may make a CAPA release-blocking. The automated effectiveness checks are a DESIGN-CHOICE.
- Behaviour:
  - CAPAs are created from, or linked to, deviations and investigations, with links in both directions: the batch lists its deviations and CAPAs, and each CAPA lists the batches it affects.
  - An effectiveness check is scheduled, with criteria that can be measured from eBMR data.
  - A CAPA that needs a master change cannot close until the new master version is effective.
- Citations: US: 211.192 (follow-up) | EU: EU GMP Ch.1 (s) | ICH/EMA/draft: ICH Q10 3.2.2 (s)
- Jurisdiction: "CAPA" is ICH Q10 / EU Ch.1 wording. 211.192 requires conclusions and follow-up. Guidance level in both regions.
- Test: Closing a CAPA that needs a master change is blocked while the change is not yet effective.

## I. Batch record review and release

### PR-52 Production approval and quality-unit review (including review by exception)
- Covers: n40, n93, n105
- Type: ENFORCED (full record available; every exception dispositioned; QCU approval of the complete record) + CONFIGURABLE (production-responsible approval: default ON, mandatory when EU is in the set; review-by-exception scope)
- Behaviour:
  - Production approval: after processing and after packaging, the person responsible for that operation approves the processing record and the packaging record by e-signature. The approval covers the exceptions within their scope.
  - QA workbench and exception report:
    - The QA review workbench shows an exception report generated from a mandatory taxonomy: limit breaches, deviations, overrides, corrections of critical data, late entries, interface fallbacks, timer breaches, open verifications, alarms, audit-trail events on critical data, and special observations or comments.
    - Each exception is dispositioned individually. The full record can always be viewed.
  - Reduced reports:
    - Automatically generated reports may be cut down to compliance summaries plus exception/OOS reports only for steps configured, under change control with a validation reference, as validated and continuously monitored.
    - The underlying data are kept and can be drilled into.
  - QCU approval: the QCU approval e-signature states that the complete record, including the packaging and labeling records, was reviewed.
- Citations: US: 211.192; 211.22(a); 11.10(e) | EU: Ch.4 4.20(i); 4.21(i); 4.20 Note; 4.27; Annex 11 sections 8.2 and 9 | ICH/EMA/draft: FDA data-integrity Q&A (2018) on audit-trail review (s)
- Jurisdiction: EU requires approval of the records by the person responsible for production (4.20(i), 4.21(i)); US has no explicit equivalent. US requires QCU review and approval of all production and control records, packaging and labeling included, before release. The 4.20 Note permits shorter reports but does not remove that US duty. Stricter combination: production approval, then QCU approval of the complete record.
- Test: Seed one exception of each type. All appear, and approval stays blocked until each is dispositioned. Enabling review by exception on a step with no validation reference is refused.

### PR-53 Release gating on open deviations and investigations
- Covers: n214, n188, n223, n115
- Type: CONFIGURABLE. Default: release or certification is blocked while any linked deviation or investigation is open. Allowed: release with an investigation still open, only when the QCU (US) or QP (EU) records an e-signed justification that the investigation is advanced enough to support the decision. The justification appears on the release record and the certificate data. Not allowed: this exception for reconciliation discrepancies (5.61 requires them explained before release) or for any registered-specification failure.
- Behaviour: The gate reads live status from the eBMR and the linked QMS/LIMS. Batches linked as "potentially affected" are held. CAPA completion is tracked separately (PR-51).
- Citations: US: 211.192; 211.165(f) | EU: Ch.5 5.61 | ICH/EMA/draft: Annex 16 section 1.7 (investigations complete enough to support certification) (s); ICH Q10 3.2.2 / EU Ch.1 (s)
- Jurisdiction: Neither 211.192 nor Annex 16 1.7 literally requires every investigation to be closed before release. Annex 16 (s) requires it to be complete to a level sufficient to support certification. The guardrail's unconditional block is stricter than both texts (D-8).
- Test: A batch with an open deviation cannot be released. With the e-signed justification it can, and the exception is printed on the release record. An open reconciliation discrepancy cannot be justified away.

### PR-54 US batch disposition by the quality control unit
- Covers: n608
- Type: ENFORCED (US in set)
- Behaviour:
  - Only users with the QCU disposition role can release a finished lot for the US market.
  - Prerequisites:
    - QCU record review approved (PR-52) and investigations handled per PR-53;
    - lab conformance to final specifications, including identity and strength of each active ingredient;
    - microbiological testing where the product must be free of objectionable organisms;
    - [I] sterility and pyrogen testing;
    - [T] a release-rate result for each active ingredient of a controlled-release product;
    - reconciliation passed;
    - QC decisions on reprocessed or recovered material recorded.
  - Failing product is rejected.
  - Contract manufacture: when the site makes product under contract, the record also supports approval or rejection by the contract giver's QCU (211.22(a)).
- Citations: US: 211.22(a),(c); 211.142(a); 211.165(a),(b),(d),(f); 211.167(a),(c); 211.192 | EU: n/a | ICH/EMA/draft: none
- Jurisdiction: US only. The QCU is an organisational unit; no named individual is required, unlike the EU QP.
- Test: An extended-release tablet lot missing one active's release-rate result cannot be released.

### PR-55 EU QP certification
- Covers: n105, n187, n188, n223, n190, n192, n619, n197
- Type: ENFORCED (EU in set)
- Behaviour:
  - Who certifies: where certification is recorded in the system, only users holding the QP role can certify. They do so by e-signature, and the system identifies the certifying QP.
  - Certification cockpit (live status):
    - record completeness and the production and QA approvals;
    - deviations and changes, with their approval status and regulatory status for the EU MA;
    - OOS/OOT results and investigations, and validation status (concurrent-validation results must be available);
    - a partial-manufacturing confirmation, with Appendix I content, for each upstream stage in the genealogy performed at another site;
    - open complaints or recalls on the product;
    - flags for special observations and for changes to critical data.
  - Blocking: certification is blocked while a mandatory item is red, unless the QP records a justified decision.
  - Certification register: each certification goes into an append-only, exportable register (batch, product/strength/pack, market, QP, date/time, confirmations relied on), kept for at least 5 years (s).
  - Real-time release (RTRT) products: certification may rest on validated summary and exception reports of PAT or parameter data, but only where the MA allows it.
  - QP outside the eBMR: typically the EU importer's QP for an Indian site. The eBMR then records the external certification reference, and the lot's EU status cannot change until that reference is recorded.
- Citations: US: n/a | EU: Ch.4 4.27; Ch.4 preamble footnote 1 (RTRT); Annex 11 section 15 | ICH/EMA/draft: Directive 2001/83/EC Art. 51 (s); Annex 16 section 1, 1.7 and Appendix I (s); EU Annex 15 concurrent validation (u)
- Jurisdiction: EU only; there is no US counterpart. Only the certification step must be an e-signature (Annex 11 section 15).
- Test: A non-QP attempt to certify is refused. An open OOS blocks certification. A register entry is created at signature and cannot be edited.

### PR-56 Market-specific disposition for multi-market batches
- Covers: n218, n187
- Type: ENFORCED
- Behaviour:
  - Disposition status is held per finished lot and per market.
  - A lot is releasable for a market only when:
    - it meets that market's registration (ECs, specifications, process);
    - its market-specific packaging record is complete;
    - that market's release authority has signed (US: QCU; EU: QP).
  - A deviation found acceptable for one market is assessed separately for the other.
  - A rejection in one market opens an investigation link visible to all markets.
  - See Section (b).
- Citations: US: 211.22(a); 211.192 | EU: Ch.5 Principle | ICH/EMA/draft: Annex 16 (s); ICH Q12 ch.3 (s)
- Jurisdiction: Each market's release authority is independent. Release in one market implies nothing about the other.
- Test: A batch certified for the EU but not yet released by the US QCU cannot be shipped to the US, and the reverse also holds.

## J. Traceability, product quality review and records retention

### PR-57 Genealogy and lot traceability (including distribution and complaint lookups)
- Covers: n87, n1, n84, n621, n637, n30, n146, n42
- Type: ENFORCED (backward and forward traceability) + DESIGN-CHOICE (graph-database projection; bitemporal storage)
- Behaviour:
  - A lot number resolves to its complete history:
    - master version, executed records and every signature;
    - component and intermediate lots, with supplier, manufacturer and manufacturer batch;
    - equipment and rooms;
    - IPC and QC results;
    - deviations;
    - packaging, serialisation and disposition;
    - distribution to consignees.
  - Traversal: backward and forward traversal works at any depth, including splits, merges, reprocessing, recovery and transfers between sites.
  - Integrity: each genealogy edge is committed atomically with the business event that creates it. Any graph database is only a derived, rebuildable and reconciled projection.
  - Distribution records, linked from ERP, hold product name and strength, dosage form, consignee name and address, date, quantity and lot.
  - Lookups: a complaint-to-lot lookup opens the record, genealogy, deviations and shipments. An API supply-chain traceability report can be produced for each finished batch.
- Citations: US: 211.130(c); 211.184(c); 211.188(b)(2)-(3); 211.105(b); 211.182; 211.150(b); 211.196; 211.192; 211.198; 210.3(b) (s); 201.18 (s) | EU: Ch.4 Records definition (batch history includes distribution); 4.8; 4.23; 4.28; Ch.5 5.29 | ICH/EMA/draft: none
- Jurisdiction: Equivalent. EU explicitly includes distribution in the batch history and requires API supply-chain traceability. Room- and person-level forward tracing are not explicit requirements anywhere.
- Test: A seeded split/merge/rework scenario returns exactly the expected nodes. A forward trace from a component lot lists every consignee, matching an ERP extract.

### PR-58 Product quality review / annual product review data
- Covers: n33, n216, n212, n80, n196, n625
- Type: ENFORCED (structured, queryable, reproducible data) + DESIGN-CHOICE (SPC dashboards, trend rules)
- Behaviour:
  - Data types: CPPs, IPCs, yields, deviations, reprocessing, rejections, reconciliation results and release decisions are stored as typed data with units, limits and specification version.
  - Extracts: extracts per product and period are reproducible and carry source-record links. They cover:
    - a representative number of approved and rejected batches;
    - complaints, recalls and returned or salvaged products;
    - investigations, changes and CAPA effectiveness.
  - Checks: extract counts reconcile to the registers.
- Citations: US: 211.180(e)(1)-(2) | EU: Ch.4 4.29 (summaries such as PQR) | ICH/EMA/draft: EU GMP Ch.1 1.10 (s); ICH Q10 3.2.1 and 3.2.4 (s); FDA Process Validation guidance (2011) (s); EU Annex 15 OPV (u)
- Jurisdiction: US requires an evaluation at least once a year. The EU PQR scope (Ch.1 1.10, (s)) is broader: significant deviations, CAPA effectiveness and changes.
- Test: A product extract for a period reconciles to the batch list and the deviation and CAPA registers. Re-running it gives identical results.

### PR-59 Record retention, record-location register and archiving
- Covers: n103, n102, n82, n42, n146
- Type: ENFORCED (retention floors; no deletion before the retention date) + CONFIGURABLE (longer national, product or legal-hold rules)
- Behaviour:
  - Retention date for each batch record: the latest of all that apply:
    - US: expiry + 1 year (for OTC products exempt from expiry dating: distribution + 3 years);
    - EU in set: the later of expiry + 1 year and QP certification + 5 years;
    - DSCSA transaction and serial data: at least 6 years (s);
    - IMP: 5 years after the last trial ends;
    - longer national or product rules, and legal holds.
  - Recalculation and edge cases:
    - The date is recomputed if the expiry changes.
    - For batches never certified, the default is the later of expiry + 1 year and disposition + 5 years (F-2).
    - Component, container, closure and labeling records are kept for 1 year after the expiry of the last lot that used them (211.180(b); see F-10).
    - Validation raw data that supported release are kept at least as long as the batches they support (4.12).
  - Deletion: impossible before the retention date. Afterwards it needs a QA-approved, audit-trailed disposition.
  - Scope: the full record, including audit trails, attachments and linked historian extracts.
  - Location register: maps each activity to its record and its storage location.
  - Archive:
    - checksums, periodic readability checks and tested migration;
    - a complete human-readable rendering on demand;
    - records stay available at the site, or can be retrieved electronically at once, for inspection.
- Citations: US: 211.180(a)-(d); 211.198(b); 211.68(b); 11.10(b)-(c) | EU: Ch.4 Principle; 4.10; 4.11; 4.12; Annex 11 sections 7, 8 and 17 | ICH/EMA/draft: DSCSA 582(b) (s)
- Jurisdiction: EU is usually longer because of the 5 years after certification; US is tied to expiry. Stricter wins: the maximum (D-7).
- Test: A batch with a 24-month shelf life certified on 2026-01-10 gets a retention date of 2031-01-10. With a 60-month shelf life, expiry + 1 year governs. Deleting before the date is refused and logged.

### PR-60 Forward compatibility with EU draft texts (data governance, AI)
- Covers: n107, n180
- Type: DESIGN-CHOICE
- Behaviour:
  - Data governance:
    - An inventory of record types and fields, each with an owner and a criticality.
    - Documented data flows to and from integrated systems.
    - A periodic data-integrity review report.
  - AI:
    - No AI/ML output can change GMP data or status without a human e-signature.
    - Any AI helper is flagged as such. Its output is reviewed and signed, and the model version and confidence are recorded.
    - Critical-use models (e.g. automated visual inspection [I]) must be static, validated and monitored.
- Citations: US: none | EU: none binding | ICH/EMA/draft: EU GMP Ch.4 draft (Jul 2025) 4.10-4.18 (draft); EU GMP Annex 22 draft (Jul 2025) (draft)
- Jurisdiction: EU drafts only. Neither region's current texts reviewed here contain these rules.
- Test: In the AI feature inventory, no feature changes GMP data without a human e-signature.

---

## (a) Required content: merged US + EU checklists

The MBR designer (PR-03) refuses approval if any item applicable to the product's market set is missing. The completeness gate (PR-16) checks the executed-record lists. "US" means required when US is in the market set, "EU" means required when EU is in the set, and "both" means both texts require it. Conditional items ("where applicable/appropriate/necessary") may be set to N/A only with a signed justification. All wording is paraphrased; see the official texts for the exact requirements.

### (a)-1 Processing master (manufacturing formula + processing instructions)
| # | Required content | US | EU | Scope |
|---|---|---|---|---|
| 1 | Product name, strength, description of dosage form | 211.186(b)(1) | 4.17(a)-(b) | both |
| 2 | Product reference code tied to its specification | - | 4.17(a) | EU (kernel: all) |
| 3 | Batch size (one master per batch size) | 211.186(a) | 4.17 lead-in, 4.17(b) | both |
| 4 | Each active: name and amount per dosage unit (or per unit weight/measure); total weight or measure of one dosage unit | 211.186(b)(2) | - | US |
| 5 | Complete component list, with names or codes specific enough to show any special quality characteristic | 211.186(b)(3) | 4.17(c) | both |
| 6 | Accurate quantity of each component in one weight system; any justified variations stated | 211.186(b)(4) | 4.17(c) | both |
| 7 | Flag on any substance that may disappear during processing | - | 4.17(c) | EU (kernel: all) |
| 8 | Statement of any calculated excess (overage) | 211.186(b)(5) | - | US |
| 9 | Formula designed to deliver at least 100% of the labeled/established active amount | 211.101(a) | - | US |
| 10 | Theoretical weight or measure at appropriate phases | 211.186(b)(6) | - | US |
| 11 | Theoretical/expected yield with min/max limits: final yield (both) and each yield checkpoint (kernel, see D-9) | 211.186(b)(7); 211.103 | 4.17(d) | both |
| 12 | Processing location and principal equipment (class/capacity) | 211.63; 211.105(b) | 4.18(a) | EU explicit; kernel: all |
| 13 | Methods, or references to them, for preparing critical equipment (cleaning, assembly, calibration, sterilisation) | 211.67(b) (via SOP) | 4.18(b) | EU |
| 14 | Pre-start check: equipment and workstation clear of previous products, documents and unneeded materials; equipment clean and suitable | 211.67(b)(6) | 4.18(c); 5.40 | both |
| 15 | Detailed stepwise instructions: material checks, pre-treatment, sequence of addition, CPPs with ranges | 211.186(b)(9) | 4.18(d) | both |
| 16 | IPC instructions with limits; sampling and test procedures; specifications | 211.186(b)(9); 211.110(a)-(b); 211.160(b)(2) | 4.18(e); 4.25; 4.26 | both |
| 17 | Bulk/intermediate storage requirements (container, labelling, storage conditions) where needed | - | 4.18(f); 5.41 | EU |
| 18 | Time limits for production phases where appropriate, with validation reference | 211.111 | - | US |
| 19 | Special notations and precautions | 211.186(b)(9) | 4.18(g) | both |
| 20 | Significant-step flags; performer/checker rule; dispensing and charge-in verification mode (manual or 211.68(c) automated) | 211.188(b)(11); 211.101(c)-(d); 211.68(c) | 4.20(c); 5.38 | both (kernel) |
| 21 | Container/closure description for steps that fill primary containers [I] | 211.186(b)(8) | - | US |
| 22 | Preparer and independent checker (each signed and dated), QCU approval, effective date, unique ID and version | 211.186(a); 211.100(a); 211.22(c) | 4.3 | both |
| 23 | Registration references per market; registered/EC flags | 211.100(a) (via application) | 4.2; Ch.5 Principle | both (PR-04) |
| 24 | Validation reference for the process and CPP ranges | - | 5.24; 5.25; Annex 15 (u) | EU (kernel: all) |

### (a)-2 Packaging master (packaging instructions)
| # | Required content | US | EU | Scope |
|---|---|---|---|---|
| 1 | Product name, plus fields for bulk batch number and finished batch number | 211.130(c) | 4.19(a) | both |
| 2 | Dosage form, and strength where applicable | 211.186(b)(1) | 4.19(b) | both |
| 3 | Pack size (number, weight or volume in the final container) | - | 4.19(c) | EU (kernel: all) |
| 4 | Full list of packaging materials, each with quantity, size, type and specification code; description of containers, closures and packaging materials | 211.186(b)(8) | 4.19(d) | both |
| 5 | A specimen or copy of every label and every other labeling item, bearing the dated signature of whoever approved that labeling; marks where batch number and expiry go | 211.186(b)(8) (mandatory) | 4.19(e) ("where appropriate") | both; US stricter (D-1) |
| 6 | Line-clearance checklist; careful pre-start examination of area and equipment; equipment clean and suitable | 211.130(e) | 4.19(f)-(g); 5.50 | both |
| 7 | Special precautions | 211.186(b)(9) | 4.19(g) | both |
| 8 | Description of the packaging operation, including significant subsidiary operations and equipment | 211.186(b)(9) | 4.19(h) | both |
| 9 | IPCs with sampling instructions and acceptance limits; on-line minimum checks; end-of-run label examination | 211.134; 211.186(b)(9) | 4.19(i); 5.59 | both |
| 10 | Pre-packaging examination of packaging and labeling materials | 211.130(d) | 5.52 | both |
| 11 | Reconciliation limits for labeling, printed materials and bulk (narrow, preset, based on historical data) | 211.125(c) | 5.61; 4.21(h) | both |
| 12 | Theoretical yield with min/max for the packaging phase | 211.103; 211.186(b)(7) | 4.17(d) (final yield) | both |
| 13 | Where cut labeling is used: one of the four 211.122(g) controls | 211.122(g) | 5.56 | US mandatory |
| 14 | Expiry-dating rule and storage statement | 211.137 | 4.16(f)-(g) | both |
| 15 | Reserve-sample step | 211.170(b) | Annex 19 (s) | US (EU: F-8) |
| 16 | Market-specific: OTC tamper-evident checks; US product identifier/NDC barcode; EU safety features | 211.132; 201.25 (s); DSCSA (s) | Reg. (EU) 2016/161 (s) | per market |
| 17 | Approval route as in (a)-1 item 22 | 211.186(a) | 4.3; 4.19 lead-in | both |

### (a)-3 Executed batch processing record
| # | Required content | US | EU |
|---|---|---|---|
| 1 | Accurate reproduction of the master, checked for accuracy, dated and signed at issue; based on the current approved version | 211.188(a) | 4.20 lead-in; 4.2 |
| 2 | Product name and batch number | 211.130(c) | 4.20(a) |
| 3 | Dates (US) and times (EU) of start, significant intermediate stages and completion | 211.188(b)(1) | 4.20(b) |
| 4 | ID of each major equipment item and line used | 211.188(b)(2); 211.105(b) | 4.20(e) |
| 5 | ID of each component and in-process material batch used (and analytical control number) | 211.188(b)(3) | 4.20(d) |
| 6 | Quantities actually weighed or measured, including batch number and quantity of any added recovered or reprocessed material | 211.188(b)(4) | 4.20(d) |
| 7 | IPC and lab results, with who performed each IPC | 211.188(b)(5) | 4.20(f) |
| 8 | Sampling performed | 211.188(b)(10) | 4.25 |
| 9 | Actual yield and % of theoretical at appropriate phases, with verifier | 211.188(b)(7); 211.103 | 4.20(g) |
| 10 | Performer of each significant step and the checker (US: always; EU: where appropriate); for automated steps, who checked the equipment | 211.188(b)(11) | 4.20(c) |
| 11 | Relevant processing operations and events | 211.100(b) | 4.20(e) |
| 12 | Notes on special problems, with signed authorisation for any deviation | 211.100(b) | 4.20(h); 5.15 |
| 13 | Any investigation made | 211.188(b)(12) | 4.29 |
| 14 | Pre-start clearance confirmation | 211.67(b)(6) | 4.18(c); 5.40 |
| 15 | Time-limit outcomes and justified departures | 211.111 | 4.18(f) |
| 16 | Cleaning, maintenance and use records for dedicated equipment with no individual log (US-only option; see PR-24) | 211.182 | - |
| 17 | Container/closure description where filling occurs in processing [I] | 211.188(b)(9) | - |
| 18 | Approval by the person responsible for processing | - | 4.20(i) |
| 19 | For validated, continuously monitored steps: compliance summary plus exception/OOS reports (a permission, not a requirement) | - | 4.20 Note |

### (a)-4 Executed batch packaging record (per batch or part batch)
| # | Required content | US | EU |
|---|---|---|---|
| 1 | Accurate reproduction of the packaging master, checked, dated and signed at issue | 211.188(a) | 4.21 lead-in |
| 2 | Product name; bulk and finished batch numbers | 211.130(c) | 4.21(a); 4.19(a) |
| 3 | Dates and times of packaging operations | 211.188(b)(1) | 4.21(b) |
| 4 | Performer of each significant step and checker | 211.188(b)(11) | 4.21(c) |
| 5 | Identity and conformity checks against the packaging instructions, including IPC results | 211.130(d); 211.188(b)(5) | 4.21(d); 5.52 |
| 6 | Packaging operations carried out, with equipment and line references | 211.188(b)(2) | 4.21(e) |
| 7 | Specimens or copies of all labeling used (US mandatory), and printed samples showing batch coding, expiry and overprint (EU whenever possible) | 211.188(b)(8) | 4.21(f) |
| 8 | Complete labeling control records (issuance, examination, reconciliation) | 211.188(b)(8); 211.125 | 4.21(h) |
| 9 | Notes on special problems and unusual events, with signed authorisation for deviations | 211.100(b) | 4.21(g); 5.60 |
| 10 | Quantities and references of printed materials and bulk issued, used, destroyed or returned, and product obtained (reconciliation) | 211.125(c); 211.184(c) | 4.21(h); 5.61 |
| 11 | Inspection of the packaging/labeling area both prior to and following use (EU: prior only, with checklist) | 211.188(b)(6); 211.130(e) | 5.50 |
| 12 | Actual yield and % of theoretical | 211.188(b)(7) | - |
| 13 | Description of containers and closures | 211.188(b)(9) | - (listed in the instructions, 4.19(d)) |
| 14 | Sampling performed, including reserve samples | 211.188(b)(10); 211.170(b) | 5.59 |
| 15 | Results of the in-process and end-of-run label examinations | 211.188(b)(13); 211.134 | 5.59 |
| 16 | Any investigation made | 211.188(b)(12) | 5.61 |
| 17 | Approval by the person responsible for packaging | - | 4.21(i) |
| 18 | Market-specific: serial commissioning and reconciliation (US Rx, (s)); tamper-evident checks (US OTC) | DSCSA (s); 211.132 | Reg. 2016/161 (s) |

---

## (b) Release models by market, and one batch destined for several markets

**US: quality control unit disposition**
- Authority: the QCU approves or rejects drug products, including product made for the firm under contract (211.22(a)). It is an organisational unit; no named individual is required. The disposition is signed by an authorised QCU member using a Part 11 e-signature (11.1(c)).
- Before release:
  - QCU review and approval of all production and control records, packaging and labeling included (211.192);
  - thorough investigation of unexplained discrepancies and specification failures, extended to associated batches and products (211.192);
  - lab conformance to final specifications, including identity and strength of each active (211.165(a)), plus micro testing where required (211.165(b));
  - sterility and pyrogen testing [I] and release-rate testing [T, controlled release] (211.167(a),(c));
  - product held in quarantine until QCU release (211.142(a)).
- Failing product is rejected, and reprocessed material must conform before use (211.165(f)).
- Contract manufacture for a US applicant: the eBMR must be able to hand the complete record to the contract giver's QCU and record its disposition as well.

**EU: QP certification**
- Authority: each batch must be certified by a Qualified Person of the manufacturing or import authorisation holder before release for sale or supply (Directive 2001/83/EC Art. 51 (s); Annex 16 (s)).
- System rules: every record must be available to the QP, and a system must flag special observations and changes to critical data (4.27). Where the computerised system records certification, only QPs can certify, by e-signature, and the certifier is identified (Annex 11 section 15).
- Certification is entered in a register kept at least 5 years (s).
- Supporting rules:
  - partial-manufacturing confirmations from other sites (Annex 16 App. I (s));
  - the unexpected-deviation route (Annex 16 section 3 (s));
  - batch records kept 5 years after certification if that is longer than expiry + 1 year (4.11).
- Indian export sites: the QP who certifies for the EU market is normally the QP of the EU importing MIA holder, after importation. For third-country batches, Art. 51 also requires testing in the EU unless an agreement provides otherwise (s; F-3). The Indian site's own quality-unit disposition is therefore a manufacturer release, not a QP certification. The eBMR must:
  - give the QP the complete record, plus flags and audit trails of critical-data changes (4.27);
  - accept the external certification reference;
  - keep EU-market status at "awaiting QP certification" until that reference is recorded (PR-55).

**One batch destined for several markets (PR-04, PR-56)**
1. Declare the market set when the batch is issued. The master version must be effective for every market in the set, which means running the process inside the intersection of the registered ranges and meeting every Established Condition. If a change is approved for one market but still pending for another, a batch for both must use the version effective in both.
2. Testing: every test either market requires is performed. For an attribute tested once, the result must meet the tighter of the two specification limits. EU import testing, if it applies, happens after importation (s).
3. Processing produces one batch processing record. Packaging runs as separate market-specific packaging orders (part batches, 4.21), each with its own packaging record, labeling, identifiers (US DSCSA/NDC; EU safety features), reconciliation and finished-lot identity. Each finished lot must trace to the bulk batch (211.130(c)).
4. The record content is the union of both markets (Section (a)). Examples: times (EU), a checker on every significant step (US), post-use area inspection (US), area logbooks and production-head approval (EU).
5. Disposition is held per lot and per market: US QCU release for US packs, QP certification for EU packs. Releasing a lot in one market implies nothing for the other.
6. Deviations are assessed per market. The Annex 16 section 3 route exists only for the EU. For the US, 211.192 applies and a specification failure means rejection (211.165(f)). A batch rejected for one market can go to the other only if it meets that registration and the recorded investigation concludes there is no impact there. Every investigation link is visible to both release authorities.
7. Retention is the maximum over all markets (PR-59).

---

## (c) Claims made by earlier research that are NOT actually required
- C-1 **Three distinct signers on every master (author, checker, QA).** The rules require a preparer plus an independent second-person checker (211.186(a)) and QCU approval (211.22(c), 211.100(a)). The checker may be a QCU member who also approves. Guardrail 8's three-person rule is a stricter design choice (PR-02).
- C-2 **Wet-ink handwritten signatures on the master record.** 211.186(a) says "full signature, handwritten", but a Part 11-compliant e-signature is its equivalent (11.1(c)), given the firm's 11.100(c) certification to FDA.
- C-3 **A checklist for processing-area clearance.** Ch.5 requires a checklist only for packaging line clearance (5.50). Processing clearance (5.40, 4.18(c)) needs a check, not a checklist (n116).
- C-4 **Second-person verification of line clearance.** Neither 5.50 nor 211.130(e) requires two people. It becomes required only if the firm designates clearance a significant step under 211.188(b)(11) (n123).
- C-5 **Clean-hold and dirty-hold limits required by 211.67 or Ch.5.** The values come from cleaning validation (Annex 15 section 10, (u)). The regulations require cleaning at appropriate intervals and a pre-use inspection (n6, n199).
- C-6 **A personnel-presence list and gowning-qualification gating under 211.28.** These come from Annex 1 and the FDA 2004 guidance. 211.28(c) requires only supervisor-authorised entry to limited-access areas (n4).
- C-7 **Cleaning verification at every product changeover.** 5.21 says cleaning verification after each campaign should be considered for higher-risk products, as a detectability tool (n121).
- C-8 **Colour-coded status labels.** They are optional; 5.13 calls them often helpful (n118).
- C-9 **Potency-adjusted dispensing and automatic filler compensation.** They are one way to meet the at-least-100% intent of 211.101(a), not a mandate (n11).
- C-10 **Excluding the person who entered the quantities from verifying the yield; forbidding manual override.** Both are design choices; 211.103 requires only independent verification (n15).
- C-11 **Zero tolerance for label reconciliation.** US requires narrow preset limits based on historical data (211.125(c)); EU asks that significant or unusual discrepancies be investigated (5.61) (n131).
- C-12 **Review by exception as a requirement, or as a replacement for QCU review.** The 4.20 Note permits shorter reports for validated, continuously monitored processes. It is not an obligation, and US QCU approval of all records still applies (n93, n40).
- C-13 **An e-signature on every release workflow state.** Only QP certification must be an e-signature (Annex 11 section 15). Other approvals must be attributable, and e-signing them is a design choice (n105).
- C-14 **QA approval of every deviation under 5.15.** 5.15 names a competent person, with QC involved when appropriate; routing to QA is a design choice (n119).
- C-15 **Release blocked until every CAPA is complete, or every investigation closed.** Neither is literal text. Annex 16 1.7 (s) requires investigations complete enough to support certification; CAPA completion is not a release criterion (n214; D-8).
- C-16 **Extending batch-record retention automatically when a complaint is linked.** 211.198(b) governs retention of the complaint record only (n42).
- C-17 **Room-level and person-level forward traceability.** These are useful for 211.192 impact assessment but not explicit requirements (n87).
- C-18 **AQL sampling for the 211.134 end-of-run examination.** A representative sample is required; AQL is one way to get one (n26).
- C-19 **Barcode/RFID on every container, and a unique container ID on dispensing labels.** The rules require identification of contents and phase, and the four 211.101(b) label elements (n12, n16).
- C-20 **A binding ban on model-only in-process control.** That is the FDA draft position (Jan 2025), not binding; the 211.110 text is technology-neutral (n18).
- C-21 **The verifier must witness charge-in within a time window, from a terminal in the room.** A policy option, not in 211.101(d) (n14).
- C-22 **A maximum filling-to-labelling interval.** 5.54 says labelling should normally follow as quickly as possible, or else procedures must prevent mix-ups (n125).
- C-23 **A witness signature on destruction of coded or obsolete materials.** 5.48 and 5.62 require destruction to be recorded; 211.125(d) requires destruction (n126, n132).
- C-24 **Blocking the next processing step on an out-of-limit yield.** 5.44 requires recording and investigation, and 211.192 requires investigation. A hard stop is a design choice (n115).
- C-25 **Recording the pre-use cleaning inspection inside the batch record.** 211.182 allows it in the equipment log, except for dedicated equipment without a log (n6).
- C-26 **5.38 requires a second person.** It requires an independent, recorded check. The second person comes from US 211.101(c) (n120).
- C-27 **Supersession of masters is required by 4.5.** The requirement exists, but it comes from 4.3 and 4.20/4.21; 4.5 is about periodic review (n98).
- C-28 **Limits on intermediate yields required by EU 4.17(d).** 4.17(d) requires limits on the final yield and mention of relevant intermediate yields where applicable. The kernel requirement comes from the US text (n89; D-9).
- C-29 **FDA CSA guidance is binding on a drug eBMR.** It is a CDRH/CBER device guidance. It can inform the 211.68 and 11.10(a) validation approach but does not bind Part 211 (n71).
- C-30 **Enhanced testing of reprocessed batches as a US rule.** 211.165(f) requires reprocessed material to meet specifications. EU 5.69 requires QC to consider additional testing (n21).

---

## (d) Conflicts between rows and how they were resolved (with official-text evidence)
- D-1 **Printed-material specimens in the packaging master.** n91 allows justified N/A because 4.19(e) says "where appropriate". But 211.186(b)(8) makes a specimen or copy of every label and every other labeling item mandatory in the master, each bearing the dated signature of the labeling approver. **Resolution:** mandatory whenever US is in the market set; N/A with justification only for EU-only products (PR-03, (a)-2 item 5).
- D-2 **Retest/expiry date block at dispensing.** n13 calls a date-based block good practice under 211.87. n120 and n620 tie it to 5.34, which allows only QC-released starting materials within their retest period. **Resolution:** ENFORCED for all markets, because EU 5.34 is binding and stricter (PR-18).
- D-3 **Independent check of dispensed materials.** n120 says 5.38 does not require a second person, so a validated automated check suffices. n13 and guardrail 7 cite 211.101(c): a second person, or one person when automated. **Resolution:** manual mode needs two distinct people; automated mode needs at least one human verifier; zero-human verification is never allowed (PR-20). The same-user option is open question F-1.
- D-4 **Line clearance after packaging.** 5.50 covers only the pre-start clearance (n123). 211.188(b)(6) requires the record to show that the packaging/labeling area was inspected both prior to and following use (n39). **Resolution:** both (PR-34).
- D-5 **Checklist for clearance.** n116 (5.40, no checklist) vs n123 (5.50, checklist for packaging) vs n90 (4.18(c) checks in processing instructions). **Resolution:** checklist ENFORCED for packaging; processing clearance ENFORCED as a check, with the checklist format CONFIGURABLE (default on) (PR-26, PR-34).
- D-6 **Labeling reconciliation waiver.** 211.125(c) waives labeling reconciliation only for cut or roll labeling with a 100% examination under 211.122(g)(2). 4.21(h) allows the reconciliation quantities to be omitted from the record where robust electronic controls exist. 5.61 still requires discrepancies to be explained before release (n131). **Resolution:** reconciliation always runs by default. The waiver needs the US condition plus, when EU is in the set, documented robust controls. Bulk and batch-coded printed-material reconciliation is never waived when EU is in the set (PR-39).
- D-7 **Retention period.**
  - The candidates are: 211.180(a) at 1 year after expiry (n87, n1); 4.11 at the longer of expiry + 1 year and certification + 5 years (n103); DSCSA 6 years (n82, (s)); complaint-driven extension (n42); guardrail 17.
  - The complaint-driven extension is not required: 211.198(b) governs the complaint record only.
  - **Resolution:** the maximum of the applicable floors (PR-59).
- D-8 **Release while a deviation or investigation is open.**
  - Guardrail 15 blocks disposition while any deviation is open.
  - n214 allows release with a QA-justified exception, and n188/n223 (Annex 16 1.7, (s)) require investigations complete enough to support certification. 211.192 requires review and investigation but does not say "closed before release".
  - **Resolution:** CONFIGURABLE. The default is the guardrail block. The exception needs an e-signed QCU/QP justification, and never applies to reconciliation discrepancies (5.61) or registered-specification failures (PR-53).
- D-9 **Yield limits at intermediate phases.** n89 treats intermediate-yield limits as good practice that 4.17(d) does not require. Guardrail 22 requires min/max at each yield stage. 211.103 requires yields at each appropriate phase, and 211.186(b)(7) ties investigation to master min/max limits. **Resolution:** min/max required at every configured yield checkpoint (US-driven interpretation; see F-12) (PR-31).
- D-10 **Rejected-material storage.** 211.89 and 211.110(d) accept a quarantine system that prevents use, and 211.42(c) accepts "other control systems". 5.66 requires separate storage in restricted areas (n134). **Resolution:** electronic hard status plus a physical restricted location (PR-46).
- D-11 **Superseded-version control.** An earlier claim attributed it to 4.5. n98's correction, checked against the text, shows 4.5 covers only periodic review; blocking comes from 4.3 (effective date) and 4.20/4.21 (currently approved instructions). **Resolution:** enforced, with corrected citations (PR-05).
- D-12 **Returned goods.** 211.204 lets examination or testing prove quality when storage conditions cast doubt. 5.70 requires destruction unless quality is beyond doubt, and forbids re-issue once any doubt arises (n137). **Resolution:** the EU rule for all markets (PR-48).
- D-13 **Checker on significant steps.** 4.20(c) and 4.21(c) require the checker only "where appropriate". 211.188(b)(11) requires the performer and the person supervising or checking each significant step (n39). **Resolution:** the US rule for all markets (PR-14).
- D-14 **Logbook scope.**
  - 211.182 covers major equipment and exempts dedicated equipment whose records are in the batch record.
  - 4.31 requires logbooks for major or critical production and analytical equipment and for areas where product has been processed, and has no exemption.
  - n87 says room-level trace is not required, which is true only for the US.
  - **Resolution:** area logbooks when EU is in the set; the dedicated-equipment exemption is US-only (PR-24).
- D-15 **Scope of automated single-person checking.** n9's correction: 211.68(c) covers only 211.101(c)/(d), 211.103, 211.182 and 211.188(b)(11). The EU has no counterpart, but Annex 11 section 6 accepts validated electronic means as the accuracy check for manually entered critical data. **Resolution:** the automation flag is restricted to those step types and never relaxes other two-person rules (PR-14).
- D-16 **Scope of OTC tamper-evident packaging.** n25 was corrected: the trigger is OTC retail status, not dosage form (211.132(a)); insulin is exempt. **Resolution:** a product-master flag drives it; Tablets edition only in practice (PR-41).
- D-17 **Overage vs "substance that may disappear".** n11 treats overage as a 211.186(b)(5) statement. n89 says an overage is not a lost substance under 4.17(c). **Resolution:** separate fields, calculated excess and lost-in-process flag; both kept (PR-03).
- D-18 **Additional-testing decision.** n135 applies the 5.69 QC decision to reprocessed batches only. n136 notes that 5.69 covers both reprocessed and recovered-material batches. **Resolution:** the decision is mandatory for both (PR-47).
- D-19 **Status of Annex 16 section 3.** n189 is labelled guidance (it merges the EMA Q&A) and n224 is labelled binding, for the same section. **Resolution:** Annex 16 section 3 is part of EU GMP and binding (s). The EMA Q&A details (recurrence as a change; registered in-process specifications; the certified-batch register) are treated as guidance-level configuration (PR-49).
- D-20 **Deviation approver.** 5.15 names a competent person, with QC involved when appropriate; n119 routes to QA; guardrail 12 makes "exception or formal deviation" a QA decision. **Resolution:** the competent-person approval is ENFORCED; QC/QA routing is CONFIGURABLE by class (PR-13, PR-49).
- D-21 **211.186(a) handwritten signature vs an all-electronic master route.** Guardrail 8 is silent. 11.1(c) makes Part 11 e-signatures equivalent to full handwritten signatures, and 11.100(c) requires the certification to FDA. **Resolution:** e-signature, with a tenant-level record of the 11.100(c) certification (PR-02).

---

## (e) "Not an eBMR concern": rows with reasons
- n71 FDA Computer Software Assurance guidance (device-centre guidance, Sept 2025, revised Feb 2026, (s)). It governs how the eBMR is validated, meaning the vendor's and customer's assurance activities. It is not a runtime production control. It belongs in the validation plan and the data-integrity/CSV catalog. It is not binding under Part 211 (C-29).
- n144 EU Ch.5 5.71, which requires telling the MAH about manufacturing constraints that could restrict supply. This is an organisational reporting duty between manufacturer and MAH, and no eBMR function is mandated. Optional support, a supply-impact flag on deviations, is offered in PR-49 as a design choice.
- n611 21 CFR 211.180(f), which requires written notification of responsible officials about complaint, return and salvage investigations, recalls, FDA observations and regulatory actions. This is a QMS and management workflow. The eBMR only supplies the lot links and investigation records (PR-50, PR-57).

---

## (f) Open questions
- F-1 **Automated dispensing under EU 5.38.** Is a validated automated check, with the operator as the only human signer, "independent" for EU purposes? Kernel default: a different human verifier. Also confirm against India Schedule M, which may require a second person regardless of automation.
- F-2 **EU retention for batches never QP-certified** (rejected, destroyed, abandoned). 4.11 is keyed to certification. Provisional default: the later of expiry + 1 year and disposition + 5 years. QA must confirm.
- F-3 **EU import route for Indian sites.** The obligations of Directive 2001/83/EC Art. 51 are not in the uploaded texts: EU QP certification after importation, EU re-testing of imported batches, and whether any mutual-recognition arrangement covers India. The eBMR's role needs confirmation against the official texts: record access for the QP, and recording the external certification reference.
- F-4 **Annex 16 rows are secondary** (n187-n192, n223, n224). Confirm the numbering of sections 1.7 and 3, the Appendix I fields, and the 5-year register retention against the official Annex 16 text.
- F-5 **Annex 15 rows are unverified** (n195-n199). Confirm section numbers (5, 10, 11, 4) and the wording on hold times, OPV and concurrent validation.
- F-6 **Status of drafts:** EU Ch.4 revision (Jul 2025), Annex 22 (Jul 2025), the FDA 211.110 draft guidance (Jan 2025), and the Annex 11 revision. Re-check before each release of the catalog.
- F-7 **Secondary US dates and figures.** Confirm the NDC final rule dates (published March 5, 2026; effective March 7, 2033; transition to March 6, 2036) and the DSCSA figures (6-year retention, 24-hour responses) against official sources.
- F-8 **EU reference and retention samples** (Annex 19) are not in the uploaded texts. Confirm the quantities and retention periods for EU-market batches.
- F-9 **Start of shelf life** (e.g. manufacturing date vs first contact of active with excipients) is not defined in the texts reviewed. It must be a QA-approved product rule.
- F-10 **211.180(b)** keeps component and labeling records for 1 year after "the expiration date", without saying whose. Kernel reading: the last finished lot that used the material. Confirm.
- F-11 **Batch-size ranges under one master.** 211.186(a) and the Ch.4 lead-in above 4.17 require masters for each batch size. Is one master with a validated, registered size range and linear scaling acceptable? Kernel default: discrete approved sizes only.
- F-12 **Intermediate-phase yield limits (US).** The text does not say explicitly that every intermediate yield needs min/max. The kernel requires them at every configured checkpoint (D-9); confirm the customer's regulatory position.
- F-13 **Line clearance as a "significant step"** (dual signature). Recommend the customer's SOPs decide this explicitly. Kernel default: dual.
- F-14 **Part 210.3 definitions** (lot number, yields) are outside the uploaded texts (n1). Confirm wording before quoting them in validation documents.
- F-15 **EU GMP Ch.1** (1.4(xiv) root cause; 1.10 PQR scope) is cited only from secondary rows (n214, n216, n228). Verify against the official Ch.1 text.
