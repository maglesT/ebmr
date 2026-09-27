# eBMR product spec: features, UX, roles and configuration model (Tablets and Injectables editions)

Scope: two separately sold products, the **Tablets edition** and the **Injectables edition**, for Indian manufacturers, many of them exporting. Each edition can be customised only inside its own dosage-form domain. Both run on one shared **compliance kernel**. Rule sources: India Revised Schedule M (always, because every batch is made under an Indian licence), plus US FDA and/or EU GMP according to the batch's market profile. Where rules differ, the stricter one wins.

This spec condenses the research files (features-ux.json, configurability.jsonl) and **defers to the four authoritative control catalogs** for every role, segregation, signature and release rule. Where the research and a catalog disagree, the catalog wins, and the difference is called out (see F.2). All text is paraphrased. No application code.

## Legend

**Control IDs** (defined in the catalogs, reused here):
- DI-xx: data-integrity and computerised-system kernel controls (digest-data-integrity.md).
- PR-xx: production, documentation, packaging and release controls (digest-production.md).
- IN-xx: India layer, including market-profile resolution IN-52 and table rows B-xx (digest-india.md).
- ST-xx: Injectables sterile controls (digest-sterile-controls.md).

**Basis of a rule:**
- **REG-US / REG-EU / REG-IN**: binding rule text (21 CFR 11/211; EU GMP Ch.4, Ch.5, Annex 1, Annex 11; Schedule M / Drugs Rules).
- **GUID**: guidance (e.g., FDA Data Integrity Q&A 2018, FDA 2004 aseptic guidance, ICH Q9/Q10).
- **DRAFT**: July 2025 EU consultation drafts (Annex 11, Chapter 4, Annex 22). Not in force.
- **DESIGN**: a product decision that no rule dictates. Where the engine enforces it anyway, this says "engine-enforced".

**Enforcement:**
- **LOCKED**: engine behaviour that no tenant, site, MBR, role or admin setting can weaken.
- **CONFIG**: has a default and an allowed range. Settings can be tightened; loosening is only possible where the rule allows options.

**Source-quality markers** (as in the catalogs):
- **(s)**: secondary source only.
- **(u)**: unverified.
- **[vendor]**: vendor capability seen only in marketing or search snippets, not verified.

Anything unmarked is backed by a catalog control that was checked against primary text, or is a product decision labelled DESIGN.

**Edition tags:** [K] kernel (both editions), [T] Tablets only, [I] Injectables only.

---

## A. User roles, permissions and segregation of duties

### A.1 How the role model works

1. **Authority is checked at the moment of every action, not only at login.**
   - For each action, the engine confirms the user has a role allowed to take it on that specific object. Scope dimensions: legal entity, site, area, product, line and step type.
   - A failed check blocks the action and is logged (DI-17; 21 CFR 11.10(g)).
   - Actions covered: execute, verify, supervise, review, audit-trail review, dispose/certify, MBR author/check/approve, master-data change, configure, administer.
2. **Signature meanings are tied to roles.**
   - A vendor-owned catalogue lists every signature type a rule requires (DI-35), for example "Performed", "Verified", "Yield verified", "Audit trail reviewed" and "Approved for release".
   - Each signature type defines the roles allowed to use it, its independence rule and its re-authentication rule.
   - Customers may add signature points but can never remove the minimum set.
3. **Two kinds of conflict check.**
   - *Static* conflicts are refused when a role is assigned. Examples: an administrator permission combined with any GMP permission (DI-18); any write permission on an account flagged generic (DI-14).
   - *Dynamic* conflicts are refused per object when someone tries to act. Examples: verifying your own entry; reviewing a batch you worked on; approving your own MBR version (DI-17, DI-25).
   - The two need separate engine mechanisms. Static checks alone cannot catch the per-batch rules.
4. **Qualification is checked at the moment of signing.**
   - The engine checks current training on the governing SOP/MBR version, plus any task qualification. For Injectables this includes gowning, APS participation and visual-inspection status.
   - The status found is stored with the signature (DI-21, PR-15, IN-04(e), ST-07).
   - Default is a hard block. Relaxing it to flag-and-review needs QA-approved configuration (DI-21). For India-licensed sites the training gate is ENFORCED (IN-04).
5. **People and accounts.**
   - Accounts are personal, unique and never reused. They are disabled, never deleted.
   - There is no proxy signing, and a supervisor cannot sign for an absent operator (DI-14, DI-15, DI-21).
   - Interface and service accounts are non-interactive and cannot sign (DI-14).
6. **Configurable vs fixed.** Role names and permission bundles are CONFIG. The separations in A.5 and the signature floors in DI-35/DI-38 are LOCKED.

### A.2 Kernel roles [K]

"Gate" means what the engine checks before that role can act.

| # | Role | Typical holder | May do | May never do | Gate at action time | Controls |
|---|---|---|---|---|---|---|
| K1 | MBR author | MS&T, technical services, process engineer | Compose MBRs and library elements from edition blocks; set formula, parameters, limits, calculations, IPC plans, signature points; run verification (sandbox, test vectors); sign "Prepared" | Check or approve a version they authored; edit an Effective version; add block types, scripts or code | Authoring training; site scope | PR-02, PR-03, DI-04, DI-09 |
| K2 | MBR independent checker | A second competent person (production, MS&T or QA) | Review diff, rendered MBR and verification evidence; sign "Checked" | Check own authored version | Training on MBR review SOP | PR-02, DI-17; 211.186(a) |
| K3 | Quality-unit (QA) MBR approver | QA | Approve master versions; set effective date; approve RBE rule sets and classification downgrades | Approve a version they authored; by default also be its checker (CONFIG, see A.5 S4) | QA role for the site | PR-02, DI-07, DI-26 |
| K4 | Regulatory-conformity signer | Regulatory affairs | Confirm registration references and registered/Established-Condition flags per market | — | Market scope | PR-04 |
| K5 | Master-data steward | Production IT or QA | Maintain materials, equipment classes, rooms, label templates, reason codes, UoM catalogue, rule tables (under change control) | Change executed GMP data | — | DI-09, PR-06 |
| K6 | Batch issuer | Planning or QA documentation | Issue a batch record from an Effective MBR; sign "Issued, reproduction verified"; void with reason | Issue from Draft; reuse a batch number | Issuer permission | PR-10, DI-42, IN-18 |
| K7 | Production operator (performer) | Shop-floor staff | Execute steps; scan; capture; raise exceptions; sign "Performed" | Verify own entries; approve own deviations; edit masters; disposition | Role, current training on the step's SOP/MBR version, area authorisation | PR-13, PR-15, DI-21 |
| K8 | Verifier / checker | A second operator, supervisor or IPQA | Independently check critical manual data, dispensing, charge-in, yield and significant steps, using own credentials in the same dialog; sign "Verified"/"Checked" | Verify an entry they performed | Qualified for the step | PR-14, PR-20, PR-21, DI-30, DI-38 |
| K9 | Designated dispenser | Dispensary staff | Dispense against the batch; print container labels; return remainders | Dispense without the designation | Designation, training, balance status | PR-19, IN-23 |
| K10 | Shift supervisor / production lead | Production | Approve in-line deviations for the classes it is designated competent for; manage holds and handover; switch to downtime (contingency) mode | Approve own deviation; sign for others | Competence designation per deviation class | PR-13, DI-43 |
| K11 | Person responsible for a stage / designated production-record reviewer | Production (EU: person responsible for production or packaging) | Sign responsibility for each production stage; approve the completed processing and packaging record, **before** QA review | Hold a quality-head approval on the same batch | Approved-technical-staff register (India) | IN-04(c), IN-15, PR-52 |
| K12 | Head of production | Production | Production approvals; optional co-signer on MBR routes; KPIs | Also act as quality head on the same batch | — | IN-04(b) |
| K13 | QA operations (shop floor) | QA | Real-time approval of critical exceptions; line-clearance oversight; witness where SOPs require | — | QA role | PR-13, ST-36 |
| K14 | QA batch-record reviewer and audit-trail reviewer | QA | Disposition every exception item; sign "Audit trail reviewed" and "Reviewed"; query production; escalate to deviation | Review or audit-trail-review a batch in which they executed or verified any step | Training that includes audit-trail review | DI-25, DI-26, PR-52 |
| K15 | Head of QC | QC | Approve QC results used for release; [T] approve printed tablets/capsules before packaging | Approve results they produced as analyst | Approved-technical-staff (testing) | IN-05(c), IN-20(e), IN-37 |
| K16 | QC analyst | QC | Record results (LIMS); shop-floor lab tests | Approve own results | Method training | IN-20(e); 211.194(a)(8) |
| K17 | Authorised person (India) or named delegate | Head of QA / AP | Release, reject or hold; own recall execution | Release while a hard prerequisite is open; act as delegate without a delegation citing an approved procedure | AP designation or cited delegation | IN-05, IN-29 |
| K18 | US quality-unit disposition signer | QA | Release/reject lots for the US market | — | QCU-disposition permission | PR-54, DI-39 |
| K19 | EU Qualified Person | Normally the EU importer's QP, outside this system | Certify, **only if** the in-system QP feature is ON for the tenant | — | Registered as a QP named on the authorisation | PR-55, DI-39 |
| K20 | Warehouse / labelling store | Stores | Receipt, staging, kitting, returns; issue labelling (authorised role only) | Change material status | — | PR-17, PR-32, PR-33 |
| K21 | Maintenance, calibration and cleaning technician | Engineering | Cleaning, PM and calibration logbook entries | Verify own manual cleaning | Training | PR-24, PR-23 |
| K22 | Training coordinator | HR/QA | Map curricula to MBR/SOP versions; see impacted users | — | — | DI-21 |
| K23 | System administrator (IT/OT) | IT/OT | Provision users per approved requests; deploy configuration under change control; backups, time sync, monitoring | Hold any GMP data role; change GMP values; sign GMP records; grant themselves roles; see passwords | MFA for privileged access | DI-18, DI-13, DI-19 |
| K24 | System / process owner | Business owner | Periodic review sign-off; access recertification; owner of the RBE rule catalogue | — | — | DI-11, DI-16, DI-26 |
| K25 | CSV / data-integrity lead | QA/CSV | Validation evidence, traceability matrix, RBE validation, DI investigation scoping | — | — | DI-03, DI-06, DI-50 |
| K26 | Auditor / inspector (read-only) | Self-inspection team, regulator | View, search and export (every export logged) | Any write, sign or acknowledge | Time-limited, audited access | DI-40, IN-28 |
| K27 | Contract giver / loan-licensee reviewer | External party | Read-only access to completed records; its AP or QCU releases where the contract says so | Edit | Party scope | IN-30, PR-54 |
| K28 | Service (interface) account | ERP, LIMS, OPC UA, printers | Machine-to-machine exchange attributed to the source system | Sign; interactive login | Least privilege | DI-14, DI-31 |
| K29 | Vendor support | Supplier | Named, time-boxed, customer-approved access with MFA; every action logged and reviewed | Any GMP action | Customer approval per grant | DI-08 |

### A.3 Tablets-edition roles [T]

These add task qualifications to the kernel operator/verifier roles. They are not separate authority levels.

| Role | Main work | Edition-specific gates and rules | Controls |
|---|---|---|---|
| Granulation / blending / drying / coating operator | Sifting, mixing, wet or dry granulation, drying, blending/lubrication, coating | Records typed CPPs with limits; at minimum time and temperature for mixing, blending and drying (REG-IN). Sieve/screen ID and integrity checked before and after each use. FBD filter bag tracked by ID. Coating or granulating solution has a use-by time. | IN-13(c), IN-36, IN-37 |
| Compression operator | Press set-up and run; IPCs | The start-of-run check cannot be signed until every station has a result. During the run, a sample check at most every 30 minutes; this ceiling is LOCKED for India-made batches and may be set shorter. Punches and dies inspected before and after use. Rejected tablets counted. | IN-35, IN-36 |
| IPC tester (operator or IPQA) | Weight, hardness, thickness, friability, disintegration, LOD | Every attempt is kept. A failed or missed periodic IPC holds output since the last passing check, at container level. | PR-29, DI-29 |
| Packing line operator (blister, strip, bottle) | Line clearance, component scan, coding checks, on-line checks, reconciliation | Coding checked at start, at intervals and at end. Code readers, counters and vision systems challenged at start, at intervals and at end. Unusual-event sub-workflow. Periodic pocket leak test for blisters. | PR-33, PR-34, PR-36, PR-37, IN-22, IN-38 |
| Blister/strip line-clearance verifier | Independent check of the clearance before each batch | Must be a different user from the performer (REG-IN, Schedule M Part VIII 7.1) | IN-38 |
| QC approver of printed tablets/capsules | Gate between printing and packaging | Packaging or sale is blocked until QC approves the printed bulk | IN-37 |

### A.4 Injectables-edition roles [I]

In this edition, anyone who records work in a classified area counts as an "operator" for training checks. That includes fillers, set-up staff, maintenance engineers, cleaners, EM/PM samplers and QA observers (ST-07).

| Role | Main work | Gates at action time (the engine blocks if any fails) | Controls |
|---|---|---|---|
| Aseptic-area operator | Aseptic set-up, filling, SUS assembly and connections, lyo loading/unloading, interventions | For an **unsupervised** Grade A/B signature: gowning qualification ≤12 months old; aseptic training current; a successful APS within 12 months on this line/process **covering the role or activity being signed** (e.g., a technician whose APS covered only EM sampling cannot sign a needle-change intervention). The access list and fitness declaration are checked at sign-in. Person status (qualified / supervised-only / retrain / requalification-required / disqualified) is applied to every open batch. **EU, manual aseptic processes:** qualification per operator × container × closure × equipment train, 3 initial runs, then about every 6 months. | ST-07, ST-08, ST-09, ST-10, ST-11, ST-30 |
| Component preparation / washing / depyrogenation operator | Container and closure washing; tunnel and oven runs | Classified-area training; garments suitable for the grade; wash program and hold records | ST-07, ST-11, ST-41, ST-47 |
| Sterilisation operator | Autoclave, SIP, dry-heat and lyophiliser sterilisation | Builds loads only against a validated load-pattern ID. Manual valves operated through an ordered checklist. Unload inspection. Steriliser readiness: leak test ≤7 days where there is a vacuum phase; same-day air-removal test for porous loads. | ST-43, ST-44, ST-48, ST-58 |
| Sterilisation-cycle reviewer | Signs each cycle review before batch release | Cycle faults must be dispositioned. DESIGN: the reviewer should not be the person who ran the cycle (not stated in the catalogs; recommended as consistent with performer ≠ checker). | IN-47, ST-72 |
| EM/PM sampler | Viable and non-viable sampling, glove and gown prints, bioburden and sterility sample pulls | Needs an "aseptic sampler" qualification. Needs APS coverage of EM sampling if sampling unsupervised in Grade A/B. Sampler identity, device calibration and media lot are recorded. Anti-masking rule: a glove sanitisation shortly before the print needs justification or a re-sample (DESIGN default 5 min). Where production staff sample, QA oversight frequency is tracked. | ST-07, ST-08, ST-18, ST-22 |
| Visual inspector (manual) | 100% visual inspection | Sign-on is refused unless:<br>• the eyesight check (with the inspector's own corrective lenses) is current, in every profile. India sets the interval by configuration, with yearly recommended.<br>• the VI qualification is ≤12 months old when EU is in the line's profile, which is the shipped default (ST-62, IN-50(d)). It is tested with the inspector's usual lenses on defect-library sets under worst-case conditions.<br><br>The illumination/background check is recorded. Breaks are enforced after a configurable continuous time. | ST-62, IN-50, IN-04(f), B-19 |
| AVI operator | Automated inspection | Challenge set at start-up and at intervals. A failed interim challenge puts all units since the last pass on hold. | ST-62 |
| APS reader and QC observer | Reading incubated media-fill units | Qualified reader. Suspect units go to the QC microbiologist at once. A QC observer signature is mandatory. | ST-32 |
| Microbiology / sterility-assurance approver | Approves microbiological investigations | Required approver role for micro events. Grade A/B isolates must be identified to species before closure. | ST-07, ST-21 |
| Aseptic-behaviour observer | Batch-linked observation of aseptic practice | Must hold the aseptic-expert, supervisor or QA role. Default frequency: at least monthly per line (DESIGN, CONFIG). | ST-13 |
| Cleanroom cleaner / disinfection operator | Cleaning and disinfection of rooms and RABS/isolators | Treated as an operator (ST-07). Agent lot, sterility and in-use expiry checked at scan. Cleaning must precede disinfection and bio-decontamination. | ST-15, ST-76 |
| Maintenance engineer (classified areas) | In-room repairs | Treated as an operator (ST-07). Unplanned work on sterility-critical equipment needs a sterility-impact assessment **before** work starts. | ST-16 |
| QA real-time authoriser | Unqualified (non-catalogue) interventions | QA e-signature needed before the operator continues; a deviation is raised automatically | ST-36 |
| Sterile certifier (QA/QP) | Release review of the sterile dossier | Needs a sterile-products training record | ST-70 |

A contractor's exceptional entry to Grade B, or to Grade A in operation, is **not** a system role. It is an "exceptional supervised entry" record that names the supervising authorised person and carries an impact assessment. It is linked to every batch in progress in that area (ST-10).

### A.5 Segregation-of-duties register

**How to read the Basis column:**
- REG means a binding text requires the separation.
- DESIGN means the product adds it.
- Every row here is enforced by the engine unless it says CONFIG.

| # | Separation | Basis | Citation / control | Enforcement |
|---|---|---|---|---|
| S1 | MBR author ≠ independent checker | **REG-US** (211.186(a): prepared by one person, independently checked by a second). India requires only approval by authorised persons, so for India-only products this is DESIGN, applied in every profile. | PR-02, DI-17, IN-06(c), B-20 | LOCKED |
| S2 | Every MBR version approved by the quality unit | **REG-US** 211.100(a), 211.22(c); **REG-EU** Ch.4 4.3; **REG-IN** Schedule M 17.2 and change control 8.x | PR-02, IN-03 | LOCKED |
| S3 | MBR author ≠ QA approver (no self-approval) | DESIGN (DI-17 lists three distinct users; no rule text names this pair) | DI-17 | LOCKED |
| S4 | Checker ≠ QA approver | DESIGN. The rules allow a QU member to be both checker and approver (PR-02, PR (c) C-1). | PR-02 | CONFIG: default distinct; may be relaxed so the checker can also approve |
| S5 | Performer ≠ verifier for significant steps, each dispensed container, each charge-in, each yield calculation and critical manual data | **REG-US** 211.101(c)-(d), 211.103, 211.188(b)(11); **REG-EU** Annex 11 §6 and Ch.4 4.20(c) ("where appropriate"); **REG-IN** Schedule M 14.16-14.18 and 17.2 (critical entries independently checked). The stricter US rule applies to all markets. | PR-14, PR-20, PR-21, DI-30, IN-23 | LOCKED |
| S5a | Only permitted reduction of S5: the operation itself was performed by validated automated equipment under 211.68(c), and one human checks it | **REG-US** 211.68(c). This covers only step types mapped to 211.101(c)/(d), 211.103, 211.182 and 211.188(b)(11). Zero-human verification is never allowed. | PR-14, PR-20, D-15 | CONFIG per step type. The default for US-market dispensing and charge-in keeps a second person (DI-30 open question). The step falls back to two-person mode automatically if the device is offline or a value is keyed. |
| S6 | Verifier signs with their own credentials; the performer's session can never supply the verifier's signature | **REG-US** 11.10(d),(g), 11.200; **REG-EU** Annex 11 §12 | DI-38 | LOCKED |
| S7 | Nobody approves their own deviation or exception | DESIGN. Competent-person approval itself is **REG-EU** Ch.5 5.15 and **REG-IN** Schedule M 18.2.2. | PR-13, IN-20 | LOCKED |
| S8 | Production-record review is a separate signature and comes **before** QA review | **REG-IN** Schedule M 11.3.4-11.3.5; **REG-EU** Ch.4 4.20(i)/4.21(i) (approval by the person responsible) | IN-04(c), PR-52 | LOCKED. India is always in the market set, so this always applies. |
| S9 | One user cannot give both the production-head and the quality-head approval on the same batch | **REG-IN** (heads of production and quality independent) | IN-04(b) | LOCKED |
| S10 | Anyone who performed or verified a step in a batch is barred from that batch's audit-trail review and from its disposition signature | DESIGN, engine-enforced. It supports 211.22 quality-unit independence and the reviewer independence expected by the draft Annex 11 (DRAFT). | DI-17, DI-25 | LOCKED. Whether a QA person who did in-process checks counts as "involved" is open (DI (f) 13); the default blocks them. |
| S11 | Only the market's release authority can release: India AP or named delegate (always); US QCU-disposition role; EU QP when certification is recorded in the system. No other role, administrators included, can set a released status. | **REG-IN** Schedule M 11.3.6-11.3.10; **REG-US** 211.22(a); **REG-EU** Annex 11 §15 | IN-05, PR-54, PR-55, DI-39 | LOCKED |
| S12 | System administrator ≠ any GMP data role. Administrators cannot self-grant, and every role grant needs a second approver. | **GUID** FDA DI Q&A Q4 (recommends admin independence); **REG-US** 11.10(d),(g); **REG-EU** Annex 11 §12; **DRAFT** Annex 11 is explicit. The kernel follows the stricter draft. | DI-18 | LOCKED. No small-site exception exists in the product. Staffing workarounds are a customer decision (DI (f) 4). |
| S13 | Break-glass account cannot perform GMP actions; dual authorisation; alarm on use | DESIGN, supporting 11.10(d) | DI-18 | LOCKED |
| S14 | Access requester ≠ access approver | DESIGN (Annex 11 §12.3 only requires changes to be recorded) | DI-16 | LOCKED |
| S15 | Shared/generic accounts cannot hold write, sign, verify or acknowledge permissions. Service accounts cannot sign. | **REG-US** 11.10(d), 11.100(a), 11.300(a); **REG-EU** Annex 11 §12.1 | DI-14 | LOCKED |
| S16 | No proxy or delegated signing. (An India AP "named delegate" signs with their own credentials and a cited delegation; that is not a proxy.) | **REG-US** 11.100(a) | DI-15, DI-21, IN-05(b) | LOCKED |
| S17 | Only approved technical staff sign production-supervisor or QC-approval steps on India-licensed batches | **REG-IN** Drugs Rules 71/76 (s); Schedule M 11.3.2 | IN-04(d) | CONFIG, ON by default for India-licensed sites |
| S18 | Only designated dispensers dispense | **REG-EU** Ch.5 (designated persons, per PR-19); **REG-IN** Schedule M 14.14 | PR-19, IN-23 | LOCKED |
| S19 | Only an authorised role issues labelling and packaging materials | **REG-US** 211.125; **REG-EU** Ch.5 5.46 | PR-33, IN-24(d) | LOCKED |
| S20 | Material, intermediate and batch status changes are made only by QC/QU roles, by e-signature | **REG-US** 211.22, 211.84(a); **REG-EU** Ch.5 5.5; **REG-IN** Schedule M 14.29-14.31 | PR-45, IN-24(a), DI-17 | LOCKED |
| S21 | QC results used for release are approved by a checker who is not the analyst | **REG-IN** Schedule M 19.x (IN-20(e)); **REG-US** 211.194(a)(8) | IN-20(e) | LOCKED |
| S22 | Manual cleaning: performer ≠ verifier (a single verifier is allowed when validated automated CIP/SIP did the cleaning) | **REG-US** 211.182, 211.68(c) | PR-24 | LOCKED |
| S23 | [T] Blister/strip line clearance: performer ≠ verifier | **REG-IN** Schedule M Part VIII 7.1 | IN-38 | LOCKED |
| S24 | Packaging line clearance verified by a second person | Not required by 211.130(e) or Ch.5 5.50. It becomes required if the firm's SOPs treat clearance as a significant step (211.188(b)(11)). | PR-34, C-4, F-13 | CONFIG, default ON (and always ON for blister/strip, S23) |
| S25 | Correction of critical data needs approval by a second person or QA | DESIGN (beyond Ch.4 4.9 / Annex 11 §9) | PR-12 | CONFIG level; the approval itself cannot be removed |
| S26 | Yield verifier ≠ the person who entered the quantities | DESIGN. 211.103 requires only independent verification (C-10). | PR-31 | LOCKED by design |
| S27 | Whoever raises a packaging "unusual event" cannot approve reintroduction of the affected units | DESIGN | PR-37 | LOCKED by design |
| S28 | Void or reprint needs a reason plus an attributable signer; QA approval of each void is optional | **GUID** FDA DI Q&A Q6 (written justification under document control) | DI-42, DI-43 | CONFIG: QA approval default ON |
| S29 | [I] Microbiological investigations approved by the microbiology / sterility-assurance role | **REG-EU** Annex 1 (ST-07 basis) | ST-07 | LOCKED |
| S30 | [I] Unqualified interventions need real-time QA authorisation before work continues | **REG-EU** Annex 1 8.16 | ST-36 | LOCKED |
| S31 | [I] APS reading by qualified readers, with a mandatory QC observer signature | **REG-EU** Annex 1 9.41-9.48; **GUID** FDA 2004 IX.A | ST-32 | LOCKED |
| S32 | Each market's release authority acts independently. Release for one market implies nothing for another. | **REG-US** 211.22(a); **REG-EU** Ch.5 Principle; **REG-IN** | PR-56, B-23 | LOCKED |

### A.6 Release authority by market profile

India is always in the market set. The engine holds disposition **per finished lot and per market** (PR-56).

| Market set | Who signs at the Indian site | What else the system does | Controls |
|---|---|---|---|
| India only | Authorised person (or named delegate), after head-of-QC approval and production-record review | Checklist stored with the release record: licence conditions, validated processes, documentation complete | IN-05, B-23 |
| India + US | AP release that **also** satisfies the 211.192 quality-unit review of all production, packaging and labelling records. In practice the AP role must belong to the quality unit and hold the QCU-disposition permission for US lots, so one signature covers both **(interpretation of B-23 + PR-54; confirm with customer QA)**. | Adds the US prerequisites: release-rate result for controlled-release tablets [T]; sterility and pyrogen tests [I]; micro testing where needed. For contract manufacture, the contract giver's QCU disposition is also recorded. | PR-54, B-23 |
| India + EU | Indian AP release (manufacturer release). **No QP signature slot at the Indian site.** | EU-market status stays "awaiting QP certification" until the EU importer's certification reference is recorded. The QP gets the complete record, flags for changes to critical data, and audit trails. Retention stays "open" until the certification date is received. | PR-55, DI-39, DI-47, India correction 8 |
| India + US + EU | Both of the above | Separate market-specific packaging orders, each with its own identifiers, reconciliation and disposition. A deviation accepted for one market is re-assessed for the other. | PR-56, PR (b) |

The QP-certification feature (DI-39) is a tenant switch, OFF by default. Turn it ON only when an EU MIA holder's QP actually certifies inside this system. When ON, only registered QP accounts can certify, and each certification goes into an append-only register (PR-55).

### A.7 What customers may change in the role model

| May change (CONFIG) | Cannot change (LOCKED) |
|---|---|
| Role names and permission bundles. Site, area and line scoping. Deviation-class competence designations. Adding reviewers or approvers to any route. Adding signature points. Making re-authentication stricter (e.g., MFA at signing). Training-gate items per step, MBR, room or equipment. Access-recertification interval (3-12 months, default 6). | Separations S1-S3, S5, S6-S16, S18-S23, S26, S27 and S29-S32; for S5a, the one-human-verifier floor (only the choice of step types is CONFIG). CONFIG rows are S4, S17, S24, S25 and S28. The signature-type catalogue minimum (DI-35). Two-component signing, with every component required at disposition, certification and MBR approval (DI-38). No shared write accounts, no proxy signing. Administrators separated from GMP work. Authority checked at action time. |

---

## B. Module list

**Priority levels:**
- **MUST**: needed for a compliant, sellable edition.
- **SHOULD**: strong value, planned for the first releases.
- **COULD**: optional or later.
- **MUST-if-used**: mandatory only when the customer runs that technology or market.

"Implements" lists the catalog controls the module is responsible for. A control can appear under several modules.

### B.1 Shared compliance kernel [K]

The kernel must be one validated code base and version, used byte-for-byte in both editions, so guardrails cannot drift apart (configurability finding; the catalogs assume a shared kernel). The kernel contains no dosage-form blocks. Those live in the edition libraries (B.2, B.3).

| ID | Module | Priority | One-line description | Implements |
|---|---|---|---|---|
| M01 | Identity, access and e-signature service | MUST | Personal accounts; SSO with local re-authentication; badge + PIN; role engine with static and per-object segregation checks; signature catalogue, manifestation, content-hash binding, automatic supersession on change; lockout and misuse alerts; identity verification before credentials are issued; optional Class 3 DSC or eSign for chosen meanings (India) | DI-14 to DI-21, DI-35 to DI-38, IN-04, IN-10 |
| M02 | Audit trail and audit-trail review | MUST | Server-generated, append-only, hash-chained, cannot be switched off. Plain-language viewer filtered by batch, step, user, data class and date. Inline change view for checkers at step sign-off. Batch-level "Audit trail reviewed" task before disposition. | DI-22 to DI-25, IN-09 |
| M03 | Market-profile engine | MUST | Versioned, market-keyed rule tables. Resolves the strictest value (India always, plus the batch's markets) and stores the governing market with each value. Re-resolves when the market set changes, which forces QA review. Label rules resolve per pack destination. Line/room sterile rules use the strictest value across all products qualified on that line or room. Locked numeric floor table. | IN-52, PR-04, PR-56, ST-01, B-01 to B-26 |
| M04 | MBR designer | MUST | Procedure graph editor plus outline tree. Typed blocks, formula/BOM, parameters and limits tagged with source (registered / internal / alert) and pharmacopoeia edition, IPC plans, timers with validation references, signature points, criticality classes. Live completeness and plausibility checks. | PR-01 to PR-08, IN-13, IN-14, IN-33, DI-01, DI-07, DI-30, ST-02, ST-37 |
| M05 | Library and configuration management | MUST | Versioned building-block library: vendor edition blocks plus customer library elements. Version-pinned references and a where-used index. Impact reports. Configuration baselines, diffs and drift alarm. Signed, hash-checked promotion between environments. | DI-06, DI-09, PR-06 |
| M06 | MBR verification workbench | MUST | Automated static checks, formula test vectors, and segregated sandbox test runs of every branch. Produces the verification record that must be linked before a version can become Effective. (The record is mandatory. The sandbox is the product's chosen method, a DESIGN choice; see E.6.) | DI-04, DI-05, PR-02 |
| M07 | Change-control linkage | MUST | Every master and configuration version cites an approved change record, linked with the QMS both ways. Diff report. Automatic "post-change evaluation" flag on the first batch after a change. [I] CCS-impact assessment and requalification blocks. | PR-06, IN-03, ST-03 |
| M08 | Batch issuance and numbering | MUST | Takes orders from ERP. Allows only the discrete batch sizes the master lists. Records the market set at issue. Instantiates a hash-verified copy of the master, signed "Issued, reproduction verified". Unique numbers that are never reissued, in an allocation register. Voids are kept. | PR-01, PR-10, DI-42, IN-18 |
| M09 | Execution engine and shop-floor client | MUST | Server-enforced batch and step state machines. Prerequisites re-checked at commit and at signing. Each entry committed durably when confirmed. Trusted server time. Explicit late-entry path. Completeness gate for "processing complete" and "packaging complete". | DI-27, DI-28, DI-34, PR-11, PR-13, PR-16, IN-07, IN-15 |
| M10 | Calculations engine | MUST | Sandboxed expression language with units, decimal arithmetic and rounding applied at the limit comparison. A calculation trace is stored for every result. Recalculations keep full history. Verification signatures on yields. | DI-33, PR-19, PR-31 |
| M11 | Materials, status, genealogy, complaints and recall | MUST | Receipt-boundary checks; status model (quarantine, on test, released, rejected, returned, recalled); retest and expiry blocks; stock rotation; rejects; reprocessing, recovery and rework (always a new batch number, India); returns. Immutable genealogy edges. Complaint-to-lot and recall queries. | PR-17, PR-18, PR-45 to PR-48, PR-57, IN-19, IN-24, IN-29 |
| M12 | Weigh and dispense | MUST | Booth and scale checks, potency-adjusted targets with compensating excipient, capture only of stable readings, tolerance checks, container labels with all four US elements, kits, independent verification, charge-in by scan | PR-19 to PR-21, IN-23, DI-20, DI-30, DI-32 |
| M13 | Equipment, rooms and e-logbooks | MUST | Status machines for equipment and rooms; qualification, calibration and PM gates; clean-hold and dirty-hold timers; changeover matrix; room occupancy and conditions; logbooks filled automatically; after an as-found calibration failure, a list of affected batches | PR-22 to PR-27, IN-21, IN-25 to IN-27, ST-05 |
| M14 | In-process controls and sampling | MUST | IPC and sample tasks from the master's plan; a missed IPC raises an exception; every attempt is kept and a repeat never overwrites; reagent and standard status checks; PAT/model results carry model ID and version. [T] container-level hold when an IPC fails. | PR-29, DI-29, IN-20 |
| M15 | Time limits and hold timers | MUST | Named server-side timers, each with a validation reference; warning before expiry; a breach raises a deviation. Mandatory hold time for every intermediate (India). | PR-30, IN-13, IN-15, ST-37 |
| M16 | Yield and reconciliation | MUST | Yield checkpoints with min/max limits and automatic calculation; independent verification. Reconciliation of bulk, labelling, printed materials and serials. **No roll-label reconciliation waiver** for Indian-made product. | PR-31, PR-39, IN-17 |
| M17 | Exceptions, deviations, investigations, CAPA links | MUST | Exception objects from a mandatory taxonomy. Approval by a competent person, never the raiser. Sync with the QMS. Impact-extension queries. Holds. Root-cause rules (a human-error conclusion needs a system-factor assessment). CAPA links. | PR-13, PR-49 to PR-51, IN-20, DI-29 |
| M18 | Alarm, event and incident register | MUST | SCADA/EMS alarms in batch context (acknowledged by a named user, with comment). System incidents linked to batches, blocking disposition until assessed. [I] Any power interruption that could affect quality creates a deviation. | DI-12, DI-49, ST-06 |
| M19 | Review by exception; production and QA review | MUST | Production approval first, then QA. Exception register built from the mandatory types, each item dispositioned individually. Audit-trail review task. Full review stays the default until the MBR meets its validated confidence criterion. | PR-52, DI-25, DI-26, IN-04(c) |
| M20 | Disposition and release cockpit | MUST | Disposition per lot and per market, with hard gates. A justified release with an investigation still open is possible, but never for reconciliation discrepancies or registered-specification failures. Post-change evaluation, PPQ flags, external QP reference, and a quarantine interlock to ERP/WMS. | PR-09, PR-53 to PR-56, DI-39, IN-03(c), IN-05 |
| M21 | Packaging, labelling and coding | MUST | Packaging masters per pack size and type. Labelling issuance and examination. Line clearance before and after use. Line segregation. Variable data sent from the record. Print checks and cut-label options. On-line checks and unusual events. Bright stock. Close-out destruction. Reserve samples. Calculated expiry. India-domestic artwork template. | PR-32 to PR-44, IN-14, IN-16, IN-22, IN-31, IN-32 |
| M22 | Serialisation and 2D/QR codes | MUST-if-used (switched on automatically per market) | US DSCSA identifiers and serial lifecycle (s); EU FMD unique identifier and anti-tampering device (s); India Schedule H2 QR for the notified product categories and dates (s); serial reconciliation; L3/L4 interfaces | PR-42, IN C.2, IN C.3 |
| M23 | Reports, true copies and archive | MUST | Complete human-readable PDF/A plus a structured electronic export. Printouts flag changed data. Copy marks. True-copy function with a verifier signature. Archive with fixity and readability checks. Certified evidence export for Indian proceedings (s). | DI-40, DI-41, DI-44, DI-46, IN-11 |
| M24 | Retention engine | MUST | Retain-until computed as the maximum over India, US, EU, other applicable rules and legal holds. The governing rule is stored. Deletion blocked before that date. Controlled, recorded disposal afterwards. | DI-47, PR-59, IN-08 |
| M25 | Business continuity and contingency forms | MUST | Controlled downtime forms generated from the current master, reconciliation, back-entry with second-person verification, and offline/edge rules if offline mode is enabled | DI-43, DI-28, PR-11 |
| M26 | Integration hub | MUST | Interfaces to ERP/WMS, LIMS, QMS, LMS, CMMS, EMS/BMS, SCADA/historian, scales, printers, coders and vision systems, and serialisation L3 (see B.4). Every interface checks data and keeps provenance; nothing is silently lost; idempotent; reconciled; service identities. | DI-20, DI-31, DI-32, DI-39 |
| M27 | Training and qualification gate | MUST | Linked to the LMS (or internal curricula). Checks at action time, with snapshots. Read-and-understand tasks on MBR/SOP changes. Eyesight checks. [I] Gowning, APS and sampler qualifications. | DI-21, PR-15, IN-04, ST-07 to ST-09 |
| M28 | Administration and system governance | MUST | Segregated admin console. Access requests with a separate approver. Point-in-time access lists. Recertification. Device registry. Time-sync monitor. Integrity jobs. Backup and restore tests. Periodic-review pack. System inventory with drift alarm. Vendor-access grants. | DI-06, DI-08, DI-11, DI-13, DI-16, DI-18 to DI-20, DI-44, DI-45 |
| M29 | Validation support | MUST | Vendor validation package for each release. Per-tenant release-acceptance gate. Generated traceability matrix. Golden-batch regression suites. Site-master-file paragraph. | DI-03, DI-06, IN-12 |
| M30 | Data-integrity investigation tooling | MUST | Scoping reports per user and period. Holds on linked records. Immediate revocation of GMP rights across all sites. | DI-50 |
| M31 | PQR/APR and CPV data | MUST (data model), SHOULD (dashboards) | Reproducible extracts reconciled to the registers, including export-only SKUs and failed batches. The PQR carries the AP sign-off (India). | PR-58, IN-01, ST-73 |
| M32 | Inspection and self-inspection workspace | MUST (read-only auditor role, yearly self-inspection reminder); SHOULD (advanced search) | Read-only, time-limited, audited access. One-click record, audit-trail and genealogy exports. Self-inspection findings linked to CAPA. | DI-40, IN-28 |
| M33 | Party model: loan licence and contract manufacture | MUST-if-used | Both licence numbers in the header; read-only sharing with the other party; the contract decides which party's AP or QCU releases | IN-30, PR-54 |
| M34 | Dashboards and KPIs | SHOULD | Right-first-time, exceptions per batch, review cycle time, deviation ageing, hold-time risk, OEE. Presentation only: must never hide prompts or exceptions. | (non-GMP presentation) |
| M35 | Notifications and task inbox | SHOULD | Queue aware of each user's role and qualifications; timer and escalation alerts; a GMP decision can only be taken after opening the full context | PR-30, ST-37 |
| M36 | Training / simulation tenant | SHOULD | Isolated store; reserved identifier namespace; NOT-GMP watermark; cannot touch GMP inventory, equipment or genealogy | DI-05 |
| M37 | Multilingual UI and locale | SHOULD. It becomes MUST as soon as MBR text is shown in more than one language, because translation governance then applies (D.4). | UI languages including Hindi and regional languages. Translations approved as part of the MBR version. Canonical, locale-neutral storage. | DI-02 |

### B.2 Tablets edition modules [T]

| ID | Module | Priority | One-line description | Implements |
|---|---|---|---|---|
| T01 | Tablets block library | MUST | Closed, vendor-validated blocks: dispensing; sifting/delumping; dry mixing; wet granulation (high-shear, fluid-bed); drying; dry granulation (roller compaction, slugging); milling; blending/lubrication; compression (single-layer, bilayer/multilayer, core-coated); coating (aqueous/solvent film, sugar, enteric/functional); imprinting/laser marking; blister, strip and bottle packaging; secondary packaging. Capsule filling is **out of scope unless licensed**: an open scope question. Capsule shells are already modelled as component lots (IN-37). | configurability finding (u); IN-36, IN-37 |
| T02 | Granulation, drying and blending controls | MUST | Typed CPPs with limits (time and temperature at minimum); sieve checks before and after use; sieve-residue examination; FBD bag register with product dedication for potent or sensitising products; solution use-by times; metal-detector challenge records where a detector is fitted | IN-13(c), IN-36 |
| T03 | Compression and IPC scheduler | MUST | Station-wise start-of-run gate; in-process-specification sample checks no more than 30 minutes apart (ceiling LOCKED for India-made batches); periodic parameters (including lubricant contamination); rejected-tablet counts; container-level hold on a failed or missed IPC; weight-band table per pharmacopoeia, with the tighter band applied for multi-market products | IN-34 (band values U), IN-35, PR-29 |
| T04 | Press and line data capture | SHOULD | Compression force, speed, weight control and rejects from the press via OPC UA; checkweigher and metal-detector data. Reduces manual transcription, the highest-risk area for tablets (features pitfall). | DI-32, DI-31 |
| T05 | Tooling register (punches, dies, sieves, screens) | MUST | Tooling IDs; inspected before every use and again afterwards; if the after-use check fails, a deviation opens for everything processed with that tool; dedication flags | IN-36(b), PR-27 |
| T06 | Coating and printing | MUST | Suspension preparation time and use-by; spray and air parameters; room T/RH; **QC approval gate** after printing and before packaging | IN-37 |
| T07 | OSD room environment | MUST | DP, T and RH at step start and during long steps; the validator refuses overlapping pressure ranges for adjacent rooms; excursions notify production and QA and link a deviation | IN-39, PR-25 |
| T08 | Cross-contamination and hazardous products | MUST | HBEL references, dedication, campaigns, changeover cleaning levels; one press per cubicle unless an exception applies; potent products only in negative-cascade rooms; hormone, steroid and cytotoxic classes add PPE, containment and decontamination steps; penicillin segregation | PR-27, IN-26, IN-27 |
| T09 | Blister, strip and bottle packaging | MUST | Independent second-person clearance check; defect categories; periodic pocket vacuum leak test; eligibility of lines for uncoated, potent and beta-lactam products | IN-38, PR-34 to PR-37 |
| T10 | US OTC tamper-evident packaging | MUST-if-used (product flag "US OTC retail") | The packaging master needs tamper-evidence checks and a labelling-statement check; sealing checks for two-piece hard capsules | PR-41 |
| T11 | Controlled-release release gate | MUST-if-used (US market) | Release blocked until a release-rate result exists for each active | PR-54 |
| T12 | Continuous manufacturing genealogy | COULD | Genealogy by time window and residence-time distribution, with diversion records; only if continuous direct compression is in scope | research, ICH Q13 (u) |

### B.3 Injectables edition modules [I]

| ID | Module | Priority | One-line description | Implements |
|---|---|---|---|---|
| I01 | Injectables block library, sterility route and CCS link | MUST | Closed library covering: compounding and component preparation; sterilisation and depyrogenation; bioburden sampling; sterilising filtration plus integrity tests; aseptic fill and close; freeze-drying; crimping/capping; terminal sterilisation; 100% visual inspection; CCI testing; labelling and packaging. The product master declares its sterility route. CCS ID and version are required on every CCS critical-control-point step. | ST-02 |
| I02 | Personnel gate and gowning log | MUST | Training and role checks at every signature; unsupervised Grade A/B gate (gowning plus APS participation for the role being performed); status triggers; access list and fitness declaration; gowning, glove and wear-time log; headcount; behaviour observations | ST-07 to ST-13 |
| I03 | Room grade, requalification and disinfection status | MUST | Grade and ISO class per room; requalification caps LOCKED (A/B ≤6 months, C/D ≤12 months); minimum grade per step type; cleaning before disinfection, agent rotation and sporicide use; return to service and clean-up period; DP, airflow and HEPA status; India's HEPA interval resolved per market | ST-14 to ST-17, IN-40, IN-41, IN-43, IN-44 |
| I04 | EM/PM plan, coverage and limits | MUST | Batch EM plan built from the approved programme; continuous Grade A viable coverage; settle plates ≤4 h; continuous Grade A particle counting at ≥28 L/min; limits resolved to the strictest of India/EU/FDA; no averaged-only views; excursion linkage; completeness required before release | ST-18 to ST-24, IN-42, B-12, B-13 |
| I05 | Utilities | MUST | WFI draw record, daily sample and post-sanitisation holds; pure-steam test status; gas quality and point-of-use filters; vent-filter register; sterile-tank pressure | ST-25 to ST-28 |
| I06 | APS engine | MUST | Status per process × line × shift × container-closure configuration; initial 3-run rule; the line's APS envelope, derived only from records (never typed); separate APS batch record; failure consequences under the EU rule wherever any EU/PIC/S product runs on the line | ST-29 to ST-33, IN-45, B-10, B-11 |
| I07 | Intervention catalogue and log | MUST | Per-line catalogue (inherent/corrective × critical/non-critical, APS coverage, units to remove, clearance rules); log with computed durations; PLC stops auto-created; unqualified interventions need QA authorisation plus a deviation | ST-34 to ST-36 |
| I08 | Sterile time-limit engine and equipment hold chain | MUST | Mandatory timer set in every aseptic MBR, checked against the longest duration qualified in APS; dirty/clean/dry/sterile hold chain; fresh sterilisation of product-contact equipment per batch unless a validated campaign exists | ST-37, ST-38, IN-46 |
| I09 | Components, container-closure preparation, sterile supply and transfers | MUST | Micro/endotoxin release before use; RTU/contract-sterilised supply checks; wash-rinse-siliconise-sterilise records with use-by; product-contact parts resolved to sterilisation records; aseptic connections; approved transfer list | ST-39 to ST-42, ST-45, ST-46 |
| I10 | Sterilisation cycles | MUST | Steriliser readiness; validated load patterns and recipes; automatic cycle acceptance comparing both channels; auto-quarantine of non-conforming loads; tunnel and oven runs; SIP; EO and irradiation inputs (UV is never offered as sterilisation); yearly revalidation (India) | ST-43, ST-44, ST-47 to ST-49, IN-47 |
| I11 | Sterile filtration and filter integrity | MUST | Scanned filter must match the registered and validated part; validated envelope; PUPSIT with a risk-assessed waiver path; post-use test before removal from the housing; redundant and serial logic; single batch and one working day unless validated; pre-filtration bioburden sample | ST-50 to ST-54, IN-48, B-17 |
| I12 | Filling, stoppering and capping | MUST | Open containers routed only through Grade A; fill weight/volume IPCs (manual checks in ISO 5 are also logged as interventions); capping mode; Grade A air supply; stopper-height detection challenge; stopper-to-crimp timer; vacuum-hold test where relevant | ST-55 to ST-57, IN-50(a)-(b) |
| I13 | Lyophilisation | MUST-if-used | Readiness (manual-open lyophilisers sterilised between every unload and the next load, since 25 Aug 2024); start-of-cycle leak rate; vent filter; trays; transfer and loading treated as aseptic operations; partial-stopper exposure timer; cycle record from SCADA (parameter list from the FDA 1993 lyo guide is (u)) | ST-58, ST-59 |
| I14 | Terminal sterilisation | MUST-if-used | Grade floors for preparation and filling driven by risk flags; preparation-to-sterilisation timer; each load a sub-batch; nozzle/drain checks for water-spray autoclaves; deformation and leak checks for non-rigid containers | ST-60, ST-61 |
| I14a | Parametric release path | COULD | Only with an authorisation reference; criteria to be verified against EU Annex 17 and FDA 2010 guidance (both outside the research inputs) | ST-61 |
| I15 | 100% visual inspection, AQL and CCI | MUST | Inspector sign-on gate; defect library; reconciliation; AVI challenges; AQL plan (values set by customer QA); a critical defect in accepted units triggers an investigation; 100% CCI for fusion-sealed containers ≤100 mL; visual inspection never counts as a CCI method | ST-62 to ST-64, IN-50 |
| I16 | Sterility, endotoxin and sterility sampling | MUST | Required LIMS results traced to this batch and load; method-suitability link per formulation version; pulls at start, middle and end, after interventions/excursions, and per load; a passing test never overrides a process failure; positive-result workflow | ST-65 to ST-69, IN-49 |
| I17 | Sterile review dossier and release gate | MUST | Signed dossier sections (EM, PM, HVAC/DP, WFI/steam, alarms, all filter tests, all cycles, interventions, time limits, APS/personnel status, IPC/lab results); consolidated timeline; investigation closure needs an impact-scope list | ST-70 to ST-72 |
| I18 | Barrier and technology profiles | MUST-if-used | Isolator and RABS: background grade, pressure, glove and enclosure integrity, bio-decontamination. BFS, FFS, closed/SUS: technology-specific CPPs, CCI and component checks. A conventional open aseptic line needs a CCS justification. | ST-74 to ST-79 |
| I19 | Structured sterile data for PQR and CCS review | MUST (data model) | Interventions, hold times, defects by code, excursions, filter values, cycle results, APS and sterility results stored as queryable data | ST-73 |
| I20 | Parenteral master-data defaults (Schedule M Part XIII) | SHOULD | Shipped area types and equipment classes; minimum floor areas stored as information only | IN-51 |

### B.4 Integration map (M26)

Boundary (ISA-95): ERP is Level 4 and owns items, BOM, orders and inventory valuation. The eBMR is Level 3 and owns the MBR, execution and the batch record. Automation, scales and instruments are Level 2. QC results and specifications belong to LIMS; the QMS holds deviations, CAPA and change control; SOPs sit in the DMS (configurability finding).

| System | Direction | Data | Must-have behaviour | Standards (per research) |
|---|---|---|---|---|
| ERP / WMS | both | Process orders, BOM, goods issue/receipt, lot status | Quarantine interlock: no allocation or shipment of uncertified or unreleased stock; idempotent goods movements; reconciliation | ISA-95 / B2MML (MESA) |
| LIMS | both | Sample registration, results, specifications, CoA, OOS status | Results linked immutably with value, limit and status; revisions force re-review; analyst ≠ approver | — |
| QMS | both | Deviations, CAPA, change records | Two-way IDs and status; live gate status at release | — |
| LMS | in | Training and qualification status | Checked at action time; snapshot per signature | — |
| CMMS | in | Calibration and PM due dates, repairs | Blocks overdue equipment and instruments; as-found failure impact lists | — |
| EMS / BMS | in | Particles, viable results, DP, T/RH, alarms | Coverage of the batch window; a feed gap counts as an alarm; limits resolved by the market engine | — |
| SCADA / DCS / historian | both | Recipes/setpoints out; cycle data, alarms and trends in | Recipe version checked against the MBR; dynamic data kept in native form | OPC UA; ISA-95 Job Control companion spec |
| Scales and balances | in | Gross/net/tare, stability, tolerance | Registered device bound to its location; raw string stored; calibration checked at point of use | OPC UA Weighing/Scales companion spec |
| Lab/analytical devices | in | IPC testers, integrity testers | Raw output and device ID; manual entry only as a flagged fallback | OPC UA LADS |
| Printers, coders, vision | both | Variable data out; verification results in | No manual keying of variable data; a job becomes invalid if batch data change after set-up | GS1 AIs (01), (10), (17), (21) |
| Packaging machines | in | States, counts, rejects | Stops auto-create entries; counts feed reconciliation | OPC UA PackML |
| Serialisation L3 / L4 | both | Serial jobs, commissioning, aggregation, events | Serial reconciliation with zero unexplained serials | OPEN-SCS (OPC UA); GS1 EPCIS 2.0 |

---

## C. Helpful extras, ranked by value against effort

**Scoring:**
- Value: H / M / L, for Indian manufacturers, including exporters.
- Effort: L / M / H, relative to the kernel.
- Rank: highest value for lowest effort first. Ties are broken by how much the extra reduces deviations or review time.

Every extra must stay inside the kernel guardrails. The "Compliance boundary" column says how.

| Rank | Extra | Edition | Value | Effort | Why it helps | Compliance boundary |
|---|---|---|---|---|---|---|
| 1 | Scan-everything with GS1/QR parsing | K | H | L-M | Removes identity typing with gloves on. Parses AIs (01) GTIN with check digit, (10) lot, (17) expiry, (21) serial, (00) SSCC. Also parses the Indian API QR code at receipt and dispensing to cross-check lot data (s). | A manually keyed identity is an exception and always needs second-person verification (DI-30). The scan confirms identity; the system's status decides usability (PR-18). |
| 2 | Right-first-time and exception analytics | K | H | L | The data are already structured. Shows exceptions per batch, step and MBR version, the top recurring exceptions, and review cycle time. Directs MBR fixes. | Presentation only (M34). Must never hide mandatory prompts or exceptions. Not a GMP decision tool. |
| 3 | Operator cockpit with smart timers | K | H | L-M | One queue per user of steps, verifications requested by peers, and timers counting down to hold-time and IPC deadlines (e.g., the 30-minute compression check [T]). Escalation to supervisors. | No GMP decision can be taken from a notification without opening the step in full context. Timers run on the server only (PR-30). |
| 4 | Consolidated sterile timeline [I] | I | H | M | One time axis showing interventions, particle and viable data, DP, alarms, holds, cycles, filter tests and personnel events. Reviewers judge the batch as a whole. | Already a DESIGN element of ST-70. It is read-only; each dossier section is still signed separately. |
| 5 | Genealogy visualisation with mock-recall simulator | K | H | M | Trace forward and backward, expanding level by level, with quantities on the edges and colour plus icon for status. Time-to-trace KPI. Export for the recall file. Answers "which batches used lot X" and "which contain recovered material from Y" (IN-29). | Graph built from immutable edges in the transactional store. Any graph database is a derived, rebuildable projection (PR-57). |
| 6 | Training / simulation mode | K | H | M | Operators rehearse new MBR versions before the effective date. Doubles as the MBR test-run engine (E.6). | Strict isolation (DI-05): separate store; reserved identifier namespace (no real lot or batch numbers); visible NOT-GMP watermark; no writes to GMP inventory, equipment status or genealogy; a record can never be converted into or merged with a GMP record. Completion may count as training evidence (research). Regulators do not require a simulation mode (DI (c) 14). |
| 7 | Multilingual UI including Hindi and regional languages | K | H | M | Operators work in the language they read best. Suggested set: Hindi plus languages common in Indian pharma clusters, e.g. Gujarati, Marathi, Telugu, Tamil, Kannada, Bengali (DESIGN; confirm per customer). | Translations of MBR text are versioned and approved **with** the MBR version. The record stores which language the operator saw. Switching language never changes a limit, unit or meaning. Values are stored locale-neutral (DI-02; guardrail). See D.4. |
| 8 | Batch comparison and golden-batch overlay | K | M-H | M | Overlays one batch on others, or on a reference batch, for parameters, step timings, IPC trends and exceptions. Speeds investigations and continued process verification. | Read-only use of PQR/CPV data (PR-58, ST-73). |
| 9 | Change-impact explorer | K | M-H | M | Before a change is approved, shows visually which MBRs and open batches use a given block, material, equipment class, label template or SOP. | Supports PR-06 impact assessment. Does not replace the change record. |
| 10 | EM mobile sampling app [I] | I | H | M | Sampling-point maps, plate labels, chain of custody, and exposure timers enforcing the 4 h maximum. | Sampler qualification and device calibration checked; GPT-released media only (ST-18, ST-22, ST-23). |
| 11 | Paper-fallback kit generator | K | H | L-M | On an outage, prints uniquely numbered forms for in-progress steps and tracks each back to reconciliation. | The underlying continuity control is mandatory (DI-43). The generator is how the product delivers it. Aseptic filling needs a pre-staged, immediate fallback. |
| 12 | Offline / edge resilience | K | H (sites with weak Wi-Fi, steel rooms, isolators) | H | Lets defined step types continue through short network loss. | DI-28 rules: entries signed and hashed locally against a trusted clock; uploaded in order; flagged "offline-captured"; never overwrite server data (a conflict becomes an exception); status checks use pre-cached values with validity windows, or block. Account and training validity re-checked at sync. Limited to defined step types and durations. |
| 13 | Class 3 DSC / eSign for key signatures (India) | K | M-H | M | Puts MBR approval and AP release within the IT Act s.5 signature route, alongside the Part 11-style signature. | CONFIG per signature meaning. Legal position is uncertain; counsel questions are open (IN-10, India D.3-D.5). |
| 14 | Camera-based verification | K | M | M | OCR/OCV of printed batch, expiry and MRP; photo evidence of line clearance; start/interval/end coding specimens (IN-16). | Images are evidence, not the decision. Vision systems are challenged at start, at intervals and at end (IN-22). |
| 15 | Certified evidence export (India) | K | M | L | Package: rendered record, data, audit trail, and a SHA-256 manifest supporting a Bharatiya Sakshya Adhiniyam s.63 certificate (s). | IN-11 (s). The certificate's format is not yet reviewed (G-5). |
| 16 | Gloved-touch hardware, and a foot pedal or voice acknowledgement for non-critical confirmations | K (mainly I) | M | M-H | Fewer glove contacts with the screen in Grade A/B, and faster flow. | **Never** used for e-signatures, measured values or identity. Read-back required. Registered, grade-rated devices only (ST-13). |
| 17 | CPV / APR data feed | K | M | L-M | Streams structured batch data to a data lake or historian for CPV and the annual review. | Extracts must be reproducible and reconcile to the registers (PR-58). |
| 18 | Rich-media work instructions | K | M | L-M | Images and video for set-ups such as filling format parts and press tooling. | Versioned and approved as part of the MBR, like any instruction text. |
| 19 | MBR / record export as BatchML / B2MML | K | M | M | Tech transfer, exchange between CDMO and sponsor, long-term archive, and less vendor lock-in. | Export only; the eBMR remains the system of record. |
| 20 | AI-assisted MBR digitisation | K | M | M-H | Turns legacy paper MBRs and SOPs into draft blocks and parameters. | The output is a **draft owned by a named human author**. The same static checks, test runs and author/checker/QA signatures apply. The source is shown side by side with a diff. Model and version are recorded (PR-60 DESIGN; draft Annex 22 (s)). |
| 21 | AI-assisted review hints | K | M | H | Anomaly scores or summaries shown as advisory flags on the RBE screen. | Advisory only: no AI output changes GMP data or status without a human e-signature (PR-60). GMP-critical AI must be static, deterministic and validated, and generative AI/LLMs stay out of critical decisions (draft Annex 22 (DRAFT)(s)). Prompts, outputs and model version are logged. Never counted as the review itself. |
| 22 | Cleaning-validation (MACO/HBEL) calculator [T] | T | M | M-H | Faster changeover decisions in multi-product tablet plants. | If it drives a GMP decision it is validated GMP logic. The values it produces feed configured changeover rules (PR-27). |
| 23 | Predictive batch and review ETA | K | L-M | M | Scheduling help; early warning of hold-time risk. | Strictly non-GxP decision support. |
| 24 | Optional graph read-model for enterprise analytics | K | L (typical site) | H | Multi-site, multi-hop genealogy and supplier-deviation analytics. | Non-authoritative, fed by outbox/CDC, rebuildable and reconciled. Validated to the extent it drives recall scope. |
| 25 | AGV/AMR material transport | K | L | H | Automated staging tasks with scan hand-offs. | Every hand-off is a scanned genealogy event. |

**Not recommended as extras:** anything that turns an interlock into a warning; any "skip review for testing" switch on a GMP master (configurability pitfall); free scripting.

---

## D. UX principles and key screens

### D.1 Shop-floor UX principles

| # | Principle | What it means in the product | Basis |
|---|---|---|---|
| U1 | One actionable step at a time, with persistent context | The step card shows the title, "step n of N", the instruction, the required inputs (unit, target, range and **limit source**, e.g. registered or internal) and one primary action. A fixed header always shows: product, batch, market-set badges (IN/US/EU), stage, room and equipment, the signed-in user, running timers, and connectivity/sync status. Parallel branches are separate tasks, never one long form. | 11.10(f) sequencing; DI-34 |
| U2 | Scanner first, keyboard last | Materials, containers, equipment, rooms, documents and badges are scanned. Keying an identity by hand is an exception that needs verification. GS1 AIs are parsed and check digits validated. | 211.101(b)-(c); DI-30; PR-18 |
| U3 | Prevent errors, and give every check a defined response | Inputs are constrained: scan, device capture, pick lists, numeric keypad with a fixed unit. Impossible actions are disabled. **LOCKED blocks** (wrong or unreleased material, unqualified person, calibration overdue, room grade too low) offer only next steps that do not override: pick another lot, call the supervisor, raise an incident. **Configurable checks** (e.g., internal limits) offer the governed deviation path. A block is never just a generic error message. | PR-18, PR-13, DI-17; research pitfall on hard stops |
| U4 | **Commit first, then evaluate** | Target and range are shown next to the input. The pass/fail or OOS verdict appears only **after** the value is durably committed, so nobody can re-key before saving. A re-entry is a correction with a reason, and every attempt stays visible. Live SPC mini-charts update from committed values. Dispensing: the live scale gauge showing the tolerance band guides the **act of adding material**; the committed value is the stable reading at confirmation, and an out-of-tolerance value cannot be confirmed without a deviation. **Confirm this interpretation of DI-28 with customer QA.** | DI-28, DI-29, PR-19 |
| U5 | Never pre-fill measured or observed values | Defaults are allowed only for context, such as the current room. Targets are shown beside the field and never copied into it. Device values are captured, never typed. | 11.10(e); DI-32 |
| U6 | State shown by colour **and** icon **and** text | Consistent palette: muted neutral = normal; blue = active; amber = attention; red = out of limit or blocked; green = complete. Always paired with an icon and a word. Text contrast ≥4.5:1; state graphics and component boundaries ≥3:1. | WCAG 2.2 1.4.1, 1.4.3, 1.4.11; ISA-101 idea (u) |
| U7 | Sized for gloved hands | Shop-floor targets are at least 44×44 CSS px (WCAG AAA 2.5.5, used as the baseline). Primary actions for double-gloved use are about 15-20 mm physical (research recommendation (u)). Generous spacing. No drag gestures, multi-finger gestures, hover-only affordances, or small icons as the only control. | WCAG 2.2 2.5.5, 2.5.7, 2.5.8 |
| U8 | Readable at arm's length through a visor | Large base font, larger still for values and limits. Units always shown. Consistent significant figures. No dense grids during execution. Anti-glare screens at the point of use. | research |
| U9 | Timers always visible | Every running time limit or hold time is in the header with time remaining, escalating colour, and warnings before expiry to the operator and supervisor. Timers run on the server. | 211.111; PR-30; ST-37 |
| U10 | Identity always visible; fast, safe user switching | Persistent identity banner. Badge tap to switch user. On shared terminals, every entry belongs to whoever authenticated for that specific entry. Kiosk locks after inactivity (default 5 min, allowed 1-15). | DI-14, DI-38 |
| U11 | Humane lock behaviour | Warn at least 20 s before the inactivity lock, with a one-tap "stay signed in". Badge re-login returns to the same step. **Committed data are never lost. Unconfirmed keystrokes are not kept as client-side drafts**, because executed GMP data have no editable client draft (DI-28), so they must be re-entered. | WCAG 2.2 2.2.1; DI-28 |
| U12 | Exceptions that tell you what to do | When a check fails, say what failed, expected vs actual, why it matters, and the permitted next actions. Capture the justification immediately: reason code from a controlled list plus free text. Show who the exception will go to. The operator cannot approve it. | 211.100(b); DI-22; PR-13; WCAG 3.3.1, 3.3.3 |
| U13 | No redundant typing | Reuse values captured earlier in the same record (a single source of truth: show the value where needed instead of asking again). Re-authenticating at signing is the permitted security exception. | WCAG 2.2 3.3.7 |
| U14 | Offline and contingency status is always visible | Connectivity and sync status are always on screen. Offline entries carry a visible badge. Switching to downtime mode is an explicit, logged act by an authorised supervisor. | DI-28, DI-43 |
| U15 | Numbers and dates that can't be misread | Parse numbers per site locale and echo the interpreted value with its unit before commit. Dates in records use an unambiguous format (e.g. 27-SEP-2026). Store canonical values (D.4). | DI-02; research |
| U16 | Granularity follows risk | Enforced blocks for CPPs/CQAs and every check a rule requires. Low-risk actions may be grouped into one acknowledgement, but **never** grouped when a rule requires a signature (DI-35). Too many trivial signatures cause fatigue and noise. | PR-07; configurability pitfall |
| U17 | Same block, same look, everywhere | One design system across execution, dispensing, logbooks and review. A given block behaves the same at every site. | research |
| U18 | Notification discipline | Rationalised, role-routed alerts. No storms of pop-ups that train people to click through. Every alert has an owner and a required response. | ISA-18.2 idea (u) |
| U19 | [I] Designed for aseptic behaviour | Paperless in Grade A/B, using registered, grade-rated devices (DESIGN). Stations placed so data entry stays out of first-air paths. Entry after the activity only where the MBR allows it, through the late-entry path. Quick-log buttons so an operator is not stuck in a dialog during an intervention. | ST-02, ST-13, ST-04 |
| U20 | Test with gowned users | Task analysis per role. Use-error analysis for weighing, charge-in, signing and release. Formative tests in a mock cleanroom with real gowns, double gloves, visors and scanners. Track task time, error rate and workaround rate before go-live. | IEC 62366-1 / ISO 9241-210 used as methods (u) |

### D.2 Key screens

**S1 Operator cockpit (home)**
- One queue of everything the user is qualified and scheduled to do: steps, peer verification requests, IPCs due, and timers.
- Each item shows its batch, room and due time.
- Items the user is not qualified for are hidden, or shown greyed out with the reason (e.g., "APS coverage missing for this activity").

**S2 Step execution screen**
- Layout as in U1.
- Step states: Not ready (with the reason) / Ready / In progress / Awaiting verification / Completed / Exception open / Blocked (with the reason).
- Prerequisites (equipment, material, room, training, predecessor, timers) are listed at step open. They are re-checked at commit and at signing (research: this closes time-of-check/time-of-use gaps).
- The "Complete step" action appears only after every mandatory field and verification is done.
- "N/A" appears only where the MBR marks the item conditional. It needs a reason and a signature (PR-03, PR-16).

**S3 Scan and identity dialog**
- Shows expected vs scanned item and lot, the status with colour, icon and text, and the retest/expiry date.
- On mismatch it says why: wrong item, quarantined, expired, retest overdue, restricted to another product, or unapproved source.
- The manual-entry path is hidden behind a supervisor-visible exception.

**S4 Dispensing screen**
- Live gauge with the target and tolerance band, and a stability indicator (U4).
- Tare, gross and net shown; potency-adjusted target with its calculation trace.
- Commit on stable reading. Automatic label print showing all four required elements.
- Every aborted weighing is kept with a reason. A reprint voids the previous label.
- Verification request goes to a different user. The screen switches to two-person mode automatically when the scale is offline (PR-19 to PR-21).

**S5 IPC entry screen [T emphasis]**
- Individual values with running mean and RSD, plus a mini control chart, all computed from committed values.
- The next-check countdown enforces the ≤30-minute compression ceiling (India).
- On a multi-station press, a station-wise grid must be completely filled at run start.
- A missed IPC opens an exception. A failed IPC puts the containers since the last pass on hold (IN-35, PR-29).

**S6 Exception capture dialog**
- Pre-filled context: step, values, limits, user and time. Severity proposal. Required path (acknowledge, supervisor approval, QA approval, QMS deviation). Reason code plus text.
- Planned departures are approved before execution; unplanned ones after the event (PR-13).

**S7 Signature dialog**
- Shows the signer's printed name, role, the meaning (e.g. "Verified by"), and the date and time with UTC offset.
- Summarises **precisely what the signature covers**: the values, their limits and any exceptions. When one signature covers several items with the same meaning, every item is listed.
- Asks for the components the policy requires. Default is all components at every signing. Disposition, certification and MBR approval always need all components (DI-38).
- The verifier authenticates with their own credentials in the same dialog.
- Never pre-filled. No "remember". Nothing can be signed in advance.
- Accessible authentication: see D.3.

**S8 Verification queue (verifier)**
- The performed data are shown side by side with the requirement.
- Inline list of any post-entry change on the step (old value, new value, who, when, why), because the checker's signature covers that review (DI-25 step level).

**S9 Equipment and room status board; e-logbook**
- Current state per unit and room: clean until / dirty since / in use by batch / maintenance / calibration due / qualification expiry. Room grade and requalification due date [I].
- Logbook entries are generated from execution. Manual entries only for non-batch work, always chronological (PR-24, IN-25).

**S10 [I] Aseptic quick-log panel**
- One-tap logging of glove sanitisation, glove change, gown change and breach (ST-11).
- Intervention start/stop with a catalogue picker that offers **only entries qualified in a valid APS for this line**. "Unqualified" triggers QA authorisation (ST-34 to ST-36).
- PLC stop entries arrive automatically for completion.
- After a critical intervention, the glove-print and outer-glove-change tasks block that operator's next action (ST-22).

**S11 [I] Visual-inspection station**
- Sign-on gate (eyesight check; VI qualification). Illumination and background check.
- Large defect-code pad from the controlled defect library. Running counts per code.
- Break timer. Reconciliation at close (ST-62, IN-50).

**S12 [T] Packaging line screen**
- Clearance checklist (with independent verification for blister/strip lines).
- Component scan against the BOM.
- Coding checks at start, at intervals and at end, with specimen images.
- Device challenge results, the on-line check schedule, an unusual-event bucket, and a live reconciliation balance (PR-33 to PR-39, IN-22, IN-38).

**S13 Late-entry and contingency screens**
- Late entry: stores the claimed event time and the entry time, requires a reason, and flags the entry for review.
- Contingency form issue and return, then back-entry flagged "transcribed from paper" with second-person verification and a linked scan (DI-28, DI-43).

**S14 Production review screen**
- For the person responsible for the stage or the designated production-record reviewer.
- Exceptions within production's scope; yields; reconciliation; completeness.
- Signature "Production record approved", which must come before QA review (IN-04(c), PR-52).

**S15 QA review-by-exception workspace**
- *Left pane:* the exception register, built from the mandatory types (out-of-limit, deviations and overrides, forced/skipped/N-A steps, post-entry changes and voids, repeats and aborted attempts, late entries, manual entry where device capture was configured, interface fallbacks, signature failures, alarms, time-sync events, open incidents, special observations). Grouped by severity and category, with filters, counters and status per item.
- *Centre pane:* item detail. Expected vs actual; limit with its source and version; who and when; justification; linked deviation status; an audit-trail snippet (old, new, who, when, why); the MBR instruction exactly as issued; attachments; raw device data.
- *Right pane:* the full record (step tree plus timeline), always reachable.
- *Actions per item:* Accept / Query to production / Escalate to deviation.
  - **Each item is dispositioned individually.** There is no bulk accept (PR-52). A keyboard-driven "next item" flow keeps this fast.
  - A query opens a controlled correction loop: the fix is a correction with a reason, never re-execution.
- *Audit-trail review panel:* every post-entry change in the batch, plus batch-linked system events. Criticality orders and highlights entries but never hides any (DI-25).
- *Clean batch:* shows "No exceptions" with a completeness summary (DI-26).
- *Mode badge:* "Full review" or "RBE, rule set vN". Full review is the default until the validated confidence criterion is met (DI-26). Reduced compliance-summary reports only on steps configured as validated and continuously monitored (PR-52).
- *Signature:* disabled until production approval is signed, every item is dispositioned and the audit-trail review is signed. It is refused if the reviewer worked on the batch (S10).

**S16 Audit-trail viewer**
- Plain language, not codes.
- Filters by batch, step, user, data class and date.
- Old and new values, reason, role at the time, terminal/device, and UTC plus offset.
- Exportable, and every export is logged. There is no edit, disable or purge function anywhere (DI-22, DI-23).

**S17 Disposition and release cockpit**
- One tab per market (IN always; US; EU). Each tab has a readiness checklist whose red/green items link to their source:
  - record completeness and production approval;
  - QA review and audit-trail review;
  - deviations and investigations; CAPA (information only unless QA makes it blocking);
  - QC results with head-of-QC approval;
  - input-lot release and genealogy completeness;
  - yields and reconciliation; serialisation;
  - post-change evaluation; PPQ status; incidents and alarms; registration-relevant deviations.
  - [I] adds: every dossier section signed; every sterilisation cycle reviewed; EM/PM complete with no plates still incubating; APS status; sterility and endotoxin results; filter integrity.
- The justified-open-investigation path records an e-signed justification that prints on the release record. It is **not offered** for reconciliation discrepancies or registered-specification failures (PR-53).
- The EU tab shows "awaiting QP certification" and a field for the external certification reference (PR-55).
- The release signature carries its meaning. The status is pushed to ERP (DI-39).

**S18 MBR designer**
- *Views:* two synchronised views, both editable:
  - a procedure canvas using PFC-style notation (sequence, parallel and alternative branches, synchronisation, loops with exit conditions);
  - an outline tree (procedure > unit procedure > operation > phase).
  - Every drag action has a single-pointer or keyboard alternative ("insert after", "move up/down") to meet WCAG 2.5.7.
- *Palette:* only edition blocks and customer library elements, each showing its pinned version.
- *Property panel:* typed parameters (value, unit, precision, limit type and source, pharmacopoeia and edition, criticality class with risk-assessment reference, entry mode, verification method). Formula editor with type and unit checking and test vectors.
- *Operator preview:* shows exactly what the operator will see, in each approved language.
- *Validation panel (like an IDE):* errors block submission; warnings need a justification. Each message names its rule and control ID, e.g. "Critical manual field has no accuracy-check method (DI-30)" or "Timer lacks validation reference (ST-37)".
- *Market panel:* market set, registration references, and resolved rule values with the market that governs each.
- *Other panels:* where-used, diff against the last Effective version, test-run launcher with coverage meter (E.6).
- *Paper-on-glass guard:* free-text capture of a value that has a typed block is flagged.

**S19 MBR review and approval mode**
- Changes since the last Effective version are highlighted.
- The verification report, test-run evidence, change record and training impact are attached.
- Signatures in order: Prepared → Checked → Approved, each with its own independence check (S1 to S4).

**S20 Dashboards**
- *Kernel:* right-first-time, exceptions per batch (Pareto by step and MBR version), review cycle time, deviation ageing, hold-time risk, review backlog.
- [T] IPC SPC, press OEE.
- [I] EM trends and excursions, intervention counts against the APS envelope, APS due dates per line and shift, VI reject rates by defect code.
- Every tile shows how fresh its data is and drills down to the record.

**S21 Genealogy explorer**
- Starts from the searched lot and expands level by level.
- Repetitive nodes are collapsed. Status shown by colour, icon and text. Quantities on the edges. Filters by material type and time.
- Export to PDF for the recall file.

**S22 Administration console**
- Kept apart from GMP work, and never shown to GMP roles.
- Access requests with a separate approver. Point-in-time user/role list for any past date. Recertification campaigns.
- Device registry. Time-sync monitor. Integrity-job and backup results. Configuration baseline and drift. Vendor-access grants.

**S23 Inspection workspace**
- Read-only, time-limited and audited.
- Batch record PDF, audit-trail export, genealogy trace, deviations, and training evidence for any signer as of the signing date.

### D.3 Accessibility baseline: WCAG 2.2 Level AA, office and shop floor

WCAG 2.2 is used here as a design target, not as a regulatory requirement.

| Success criterion | How it applies |
|---|---|
| 1.4.1 Use of Color (A); 1.4.3 Contrast Minimum (AA); 1.4.11 Non-text Contrast (AA) | State never shown by colour alone (U6). Text 4.5:1. State graphics and control boundaries 3:1. |
| 1.4.4 Resize Text; 1.4.10 Reflow (AA) | Review and designer screens work at 200% zoom and at narrow widths. |
| 2.1.1 Keyboard (A); 2.4.7 Focus Visible (AA); **2.4.11 Focus Not Obscured (Minimum) (AA, new in 2.2)** | Every office function works by keyboard. The focused field is never hidden behind the sticky header or an on-screen keypad. |
| 2.2.1 Timing Adjustable (A) | Warning plus one-tap extend before the inactivity lock (U11). |
| **2.5.7 Dragging Movements (AA, new)** | The MBR canvas and genealogy explorer offer single-pointer alternatives. |
| **2.5.8 Target Size Minimum 24×24 CSS px (AA, new)**; 2.5.5 Enhanced 44×44 (AAA) | 24 px is the floor for office screens. Shop-floor screens use ≥44 px and larger primary actions (U7). |
| 3.3.1 Error Identification (A); 3.3.3 Error Suggestion (AA); 3.3.4 Error Prevention (AA) | Actionable exceptions (U12). Confirmation before commit and signature. Corrections are always possible, via the correction path. |
| **3.3.7 Redundant Entry (A, new)** | Reuse captured data (U13). Re-authentication at signing is the security exception. |
| **3.3.8 Accessible Authentication (Minimum) (AA, new)** | A password or PIN is a memory test. Provide at least one method that is not: badge plus biometric or a hardware security key on shared kiosks, or allow paste and enterprise password-manager autofill on office clients. The application itself never stores or pre-fills credentials (DI-19, DI-38). Biometrics must be usable only by their owner, with anti-spoofing. **Needs customer IT/QA sign-off.** |
| 3.2.6 Consistent Help (A, new); 4.1.2 Name, Role, Value (A); 4.1.3 Status Messages (AA) | Help in the same place on every screen. Screen-reader support for review and office roles. Sync and timer status announced. |

### D.4 Language and locale (India-specific design)

- **Languages.** UI strings in English plus Hindi and regional languages chosen per customer (C rank 7). Scripts: Devanagari, Gujarati, Telugu, Tamil, Kannada, Bengali and others, using a font family with full Indic shaping support. Every screen is tested with the longest translation.
- **MBR text.**
  - Instruction text shown to operators in any language is part of the approved MBR version. Translations are reviewed by a bilingual reviewer and approved with the MBR (DESIGN).
  - Machine translation is allowed only as a draft.
  - The record stores the language the operator saw.
  - Switching language never changes a limit, a unit or an instruction's meaning (guardrail; DI-02).
- **Numbers.**
  - Values are stored canonically: decimal, unit code, UTC.
  - DESIGN: show GMP values in international (Western Arabic) digits with SI unit symbols in every UI language, to avoid misreading.
  - Offer Indian digit grouping (lakh/crore, e.g. 12,34,567) only as a site display option. Parsing is locale-safe and always echoes the parsed value back (U15).
- **Dates and times.** Stored as UTC instants. Shown as site-local time with the offset. Unambiguous month names (DI-27).

### D.5 Devices and environment

- **Shop floor:** sealed panel PCs or cleanroom-rated tablets. Glove-capable touch. Resistant to IPA, sporicides and VHP. Fixed at the point of use. Tethered 2D imagers that can read damaged codes. Badge readers. Kiosk mode with USB storage disabled (DI-13). Every device registered to a room or line, and its ID stored with each value (DI-20).
- **[I]** Sessions in classified areas can be opened only from registered devices rated for that grade, and each device needs a disinfection record when it is brought in (ST-13). Screens outside isolators may be read through windows (research).
- **Network:** OT/IT segmentation for scales, PLCs and edge devices (DI-13). Wi-Fi inside steel rooms and isolators is surveyed before go-live (research pitfall).

---

## E. Configuration model

### E.1 Layers: who owns what

The recipe layers follow the ISA-88 general / site / master / control recipe idea (configurability findings (s)).

| Layer | Owner | Contents | Change route |
|---|---|---|---|
| L0 Kernel engine | Vendor | State machines, enforcement logic, audit trail, signatures, calculation engine, market-profile engine, record generation, retention engine | Vendor release → customer acceptance per tenant (DI-03) |
| L1 Edition block library | Vendor | Closed set of typed primitive block types for Tablets **or** Injectables (B.2, B.3), each with declared options | Vendor release |
| L2 Rule tables | Vendor-shipped and versioned; values can be tightened per site | Market-keyed values and floors (IN-52 table B; ST-01 floor table; pharmacopoeia band tables) | Vendor rule-table version + customer impact review (E.7) |
| L3 Company library | Customer | Library elements (parameterised sequences composed from L1 blocks); general recipes per product, independent of equipment | Library-element change control + verification |
| L4 Site layer | Customer | Site recipes: local materials and suppliers, languages, site time limits, [I] CCS values (EM plan, intervention catalogue, cycle recipes, filter trains) | Site change control |
| L5 Master (MBR) | Customer | Header, formula/BOM, equipment-class requirements, procedure graph, plus approved variant parameter sets | MBR change control + verification package (E.6) |
| L6 Issued batch record (control recipe) | Created by the system | Exact, hash-verified instance of an Effective L5 version, plus batch header: number, approved size, market set, actual equipment | Never edited. Departures go through the deviation path; ISA-88 run-time recipe editing is not allowed in GMP (configurability finding) |

Every other configurable object follows one rule set, the same as MBRs:
- roles, approval routes, signature policies, exception-taxonomy extensions, RBE rule sets;
- numbering formats, label and report templates, UoM catalogue, master-data classes, custom fields, languages;
- interface mappings, security parameters.

Each is a versioned configuration item with an author and an approver, an audit trail, an effective date, a where-used list, export/diff, and signed promotion between environments (DI-09; configurability finding).

### E.2 Configurable vs locked

| Area | Customer may configure | Locked guardrail | Controls |
|---|---|---|---|
| Audit trail | Add event types (independent admins only, under change control) | Always on; covers creation, change, void, sign and configuration change; reason mandatory for changes and voids; cannot be disabled, filtered at capture, edited or purged | DI-22, DI-23 |
| Corrections | Approval level for corrections to critical data (second person or QA) | Original never overwritten; the approval requirement cannot be removed; re-signature after correcting signed content | DI-24, PR-12, DI-37 |
| Time | Clock-drift alarm threshold (design default 1 s, allowed 0.1-5 s); late-entry window (design defaults: kernel = after the planned step window; [I] 15 min) | Server UTC time only; the user never sets the time of an action; claimed event time stored separately from entry time | DI-27, DI-28, PR-11, ST-04 |
| E-signatures | Stricter settings (MFA at signing); relaxation to the private component only, for routine signings within one continuous session, with QA approval; Class 3 DSC/eSign per meaning (India option) | Two distinct components; all components at disposition, certification and MBR approval; manifestation and hash binding; no pre-signing | DI-35 to DI-38, IN-10 |
| Accounts and sessions | Lockout 3-5 attempts (default 5); password aging (default 90 days) or a documented equivalent; kiosk lock 1-15 min (default 5); recertification 3-12 months (default 6). **These numbers are design defaults. No regulation sets them.** | Unique IDs, never reused; identity verified before credentials issued; misuse alerts; no shared write accounts | DI-14, DI-15, DI-16, DI-19, DI-38 |
| Roles | Names, bundles, scope, deviation-class competence | Segregation register A.5; authority checked at action time | DI-17, DI-18 |
| Approval routes | Add stages and reviewers | Minimum: author → independent checker → QU approval; production review before QA review; release only by AP/QCU/QP per market | PR-02, IN-04, IN-05, PR-54, PR-55 |
| Training gate | Which curricula and qualifications apply per step, MBR, room or equipment; evidence source (LMS or internal) | Blocks untrained users at the moment of signing for India-licensed batches, which in practice means every batch (IN-04(e)). The kernel's flag-and-review option (DI-21) is therefore not available to Indian sites. | DI-21, IN-04, PR-15 |
| Data criticality | Class per field (default critical until classified) | Downgrade needs QA e-signature, risk assessment and change control. Floors (attribution, audit trail, reason, inclusion in audit-trail review) apply in every class. | DI-07, IN-02 |
| Accuracy check for critical manual data | Method: second person, or validated electronic means | "No check" cannot be configured. US floors on dispensing, charge-in and yield. At least one human verifier. | DI-30, PR-20 |
| Limits | Values, tiers (registered / internal action / alert), precision, pharmacopoeia rounding policy, breach action for **internal** limits | Every CPP/IPC has unit, limits and source. Out-of-limit values stored as acquired and flagged. A breach of a registered or action limit stops the dependent step until a deviation exists. The narrower range applies for multi-market products. | PR-08, IN-33, IN-34 |
| Time limits and hold times | Values, each with a validation reference | Server-side enforcement; breach creates a deviation; hold time mandatory for every intermediate (India); [I] mandatory aseptic timer set | PR-30, IN-13, ST-37 |
| IPC and sampling plans | Frequency and sample size with QRM reference; reducing frequency needs change control citing trend data | Missed IPC → exception. [T] ≤30-min compression ceiling (India). [T] Container-level hold on failure. | PR-07, PR-29, IN-35 |
| Exception taxonomy | Add types; raise severities; set routing and notifications | Mandatory types cannot be removed; open exceptions block disposition; classifying an exception as a deviation is a recorded QA decision | DI-26; guardrail |
| Review by exception | Whether an MBR uses RBE (default: full review, until the MBR meets its validated confidence criterion); extra checkpoints; wider audit-trail scope | The mandatory type set; validation with seeded exceptions and zero false negatives; periodic challenge; QU approves the complete record | DI-26, PR-52 |
| Release on open investigation | Default block; e-signed QCU/QP/AP justification allowed | Never for reconciliation discrepancies or registered-specification failures | PR-53, IN-05(c) |
| CAPA | Whether a CAPA blocks release (default: no) | A CAPA that needs a master change cannot close before the new version is Effective | PR-51 |
| Numbering | Formats | Unique, never reused (voids included); rework gets a new number | IN-18, PR-10 |
| Label and report templates | Layout; optional content; artwork variants per market | Data bound from the record (no free typing); complete-record export cannot be trimmed; India-domestic template fields mandatory | DI-40, PR-36, IN-31 |
| Languages | Which languages; translations | Canonical storage; translations approved with the MBR version; meaning never changes | DI-02 |
| UoM catalogue | New units and conversions within dimensional classes, verified and approved | Dimensionally invalid conversions impossible | configurability |
| Master-data models | Classes, attributes, extra statuses, intervals, hold times | Mandatory statuses and gating behaviour | PR-18, PR-23 |
| Custom fields | Fields on batch, lot, equipment, sample and exception | A field used in logic, limits or labels is GMP data: audited, versioned, exported. No "non-GMP" flag is offered for such fields. | configurability |
| Interfaces | Which systems, field mappings, check depth by risk | No silent loss or defaulting; provenance kept; manual fallback flagged and verified | DI-31 |
| Device binding | Per step (default ON for weighing, dispensing and critical capture) | Device registry and source-ID stamp | DI-20 |
| Dispensing verification mode | Manual, or automated under 211.68(c) | At least one human verifier; reverts to two-person mode on fallback | PR-20, PR-14 |
| Line clearance | Checklist format for processing clearance (default ON); second verifier for packaging (default ON) | Checklist mandatory for packaging; [T] blister/strip independent verifier | PR-26, PR-34, IN-38 |
| Labelling reconciliation waiver (211.125(c)) | **Not offered for Indian-made product.** India has no waiver, and India is always in the market set. | Reconciliation always runs | IN-17, PR-39 |
| Excipient release by vendor history (Schedule M 14.15) | QA may enable it only for India-only batches, with a stored statistical justification. Default for new tenants: identity test on every lot. | A lot without an identity result is blocked for any batch with a US or EU market | IN-24, B-09 |
| Retention | Longer periods; legal holds | Floors = maximum across the applicable rules; no deletion before the retain-until date | DI-47, PR-59, IN-08 |
| Governance intervals | Periodic review (default 12 months); restore test (default quarterly); downtime drill (default yearly); integrity and readability job frequency | The checks must exist and raise alarms | DI-11, DI-43 to DI-45 |
| QP certification in-system | Tenant switch (default OFF) | When ON, only registered QPs can certify, and the certification register is append-only | DI-39, PR-55 |
| Market set per batch | Set at issue; packaging orders may narrow it under control | A change before release re-resolves the rules and forces QA review | PR-10, IN-52 |
| Offline mode | Per step type and duration | When ON, the DI-28 offline rules apply | DI-28 |
| Simulation mode | Availability | Segregation per DI-05 | DI-05 |
| [I] Numeric floors | Site values stricter than the floor | Hard numbers locked. Annex 1 guidance values (10 Pa, clean-up <20 min, 0.36-0.54 m/s) can be loosened only with a CCS reference and QA approval, and this is shown on every affected batch. | ST-01 |
| [I] Filter integrity | PUPSIT waiver per product/filter configuration, via an approved risk assessment | A post-use test is always required. **A pre-use integrity test is always required for Indian-made product** (Schedule M, B-17), even though FDA alone would make it optional. EU profile: pre-use test after sterilisation (PUPSIT). | ST-52, IN-48 |
| [I] APS rules | FDA/India tiered acceptance only on lines that make no EU/PIC/S product (India is still in scope there); grace periods need a recorded QA decision | Status per process × line × shift × configuration; default and maximum interval 6 months after the last success; EU "any positive fails" wherever an EU product runs on the line | ST-29, ST-33, B-10, B-11 |
| [I] EM | Alert levels from qualification data; locations and frequencies from the EM programme | Limits resolved to the strictest of India, EU and FDA; no alert tier for Grade A viable; settle plates ≤4 h; continuous Grade A particle counting | ST-18 to ST-20, IN-42, B-12, B-13 |
| [I] Filter reuse | Multi-lot reuse only on lines that make no EU/PIC/S product, with validation that states the maximum number of lots | EU: one batch only, and no longer than one working day without validation. India (always applies): no use past one working day unless validated for extended use. | ST-53, IN-48 |
| [I] Personnel | Shorter gowning requalification for manual processes; observation frequency (default monthly) | Gowning ≤12 months and APS participation ≤12 months before unsupervised Grade A/B signing | ST-08, ST-13 |
| [T] Weight bands | Versioned band tables per pharmacopoeia | The tighter band applies to multi-market products (band values U) | IN-34 |

### E.3 Building blocks, library elements and version pinning

**Block types (L1)**
- Vendor-defined. Each declares:
  - typed inputs and outputs;
  - parameters with allowed ranges;
  - execution mode: manual, semi-automated, or equipment-executed (configurability finding);
  - the prerequisites it checks;
  - the signature points it always carries (e.g., the charge-in block always carries a performer and a different verifier);
  - the exceptions it can raise;
  - the genealogy and logbook events it writes;
  - its rendering template;
  - its edition tag: both, tablets or injectables.
- Customers cannot create new primitive types.
- A partner SDK that adds block types, if one is ever offered, would be bespoke (GAMP Category 5) software with its own lifecycle. It is not configuration (configurability finding).

**Library elements (L3/L4)**
- Customer-built, parameterised compositions of blocks, e.g. "vessel drain", "IPC round", "reconciliation".
- They go through the same verification and approval as an MBR, once.
- MBRs then reference them and reuse the verification evidence. Per-MBR verification concentrates on parameter values and composition.

**Referencing rules**
- Every reference is **pinned to a version and content hash**. There are no "latest" references. Referencing "latest" would let an upstream edit silently change released masters; copying would stop fixes from propagating (configurability pitfall).
- A where-used index spans blocks and library elements, material and equipment-class master data, formulas, label templates, cited SOPs, and the training curricula tied to them.
- A change to any referenced object produces an impact report: affected MBRs, open batch orders, in-progress batches.
- A bulk "re-point and re-approve" workflow creates new MBR versions. Each still needs verification and approval.
- Batches in progress stay on their issued versions unless an approved change says otherwise (PR-05).
- The executed record snapshots every resolved version: MBR, library elements, formulas, specifications, SOPs, device recipe versions (DI-10).
- A block or library version can be retired only when no Effective MBR references it (DESIGN).

**Starter content**
- Each edition ships a vendor-validated starter library per process route, kept clearly separate from customer-authored elements.
- Vendors sell similar content packages [vendor].

### E.4 Generic masters, variant parameter sets and batch sizes

- **Structure vs variant data.**
  - Process structure is kept apart from variant data, to prevent MBR sprawl ([vendor] generic-MBR pattern; configurability finding).
  - A variant parameter set can change only declared parameters, never structure. Examples: strength, tooling set, tablet weight, coating weight-gain target, fill volume, lyo recipe ID, artwork per market.
- **Regulatory keying still applies.**
  - Every product × strength × batch-size combination (processing), and every product × pack size × pack type combination (packaging), must exist as an **approved master**.
  - In this model the approved master is the specific pairing (generic structure version + parameter set version). The approval signatures cover that pairing, and the issued record cites both versions (DESIGN interpretation of PR-01, IN-13, IN-14; confirm with customer QA).
  - A parameter set can never be used to create an unapproved combination.
- **Batch sizes.**
  - Only discrete sizes listed in the approved master. No free scaling at batch creation (PR-01, IN-13).
  - Whether a validated, registered size range with linear scaling is acceptable is an open question (PR F-11).
- **Equipment.** MBR steps ask for an equipment class and capability, with an allowed-units list. The engine binds the actual unit at execution and checks its status (PR-22, PR-23).
- **Markets.** A version becomes usable for a market only when that market's approvals or notifications are recorded. A multi-market batch runs inside the intersection of the registered ranges (PR-04).

### E.5 Safe expression language for calculations and branch conditions

| Property | Specification | Basis |
|---|---|---|
| Nature | Not Turing-complete, side-effect free, always terminates, statically typed, embeddable. CEL-like: an open-source precedent with these properties, extended with quantities and a pharma function library. | DI-33 (DESIGN, engine-enforced); configurability finding |
| Scope | Can read only the inputs it declares. Cannot write data, do I/O or reach other records. No unbounded loops. Aggregates only over declared arrays (e.g., the 20 tablet weights of an IPC round). | guardrail; DI-33 |
| Types | Decimal; Quantity (value + UCUM unit + semantic tag such as % w/w, % label claim, % LOD, % yield, count of units); Integer; Boolean; Enumeration; Instant (UTC); Duration | configurability finding |
| Units | Dimensional analysis when the formula is written. Mixing incompatible quantities (e.g., adding % LOD to % yield) is refused. Conversion factors come from the approved UoM catalogue. | configurability finding |
| Arithmetic | Decimal arithmetic at decimal128-class precision, never binary floating point. Example: raw 94.95 against a limit of 95.0-105.0 with one decimal place must round to 95.0 and pass. Binary floating point can hold it as 94.9499… and fail it wrongly. | configurability finding |
| Rounding | Full precision carried through every intermediate step. Rounding is attached to the **limit comparison**, not to the stored value: to the decimal places of the limit (USP General Notices 7.20) or to its significant figures (Ph. Eur. General Notices), always **half-up**. Many libraries default to half-even, and must be overridden. Both raw and reportable values are stored. A displayed rounded value is never fed back into a calculation. | configurability findings; IN-33 |
| Function library | Closed and vendor-validated: arithmetic, min/max, mean, SD (n-1), RSD, yield %, potency/assay/LOD-adjusted quantity with compensating excipient, reconciliation balance, durations, uniformity-of-mass bands from versioned tables, compendial acceptance procedures as registered. Customers choose and parameterise functions; they do not re-implement compendial statistics. | configurability finding; IN-34 |
| Error handling | A missing input, division by zero or an out-of-domain value produces an explicit error state that raises an exception. There is never a silent default such as 0. | configurability finding |
| Evaluation | On the server, in dependency (topological) order. Cycles and unresolved references are rejected when the formula is written. Results are read-only. Overriding a calculated value is an exception. | DI-33; research |
| Trace and history | Every result stores its expression version, its inputs with units and sources, conversion factors and the output. Correcting an input recalculates the dependents, keeps the superseded results, and flags any dependent already signed so it must be re-verified. | DI-33, DI-37 |
| Verification | Each expression ships with test vectors written by its author: typical values, values at each limit and at rounding boundaries, absent inputs, and zero/negative guard cases. The designer runs them automatically, and the results go into the verification report. | configurability finding; DI-04 |
| Branch conditions | Same language, returning Boolean. Every branch must be reachable and exercised in a test run (E.6). Alternative branches need an exhaustive "else". | research linting |

### E.6 MBR lifecycle and verification workflow

**States:** Draft → In verification → Checked → Approved → Effective, then Superseded → Retired. A version that is withdrawn before becoming Effective goes to Withdrawn.
- Approval does not make a version executable before its effective date (PR-02).
- Draft and test masters run **only** in the sandbox (DI-05).
- A GMP record can come only from an Effective version (DI-42).

**Gate sequence** (the engine will not advance a version until each step is complete):

1. **Change link.** An approved change record exists. It holds the risk assessment, the impact assessment (specifications, equipment, validation, cleaning, training, labels, shared lines, other sites) and a regulatory-impact decision per market. [I] It also holds a CCS-impact assessment. (PR-06, IN-03, ST-03)
2. **Automated static checks.** These block submission to the checker.
   - *Content minima for the market set:* processing items (a)-1; packaging items (a)-2; the India master items, including a hold time for every intermediate and an India-domestic artwork specimen; one of the 211.122(g) options where cut labels are used; a reserve-sample step; the OTC flag where set (PR-03, IN-13, IN-14, PR-36, PR-44, PR-41).
   - *Graph:* every node reachable; every path reaches the end; no unintended cycles; loops have exit conditions; parallel branches converge.
   - *Data points:* a type, unit, precision and range or list on every data point; no inverted limits; limits within registered values (PR-02, PR-04).
   - *Formula:* BOM total consistent with batch size; the formula delivers ≥100% of the labelled active; calculated excess and lost-in-process flags kept separate (PR-19, PR D-17).
   - *Verification points:* every critical manual field has an accuracy-check method (DI-30); significant steps carry performer and checker (PR-14); the 211.68(c) automated flag is used only on permitted step types (PR-14).
   - *Risk:* every critical element cites a risk assessment (PR-07, DI-07); nothing used in a quality decision is classed below raw data (DI-01).
   - *Timers and yields:* every timer has a validation reference (PR-30, ST-37); every yield checkpoint has a basis and min/max (PR-31); reconciliation limits exist (PR-39); IPC plans are complete (PR-29); [T] compression interval ≤30 minutes (IN-35).
   - *Systems:* PAT steps have acceptance criteria and a model version; the computerised systems relied on are named, with recipe versions (DI-04).
   - [I] *Sterile checks:*
     - CCS ID and version on every critical control point;
     - sterility-route justification;
     - step grades consistent with mapped rooms;
     - PUPSIT step, or a referenced waiver;
     - 100% CCI for fusion-sealed containers ≤100 mL;
     - a sterilisation method for every product-contact item (VHP only for heat-labile items, with a ≥6-log reference);
     - open-container routing only through Grade A;
     - the mandatory timer set present.
     (ST-02, ST-14, ST-37, ST-42, ST-52, ST-55, ST-64, IN-41)
   - *Market-profile resolution run:* the resolved values and their governing markets are shown for review (IN-52).
   - *Translations:* each enabled language is complete.
3. **Formula tests.** All test vectors pass (E.5).
4. **Test runs in the sandbox.**
   - *Scripted runs for high-risk steps:* every branch and loop exit; each critical limit just inside, on and just outside (DI-06); every exception path; timer breaches; status blocks (quarantined lot, dirty equipment, expired training); device fallback to manual entry.
   - *Unscripted walk-through:* by operators in realistic conditions, for usability.
   - Simulated device inputs are allowed.
   - A coverage report shows what was exercised.
   - This is the product's chosen method. The rules require only a verification record, and any sound method is acceptable (DI-04, DI (c) 14).
5. **Side-by-side review.** The rendered MBR (operator view and PDF) is compared with the approved process description and the registration dossier.
6. **Verification report.** Evidence from steps 2-5 is assembled and linked. QA cannot set Effective without it (DI-04).
7. **Signatures.** Prepared (author) → Checked (a different person) → QU-approved. Regulatory-conformity sign-off. The effective date is mandatory (PR-02, PR-04; separations S1-S4).
8. **Training.** Read-and-understand tasks go out automatically. Users cannot execute the new version until trained (DI-21, IN-04(e)).
9. **Effective per market.** A market becomes valid once its approvals or notifications are recorded. The previous version stops accepting new batches (PR-04, PR-05).
10. **After go-live.**
    - The first batch after the change is flagged "post-change evaluation required", and release waits for the QA evaluation (IN-03(c)).
    - A protocol batch (PPQ/concurrent) carries its flag until the outcome is recorded (PR-09).
    - A periodic-review due date is set (PR-05).
    - Recurring exceptions on a step open a risk re-review, and RBE for that step pauses (PR-07).

### E.7 Validation strategy: GAMP 5 Category 4 platform plus per-MBR verification; CSA as supporting rationale

- **Category.**
  - GAMP 5 Second Edition (2022) treats software categories as a continuum and puts critical thinking first (s).
  - The eBMR platform is a **configured product (Category 4)** on infrastructure (the database manager is Category 1) (s).
  - MBRs built only from vendor block types are configuration.
  - Customer scripts, reports with embedded logic and custom interfaces would be bespoke and need their own specifications and tests (DI-03). The product therefore offers **no script escape hatch** in GMP masters (DI-33).
- **Tier 1: platform, once per vendor release.**
  - Vendor package: risk-based requirements, design/configuration specifications, test evidence including negative and boundary tests, validation deviations and their resolution, known issues, SDLC/QMS evidence, generated traceability matrix, and a paragraph for the site master file (DI-03, DI-06, IN-12).
  - Customer: supplier assessment scaled to risk (DI-08); risk-based verification of its intended use; an e-signed release-acceptance record **per tenant** before any GMP batch runs on that release. Every batch records the release it ran on (DI-03, DI-10).
- **Tier 2: configuration, every version.**
  - Every MBR, library element, workflow, report, calculation, interface mapping and RBE rule set is verified before it becomes Effective (DI-04).
  - This is FDA's explicit position: qualifying the platform does not show that a given electronic master calculates and behaves correctly (FDA DI Q&A Q3, cited in DI-04).
- **Each change classifies itself.** The system tags every change as one of:
  - (a) platform release: full regression plus tenant acceptance;
  - (b) rule-table version: impact list of the MBRs using changed values, plus change-control tasks. Example: making IP 2026 effective lists every MBR citing IP 2022 (IN-33);
  - (c) configuration item: its own change control plus verification;
  - (d) MBR or library element: the E.6 workflow.
- **Regression across many MBRs after an upgrade.**
  - Automated golden-batch suites per block type and per representative MBR. Generated records and audit-trail entries are compared with expected outputs.
  - Archived records created under earlier versions are re-rendered (DI-46).
- **CSA.**
  - FDA finalised *Computer Software Assurance for Production and Quality System Software* on 24 Sep 2025 (FR 2025-18468) (s). It was reportedly reissued on 3 Feb 2026 with QMSR-aligned terminology (s).
  - It is a **device** guidance (CDRH/CBER). It does not bind a Part 211 drug eBMR.
  - The binding basis is 21 CFR 211.68 and Part 11, EU Annex 11, and Schedule M Part I section 20.
  - CSA is used only as rationale for scaling assurance to risk:
    - *high process risk*, tested with scripted methods: limit checks, calculation engine, e-signature binding, status and release interlocks, record generation, audit trail, interfaces, RBE rules;
    - *lower risk*, tested with unscripted methods (exploratory, scenario, error-guessing) plus supplier evidence: UI layout, dashboards, notifications.
    - The approach and results are recorded in both cases. (Configurability findings; PR (c) C-29; DI-03.)
  - ICH Q9(R1) supports formality proportional to risk (s).

### E.8 Moving configuration between environments

- **Environments:** development → validation/test → production. There is never direct database editing in production, and no admin path changes specifications, parameters or MBR content outside the change workflow (DI-09).
- **Packages:** an MBR with its dependent library elements and master data is exported as a **signed package with a content hash**. The target verifies the hash on import, so the object tested is provably the object released (configurability finding; [vendor] precedent).
- **Baselines:** each environment keeps an exportable configuration baseline that can be diffed; any departure from the validated baseline triggers an alarm. An undocumented interface or device triggers the system-inventory drift alarm (DI-06, DI-09).

### E.9 What "customisable within the edition" means: Tablets vs Injectables

| Aspect | Tablets edition | Injectables edition |
|---|---|---|
| What a customer can model | Any oral tablet product and route, by composing the closed tablet library: granulation route, compression type, coating type, primary pack type, market variants | Any sterile injectable route: terminally sterilised, aseptic, or aseptic plus a post-aseptic step; solutions, suspensions and emulsions, sterile powders, lyophilised products; vials, ampoules, cartridges, PFS, bags; isolator, RABS, conventional line, BFS, FFS, SUS; small molecules and biologics (research (u)) |
| What drives customer values | Process validation and registration: CPP limits, IPC plans (within the India ceiling), tooling sets, coating targets, cleaning/HBEL references | The **CCS** and site validation: time-limit values, EM locations and frequencies, intervention catalogue, validated cycle recipes and load patterns, filter trains and test limits, garment wear times, AQL plan, disinfectant rotation |
| Domain master data | Granulators, FBDs, roller compactors, mills, blenders/IBCs, rotary presses with tooling, coaters, dedusters/metal detectors, blister/strip/bottle lines; IPC test types; OSD rooms with DP/T/RH limits | Rooms graded A-D with ISO classes; isolator/RABS; autoclave, SIP circuit, tunnel, oven, lyophiliser and filling-line classes; filter and SUS types; EM sample types; defect library; WFI loops and points of use; Part XIII area types (IN-51) |
| Locked domain rules (examples) | Station-wise start check; ≤30-min compression IPC ceiling; tooling and sieve checks before and after use; container-level hold on IPC failure; non-overlapping adjacent pressure ranges; QC gate after printing; independent blister/strip clearance; hazardous-class containment steps | ST-01 floor table; APS gate and failure consequences; continuous Grade A coverage; mandatory timer set; filters matching the registered part number; post-use integrity test; mandatory pre-use test (India); 100% VI and 100% CCI for fusion-sealed ≤100 mL; sterility/endotoxin release rules; a passing sterility test never overrides a process failure |
| Turning a control off ("N/A") | Only for items the rule itself makes conditional ("where applicable/appropriate"), with a signed justification (PR-03) | The same, and in addition any Annex 1-derived control can be marked not applicable **only** by referencing an approved risk assessment plus QA approval of the MBR (e.g., a PUPSIT waiver). The waiver ID shows on every batch and at QP/AP review (ST-52; configurability finding) |
| Scope of a rule | Mainly per product and batch | Per product for product rules. **Line-, room- and person-level rules** (APS, EM limits, requalification, operator qualification) take the strictest value among all products qualified on that line or room, since a single body of APS/EM evidence underpins all of them (sterile conventions) |
| Blocks that do not exist in the edition | Filter integrity, sterilisation cycles, lyophilisation, Grade A interventions, EM plans | Granulation, compression, coating, tablet IPC blocks |
| What stays identical | The kernel (identity, signatures, audit trail, calculations, status engine, exceptions/RBE, records, retention, market-profile engine): **one validated kernel version in both editions**. Whether the editions may share code is an open question (configurability open question), but separate kernels would double validation effort and let guardrails drift. | Same |

### E.10 Market-profile rule tables

- **Inputs.** Each batch declares its target markets at issue (India always, plus US and/or EU). Each pack/SKU declares its destination class: India domestic, India export (Rule 94 (u)), US or EU (IN-52, IN-31).
- **When rules are resolved.** At six points: approval of the MBR, start of the batch, execution, release, retention of samples, and archiving. Each parameter then takes the **strictest** value found across India and the batch's markets. It stores the resolved value and the market that drove it. A change to the market set before release re-resolves everything and forces QA review (IN-52).
- **Examples of resolved rules:**
  - Retention: maximum of expiry + 1 y (US, India), manufacture + 5 y (India Rule 74 (u)), and QP certification + 5 y (EU). Stays "open" while an EU certification date is unknown (B-01, DI-47, PR-59).
  - Reference samples: twice the full test quantity **including** sterility tests (India (s)), kept for expiry + 1 y when the US or EU is in the set (B-02, B-26).
  - [I] APS acceptance: any positive fails if an EU product runs on the line (B-10, ST-33).
  - [I] Grade B in-operation ≥5 µm limit: India's 2,900/m³ is lower than the EU's 2,930/m³, so India governs (B-13).
  - [I] HEPA leak-test interval: 6 months for A/B when the US or EU is in the set (B-16).
  - [T] Weight-variation bands: IP bands, which are tighter than the legacy USP bands (B-14, U).
  - Label: date of manufacture uncoded on India-domestic packs only (B-15).
- **Rule-table versions.** Tables are vendor-maintained and versioned. A regulatory change (e.g., a new IP edition, a Schedule H2 date, final EU Annex 11/Chapter 4 texts) ships as a new table version, with an impact list and the change-control tasks it triggers.

---

## F. Pitfalls to design against

### F.1 Product and design pitfalls

| # | Pitfall | Design countermeasure | Where |
|---|---|---|---|
| P1 | **Paper on glass**: copying paper forms one-to-one, with free-text fields and signatures on "pages". No structured data, no enforceable limits, no real RBE. | MBRs are data: typed blocks, device capture, bound master data. The designer flags free-text capture of any value that has a typed block. | S18, E.3 |
| P2 | **Over-customisation**: scripts, SDK blocks, or generic app builders where each customer rebuilds GMP semantics (verification, reconciliation, status checks). This creates Category 5 validation debt and blocks upgrades. | Closed block types; no script escape hatch; calculations only in the sandboxed language. Anything outside is bespoke with its own lifecycle. | E.3, E.5, E.7; DI-03, DI-33 |
| P3 | **Test switches that bypass master approval** (seen in one configurable platform [vendor]) | Draft and test masters run only in the sandbox. A GMP record can come only from an Effective version. | DI-05, DI-42 |
| P4 | **RBE bolted on afterwards**: too noisy (QA goes back to full review) or too sparse (manual entries and overrides slip through) | Mandatory exception taxonomy; validation with seeded exceptions; periodic challenge against sampled full reviews; default full review until the confidence criterion is met; audit-trail review always included | DI-25, DI-26, PR-52 |
| P5 | **Trusting interface or automation data** without validated interfaces and device checks, which silently breaks the assumption RBE relies on | Per-interface checks, provenance, device registry and binding; fallback to manual is always flagged and verified | DI-20, DI-31, DI-32 |
| P6 | **Hard stops with no defined response** (people work around them) **or soft warnings** (people click through) | Every check has a declared severity, response and escalation. Locked blocks offer non-override next steps; configurable checks offer the deviation path. | U3, U12 |
| P7 | **Time-of-check/time-of-use gaps**: status checked only when the step opens | Material, equipment, room, training and timer status re-checked at commit and at signing | S2; research |
| P8 | **Weak identity hygiene**: shared accounts, signing for someone absent, open sessions on shared terminals, admins with GMP rights, changeable clocks | Personal accounts only; badge + PIN per entry; kiosk lock; admin segregation; server time | DI-14, DI-18, DI-27, DI-38 |
| P9 | **Business continuity never designed or tested**, so an outage stops production or produces uncontrolled hybrid records | Controlled contingency forms, reconciliation, verified back-entry, drills. Aseptic filling has a pre-staged, immediate fallback. | DI-43 |
| P10 | **Undefined hybrid state**: no agreed record of truth per data element | Register of record types and hybrid points, each with its official medium and linkage method | DI-01, DI-41 |
| P11 | **Big-bang multi-site roll-out without harmonised master data** (UoM, codes, equipment classes, reason codes). The global template collapses. | Core library per edition; site libraries extend it but never fork it; divergence report per site | E.1, E.3 |
| P12 | **Treating MBR build and verification as light work.** An MBR behaves like software and needs the same rigour. | Library elements with reusable evidence; verification workbench; authoring standards; dry runs with users before approval | E.6 |
| P13 | **Ignoring shop-floor ergonomics**: gloves, visors, device placement, Wi-Fi in steel rooms, label print quality, slow screens | Glove-sized targets; mock-cleanroom usability tests; site surveys; performance budgets | U7, U20, D.5 |
| P14 | **Fragile integrations**: duplicate or missing goods movements, status mismatches | Outbox with guaranteed delivery; idempotency keys; reconciliation reports; error queue triaged by GMP impact | DI-31 |
| P15 | **Versioning mistakes**: batches on superseded versions; uncontrolled in-flight changes; translations not versioned | Pinned versions; superseded versions blocked for new batches; in-flight rule defined; translations approved with the MBR | PR-05, E.3, D.4 |
| P16 | **Equipment and room status not integrated**, so paper logbooks and status tags carry on in parallel | Equipment and room state machines gate steps; logbooks filled from execution | M13 |
| P17 | **Performance and data-volume blind spots**: records of thousands of pages, audit-trail growth, multi-year genealogy, peak-shift load | Load the record per unit procedure; precomputed exception index; historian data held as references plus summaries; paginated audit trail; approved MBR compiled into an immutable execution graph; peak-shift load tests (configurability finding) | M09, M19 |
| P18 | **Archiving and system retirement not planned** | Archive with fixity and readability checks; re-render tests after upgrades; full exit export with audit trails and signatures | DI-08, DI-46 |
| P19 | **Validation that is heavy on documents but blind to risk**, or the reverse | Two-tier model; testing depth scaled to risk; deep evidence for calculations, limits, signatures, audit trail and interfaces | E.7 |
| P20 | **Graph database as the system of record** | Genealogy edges live in the transactional store, committed atomically with their events. Any graph database is a rebuildable projection. | PR-57 |
| P21 | **Genealogy modelling errors**: mutable edges; missing partial containers, returns, rework or samples; time-zone ordering errors | Immutable edges, with compensating edges for corrections; every movement modelled; UTC ordering | PR-57, DI-27 |
| P22 | **AI as the decision-maker**, or drifting and unlogged AI output in the record | AI stays advisory. No GMP data or status changes without a human e-signature. Model version and output logged. Static validated models only for critical use (draft Annex 22 (s)). | PR-60; C ranks 20-21 |
| P23 | **Vendor lock-in and upgrade paralysis** | BatchML/B2MML export; full exit export; no customer code in the kernel | C rank 19; DI-08 |
| P24 | **Serialisation and label-control gaps; uncontrolled reprints** | Variable data sent from the record; print checks; reprints need a reason and void the original; serial reconciliation | PR-36, PR-39, PR-42, DI-42 |
| P25 | **Locale defects**: decimal comma vs point, DD/MM vs MM/DD, translations that change meaning | Canonical storage; parse with echo-back; unambiguous dates; approved translations | D.4 |
| P26 | **Running eBMR as a pure IT project**, with few super-users and little operator input | Operators in design and usability tests; super-user network; training runs in simulation mode before the effective date | U20; C rank 6 |
| P27 | [I] **Annex 1 evidence left in side systems or on paper** (interventions, time limits, integrity tests, cycles, EM/APS), so release still depends on manual collation | All of it in batch context; signed dossier sections; consolidated timeline | I04 to I17; ST-70 |
| P28 | [T] **Potency adjustment, IPC frequency and press data left to manual calculation and entry**, the highest-risk area for errors | Calculation engine; IPC scheduler with ceiling; press and checkweigher capture | M10, T03, T04 |
| P29 | **Unsynchronised clocks** across PLCs, edge devices, historian and servers | Server time for actions; device timestamps stored as data; drift monitoring with alarm and incident; time source recorded | DI-27 |
| P30 | **MBR sprawl**: separate MBRs per strength, pack, market or language | Generic structure plus approved variant parameter sets; translations inside the version | E.4 |
| P31 | **Too many or too few signatures** | Granularity follows risk; rule-required signatures are never grouped away | U16; PR-07 |
| P32 | **Configuration drift** between environments or sites | Signed packages; baselines; drift alarms | E.8 |
| P33 | **Custom fields or report templates escaping GMP controls** | GMP fields inherit audit trail and versioning; complete-record export cannot be trimmed | E.2; DI-40 |

### F.2 Accuracy traps: claims that sound right but are wrong (the catalogs' position)

| # | Tempting claim | Correct position | Source |
|---|---|---|---|
| A1 | Review by exception replaces QA review of the record. | RBE is only a validated **method for performing** the full QU review; the QU still signs off the entire record, with drill-down to everything. The FDA DI Q&A is silent on RBE as such and expects firms to demonstrate that their review is reliable. | DI-26, PR-52, PR C-12 |
| A2 | Audit-trail review can be limited to critical data, or deferred until after release. | Every post-entry change to batch data is in scope; criticality only orders and highlights. Review is signed before disposition, with no deferral option. | DI-25; DI (c) 16; DI (d) 1-2 |
| A3 | Part 11 or Annex 11 set numbers for password length, aging, lockout or timeout. | They set none. All such numbers are design defaults. | DI (c) 1-2 |
| A4 | 11.10(e) requires a reason for change; Annex 11 (2011) makes an audit trail mandatory. | The audit trail is mandatory through 11.10(e). The reason comes from Annex 11 §9. The kernel requires both. | DI (c) 3-4 |
| A5 | Regulations require three different people to sign an MBR. | They require a preparer, an independent checker and QU approval. The checker may be the QU approver. Three distinct signers is the product default. | PR-02, PR C-1 |
| A6 | 211.186(a) needs a wet-ink signature on the master. | A Part 11 e-signature is equivalent, provided the firm's 11.100(c) certification letter has been filed with FDA (tracked per US tenant). | PR C-2, PR D-21, DI-15 |
| A7 | An Indian exporter's eBMR must hold the EU QP's certification signature. | The EU QP normally certifies at the EU importing site. The Indian site signs an AP (manufacturer) release. The system supplies the batch package and stores the external certification reference. | India correction 8; PR-55; DI (c) 28 |
| A8 | Cut or roll labels examined 100% electronically need no reconciliation. | That waiver is US-only (211.125(c)), is never available when the EU is in the set for bulk and batch-coded material, and **India has no waiver**. Since every batch is Indian-made, the waiver is never offered. | IN-17, PR-39, PR D-6 |
| A9 | One MBR can scale freely across a batch-size range. | Only the discrete sizes listed in an approved master (one master per product and batch size). Whether a validated range is acceptable is an open question. | PR-01, IN-13, PR F-11 |
| A10 | A validated balance interface removes the need for any human check at dispensing (211.68(c)). | At least one human verifier is always required, and the scope of 211.68(c) is limited. Schedule M alone would accept a validated interface as the independent check (IN-23), but the kernel never allows zero-human verification in any profile. The US-market default keeps a second person. | PR-14, PR-20, DI-30, PR D-15 |
| A11 | Show pass/fail while the operator types, and restore unconfirmed input after a timeout. | Commit first, then show the verdict. No client-side drafts of executed GMP data. | DI-28; U4, U11 |
| A12 | Block data capture when a clock drifts. | Raise an alarm and an incident, flag the affected entries, and use the controlled contingency path. Blocking without a fallback pushes people to scrap paper. | DI-27; DI (d) 17 |
| A13 | Every line clearance needs two people, and processing clearance needs a checklist. | Two people only if the firm designates clearance a significant step (US), except blister/strip lines, where India requires an independent check. A checklist is required only for packaging clearance. | PR C-3, C-4, D-5; IN-38 |
| A14 | Release is impossible until every CAPA and every investigation is closed. | Default block on open deviations and investigations. An e-signed justification is allowed, except for reconciliation discrepancies and registered-specification failures. CAPA completion is not a release criterion by default. [I] investigations must be closed or formally assessed as not affecting the batch. | PR-51, PR-53, PR D-8, ST-71, IN-05 |
| A15 | FDA's CSA guidance is binding for a drug eBMR. | It is a device guidance: persuasive, not binding under Part 211. | PR C-29; E.7 |
| A16 | FDA expects an MBR simulation/dry-run mode. | FDA expects each electronic master to be verified, by any sound method. The sandbox is the product's choice. | DI (c) 14; DI-04 |
| A17 | 211.67 sets clean-hold and dirty-hold limits. | The values come from cleaning validation. India requires data-based time limits for cleaned equipment (IN-25), and the engine enforces them once set. | PR C-5, PR-23, IN-25 |
| A18 | Training-gated hard stops are required by 211.25. | The rules require trained staff, not system gating. The product enforces the gate anyway: DI-21 default, and ENFORCED for India-licensed sites (IN-04). | DI (c) 20; IN-04 |
| A19 | FDA's DI Q&A lets small sites combine administrator and QA roles. | The final Q&A has no such fallback. | DI (c) 15; DI-18 |
| A20 | Printed name and meaning in the signature come from Annex 11 §14. | They come from 11.50. The union is applied. | DI (c) 5; DI-36 |
| A21 | "Temporary memory" is FDA wording. | It is EMA Q&A wording. Commit-before-evaluate satisfies both. | DI (c) 17 |
| A22 | Retention is expiry + 1 year. | It is the maximum across the applicable rules: EU is 5 years after QP certification; India's Rule 74 period is (u); DSCSA data 6 years (s). An unknown EU certification date keeps retention open. | DI-47, PR-59, IN-08 |
| A23 | [I] The Grade A ≥5 µm limit of 29/m³ applies to classification. | It applies to monitoring only; classification leaves it unspecified. India's Grade A table value is 20/m³, lower, so India governs the resolved limit. | ST-19, ST conflict 21, IN-40 |
| A24 | [I] FDA ISO 8 microbial limits are looser than EU Grade D. | The opposite: ISO 8 (100 CFU/m³ air; 50 per 4 h settle plate) is stricter than Grade D (200; 100). | ST-20, ST conflict 16 |
| A25 | [I] FDA's tiered media-fill acceptance applies to Indian exporters. | Only on lines with no EU/PIC/S product. Otherwise any contaminated unit fails the APS, and product made since the failure is quarantined. | ST-33, B-10 |
| A26 | [I] APS twice a year per line is enough. | The EU requires it per process, line **and shift**; FDA per line. The stricter rule governs where the EU is served. | ST-29, ST conflict 1 |
| A27 | [I] 20-35 °C and 14 days for media-fill incubation are Annex 1 numbers. | They are FDA 2004 numbers, used as the enforced default. Annex 1 requires justified, validated conditions. | ST-32, ST conflict 14 |
| A28 | [I] 100% visual inspection can count as the CCI test. | Never. Fusion-sealed containers ≤100 mL need 100% CCI by a validated method. | ST-64 |
| A29 | [I] PUPSIT has no exceptions, or is optional. | EU expects it, with a documented risk-assessed alternative where justified. FDA says it can be done. **India requires an integrity test before use in every profile.** | ST-52, IN-48, B-17 |
| A30 | [I] A validated filter can be reused across lots. | Only on lines that make no EU/PIC/S product, with validation stating the maximum number of lots, and never past one working day unless validated (India always applies). Where EU product runs: one batch only. | ST-53, IN-48 |
| A31 | [I] The India HEPA interval (warning at 6, block at 12 months) is enough for exports. | Grade A/B rooms are 6 months whenever the US or EU is in the set. | IN-43, B-16 |
| A32 | [I] India's microbial table gives averages, so averaging results is fine. | Each result is evaluated individually. India calls its values averages and informative; the EU values are maximum action limits, and no Grade A growth is allowed. | IN-42, ST-20 |
| A33 | [I] Copy the FDA-AP glossary wording for SAL. | That parenthetical states the probability inverted. Configure SAL as ≤10⁻⁶. | ST-60, ST conflict 18 |
| A34 | [T] India's 30-minute rule covers all six tablet parameters. | The 30-minute maximum applies to sampling against the in-process specification. The six named parameters are checked periodically at a frequency the MBR sets (confirm inspector expectation). | India correction 5; IN-35; G-4 |
| A35 | [T] USP and IP weight-variation bands are interchangeable. | For tablets weighing 80-130 mg or 250-324 mg, the IP bands (u) are narrower than the older USP in-process bands; current USP ⟨905⟩ judges uniformity by an acceptance value instead. The tighter band applies to multi-market products. | IN-34 |
| A36 | [K, India] Excipients can be released on vendor history for any batch. | Only for India-only batches, and only when QA enables it. Otherwise each lot needs an identity test. | IN-24, B-09 |
| A37 | [K, India] A reworked batch keeps its number; hold times are optional; manufacturing date is optional on labels. | New number on rework; hold time mandatory for every intermediate; uncoded manufacturing date mandatory on India-domestic packs. | IN-18, IN-13, IN-31 |
| A38 | [K, India] A password e-signature certainly satisfies Indian law. | Legally uncertain under IT Act s.5. The product offers a DSC/eSign option for key meanings; counsel's opinion is needed. | IN-10; India D.3-D.5 |
| A39 | [K, India] DGFT export barcoding and iVEDA uploads are still required. | Withdrawn on 31 Jan 2025 (s). Destination serialisation belongs to the US and EU layers. | India C.4, E |

### F.3 Open questions to settle before build (subset relevant to this spec)

1. **Final EU texts.** Wording and dates of the final EU Annex 11, Chapter 4 and Annex 22. Then re-run the gap check on identity and access, audit trail, signatures and AI features (DI (f) 1).
2. **211.68(c) for automated dispensing.** Can dispensing or charge-in drop to one person for US-market products (DI (f) 3, PR F-1)?
3. **Indian e-signatures.** Is a password signature enough under IT Act s.5 for AP release and master approval? Which signature meanings should default to DSC/eSign (India G-2)?
4. **RBE confidence criterion.** Its definition per customer, and whether any FDA-facing site will switch RBE on (DI (f) 9).
5. **Audit-trail reviewer independence.** Does a QA person who did in-process checks count as "involved"? The default excludes them (DI (f) 13).
6. **Batch sizes and generic masters.**
   - Is a validated batch-size range acceptable (PR F-11)?
   - Do regulators and customer QA accept approval of a (generic structure + parameter set) pairing as "the master" (E.4, this spec)?
7. **Tablets edition scope.** Are capsules included (T01, this spec)?
8. **Kernel sharing.** One shared, validated kernel code base for both editions, recommended here, or separate code bases (configurability open question)?
9. **PUPSIT waiver approval.** QA only, or QA plus the AP/QP route (configurability open question)?
10. **Pharmacopoeia rounding.** USP vs Ph. Eur. convention per specification, and any registration-specific rule (configurability open question). **Scope:** US OTC products without expiry, and clinical batches (configurability open question).
11. **Build vs integrate.** Which systems are integrated (EMS, LIMS, QMS, LMS) and which are provided as minimal built-in modules? Several locked gates depend on these interfaces (configurability open question; ST open question 11).
12. **[T] India 30-minute rule.** Which parameters do Indian inspectors expect at the 30-minute interval? IP 2026 band wording (India G-4, G-8).
13. **[I] Site values.** AQL values; APS grace period (default none); extended-inactivity trigger for APS; DP default of 10 vs 12.5/15 Pa for US exporters (ST open questions 1, 2, 4, 8).
14. **UX items needing customer QA/IT sign-off:**
    - the dispensing-gauge reading of commit-before-evaluate (U4);
    - accessible-authentication methods on shop-floor kiosks versus the no-remember-password policy (D.3);
    - which regional languages to ship, and the digit-display policy (D.4).

