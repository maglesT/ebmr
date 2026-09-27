# India layer: control catalog for the eBMR (Tablets and Injectables editions)

Scope: the Indian legal layer (Revised Schedule M, G.S.R. 922(E) of 28 Dec 2023; Drugs Rules 1945; IT Act 2000; Bharatiya Sakshya Adhiniyam 2023) and how it combines with US FDA and EU GMP when a batch is also made for those markets. FDA-only and EU-only controls live in the companion catalogs. All text is paraphrased; nothing here is a quotation of a regulation.

Baseline assumption used throughout: every batch is made in India under an Indian manufacturing licence, so the Indian rules always apply. A batch's "market profile" adds US and/or EU rules. Where values differ, the engine applies the stricter one for the markets the batch serves (control IN-52). Label rules are resolved per pack/SKU destination rather than per batch (see section B note).

Status keys used in every control:
- **P** = wording and numbers re-read in the uploaded Gazette text during this digest.
- **P~** = present in the Gazette text, but the clause number is inferred (pages are scrambled in the uploaded copy).
- **S** = secondary sources only (not seen in any primary text here); confirm before validation documents cite it.
- **U** = secondary and incomplete or unconfirmed detail; must be confirmed before hard-coding.
- For FDA/EU comparison values: **[chk]** = checked in the supplied primary files (21 CFR 211, 21 CFR 11, EU Ch.4, Ch.5, Annex 1 (2022), Annex 11, FDA 2004 aseptic guidance); **[gk]** = general regulatory knowledge, source not in the supplied set.

Type keys: **ENFORCED** = the engine enforces it and no tenant can switch it off; **CONFIGURABLE** = the tenant sets values within the stated bounds (never looser than the resolved rule); **DESIGN-CHOICE** = our product decision, stricter than or not required by the Indian text, applied for consistency across markets.

Corrections to the register found while re-checking primary texts (applied below):
1. EU Chapter 5 reprocessing/recovery clauses are 5.67-5.69 (not 5.62-5.64); EU per-batch identity testing of starting materials is 5.35 (by reference to Annex 8). EU batch-record retention is Chapter 4 section 4.11.
2. EU Annex 1 (2022) 4.32 caps requalification (which includes the integrity test of final filters) at 6 months for Grades A/B and 12 months for C/D. So for Grade A/B the Indian HEPA interval (recommended 6, maximum 12 months) is weaker than EU, not more prescriptive.
3. Schedule M Part II Table 1 gives 5.0 micrometre limits of 20 (Grade A), 29 (B at rest), 2,900 and 29,000, which are numerically lower than the EU 2022 monitoring/classification values (29, 2,930, 29,300). India is numerically stricter on 5.0 micrometre counts; EU 2022 is stricter on how Grade A is monitored and on microbial limits.
4. Schedule M Part II Table 3 microbial values are stated to be averages and "for information only", not specifications; EU 2022 Table 6 values are maximum action limits with no growth allowed at Grade A.
5. Part VIII 3.8 wording: the 30-minute maximum applies to sampling tablets against the in-process specification; the six named parameters plus lubricant-oil contamination are to be checked "periodically" (frequency left to the firm).
6. EU Annex 1 (2022) 8.94 limits a liquid sterilising filter to a single batch and at most one working day unless validated; India only sets the one-working-day limit.
7. FDA 21 CFR 211.186(a) requires the master record to be signed by one person and independently checked and signed by a second; India only requires approval, signature and date by authorised persons.
8. Release to the EU market: the Indian authorised-person release is still required at the Indian site; EU QP certification takes place at the EU importing/release site. The Indian system supplies the batch package; it does not hold a QP signature slot for the Indian site (correction to register row n233 implications).

---

## A. Controls

### Kernel controls (both editions)

#### IN-01 Quality-system data feeds: product quality review, management review, CAPA
- **Covers:** n229, n231, n674
- **Edition:** both. **Type:** ENFORCED (structured capture and links); CONFIGURABLE (review periods, product grouping with recorded justification).
- **Behaviour:** (a) Yields, IPC results, deviations, OOS, rejects, reprocessing, material lots and supplier identity are stored as typed, queryable fields, never only as free text. (b) A PQR extract per product and period (default 12 months) includes every batch, explicitly including export-only SKUs, failed batches, deviations with CAPA status, changes, and flags suppliers that were new in the period; the PQR record carries the authorised person's sign-off. (c) A management-review extract (default 12 months) is available per site. (d) Every CAPA links to its source (deviation, OOS, complaint, PQR, self-inspection) and has an owner, due date and an effectiveness-check task; an ageing/overdue report exists; release screens show open CAPAs for the product/line as information.
- **Test:** run the PQR extract for a product with domestic and export-only batches; all appear. Create a CAPA with a 90-day effectiveness check; it appears as overdue on day 91.
- **Citations:** Schedule M Part I 1.6 (management review at least yearly unless justified); section 2.3.1-2.3.3 (quality review normally yearly, export-only products included; CAPA management); section 1 PQS list (CAPA effectiveness monitored); 10.5-10.7 (follow-up of self-inspection actions).
- **Verification:** P.
- **Relation to FDA/EU:** PQR: **same** as FDA 211.180(e) (evaluation at least annually) [chk] and EU Chapter 1 section 1.10 (annual review) [gk]. Management review: **stricter** on frequency (yearly minimum) than FDA Part 211 (no such clause) [chk] and EU Chapter 1 (periodic, no fixed minimum) [gk]. CAPA: **same** as EU Chapter 1 [gk] and FDA 211.192 investigations [chk].

#### IN-02 Risk classification recorded on steps, deviations and changes
- **Covers:** n232
- **Edition:** both. **Type:** CONFIGURABLE (scales, formality levels); ENFORCED (a rationale is mandatory whenever a risk class drives a reduced control).
- **Behaviour:** MBR steps, parameters, deviations and change requests carry a risk class from a controlled, versioned scale. Any risk-based reduction (e.g., no second-person verification, "minor" deviation, reduced IPC frequency) cannot be saved without a linked risk assessment and written rationale. Changing a step's criticality in a new MBR version changes its verification requirements.
- **Test:** classify a deviation as minor without a rationale; saving is refused.
- **Citations:** Schedule M Part I section 2 (QRM: systematic, science-based, effort proportionate to risk).
- **Verification:** P.
- **Relation to FDA/EU:** **same** in substance as ICH Q9(R1) as adopted in EU GMP Part III and FDA guidance [gk]; Part 211 has no explicit QRM clause [chk], so India is more explicit than the FDA regulation.

#### IN-03 Change control gate and first-batch-after-change evaluation
- **Covers:** n268
- **Edition:** both. **Type:** ENFORCED.
- **Behaviour:** (a) No MBR, packaging-instruction, master-data, limit table, software or configuration version can become effective without a linked, approved change record (approval by the originating unit and by quality). (b) The change record stores the change class (e.g., minor/major) and the list of affected documents; the change cannot be closed until all listed documents are revised. (c) The first batch made or tested under the changed state is automatically flagged "post-change evaluation required"; it cannot be released until QA signs that evaluation. (d) For changes classified critical, the system creates a task to assess retest/expiry impact (optionally a stability commitment).
- **Test:** approve MBR v2 under change CC-1, execute a batch; release is blocked until the post-change evaluation is signed.
- **Citations:** Schedule M Part I 8.1-8.7 (formal change control; quality-unit approval; classification; documents revised on implementation; evaluation of the first batch after the change; expiry/retest impact of critical changes); Part I section 20 (changes to computerised systems follow a change procedure; exact sub-clause number not legible in the uploaded copy).
- **Verification:** P (8.6 first-batch evaluation and 8.7 expiry evaluation re-read).
- **Relation to FDA/EU:** **stricter** (more explicit) than FDA 211.100(a), which requires changes to procedures to be reviewed and approved by the relevant units and the quality control unit but names no first-batch evaluation [chk]; **same** intent as EU Chapter 1 / ICH Q10 post-implementation evaluation [gk].

#### IN-04 Role model, segregation of duties, approved technical staff and training gates
- **Covers:** n234, n662, n271
- **Edition:** both. **Type:** ENFORCED (segregation, training gate); CONFIGURABLE (approved-staff register mandatory for India-licensed sites, on by default).
- **Behaviour:** (a) Separate roles for head of production, head(s) of QA/QC, authorised person (AP) and designated production-record reviewer. (b) One user cannot hold both a production-head and a quality-head approval on the same batch. (c) The production-record review signature is distinct from, and must precede, the QA review. (d) An "approved technical staff" register stores, for each person approved for manufacture or testing, the licensing-authority approval reference and date; only these people can sign production-supervisor or QC-approval steps on batches made under an Indian licence. (e) Each MBR step type needs a current training record; the system refuses step sign-on by untrained users and stores the training status at the moment of signing. (f) Visual inspectors need a current eye-check record (see IN-50). (g) Visitor/contractor accounts are view-only or supervised.
- **Test:** give one user production-head and QA-head roles on one batch; the conflict is refused. Remove a user from the approved-staff register; they can no longer sign as production supervisor.
- **Citations:** Schedule M Part I 11.3.1 (key personnel), 11.3.4-11.3.5 (heads independent; designated person signs production records), 11.2, 11.4 (training), 11.5 (hygiene; eye checks for visual inspectors); Part I 11.3.2 (qualifications as per the Rules); Drugs Rules 71 and 76 (manufacture under active direction of competent technical staff; testing staff approved by the licensing authority).
- **Verification:** P for Schedule M (independence of heads and designated reviewer re-read); S for Drugs Rules 71/76.
- **Relation to FDA/EU:** training and quality-unit independence **same** as FDA 211.22 and 211.25 [chk] and EU Chapter 2 [gk]. The approved-technical-staff register is **different** (Indian licensing construct; the EU uses the QP under Annex 16 [gk]; FDA has no named-person approval).

#### IN-05 Batch disposition by the authorised person
- **Covers:** n233, n244, n676
- **Edition:** both. **Type:** ENFORCED.
- **Behaviour:** (a) Bulk and finished goods are created in quarantine; only an e-signed disposition changes status (released, rejected, on hold) and warehouse/ERP interfaces must honour that status. (b) The release signature is available only to the AP or to a named delegate whose delegation cites an approved procedure. (c) Hard prerequisites: every step signed; production-record review signed; all deviations closed or formally assessed; head-of-QC approval recorded; a regulatory-notification assessment recorded for any change or deviation; for injectables, sterilisation records, EM data for the processing window and sterility results reviewed (IN-42, IN-47, IN-49). (d) The release checklist (licence and approval conditions met, validated processes, documentation complete and endorsed) is stored with the release record. (e) A rejected batch cannot close without a recorded disposition (return, reprocess, destroy) approved by an authorised role.
- **Test:** attempt release with an open deviation, without head-of-QC approval, with an unsigned step, and as a user without the AP/delegate role; all four are blocked.
- **Citations:** Schedule M Part I section 1 PQS list (no sale or supply before AP certification; head-of-QC approval), 11.3.6-11.3.10 (AP duties and delegation), 18.2.2 and 18.5.12 (records reviewed before AP; investigation of discrepancies), 14.29-14.31 (quarantine, release, rejected materials).
- **Verification:** P.
- **Relation to FDA/EU:** **different** legal role. FDA: quality control unit approves, after reviewing all production and packaging records, per 211.22 and 211.192 [chk]; the Indian AP plus head-of-QC approval maps onto that and must meet 211.192 for US batches. EU: QP certification (Annex 16 [gk]; Annex 11 section 15 requires the system to let only QPs certify, by e-signature [chk]) happens at the EU importing site, not in India; the system supplies the batch package and can store the QP certification reference received back.

#### IN-06 Document control of masters and corrections to recorded data
- **Covers:** n236
- **Edition:** both. **Type:** ENFORCED; DESIGN-CHOICE for the two-person master approval and the always-mandatory reason.
- **Behaviour:** (a) MBRs, packaging instructions and SOP references have approval e-signatures, an effective date and a periodic-review date. (b) Once superseded, a version can no longer issue new batches but stays retrievable for a configured period (never shorter than the retention of batches made with it). (c) Every master version needs two signatures from different users: prepared by one, independently checked by another (applied in all profiles; required for US). (d) A correction to a recorded value never overwrites it: original value, new value, user, timestamp and a reason are kept and shown in the rendered record. The reason is mandatory in all profiles.
- **Test:** supersede MBR v1; new batches cannot start on it; v1 still opens. Correct a weight; the rendered BMR shows old and new values, who, when, why.
- **Citations:** Schedule M Part I 17.2 (design, approval, signature and dating of documents; regular review; preventing use of superseded versions; retention of superseded documents for a set period; clear, indelible entries; alterations signed and dated with the original legible and a reason where appropriate).
- **Verification:** P~ (text re-read; 17.2 sub-clause numbers inferred).
- **Relation to FDA/EU:** corrections **same** as EU Chapter 4 section 4.9 (reason "where appropriate") [chk]; **weaker** than EU Annex 11 section 9 (reason must be documented for any change or deletion of GMP-relevant data) [chk]. Master approval **weaker** than FDA 211.186(a) (one person prepares and signs, a second independently checks and signs) [chk]. The system applies both stricter rules everywhere.

#### IN-07 Contemporaneous capture, completeness and traceability
- **Covers:** n230, n235
- **Edition:** both. **Type:** ENFORCED.
- **Behaviour:** (a) Each step is recorded at the time of the action with a server timestamp; entries by hand, by instrument interface, or both, are supported. (b) A batch cannot be completed while any mandatory step is unexecuted; skipped or not-applicable steps need a reasoned, signed justification. (c) Significant deviations are captured at the point of occurrence (IN-20). (d) Full backward genealogy (every input lot) and forward genealogy (packaging batches, distribution records) is queryable per batch. (e) The complete record renders in a human-readable form for the whole retention period (IN-08).
- **Test:** skip a step; completion is refused. From a finished batch, list every input lot and every customer shipment.
- **Citations:** Schedule M Part I section 1 PQS list (records during manufacture show each step was done; history of a batch traceable and accessible), 3.1 (basic GMP requirements), 17.2 (records made when each action is taken).
- **Verification:** P~.
- **Relation to FDA/EU:** **same** as FDA 211.100(b) (documented at the time of performance) and 211.188(b) [chk], and EU Chapter 4 section 4.8 [chk].

#### IN-08 Record retention engine
- **Covers:** n235, n661, n678
- **Edition:** both. **Type:** ENFORCED (compute, block purge); CONFIGURABLE (company policy may only lengthen).
- **Behaviour:** For each batch the system computes a "retain until" date as the maximum of every rule that applies to that batch, stores which rule governed, and blocks deletion or archive-with-loss before that date. Rules: (i) Schedule M: expiry + 1 year (always). (ii) Drugs Rules conditions of licence, pending confirmation: 5 years from manufacture for Schedule U manufacturing and test records (Form 25, Rule 74); for Form 28 licences (Rule 78) test records reportedly 2 years after expiry where an expiry is labelled, otherwise 5 years from manufacture (U). (iii) US market: expiry + 1 year (3 years after distribution for exempt OTC products without expiry). (iv) EU market: the longer of expiry + 1 year or 5 years after QP certification. Audit trails and signatures are retained for the same period as the record they belong to. A legal hold (complaint, recall, litigation) suspends expiry of retention.
- **Test:** 24-month tablet made Jan 2026, India only: retention not earlier than Jan 2031 (5 years) because expiry + 1 year is Jan 2029. Same batch for EU with QP certification Mar 2026: not earlier than Mar 2031.
- **Citations:** Schedule M Part I 17.2 (retention at least one year after finished-product expiry); Drugs Rules Rules 74 and 78 with Schedule U (S/U).
- **Verification:** P~ for Schedule M (retention sentence re-read; numbered 17.2.7 by WHO ordering); U for the Drugs Rules periods.
- **Relation to FDA/EU:** Schedule M rule is the **same** as FDA 211.180(a) (expiry + 1 year) [chk] and **weaker** than EU Chapter 4 section 4.11 (longer of expiry + 1 year or 5 years after QP certification) [chk]. If the Rule 74/78 periods are confirmed, the Indian result can exceed FDA for short shelf lives.

#### IN-09 Computerised-system controls for electronic batch records
- **Covers:** n237, n238
- **Edition:** both. **Type:** ENFORCED; DESIGN-CHOICE for audit-trail review and periodic evaluation (not in Schedule M).
- **Behaviour:** (a) Role-based access; only authorised users enter or change data; access by unique credentials. (b) An always-on audit trail records every create, change and delete with previous value, new value, user and timestamp; it cannot be disabled or edited. (c) Completeness controls: sequence and heartbeat checks on instrument feeds so that data not captured while a device or the system was down are detected and flagged in the batch record. (d) Every manually entered critical value needs a second-person verification or a validated system check. (e) System incidents that could affect product quality or record reliability are logged, investigated and linked to affected batches. (f) Configuration and software changes go through change control (IN-03) with test evidence. (g) Validated backup and restore; restore test on a schedule. (h) Optional parallel secondary record (e.g., printout) can be attached. (i) Audit-trail review is a step of batch review (review by exception allowed) and a periodic system evaluation report is available.
- **Test:** stop an equipment feed mid-step; a gap flag appears. Enter a critical value manually; a verifier is demanded. Restore a backup to a test instance; a closed batch renders completely.
- **Citations:** Schedule M Part I 17.2 electronic data-processing clause (electronic or photographic records allowed; authorised persons only; record of changes and deletions; passwords or other means; independent check of critical entries; backup; readily available during retention); Part I 20.2-20.10 (IQ/OQ; qualified commercial software; retrospective validation; access and change controls; preventing omitted data; previous entry, who and when recorded; procedures; second check of critical manual entries; incidents; change procedure; backup; secondary means of recording). The 20.1 sentence is not legible in the uploaded copy.
- **Verification:** P (20.2, 20.3, 20.6, 20.7 and the data-processing clause re-read); P~ for the 17.2 sub-clause number.
- **Relation to FDA/EU:** **same** as EU Annex 11 sections 4, 6, 7, 10, 12, 13 [chk] and FDA 211.68(b) (authorised changes, input/output checks, backup) [chk]. **Weaker** than Annex 11 section 9 (audit trails regularly reviewed; reason for change documented) and section 11 (periodic evaluation) [chk], and than 21 CFR 11.10(e) (secure, computer-generated, time-stamped audit trail kept at least as long as the record) [chk]. The kernel applies the stricter items for every market.

#### IN-10 Electronic signatures (Indian basis)
- **Covers:** n663, n667, n242
- **Edition:** both. **Type:** ENFORCED (baseline); CONFIGURABLE (PKI/eSign option per signature meaning).
- **Behaviour:** (a) Baseline for all signatures: unique user ID plus secret, re-authentication at the moment of signing, signature manifestation (printed name, date/time with time zone, meaning such as performed/verified/approved/released), cryptographic binding of the signature to a hash of the signed content so any later change shows the signature as broken, no shared or reused IDs. (b) Configurable option: for selected meanings (default proposal: MBR approval and AP release) require a Class 3 digital signature certificate from a licensed certifying authority, or an eSign (Second Schedule technique) instead of the password signature. (c) Any record can be printed or exported with signatures and audit trail on demand.
- **Test:** sign a step, then alter the value directly in the test database; signature verification reports the record as altered. Sign a release with a DSC; it validates against the CCA root chain.
- **Citations:** Schedule M Part I 17.3.9 (packaging-record entries identified by signature or electronic password); Part I 17.3.8 (processing record dated and signed); Part XII 6.1 (e-signatures authenticated and secure; hard copy obtainable where electronic records are used; 6.1.7 originals or true copies); IT Act 2000 sections 3A, 5 and Second Schedule. See section D.
- **Verification:** P for Schedule M (17.3.9 wording and Part XII sentence re-read; Part XII sentence number 6.1.9 inferred); S for IT Act.
- **Relation to FDA/EU:** **weaker/less specific** than 21 CFR 11.50 (manifestation), 11.70 (signature/record linking), 11.100, 11.200 (two distinct identification components), 11.300 (identification code/password controls) [chk] and EU Annex 11 section 14 (same effect as handwritten within the company, permanently linked, time and date) [chk]. The baseline in (a) meets all three regimes.

#### IN-11 Certified evidence export
- **Covers:** n668
- **Edition:** both. **Type:** DESIGN-CHOICE.
- **Behaviour:** Any batch record can be exported as a package: rendered human-readable copy, machine-readable data, full audit trail, and a manifest with a SHA-256 hash per file plus system name, version, time source, export operator and time. The hashes re-verify on import. The package supplies the facts needed for the certificate that accompanies electronic evidence in Indian proceedings, and keeps origin and date/time metadata (IT Act s.7).
- **Test:** export a batch; alter one byte; hash verification fails.
- **Citations:** Bharatiya Sakshya Adhiniyam 2023 section 63 (in force 1 Jul 2024, replacing Evidence Act s.65B); IT Act 2000 section 7.
- **Verification:** S (certificate form not reviewed; open question G-5).
- **Relation to FDA/EU:** **different**: no equivalent evidence certificate; closest are 21 CFR 11.10(b) (accurate and complete copies in human-readable and electronic form for inspection) [chk] and EU Annex 11 section 8 (clear printed copies; printouts showing changes for batch-release records) [chk].

#### IN-12 Validation package and site master file support
- **Covers:** n273
- **Edition:** both. **Type:** DESIGN-CHOICE (vendor deliverable).
- **Behaviour:** The vendor ships a validation package usable in the customer's validation master plan: URS, risk assessment, IQ/OQ scripts with evidence, traceability matrix, periodic-review template, and a short, accurate system description for the "computerised systems validation" item of the site master file. Supplier-qualified functions are documented so that customer testing can be reduced as allowed for qualified commercial software.
- **Test:** the package contains each listed artefact and the SMF paragraph.
- **Citations:** Schedule M Part I section 5 (qualification and validation; validation master plan; attention to automated systems; periodic review); Appendix I site master file item on qualification and calibration including computerised-system validation arrangements; Part I 20.2-20.3.
- **Verification:** P.
- **Relation to FDA/EU:** **same** as EU Annex 11 section 4 [chk] and Annex 15 [gk]; FDA 211.68 and 21 CFR 11.10(a) validation [chk/gk].

#### IN-13 Master formula (MBR) content and hold times
- **Covers:** n239, n262, n678
- **Edition:** both (tablet CPP rule applies to the Tablets edition). **Type:** ENFORCED.
- **Behaviour:** (a) One approved master per product and per batch size; a batch of a different size needs its own approved master (or a separately approved scaled master). (b) MBR approval fails validation if any of these is empty: product name and product code linked to its specification; dosage form, strength, batch size; each starting material with INN where one exists, quantity, designated name and unique material code; a flag for substances lost in processing (e.g., granulation water, solvents); expected final yield with limits and pertinent intermediate yields; processing location and principal equipment class; references to methods for preparing critical equipment (cleaning, assembly, calibration, sterilisation, use); stepwise instructions; each IPC with its limits; storage requirements for products (container, labelling, special conditions); special precautions; **the permitted hold time for every intermediate and in-process material**. (c) Tablets edition: each mixing, blending and drying step must carry its critical operating parameters (at least time and temperature) with limits, and the batch record captures the observed values (IN-36).
- **Test:** approve an MBR with one intermediate lacking a hold time; approval is refused. Try to issue a 200 kg batch from a 100 kg master; refused.
- **Citations:** Schedule M Part I 17.3.6 (master formula list, including hold time as its final item); Part VIII 2.3 (time and temperature for mixing, blending and drying set in the master formula, monitored and recorded).
- **Verification:** P.
- **Relation to FDA/EU:** per-batch-size masters **same** as FDA 211.186(a) [chk] and EU Chapter 4 (formula and instructions per product and batch size; 4.17-4.18) [chk]. Hold time as a mandatory master element is **stricter** than FDA 211.111 (time limits for each production phase only when appropriate) [chk] and EU 4.17/4.18 (no hold-time item) [chk]. Time/temperature CPPs **same** as EU 4.18(d) [chk].

#### IN-14 Master packaging instructions
- **Covers:** n240
- **Edition:** both. **Type:** ENFORCED.
- **Behaviour:** A separate approved packaging master per product x pack size x pack type, linked to the MBR, containing: product name; form, strength and method of application where relevant; pack size; complete packaging bill of materials for the standard batch with quantities, sizes, types and each material's specification code; an image of each approved printed component with the positions of batch number, expiry date and (for India packs) manufacturing date and MRP marked; line-clearance checks before and after packaging; the operation description and equipment; IPCs with sampling instructions and limits. A packaging order cannot start unless every printed component in the bill has an attached approved specimen.
- **Test:** create two pack sizes of one product; each needs its own approved packaging master.
- **Citations:** Schedule M Part I 17.3.7 (packaging instructions).
- **Verification:** P.
- **Relation to FDA/EU:** **same** as EU Chapter 4 section 4.19 [chk] and FDA 211.186(b) master record content [gk].

#### IN-15 Batch processing record content
- **Covers:** n241
- **Edition:** both. **Type:** ENFORCED.
- **Behaviour:** The executed record is generated from the approved MBR (no re-typing). Before processing, a recorded check that the equipment and workstation are free of previous products, documents and materials and are clean and suitable. Captured at the time of action: product name; batch number; date/time of start of significant intermediate stages and of completion; **named person accountable for each stage** (separate from step performers); initials/IDs of operators of significant steps and, where appropriate, of checkers (e.g., weighing); lot or analytical control number and actual quantity of each starting material, including recovered or reprocessed material; significant operations, events and major equipment IDs; **permitted hold time and actual hold start/stop per intermediate**, with an alarm or deviation when exceeded; IPC results with performer; yields at pertinent stages with a mandatory explanation when outside limits; notes on special problems with signed authorisation for any departure from the master. On completion the processing lead dates and e-signs the record.
- **Test:** exceed a hold time; the system blocks the next step or opens a deviation. Enter an out-of-limit stage yield; a comment and deviation link are forced.
- **Citations:** Schedule M Part I 17.3.8 (batch processing records).
- **Verification:** P (item list re-read, including hold time and responsible person per stage; sub-item letters inferred).
- **Relation to FDA/EU:** mostly **same** as FDA 211.188(b) (dates, equipment, component lots, weights, IPC results, yields, persons performing and checking each significant step) [chk] and EU Chapter 4 section 4.20 [chk]. **Stricter** on two items absent from both: the person responsible for each stage, and the hold time for intermediates [chk].

#### IN-16 Batch packaging record content
- **Covers:** n242
- **Edition:** both. **Type:** ENFORCED.
- **Behaviour:** A separate packaging record per packaging batch or part-batch, linked to the bulk batch, built from the approved packaging master. Before packaging: recorded line clearance. Captured at the time of action, with the responsible person identified by signature or electronic password: product name, bulk batch number and quantity to be packed, finished batch number, planned and actual quantity and reconciliation; date and time of operations; responsible person; operator IDs for significant steps; identity and conformity checks against the instructions including IPC results; operations, equipment and lines; handling of unpacked product returned to store; specimens (image capture) of printed materials including coded batch/expiry/manufacturing date/MRP at start and at intervals; notes on problems and deviations with authorisation; quantities and reference numbers of printed materials and bulk issued, used, destroyed or returned.
- **Test:** run two part-batches; two linked packaging records exist, each with start/mid/end coding specimens.
- **Citations:** Schedule M Part I 17.3.9 (batch packaging records).
- **Verification:** P.
- **Relation to FDA/EU:** **same** as EU Chapter 4 section 4.21 [chk] and FDA 211.188(b)(6), (8) and 211.134 (examination of packaged products, results in the batch record) [chk].

#### IN-17 Yields and reconciliation
- **Covers:** n245
- **Edition:** both. **Type:** ENFORCED; CONFIGURABLE (limits per product/component).
- **Behaviour:** Yields are calculated automatically at each stage against MBR limits; printed components and bulk are reconciled automatically (issued = used + destroyed + returned, within limits). Any out-of-limit yield or significant/unusual reconciliation discrepancy opens a deviation that blocks release until explained and closed. No reconciliation waiver is offered for roll labels.
- **Test:** enter a carton reconciliation with a 2% unexplained loss above the configured limit; a deviation opens and release is blocked.
- **Citations:** Schedule M Part I 18.2.3, 18.4.6, 18.5.10 (yield checks and reconciliation; investigation before release).
- **Verification:** P.
- **Relation to FDA/EU:** **same** as EU 5.44 and 5.61 [chk] and FDA 211.103 [gk], 211.125(c) and 211.192 [chk]. FDA 211.125(c) waives label reconciliation for cut or roll labeling when 100% examination is done [chk]; India has no such waiver, so India is **stricter** there and the waiver is not offered.

#### IN-18 Batch numbering and allocation register
- **Covers:** n243, n249
- **Edition:** both. **Type:** ENFORCED (uniqueness); CONFIGURABLE (number format, bulk-to-pack linkage rule).
- **Behaviour:** A configurable batch-number generator with a site-wide uniqueness constraint: a number is never reissued, including after cancellation or reprocessing; manual entry of an existing number is rejected. Processing and packaging batch numbers are linked by a defined rule. Every allocation writes immediately to an allocation register with at least allocation date, product identity and batch size. A reworked batch always receives a new batch number (IN-19).
- **Test:** cancel a batch; its number is never offered again. Export the register; the three fields are present.
- **Citations:** Schedule M Part I 17.3.10.8-17.3.10.11 (numbering SOP, relation of processing and packaging numbers, no reuse, immediate recording of allocation); 14.32 (reworked batch gets a new number).
- **Verification:** P (14.32 re-read); P~ for 17.3.10 sub-numbers.
- **Relation to FDA/EU:** new number for rework is **stricter** than FDA 211.115 [chk] and EU 5.67 [chk] (neither requires it). Unique, history-traceable lot numbers **same** as FDA 211.130(c) [chk].

#### IN-19 Rework, reprocessing and recovery
- **Covers:** n249
- **Edition:** both. **Type:** ENFORCED; DESIGN-CHOICE for the default expiry proposal.
- **Behaviour:** (a) Rework of a rejected batch is modelled as a new batch with a new number and a parent-child link to the rejected batch(es); it requires an approved rework procedure/protocol and a linked risk evaluation; a record of the rework is part of the new batch record. (b) Adding an earlier in-specification batch (recovery) into a later batch of the same product is allowed only at an MBR-defined stage, with prior authorisation, a risk evaluation that addresses shelf-life impact, and recording of source batch numbers and quantities. The expiry of the receiving batch requires QA confirmation; the default proposal is not later than the earliest expiry of any recovered input (design choice). (c) QC receives an automatic flag to consider additional testing of any finished batch that was reworked, reprocessed or contains recovered material. (d) US-market batches: reprocessing also needs quality-unit approval.
- **Test:** add recovered material without prior authorisation; the step is blocked.
- **Citations:** Schedule M Part I 14.32-14.34.
- **Verification:** P.
- **Relation to FDA/EU:** **same** as EU 5.67-5.69 [chk] and FDA 211.115 (written procedures; quality control unit approval) [chk], except the new-number rule (IN-18), which is stricter.

#### IN-20 Deviations, OOS and investigation scope
- **Covers:** n244, n659, n230
- **Edition:** both. **Type:** ENFORCED.
- **Behaviour:** (a) A deviation is captured at the point of occurrence and linked to the step; a planned or unplanned departure from the MBR cannot continue until a designated role approves it by e-signature (QC co-approval configurable, on by default for product-impacting categories). (b) Closure requires root cause (or most probable cause), CAPA reference and conclusion; the impact assessment can list other batches and products, which are then flagged. (c) IPC results that are specification tests follow the same OOS workflow as QC results: the original result stays in the record, a re-entered passing value never replaces it, and the OOS stays open until the approved investigation closes. (d) Sampling steps print sample labels with material name, batch/lot number, container number, sample number, sampler identity (e-signature) and date. (e) QC results used for release are approved by a checker different from the analyst.
- **Test:** enter an out-of-specification IPC assay and then a passing re-test; both remain visible and the OOS stays open.
- **Citations:** Schedule M Part I 18.2.2 (written approval of any departure by a designated person, QC involved where appropriate); 18.5.12 (review before AP; investigation extended to other batches); section 1 PQS list (root cause, CAPA effectiveness); 19.1-19.3 (QC independence; records of sampling and testing; review of production documentation in product assessment); 19.6.6 (sample label items); 19.6.7 (OOS investigated under an approved procedure).
- **Verification:** P (18.2.2, 19.6.6, 19.6.7 re-read).
- **Relation to FDA/EU:** **same** as FDA 211.100(b) (deviations recorded and justified) and 211.192 (investigation extended to other batches) [chk]; sample identification **same** as FDA 211.84(c)(5) [chk]; OOS handling **same** as FDA OOS guidance [gk] and EU Chapter 6 [gk].

#### IN-21 Line clearance, status labelling and identification
- **Covers:** n246
- **Edition:** both. **Type:** ENFORCED.
- **Behaviour:** Rooms, lines and major equipment carry a status (in use for product/strength/batch/stage; cleaned; to be cleaned; out of service) shown on screen and on printable labels; containers of materials and bulk carry product, strength, batch and stage. An electronic line-clearance checklist, recording the previous product, is a gating step before (and, for packaging, after) each operation; its signer and time appear in the batch record. Each packaging line displays the product and batch in the line status. Required environmental readings for the step are captured into the batch record.
- **Test:** start compression on a room with status "to be cleaned"; refused.
- **Citations:** Schedule M Part I 18.2.5, 18.4.1-18.4.2 (identification; checks before processing), 18.5.2-18.5.3 (packaging line clearance by checklist; line identification).
- **Verification:** P.
- **Relation to FDA/EU:** **same** as EU 5.40, 5.50, 5.51 [chk] and FDA 211.105(a), 211.130(e) and 211.188(b)(6) [chk].

#### IN-22 Packaging operation controls (coding, readers, on-line checks, leftovers)
- **Covers:** n247
- **Edition:** both. **Type:** ENFORCED; CONFIGURABLE (check frequencies, never below the MBR minimum; tighter for manual labelling).
- **Behaviour:** (a) Coding (batch, expiry, manufacturing date, MRP where applicable) is verified and recorded at start and at intervals; hand-applied printing is re-checked at a shorter interval. (b) Electronic code readers, vision systems, label counters and similar devices are challenged at start, at intervals and at end; a failed challenge places everything since the last good challenge on hold. (c) On-line checks include at least pack appearance, completeness, correct product and materials, correct overprint and working line monitors. (d) Samples taken from the line are not returned. (e) An "unusual event" sub-workflow requires inspection, investigation and authorised approval before product re-enters the line, with a detailed record. (f) Labelling must follow filling/sealing promptly, or the MBR defines controls against mix-ups for the interval. (g) At the end, unused batch-coded materials must be recorded as destroyed; uncoded printed materials return to stock only through a documented check.
- **Test:** close a packaging order with coded cartons unaccounted for; closure demands a destruction entry.
- **Citations:** Schedule M Part I 18.5.4-18.5.11.
- **Verification:** P (18.5.4-18.5.9 re-read).
- **Relation to FDA/EU:** **same** as EU 5.54-5.62 [chk] and FDA 211.125(d) (destroy excess coded labeling), 211.130 and 211.134 [chk].

#### IN-23 Dispensing
- **Covers:** n248
- **Edition:** both. **Type:** ENFORCED.
- **Behaviour:** Container-level barcode identity check; hard block on any lot not released by QC, expired, or past retest; only users in the designated-dispenser role may dispense; each weighing or measurement is independently checked by a second person or by a validated balance interface configured as the independent check; dispensed materials for a batch are kept and labelled together with a kit label linked to the batch.
- **Test:** scan a quarantined lot, an expired lot and a lot past retest; all refused.
- **Citations:** Schedule M Part I 14.14, 14.16-14.20.
- **Verification:** P (14.14, 14.16-14.18 re-read).
- **Relation to FDA/EU:** **same** as EU 5.33-5.34 and 5.37-5.39 [chk] and FDA 211.84(a) and 211.101(c)-(d) (second-person or automated check) [chk].

#### IN-24 Material status, labels, excipient release route, packaging materials and returns
- **Covers:** n250, n251, n673
- **Edition:** both. **Type:** ENFORCED; CONFIGURABLE (vendor-history release route, India-only).
- **Behaviour:** (a) The system is the authority for material status (quarantine, under test, released, rejected, returned, recalled); status changes are e-signed and audit-trailed; with the validated system, labels may carry a barcode plus minimal text. (b) Each lot within a delivery is sampled, tested and released separately; every delivery of primary and printed packaging gets a unique reference. (c) Excipient release: Schedule M 14.15 lets QC release non-API raw materials without batch testing based on vendor approval and statistical analysis of past results. The system supports this route only when QA enables it, stores the statistical justification, and limits such lots to batches whose market profile is India-only. For any batch with a US or EU market, the dispensing check blocks a lot that has no identity test result. Default for new tenants: identity test required for every lot in every profile, because the Schedule M identity-test clause 19.7.2 is truncated in the uploaded copy and may restrict 14.15 (gap F-2). (d) Printed materials are issued only by a designated role against the packaging bill of materials with scan confirmation of artwork version; superseded artwork is blocked and its destruction recorded. (e) Returned goods cannot be made available again without a recorded QC assessment (nature, storage needs, condition, history, time since issue).
- **Test:** release an excipient lot on vendor history and try to dispense it into a batch with markets {India, US}; blocked until an identity result exists.
- **Citations:** Schedule M Part I 14.10-14.13 (receipt, labelling of stored materials, reduced label text with validated systems), 14.15 (non-API raw materials released without batch testing), 14.21-14.25 (packaging materials), 14.36 (returned goods), 19.7.1 (identity, strength, purity before release).
- **Verification:** P (14.15 and 19.7.1 re-read).
- **Relation to FDA/EU:** the vendor-history route is **weaker** than FDA 211.84(d)(1)-(2) (at least one identity test on each component; supplier report of analysis accepted only with an identity test and periodic validation of supplier results) [chk] and EU 5.35 (identity testing of each batch per Annex 8) [chk]. Status, labels and packaging-material rules **same** as EU 5.31-5.32, 5.45-5.48 [chk].

#### IN-25 Equipment status, logbooks, calibration and clean-hold time
- **Covers:** n266, n267
- **Edition:** both. **Type:** ENFORCED; CONFIGURABLE (hold-time values from validation data).
- **Behaviour:** (a) Equipment and room logbooks are written automatically from execution (who, product, batch, start/end, cleaning, maintenance), chronological, correctable only through audited corrections. (b) Before a step can use equipment, the system checks qualified, calibrated (not past due), cleaned and not-out-of-service status; balances need a daily/before-use check record. (c) Each equipment class has a validated clean-hold time (and dirty-hold time where defined); the system computes "clean until" and blocks use after it, forcing re-cleaning. (d) Equipment or utility failure can be signalled from the step and removes the item from use until repaired.
- **Test:** use a balance with calibration past due; the weighing step is blocked. Wait past a press's clean-hold time; the next batch cannot use it.
- **Citations:** Schedule M Part I 17.3.10.5 and 17.3.10.16-17.3.10.17 (equipment SOPs near the equipment; logs), 18.4.3 and 18.4.9 (failures, calibration), 18.4.4 (data-based time limits for cleaned equipment and process materials), 18.4.5 and 18.2.8.
- **Verification:** P~ (17.3.10.5 re-read; others from register).
- **Relation to FDA/EU:** **same** as FDA 211.67, 211.68(a) and 211.182 [chk/gk] and EU Chapter 3 and Chapter 4 logbook clauses [gk]. The explicit clean-hold time is **same** in intent as FDA 211.67(b) [gk] and EU Annex 15 cleaning validation [gk].

#### IN-26 Cross-contamination and room/product eligibility
- **Covers:** n672, n677
- **Edition:** both (cubicle and pressure-cascade detail: Tablets). **Type:** ENFORCED (eligibility rules); CONFIGURABLE (room/equipment master data).
- **Behaviour:** (a) Product-to-room and product-to-equipment restrictions (dedicated, campaign-only, segregated) are master data; campaign length and changeover cleaning-validation references are stored; residue (swab/rinse) results gate the changeover. (b) The system refuses a second open batch of a different product in the same room unless the room is configured as segregated with a recorded risk justification. (c) Tablets: each press sits in its own cubicle unless the same product runs on all presses there or the press is self-enclosed; hoppers, containers and presses carry identity labels verified by scan at charging; highly potent products may only be scheduled in rooms flagged with a negative pressure cascade; corridors are at higher pressure than cubicles and cubicles above atmospheric; pre-use checks include nozzles clean and no lubricant leakage.
- **Test:** schedule a highly potent product in a positive-pressure cubicle; blocked. Charge granules from a container labelled for another batch; the scan is refused.
- **Citations:** Schedule M Part I 18.2.4, 18.2.7, 18.3.1-18.3.5, 18.5.1; Part VIII 1.1, 1.6-1.10, 3.1-3.2.
- **Verification:** P (Part VIII 1.6-1.10 and 3.1-3.2 re-read).
- **Relation to FDA/EU:** **same** in intent as EU 5.49 (no packaging in close proximity without segregation) [chk], EU Chapter 3/5 cross-contamination measures [gk] and FDA 211.42(c), 211.46 [gk]; the tablet cubicle and pressure-cascade specifics are **stricter/more prescriptive** than either text.

#### IN-27 Hazardous products (sex hormones, steroids, cytotoxics)
- **Covers:** n666
- **Edition:** both. **Type:** ENFORCED (eligibility and inserted steps once the hazard class is set).
- **Behaviour:** Product master data carries a hazard class set from a documented risk assessment (which stages fall under Part III). The class restricts rooms, lines and equipment to contained ones and inserts mandatory PPE, containment-check and decontamination/de-gowning steps into the MBR; the executed checks are recorded. Where breathing air is used, the room master data records the 100% back-up with automatic changeover and its status is checked at step start.
- **Test:** classify a product as cytotoxic; the MBR designer adds PPE and decontamination steps and offers only contained areas.
- **Citations:** Schedule M Part III (general; 2.1-2.3 risk assessment including OELs; 4 PPE and breathing air).
- **Verification:** P~ (Part III 2.1-2.3 re-read; the rest is interleaved with Part IV text in the uploaded copy).
- **Relation to FDA/EU:** **different/more prescriptive** than EU Chapter 3/5 health-based exposure limits approach [gk] and FDA 211.42/211.46 [gk].

#### IN-28 Self-inspection support and supplier approval
- **Covers:** n269
- **Edition:** both. **Type:** CONFIGURABLE (audit mode, schedule); ENFORCED (read-only auditor role).
- **Behaviour:** A read-only auditor role with batch sampling and exports of deviation/CAPA status; findings link to batches and CAPA both ways; the self-inspection schedule reminds QA when 12 months since the last self-inspection are about to pass (frequency may be set shorter, never longer, for Indian sites). The approved-supplier list is master data used at receipt and dispensing.
- **Test:** an auditor opens a closed batch record; edit functions are unavailable.
- **Citations:** Schedule M Part I 10.1-10.8 (10.4: frequency set in the procedure, at least once a year).
- **Verification:** P (10.4 re-read).
- **Relation to FDA/EU:** **stricter** than FDA Part 211 (no self-inspection clause) [chk] and EU Chapter 9 (programme-based, no fixed minimum) [gk].

#### IN-29 Complaints, recalls and genealogy queries
- **Covers:** n270
- **Edition:** both. **Type:** ENFORCED (links); CONFIGURABLE (notification templates).
- **Behaviour:** Complaint and recall records link to batch IDs; genealogy answers within seconds "which batches used material lot X" and "which batches contain reprocessed or recovered material from batch Y"; per-batch distribution data (customer, quantity, date) supports a recall reconciliation of delivered versus recovered quantities; the AP role owns recall execution; a flag records that the licensing authority was informed of an intended recall.
- **Test:** from a defective API lot, list every finished batch including those with recovered material from affected batches.
- **Citations:** Schedule M Part I section 6 (complaints; pharmacovigilance) and section 7 (7.1-7.12 recalls; AP responsible; final report with reconciliation).
- **Verification:** P (7.1-7.4 and 7.12 re-read).
- **Relation to FDA/EU:** **same** in substance as FDA 211.198 and 211.204 [gk] and EU Chapter 8 [gk]; licensing-authority notification is **different** (Indian authority).

#### IN-30 Loan-licence and contract manufacture
- **Covers:** n272
- **Edition:** both. **Type:** CONFIGURABLE (party model); ENFORCED (read-only sharing).
- **Behaviour:** A batch can belong to a loan licensee or contract giver while made on the host site; the record header carries both the host manufacturing licence number and the loan licence number (IN-31, section C); completed records can be shared read-only with the loan licensee/contract giver; the release workflow shows which party's authorised person releases, per the written contract.
- **Test:** create a loan-licence batch; both licence numbers appear and a contract-giver reviewer cannot edit.
- **Citations:** Schedule M Part I 9.1-9.5 (loan licence and contract production; 9.3.x duties of the loan licensee/contract giver).
- **Verification:** P.
- **Relation to FDA/EU:** **different**: the loan licence is an Indian legal construct (Drugs Rules Forms 25-A/28-A, S); EU Chapter 7 outsourced activities [gk] and FDA contract-manufacturing expectations [gk] cover the contract part.

#### IN-31 Finished-pack label content and coding verification
- **Covers:** n252
- **Edition:** both. **Type:** ENFORCED (per destination template); CONFIGURABLE (template contents per market).
- **Behaviour:** (a) Artwork templates are typed by destination class: India domestic (Schedule M 17.3.1 plus Drugs Rules Rules 96/97, section C), India export (Rule 94), US, EU. (b) The India-domestic template cannot be approved without fields for: drug name; active ingredients with INN and amount each, and net contents; batch number; **date of manufacture and expiry date in plain (uncoded) form**; special storage/handling; directions, warnings and precautions; name and address of the manufacturer and of the party placing the product on the market. (c) The packaging-record coding check compares every printed variable (batch, manufacturing date, expiry, MRP where applicable) against batch data at start, at intervals and at end. (d) Status labels on containers, equipment and premises follow the company format, optionally colour-coded.
- **Test:** load an India-domestic template without a manufacturing-date field; approval fails. Print an expiry one month off; the coding check fails.
- **Citations:** Schedule M Part I 17.3.1 (items (a)-(g), including expiry and manufacture date uncoded); Drugs Rules Rule 96 (S).
- **Verification:** P for Schedule M (item list re-read); S for Rule 96.
- **Relation to FDA/EU:** **stricter** than FDA (lot number and expiration date required under 21 CFR 201.17 and 211.137; no manufacturing date) [gk] and EU Directive 2001/83/EC Article 54 (expiry and batch number; no manufacturing date) [gk]. Applies to India-domestic packs; export packs follow IN-52 destination rules and Rule 94.

#### IN-32 Reference and retention samples
- **Covers:** n660
- **Edition:** both. **Type:** ENFORCED (quantity and retention date); CONFIGURABLE (company policy may lengthen).
- **Behaviour:** The packaging record creates a mandatory reference-sample pull for each finished batch, in the final pack (or an equivalent pack for very large packs), with quantity not less than twice that needed for the full test plan. The FDA allowance to leave sterility and pyrogen tests out of the doubling is not used, because the Indian condition (if confirmed) covers all tests on the batch. Starting-material samples are also retained. Retention date = maximum over the batch's markets: India expiry + 3 months (3 years from manufacture where no expiry is labelled) pending confirmation; US expiry + 1 year; EU expiry + 1 year. For US batches, an annual visual examination task is scheduled for representative reserve samples.
- **Test:** batch with markets {India, US}: sample retention = expiry + 1 year; {India}: expiry + 3 months unless company policy is longer.
- **Citations:** Schedule M Part I 19.3(g) (sufficient samples retained in final pack for an appropriate time); Drugs Rules Rules 74 and 78 conditions of licence (quantity and period, S).
- **Verification:** P for 19.3(g) (re-read); S for the Drugs Rules quantity and period.
- **Relation to FDA/EU:** period **weaker** than FDA 211.170(b)(1) (1 year after expiry) [chk] and EU Annex 19 (at least 1 year after expiry) [gk]. Quantity **same** (twice the full testing need; FDA excludes sterility and pyrogen tests) [chk]. FDA's yearly visual examination of reserve samples [chk] has no Indian counterpart (**stricter** FDA).

#### IN-33 Pharmacopoeia and edition references in specifications and limits
- **Covers:** n665
- **Edition:** both. **Type:** ENFORCED (reference field mandatory); CONFIGURABLE (edition effective dates).
- **Behaviour:** Each specification and each IPC limit in an MBR stores its source (IP, BP, Ph. Eur., USP, in-house) and edition as data. Marking a new edition effective (e.g., IP 2026 from 1 Jul 2026) lists every MBR whose limits cite the previous edition and opens a change-control task. For multi-market products, each limit shows its source and the narrower range is enforced (IN-34, IN-52). Reference standards record their source (IP reference standards from the Indian Pharmacopoeia Commission). The latest IP edition, the 1940 Act and the 1945 Rules are listed as controlled reference documents.
- **Test:** mark IP 2026 effective; all MBRs citing IP 2022 appear on the review list.
- **Citations:** Schedule M Part I PQS resources list (Act, Rules, latest IP, official guidance), 15.2 (IP reference standards from IPC), 17.3.2 (specifications revised for new pharmacopoeia editions); packaging materials to meet IP requirements.
- **Verification:** P (17.3.2 revision sentence re-read); S for the IP 2026 dates.
- **Relation to FDA/EU:** **different**: US products are held to USP-NF [gk], EU products to Ph. Eur. [gk]; the engine keeps the IP limit for Indian compliance and adds the importing market's compendial limit.

### Tablets edition

#### IN-34 Weight-variation limits by pharmacopoeia
- **Covers:** n669
- **Edition:** tablets. **Type:** CONFIGURABLE (band tables as versioned reference data); ENFORCED (tighter band for multi-market products).
- **Behaviour:** Individual-weight IPC limits are computed from the target tablet weight using a pharmacopoeia band table stored as versioned data. IP/BP/Ph. Eur. uniformity-of-mass bands as reported by secondary sources (to be confirmed against IP 2026): 80 mg or less 10%; more than 80 mg and less than 250 mg 7.5%; 250 mg or more 5%. Legacy USP in-process bands often used by US-market firms: 130 mg or less 10%; 130-324 mg 7.5%; more than 324 mg 5%. The MBR shows which table applies; for a product sold in India and the US the tighter band applies (IP is equal or tighter at every weight: e.g., 100 mg is 7.5% vs 10%; 300 mg is 5% vs 7.5%). Release testing of uniformity of dosage units (USP chapter 905 / Ph. Eur. 2.9.40 acceptance value) is a separate calculation.
- **Test:** 300 mg tablet: India or India+US gives plus/minus 5%; US-only legacy table gives 7.5%.
- **Citations:** Schedule M Part VIII 3.3-3.4, 3.8 (weight variation against pharmacopoeial parameters); Indian Pharmacopoeia uniformity-of-weight test (not seen).
- **Verification:** U (band values from secondary sources; IP 2026 wording and any adoption of the harmonised UDU chapter not confirmed).
- **Relation to FDA/EU:** **same** as Ph. Eur. 2.9.5 bands [gk]; **stricter** than the legacy USP bands for 80-130 mg and 250-324 mg tablets [gk]; **different** from current USP chapter 905, which judges content/weight uniformity by acceptance value [gk].

#### IN-35 Compression in-process controls
- **Covers:** n261
- **Edition:** tablets. **Type:** ENFORCED (30-minute ceiling for India-made batches); CONFIGURABLE (shorter intervals; frequency of the periodic parameters).
- **Behaviour:** (a) Calibrated balance status is checked at step start. (b) Start of each compression run: a sample from every station/compression point must be tested for the pharmacopoeial parameters (appearance, weight variation, disintegration, hardness, friability, thickness); the start check cannot be signed until each station has a result; on multi-point machines this station-wise check repeats at fixed intervals set in the MBR. (c) During compression an IPC timer forces a sample check against the in-process specification at intervals of at most 30 minutes; the interval may be configured shorter but never longer; a missed check raises an alarm and a deviation. (d) The same parameters plus lubricating-oil contamination are checked periodically at an MBR-defined frequency. (e) De-dusting and foreign-matter/defect checks are recorded; tablets are collected in clean, labelled containers. (f) Rejected or discarded tablets are held in identified containers and their quantity is recorded and fed into yield reconciliation.
- **Test:** run 45 minutes without an IPC entry; the alarm fires at 30 minutes. On a 16-station press the start check cannot be signed with 15 results.
- **Citations:** Schedule M Part VIII 3.3-3.8.
- **Verification:** P (3.3-3.8 re-read; see correction 5 on what the 30-minute rule covers).
- **Relation to FDA/EU:** **stricter** than FDA 211.110(a) (lists weight variation and disintegration as IPCs, no frequency) [chk] and EU 5.43 (necessary IPCs carried out and recorded, no frequency) [chk].

#### IN-36 Sifting, mixing, granulation and drying controls; sieve, punch and die checks
- **Covers:** n262
- **Edition:** tablets. **Type:** ENFORCED.
- **Behaviour:** (a) Step types for sifting, dry mixing, granulation, drying (fluid-bed/tray), blending and lubrication carry typed CPP fields with limits (time and temperature at minimum; others such as impeller speed, inlet/outlet air temperature, LOD as the MBR defines); observed values are captured. (b) Sieves/screens record ID and mesh, with an integrity check both before and after each use; punches and dies record an inspection for wear or breakage before and after each use; a failed after-use check opens a deviation covering the material processed. (c) Sieve residues are examined for foreign material at the MBR-defined frequency. (d) Fluid-bed filter bags are tracked by ID: a bag registered to another product is blocked unless a washing record exists; for products flagged highly potent or sensitising, product-dedicated bags only. (e) Metal-detector challenge records where fitted. (f) Granulation/coating solutions record preparation time and use-by limits. (g) Dry ingredients are sifted before use unless the MBR records that input quality is assured.
- **Test:** omit the after-use sieve check; the step cannot be closed. Use an FBD bag from another product without a wash record; blocked.
- **Citations:** Schedule M Part VIII 1.3-1.4 (metal detector recommended; wooden equipment avoided; screens, sieves, punches and dies checked before and after each use; sifting), 2.1-2.5 (dust extraction; sieve residues; CPPs in master formula and batch record; FBD bags; solutions).
- **Verification:** P (1.3-1.4 and 2.1-2.5 re-read).
- **Relation to FDA/EU:** **stricter/more prescriptive** than FDA 211.63-211.67 [gk] and EU Chapter 3/5 [gk], which do not name before-and-after checks of sieves, punches and dies or FBD bag rules.

#### IN-37 Coating, capsule shells and printing of tablets/capsules
- **Covers:** n263, n676
- **Edition:** tablets. **Type:** ENFORCED.
- **Behaviour:** Coating steps record solution/suspension preparation time and a use-by limit (freshly prepared; use after the limit is blocked), spray and air parameters, and room temperature/RH. Empty capsule shells are handled as a component lot with storage-condition checks. After printing of tablets or capsules, a QC approval of the printed bulk is a hard gate before packaging or sale; simultaneous printing of different products/batches requires a segregation record.
- **Test:** open a packaging order for printed tablets without the QC approval; refused.
- **Citations:** Schedule M Part VIII 4.1-4.2, 5, 6.1-6.2; Part I 14.29-14.31.
- **Verification:** P (4.1-4.2, 5, 6.1-6.2 re-read).
- **Relation to FDA/EU:** the post-printing QC approval gate is **stricter** (no FDA/EU counterpart) [chk: not in 211 or EU Ch.5]; coating controls **same** in intent as FDA 211.113(a) [chk].

#### IN-38 Strip and blister packaging
- **Covers:** n264
- **Edition:** tablets. **Type:** ENFORCED; CONFIGURABLE (leak-test frequency and sample size).
- **Behaviour:** (a) Before a new batch, the counting/strip/blister equipment clearance (removal of rogue tablets, capsules, foils) is performed by one user and independently verified by a different user; both signatures are recorded. (b) Strip/blister IPC records defect categories (misprint, foil cut, missing tablet, poor sealing). (c) A periodic vacuum leak test of pockets is a scheduled IPC with frequency, sample size and pass/fail; a missed test flags the record. (d) Products flagged uncoated, potent or beta-lactam are only schedulable on eligible lines; potent and beta-lactam packing only in isolated areas.
- **Test:** one user signs both "performed" and "verified" for blister clearance; refused. Skip the scheduled leak test; the record flags a missed IPC.
- **Citations:** Schedule M Part VIII 7.1-7.4.
- **Verification:** P (7.1-7.4 re-read).
- **Relation to FDA/EU:** **stricter** than FDA 211.130(e) and 211.188(b)(6) (inspection of the area before and after use documented; no explicit independent-check requirement for the clearance) [chk] and EU 5.50 (line clearance by checklist) [chk]; periodic pocket leak testing is not named in either [chk].

#### IN-39 OSD room environment: pressure differentials, temperature and humidity
- **Covers:** n265, n677
- **Edition:** tablets. **Type:** ENFORCED (limit checks); CONFIGURABLE (room limits).
- **Behaviour:** Each step records room ID and captures differential pressure, temperature and RH at start and during long steps (manual entry or BMS/EMS import) against room-specific alert and action limits. The room master data validator refuses pressure ranges of adjacent rooms that overlap (e.g., 5-15 Pa next to 15-30 Pa is rejected). An excursion notifies Production and QA immediately and links to the batch as a deviation. Moisture-sensitive products may carry tighter product-specific RH limits.
- **Test:** enter a differential pressure below the action limit at compression start; the step is blocked or a deviation opens and both departments are notified.
- **Citations:** Schedule M Part VIII 1.5, 1.14 (non-overlapping limits, 5-15 Pa vs 15-30 Pa example), 1.17, 1.25, 1.27-1.28.
- **Verification:** P for 1.5 and 1.14 (re-read); P~ for the others.
- **Relation to FDA/EU:** **stricter/more prescriptive** than FDA 211.46 [gk] and EU Chapter 3 [gk] (no numeric cascade rules for non-sterile products).

### Injectables edition

#### IN-40 Clean-area grades, particle limits and airflow
- **Covers:** n253, n671
- **Edition:** injectables. **Type:** ENFORCED (market-resolved limit table); CONFIGURABLE (alert limits, locations).
- **Behaviour:** (a) Room/zone master data carry grade A-D and a market-keyed limit table. India table (maximum particles per m3, 0.5 / 5.0 micrometre): Grade A 3,520 / 20 at rest and in operation; Grade B 3,520 / 29 at rest, 352,000 / 2,900 in operation; Grade C 352,000 / 2,900 at rest, 3,520,000 / 29,000 in operation; Grade D 3,520,000 / 29,000 at rest, in operation not defined. (b) Imported EM counts for the batch's processing window are checked against the resolved limits (section B row B-13). (c) Grade A unidirectional airflow records: velocity at 15-30 cm below the terminal filter within 0.36-0.54 m/s (guidance) and a hard minimum of 0.36 m/s at working level; readings below 0.36 m/s at working level are flagged. (d) Clean-up (recovery) time after operations: about 15-20 minutes (guidance) with a 100-fold reduction demonstrated; stored per room from qualification. (e) Classification sampling data: at least 1 m3 per location in Grade A; for the lower grades (C while operating, D while at rest) at least 2 litres sampled for no less than 1 minute per location. Classification results are kept separate from routine monitoring.
- **Test:** import a Grade B in-operation 5.0 micrometre count of 2,910/m3: it exceeds the India limit (2,900) and therefore fails for every profile, although it would pass the EU-only value (2,930).
- **Citations:** Schedule M Part II 4.1-4.6 and Table 1; 4.6.2-4.6.3 (sampling volumes, portable counters, isokinetic heads); 4.7.5 (clean-up period).
- **Verification:** P (Table 1 cells reassembled from scattered lines; values consistent with WHO TRS 961 Annex 6 and the stated ISO 4.8 classification for Grade A).
- **Relation to FDA/EU:** 0.5 micrometre values **same** as EU Annex 1 (2022) Tables 1 and 5 [chk] and FDA 2004 Table 1 (ISO 5: 3,520; ISO 7: 352,000; ISO 8: 3,520,000, measured during activity) [chk]. 5.0 micrometre values **stricter (lower)** than EU 2022 (Table 5 monitoring: Grade A 29; B 29 at rest / 2,930 in operation; C 2,930 / 29,300; D 29,300; Table 1 classification: Grade A not specified) [chk]; FDA sets no 5.0 micrometre limit [chk]. EU 2022 is **stricter on monitoring method**: Grade A monitored continuously for both sizes at no less than 28 L/min (9.17) and consecutive low-level 5 micrometre counts investigated (Table 5 note 2) [chk]; EU Grade D in-operation limits must be set by the site from risk assessment [chk]. Airflow: EU 0.36-0.54 m/s at the working position (guidance) [chk]; India adds the hard 0.36 m/s minimum at working level (**stricter**). Clean-up: EU under 20 minutes guidance [chk] (**same**).

#### IN-41 Minimum grade per sterile operation
- **Covers:** n675
- **Edition:** injectables. **Type:** ENFORCED.
- **Behaviour:** Each injectables MBR step type carries a required minimum grade and background grade derived from process type and product risk flags; the MBR validator rejects a step mapped to a lower-grade room; execution checks the room's current status and EM state. Terminally sterilised: filling at least Grade C; Grade A with at least Grade C background when the product is unusually at risk (slow filling, wide-necked containers, exposure for more than a few seconds); solutions and components prepared at least in Grade D (Grade C when at unusual microbial risk); ointments, creams, suspensions and emulsions prepared and filled in Grade C before terminal sterilisation. Aseptic: components after washing at least Grade D; sterile materials not later sterilised or filtered handled in Grade A with Grade B background; solutions to be sterile-filtered prepared in Grade C (D if closed system); aseptic handling/filling in A with B background; partially stoppered lyophilisation containers moved in A/B or in sealed trays in B; exposed sterile semi-solids/suspensions not later filtered made in A/B.
- **Test:** map an aseptic filling step to a Grade C room; MBR validation fails.
- **Citations:** Schedule M Part II 1.1-1.3, 4.11, 4.11.1-4.11.2 (and Table 2 examples).
- **Verification:** P (4.11.1 and 4.11.2 fragments re-read).
- **Relation to FDA/EU:** **same** in structure as EU Annex 1 (2022) Tables 3 and 4 [chk] and FDA 2004 (ISO 5 critical area with ISO 7 supporting area) [chk]; EU 2022 adds a contamination control strategy overlay [chk].

#### IN-42 Environmental monitoring data in the batch record and microbial limits
- **Covers:** n254
- **Edition:** injectables. **Type:** ENFORCED (release gate, limit check); CONFIGURABLE (alert limits, locations).
- **Behaviour:** (a) The batch record links the EM data for its processing window: continuous Grade A particle counts for the full critical processing including equipment assembly (capturing interventions and transients, alarming at alert limits), Grade B monitoring, and viable results (settle plates, active air, contact plates, glove prints, swabs) per location and session. (b) Release is blocked until all EM results for the filling window are complete (no plate still incubating) and reviewed, and every excursion is investigated. (c) Each viable result is evaluated individually against the resolved action limit (design choice: the Indian table gives averages, but averaging must not hide a single Grade A recovery). India values (CFU; air per m3 / settle plate 90 mm per 4 h / contact 55 mm / 5-finger glove): Grade A under 1 for all four; Grade B 10 / 5 / 5 / 5; Grade C 100 / 50 / 25 / not set; Grade D 200 / 100 / 50 / not set. (d) Alert and action limits must be configured for every location; exceeding an action limit or an adverse alert trend opens an investigation with CAPA.
- **Test:** record a Grade A settle plate of 1 CFU during a fill; an excursion is raised for every profile and release is blocked until the investigation closes.
- **Citations:** Schedule M Part II 4.7-4.10 and Table 3 (values stated to be averages and for information, not specifications); 4.8 (EM results considered in batch release review).
- **Verification:** P (Table 3 cells reassembled from scattered lines; the "average values" and "for information only" notes re-read).
- **Relation to FDA/EU:** Grades B-D numbers **same** as EU Annex 1 (2022) Table 6 [chk]; EU is **stricter** because its values are maximum action limits and Grade A is "no growth", with any Grade A growth investigated [chk]. FDA 2004: ISO 5 action level 1 CFU/m3 active air and 1 CFU settle plate (settle plates optional); ISO 5 samples should normally yield no contaminants; averaging can mask localized excursions [chk]; broadly **same** as India at Grade A.

#### IN-43 HEPA filter leak-test interval
- **Covers:** n671
- **Edition:** injectables. **Type:** ENFORCED (block when overdue); CONFIGURABLE (warning threshold).
- **Behaviour:** Room/HEPA master data hold last and next installed-filter leak-test dates; the test aerosol must be non-nutritive. A batch cannot start in a room whose HEPA test is overdue under the resolved interval (section B row B-16); a warning appears at the recommended interval.
- **Test:** India-only profile, Grade B room tested 13 months ago: batch start blocked; tested 7 months ago: warning only. India+EU profile, same 7-month case: blocked.
- **Citations:** Schedule M Part II 4.5 (ISO leak test, recommended every 6 months, not exceeding 12 months).
- **Verification:** P (4.5 re-read).
- **Relation to FDA/EU:** **weaker** for Grade A/B than EU Annex 1 (2022) 4.32 (requalification including integrity test of final filters at most every 6 months for A/B; 12 months for C/D) [chk] and FDA 2004 (leak tests twice yearly in the aseptic processing room) [chk]; **same** as EU for C/D (12 months).

#### IN-44 Clean-area sanitation, disinfectants and water monitoring
- **Covers:** n670
- **Edition:** injectables. **Type:** ENFORCED; CONFIGURABLE (agents, rotation).
- **Behaviour:** Cleaning/disinfection records for Grade A-D rooms record agent, lot, dilution preparation time and use-by, sterility status for Grade A/B use, and the rotation (at least two agent types, including a sporicidal agent). A dilution past its defined storage period, or a non-sterile agent in Grade A/B, is rejected. The batch record links the cleaning events covering its window. Water results (WFI endotoxin, microbial, chemical) for the points used by the batch are visible at release relative to batch dates.
- **Test:** record use of a dilution past its storage period; refused.
- **Citations:** Schedule M Part II 3.1-3.4 (more than one type of disinfectant; sporicidal agent; residue removal validated; sterile agents for A/B), 5.9 (water monitoring and records).
- **Verification:** P (3.1-3.3 and 5.9 re-read).
- **Relation to FDA/EU:** **same** as EU Annex 1 (2022) 4.33 (more than one agent type; periodic sporicidal use) [chk] and FDA 211.67/211.113(b) expectations [gk].

#### IN-45 Aseptic process simulation (media fill) envelope and acceptance
- **Covers:** n255
- **Edition:** injectables. **Type:** ENFORCED (envelope checks; resolved acceptance); CONFIGURABLE (requalification interval where the resolved rule allows).
- **Behaviour:** (a) Each aseptic line holds its qualified APS envelope: maximum fill duration, processing hold times, intervention types simulated, shifts, operators, container sizes. A batch whose duration, interventions, shift or operators fall outside the last successful APS is flagged and needs a deviation. (b) Initial qualification requires three consecutive successful runs; requalification at the resolved interval and after significant HVAC, equipment or process changes; each shift and shift changeover represented; for small batches the units filled are at least the batch size. (c) Acceptance resolved per profile (section B row B-10). India/FDA rule: fewer than 5,000 units, no contaminated unit; 5,000-10,000 units, one unit means investigation including a possible repeat, two mean revalidation after investigation; more than 10,000 units, one means investigation, two mean revalidation after investigation; intermittent contamination at any size is investigated. (d) A failed APS lists every batch filled on that line since the last successful APS for impact assessment.
- **Test:** India+EU profile with one contaminated unit in 12,000: recorded as a failed APS. Mark an APS failed; all batches since the previous pass are listed.
- **Citations:** Schedule M Part II 5.3-5.7; 4.11 (media fills set hold times and maximum fill duration).
- **Verification:** P (5.3-5.7 re-read).
- **Relation to FDA/EU:** acceptance **same** as FDA 2004 (plus FDA: under 5,000 units, one contaminated unit is cause for revalidation after investigation) [chk]; **weaker** than EU Annex 1 (2022) 9.46 (any contaminated unit is a failed APS, normally three successful repeats) [chk]. Frequency: India only "defined intervals"; FDA 2004 semi-annual per line and each authorised person at least yearly [chk]; EU 9.38 twice a year per process, line and shift, and each operator at least one successful APS per year [chk] (both **stricter**).

#### IN-46 Processing time limits, bioburden and endotoxin
- **Covers:** n256
- **Edition:** injectables. **Type:** ENFORCED.
- **Behaviour:** The injectables MBR carries timers with product-specific maxima and hard alarms: washing/drying to sterilisation and sterilisation to use of components, containers and equipment; start of solution preparation to sterilisation or sterile filtration; (EU profile adds) start of preparation to end of aseptic filling, sterilised product hold before filling, aseptic processing time and filling time. Processing stage of components and equipment is identified. A pre-sterilisation bioburden sample is mandatory for every batch (aseptic and terminally sterilised), with result entry against working limits; scheduled intervals are allowed only for products flagged overkill-terminal; for parametric release it is an IPC on every batch. Purge/blanket gas steps require a sterilising-filter reference. Endotoxin steps on WFI, intermediates and finished product; for LVPs the water/intermediate endotoxin step cannot be removed from the MBR.
- **Test:** let the preparation-to-filtration timer exceed its maximum; a deviation is forced. Close a batch without a bioburden result; blocked.
- **Citations:** Schedule M Part II 5.12-5.17, 2.4.
- **Verification:** P (5.12-5.16 and 2.4 re-read).
- **Relation to FDA/EU:** **same** core as EU Annex 1 (2022) 8.18 and 8.93 (bioburden immediately before final sterile filtration; before the first filter where redundant) [chk] and FDA 211.110(a)(6) and 211.113(b) [chk]; EU 8.18 is **stricter**: it limits more intervals, including preparation start through to the end of aseptic filling, and the filling time itself [chk].

#### IN-47 Sterilisation cycle records and revalidation
- **Covers:** n257
- **Edition:** injectables. **Type:** ENFORCED.
- **Behaviour:** Steriliser/autoclave/tunnel/EO/irradiation interfaces import each cycle into the batch record (cycle ID, validated load pattern selected from a list, trace, coolest-point temperature with independent second probe where fitted, pressure, F0 where used, alarms; for EO also time, pressure, temperature, humidity, gas concentration and biological indicators; for irradiation dosimeter results). A reviewer signs each cycle before batch release, and cycle faults must be dispositioned. A steriliser whose revalidation (at least yearly and after significant change) or chamber leak test is overdue cannot be selected. Carrier labels (basket, tray) print material name, batch number and sterilised/not-sterilised status. Cooling fluid in contact with product must be recorded as sterile.
- **Test:** select a steriliser whose annual revalidation lapsed; blocked. Import a cycle with an alarm; release is blocked until the alarm is dispositioned.
- **Citations:** Schedule M Part II 6.3-6.11 (6.5 at least annual verification; 6.8 carrier labelling; 6.10 records approved in batch release; 6.11.1 heat sterilisation recording and faults; chamber leak tests).
- **Verification:** P (6.3-6.11.1.4 re-read).
- **Relation to FDA/EU:** yearly revalidation of every process is **stricter** than EU Annex 1 (2022) 8.39 (at least yearly for worst-case load patterns; others per CCS) [chk] and FDA (periodic) [gk]; chamber leak testing **weaker** than EU 8.60 (normally weekly when a vacuum phase is used) [chk], where India only says "regular".

#### IN-48 Sterile filtration
- **Covers:** n258
- **Edition:** injectables. **Type:** ENFORCED.
- **Behaviour:** The filtration step records filter ID/lot and pore rating (0.22 micrometre or equivalent), pre-use integrity result (after sterilisation for EU-profile batches), post-use integrity result (instrument import where possible), filtration start/stop time and differential pressure against validated ranges (outside range forces an investigation note), post-use integrity of critical vent filters, and the product hold time from end of compounding to filling. A failed integrity test puts the batch on hold with a deviation. A filter ID cannot be used beyond one working day unless flagged as validated for extended use; for EU-profile batches a liquid sterilising filter is also limited to a single batch. Filtration is refused as the sole method for a product flagged as terminally sterilisable.
- **Test:** enter a failing post-use result; the batch goes on hold. Reuse a filter on day 2 without validation; blocked. EU profile, same filter for a second batch on day 1: blocked.
- **Citations:** Schedule M Part II 6.11.2 (6.11.2.4-6.11.2.9).
- **Verification:** P (6.11.2.5-6.11.2.8 re-read).
- **Relation to FDA/EU:** pre-use testing **stricter** than FDA 2004 (pre-use test may be performed; post-use testing routine) [chk]; **weaker** than EU Annex 1 (2022) 8.87 (pre-use post-sterilisation integrity test unless justified by risk; post-use before removal from housing) [chk] and 8.94 (single batch and at most one working day) [chk].

#### IN-49 Sterility-test sampling and release review
- **Covers:** n259
- **Edition:** injectables. **Type:** ENFORCED.
- **Behaviour:** The record marks mandatory sterility-sample pulls: first and last units of an aseptic fill and after every significant interruption (logging an interruption automatically adds a pull after restart); for heat-sterilised loads, units from the potentially coolest position. The release review screen presents processing record, EM data (aseptic) and sterility result together and requires each to be opened and acknowledged. Parametric release mode is available only when the product licence permits it.
- **Test:** log a significant stoppage; a sterility pull after restart becomes mandatory.
- **Citations:** Schedule M Part II 2.1-2.3; 4.8.
- **Verification:** P (2.1-2.3 re-read).
- **Relation to FDA/EU:** **same** as EU Annex 1 (2022) sterility sampling expectations [gk] and FDA 211.167(a) / 2004 guidance [gk].

#### IN-50 Capping, vacuum-sealed containers and 100% inspection
- **Covers:** n260
- **Edition:** injectables. **Type:** ENFORCED; CONFIGURABLE (break interval, challenge frequency).
- **Behaviour:** (a) Capping records the station (separate, with extraction), confirms Grade A air supply to vials until crimped when capping is outside the aseptic core, and counts vials rejected for missing/displaced stoppers before capping. (b) Vacuum-sealed containers get a vacuum-hold test after a predetermined period. (c) 100% inspection step records inspector identity, booth lighting/background check, start/stop times with enforced breaks, quantities inspected and rejects by defect category. (d) Sign-on is refused if the inspector's eyesight check (with their own corrective lenses) or inspection qualification has lapsed; EU-profile batches require inspection qualification renewed at least yearly. (e) Automated inspection machines: validation reference and challenge-set results at start and at intervals; a missed challenge flags the lot.
- **Test:** assign an inspector with an expired eye check; sign-on refused.
- **Citations:** Schedule M Part II 10.3-10.8; Part I 11.5.1 (periodic eye checks for visual inspectors).
- **Verification:** P (10.3-10.5, 10.7, 10.8 re-read). Part II 10.1-10.2 (closure integrity) not found in the uploaded copy (gap F-7).
- **Relation to FDA/EU:** **weaker** than EU Annex 1 (2022) 8.31-8.33 (inspector qualification at least yearly using defect libraries; automated systems challenged before start-up and at intervals; defect trending) [chk]; EU 8.22 (100% integrity testing of fusion-sealed containers of 100 ml or less) [chk] has no verified Indian counterpart. FDA: 21 CFR 211 has no inspector-qualification clause [chk]; FDA expects 100% visual inspection of injectables under USP chapters 790/1790 [gk].

#### IN-51 Part XIII area and equipment classes for parenterals
- **Covers:** n664
- **Edition:** injectables. **Type:** CONFIGURABLE (master data shipped as defaults).
- **Behaviour:** The Injectables edition ships area types (water management, container/closure preparation, solution preparation, filling/capping/sealing, sterilisation, quarantine, visual inspection, packaging; separate FFS/BFS set) and equipment classes (RO/EDI plus multi-column distillation, SS 316L tank and circulating loop, washers, double-ended dryer/steriliser, filtration, filling under laminar flow, steam and hot-air sterilisers, pressure leak tester, visual inspection units with white and black backgrounds, batch coding and labelling). Leak-test steps may only reference the pressure-leak-tester class; each water draw records the WFI loop/point of use. Recommended minimum areas (SVI 150 m2 basic plus 100 m2 ancillary; LVP 150 m2 each; LVP packaging materials 100 m2; FFS LVP 250 m2 plus 150 m2) are stored as site-profile information, not enforced.
- **Test:** build an SVI MBR using only shipped classes; every needed area type exists.
- **Citations:** Schedule M Part XIII (parenteral preparations section; FFS section).
- **Verification:** P (area figures re-read; equipment list fragmentary in the uploaded copy).
- **Relation to FDA/EU:** **different**: no FDA or EU counterpart to prescriptive minimum areas and equipment lists [chk: not in 211 or Annex 1].

### Kernel rule engine

#### IN-52 Market-profile rule resolution
- **Covers:** n678
- **Edition:** both. **Type:** ENFORCED.
- **Behaviour:** Each batch carries its target markets (India domestic; export country list), and each pack/SKU carries its destination class. A versioned, market-keyed rule table is consulted at MBR approval, batch start, execution, release, sample retention and archiving. For each parameter the engine resolves the strictest value across India (always) and the batch's markets, stores the resolved value and the market that drove it in the batch record, and re-resolves if the market list changes before release (which forces QA review). Section B lists the resolved values. Resolution never loosens an Indian requirement for an export-only batch, because Indian GMP applies to everything made under the licence.
- **Test:** set up one tablet and one injectable product, each with a batch for {India} and a batch for {India, US, EU}. The {India, US, EU} batches resolve to: retention max(expiry + 1 y, mfg + 5 y, QP certification + 5 y); reference samples expiry + 1 y; annual self-inspection; new number on rework; identity test per excipient lot; plus, for the tablet, the 30-minute compression IPC and IP weight bands; and, for the injectable, any contaminated APS unit fails, Grade A viable no growth, PUPSIT and a single-batch sterilising filter. The resolution log names the governing market for each value.
- **Citations:** Schedule M (all Parts cited above); Drugs Rules; 21 CFR 211; EU GMP Chapters 4-5, Annexes 1 and 11.
- **Verification:** P for Indian values marked P elsewhere; U where the underlying control is S/U (IN-08, IN-32, IN-34).
- **Relation to FDA/EU:** **different** (cross-cutting mechanism); implements "stricter rule wins".

---

## B. Market-profile resolution table

How to read: "India" is always present because every batch is made under an Indian licence; columns show the value the engine (IN-52) applies. "India + US" means the batch serves the US market (with or without Indian domestic sale); an export-only batch for the US resolves like "India + US" for GMP rows. Label rows (B-15 and section C) resolve per pack destination: an India-domestic pack follows Rules 96/97, an export pack follows Rule 94 plus the importing market's rules. Status keys as in the header.

| # | Topic | India only | India + US | India + EU | India + US + EU | Basis and status |
|---|---|---|---|---|---|---|
| B-01 | Batch record retention (IN-08) | Longest of expiry + 1 y and mfg + 5 y (Rule 74); Form 28 test records per Rule 78 variant | Same as India only (FDA expiry + 1 y is not longer) | Longest of India value and QP certification + 5 y | Longest of India value and QP certification + 5 y | Schedule M 17.2 (P~); Rules 74/78 (U); 211.180(a) [chk]; EU 4.11 [chk]. If counsel does not confirm the Rule 74/78 periods, India only falls back to expiry + 1 y |
| B-02 | Reference/retention samples (IN-32) | Expiry + 3 months (3 y from mfg if no expiry); 2x all tests; final pack | Expiry + 1 y; 2x all tests; yearly visual check of representative samples | Expiry + 1 y; 2x all tests | Expiry + 1 y; 2x all tests; yearly visual check | Schedule M 19.3(g) (P); Rules 74/78 (S); 211.170(b) [chk]; EU Annex 19 [gk] |
| B-03 | Compression IPC frequency (IN-35) | Sample vs IPC spec at most every 30 min; station-wise check at run start (and fixed intervals on multi-point presses); other parameters periodically per MBR | Same | Same | Same | Part VIII 3.4, 3.8 (P); FDA 211.110(a) and EU 5.43 set no frequency [chk] |
| B-04 | Sieve, screen, punch and die checks (IN-36) | Before and after each use | Same | Same | Same | Part VIII 1.3 (P) |
| B-05 | Strip/blister line (IN-38) | Independent second-person recorded equipment check before each batch; periodic pocket vacuum leak test | Same | Same | Same | Part VIII 7.1, 7.4 (P) |
| B-06 | Hold times in master and batch record (IN-13, IN-15) | Mandatory for every intermediate and in-process material; actual hold recorded | Same | Same, plus EU aseptic timers (preparation start to end of filling; filling time) for injectables | Same as India + EU | Part I 17.3.6, 17.3.8 (P); 211.111 [chk]; EU 4.17-4.20 and Annex 1 8.18 [chk] |
| B-07 | Reworked batch number (IN-18) | New batch number | Same | Same | Same | Part I 14.32 (P) |
| B-08 | Self-inspection frequency (IN-28) | At least once a year | Same | Same | Same | Part I 10.4 (P) |
| B-09 | Excipient (non-API) release (IN-24) | Identity test per lot by default; vendor-history route of 14.15 allowed if QA enables it with statistical justification | Identity test on each lot (supplier CoA only with own identity test and periodic verification) | Identity test on each batch; identity sampling per container unless a validated reduced procedure applies | As India + US and India + EU combined | Part I 14.15, 19.7.1 (P; 19.7.2 truncated); 211.84(d) [chk]; EU 5.35 [chk], Annex 8 [gk] |
| B-10 | Media-fill (APS) acceptance (IN-45) | Under 5,000 units: none; 5,000-10,000: 1 = investigate (consider repeat), 2 = revalidate; over 10,000: 1 = investigate, 2 = revalidate | As India, and under 5,000 units one positive = revalidation after investigation | Any contaminated unit = failed APS; root cause, CAPA, normally 3 repeat APS, review of batches since last pass | As India + EU | Part II 5.6-5.7 (P); FDA 2004 [chk]; EU Annex 1 9.46 [chk] |
| B-11 | Media-fill frequency (IN-45) | Site-defined interval must be configured (recommended default 6 months) and after significant change | Every 6 months per line incl. all shifts; each authorised person yearly | Every 6 months per process, line and shift; each operator one successful APS yearly | As India + EU | Part II 5.5 (P); FDA 2004 [chk]; EU 9.38 [chk] |
| B-12 | Grade A viable limits; status of B-D values (IN-42) | Grade A under 1 CFU (air per m3, settle, contact, glove), evaluated per sample by design; B-D per Table 3; site sets alert/action limits no looser | Same; any Grade A recovery is an excursion (FDA ISO 5 action level 1 CFU) | Grade A no growth, any growth investigated; B-D values are maximum action limits; A/B settle plates exposed for the whole operation, changed at most every 4 h | As India + EU | Part II Table 3 (P, stated as averages and informative); FDA 2004 Table 1 [chk]; EU Table 6 [chk] |
| B-13 | Non-viable particle limits (IN-40) | India Table 1 (0.5 / 5.0 micrometre: A 3,520/20; B 3,520/29 rest, 352,000/2,900 op; C 352,000/2,900 rest, 3,520,000/29,000 op; D 3,520,000/29,000 rest) | India table (FDA 0.5 micrometre values identical; no FDA 5 micrometre limit) | India numeric limits (lower 5 micrometre values) plus EU monitoring rules: continuous Grade A for both sizes at 28 L/min or more, investigation of repeated low 5 micrometre counts, site-set Grade D in-operation limits | As India + EU | Part II Table 1 (P); FDA 2004 [chk]; EU Tables 1, 5 and 9.17 [chk] |
| B-14 | Tablet weight-variation IPC bands (IN-34) | IP bands (80 mg or less 10%; over 80 to under 250 mg 7.5%; 250 mg or more 5%) | IP bands (tighter than legacy USP bands at every weight); release UDU per USP chapter 905 as registered | IP bands (= Ph. Eur. 2.9.5); release per Ph. Eur. 2.9.40 as registered | IP bands; both release tests as registered | IP values (U); USP/Ph. Eur. [gk] |
| B-15 | Date of manufacture on label (IN-31) | India-domestic pack: mandatory, uncoded, verified in coding check | Domestic packs as India; US packs: not required by FDA | Domestic packs as India; EU packs: not required by EU | Per pack destination as in the other columns | Schedule M 17.3.1(d) (P); Rule 96 (S); 21 CFR 201.17 and Dir. 2001/83 Art. 54 [gk]; Rule 94 export particulars (U) |
| B-16 | HEPA leak-test interval (IN-43) | Block beyond 12 months; warn beyond 6 months | Aseptic processing rooms (A/B): 6 months; others 12 months | A/B: 6 months; C/D: 12 months | A/B: 6 months; C/D: 12 months | Part II 4.5 (P); FDA 2004 [chk]; EU 4.32 [chk] |
| B-17 | Sterilising-filter integrity and use (IN-48) | Integrity before use and right after use; one working day maximum unless validated | Same as India (stricter than FDA) | Pre-use test after sterilisation (PUPSIT) unless risk-justified; post-use test before removal; single batch and one working day maximum unless validated | As India + EU | Part II 6.11.2.7-6.11.2.8 (P); FDA 2004 [chk]; EU 8.87, 8.94 [chk] |
| B-18 | Sterilisation revalidation; chamber leak test (IN-47) | Every process at least yearly and after significant change; chamber leak test regularly (SOP interval) | Same | Same yearly rule; chamber leak test normally weekly where a vacuum phase is used | As India + EU | Part II 6.5, 6.11.1.4 (P); EU 8.39, 8.60 [chk] |
| B-19 | Visual-inspector qualification (IN-50) | Regular eyesight checks (interval configured; recommended yearly); frequent breaks | Same | Inspection qualification at least yearly with defect library, eyesight considered; breaks; automated inspection challenged at start and intervals | As India + EU | Part II 10.8, Part I 11.5.1 (P); EU 8.31-8.33 [chk] |
| B-20 | Master record approval (IN-06) | Two-person (prepare + independent check) by design | Two-person mandatory | Two-person by design | Two-person | Part I 17.2 (P~); 211.186(a) [chk] |
| B-21 | Reason for any data change (IN-06) | Mandatory by design ("where appropriate" in Schedule M) | Mandatory | Mandatory | Mandatory | Part I 17.2 (P~); EU 4.9, Annex 11 section 9 [chk] |
| B-22 | Audit-trail review (IN-09) | Part of batch review by design (not in Schedule M) | Part of batch record review before release | Regular review; part of batch review | Part of batch review | Annex 11 section 9 [chk]; FDA DI Q&A 2018 Q7-Q8 [chk] |
| B-23 | Batch release authority (IN-05) | Authorised person, with head-of-QC approval | AP release that also meets 211.192 quality-unit review of all production and packaging records | Indian AP release; EU QP certification at the EU site (system supplies the batch package) | Both | Schedule M section 1, 11.3.6-11.3.10 (P); 211.22, 211.192 [chk]; Annex 11 section 15 [chk], Annex 16 [gk] |
| B-24 | Management review | At least yearly | Same | Same | Same | Part I 1.6 (P) |
| B-25 | Grade A airflow (IN-40) | 0.36-0.54 m/s at 15-30 cm below the terminal filter; never below 0.36 m/s at working level | Same | India positions plus 0.36-0.54 m/s at the working position (EU) | As India + EU | Part II 4.3 Grade A text (P); EU Annex 1 airflow guidance [chk] |
| B-26 | Sample-retention quantity basis | Twice all tests, including sterility | Same (the Indian rule, if confirmed, leaves no room for the FDA sterility/pyrogen exclusion) | Same | Same | Rules 74/78 (S); 211.170(b) [chk] |

---

## C. India-specific fields

Fields the Indian layer adds to the kernel data model. "Record" = where the field lives; "Check" = what the system verifies. Status keys as in the header.

### C.1 Batch manufacturing record (header and body)

| Field | Record / check | Legal basis | Status |
|---|---|---|---|
| Manufacturing licence number and licence form (Form 25 for drugs outside Schedules C/C(1), which covers most tablets; Form 28 for Schedule C/C(1) drugs, where parenterals fall, and a tablet too if its drug is listed in C(1); Form 28-D reported for LVPs, sera and vaccines) | BMR/BPR header, from site master data; drives which conditions of licence (Rule 74 or Rule 78) feed retention (IN-08) | Drugs Rules licence rules and Schedule A forms; Rules 74 and 78 | S (form mapping U, see G-10) |
| Loan licence number (Form 25-A / 28-A) plus the host facility's licence number | BMR/BPR header for loan-licence batches; both numbers printed (IN-30) | Schedule M Part I section 9; Drugs Rules loan-licence forms | P for section 9; S for forms |
| Approved technical staff (manufacture and testing) with licensing-authority approval reference and date | Register; gates supervisory and QC approval signatures (IN-04) | Drugs Rules Rules 71 and 76; Schedule M Part I 11.3.2 | S / P |
| Schedule U particulars: batch size; dates of start and completion; each raw material with quantity and analytical report (control) number; finished-product analytical report number; actual production and packing quantities; date of release for distribution or sale | BMR fields (ARN per dispensed lot; release date written by the release workflow) | Drugs Rules Rule 74 (and 78) with Schedule U | S |
| Permitted hold time per intermediate and actual hold start/stop | MBR and BMR (IN-13, IN-15) | Schedule M Part I 17.3.6, 17.3.8 | P |
| Person responsible for each production stage; dated completion signature of the person responsible for processing | BMR (IN-15) | Schedule M Part I 17.3.8 | P |
| Batch-number allocation entry (allocation date, product, batch size); link between processing and packaging numbers | Allocation register (IN-18) | Schedule M Part I 17.3.10.8-17.3.10.11 | P~ |
| Pharmacopoeia and edition behind every specification/IPC limit (e.g., IP 2026) | MBR limit metadata (IN-33) | Schedule M Part I 17.3.2 | P |
| Target markets and export destinations | BMR header; input to rule resolution (IN-52) | Design (needed to apply stricter-rule-wins) | n/a |
| Marketer name and address and marketer-manufacturer agreement reference, where a marketer sells the product | Product master and BMR header; also on label | Drugs Rules Rules 84D and 84E (2020 amendment); Rule 96 | S |
| Tablets: compression IPC entries at no more than 30-minute intervals; station-wise start-of-run results; sieve/screen/punch/die checks before and after use; FBD bag ID; rejected-tablet quantity; QC approval of printed tablets/capsules | BMR (IN-35 to IN-37) | Schedule M Part VIII 1.3, 2.4, 3.4, 3.7-3.8, 6.2 | P |
| Injectables: inspector eye-check validity at sign-on; APS envelope reference; filter integrity results; approved sterilisation cycles; EM summary for the processing window; bioburden result | BMR (IN-42 to IN-50) | Schedule M Part II 2.3, 4.8, 5.16, 6.10, 6.11.2.7, 10.8; Part I 11.5.1 | P |

### C.2 Batch packaging record

| Field | Record / check | Legal basis | Status |
|---|---|---|---|
| Coded variables: batch number with an allowed prefix (e.g., "Batch No.", "B. No.", "Lot No."), manufacturing date and expiry date in plain form | Coding verification at start, intervals and end against batch data (IN-22, IN-31) | Schedule M Part I 17.3.1; Drugs Rules Rule 96 | P / S |
| MRP value used for the run (inclusive of all taxes) | Overprint verified, coded packs reconciled; value traceable to the approved price for the period | Drugs (Prices Control) Order 2013; Legal Metrology (Packaged Commodities) Rules 2011 exemption for DPCO formulations | S |
| Schedule H2 QR/barcode: payload generated from batch master data (unique product identification code, proper and generic name, brand name, manufacturer name and address, batch number, manufacturing date, expiry date, manufacturing licence number; from the 2026 amendment reportedly excipient details where applicable) and reader verification results | Code generation step plus reader challenge and per-pack or sampled verification; on primary pack label (secondary if space is insufficient) | Drugs Rules Rule 96 and Schedule H2 (G.S.R. 823(E) of 17 Nov 2022; G.S.R. 506(E) of 22 Jun 2026) | S (2026 data elements U, see G-6) |
| Export pack particulars (destination-specific artwork; Indian particulars kept under Rule 94; approved code number instead of manufacturer name when the consignee asks) | Artwork template by destination; coding check | Drugs Rules Rule 94 | U (see G-9) |
| Reference-sample pull (quantity, storage location, retain-until date) | Packaging record step (IN-32) | Schedule M 19.3(g); Rules 74/78 | P / S |
| Blister/strip: independent second-person clearance check; periodic pocket vacuum-test results | Packaging record (IN-38) | Schedule M Part VIII 7.1, 7.4 | P |

### C.3 Label (India-domestic artwork template)

| Field | Check in the packaging master | Legal basis | Status |
|---|---|---|---|
| Drug name; actives with INN and amount; net contents; batch number; manufacturing and expiry dates uncoded; storage/handling; directions, warnings, precautions; name and address of manufacturer and of the party placing the product on the market | Template cannot be approved without each field (IN-31) | Schedule M Part I 17.3.1(a)-(g) | P |
| Proper (generic) name with "I.P." where the drug is in the Indian Pharmacopoeia, printed at least two font sizes larger than the brand name (combinations of three or more actives exempt) | Artwork review checklist item; font-size comparison recorded by the approver | Drugs Rules Rule 96(1)(i) as amended in 2018, mandatory from 1 Apr 2019 | S |
| Manufacturing licence number ("Mfg. Lic. No.") and, for loan-licence products, the loan licence number | Template field bound to master data | Drugs Rules Rule 96 | S |
| Schedule H, H1 or X caution text in a box with red border and the Rx / NRx / XRx symbol at top left, per the product's classification | Product master carries the Indian schedule; template selects the matching panel | Drugs Rules Rule 97; Schedules H, H1, X | S |
| MRP | Template field; overprint (C.2) | DPCO 2013 | S |
| Marketer name and address where different from the manufacturer | Template field | Drugs Rules Rule 96 and Rules 84D/84E | S |
| QR/barcode for Schedule H2 products (from 1 Aug 2023 for the 300 listed brands; vaccines, NDPS narcotic/psychotropic and anticancer drugs from 1 Jul 2027; all antimicrobials from 1 Jul 2028) | Template reserves the code area; C.2 generates and verifies content | Rule 96 and Schedule H2 | S |

### C.4 Incoming material data

| Field | Use | Legal basis | Status |
|---|---|---|---|
| API QR code at every packaging level (unique product identification code, API name, brand if any, manufacturer name and address, batch number, batch size, manufacturing date, expiry or retest date, serial shipping container code, licence number, special storage conditions) | Parsed at receipt/dispensing scan to pre-fill and cross-check lot data | G.S.R. 20(E) of 18 Jan 2022, from 1 Jan 2023 | S |
| Export track-and-trace (DGFT) data | Not required: DGFT withdrew the export barcoding/iVEDA upload regime on 31 Jan 2025. Destination serialisation (US DSCSA, EU FMD) is handled by the FDA/EU layers | DGFT Public Notice 44/2024-25 | S |

---

## D. Electronic records and signatures in India

### D.1 What Schedule M allows and requires (P unless marked)
- **Electronic records are expressly allowed.** Part I 17.2 (data-processing clause): data and records may be kept by electronic data-processing, photographic or other reliable means, provided the system's master formulae and SOPs are available and record accuracy is checked. With electronic handling: only authorised persons enter or change data; changes and deletions are recorded; access is limited by passwords or other means; critical data entry is independently checked; electronically stored batch records are protected by back-up (tape, microfilm, discs, printouts or other means) and stay readily available throughout retention. Retention is at least one year after the finished product's expiry (17.2).
- **Computerised systems section.** Part I 20.2-20.10: suitability shown by IQ/OQ; qualified commercial software needs less testing; retrospective validation possible with documentation; controls against unauthorised access and changes; controls against omitted data (e.g., system switched off); each change records the previous entry, who changed it and when; written operating/maintenance procedures; an extra accuracy check (second person or system) for critical manual entries; incidents recorded and investigated; system changes authorised, documented, tested and recorded to show the validated state is maintained; back-up against permanent loss; data protection for all systems; a second means of recording is permitted. The opening 20.1 sentence is not legible in the uploaded copy (F-3). The API Part repeats this set in Part XII 5.4.x and adds that validation effort scales with how diverse, complex and critical the application is (5.4.1).
- **Signatures.** Batch processing records are dated and signed by the person responsible (17.3.8); batch packaging entries identify the responsible person by signature or electronic password (17.3.9); corrections are signed and dated (17.2). The only explicit e-signature sentence sits in Part XII (APIs, 6.1): e-signatures on documents must be authenticated and secure; where electronic or reduction techniques are used, retrieval equipment and a way to produce a hard copy must be readily available (6.1.7). Part XII binds API manufacture only, but it is the clearest Indian statement and the product applies it to both editions.
- **Validation and site master file.** Part I section 5 requires a validation master plan with attention to automated systems; Appendix I requires the site master file to describe computerised-system validation arrangements.
- **Not in Schedule M:** audit-trail review, e-signature manifestation (name, date/time, meaning), signature-to-record linking, password rules, periodic system evaluation, data-integrity (ALCOA+) terminology. No CDSCO guidance, circular or FAQ on electronic batch records, e-signatures or audit-trail review was found by the research (S). The product therefore applies 21 CFR Part 11 and EU Annex 11 detail in all editions (IN-09, IN-10).

### D.2 IT Act 2000 position (S; primary Act text not read)
- **s.4:** where a law requires information in writing, an electronic record satisfies it if accessible for later reference.
- **s.5:** where a law requires a signature, the requirement is met by an electronic signature affixed in the manner the Central Government prescribes.
- **s.3A:** an electronic signature technique counts as reliable if the signature creation data are linked to and controlled by the signatory alone, and any later change to the signature or to the signed information is detectable. Recognised techniques are listed in the Second Schedule: digital signatures under certificates from licensed certifying authorities (PKI, CCA root), and Aadhaar/e-KYC-based eSign.
- **s.7:** electronic retention satisfies a retention duty if the information stays accessible, is kept in its original format or one shown to represent it accurately, and origin, destination and date/time details are kept.
- **Bharatiya Sakshya Adhiniyam 2023 s.63** (in force 1 Jul 2024, replacing Evidence Act s.65B): computer output is admissible subject to conditions; a certificate in the prescribed form, reportedly signed by the person in charge of the device and an expert and including a hash of the record, accompanies it (format not reviewed).

### D.3 Password-based signatures versus DSC/eSign
- Schedule M itself accepts "signature or electronic password" for packaging records and allows electronic records with password-restricted access, which supports username/password e-signatures for GMP purposes under the Drugs Rules.
- The IT Act s.5 route is narrower: it deems a legal signature requirement met by a Second-Schedule technique. A password signature is not a listed technique. Whether a signature required by the Drugs Rules (e.g., the AP's release, MBR approval, the processing-lead's completion signature) must satisfy s.5, or is satisfied by Schedule M's own acceptance of electronic passwords and validated systems, is **legally uncertain**.

### D.4 Recommendation for the system
1. **Baseline (all signatures, all editions, ENFORCED):** meet 21 CFR Part 11 subpart C and EU Annex 11 section 14 in full: unique ID plus secret, re-authentication at each signing (both components at the first signing of a session), signature manifestation (name, date/time with zone, meaning) shown on screen and in print, cryptographic binding to a hash of the signed content so that any change shows the signature as invalid, account controls (no reuse, lockout, periodic credential review). This also meets the s.3A(2) reliability tests in substance (sole control, change detection), and Schedule M's "authenticated and secure".
2. **Option (CONFIGURABLE per signature meaning; recommended default ON for Indian licensees for MBR/packaging-master approval and AP release):** a Class 3 DSC from a licensed CA (e.g., USB token or HSM-backed signing) or an eSign service, producing a PKI signature over the record hash that validates to the CCA root. This places the most consequential signatures squarely within IT Act s.5. The password signature is still captured for Part 11/Annex 11 purposes. eSign involves Aadhaar/e-KYC through a licensed eSign service provider; privacy and contract terms need review.
3. **Evidence export (IN-11):** a certified export package with SHA-256 manifest and system details to support a BSA s.63 certificate.
4. **Printed/PDF rendering** of any record with signatures, meanings and audit trail on demand (Part XII 6.1.7; Annex 11 section 8; 21 CFR 11.10(b)).

### D.5 Questions for Indian legal counsel (flagged; do not treat as settled)
- Q1. Does a signature requirement in the Drugs Rules/Schedule M (release by the authorised person, approval of master documents, completion signature of processing records) count as a "law requiring a signature" under IT Act s.5, so that only a Second-Schedule technique (DSC/eSign) satisfies it? Or is Schedule M's acceptance of electronic passwords and validated systems a sufficient, specific authority?
- Q2. If a password signature is used, what is its evidential weight in a prosecution for a not-of-standard-quality or spurious drug under the Drugs and Cosmetics Act, and what must the BSA s.63 certificate contain (signatories, hash algorithm)?
- Q3. Would an Indian drug inspector accept an electronic batch record with password signatures and no wet-ink or DSC signature for the AP release? (No CDSCO guidance found.)
- Q4. For loan-licence batches, which party's authorised person must sign, and may the loan licensee sign remotely in the host's system?
- Q5. Are the Drugs Rules retention periods (Rules 74/78, Schedule U) as summarised in IN-08 current, and do they apply to electronic records identically?

---

## E. Status, in-force dates and deadlines (as of 27 Sep 2026)

| Item | Date / value | Effect on the product | Status |
|---|---|---|---|
| Revised Schedule M notified | G.S.R. 922(E), New Delhi, 28 Dec 2023 (draft G.S.R. 999(E) of 5 Oct 2018); made under sections 12 and 33 of the 1940 Act after DTAB consultation; substitutes Schedule M in the Drugs Rules and retitles it (GMP plus premises, plant and equipment); Rules 74, 76 and 78 cross-references updated | Legal basis for every IN control | P |
| Commencement | Amending rules in force on publication; paragraph 6 sets implementation by turnover: large manufacturers (over Rs 250 crore) within 6 months of publication (about 28 Jun 2024); small and medium (Rs 250 crore or less) within 12 months (about 28 Dec 2024) | Site profile stores category and dates | P |
| MSME extension | G.S.R. 127(E) of 11 Feb 2025 (draft G.S.R. 10(E), Jan 2025): MSMEs applying in Form A with an upgradation plan within 3 months got until 31 Dec 2025; non-applicants kept the original date | None today (expired) | S |
| Current position | Binding on all licensed manufacturers from 1 Jan 2026 at the latest; CDSCO asked State/UT regulators in Nov 2025 to begin risk-based Schedule M inspections with monthly reporting; no further extension notice found in 2026 searches (egazette not reachable) | All Indian customers need full compliance now | S (see G-7) |
| Draft licence-form change | Draft G.S.R. 299(E) of 21 Apr 2026 reportedly widens the licence forms listed in Rule 89 (25A, 25F, 28A, 28B, 28D, 28DA, 28F); 30-day consultation draft | May change licence-form labels in C.1; not Schedule M content | S, single source |
| Indian Pharmacopoeia 2026 | 10th edition released 2 Jan 2026; effective 1 Jul 2026, replacing IP 2022 as the "latest edition" Schedule M requires; Amendment List 01 issued; draft harmonised Uniformity of Dosage Units chapter circulated Oct 2024 (adoption in IP 2026 not confirmed) | Change-control sweep of MBR limits citing IP 2022 (IN-33); weight-band table to be confirmed (IN-34) | S |
| Schedule H2 QR codes (formulations) | G.S.R. 823(E) of 17 Nov 2022: 300 listed brands from 1 Aug 2023. G.S.R. 506(E) of 22 Jun 2026 (Drugs (Seventh Amendment) Rules 2026; draft 16 Oct 2025): all vaccines, NDPS narcotic/psychotropic drugs and anticancer drugs from 1 Jul 2027; all antimicrobials from 1 Jul 2028; reportedly adds excipient details where applicable | Packaging QR generation/verification must be ready for domestic packs of these categories by 1 Jul 2027 / 1 Jul 2028 | S (2026 details U) |
| API QR codes | G.S.R. 20(E) of 18 Jan 2022: every API made in or imported into India, at each packaging level, from 1 Jan 2023 | Receipt/dispensing scan can use it (C.4) | S |
| DGFT export track-and-trace | Withdrawn by DGFT Public Notice 44/2024-25 of 31 Jan 2025 (removed Handbook of Procedures para 2.76); tertiary (2011) and secondary (2013) barcoding and iVEDA uploads no longer required; primary-level barcoding had been deferred repeatedly; no replacement Indian export rule found | Drop DGFT/iVEDA features from the Indian layer; destination serialisation belongs to FDA/EU layers | S |
| Bharatiya Sakshya Adhiniyam 2023 | In force 1 Jul 2024; s.63 replaces Evidence Act s.65B for electronic evidence | IN-11 export | S |
| Items to re-check before each release | Any 2026-27 corrigendum or amendment to Schedule M; final text of G.S.R. 506(E); outcome of draft G.S.R. 299(E); IP 2026 amendment lists | Rule-table versions (IN-52) | open |

---

## F. Gaps: text that could not be verified in the uploaded Gazette copy

The uploaded copy is a compressed extraction with scrambled paragraph order and missing pages. The following could not be checked and must be verified against a clean copy of G.S.R. 922(E) (e.g., the CDSCO PDF) before validation documents cite them.

- **F-1** Part I section 13 (equipment) and 14.1-14.4 (general materials clauses): not found. Equipment controls in IN-25 rest on 17.3.10 and 18.4 text instead.
- **F-2** Part I section 19 after 19.7.2: the identity-test sentence is cut off mid-word, and later QC clauses (possibly identity testing per container, retained-sample periods, stability, finished-product testing and release) are missing. Affects IN-24 (scope of the 14.15 excipient route) and IN-32.
- **F-3** Part I 20.1 opening sentence of the computerised-systems section: not legible.
- **F-4** Sub-clause numbering inside Part I 17.2 (general documentation: retention sentence, data-processing clause), and item letters within 17.3.8 and 17.3.9 and numbering of 17.3.10: inferred from WHO TRS 986 ordering; the wording itself was found.
- **F-5** Part II sections 7-9 (personnel, premises, equipment for sterile areas: gowning per grade, training, premises finishes, equipment design): only fragments found. The FDA/EU layers' gowning and APS-participation controls are therefore not yet matched to Indian text.
- **F-6** Part II Tables 1 and 3: values reassembled from scattered cells; consistent with WHO TRS 961 Annex 6 and with the stated ISO classifications, but the table layout (including footnotes) could not be read as a whole.
- **F-7** Part II 10.1-10.2 (closure integrity of fusion-sealed and other containers): not found. No Indian container-closure-integrity value is catalogued; EU Annex 1 (2022) 8.22 applies for EU-profile batches.
- **F-8** Part III (hazardous substances): text interleaved with Part IV (biologicals); IN-27 detail needs re-checking.
- **F-9** Part X and Part XI headings: not found (not needed for either edition).
- **F-10** Part XIII tablet section (areas and equipment for tablets, referred to as item 3 for tablets): not found; the Tablets edition has no Part XIII master-data list yet.
- **F-11** Part XIII parenteral equipment list: fragmentary; area figures found (IN-51).
- **F-12** Outside Schedule M, no primary text was available for: Drugs Rules 71, 74, 76, 78, 84D/84E, 94, 96, 97 and Schedules C/C(1), H, H1, H2, U, X; the IT Act; the BSA; IP 2026; G.S.R. 127(E), 823(E), 506(E), 20(E); DGFT Public Notice 44/2024-25. Everything relying on them is marked S or U.

---

## G. Rows not treated as eBMR concerns, and open questions

### G.1 "Not an eBMR concern"
No bucket row is wholly out of scope: every row maps to at least one control above. The following parts of rows are outside the eBMR and are handled by facility engineering, HR/EHS or the wider QMS; the eBMR only consumes their status or supplies data:
- n664: recommended minimum floor areas and room partitioning (facility design; stored as site-profile information only).
- n677 and n265: building structure, HVAC design, airlock layouts and pressure-cascade diagrams (engineering documents; the eBMR only reads room status and readings).
- n666: breathing-air plant design, effluent treatment, facility containment engineering.
- n271: organisation charts, job descriptions, pre-employment and periodic health checks, hygiene rules (HR/EHS; the eBMR only reads training and eye-check status).
- n270: pharmacovigilance collection and ADR reporting to the authority (PV system; the eBMR only supplies batch genealogy).
- n269: supplier audits and external quality audits (QMS/supplier module; the eBMR only uses the approved-supplier list).
- n229 and n273: quality manual, senior-management responsibilities and the validation master plan document itself (customer QMS documents).
- n668: the signatories and legal execution of the BSA s.63 certificate (legal process; the eBMR supplies the data package).

### G.2 Open questions
- **G-1** Drugs Rules retention and sample conditions: confirm Rule 74 (Form 25) five-year retention of Schedule U records and its start point; Rule 78 (Form 28) test-record period (reported two years after expiry, or five years from manufacture without expiry); reference-sample quantity (twice all tests) and period (three months after expiry; three years from manufacture without expiry); whether Schedule U applies unchanged alongside revised Schedule M. Drives B-01, B-02, B-26.
- **G-2** Legal weight of password e-signatures under IT Act s.5 versus Schedule M's acceptance of electronic passwords (section D.5, Q1-Q3). Obtain a legal opinion and, if possible, informal CDSCO or State Licensing Authority confirmation.
- **G-3** Scope of Part I 14.15 (release of non-API raw materials without batch testing) versus the truncated 19.7.2 identity-test clause; until clarified the default is an identity test on every lot (IN-24).
- **G-4** Part VIII 3.8: the text ties the 30-minute ceiling to sampling against the in-process specification and makes the six named parameters periodic; confirm with Indian QA practice/inspectors which parameters inspectors expect at the 30-minute interval (usually at least weight/appearance), as this sets the default IPC schedule.
- **G-5** Bharatiya Sakshya Adhiniyam s.63 certificate: prescribed form, signatories, hash expectations (IN-11).
- **G-6** Schedule H2 after G.S.R. 506(E): exact data elements (excipient details), whether the new elements also apply to the original 300 brands, whether a GS1 GTIN is required as the unique product identification code, and whether any aggregation or portal reporting starts on 1 Jul 2027.
- **G-7** MSME status: confirm no gazette notification after G.S.R. 127(E) extended or relaxed revised Schedule M, whether Form A applicants that missed upgrades have any transition, and whether any corrigendum to G.S.R. 922(E) exists.
- **G-8** IP 2026: wording of uniformity of weight / uniformity of dosage units, disintegration and friability tests, and whether State regulators expect IP in-process bands for export-only products registered to USP or Ph. Eur. specifications (IN-34).
- **G-9** Rule 94 export labelling: whether "for export only / not for domestic consumption" comes from Rule 94 or from export NOC conditions, and which Indian particulars (licence number, manufacturer name or approved code, batch, expiry, manufacturing date) remain mandatory when the importing country's rules differ.
- **G-10** Licence-form mapping (Form 25 vs 28 vs 28-D; Schedule X forms) and the outcome of draft G.S.R. 299(E).
- **G-11** Part II Table 3 describes microbial values as averages and informative; confirm that Indian inspectors accept the product's stricter per-sample evaluation and that site-set action limits no looser than Table 3 satisfy 4.10.
- **G-12** Whether CDSCO expects audit-trail review or has issued any data-integrity guidance for electronic records (none found); until then the Annex 11/FDA expectation is applied (B-22).
- **G-13** Whether Indian inspectors expect the EU/FDA requalification detail for media fills (frequency, operator participation) at Indian sites making India-only product, given Part II only says "defined intervals" (B-11).
