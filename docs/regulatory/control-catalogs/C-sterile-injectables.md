# Injectables eBMR: Sterile Control Catalog (EU Annex 1 2022 / FDA 2004 aseptic guidance / 21 CFR 211)

Input: `register/bucket-sterile.jsonl` (329 rows). Numbers, clause references and FDA-vs-EU comparisons were re-checked against `primary/eu-annex1-2022.txt`, `primary/fda-aseptic-processing-2004.txt` and `primary/21cfr211.txt`. India Revised Schedule M is covered by the separate India catalog; where Schedule M is stricter, it overrides the rules below.

## Conventions

- **EU** = EU GMP Annex 1 (2022). In force since 25 Aug 2023; clause 8.123 (lyophiliser sterilisation frequency) applies from 25 Aug 2024. Annex 1 is mostly written as "should". The Scope section, however, says that any specific limit, frequency or range is a **minimum requirement**. The few declarative or "must/need to" statements are marked **[EU hard]**.
- **US** = 21 CFR 211 ("shall", binding). **FDA-AP** = FDA guidance *Sterile Drug Products Produced by Aseptic Processing* (Sept 2004). It is nonbinding apart from the text boxes that restate Part 211.
- **Market-profile rule (stricter wins).** Each product carries a list of markets (US, EU/PIC/S, others). Product-level rules use the strictest rule among those markets. Line-, room- and person-level rules (APS status, EM limits, requalification, operator qualification) use the strictest rule across every product qualified on that line or room, because one set of APS/EM evidence supports all of them. The default shipped profile is "EU + US". A US-only relaxation can be chosen only for a line that makes no EU/PIC/S product.
- **Type.** ENFORCED = a hard rule in code, not configurable. CONFIGURABLE = a parameter with a shipped default and an allowed range, which can be tightened but never loosened beyond the floor (ST-01). DESIGN-CHOICE = a product design proposal that the text does not demand; it can be switched off per site with a recorded rationale.
- **Gate vocabulary.** *Block* = the step cannot be started or signed. *Deviation-gate* = work continues only after a deviation is raised and QA records a decision. *Release block* = the QA disposition / QP certification e-signature is unavailable.
- Scope values: aseptic, terminal, lyo, all, and the technology profiles isolator, rabs, bfs, ffs, sus.
- "Covers" lists register row numbers (nNNN).

---

## Theme 0: Cross-cutting rules (apply to every theme)

### ST-01: Regulatory-floor table for every numeric limit
- **Theme:** 0 (configuration guard)
- **Covers:** n391
- **Scope:** all
- **Type:** ENFORCED (floor table locked). Individual site values are CONFIGURABLE only in the tightening direction.
- **Behaviour:**
  - The system ships a locked, versioned table of every numeric floor used in this catalog. Examples: Table 5/Table 6 limits; 6-month (Grade A/B) and 12-month (Grade C/D) requalification; about 6-month APS per process, line and shift; 12-month operator APS, gowning and visual-inspection requalification; 4 h maximum settle-plate exposure; 28 L/min minimum Grade A counter flow; weekly steriliser leak test; daily air-removal test; annual worst-case heat-cycle revalidation; 0.22 µm maximum sterilising-filter rating; 100 mL fusion-seal CCI threshold. Each entry stores its source, clause, market profile and whether it is a **hard number** or an Annex 1 **guidance value**.
  - Saving a site value looser than a hard number is rejected, with no override. Loosening an Annex 1 *guidance value* (10 Pa step between grades, clean-up time under 20 min, 0.36–0.54 m/s UDAF speed) needs a CCS justification reference and QA approval, and is shown on every affected batch.
  - Every limit is versioned. Each result, check and timer stores the limit version it was evaluated against.
- **Citations:** EU Annex 1: 1 (Scope, para 2), 4.14, 4.29(iii), 4.30 | US: none equivalent (FDA-AP Table 1 note c lets firms set alternative microbial action levels with justification).
- **FDA vs EU:** EU is stricter. It turns stated numbers into minimums, while FDA-AP allows justified alternative microbial action levels.
- **Verify:** Configure a Grade B active-air action limit of 15 CFU/m³ → rejected. Configure a 7 Pa B/C differential → accepted only with a CCS reference and QA e-signature.

### ST-02: Product sterility-assurance route, CCS linkage and master-record design checks
- **Theme:** 0
- **Covers:** n482, n381, n394, n459, n460, n392
- **Scope:** all
- **Type:** CONFIGURABLE (route per product), plus ENFORCED master-record approval checks.
- **Behaviour:**
  - The product master requires a *sterility-assurance route*: terminal / aseptic / aseptic + post-aseptic heat treatment (or another adjunct step). For any route other than terminal, a justification reference is mandatory. The route selects the master-record template and rule set (Themes 7–13).
  - MBR approval is blocked unless every step marked as a CCS critical control point carries the CCS document ID and version. The executed batch header shows the CCS version in force on the execution date.
  - Master-record design review: a manual aseptic assembly or connection step where SIP or a pre-assembled sterile kit is feasible raises a mandatory "justify manual manipulation" item (DESIGN-CHOICE).
  - Optional flag "Annex 1 principles applied to a non-sterile product" with a mandatory list of the principles applied. This is used when the edition is reused for low-bioburden intermediates, and it can never produce a sterility claim.
  - DESIGN-CHOICE: Grade A/B steps are paperless, using cleanroom-rated devices (see ST-13), because paper sheds fibres.
- **Citations:** EU Annex 1: 1 (Scope, para 3), 2.3, 2.5, 8.7–8.9, 8.15, 8.34, 8.37 | US: 211.113(b); FDA-AP II.B and III (aseptic processing only when terminal sterilisation is not feasible).
- **FDA vs EU:** Aligned on preferring terminal sterilisation. The CCS is an EU concept; FDA has no CCS requirement, so the CCS fields are EU-driven.
- **Verify:** Submit an aseptic product master with no route justification → approval refused. Open an executed batch → every CCP step shows the CCS ID and version effective on that date.

### ST-03: Change control drives requalification/revalidation blocks
- **Theme:** 0
- **Covers:** n396, n318
- **Scope:** all
- **Type:** ENFORCED
- **Behaviour:**
  - Every change to an MBR, recipe, limit, line, room, steriliser or filter type needs a CCS-impact assessment before approval, and a post-implementation effectiveness check before closure. Neither can be skipped.
  - A change control that sets "requalification/revalidation required" on an asset makes that asset unusable in batch execution until the change is closed or QA records an interim decision. The pre-start check cites the change-control ID.
  - Changes tagged "affects aseptic process" feed the APS status engine (ST-29).
- **Citations:** EU Annex 1: 2.6, 4.32 (requalification after changes) | US: 211.100(a); FDA-AP IX (intro).
- **FDA vs EU:** Aligned. EU adds the CCS-impact element.
- **Verify:** Open a change control on filling line 2 with "requalification required" → batch start on line 2 is blocked. Close it → start allowed, citing the change-control ID.

### ST-04: Contemporaneous recording and departures from the MBR
- **Theme:** 0
- **Covers:** n366
- **Scope:** all
- **Type:** ENFORCED
- **Behaviour:**
  - All steps carry server-synchronised timestamps and attributed e-signatures. An entry made more than a configurable window after the recorded activity is flagged "late" and needs a reason. The window is a DESIGN-CHOICE, default 15 min; neither text gives a number.
  - A skipped or out-of-sequence step, an out-of-range parameter or substitute equipment forces a deviation with justification before the next dependent step.
  - MBRs cannot be executed until QA has approved them.
- **Citations:** EU Annex 1: 8.7 (defined process) | US: 211.100(a)-(b), 211.186, 211.188; FDA-AP XII (text box).
- **FDA vs EU:** Aligned. The US wording is binding.
- **Verify:** Sign a step 3 h after the activity → flagged "late" and a reason required. Execute step 7 before step 6 → deviation required.

### ST-05: Instrument calibration status checked at point of use
- **Theme:** 0
- **Covers:** n384, n434
- **Scope:** all
- **Type:** ENFORCED
- **Behaviour:**
  - Every instrument whose reading enters the batch record is referenced by ID and checked against the calibration system at the moment of use. This covers balances, checkweighers, particle counters and probes, air samplers, integrity testers, steriliser/tunnel/lyo sensors, DP gauges and incubators. An overdue or failed instrument is blocked. Its reading is accepted only through a deviation, with a retrospective impact assessment once as-found data are known.
  - An as-found out-of-tolerance result automatically lists every batch and result produced since the last good calibration, for impact assessment.
  - Particle-counter records carry counter and probe ID. The ≤1 m tubing guidance is a qualification item and is not re-checked per batch.
- **Citations:** EU Annex 1: 5.9 (particle counters and tubing qualified) | US: 211.160(b)(4), 211.68; FDA-AP X and XI (text boxes), IX.C.2.
- **FDA vs EU:** Aligned. The US rule is binding.
- **Verify:** Record a fill-weight check on a balance whose calibration expired yesterday → refused or deviation-gated. Enter an as-found failure on an integrity tester → the impacted results list is generated.

### ST-06: Batch alarm and event register (equipment, utilities, power, interlocks)
- **Theme:** 0
- **Covers:** n428, n365, n444, n409, n281
- **Scope:** all
- **Type:** ENFORCED (register and assessment). Criticality mapping is CONFIGURABLE.
- **Behaviour:**
  - For every room, line, isolator, steriliser, lyophiliser and utility used by the batch, the eBMR imports EMS/BMS/SCADA alarms and events for the whole execution window. This includes DP, particle, T/RH, interlock override or simultaneous door opening, leak or backflow alarms, and power events. Each item needs an acknowledgement (user, time) and an assessment of batch impact.
  - A *critical* alarm (per master data) pauses the step until an authorised reviewer records an evaluation. Any alarm that breached a limit must be linked to a deviation.
  - **Any power interruption that could affect quality, however short, automatically creates a deviation** linked to the batch (US text-box rule).
  - A data-feed gap longer than a configurable limit (default 5 min) is treated as an alarm.
  - Release is blocked while any alarm in the window is unassessed.
- **Citations:** EU Annex 1: 4.13, 4.16, 5.2, 6.20–6.22 | US: 211.100, 211.192; FDA-AP IV.C, XII (power interruption).
- **FDA vs EU:** FDA-AP is more explicit that every power interruption is a deviation. EU adds a requirement for immediate review of critical alarms. Apply both.
- **Verify:** Inject a 2 s power dip on the filler feed → deviation auto-created. Leave one of three alarms unassessed → release blocked. Cut the EMS feed for 30 min → a gap item appears.

---

## Theme 1: Personnel qualification and gowning gate

### ST-07: Role and training check at every e-signature (all cleanroom roles)
- **Theme:** 1
- **Covers:** n446, n291, n583, n296, n573
- **Scope:** all
- **Type:** ENFORCED
- **Behaviour:**
  - "Operator" covers every person who records work in a classified area: fillers, set-up, maintenance engineers, cleaners, EM/PM samplers and QA observers. At each e-signature the system checks the LMS for current training on the aseptic curriculum (microbiology basics, hygiene, cleanroom behaviour, gowning, patient-safety consequences) and on the SOPs linked to the step, keyed to the grade and task criticality. Missing or expired training → the signature is refused with a reason.
  - Sampling tasks (EM, PM, bioburden, sterility sample pulls) need an "aseptic sampler" qualification. LIMS results carry the analyst ID, and review checks that the sampler and analyst were qualified on the date.
  - Investigations of microbiological events need an approver with a microbiology / sterility-assurance role.
  - A snapshot of training status at signing is stored in the batch record.
- **Citations:** EU Annex 1: Glossary (Operator), 7.3, 10.1 | US: 211.25(a)-(c); FDA-AP V.A, V.B.
- **FDA vs EU:** Aligned. FDA-AP V.B explicitly extends this to lab and sampling staff.
- **Verify:** A maintenance technician with expired cleanroom training signs an in-room repair step → refused. An EM task completed by a user without the sampler qualification → refused.

### ST-08: Unsupervised Grade A/B access gate (gowning qualification + APS participation)
- **Theme:** 1
- **Covers:** n447, n292, n321, n539
- **Scope:** aseptic
- **Type:** CONFIGURABLE. Default: gowning requalification ≤12 months and a successful APS ≤12 months. Allowed range: shorter only. ENFORCED: no unsupervised Grade A/B signature without both.
- **Behaviour:**
  - Before a person may sign any Grade A/B aseptic step without supervision, the system requires all of the following:
    - gowning qualification passed, with visual and microbial assessment (gloved fingers, forearms, chest, hood/mask/forehead). Results are judged against the Table 6 contact-plate and glove-print limits for the grade concerned (Grade B: 5 CFU; Grade A: no growth), per Table 2 note 3. The qualification must be no more than 12 months old;
    - aseptic training current;
    - participation within the last 12 months in a successful APS on this line or process, **in the role or activity being signed**. Roles include filling, set-up, maintenance intervention, EM sampling and SUS assembly/connection.
  - If any check fails, the person is routed to "supervised only" mode, if the site allows it, or blocked.
  - The qualification snapshot for each person is stored in the batch roster.
  - The site can shorten the gowning requalification interval for manual or intervention-heavy processes. FDA-AP says annual is normally enough only for automated, low-intervention operations.
- **Citations:** EU Annex 1: 7.4, Table 2 note 3, 8.139, 9.38 (each operator ≥1 successful APS per year) | US: 211.25(a), 211.28(a),(c); FDA-AP V.A, IX.A.2.
- **FDA vs EU:** Operator APS participation is annual in both. Gowning: EU says at least annually for everyone. FDA says annual is usually adequate for automated operations and implies more frequent requalification for manual work or after adverse findings. Stricter result = ≤12 months for everyone, shortened for manual processes.
- **Verify:** Gowning requalified 12 months + 1 day ago → Grade B signature blocked. A technician whose APS covered only EM sampling signs a needle-change intervention → blocked or flagged.

### ST-09: Disqualification, restriction and requalification triggers
- **Theme:** 1
- **Covers:** n449, n295
- **Scope:** aseptic
- **Type:** ENFORCED (the triggers exist). Trend thresholds are CONFIGURABLE.
- **Behaviour:**
  - Person status can be qualified, supervised-only, retrain, requalification-required or disqualified. The status changes automatically on any of these:
    - a personnel-monitoring action result or an adverse PM trend (rule set in ST-22);
    - implication in a failed APS (ST-33);
    - a gown breach or an observation finding (ST-11, ST-13);
    - manual QA action.
  - A disqualified or requalification-required person cannot sign Grade A/B steps on **any** open batch.
  - Clearing the status needs QA sign-off referencing linked retraining, a gowning assessment and (default on) a successful APS.
- **Citations:** EU Annex 1: 7.6 | US: 211.25(a); FDA-AP V.A, V.C.
- **FDA vs EU:** Aligned. EU is explicit that requalification should consider a successful APS.
- **Verify:** Mark an APS failed → all implicated operators become restricted and their aseptic signatures are refused until the requalification records, including a successful APS, are linked.

### ST-10: Access authorisation, health declaration and exceptional supervised entry
- **Theme:** 1
- **Covers:** n450, n383, n448
- **Scope:** all
- **Type:** ENFORCED (access list, medical exclusion). The self-declaration form is CONFIGURABLE.
- **Behaviour:**
  - Aseptic-area sign-in checks that the person is on the supervisor-authorised access list and records a fitness-to-enter declaration. This covers illness, open lesions, and recent work with human/animal tissue or microbial cultures.
  - Declared culture or tissue work blocks entry until a documented decontamination record exists.
  - A supervisor or medical exclusion flag blocks product-contact steps until a clearance with a medical reference is recorded. The flag state at each signature is kept.
  - Exceptional entry of an unqualified person (for example a contractor) into Grade B, or into Grade A in operation, needs an "exceptional supervised entry" record: person, reason, times in and out, supervising authorised person (whose qualification is checked), and a cleanliness impact assessment. The record links to every batch in progress in that area and appears in batch review.
- **Citations:** EU Annex 1: 7.5, 7.7, 7.8 | US: 211.28(c)-(d); FDA-AP V (text box).
- **FDA vs EU:** Aligned. The US health-exclusion rule is binding.
- **Verify:** Set a medical exclusion → filling signatures refused until clearance. Record a contractor entry during filling → impact assessment mandatory and entry visible in batch review.

### ST-11: Per-entry gowning record, garment status, wear time and glove events
- **Theme:** 1
- **Covers:** n452, n453, n454, n294
- **Scope:** all (Grade A/B rules: aseptic)
- **Type:** ENFORCED (sterile-pack checks, breach handling). Maximum wear time and glove-disinfection interval are CONFIGURABLE (default = the value from garment qualification; no shipped numeric default because Annex 1 sets none).
- **Behaviour:**
  - Each entry is logged with garment and sterile-pack lot, sterilisation expiry, packaging-intact check, visual checks before and after donning, and an integrity check on exit. An expired or unsterilised pack is rejected at scan.
  - Grade A/B entries need a fresh sterile gown set (suit, hood, mask, eye cover, double sterile gloves, over-boots) on **every** entry.
  - Garment type is checked against the grade: Grade C (hair covered, high-neck suit, disinfected shoes) and Grade D (hair covered, protective suit).
  - A per-operator wear timer starts at gowning and warns before, and alerts at, the qualified maximum wear time.
  - If RFID is used, the garment's laundry/sterilisation cycle count must not exceed the qualified maximum.
  - Quick-log events cover glove sanitisation, glove change, gown change, gown or glove breach and instrument replacement. A breach during exposed-product work requires an immediate change record and an assessment of units exposed in the breach window.
- **Citations:** EU Annex 1: 7.10–7.17 | US: 211.28(a); FDA-AP V.A.
- **FDA vs EU:** EU is more prescriptive: per-grade garment list, fresh sterile garments on every A/B entry, qualified maximum wear time and maximum laundry cycles. Apply EU.
- **Verify:** Scan a gown pack past its sterile hold → rejected. Log a torn glove during filling → change record and impact assessment required.

### ST-12: Headcount limit and personnel presence log
- **Theme:** 1
- **Covers:** n445, n285
- **Scope:** aseptic
- **Type:** CONFIGURABLE (maximum per room is master data, must be ≤ the maximum qualified in the latest successful APS). ENFORCED: deviation when exceeded.
- **Behaviour:**
  - Records who was present in each aseptic room, with entry and exit times, from access control or sign-in/out.
  - Computes peak concurrent headcount and compares it with the room maximum. Exceeding it raises a batch event and a deviation.
  - Counts transfers into the critical zone.
  - The roster is printable in the batch report.
- **Citations:** EU Annex 1: 7.1, 7.2 | US: 211.42(b) (inferred); FDA-AP IV.E.
- **FDA vs EU:** Aligned. EU requires the maximum operator number to be documented and challenged in APS.
- **Verify:** APS qualified 4 people and 5 are present during filling → deviation, with the peak shown on the timeline.

### ST-13: Aseptic behaviour observation, QA oversight and in-cleanroom device rules
- **Theme:** 1
- **Covers:** n470, n293, n455, n451
- **Scope:** aseptic
- **Type:** CONFIGURABLE (observation frequency per line; default at least one expert observation per line per month, site may tighten). Device rules are DESIGN-CHOICE.
- **Behaviour:**
  - Batch-linked observation record: observer (must hold the aseptic-expert, supervisor or QA role), time window, operator observed, checklist result, findings and coaching. A finding can raise a deviation, and it feeds ST-09.
  - Line readiness shows when the next observation is due. Batch review shows whether QA oversight took place.
  - Device rules: only registered, grade-rated tablets and scanners may open sessions in classified areas, with a disinfection record at transfer-in. Station layout keeps data entry out of first-air paths. Entry after the activity is allowed where the MBR permits it.
- **Citations:** EU Annex 1: 7.9, 7.18, 8.19 | US: 211.22(a), 211.25(b); FDA-AP V.A.
- **FDA vs EU:** Aligned on regular observation. Neither text sets a frequency, so the 1/month default is a design choice.
- **Verify:** A user without the expert role creates an observation → refused. Log in from an unregistered tablet in Grade B → refused.

---

## Theme 2: Cleanroom/area status and environmental and personnel monitoring linked to the batch window

### ST-14: Room/zone grade, classification and qualification gate at step start
- **Theme:** 2
- **Covers:** n404, n421, n424, n275, n279, n402, n5, n388, n422
- **Scope:** all
- **Type:** ENFORCED. The maximum requalification intervals are locked: Grade A/B ≤6 months, Grade C/D ≤12 months. Mapping each step to a grade is CONFIGURABLE within the Annex 1 grade rules.
- **Behaviour:**
  - Room/zone master data holds the EU grade, ISO class and FDA class, plus qualification status and expiry. These are held separately from routine EM, and EM data never counts as qualification evidence.
  - Particle equivalences for mapping: Grade A ≈ ISO 5 (in operation); Grade B in operation ≈ ISO 7; Grade C in operation ≈ ISO 8. Grade D has no predetermined in-operation limit.
  - Every MBR step names a minimum grade. Exposed sterile product, open primary containers, aseptic assembly and aseptic connections need Grade A with a Grade B background (isolators: ST-74).
  - FDA support rooms: the room next to the aseptic line must be at least ISO 7 in operation; ISO 8 is allowed for less critical work such as equipment washing.
  - At step start and at line clearance, the system blocks when any of these holds:
    - the room qualification is expired;
    - requalification is overdue (last requalification more than 6 months ago for A/B, more than 12 months for C/D);
    - a "requalification required" flag is open, for example after an air-movement interruption, an HVAC design or set-point change, a final-filter change, special maintenance or remedial action;
    - the room grade is below the step's requirement.
  - The status and due date in effect at execution are stored in the batch record.
  - Each step is bound to a room or zone. The scanned location must match. The same room cannot run incompatible activities or two batches at once; component preparation, product preparation and filling are kept separate.
  - The 211.42(c)(10) facility systems (T/RH control, HEPA air under positive pressure, EM system, cleaning/disinfection system, maintenance of aseptic-control equipment) appear as room status attributes that the batch reads. It does not re-verify them.
  - DESIGN-CHOICE: the scheduler warns if classification sampling is planned inside a commercial batch window, and allows an APS to be tagged as the reclassification run.
- **Citations:** EU Annex 1: 4.2, 4.4, 4.23–4.26, 4.32 | US: 211.42(c)(10)(i)-(vi), 211.46(b); FDA-AP IV (intro), IV.B, Table 1.
- **FDA vs EU:** EU is stricter. It sets fixed maximum requalification intervals (6 and 12 months) and at-rest plus in-operation limits. FDA-AP has no fixed room requalification interval; only HEPA leak testing is about twice a year (ST-17).
- **Verify:** A Grade B room last requalified 6 months + 1 day ago → step start blocked. Set a "final filter changed" flag → blocked until requalification is recorded. An aseptic connection step mapped to a Grade C room → MBR validation rejects it.

### ST-15: Room cleaning and disinfection status
- **Theme:** 2
- **Covers:** n425, n426, n427, n349
- **Scope:** all
- **Type:** ENFORCED (sequence, sterility of agent, expiry). Frequencies and rotation are CONFIGURABLE per validated programme; Annex 1 gives no numbers.
- **Behaviour:**
  - The room log records:
    - cleaning **before** disinfection; disinfection without a preceding cleaning entry is flagged;
    - agent, lot, sterility status, preparation time and in-use expiry, contact time, areas and sequence, and operator.
  - Agents used in Grade A/B must be sterile (vendor CoA/CoC after qualification, or in-house sterilisation record). Grade C/D agents must be sterile where the CCS says so. An expired dilution or non-sterile lot is rejected at scan.
  - Rotation rules apply: at least two agents with different modes of action, and a sporicide at the defined frequency. A spore-former recovery automatically creates a sporicidal-clean task that must be done before the next aseptic batch in that area.
  - Fumigation or VHP cycles are recorded with the validated cycle ID. After a failed cycle the room stays unavailable.
  - The room shows "ready" at step start only if disinfection and sporicide are not overdue and no expired agent was used.
- **Citations:** EU Annex 1: 4.33–4.36 | US: 211.42(c)(10)(v), 211.56(b)-(c); FDA-AP X.A.3.
- **FDA vs EU:** EU requires cleaning before disinfection and more than one disinfectant type. FDA-AP requires a sporicide on a written schedule and when spore-formers appear. Apply both.
- **Verify:** Use a disinfectant past its in-use expiry → line clearance fails. Record a *Bacillus* recovery → a sporicidal-clean task is required before the next aseptic batch.

### ST-16: Return to service after maintenance, shutdown or construction, and clean-up period
- **Theme:** 2
- **Covers:** n429, n433, n290, n552, n432, n423
- **Scope:** all
- **Type:** ENFORCED (sequence). Clean-up period is CONFIGURABLE: the value from room qualification, where the Annex 1 guidance value is under 20 min. A longer value needs a CCS justification (ST-01).
- **Behaviour:**
  - Maintenance inside a cleanroom on a batch line inserts mandatory follow-up steps before restart: extra cleaning and disinfection, extra EM samples, and re-sterilisation of reassembled parts (sterilised after full reassembly where possible).
  - *Unplanned* maintenance on equipment flagged sterility-critical needs a sterility-impact assessment **before** work starts. It is automatically linked to the in-process batch and to adjacent batches.
  - Sterilisers, HVAC and water systems can be selected only if qualified, not overdue for PM, and formally released after maintenance.
  - After an HVAC or utility shutdown or construction work, a return-to-service record is required before aseptic steps can start. It covers cleaning/disinfection, post-shutdown and pre-start viable samples, and requalification where needed. Those results are linked to the next batch.
  - After line clearance or any disruption, a clean-up timer set to the room's qualified period must elapse before the next batch or before aseptic work resumes. Optionally, the timer also waits until particle counts are back within at-rest limits.
- **Citations:** EU Annex 1: 4.29(iii), 5.3, 5.6, 5.7, 9.23, Table 5 note 1 | US: 211.42(c)(10)(vi), 211.100 (inferred); FDA-AP IV.E.
- **FDA vs EU:** Complementary. EU adds the clean-up period and the pre-maintenance sterility assessment. FDA-AP stresses written return-to-operation procedures after shutdowns and construction.
- **Verify:** Log an HVAC shutdown without a return-to-service record → line clearance fails. Finish line clearance and try to start the next batch immediately → blocked until the clean-up period elapses.

### ST-17: Pressure differentials, airflow velocity/visualisation and HEPA status
- **Theme:** 2
- **Covers:** n405, n410, n412, n280, n277, n411, n284
- **Scope:** all (continuous Grade B DP: aseptic)
- **Type:** ENFORCED (continuous linkage and assessment). Set points are CONFIGURABLE: floor ≥10 Pa between different grades, and ≥12.5 Pa for an aseptic room next to an unclassified room. A lower value between graded rooms needs a CCS justification (EU guidance value).
- **Behaviour:**
  - For every room pair used, the DP trend for the whole batch window is attached, showing minimum values against limits.
    - Critical DPs, including the Grade B background during aseptic preparation and filling, are monitored continuously with instant alarms.
    - Non-critical pairs are captured as recurring manual readings.
  - Any time below the limit during open processing needs an impact assessment. Before the next aseptic step can be signed, a restoration and confirmation record is required, for example the clean-up period plus extra EM. Alarms cannot be cleared without an assessment.
  - Door-held-open alarms are compared with a configured maximum door-open time.
  - Line readiness checks, with block or deviation-gate when overdue:
    - current airflow-visualisation study reference covering the line's interventions;
    - UDAF velocity check current and within the justified range (EU guidance 0.36–0.54 m/s at the working position; FDA 0.45 m/s ±20%, measured about 15 cm below the filter face and at working height);
    - HEPA in-place leak test current, including tunnel and oven HEPAs. Default interval is 6 months. A single probe reading of about 0.01% of the upstream challenge counts as a significant leak.
  - Media-fill and sterility-failure investigation templates generate a HEPA retest task.
- **Citations:** EU Annex 1: 4.4 (Grade B DP continuous), 4.14, 4.15, 4.16, 4.30, 4.32 | US: 211.42(c)(10)(iii)-(iv), 211.46(b); FDA-AP IV.A (footnote 5), IV.C, IV.D.2.
- **FDA vs EU:**
  - DP: EU gives a minimum 10 Pa *guidance value*. FDA-AP gives at least 10–15 Pa between classes and at least 12.5 Pa toward an unclassified room at all times, so the 12.5 Pa rule comes from FDA.
  - Velocity: the numeric ranges are equivalent.
  - HEPA testing: FDA states twice a year; EU covers it through A/B requalification at ≤6 months. Equivalent.
- **Verify:** Replay an 8 Pa dip for 5 min during filling → the batch shows the excursion, the next aseptic step needs a restoration record, and release is blocked until assessed. Set the tunnel HEPA test as expired → the depyrogenation step is blocked.

### ST-18: Batch EM sampling plan and coverage of the processing window
- **Theme:** 2
- **Covers:** n541, n542, n343, n347, n551, n553, n344, n587, n543, n550
- **Scope:** all (continuous Grade A viable coverage: aseptic)
- **Type:** ENFORCED (coverage checks, 4 h plate maximum, end-of-operation sequencing). Plan content is CONFIGURABLE from the approved EM programme.
- **Behaviour:**
  - Each batch gets an EM plan generated from the approved EM programme version: locations, method, frequency per activity, timing (during or at end of operation), air volume or surface area, exposure time and limits. Critical locations are flagged.
  - The plan also covers the airlocks, change rooms and pass-throughs actually used, taken from gowning and transfer records.
  - Tasks are generated for **every shift** the batch spans. A missed or late sample becomes a deviation.
  - **Grade A:** viable monitoring (settle plates and/or active air) must be continuous from the start of aseptic set-up to the last unit sealed.
    - The system checks contiguous coverage, and any gap is an exception.
    - Each settle plate may be exposed for no more than **4 h**; a longer plate is invalid or deviation-gated.
    - For Grade C/D, exposure time (still ≤4 h) and frequency come from QRM.
  - **Grade B:** a continuous-viable approach is on by default (CONFIGURABLE by risk).
  - End-of-operation surface sampling (room and equipment) is mandatory before line clearance. Critical product-contact surfaces such as needles, stopper bowl and feed tracks can be sampled only after the fill-end event; earlier sampling is blocked.
  - EM sampling inside Grade A is logged as an inherent intervention.
  - Room T/RH trends are attached with limit checks.
  - A product flagged hazardous (live organisms, powders, radiopharmaceuticals) switches the plan to classification checks before and after exposure, extra viable sampling and scheduled monitoring during simulated operations.
  - Each task records the sampler device ID (calibration current), actual volume, media lot and sampler identity.
- **Citations:** EU Annex 1: 4.1, 9.4–9.8, 9.19–9.24, Table 6 note (a) | US: 211.42(c)(10)(iv), 211.113(b), 211.160(b); FDA-AP IV.A, X.A.1.
- **FDA vs EU:** EU is stricter. It requires continuous Grade A viable monitoring including set-up, and a maximum 4 h plate exposure. FDA-AP requires sampling each shift, calls settle plates optional, and puts critical-surface sampling at end of operation (same as EU).
- **Verify:** Leave a 15-min gap between Grade A plates → coverage exception. Log a plate exposed for 4 h 20 min → flagged invalid. Try a needle-surface sample before fill end → blocked.

### ST-19: Total particle monitoring (Grade A continuous) and particle excursions
- **Theme:** 2
- **Covers:** n548, n549, n547, n276, n353
- **Scope:** aseptic
- **Type:** ENFORCED (continuous Grade A coverage, excursion assessment). Alert levels are CONFIGURABLE from qualification data. Action limits are at most the Table 5 values.
- **Behaviour:**
  - **Grade A monitoring.** The eBMR ingests continuous Grade A counts for **≥0.5 µm and ≥5 µm** at a flow of **≥28 L/min (1 ft³/min)**. Coverage must span all critical processing, including equipment assembly, and the data are aligned on the batch timeline next to interventions. For FDA, the probe is within about 30 cm (1 ft) of the work site and in the airflow, and there is data for every shift the batch spans.
  - **Grade B monitoring.** A similar system is used at lower sampling frequency, with alert alarms.
  - **Alarms.** An alert-level exceedance raises an alarm, which needs a recorded response. The system prompts for extra microbial sampling.
  - **Table 5 monitoring limits** (particles/m³, ≥0.5 µm / ≥5 µm):

    | Grade | At rest | In operation |
    |---|---|---|
    | A | 3,520 / 29 | 3,520 / 29 |
    | B | 3,520 / 29 | 352,000 / 2,930 |
    | C | 352,000 / 2,930 | 3,520,000 / 29,300 |
    | D | 3,520,000 / 29,300 | set by the site from risk and routine data |

    The *classification* table (Table 1) leaves 5 µm "not specified" for Grade A and at-rest Grade B. The 29/m³ Grade A value applies only to *monitoring*.
  - **FDA ISO 5 limit.** ≤3,520/m³ ≥0.5 µm during filling and closing.
  - **5 µm rule.** An isolated single count is annotated. Consecutive or recurring low-level counts within a configurable window raise an investigation event.
  - **Excursions.** Any excursion above the limit becomes a batch event (location, magnitude, duration, severity). It needs an assessment sized to its severity, with a trend look-up, before review can close. A missing counter feed is treated as an alarm (ST-06).
- **Citations:** EU Annex 1: 9.14–9.18, Table 5 (with notes 1 and 2), Table 1 | US: 211.42(c)(10)(iv); FDA-AP IV.A, X.E.
- **FDA vs EU:** EU is stricter. It adds 5 µm limits, a 28 L/min continuous requirement and alarm-at-alert. FDA-AP covers only ≥0.5 µm and says continuous systems are *preferred*.
- **Verify:** Replay three consecutive samples with 1–2 counts at 5 µm in Grade A → investigation event. Start the Grade A counter 20 min after assembly began → coverage gap.

### ST-20: EM limits, alert levels and trend rules (EU and FDA profiles)
- **Theme:** 2
- **Covers:** n544, n545, n346, n348, n74, n274, n556, n352
- **Scope:** all
- **Type:** CONFIGURABLE within floors (ST-01). ENFORCED: no averaged-only views, and no alert tier for Grade A viable.
- **Behaviour:**
  - **Viable action limits** (EU Table 6, maxima):

    | Grade | Air (CFU/m³) | Settle plate, 90 mm (CFU/4 h) | Contact plate, 55 mm (CFU/plate) | Glove print, 5 fingers (CFU/glove) |
    |---|---|---|---|---|
    | A | no growth | no growth | no growth | no growth |
    | B | 10 | 5 | 5 | 5 |
    | C | 100 | 50 | 25 | – |
    | D | 200 | 100 | 50 | – |

  - **FDA Table 1 action levels** (air CFU/m³ / settle plate CFU per 4 h; particles ≥0.5 µm/m³):

    | ISO class | Air / settle | Particles |
    |---|---|---|
    | 5 | 1 / 1 (normally no growth) | 3,520 |
    | 6 | 7 / 3 | 35,200 |
    | 7 | 10 / 5 | 352,000 |
    | 8 | 100 / 50 | 3,520,000 |

    FDA settle plates are optional.
  - **Effective limit.** Each location uses the stricter of the EU and FDA values for the markets served. Example: a room classed ISO 8 for US and Grade D for EU gets **100/50** (FDA), not 200/100.
  - **Alert levels.** Required for Grade A (total particles only), B, C and D. They are derived from qualification data and periodically re-set from trend data. The system offers no alert field for Grade A viable, because any growth is an action event (ST-21).
  - **Trend rules** (configurable; each rule is required):
    - a rising number of alert/action excursions;
    - consecutive alert excursions;
    - recurring isolated action excursions with a common cause, for example after planned maintenance;
    - flora change, including a first-seen organism or a spore-former/mould;
    - recovery frequency over a rolling window per location.

    A triggered rule creates an event linked to every batch in the affected area and period.
  - **Result display.** Each result is shown individually against limits; there is no averaged-only view. Records carry location, room, class, shift, operator and batch, so data can be trended along each of these. DESIGN-CHOICE: the review dossier shows 30-day and 12-month snapshots.
  - **Rapid methods.** Results from validated rapid or alternative methods may use non-CFU units, with a correlated limit and justification reference. Results from unvalidated methods are refused.
- **Citations:** EU Annex 1: 9.9–9.12, 9.28, 9.29, Table 2 note 2, Table 5, Table 6 | US: 211.22(a), 211.42(c)(10)(iv), 211.165(e); FDA-AP IV (Table 1 and notes), X.A.1, X.A.2, X.D.
- **FDA vs EU:** Grade A is stricter under EU (no growth) than ISO 5 (action 1, normally none). Grade B equals ISO 7 for air and settle plates, and EU adds contact and glove limits. **ISO 8 (FDA 100/50) is stricter than EU Grade D (200/100)**, so it applies for US-market products.
- **Verify:** Configure a Grade B air action limit of 15 → rejected. The Grade A viable alert field is absent. Three low-level recoveries at one ISO 7 location in 10 days → the frequency trend rule fires and links to batches.

### ST-21: Viable excursion handling, identification and batch linkage
- **Theme:** 2
- **Covers:** n557, n278, n546, n558, n345
- **Scope:** all (Grade A rules: aseptic)
- **Type:** ENFORCED
- **Behaviour:**
  - **Grade A / ISO 5 recovery.** Any recovery above 0 CFU in any sample type (air, settle, contact, glove) automatically opens an investigation. The investigation is linked to every batch whose aseptic window overlaps the sample. Release is blocked until it closes with a documented batch-impact disposition. Rejection is not automatic, because FDA-AP notes a critical-site positive does not by itself require rejection, but a signed rationale is mandatory.
  - **Action excursion in any grade.** The result links automatically to **every batch processed in that room/zone from the sampling time until the result was reported**. Those batches go on hold. A root-cause investigation, product-impact assessment and CAPA are required.
  - **Alert excursion.** Creates an assessment and follow-up task, and investigation or CAPA is considered.
  - **Identification.** Grade A/B isolates must be identified to **species**, and each linked batch needs its own impact statement. A genus-only ID cannot close an A/B record. Grade C/D isolates are identified on excursions, for indicator organisms (spore-formers, moulds) and periodically.
  - **Investigation template.** Pre-filled with the context around the sample: interventions, personnel present, PM, particle and DP data, alarms, and the sterilisation records of the sampled item.
- **Citations:** EU Annex 1: 9.13, 9.30 (Table 6 note c), 9.31 | US: 211.192, 211.42(c)(10)(iv); FDA-AP IV.A (Table 1 note e), X.A.1, X.B.
- **FDA vs EU:** EU is stricter on identification: species level for A/B, where FDA-AP accepts genus "where appropriate". Both expect investigation of any ISO 5 / Grade A growth.
- **Verify:** Enter an action result on day 5 for a sample taken on day 1 → all batches in that area on days 1–5 are linked and held. Enter 1 CFU on a Grade A plate → automatic investigation and release block.

### ST-22: Personnel monitoring tasks and results
- **Theme:** 2
- **Covers:** n554, n555, n297, n298, n299
- **Scope:** aseptic
- **Type:** ENFORCED (sampling after critical interventions and at Grade B exit, outer-glove change). Frequencies are CONFIGURABLE, never below: gloves at least daily or per lot (FDA allows either), and on each Grade B exit.
- **Behaviour:**
  - For every person on the batch's aseptic roster, the system generates:
    - glove prints (both hands, five fingers), at least daily or in association with each lot (FDA), plus at every exit from Grade B for gloves **and** gown (EU);
    - periodic in-process samples;
    - extra samples for high-intervention or manual-process operators (enhanced gown sampling per CCS).
  - **After a critical intervention closes:** each involved operator gives a glove sample. An **outer-glove change** must be recorded before that operator's next action, and the next action is blocked until it is. If a gown sample was taken, a re-gowning record is required before further cleanroom activity.
  - **Anti-masking rule:** the glove-sample task records the operator's last glove sanitisation. A sanitisation within a configurable interval before the print (DESIGN-CHOICE default 5 min) needs a justification or a re-sample.
  - Where production staff take samples, the frequency of QA oversight is tracked.
  - Limits: Grade A gloves no growth; Grade B gloves and gown contact plates 5 CFU.
  - Batch review is blocked until every roster member's results are back and assessed.
  - An alert or action PM result is linked to every batch the person worked that session. An action result opens an investigation and feeds the person's status (ST-09).
- **Citations:** EU Annex 1: 9.25–9.27, Table 6 | US: 211.113(b), 211.42(c)(10)(iv), 211.192 (inferred); FDA-AP V.C, X.A.
- **FDA vs EU:** Apply both. EU adds sampling on every Grade B exit and after critical interventions, followed by a glove change. FDA-AP adds daily or per-lot glove sampling and forbids sanitising gloves just before sampling.
- **Verify:** Close a corrective critical intervention and attempt the next step without a glove-change entry → blocked. Four operators on the roster but only three glove samples → review flags the missing sample.

### ST-23: EM media qualification and incubation conditions
- **Theme:** 2
- **Covers:** n579, n350
- **Scope:** all
- **Type:** ENFORCED (growth promotion before use). The incubation scheme is CONFIGURABLE as validated.
- **Behaviour:**
  - A media lot for EM, PM or APS can be issued only with a passing growth-promotion record. The test uses pharmacopoeial reference organisms and representative local isolates, run by the site, or by the supplier where reliance is justified with transport considered.
  - Each sample records media lot, GPT status, neutraliser (where disinfectant or product residues could inhibit growth) and incubation conditions.
  - FDA example scheme for the shipped default: 30–35 °C for 48–72 h (bacteria) and 20–25 °C for 5–7 days (yeasts/moulds).
  - A result on a lot whose GPT later fails is invalidated, and a resample or deviation is required.
  - Sterility-sample exterior decontamination (VHP/UV) must be a validated method that does not reduce test sensitivity (ST-65).
- **Citations:** EU Annex 1: 10.8, 10.9, 10.11 | US: 211.160(b), 211.165(e); FDA-AP X.B.
- **FDA vs EU:** Complementary. EU expects GPT with local isolates, normally by the user. FDA-AP gives incubation examples and requires GPT for every prepared lot.
- **Verify:** Scan a settle-plate lot without GPT release at the Grade A station → refused.

### ST-24: EM/PM completeness and review as a release prerequisite
- **Theme:** 2 (feeds 14)
- **Covers:** n540, n580
- **Scope:** all (aseptic **and** terminally sterilised)
- **Type:** ENFORCED
- **Behaviour:**
  - The release package assembles, for every room, zone and line used and the whole processing window: viable and total-particle EM, PM, T/RH, DP, and APS status.
  - Certification is blocked while any result is outstanding, for example plates still incubating, or while an out-of-trend event is open.
  - An explicit "EM and trend data reviewed" signature is required.
  - Exception: the short-shelf-life path (ST-69).
- **Citations:** EU Annex 1: 9.1–9.3, 10.10 | US: 211.192; FDA-AP XII.
- **FDA vs EU:** Aligned. EU states explicitly that this applies to terminally sterilised products too.
- **Verify:** Attempt certification while two filling-window plates are still incubating → blocked.

---

## Theme 3: Utilities (WFI, clean steam, gases)

### ST-25: High-risk utility points of use linked to steps
- **Theme:** 3
- **Covers:** n435
- **Scope:** all
- **Type:** CONFIGURABLE. Defaults: WFI, pure steam used as a direct sterilant, and product-contact gases are high-risk; the CCS may add more.
- **Behaviour:**
  - The MBR names each high-risk utility point used by each step (WFI outlet, pure-steam header, gas drop).
  - The batch shows each point's status and trend flag.
  - An open excursion or adverse trend on a used point becomes a review item.
- **Citations:** EU Annex 1: 6.1–6.4 | US: FDA-AP XII (support-system output is part of the release decision).
- **FDA vs EU:** Aligned in intent. EU requires critical parameters of high-risk utilities to be trended.
- **Verify:** Put an adverse-trend flag on nitrogen drop N-3 → every batch that used N-3 shows a review item.

### ST-26: Water for injection: draw record, daily sampling, excursions and sanitisation hold
- **Theme:** 3
- **Covers:** n436, n437, n438, n439, n440
- **Scope:** all
- **Type:** ENFORCED (post-sanitisation hold, excursion linkage). Loop parameters are CONFIGURABLE as validated.
- **Behaviour:**
  - **Draw record.** Each WFI draw records outlet, time and volume. At draw time the system imports loop temperature (for hot storage the validated range, for example circulation above 70 °C), flow or turbulence evidence, and continuous **TOC and conductivity**. Out-of-range values are flagged and need assessment.
  - **Daily sampling.** At least **one representative sample every day** water is used in manufacture, with all outlets covered over the defined interval. The batch shows the results for the outlets and loop that supplied it.
  - **Action excursion.** Linked automatically to every batch that drew from the affected outlet or loop in the relevant period. Release is blocked pending investigation of root cause and product impact.
  - **Alert excursion.** Reviewed to decide whether it is isolated or part of a trend.
  - **After sanitisation or regeneration:** water use is blocked until chemical results are approved. Batches made with water drawn after the event are tagged, and certification is blocked until post-sanitisation microbial and endotoxin results are approved.
  - **Tank vent filter.** Integrity is tested before installation and after use. A failed post-use test lists every batch supplied during the filter's service window.
- **Citations:** EU Annex 1: 6.7–6.15 | US: FDA-AP XII (WFI output reviewed for release); no WFI-specific Part 211 clause in this register.
- **FDA vs EU:** EU is far more prescriptive (daily sample, continuous TOC/conductivity, post-sanitisation certification hold), so EU governs.
- **Verify:** Draw water after chemical release but before microbial release → that batch's certification is blocked until approval. An action TAMC result on outlet 12 → batches that drew from outlet 12 are listed and held.

### ST-27: Pure (clean) steam quality status for sterilisers and SIP
- **Theme:** 3
- **Covers:** n441
- **Scope:** all
- **Type:** ENFORCED (check). Test frequencies are CONFIGURABLE per site; Annex 1 says only "regularly" and "periodically".
- **Behaviour:**
  - Before an autoclave or SIP cycle, the system checks that the supplying pure-steam system has results within limits and not overdue for: the latest condensate test (meets the WFI monograph; microbial testing not mandatory) and the periodic non-condensable gas, dryness and superheat tests.
  - If not, the cycle is flagged as "unverified steam" and deviation-gated.
- **Citations:** EU Annex 1: 6.16, 6.17 | US: FDA-AP XII (steam generator output reviewed for release).
- **FDA vs EU:** EU is more specific.
- **Verify:** Make the dryness test overdue → the autoclave run is flagged.

### ST-28: Process gases, point-of-use sterilising gas filters, vent filters and sterile-tank pressure
- **Theme:** 3
- **Covers:** n442, n443, n282, n283
- **Scope:** aseptic (gas quality: all)
- **Type:** ENFORCED
- **Behaviour:**
  - The gas source (bulk tank, cylinder, generator) is recorded with lot/CoA or quality status against a specification covering chemical, particulate, microbial, oil and water content. A source that is not current is blocked. The status of periodic point-of-use microbial monitoring is shown.
  - Aseptic-use gases pass a **sterilising-grade filter of ≤0.22 µm nominal** at the point of use, and tubing downstream of the final filter is sterilised.
  - Batch-basis gas filters (for example nitrogen overlay) and product-vessel vent filters are integrity-tested. The results are **release items**, and a missing or failed result blocks certification.
  - A vent/gas filter register holds, per filter: part/lot, install date, service-life limit and test history. Tests happen at installation, periodically or at end of use, and after any damaging event. Use past the change interval is blocked. A failed test links every batch since the last pass and opens a deviation. Filters must stay dry (hydrophobic media, heated where needed).
  - A sterilised holding tank must stay under positive pressure, or sealed, from sterilisation to end of use. Loss of pressure is a deviation.
- **Citations:** EU Annex 1: 6.18, 6.19 | US: 211.46(c), 211.113(b), 211.192; FDA-AP IV.D.1.
- **FDA vs EU:** EU is stricter per batch: batch-basis filter integrity is reviewed at certification. FDA-AP adds sterile filters on autoclave air lines and lyophiliser vacuum breaks, and back-flow safeguards.
- **Verify:** Complete a batch without the overlay filter's post-use test → certification blocked. Record a tank pressure drop to 0 during a hold → deviation required.

---

## Theme 4: Aseptic process simulation (media fill): status and failure consequences

### ST-29: APS status engine and gate at batch start
- **Theme:** 4
- **Covers:** n564, n320, n319, n73, n572, n324, n379
- **Scope:** aseptic
- **Type:** ENFORCED (gate, 3-consecutive rule). Periodic interval is CONFIGURABLE with default and maximum = 6 months after the last successful APS. Any grace period is a DESIGN-CHOICE that needs a QA decision on the record (see Open questions).
- **Behaviour:**
  - Status is held per **aseptic process × filling line × shift**, and per container/closure configuration.
  - **Initial validation.** Status stays "initial validation incomplete" until **≥3 consecutive successful APS** covering every shift the process runs in.
  - **Periodic revalidation.** A successful APS about **every 6 months** for each process, each line and each shift.
  - **Back to initial validation (3 runs) or requalification pending** when any of these occurs:
    - an approved change tagged "affects sterility assurance" (HVAC, equipment, process, number of shifts or personnel, major shutdown);
    - inactivity longer than a configured period;
    - a new container or container-closure combination;
    - FDA triggers flagged "media-fill assessment required": significant staffing change, EM anomaly, extended shutdown, finished-product sterility positive.

    FDA-AP allows QA to lift the block with a documented risk decision that no new media fill is needed. Where the change affects the aseptic process, EU 9.49 requires the APS.
  - **Formulation/bulk aseptic stage** (non-filterable products): a separate simulation status, at least **twice a year**. It carries its own envelope: maximum open-operation time, operators, and sterile-bulk hold and transport time.
  - **Gate at fill start.** Aseptic filling cannot start unless both hold, and the status seen is stored:
    - the line/shift/format APS status is current and passing;
    - every sterilisation process used (equipment, components, container-closure, product filtration) is in validated status and not suspended.
  - DESIGN-CHOICE: prompt for an APS after the last batch before a shutdown, long inactivity, decommissioning or relocation.
- **Citations:** EU Annex 1: 9.38, 9.49 | US: 211.113(b) (validation of aseptic processes is binding); FDA-AP IX.A (intro), IX.A.2, Appendix 3.A.
- **FDA vs EU:** Both require 3 initial runs and a semi-annual cycle. **EU is stricter:** twice a year for *each process, each line and each shift*. FDA-AP requires semi-annual runs *per line*, with each shift's activities and changeovers represented in the programme. (Row n73 overstates FDA as "per line and shift"; see Conflicts.)
- **Verify:** Last successful night-shift APS 6 months + 3 weeks ago → night-shift batch start blocked. Add a new stopper type → "initial APS validation required" for that configuration.

### ST-30: Manual aseptic operations: per-operator APS qualification per configuration
- **Theme:** 4
- **Covers:** n565
- **Scope:** aseptic (manual compounding or filling)
- **Type:** ENFORCED for the EU profile. Interval CONFIGURABLE ≤6 months.
- **Behaviour:**
  - For processes flagged "manual aseptic", qualification is tracked per **operator × container type × closure × equipment train**: 3 consecutive successful APS initially, then one successful APS about every 6 months per operator. APS batch size mirrors routine batches.
  - An operator cannot sign a manual aseptic step for a combination not currently qualified.
- **Citations:** EU Annex 1: 9.39 | US: FDA-AP IX.A.3 (manual processes simulated at least as long as the real process); no per-operator interval.
- **FDA vs EU:** EU is stricter: 6-monthly per operator, against FDA's annual participation.
- **Verify:** An operator qualified on 10 mL vials is assigned a manual 50 mL fill → refused.

### ST-31: APS design coverage and the line's "APS-qualified envelope"
- **Theme:** 4
- **Covers:** n559, n560, n561, n562, n322, n389, n563, n566
- **Scope:** aseptic (lyo parameters: lyo)
- **Type:** ENFORCED (envelope checks). Envelope values are *derived* from successful APS records and cannot be typed in.
- **Behaviour:**
  - **APS batch type.** Generated from the commercial MBR with the same step structure. Media or a non-inhibitory surrogate replaces product, with growth-promotion status. The APS never serves as the primary validation of the aseptic process.
  - **Protocol fields** (worst case must be justified):
    - container/closure sizes, with bracketing or matrixing justified;
    - maximum line speed and maximum duration (at least the routine duration; manual or intervention-heavy processes at least as long as the real process);
    - maximum hold of exposed sterile product and equipment;
    - fill volume that wets all surfaces and leaves headspace;
    - **air in place of inert gas**, with occasional anaerobic runs considered;
    - maximum headcount and maximum operator time in the cleanroom;
    - shift changes and idle interruptions;
    - EM as in routine production throughout;
    - campaign start and end risks (an end-of-campaign APS may only supplement, never replace, routine APS);
    - all routine inherent and corrective interventions at representative frequency. Rare interventions are simulated periodically, and the catalogue holds each one's simulation interval.
  - **Lyo APS** covers filling, transport, loading, a representative chamber dwell, unloading and sealing. It records the worst cases challenged: SIP-to-load interval, filtration-to-loading time, number of trays, loading duration and dwell. Media must not boil or freeze, and a partial vacuum is used.
  - **Unit count.** Justified in the CCS, typically **≥5,000–10,000** units. For batches under 5,000 units, the APS must contain **at least as many units as the production batch**.
  - **Sterile API.** APS size and surface coverage are justified, and all simulation materials are microbially evaluated.
  - **Routine checks against the envelope.** A container size not covered, or a batch size above an APS of under 5,000 units, blocks batch creation. The following raise a deviation for QA assessment before release: longer duration, higher peak headcount, more occurrences of an intervention than demonstrated, line speed out of range, longer lyo loading, or longer holds.
- **Citations:** EU Annex 1: 9.32–9.37, 9.40 | US: 211.113(b); FDA-AP IX.A.1, IX.A.3–IX.A.6.
- **FDA vs EU:** Aligned on unit numbers and worst-case design. EU adds explicit lyo worst-case items and campaign start/end. FDA adds the common/rare intervention frequency idea.
- **Verify:** APS included 3 needle changes and the routine batch records 5 → flag. APS covered 6 h lyo loading and routine takes 7 h → flag. With a 3,000-unit APS, create a 3,500-unit batch → flagged/blocked.

### ST-32: APS execution record, unit accountability, incubation and reading
- **Theme:** 4
- **Covers:** n323, n567, n568, n569, n571, n327, n328, n329, n330, n331, n332, n390
- **Scope:** aseptic
- **Type:** ENFORCED (including the [EU hard] unit-removal rule). Incubation parameters are CONFIGURABLE inside the FDA numbers.
- **Behaviour:**
  - **Separate batch record per run.** It holds the rationale, a planned-vs-executed intervention matrix, participants and roles, line speed, duration and embedded EM/PM. It cannot be released for distribution and consumes no product inventory.
  - **Units:**
    - Every unit is inverted, swirled or agitated before incubation.
    - **All integral units are incubated**, including cosmetic rejects and units that passed non-destructive IPC. Wrongly rejected units go back to incubation.
    - Units may be removed without incubation only in the **exact catalogue number** for that intervention type and line location, and **never more than in a production run** [EU hard]. The same catalogue value applies in routine batches.
    - Set-up and mandatory line-clearance units are incubated as a separate population.
    - Product-flush equivalents are simulated with media and incubated unless shown irrelevant.
  - **Reconciliation.** Filled = incubated + justified non-incubated + separately incubated set-up units, with zero unexplained difference. Yield (incubated/filled) is checked against a configured criterion. Excluding an incubated unit needs justification and QA signature.
  - **Incubation:**
    - Clear containers are used; amber or opaque containers are replaced by identical-configuration clear ones, or a validated detection method is used.
    - Incubation starts without unnecessary delay (fill-end to incubation-start limit is a DESIGN-CHOICE, default 24 h).
    - **20–35 °C at all times, within ±2.5 °C of target, ≥14 days in total. With two temperatures, ≥7 days at each, lower temperature first.**
    - The incubator record and calibration are linked.
  - **Reading.** Done by qualified APS readers, with QC oversight if QC does not read. Each suspect unit is referred to the QC microbiologist immediately. Positive controls use reference organisms and local isolates, and isolates are identified to species where practical.
  - **Media growth promotion.** Must cover Gram-positive, Gram-negative, yeast and mould at **<100 CFU**, plus relevant isolates. The APS cannot close as passed until GPT passes. A GPT failure forces a repeat APS and two investigations.
  - **Traceability.** Units are time/tray-blocked and mapped to interventions, so a positive shows the surrounding activities. A QC observer signature is mandatory; video reference is optional.
  - **Abort or invalidation.** Allowed only by selecting an SOP rule that would equally apply to a commercial lot, with justification, QA approval and investigation. Invalidation frequency is reported per line.
  - **After closure.** The line is set to "post-media-fill clean required" until cleaning, sanitisation and sterilisation records are complete.
- **Citations:** EU Annex 1: 9.41–9.45, 9.47, 9.48 | US: 211.113(b), 211.188 (inferred), 211.67(a); FDA-AP IX.A.1, IX.A.7, IX.A.8, IX.A.9.
- **FDA vs EU:** **EU gives no incubation numbers**; it requires scientifically justified, validated conditions. FDA-AP's 20–35 °C / ±2.5 °C / ≥14 d / ≥7 d per temperature is used as the enforced default. Unit-removal rules are identical in substance.
- **Verify:** Record 12 units removed for an intervention whose catalogue value is 8 → refused. A 6-day + 8-day two-temperature scheme → phase rule fails. A GPT inoculum of 150 CFU → invalid.

### ST-33: APS failure consequences
- **Theme:** 4
- **Covers:** n570, n325, n326
- **Scope:** aseptic
- **Type:** ENFORCED. The acceptance profile is selected per line. **The EU rule is mandatory if any product qualified on the line is for an EU/PIC/S market.**
- **Behaviour (EU profile, default):**
  - Target is zero growth, and **any contaminated unit fails the APS**, whatever the run size. On recording a positive, the system automatically:
    1. sets the line to "production suspended";
    2. quarantines every product made on the line after the failed APS until the failure is resolved;
    3. builds the list of all batches since the last successful APS, requires a prompt record review with a per-batch sterility-breach risk assessment, and puts unreleased batches in the investigation scope with release blocked pending the outcome;
    4. flags already-released batches for a documented market-impact decision (FDA-AP);
    5. opens a root-cause investigation with CAPA and species identification;
    6. requires **normally ≥3 consecutive successful repeat APS** before the status returns;
    7. restricts implicated operators (ST-09).
- **Behaviour (US-only line profile):** the FDA-AP tiers, where every positive is still investigated:

  | Units filled | 1 contaminated unit | 2 contaminated units |
  |---|---|---|
  | <5,000 | investigation, then revalidation | – |
  | 5,000–10,000 | investigation, including whether to repeat | revalidation after investigation |
  | >10,000 | investigation | revalidation after investigation |

  - Intermittent or recurring positives on a line escalate to "revalidation required" even when each run is within the criteria.
  - Confirmatory runs: one or more after corrections, and three consecutive when the root cause is not conclusively found.
  - Impact on commercial batches made since the last passing media fill is always assessed.
- **Citations:** EU Annex 1: 9.46 | US: 211.113(b), 211.192 (inferred); FDA-AP IX.A.2, IX.A.9.
- **FDA vs EU:** **EU is stricter:** any positive fails the APS, product made after the failure is quarantined, and at least 3 repeats are normally required. FDA tolerates one positive in runs of 5,000 or more as investigation-only.
- **Verify:** Enter one turbid unit in a 12,000-unit APS on a line with an EU product → failed, line suspended, quarantine and impact list created, 3 repeat runs required. On a US-only line → investigation only.

---

## Theme 5: Interventions catalogue and log

### ST-34: Intervention catalogue (per line)
- **Theme:** 5
- **Covers:** n581, n464, n286
- **Scope:** aseptic
- **Type:** ENFORCED structure. Entry values are CONFIGURABLE and QA-approved.
- **Behaviour:**
  - Each catalogue entry holds these fields:
    - ID and description;
    - **type** (inherent / corrective) and **criticality** (enters the critical zone → critical); the two attributes are independent;
    - procedure reference;
    - qualifying APS (ID, date);
    - maximum count and duration demonstrated in APS;
    - frequency class (common / rare) with its simulation interval;
    - airflow-visualisation (smoke) study reference;
    - **number and positions of units to remove**;
    - required clearance (none / local / full) and the duration or exposure beyond which clearance becomes mandatory;
    - post-intervention actions (glove print and glove change, extra sterility sample).
  - Only entries qualified in a valid APS for the line can be selected. An entry without a smoke-study reference is flagged unqualified.
  - DESIGN-CHOICE: master-record review prefers engineering alternatives, such as in-line weight checks, SIP instead of aseptic connections, and automation.
- **Citations:** EU Annex 1: Glossary (inherent, corrective and critical interventions; critical zone), 4.15, 8.16 | US: 211.63, 211.113(b); FDA-AP IV.E, IX.A.3.
- **FDA vs EU:** EU formalises the authorised list and classification. FDA-AP stresses minimising interventions and simulating them. Aligned.
- **Verify:** Record an intervention: only entries qualified in a valid APS for this line can be selected. Post-intervention glove sampling fires for an inherent *critical* entry and not for a corrective *non-critical* one.

### ST-35: Intervention and stoppage log, and line clearance
- **Theme:** 5
- **Covers:** n466, n363, n364
- **Scope:** aseptic
- **Type:** ENFORCED
- **Behaviour:**
  - **Each intervention or stoppage records:**
    - start and end (duration computed, never typed);
    - catalogue ID, inherent/corrective, zone or filling position;
    - operators involved (qualification and APS coverage checked);
    - units removed, and whether line clearance was done.
  - **Corrective or major interventions also record:** what failed, what was adjusted or replaced, the tools and parts used with their sterilisation records, and immediate EM/PM where configured.
  - **Stops from PLC/SCADA** create entries automatically. A stop with no matching entry is flagged, and operators and reason are required before review.
  - **Line clearance.** If the catalogue requires clearance, or the intervention exceeds its maximum duration, restart is blocked until a clearance record exists: scope, units and positions removed, and reconciliation. Removed units are excluded from good output and counted in yield.
  - **Removal counts.** Removing a number of units different from the catalogue value in production is a deviation.
  - Links: glove sampling (ST-22), extra sterility samples (ST-66), timeline (ST-70).
- **Citations:** EU Annex 1: 8.17, 9.34 | US: 211.100(a)-(b), 211.188(b); FDA-AP XII.
- **FDA vs EU:** Aligned. FDA-AP adds line-clearance rules for major interventions.
- **Verify:** Replay a 7-min PLC stop with no entry → review flag. Log a needle realignment (local clearance) and restart without a clearance record → blocked.

### ST-36: Non-qualified interventions and exceedance of APS-demonstrated frequency
- **Theme:** 5
- **Covers:** n465
- **Scope:** aseptic
- **Type:** ENFORCED
- **Behaviour:**
  - An intervention not in the catalogue can be recorded only as "unqualified". It needs:
    - a real-time QA authorisation e-signature before the operator continues;
    - an automatic deviation and investigation;
    - flagging of the affected units and time window;
    - a mandatory QA disposition item that blocks certification until closed.
  - A catalogue intervention done more often than demonstrated in APS, or a rare intervention not simulated within its interval, raises a deviation for QA assessment (see ST-31).
- **Citations:** EU Annex 1: 8.16, 9.34 | US: 211.113(b), 211.192; FDA-AP IV.E, IX.A.3.
- **FDA vs EU:** EU is explicit that unqualified interventions are exceptional and are considered at disposition. FDA treats them through the deviation path. Aligned.
- **Verify:** Record an "other" intervention → QA sign-off required before continuing, deviation auto-created, certification blocked while open.

---

## Theme 6: Time limits driven by recorded events

### ST-37: Time-limit rule engine (mandatory timer set)
- **Theme:** 6
- **Covers:** n315, n316, n72, n467, n468, n469
- **Scope:** aseptic (items 1–12); terminal (item 13, see ST-60)
- **Type:** ENFORCED (the timer set must exist in every aseptic MBR; breach handling). Limit values are CONFIGURABLE, product-specific and validated. Neither text gives numbers, except that the time must be *validated*.
- **Behaviour:**
  - **Rule definition.** Each rule has a start event, end event, maximum (minimum where relevant) and validation reference. MBR approval is refused if any rule lacks its reference.
  - **Execution.** Timers run automatically from recorded events and warn before the limit. A breach blocks the step and all downstream steps until a deviation with justification and a QA decision exists. 211.111 accepts an overrun only if quality is not compromised.
  - **Mandatory set:**
    1. cleaning → drying → sterilisation of equipment, components and containers (dirty/clean hold);
    2. sterilised equipment, components and containers from cycle end to last use, including during filling/assembly;
    3. bio-decontaminated RABS/isolator from end of decontamination to start of aseptic work;
    4. start of product preparation → start of sterilising filtration or sterilisation;
    5. start of preparation → end of aseptic filling (product-specific overall limit reflecting composition and storage);
    6. filtered/sterilised product hold before filling;
    7. total filtration time, pauses included;
    8. aseptic processing time;
    9. filling time;
    10. product exposure on the line (first open container to last unit sealed);
    11. lyo: fill → lyo load, and partial-stopper exposure (ST-59);
    12. stopper → crimp (ST-57);
    13. terminal: preparation → sterilisation (ST-60).
  - Each limit is also checked against the longest duration qualified by APS (ST-31). Hold-vessel storage conditions are attached.
  - A time-limit compliance summary is part of batch review.
- **Citations:** EU Annex 1: 8.18(i)–(vii), 8.36, 8.85(ii) (maximum filtration time) | US: 211.111; FDA-AP VIII.
- **FDA vs EU:** Use the union. EU lists decontaminated-enclosure hold, aseptic processing time and filling time. FDA-AP lists line exposure time and a maximum total filtration time.
- **Verify:** Configure a 24 h preparation-to-fill-end limit and run 25 h → next step blocked until a QA-approved deviation. An MBR timer without a validation reference → approval refused.

### ST-38: Equipment status and hold chain; re-sterilisation between batches
- **Theme:** 6 (feeds 7)
- **Covers:** n430, n314, n337
- **Scope:** all (re-sterilisation rule: aseptic)
- **Type:** ENFORCED. Hold limits are CONFIGURABLE as validated.
- **Behaviour:**
  - **Equipment states:** dirty → cleaned → dried → sterilised → in use. The cleaned step records the CIP/wash cycle ID, validated procedure version and final-rinse quality (for example conductivity; endotoxin removal by hot-WFI rinse).
  - **Hold enforcement.** Dirty-hold and clean-hold limits are enforced. An item cleaned but not dried or sterilised within the limit cannot be used. A CIP with out-of-spec final rinse leaves the item "not clean".
  - **Endotoxin.** Only cleaning or dry heat is accepted as removing endotoxin from equipment. Moist heat and filtration are not treated as depyrogenating.
  - **Re-sterilisation.** Product-contact equipment gets a fresh sterilisation per batch by default. A campaign is allowed only with a validated MBR rule (maximum batches or hours plus validation reference); exceeding it is refused.
- **Citations:** EU Annex 1: 5.4, 8.18(i) | US: 211.63, 211.65(a), 211.67(a), 211.113(b); FDA-AP VII, IX.C (footnote 19).
- **FDA vs EU:** Aligned. FDA-AP is explicit that equipment is re-sterilised between batches unless a validated interval exists.
- **Verify:** Assign a vessel past its clean-hold → blocked. With a validated 3-batch campaign rule, the 4th batch → refused.

---

## Theme 7: Components, container-closures, depyrogenation, sterilisation cycles and load traceability

### ST-39: Component release, including bioburden, endotoxin and microbial tests before use
- **Theme:** 7
- **Covers:** n393, n300, n301
- **Scope:** all
- **Type:** ENFORCED
- **Behaviour:**
  - Material master flags microbial, bioburden, endotoxin and particulate specifications. This covers APIs, excipients, WFI as an ingredient, containers and closures.
  - At dispensing or issue, the lot must be QC-released with each flagged result present and within limits. Lots failing endotoxin are rejected. Quarantined, untested or "micro test before use" lots cannot be staged or consumed.
  - Storage location and condition are checked at issue.
  - Component lot numbers and result references are written into the batch record.
- **Citations:** EU Annex 1: 2.1(iv), 10.2 | US: 211.80(a)-(b), 211.84(d)(6) (binding); FDA-AP VI (text box), VI.A.
- **FDA vs EU:** Aligned. The US rule is binding.
- **Verify:** Dispense an excipient with its endotoxin result pending → hard stop.

### ST-40: Sterile components from suppliers or contract sterilisers, and sterile additions
- **Theme:** 7
- **Covers:** n395, n309, n302, n461, n378
- **Scope:** aseptic (supplier checks: all)
- **Type:** ENFORCED
- **Behaviour:**
  - Applies to RTU/RTS items (nested syringes, RTU vials, RTU stoppers, gamma-sterilised assemblies) and to contract-sterilised components. Before issue:
    - supplier and contract steriliser are in approved status;
    - the finished-product maker's review of the contractor's validation protocol **and** report is current;
    - the CoA-reliability confirmation under 211.84(d)(3) is current, otherwise full testing is required;
    - the lot's CoA, sterilisation certificate and a visual identity check are recorded.
  - **Aseptically added sterile components.** The method used (filtration, sterile crystallisation, dry heat, irradiation) must match the MBR registration, with evidence linked. Missing evidence blocks the addition.
  - **Non-filterable products.** Every material addition needs sterility evidence and is made aseptically in Grade A. All contact equipment and bulk/intermediates are sterilised.
  - **Aseptic upstream stages** (for example aluminium-adjuvanted suspensions): steps that expose product or contact surfaces need ISO 5/Grade A unidirectional air with an ISO 7 / Grade B or better background. EM and PM tasks are generated for these stages. End-of-operation surface EM must be recorded before the cleaning step can be signed. Sterile bulk transfer and transport are logged: vessel ID, integrity or pressure status, route, times, and a hold within the validated vessel-integrity time (ST-29). Where the MBR requires a bulk sterility test, the downstream step is blocked until the result is linked.
- **Citations:** EU Annex 1: 2.5(vii)-(viii), 8.11 | US: 211.84(d)(3), 211.113(b); FDA-AP VI.A, VI.B.1, Appendix 3.A.
- **FDA vs EU:** Aligned. FDA-AP is explicit that the product maker must itself evaluate the contractor's validation.
- **Verify:** Issue RTU syringe tubs after the CoA-reliability confirmation has lapsed → blocked. Add a sterile API lot without a sterility certificate → blocked.

### ST-41: Container and closure preparation: wash, rinse, siliconisation, sterilisation/depyrogenation, hold
- **Theme:** 7
- **Covers:** n303, n304, n305, n308, n29
- **Scope:** all (sterilisation/depyrogenation where the product requires it)
- **Type:** ENFORCED. Hold limits are CONFIGURABLE as validated.
- **Behaviour:**
  - Each container or closure lot needs a complete preparation record before the filler can accept it. The record contains:
    - wash program ID and water point, with water status in specification (parenterals: final rinse at WFI quality; stoppers: first washes with low-endotoxin purified water or better, final rinse with WFI);
    - wash-end, drying-end and sterilisation-start timestamps, with a maximum wash-to-sterilise time;
    - silicone lot (must be released);
    - validated stopper load configuration (bag count, fill level) and penetration-validated recipe;
    - depyrogenation or sterilisation cycle ID, equipment and load.
  - At cycle end a use-by time is computed from the MBR hold limit for that item and pack type. Use after it is blocked or deviation-gated.
  - The preparation process's revalidation due date is checked at line clearance.
- **Citations:** EU Annex 1: 8.18(i)-(ii) | US: 211.94(c)-(d) (binding); FDA-AP VI (text box), VI.B.1.
- **FDA vs EU:** FDA-AP is more specific on stopper washing, siliconisation and water quality. Apply it as written.
- **Verify:** Stoppers sterilised at T0 with a 72 h hold are used at T0+73 h → blocked. A stopper load with a wash record but no sterilisation cycle → refused at the filler.

### ST-42: Product-contact parts sterile and traceable; aseptic assembly and connections
- **Theme:** 7
- **Covers:** n431, n336, n462, n463, n371
- **Scope:** aseptic
- **Type:** ENFORCED
- **Behaviour:**
  - The MBR lists every **direct and indirect** product-contact item: needles, pumps, manifolds, tubing, filter housings, stopper bowls, guides and hoppers.
  - At fill start each item must resolve to a passed sterilisation record (steriliser, cycle, validated load pattern), a SIP record or a supplier irradiation certificate. It must also be within sterile hold with packaging intact. Otherwise fill start is blocked and the item is named.
  - Each item declares its method: SIP, autoclave, dry heat or irradiation. *Surface decontamination* (for example VHP) is allowed for a product-contact surface only on heat-labile items **and** only with a validation reference showing **≥6-log** reduction. Heat-tolerant items cannot be assigned decontamination.
  - Unwrapping, assembly and line set-up are "aseptic" steps. They force Grade A with a Grade B background (isolator background per ST-74), aseptic-qualified operators, and intervention and EM linkage.
  - Each aseptic connection records its method:
    - open, in Grade A with Grade B background;
    - post-connection SIP (cycle ID);
    - intrinsic sterile connector (type, lot).

    An open connection outside Grade A is blocked.
- **Citations:** EU Annex 1: 5.5, 8.12–8.14 | US: 211.67, 211.113(b) (binding); FDA-AP IX.C, Appendix 1.E.
- **FDA vs EU:** Aligned. The 6-log figure for decontaminating product-contact surfaces is from FDA-AP.
- **Verify:** Leave one pump head without an autoclave link → fill start blocked with the item named. Assign VHP to a stainless needle → MBR approval refused.

### ST-43: Steriliser readiness, validated recipes and load patterns
- **Theme:** 7
- **Covers:** n483, n484, n338, n339, n496, n497, n340, n341, n342
- **Scope:** all
- **Type:** ENFORCED. Intervals are CONFIGURABLE but never looser than: vacuum leak test **≤7 days**, air-removal test **same day** before porous loads, worst-case heat-cycle revalidation **≤12 months**.
- **Behaviour:**
  - **Readiness.** A steriliser, SIP circuit, oven or tunnel can be used only if all of these hold:
    - it is qualified, PM is not overdue and there is no open change control;
    - the controlling and recording sensors, timers and belt-speed sensors are in calibration;
    - where there is a vacuum phase or a return to sub-ambient pressure, a passing vacuum leak test is **≤7 days** old;
    - for porous loads, a passing air-removal (Bowie-Dick type) test was run **that day**, or an air detector works on every cycle.
  - **Load building.** Loads are built against a **validated load-pattern ID**: item types, quantities, positions, and minimum/maximum load. Items or quantities outside the pattern are refused.
    - The cycle recipe must be linked to that pattern and to a current validation.
    - Worst-case heat-sterilisation patterns revalidated more than 12 months ago cannot be selected. Other patterns use the CCS interval.
  - **Cycle master data.** Stores target SAL ≤10⁻⁶ (at most one non-sterile unit per million).
  - **BIs.** Where used, the record holds BI lot, verified population and D-value source (qualified CoA or in-house).
  - **Manual valves.** Operated through an ordered checklist: valve ID, required and actual position, time, user. Sequence errors are blocked.
  - **Performance trending.** Come-up/equilibration time is trended per steriliser. Out-of-range values or drift are flagged before the load is used.
- **Citations:** EU Annex 1: 8.35, 8.36, 8.38–8.40, 8.60, 8.61 | US: 211.63–211.68, 211.113(b), 211.160(b)(4), 211.188(b) (inferred); FDA-AP IX.C.1, IX.C.2, Glossary (SAL).
- **FDA vs EU:** EU is stricter numerically (annual worst-case revalidation, weekly leak test, daily air-removal test). FDA-AP says "periodic" and adds manual-valve documentation and SAL 10⁻⁶.
- **Verify:** Last leak test 8 days ago → autoclave not selectable. Add 2 tubing sets beyond the pattern maximum → load refused.

### ST-44: Automated cycle acceptance and quarantine of non-conforming cycles
- **Theme:** 7
- **Covers:** n485, n486, n491, n492, n495, n494
- **Scope:** all
- **Type:** ENFORCED
- **Behaviour:**
  - **Comparison with the validated recipe.** Each imported cycle is checked on:
    - phase durations; a phase **longer or shorter** than validated is a deviation even when exposure passed;
    - temperatures and pressures;
    - porous loads: drain temperature over the whole exposure, equilibration time, exposure time, pressure/temperature agreement with saturated steam, minimum and maximum exposure temperature;
    - fluid loads: time and temperature and/or F0;
    - SIP: condensate-drain temperatures.
  - **Exposure timing.** Valid only once the whole load (coldest or load probe) has reached temperature. The cooling medium in contact with sterilised items is recorded with its sterility evidence.
  - **Duplex channels.** Both the control channel and the independent monitoring channel are imported with probe IDs and positions. A difference beyond tolerance fails the review.
  - **Failure or deviation.** The load is auto-quarantined, its items cannot be consumed, and an investigation opens.
  - **BIs.** BI lot verified (population, purity, identity), positions, incubation results and a positive control per cycle. **A passing BI never clears a cycle that failed physical parameters.**
  - **Unload.** Load dryness check and per-item inspection for damage, wet packs or breached packaging. Rejects are removed and investigated, and the load cannot be released without the unload record.
- **Citations:** EU Annex 1: 8.41–8.43, 8.50–8.53, 8.55–8.59 | US: 211.113(b); FDA-AP IX.C.1.
- **FDA vs EU:** EU is more detailed. Aligned in principle.
- **Verify:** Import a cycle with heating phase 20% longer than validated but passing exposure → quarantined. Enter passing BIs on a cycle with a failed temperature → load stays rejected.

### ST-45: Sterile-state tracking of items and carriers; sterile packaging and hold
- **Theme:** 7
- **Covers:** n487, n489
- **Scope:** all
- **Type:** ENFORCED. Packing-to-sterilisation and sterile-hold limits are CONFIGURABLE as validated.
- **Behaviour:**
  - Every carrier and item carries ID, product/batch and state: to be sterilised / sterilised, pending review / released / rejected.
  - Point-of-use scanners refuse anything not "released sterile". Process indicators (tape, dots) are recorded but never serve as release evidence on their own.
  - Packing time, sterilisation time and sterile expiry are tracked, and the maximum packing-to-sterilisation time and sterile hold are enforced.
  - At use, the operator confirms sterile-barrier integrity for each item or rejects and replaces it.
- **Citations:** EU Annex 1: 8.44, 8.46, 8.48 | US: 211.113(b).
- **FDA vs EU:** EU is explicit. FDA-AP has equivalent expectations in IX.C.
- **Verify:** Scan a tray whose cycle is unreviewed at Grade A entry → refused.

### ST-46: Material transfer into Grade A/B and into the critical zone
- **Theme:** 7
- **Covers:** n406, n407, n408, n288, n490
- **Scope:** aseptic (lower-to-higher grade disinfection: all)
- **Type:** ENFORCED
- **Behaviour:**
  - Each transfer records the item and its method: double-ended steriliser load ID, tunnel run, wipe-down disinfection (agent, lot, expiry, contact time, operator), RTP, or filter. It also records the validated transfer procedure ID.
  - The item is checked against the **approved transfer list**. An unlisted item is blocked unless a pre-approved QA exception (risk assessment, disinfection and extra monitoring) is linked. The exception shows in batch review.
  - Moving from a lower to a higher grade needs a disinfection record before acceptance. An expired agent is rejected.
  - Items for the critical zone need a valid sterilisation record within hold; disinfection alone is refused.
  - Non-sterilisable items needed in Grade A get validated disinfection and are added to the batch surface-EM plan.
  - Exits are logged separately with times. Where time-based separation is used, an overlapping entry and exit triggers a warning.
- **Citations:** EU Annex 1: 4.10–4.12, 8.47, 8.49 | US: 211.42(b), 211.113(b); FDA-AP IV.E.
- **FDA vs EU:** EU adds the approved-list and exception mechanism. Aligned otherwise.
- **Verify:** Use a tool in the filling zone with only a disinfection record → blocked. Scan an unlisted tool at the Grade B hatch → blocked.

### ST-47: Dry-heat sterilisation/depyrogenation: tunnels and ovens
- **Theme:** 7
- **Covers:** n500, n501, n502, n306
- **Scope:** all (tunnel: aseptic)
- **Type:** ENFORCED. Tunnel HEPA test interval is CONFIGURABLE, default and maximum 6 months.
- **Behaviour:**
  - **Per run, attached to the container lot:** equipment, validated recipe and load pattern, container format, belt speed or dwell time, zone minimum and maximum temperatures, time at temperature, DP/airflow profile, alarms, chart, and controller Fh against the validated minimum.
  - **Readiness.** Belt-speed and temperature instruments must be calibrated, and the tunnel HEPA integrity test must be current.
  - **Excursions.** Any excursion quarantines the containers processed in that window, identified by time, and a deviation is raised.
  - **Ovens.** Positive pressure against lower grades is held through the sterilisation and post-sterilisation hold, unless packaging integrity is maintained. Loss of pressure on an unwrapped load rejects it.
  - **Validation.** Must show **≥3 log₁₀ endotoxin reduction**; once shown, no separate sterilisation demonstration or BI study is needed. Endotoxin-spiked validation containers are fully reconciled, and a run with an unreconciled spiked unit keeps the tunnel unreleased.
- **Citations:** EU Annex 1: 8.66–8.70 | US: 211.94(c), 211.113(b); FDA-AP VI.B.1, IX.C.2.
- **FDA vs EU:** Aligned on 3-log. Tunnel HEPA testing: EU text says "at least biannually" (ambiguous); FDA-AP says twice a year, so 6 months is used (see Conflicts).
- **Verify:** Import a tunnel trace with a 5-min hot-zone dip → containers in that window quarantined.

### ST-48: Sterilisation-in-place and post-SIP integrity
- **Theme:** 7
- **Covers:** n499
- **Scope:** all
- **Type:** ENFORCED. Maximum post-SIP hold is CONFIGURABLE as validated.
- **Behaviour:**
  - The SIP record holds temperature, pressure and time at each monitored location (correlated with the slowest-heating points), plus cycle ID and result.
  - After SIP, integrity status is tracked (positive-pressure trend, or sterilising vent-filter ID), along with the maximum hold until product use.
  - Loss of pressure invalidates the SIP and blocks product transfer.
- **Citations:** EU Annex 1: 8.63 | US: 211.113(b); FDA-AP IX.C.1.
- **FDA vs EU:** Aligned.
- **Verify:** Import a post-SIP pressure trend that falls to ambient before use → SIP invalid, transfer blocked.

### ST-49: Radiation- and ethylene-oxide-sterilised materials; UV excluded
- **Theme:** 7
- **Covers:** n503, n504, n505, n506, n307
- **Scope:** all
- **Type:** ENFORCED (UV exclusion is [EU hard])
- **Behaviour:**
  - **UV** is not offered as a sterilisation method. It can be logged only as a bioburden-reduction aid.
  - **Irradiated items** record the certificate, processing lot and a dose within the validated range. A dose below the minimum rejects the lot.
  - **EO-sterilised items** cannot be issued until all of the following are recorded:
    - a justification that no other method is practicable;
    - the cycle record: preconditioning time, temperature and RH; gas concentration, pressure and quantity; exposure time;
    - BI results at every validated location, with a positive control per cycle;
    - aeration start, end and conditions, with the **validated minimum aeration elapsed**;
    - residual EO and reaction-product results within limits.
- **Citations:** EU Annex 1: 8.71 (UV not acceptable), 8.72–8.78 | US: 211.94(d), 211.113(b); FDA-AP VI.B.1.
- **FDA vs EU:** EU is stricter: EO only as a last resort, and an explicit UV ban.
- **Verify:** Set a component's method to UV → option unavailable. Issue an EO lot with residuals pending → blocked.

---

## Theme 8: Sterilising filtration, filter integrity (PUPSIT/post-use) and bioburden

### ST-50: Sterilising filter selection matches the validated and registered filter
- **Theme:** 8
- **Covers:** n507, n333, n29, n76
- **Scope:** aseptic (the 211.72 fibre rule: all injectable liquid filtration)
- **Type:** ENFORCED
- **Behaviour:**
  - **Filter master data.** Each product holds its validated and registered filter part number(s): polymer, pore rating, and, where used, redundant configuration. It also holds the validation reference: bacterial retention under worst case, challenge **≥10⁷ organisms per cm²** of filter area (typically *B. diminuta*, or a justified isolate), preferably in product.
  - **Pore rating.** The final filter must be **≤0.22 µm nominal** (EU). FDA-AP accepts 0.2 µm or smaller and treats 0.2 and 0.22 as interchangeable ratings.
  - **Installation scan.** The filter must equal the registered and validated part number. The same polymer and rating is not enough if the part differs. Otherwise installation is refused. Lot, serial and sterilisation evidence (in-house load or supplier irradiation certificate) are recorded.
  - **211.72 attributes.** The filter master carries "non-fibre-releasing" and "asbestos-free". An MBR that specifies a fibre-releasing filter cannot be approved unless a downstream non-fibre-releasing filter of **≤0.2 µm** follows it. **0.45 µm** is allowed only where manufacturing conditions require it, with a recorded justification. Asbestos-containing filters are never allowed.
- **Citations:** EU Annex 1: 8.79 (with cross-reference to 8.135), 8.83–8.85 | US: 211.72 (binding), 211.113(b); FDA-AP IX.B.
- **FDA vs EU:** Numerically equivalent (0.2/0.22 µm). EU also requires the filter to match the marketing authorisation. The US adds the binding fibre-release and asbestos rule.
- **Verify:** Scan a 0.45 µm or non-registered part for final filtration → refused.

### ST-51: Filter train configuration and routine filtration parameters
- **Theme:** 8
- **Covers:** n508, n509, n510, n317
- **Scope:** aseptic
- **Type:** ENFORCED. The validated envelope is master data, not editable at execution.
- **Behaviour:**
  - **Train master data.** Each position records its role: bioburden-reduction prefilter, primary sterilising filter, or redundant sterilising filter near the point of fill. The redundant filter is a CCS decision; Annex 1 says it should be *considered*. The eBMR generates install, test and sampling steps from the train. It counts aseptic connections downstream of the final filter for review.
  - **Validated envelope per product and filter:**
    - integrity-test wetting fluid and specification;
    - pre-filtration hold and its bioburden effect;
    - conditioning;
    - **maximum filtration and contact time**;
    - maximum pressure, flow range, **maximum volume** and temperature;
    - time to filter a known volume and the DP across the filter.
  - **Execution record.** Start and end (including pauses), volume, flow, upstream and downstream pressure/DP, and temperature. Filtration time per known volume is computed from instrument data where available. The batch record must contain at least the time to filter a known volume and the DP. Values outside the envelope raise a deviation automatically; a significant difference is investigated.
  - **Prefilter usage register.** Tracks accumulated use time and lots for prefilters and clarification filters, and blocks use beyond the justified maximum.
- **Citations:** EU Annex 1: 8.80–8.86 | US: 211.111, 211.113(b); FDA-AP VIII, IX.B.
- **FDA vs EU:** Aligned. Both require a maximum filtration time. EU lists the minimum batch-record content.
- **Verify:** Import a DP above the validated maximum → automatic deviation. Record filtration 08:00–16:30 against an 8 h maximum → deviation.

### ST-52: Filter integrity testing: PUPSIT, post-use test and redundant/serial logic
- **Theme:** 8
- **Covers:** n511, n512, n514, n335
- **Scope:** aseptic
- **Type:** ENFORCED. Post-use testing always. **PUPSIT** is ENFORCED in the EU profile with a waiver path. In a US-only profile the pre-use test is CONFIGURABLE, default on.
- **Behaviour:**
  - **PUPSIT.** A mandatory step between filter sterilisation and product filtration. It can be omitted only where the product/filter configuration carries an approved PUPSIT-waiver risk assessment. The assessment must cover filter-sterilisation process control, the supply chain (contract steriliser, transport, protective packaging) and product knowledge (for example, particle burden that could mask a non-integral filter in the post-use test). The waiver ID is displayed in the batch record and QP review.
  - **Post-use test.** A non-destructive test (bubble point, diffusive flow, water intrusion or pressure hold) of **every** sterilising filter used on a fluid. It is run **after use and before removal from the housing**; recording removal first is refused.
  - **Test record:** test type, tester ID and calibration, wetting fluid, temperature, test pressure, measured value, the product-specific limit pulled from filter master data (never typed), pass/fail, and the raw printout or e-file. The limit must correlate with the bacterial-retention validation.
  - **Failure handling.** A failed or invalid test causes a deviation, batch hold and certification block. Retests are allowed only under the defined procedure, and every attempt is kept.
  - **Multi-filter logic:**
    - A train *validated as a serial system*: every filter must pass post-use.
    - A *redundant* train: the primary is tested post-use. If it passes, the backup need not be tested. If it fails, the backup must be tested post-use, and an investigation plus risk assessment into the primary failure opens automatically. Both results appear at QP review.
- **Citations:** EU Annex 1: 8.82(vi), 8.87, 8.91, 8.92 | US: 211.113(b), 211.192; FDA-AP IX.B, IV.D.1.
- **FDA vs EU:** **EU is stricter.** EU expects PUPSIT, with a documented risk-based alternative only where it is not feasible. FDA-AP says pre-use testing *can* be done and post-use testing should be routine.
- **Verify:** Start filtration without PUPSIT on a product with no waiver → blocked. A redundant train with the primary failing post-use → the backup test step appears, an investigation is created, and the batch is blocked until both are complete.

### ST-53: Filter single-batch use, maximum duration, and vent filter lifecycle
- **Theme:** 8
- **Covers:** n516, n334, n513
- **Scope:** aseptic (vent/gas filter rules: all)
- **Type:** ENFORCED. Maximum durations and cycle counts are CONFIGURABLE as validated.
- **Behaviour:**
  - **Liquid sterilising filters.** A serial is bound to **one batch**. Continuous use beyond **one working day** is blocked unless validated.
    - Campaign use requires a CCS justification and validation, with a documented maximum duration enforced by recorded times.
    - Under the FDA profile, reuse across lots is allowed only if validation states the maximum number of lots; the system counts lots and blocks beyond.
  - **Vent and gas filters:**
    - Critical sterile gas and air vent filters that directly affect product sterility get a post-use integrity test in the housing for each batch, and that test is a release item.
    - Non-critical vent filters are confirmed integral at defined intervals.
    - Long-duration gas filters are tested at installation and before replacement.
    - A maximum use duration (days, uses, SIP cycles) is specified and enforced.
  - A "defective/contaminated" flag retires a filter permanently.
- **Citations:** EU Annex 1: 8.88–8.90, 8.94, 8.95 | US: 211.113(b); FDA-AP IX.B.
- **FDA vs EU:** **EU is stricter.** It caps use at one working day unless validated. FDA-AP normally discards after one lot and allows justified multi-lot reuse.
- **Verify:** Scan a filter serial used yesterday → refused. Run a tank vent filter beyond its maximum SIP cycles → blocked.

### ST-54: Pre-sterilisation bioburden per batch
- **Theme:** 8 (also 11)
- **Covers:** n515, n574, n351
- **Scope:** all (aseptic and terminal)
- **Type:** ENFORCED. The overkill-cycle interval option is CONFIGURABLE with justification.
- **Behaviour:**
  - **Every batch** has a bioburden sample at the worst-case point:
    - aseptic: from the bulk immediately before final sterile filtration; in a redundant set-up, before the *first* filter;
    - terminal: immediately before loading into the steriliser;
    - in both cases, at the end of any hold.
  - The sample is timestamped relative to the hold and to the filtration or cycle start. Sampling after filtration started is a sequence violation. Sampling at the start of a long hold raises a warning. The sampling system must not introduce contamination.
  - The result is checked against the product limit, which is tied to the filter challenge or cycle lethality. A result over the limit raises a deviation. The result is a mandatory release item and is trended per product.
  - For overkill terminal cycles, monitoring at scheduled intervals instead of every batch is allowed with justification. Parametric release: ST-61.
- **Citations:** EU Annex 1: 8.93, 10.3 | US: 211.110(a), 211.113(b); FDA-AP X.C, IX.B, XI.C.5.
- **FDA vs EU:** Aligned. EU is explicit about per-batch sampling and the sampling point.
- **Verify:** Filtration start without a bioburden sample → blocked. Release with the result pending → blocked.

---

## Theme 9: Filling, fill weight/volume checks, stoppering and capping

### ST-55: Open-container routing under Grade A and validated closure
- **Theme:** 9
- **Covers:** n471
- **Scope:** aseptic
- **Type:** ENFORCED
- **Behaviour:**
  - The line map is validated so that open primary containers pass only through Grade A zones, with the background suited to the technology, from depyrogenation/sterilisation exit to closure.
  - Partially stoppered vials and PFS follow the lyo transfer rules (ST-59).
  - The closure step records the validated closing method or equipment and its key settings.
- **Citations:** EU Annex 1: 8.20, 8.21 | US: 211.42(c)(10), 211.113(b).
- **FDA vs EU:** Aligned (ISO 5 critical area).
- **Verify:** Route open vials through a zone not classified Grade A in the line map → MBR rejected.

### ST-56: In-process controls: fill weight/volume and device functional tests
- **Theme:** 9
- **Covers:** n386, n311, n86
- **Scope:** all (device tests: PFS, cartridges, autoinjectors)
- **Type:** ENFORCED (scheduling, limits, reaction). IPC content is CONFIGURABLE.
- **Behaviour:**
  - **IPC definition.** The MBR defines each IPC: trigger (time or unit count), sample size, method, equipment, limits and reaction rules. Examples: fill weight/volume, stopper seating, seal checks. In-line automatic checkweighing is the preferred design because it avoids interventions.
  - **Execution.** A missed IPC is flagged. An out-of-limit result raises a deviation and a 211.192 investigation (ST-63).
  - **Manual checks in ISO 5.** A manual weight check inside ISO 5/Grade A is also logged as an intervention with its duration.
  - **Device presentations.** Scheduled functional IPCs, such as delivery volume and break-loose/glide or activation where relevant. Device-component genealogy is kept (plunger rods, subassemblies).
  - The 21 CFR Part 4 cross-references for combination products are **not verified** (see Open questions).
- **Citations:** EU Annex 1: 8.101, 8.115 (fill volume as a CPP for FFS/BFS) | US: 211.110(a) (binding); FDA-AP IV.E, VI.B.2; 21 CFR Part 4 (unverified).
- **FDA vs EU:** The US is more explicit through binding 211.110(a). Annex 1 names fill volume only as a CPP for FFS and BFS.
- **Verify:** Miss a 15-min fill-weight check → flagged. Record a manual weight check in ISO 5 → also logged as an intervention.

### ST-57: Stoppering and capping: capping mode, Grade A air supply, stopper-height detection, stopper-to-crimp time
- **Theme:** 9
- **Covers:** n475, n582, n476, n289
- **Scope:** aseptic
- **Type:** ENFORCED. The maximum stopper-to-crimp time is CONFIGURABLE as validated.
- **Behaviour:**
  - **Capping mode** is recorded per line.
    - *Aseptic capping* uses sterilised caps, with sterilisation evidence.
    - *Clean-process capping:* vials stay under Grade A until they leave the aseptic area, then under **Grade A air supply** until crimped. The background of the Grade A air supply must be at least Grade D.
  - **Zone types.** Zone master data separates "Grade A zone" from "Grade A air supply". Air supply means filtered air qualified to Grade A particle quality. For it, the EM engine asks for no continuous particle counting and no Grade A viable limits, but it records air-supply status. A loss of air supply raises a batch event for the vials in that window.
  - **Stopper-height detection.** Clean-process capping needs **qualified automated stopper-height detection**. A challenge at batch start (and periodically) is mandatory before capping starts. Vials with missing or displaced stoppers are rejected before capping and counted in reconciliation.
  - **Stopper-to-crimp time.** Checked against the configured maximum. Exceeding it, or losing local protection, raises a deviation.
  - **Manual capping** happens only in Grade A (isolator, or Grade A with Grade B background). Interventions at the capper must avoid direct vial contact. The crimper sits at a separate station with extraction; this is a facility item.
- **Citations:** EU Annex 1: 8.26–8.29, Glossary (Grade A air supply) | US: 211.42(c)(10); FDA-AP IV.E.
- **FDA vs EU:** EU is stricter. It makes automated stopper-height detection an expectation and defines Grade A air supply. FDA-AP says local protection until crimping, and that on-line detection *adds* assurance.
- **Verify:** Run clean-process capping without the stopper-height challenge → capping cannot start. Record a 3 h stopper-to-crimp gap against a 2 h limit → deviation.

---

## Theme 10: Lyophilisation

### ST-58: Lyophiliser readiness: sterilisation frequency, integrity, leak rate, vent filter, trays
- **Theme:** 10
- **Covers:** n528, n529, n530, n531
- **Scope:** lyo
- **Type:** ENFORCED. The CCS-justified sterilisation interval for automated or barrier-protected units is CONFIGURABLE.
- **Behaviour:**
  - **Loading mode.** Lyophiliser master data records manual-open (no barrier separation), automated, or closed-barrier.
    - **Manual-open:** a new successful sterilisation is required **between every unload and the next load**, as a hard block. This has applied since 25 Aug 2024.
    - Automated or closed-barrier: the CCS-justified frequency is enforced, and the CCS reference is displayed.
  - **Conditions for loading:**
    - a passing SIP record exists, no older at loading than the **longest sterilisation-to-use interval challenged in the last successful APS**;
    - no maintenance or cleaning event has occurred after it; otherwise re-sterilise;
    - trays and vial rings have their own sterilisation load IDs.
  - **Every cycle:**
    - the start-of-cycle leak-rate result is at or below the specified maximum air leakage; a failure blocks the cycle and release;
    - the integrity/vent filter is sterilised before each use, and its **integrity test result is on the QP release checklist**;
    - the chamber leak-test frequency is documented.
  - **Trays.** IDs are tracked with last inspection date. A tray that is overdue or flagged misshapen or damaged is refused.
- **Citations:** EU Annex 1: 8.122, 8.123 (from 25 Aug 2024), 8.124, 8.125 | US: 211.113(b), 211.68 (inferred); FDA-AP IV.D.1 (sterile filter on the lyophiliser vacuum break).
- **FDA vs EU:** FDA-AP is silent on lyophiliser sterilisation frequency and leak rate, so EU governs.
- **Verify:** On a manual-open lyophiliser, attempt a second load without a new SIP → hard block. Start leak rate above maximum → cycle flagged and release blocked.

### ST-59: Lyo transfer, loading and unloading as aseptic operations; lyo cycle record
- **Theme:** 10
- **Covers:** n527, n532, n287, n78
- **Scope:** lyo
- **Type:** ENFORCED (aseptic extension [EU hard], Grade A transfer). Cycle-parameter checks are CONFIGURABLE per validated recipe.
- **Behaviour:**
  - **Aseptic extension.** Transfer, loading, the cycle and unloading are treated as extensions of aseptic processing until containers are fully sealed. They inherit Grade A checks, aseptic-qualified operators, intervention logging, and the EM coverage window, which extends to the end of unloading/sealing.
  - **Transfer.** Partially closed containers move only under Grade A/ISO 5: conveyor, qualified clean-air cart, or portable UDAF. Alternatively they travel in validated closed trays or boxes, closed in Grade A and not opened in Grade B. The record holds the transfer device ID and qualification, and its Grade A/airflow status in transit. A transit alarm flags the affected trays.
  - **Loading record:**
    - shelf-by-shelf pattern (tray IDs, vial counts);
    - first tray out of the filler, last tray loaded, chamber closure; these drive the **partial-stopper exposure timer** (ST-37);
    - sterile utensil IDs.
  - **Unloading.** A stopper-seating check is recorded. If stoppers are not fully seated before the chamber opens, the units stay in Grade A until capped.
  - **Cycle record** from the lyophiliser SCADA/historian:
    - recipe ID and version;
    - per-phase set points and actuals for shelf temperature, chamber pressure and condenser temperature;
    - product probes, pressure-rise tests and phase durations.

    Values are compared with the validated (filed) cycle, and excursions raise deviations. This detail is sourced outside Annex 1 and FDA-AP; see "What FDA-AP does not cover".
- **Citations:** EU Annex 1: 8.121, 8.126 | US: 211.42(c)(10), 211.111, 211.113(b), 211.188(b) (inferred); FDA-AP IV.E; FDA *Guide to Inspections of Lyophilization of Parenterals* (1993; not in the uploaded texts, unverified).
- **FDA vs EU:** Aligned on ISO 5 transfer. EU adds the explicit "extension of aseptic processing" [EU hard] and the closed-tray option.
- **Verify:** Load with an unqualified transfer cart → blocked. Exceed the partial-stopper exposure limit → deviation.

---

## Theme 11: Terminal sterilisation

### ST-60: Terminally sterilised products: preparation/filling grades and preparation-to-sterilisation time
- **Theme:** 11
- **Covers:** n456, n457, n458, n382
- **Scope:** terminal
- **Type:** ENFORCED (grade floors). Risk flags and the time limit are CONFIGURABLE; the time limit must be validated.
- **Behaviour:**
  - **Grade floors:**
    - component and solution preparation: **≥ Grade D**;
    - preparation raised to **≥ Grade C** automatically when the product has an unusual contamination risk (supports microbial growth, long hold before filling, not processed mainly in closed vessels), and for ointments, creams, suspensions and emulsions;
    - filling: **≥ Grade C**;
    - filling moves to **Grade A with ≥ Grade C background** when the CCS shows unusual environmental risk (slow filling, wide-neck containers, exposure of more than a few seconds before closure).

    Product and container risk flags drive these grades.
  - Primary containers and components are cleaned by validated processes that control particles, endotoxin and bioburden.
  - Where possible, the bulk passes a microorganism-retaining filter before filling; its filter ID is recorded.
  - A **preparation-to-sterilisation** timer uses the validated maximum (ST-37 item 13). Pre-sterilisation bioburden: ST-54.
  - Cycle master data holds **SAL ≤10⁻⁶**, meaning at most one non-sterile unit per million. An "overkill" cycle means a **≥12-log** reduction of organisms with **D ≥1 min**. The FDA-AP glossary's parenthetical states the SAL probability inverted; configuration text must not copy it.
- **Citations:** EU Annex 1: 8.1–8.5, 8.36 | US: 211.113(b), 211.111 (inferred); FDA-AP II.B, Glossary (terminal sterilisation, overkill).
- **FDA vs EU:** FDA-AP does not regulate terminal sterilisation of product, so EU governs (see the section below).
- **Verify:** Flag a terminal product as growth-supporting → a Grade D preparation room is rejected. Set container type "wide-neck" → filling demands Grade A in a Grade C background.

### ST-61: Terminal sterilisation loads (sub-batches), non-rigid containers, parametric release
- **Theme:** 11
- **Covers:** n498, n493, n575, n77
- **Scope:** terminal
- **Type:** ENFORCED. Parametric release is available only with an authorisation reference.
- **Behaviour:**
  - **Loads as sub-batches.** Each load is a sub-batch. Units are linked by load, tray and pallet to a validated load pattern and cycle (ST-43, ST-44). Routine probe positions are fixed master data correlated with the worst case from load mapping.
  - **Superheated-water or spray autoclaves.** A pre-cycle checklist confirms nozzles are not blocked and drains are free of debris; the cycle cannot start otherwise.
  - **Non-rigid containers** (BFS, FFS, bags). The cycle is designed to avoid distortion. A post-cycle deformation and leak inspection is recorded.
  - **Parametric release** is allowed only where authorised (MA/application reference on the product master). The release gate requires:
    - complete in-limit critical parameters at **every** specified monitoring position (time, temperature, pressure, F0);
    - chemical indicator results (FDA recommends Class 5);
    - per-batch filled-unit bioburden from worst-case positions before the cycle, with organism ID and a resistance assessment for any recovery, plus endotoxin where appropriate.

    Any failure makes parametric release impossible. Falling back to a sterility test is allowed only if the authorisation permits it. Without authorisation, the sterility test under 211.167(a) is required (ST-65).
- **Citations:** EU Annex 1: 8.54 (refers to Annex 17), 8.62, 8.64, 8.65, 10.4 | US: 211.167(a); FDA parametric-release submission guidance (Feb 2010) and CPG 490.200 (secondary sources, not in the uploaded texts).
- **FDA vs EU:** Both require prior authorisation. Detailed criteria come from EU Annex 17 and the FDA 2010 guidance, neither of which is in the inputs (see Open questions).
- **Verify:** One probe below the F0 minimum on a parametric-release batch → parametric release blocked. A cycle start without the nozzle/drain check → blocked.

---

## Theme 12: 100% visual inspection, AQL and container-closure integrity

### ST-62: 100% inspection (manual, semi-automated, automated)
- **Theme:** 12
- **Covers:** n477, n479, n480, n310, n79
- **Scope:** all
- **Type:** ENFORCED. Per-defect alert/action limits are CONFIGURABLE and derived from historical data.
- **Behaviour:**
  - **Mandatory step.** Every filled parenteral unit goes through a 100% inspection step. The step records:
    - mode, equipment/recipe and inspectors;
    - units presented, accepted and rejected **by defect code** from a controlled defect library. The library holds criticality (critical/major/minor), particle type (fibre, glass, metal) and integrity defects (cracks, missing or loose stoppers).
    - reconciliation: filled = accepted + rejected + samples + destroyed, within limits.
  - **Manual inspection:**
    - Sign-on requires VI qualification **≤12 months** old, tested with the inspector's usual corrective lenses on defect-library sets under worst-case conditions (inspection time, conveyor speed, container size, fatigue). An eyesight check must also be current.
    - The station records its illumination/background check.
    - The inspection rate is controlled.
    - The station enforces a break after a configurable maximum continuous time.
  - **Automated inspection (AVI).** Validated to detect at least as well as manual inspection. A challenge-set run is required at start-up and at defined intervals during the batch. A failed interim challenge puts every unit since the last passing challenge on hold for re-inspection.
  - **Reject rates.** A per-defect reject rate above its alert or action limit opens an investigation and blocks release.
- **Citations:** EU Annex 1: 8.30–8.32 | US: 211.192; FDA-AP VI.B.2; FDA draft guidance *Inspection of Injectable Products for Visible Particulates* (Dec 2021, draft; secondary).
- **FDA vs EU:** EU is stricter on inspector qualification (annual) and AVI challenges. The FDA draft adds a lifecycle programme with AQL; it is not final.
- **Verify:** An inspector with VI qualification 13 months old → sign-on refused. A failed mid-batch AVI challenge → units since the last pass held.

### ST-63: AQL of accepted units, critical defects, OOS investigations and defect trending
- **Theme:** 12
- **Covers:** n478, n481, n312
- **Scope:** all
- **Type:** ENFORCED. The AQL plan is CONFIGURABLE; see Open questions for values.
- **Behaviour:**
  - **AQL sampling.** Accepted units are sampled after inspection. The record holds sample size, acceptance and rejection numbers, and results by class.
  - **Critical defect in accepted units.** Any **critical** defect found in accepted units, whether in AQL or any later inspection, opens an investigation automatically, blocks release and prompts a re-inspection decision. Re-inspection is allowed only under SOP, with a deviation, and its counts are recorded separately.
  - **OOS results.** Any out-of-specification IPC or inspection result opens a 211.192 investigation, which includes other potentially affected batches. Release waits for closure.
  - **Trending.** Defect counts are stored per code per batch, so SPC trending works across batches. An adverse trend opens an investigation with a **mandatory market-impact assessment**.
- **Citations:** EU Annex 1: 8.30, 8.33 | US: 211.192 (binding); FDA-AP VI.B.2; FDA draft guidance (2021).
- **FDA vs EU:** Aligned. Neither final text fixes AQL values.
- **Verify:** One cracked vial in the AQL sample → automatic investigation and release block. Ten batches with rising glass rejects → trend rule fires.

### ST-64: Container-closure integrity
- **Theme:** 12
- **Covers:** n472, n589, n473, n474
- **Scope:** all
- **Type:** ENFORCED ("visual inspection is not a CCI method" is [EU hard])
- **Behaviour:**
  - **Fusion-sealed containers** (BFS, FFS, SVP/LVP bags, glass or plastic ampoules):
    - seal-critical parameters (for example heater temperature, dwell, pressure) are recorded and monitored;
    - **glass ampoules, BFS units and fusion-closed containers of ≤100 mL** get **100% CCI** by a validated method, recording units tested, passes and rejects by reason;
    - above 100 mL, reduced sampling needs a referenced scientific justification and process-consistency data.
  - **Visual inspection** is excluded from the CCI method list. A 100% VI record can never satisfy a CCI requirement.
  - **Non-fusion closures** (stoppered/crimped vials, syringes): CCI on samples by a validated method, under a sampling plan justified by container-closure knowledge, supplier management and component specifications. Any failure opens an investigation and blocks release.
  - **Vacuum-sealed containers.** A vacuum-retention test is scheduled after the predetermined waiting period. Certification is blocked until it passes. Retention during shelf life is covered by stability.
  - Integrity-defect units are removed at final inspection (ST-62).
- **Citations:** EU Annex 1: 8.22–8.25 | US: 211.192; FDA-AP VI.B.2.
- **FDA vs EU:** **EU is stricter:** 100% CCI for fusion-sealed containers ≤100 mL, and VI not accepted as CCI. FDA-AP only requires removal of defective units and safeguards against shipping units lacking integrity.
- **Verify:** Configure a 2 mL ampoule with sampled CCI → MBR rejected. Choose "visual inspection" as the CCI method → option unavailable.

---

## Theme 13: Sterility, endotoxin and particulate testing, and release

### ST-65: Sterility and endotoxin results required per batch; method suitability and test conditions
- **Theme:** 13
- **Covers:** n313, n354, n355
- **Scope:** all
- **Type:** ENFORCED
- **Behaviour:**
  - The release checklist requires approved LIMS results for **sterility and bacterial endotoxins (or pyrogens)**. The samples must trace to this batch and, where relevant, to the sub-batch or load. Results must be within specification. A result from another batch cannot be linked.
  - The only alternative is authorised parametric release (ST-61).
  - A sterility result is accepted only if it references a method-suitability (bacteriostasis/fungistasis) validation approved for this product and **formulation version**, current on the test date. A formulation change invalidates the link until it is re-verified.
  - Each sterility result must carry:
    - the test environment (isolator or cleanroom ID and status);
    - media lots with sterility and GPT status;
    - an analyst qualified on the test date;
    - incubation start and end.

    A missing or non-compliant element is flagged for QA.
  - Sample exterior decontamination (VHP/UV) must be a validated process that does not affect the test.
- **Citations:** EU Annex 1: 10.5 (test validated per product), 10.8, 10.9 | US: 211.167(a) (binding), 211.165(e), 211.194, 211.160(b), 211.22(b), 211.25(a); FDA-AP VII (text box), XI.A.
- **FDA vs EU:** Aligned. The US per-batch testing rule is binding.
- **Verify:** Release with sterility present and endotoxin pending → refused. A sterility result whose method suitability used the old formulation → refused.

### ST-66: Sterility sampling plan (start/middle/end, post-intervention, per load and sub-batch)
- **Theme:** 13
- **Covers:** n577, n356, n385
- **Scope:** all
- **Type:** ENFORCED. Risk rules for extra samples are CONFIGURABLE.
- **Behaviour:**
  - **Pull tasks** are generated automatically:
    - at the **start, middle and end** of the aseptic fill, by unit count or elapsed time; EU names start and end, FDA adds middle;
    - after **each recorded critical intervention or environmental excursion**, following the risk rule;
    - for heat-sterilised product in the final container: from the **coolest/slowest-heating positions of each load**. Each load is a sub-batch with its own sample set and test;
    - for lyophilised product: from **each lyophiliser load**.
  - Each sample keeps its origin (time, unit counter, tray or position, load) through to LIMS. The release check confirms every required pull was sampled and tested.
  - Sampling of sterile materials (sterile bulk, sterile API, post-filtration samples) records the sterile sampling device and its sterilisation record, the aseptic method or SOP, the location or class, and the sampler's qualification. A record missing any of these cannot be completed.
  - Design basis: a 20-unit test passes a lot with 0.1% contaminated units about 98% of the time (FDA-AP XI.B). That is why samples are tied to the riskiest moments.
- **Citations:** EU Annex 1: 10.6 | US: 211.84(c)(3), 211.160(b)(3), 211.165(a); FDA-AP XI.B.
- **FDA vs EU:** Use the union. EU adds per-load sub-batch sampling for terminal sterilisation and lyo, and risk-based post-intervention samples. FDA adds the middle-of-fill pull and pulls after excursions.
- **Verify:** A terminally sterilised batch in 3 autoclave loads → 3 cold-spot sample sets required. A corrective intervention at 40% fill → an extra sample task is generated.

### ST-67: Sterility-positive handling and investigation
- **Theme:** 13
- **Covers:** n357, n358, n359
- **Scope:** all
- **Type:** ENFORCED
- **Behaviour:**
  - **Status on a positive.** A positive sets the batch to "sterility failure: presumed non-sterile" and blocks release.
  - **Invalidation and retest.** Invalidation needs a QA-approved record with conclusive evidence that the contamination arose in the laboratory. A retest can be linked only after that approval. A QA conclusion of "inconclusive" allows only "reject". Original results are never replaced. Tests invalidated before incubation remain visible with their deviation reference.
  - **Investigation template.** Pre-filled from the eBMR with:
    - species ID of the isolate, compared with EM, PM and bioburden isolates using the same ID method;
    - lab records and lab EM trends;
    - short- and long-term production EM trends, and PM trends;
    - bioburden trend;
    - batch events: interventions, alarms, DP and particle excursions, utility events;
    - maintenance and construction work orders;
    - prior deviations and changes;
    - a HEPA retest task (ST-17).
  - **Associated batches** are proposed per 211.192: batches sharing the same line, fill window, sterilisation loads, bulk, component lots or personnel.
  - **Trending.** Sterility records carry product, container type, line, sterilisation mode (aseptic/terminal), sampler, analyst and environment. This enables the required trend views, including initial-positive rate for aseptic vs terminal.
  - A conclusion of "lab error" with no specific evidence attached is refused, whatever the laboratory's history.
- **Citations:** EU Annex 1: 3.2 | US: 211.192, 211.165(a), 211.167(a), 211.180(e); FDA-AP XI.C, XI.C.1–7.
- **FDA vs EU:** FDA-AP is more detailed. EU requires investigation before certification with batch-scope rationale (ST-71). Apply both.
- **Verify:** Post a positive, then link a passing retest without an approved invalidation → refused. Mark the outcome "inconclusive" → only "reject" is offered.

### ST-68: A passing sterility test never overrides a process failure
- **Theme:** 13 (also 14)
- **Covers:** n576, n591, n397
- **Scope:** all
- **Type:** ENFORCED ([EU hard]: 10.5, second sentence)
- **Behaviour:**
  - The sterility result is evaluated only after all process, procedural and validation-status checks have passed. A pass never closes or overrides an open nonconformance.
  - Certification with only a sterility result attached, while process, EM, utility or sterilisation review items are open, is blocked.
- **Citations:** EU Annex 1: 2.2, 2.7, 10.5 | US: 211.113(b), 211.192.
- **FDA vs EU:** Aligned. EU states it categorically.
- **Verify:** A passing sterility result with an open sterilisation-cycle deviation → status stays "not releasable".

### ST-69: Short shelf-life products and conditional release before final results
- **Theme:** 13
- **Covers:** n578, n380
- **Scope:** all (the cell-therapy module is optional and outside core scope)
- **Type:** CONFIGURABLE (off by default). ENFORCED escalation once enabled.
- **Behaviour:**
  - For a product flagged "short shelf life", certification may precede the sterility and/or EM results only when all of these hold:
    - a documented risk-mitigation reference exists (process design, extra monitoring, alternative or rapid methods);
    - the **most recent available** EM data are reviewed;
    - late results stay linked to the batch.

    An adverse late result triggers automatic escalation, including a recall assessment.
  - Optional cell-therapy module: release requires passing intermediate sterility, stain (for example Gram) and endotoxin results. The final sterility result is tracked afterwards, and a positive triggers escalation and notification.
- **Citations:** EU Annex 1: 10.7, 10.10 | US: 211.165(a), 211.167(a) (inferred); FDA-AP Appendix 3.B.
- **FDA vs EU:** Aligned in approach.
- **Verify:** Certify a short-shelf-life batch before its sterility result, then enter a positive → escalation linked to the distributed batch.

---

## Theme 14: Batch record review dossier and release gate

### ST-70: Sterile batch review dossier with signed sections and consolidated timeline
- **Theme:** 14
- **Covers:** n362, n75, n361, n586, n399
- **Scope:** all
- **Type:** ENFORCED (sections and signatures). The consolidated timeline is a DESIGN-CHOICE.
- **Behaviour:**
  - **Dossier sections.** Each section needs a reviewer signature, and QA release is blocked until every section is signed:
    - EM (viable and non-viable) for every room/zone and the whole window;
    - PM for the roster;
    - HVAC/HEPA status and DP;
    - WFI and clean-steam results for the period;
    - equipment/EMS alarm report (ST-06);
    - **all** filter integrity results (product, vent, gas);
    - sterilisation, depyrogenation and SIP cycles (ST-72);
    - interventions and stoppages;
    - time-limit compliance;
    - APS and personnel-qualification status on the fill date;
    - all IPC and lab results.
  - **Required results.** The MBR declares a required-results list. Each result is linked as an immutable reference (value, limit, status) and is visible *in the batch record*, not only in LIMS. A later source change shows the revision history and forces re-review.
  - **Timeline.** Interventions, particle and EM data, DP and alarms, holds, sterilisation and filter results, and personnel events appear on one exportable time axis. Reviewers judge the batch as a whole.
  - **QP/QA access.** QP/QA users reach every linked source from one screen. The certifier role requires a sterile-products training record.
- **Citations:** EU Annex 1: 2.4, 3.1(vii) | US: 211.188, 211.192 (binding); FDA-AP XII.
- **FDA vs EU:** Aligned. FDA-AP XII lists the essential release-review elements. (Row n75 was unverified; see Conflicts.)
- **Verify:** Leave the WFI section unsigned → release refused. Remove the link to the post-use filter test → completeness check fails.

### ST-71: Release gate: deviations and investigations with impact scope, yield, storage excursions
- **Theme:** 14
- **Covers:** n400, n360, n401, n398
- **Scope:** all
- **Type:** ENFORCED
- **Behaviour:**
  - **Conditions for the release e-signature:**
    - every section is complete and every review-by-exception item is dispositioned;
    - **every linked deviation and investigation is closed**, or formally assessed as not affecting this batch;
    - yield and reconciliation (bulk, fill count, inspection, labelling) are within MPCR limits or explained.
  - **Investigation closure requires:**
    - root-cause category and product-risk statement;
    - CAPA link and residual-risk acceptance rationale;
    - an impact-scope list of batches, with an inclusion/exclusion rationale for each, propagated to every listed batch;
    - a completed "other batches/products assessed" field.

    This applies **even if the batch has already been distributed**.
  - **Post-fill handling.** Storage and transport record location and conditions. An excursion from registered storage conditions is linked to the batch and blocks release until assessed.
- **Citations:** EU Annex 1: 3.1(iii), 3.1(iv), 3.1(vi), 3.2 | US: 211.192 (binding); FDA-AP XII (text box).
- **FDA vs EU:** Aligned. EU adds a documented inclusion/exclusion rationale for each batch.
- **Verify:** An open deviation plus a yield outside limits → release refused, listing both. Close an investigation with the "other batches" field empty → refused.

### ST-72: Sterilisation-cycle roll-up at release
- **Theme:** 14 (fed by 7)
- **Covers:** n488
- **Scope:** all
- **Type:** ENFORCED
- **Behaviour:**
  - Every item consumed resolves to a unique cycle ID. This covers product, components, equipment, and garments where relevant.
  - QA/QP review lists every contributing cycle with its conformity status.
  - Certification is blocked while any cycle record is unreviewed or non-conforming.
- **Citations:** EU Annex 1: 8.45 | US: 211.188(b), 211.192.
- **FDA vs EU:** Aligned.
- **Verify:** Consume stoppers from an unreviewed cycle → certification blocked, with the cycle listed as open.

### ST-73: Structured execution data for PQR/APR, CCS review and management review
- **Theme:** 14
- **Covers:** n585, n387
- **Scope:** all
- **Type:** DESIGN-CHOICE for the data model. The annual review itself is a binding US requirement.
- **Behaviour:**
  - The following are stored as structured, queryable data: interventions (type, count, duration), achieved hold times, defects by code, EM/PM excursions, filter test values, cycle results, time-limit exceedances, APS results, sterility and endotoxin results, and deviations.
  - Cross-batch exports and dashboards are available per product and line, so the review of at least annual frequency, the PQR, CCS effectiveness review and management review need no re-keying.
- **Citations:** EU Annex 1: 2.3, 3.1(v), 6.4, 8.33, 9.11 | US: 211.180(e); FDA-AP XI (text box).
- **FDA vs EU:** Aligned.
- **Verify:** A 12-month extract of interventions per line matches the source batch records.

---

## Theme 15: Technology profiles (isolator, RABS, BFS, FFS, closed/SUS)

### ST-74: Barrier-technology profile, background grade, isolator pressure and transfers
- **Theme:** 15
- **Covers:** n403, n414, n413, n368
- **Scope:** isolator, rabs (and conventional lines)
- **Type:** ENFORCED (background floors, pressure monitoring). Pressure limits are CONFIGURABLE per qualification.
- **Behaviour:**
  - **Line profile.** Line master data records the technology: isolator (open/closed), RABS (open/closed), conventional cleanroom, BFS, FFS or closed/SUS. The profile selects the mandatory building blocks: glove tests, bio-decontamination, door-opening log. A **conventional (open) aseptic line** needs a CCS justification reference before release for use.
  - **Background grades:**
    - open isolator: **≥ Grade C** generally;
    - closed isolator: **≥ Grade D**, decided by CCS risk assessment;
    - RABS for aseptic processing: **≥ Grade B**, with airflow studies covering interventions and door openings;
    - FDA: isolator background is set by interface design, commonly ISO 8, and **never unclassified**.

    Batch start verifies the background room's classification is current.
  - **Isolator pressure.** Overpressure against the room is linked continuously for the batch window against qualified limits (FDA typical range **17.5–50 Pa**). Exit-port (mousehole) overpressure is continuously monitored. An excursion becomes an integrity-breach event (ST-76).
  - **Transfers** into a running isolator or RABS are logged: technology (RTP alpha/beta, mousehole, transfer isolator), port ID, beta-container sterilisation reference and time. Weaker ports need local HEPA UDAF cover status.
  - A negative-pressure isolator is allowed only as a flagged containment configuration.
  - RABS door openings are batch events that need assessment.
- **Citations:** EU Annex 1: 4.3, 4.18–4.20 | US: 211.42(c)(10)(iii)-(iv) (inferred); FDA-AP Appendix 1.B.3-4, 1.C.
- **FDA vs EU:** For open isolators EU is stricter (Grade C, which is ISO 7 at rest) than FDA's "commonly ISO 8". The 17.5–50 Pa figure is FDA's.
- **Verify:** Assign a RABS line to a Grade C room → rejected. Replay exit-port overpressure at 0 Pa for 20 s → integrity-breach event.

### ST-75: Glove, sleeve and enclosure integrity (isolator and RABS)
- **Theme:** 15
- **Covers:** n415, n416, n417, n418, n367, n373
- **Scope:** isolator, rabs
- **Type:** ENFORCED. Replacement frequency and campaign test intervals are CONFIGURABLE, with a floor of a glove test at the start and end of each batch or campaign.
- **Behaviour:**
  - **Register per port.** Glove, sleeve or half-suit ID, install date, replacement due date (CCS-defined) and last integrity result. Batch start is blocked if any port on the line is overdue or failed.
  - **Isolators:**
    - glove integrity test by a suitable method **at least at the start and end of each batch or campaign**, with more tests if the campaign is long; for small manual batches, at session start and end;
    - a visual check at each use and after any manipulation that could affect integrity;
    - an **enclosure leak test** at defined intervals; overdue blocks batch start.
  - **RABS:**
    - gloves are sterilised before fitting, and sterilised or bio-decontaminated by a validated method before **each campaign**;
    - after each exposure to the background during operation, a disinfection entry is required before the next aseptic step;
    - a visual check at each use, and periodic integrity-test status checked at line start.
  - **Failed test after use.** The failure links every batch and time window since that glove last passed, for impact assessment. Under FDA-AP, units filled in the suspect window default to rejection unless QA documents that the environment was not compromised.
  - **Glove-port manipulations** are logged as interventions (type, port, duration, operator), with tools linked to sterilisation records. Fingertip PM covers each port used.
- **Citations:** EU Annex 1: 4.21 | US: 211.113(b); FDA-AP Appendix 1.A, 1.G.
- **FDA vs EU:** EU is stricter on frequency: a minimum of start and end of each batch/campaign, where FDA says "routine". FDA adds daily attention and inner-glove precautions.
- **Verify:** Enter a failed end-of-batch test on port 3 → deviation plus impact window since the last pass. Log a RABS door opening with glove exposure and no disinfection → next aseptic step blocked.

### ST-76: Barrier cleaning, bio-decontamination, validity interval and integrity breach
- **Theme:** 15
- **Covers:** n588, n419, n369, n370, n420, n372
- **Scope:** isolator, rabs
- **Type:** ENFORCED ("cleaning before bio-decontamination" is [EU hard])
- **Behaviour:**
  - **Sequence rule.** A bio-decontamination cycle is valid for the batch only if a completed cleaning record for the same enclosure precedes it, with no use in between.
  - **Isolator bio-decontamination.** Automated, validated, using a sporicidal agent in vapour or gas form. The record holds:
    - pre-clean confirmation;
    - **gloves extended with fingers separated**;
    - recipe ID and version, and agent lot;
    - key parameters against validated ranges (agent amount or concentration, phase durations);
    - end-of-aeration residual below its limit;
    - chemical indicator results;
    - pass/fail.

    Validation reference: quantified BIs at many locations, normally a **4–6 log** reduction (FDA-AP). The aseptic phase cannot open until the cycle has passed.
  - **Validity.** Status reads "decontaminated, valid until" (validated interval; hold per ST-37 item 3). Aseptic steps after that time are blocked. Deteriorating EM trends prompt a review of the interval.
  - **Integrity breach.** Overpressure loss, a glove or seam hole, or a power or valve failure sets the status to "decontamination required" and creates a deviation linked to the batch, with the unit-disposition default as in ST-75.
  - **Isolator EM.** EM media cannot be introduced until aeration is recorded complete. Per shift: fingertip samples for each port used, air, surfaces (with wipe-down confirmation after contact plates) and exit-port particle monitoring.
  - **RABS.** Routine sporicidal disinfection of every interior surface (agent, lot, expiry, SOP version, operator) at the defined frequency. Overdue blocks line start.
- **Citations:** EU Annex 1: 4.22 | US: 211.113(b) (inferred); FDA-AP Appendix 1.D.1–3, 1.F.
- **FDA vs EU:** Complementary. EU makes cleaning first essential and requires a sporicide in vapour form. FDA gives the log-reduction expectations and the reject-by-default for compromised units.
- **Verify:** A VHP cycle with no prior cleaning record → invalid for batch use. Settle-plate exposure logged before aeration end → blocked.

### ST-77: Blow-fill-seal (BFS)
- **Theme:** 15
- **Covers:** n521, n522, n523, n524, n525, n526, n374, n375, n376, n377
- **Scope:** bfs
- **Type:** ENFORCED
- **Behaviour:**
  - **Environment:**
    - line records shuttle vs rotary machine type;
    - terminal BFS: machine in **≥ Grade D**, with point-of-fill conditions per ST-60;
    - aseptic shuttle: **Grade A** at the parison extrusion, blow-moulding and sealing critical zones, plus a Grade A filling environment;
    - aseptic rotary: **Grade A inside the parison**;
    - machine background **≥ Grade C**, with operators in **Grade A/B garments**, so a Grade C gowning record is refused;
    - FDA: the surrounding room generally ISO 8 or better, and the critical zone meets ISO 5 microbial (normally also particle) levels.
  - **EM.** In-operation particle monitoring of the critical zone is not expected; a design-data reference is required instead. Viable monitoring must cover from equipment assembly to the end of filling, with samples spread across the run. Gaps are flagged.
  - **Checks at start:**
    - PM is current, and machine-utility integrity (for example mould-cooling leak check) is current;
    - seal-critical tooling has been inspected;
    - a mould change or modification is blocked until its CCI assessment is closed;
    - the polymer lot is released (bioburden/endotoxin where specified) and its supplier is qualified;
    - parison/support air filter IDs and integrity are current;
    - the product-path SIP (and mandrel CIP/SIP) is within the validated recipe.
  - **CPPs, imported continuously with limits:** extrusion temperature, speed and throat settings (parison thickness), melt temperature and residence time, mould temperatures and cooling rate. An excursion segregates units made in that window and raises a deviation.
  - **IPCs.** Wall thickness, container weight, fill weight/volume, leak checks and process air pressure. **100% CCI** is run with a known-defect challenge verification. Rejects by reason flow into reconciliation. A significant forming or sealing defect creates a deviation with a 211.192 investigation.
  - **Interventions.**
    - Entries flagged "stops extrusion/filling" or "requires re-sterilisation" force a passing SIP before resumption.
    - Set-up and troubleshooting are logged as interventions, with media-fill coverage checked.
  - **Added components** (for example LVP caps), aseptic case: pre-sterilised and added in Grade A, with validated sealing tests.
  - **Campaign.** A campaign-duration timer runs.
- **Citations:** EU Annex 1: 8.22, 8.105–8.120 | US: 211.100, 211.113(b), 211.192; FDA-AP Appendix 2 (intro), 2.A–2.C.
- **FDA vs EU:** EU is more prescriptive on zones, the Grade A/B garment rule and 100% CCI. FDA-AP adds extrusion endotoxin/spore challenge validation and polymer supplier control.
- **Verify:** A 10-min mould-temperature excursion → units from that window segregated. A modified mould without closed CCI assessment → batch start blocked.

### ST-78: Form-fill-seal (FFS)
- **Theme:** 15
- **Covers:** n517, n518, n519, n520
- **Scope:** ffs
- **Type:** ENFORCED
- **Behaviour:**
  - **Environment** follows the product's route: terminal (ST-60 grades) or aseptic (Grade A/B).
  - **Film.** Each roll is scanned against its specification: thickness, strength, microbial and particulate contamination, integrity and artwork. Film bioburden/endotoxin applies where the CCS defines it. A roll with a pending result is blocked.
  - **CPPs recorded against validated ranges:**
    - package dimensions and cutting;
    - forming temperatures (including pre-heat and cooling), forming times and pressures;
    - sealing temperature and its uniformity, sealing time and pressure;
    - environmental and product temperature;
    - fill volume, speed and uniformity;
    - print and emboss settings.

    **Batch-specific seal strength and uniformity tests are mandatory** before the batch can close. CCI is 100% for fusion-sealed containers ≤100 mL (ST-64).
  - **Gases.** Product-contact gases (inflation, overlay) are filtered close to the point of use and periodically verified.
  - **Machine records.** CIP/SIP records, film decontamination/sterilisation and the campaign-duration limit are held. Machine set-point changes and alarms enter the batch audit trail, and an out-of-range change needs justification.
  - **Rejects** by reason (forming, sealing, cutting) go into reconciliation. Sealing issues above a threshold open an investigation. Tooling inspection status is checked at start.
- **Citations:** EU Annex 1: 8.22, 8.96–8.104 | US: 211.100, 211.192 (general). FDA-AP has no FFS content.
- **FDA vs EU:** Only EU has FFS-specific requirements.
- **Verify:** Omit the batch seal-strength test → batch cannot close. Change a sealing set point outside range on the HMI → recorded with user and time and justification required.

### ST-79: Closed systems and single-use systems (SUS)
- **Theme:** 15
- **Covers:** n533, n590, n534, n535, n536, n537, n538
- **Scope:** sus
- **Type:** ENFORCED ("sterility of product-contact surfaces is critical" is [EU hard])
- **Behaviour:**
  - **Assemblies.** Closed-system assemblies are configured items (bags, tubing, connectors, sensors, filters), each with lot and sterilisation evidence. **Every** product-contact element of an aseptic closed system must resolve to a sterilisation record or supplier sterility proof, with no "N/A". Connections to the sterile path after the final filter use intrinsic sterile connectors by design. A pre-use system integrity test (for example pressure decay) is required when the CCS says so.
  - **Background.** An aseptic closed system whose integrity could be compromised sits in Grade A. A lower grade needs an integrity result recorded **at every use**. A "system opened" event forces either opening in Grade A (aseptic) or Grade C (terminal), or the extra cleaning, disinfection and, for aseptic use, sterilisation steps.
  - **SUS goods receipt.** Per lot or unit: sterilisation evidence (irradiation certificate, dose, indicator status) and approved-supplier status. Unverified lots stay in quarantine.
  - **SUS pre-use, per piece:**
    - part number against the approved specification or BOM revision;
    - outer packaging and pouch condition, and label check;
    - CoC and sterilisation proof present;
    - structured visual inspection at unpacking and after installation (damage, holes, kinks, clamp positions), plus the packaging-opening method.

    Each check is documented. Integrated filters follow ST-52.
  - **Product compatibility.** Extractables/leachables and adsorption assessment status is held per product × part number; an unassessed part is blocked. A validated maximum contact time is enforced. Freeze/thaw use requires a SUS qualified for that condition.
  - Operators for SUS assembly and connections need APS coverage of that manipulation (ST-08).
- **Citations:** EU Annex 1: 8.127–8.138 | US: 211.113(b) (general). FDA-AP does not address SUS or closed systems.
- **FDA vs EU:** Only EU has specific requirements.
- **Verify:** A closed assembly with one connector lacking sterility evidence → cannot be released for use. A bag part number that differs from the approved BOM revision → refused.

---

## What the FDA aseptic guidance (2004) does NOT cover, and where those rules come from

| Topic | FDA-AP position | Source used instead | Controls |
|---|---|---|---|
| **Terminal sterilisation of the drug product** | Out of scope. II.B/III: only aseptic processing and sterilisation of components, containers, closures and equipment are covered; aseptic processing is to be used only when terminal sterilisation is not feasible (row n381). | US binding: 211.113(b) (validated sterilisation), 211.111 (time limits), 211.167(a) (per-batch sterility test), 211.192. EU Annex 1: 8.1–8.5 (preparation and filling grades), 8.34–8.65 (sterilisation, including non-rigid containers and superheated-water loads), 10.3–10.4 (bioburden), 10.6 (per-load sampling). FDA-AP IX.C steriliser principles reused by analogy. Parametric release: EU 8.54 → Annex 17, and FDA's Feb 2010 parametric-release submission guidance + CPG 490.200 (rows n77, n493). **Neither of those two is in the uploaded texts.** | ST-43, ST-44, ST-54, ST-60, ST-61, ST-66 |
| **Lyophilisation cycle records** (shelf/condenser temperature, chamber pressure, phase times), lyophiliser sterilisation frequency, leak rate | Only ISO 5 protection for transfer and loading (IV.E), sterile filters on vacuum breaks (IV.D.1) and lyo simulation in media fills (IX.A). No cycle-record content. | EU Annex 1 8.121–8.126, including the 8.123 lyophiliser-sterilisation rule in force from 25 Aug 2024. FDA *Guide to Inspections of Lyophilization of Parenterals* (1993) for cycle records (row n78, **not in the uploaded texts; unverified**). US anchors: 211.113(b), 211.68, 211.111, 211.188(b). 211.137(c) (expiry of reconstituted products) is a labelling item, not a batch-execution control. | ST-58, ST-59 |
| **RABS** | Not mentioned. | EU Annex 1 4.3, 4.18–4.22 | ST-74, ST-75, ST-76 |
| **Form-fill-seal** | Not mentioned. Appendix 2 covers BFS only. | EU Annex 1 8.96–8.104, 8.22 | ST-78 |
| **Single-use / closed systems** | Not mentioned. | EU Annex 1 8.127–8.139 | ST-79 |
| **100% visual inspection detail, inspector qualification, AQL** | VI.B.2 says only that defective units are removed at inspection. | EU Annex 1 8.30–8.33. FDA draft guidance on visible particulates (Dec 2021, **draft**, row n79; AQL figures from secondary sources). | ST-62, ST-63 |
| **Container-closure integrity numbers** (100% for fusion-sealed ≤100 mL; visual inspection not acceptable) | General statement in VI.B.2. | EU Annex 1 8.22–8.25 | ST-64 |
| **WFI and pure-steam system detail** | WFI and steam-generator output named only as release-review elements (XII). | EU Annex 1 6.7–6.17 | ST-26, ST-27 |
| **5 µm particle limits; Grade B/C/D viable limits for contact plates and gloves; 28 L/min; 4 h plates** | Only ≥0.5 µm ISO classes and air/settle action levels (Table 1). | EU Annex 1 Tables 1, 2, 5 and 6; 9.17; Table 6 note (a) | ST-18, ST-19, ST-20 |
| **Contamination Control Strategy** | No equivalent concept. | EU Annex 1 2.3–2.6 | ST-02, ST-03 |
| **Per-grade garment specification, maximum gown wear time, laundry cycles** | General gowning expectations (V.A). | EU Annex 1 7.10–7.17 | ST-11 |
| **Combination-product device controls** (PFS, autoinjectors) | Not covered. | 21 CFR Part 4 (row n86; post-QMSR cross-references **unverified**) | ST-56 |

---

## Conflicts between rows and how they were resolved (with evidence)

1. **APS frequency: per shift or per line.**
   - Row n73 (secondary) says FDA requires semi-annual requalification "per line and shift".
   - The primary FDA-AP IX.A.2 text (row n320) says semi-annual qualification **per processing line**, with each shift's activities and changeover *incorporated into the programme*.
   - EU 9.38 (row n564) says twice a year for **each process, each line and each shift**.
   - *Resolution:* EU governs (stricter). n73 is corrected in ST-29.
2. **APS acceptance.**
   - Row n570 (EU 9.46): any contaminated unit fails the APS.
   - Rows n326 and n73 (FDA-AP IX.A.9): tiered by run size. Verified text: under 5,000 units, one positive → revalidation after investigation. 5,000–10,000: one → investigation including a possible repeat; two → revalidation. Over 10,000: one → investigation; two → revalidation.
   - *Resolution:* the rule is chosen per line. The EU rule is mandatory when any EU/PIC/S product is qualified on the line (ST-33).
3. **FDA Table 1 values (row n74, "from recollection, not re-verified").**
   - Checked against the primary FDA-AP Table 1 (row n274): ISO 5 3,520 / 1 / 1; ISO 6 35,200 / 7 / 3; ISO 7 352,000 / 10 / 5; ISO 8 3,520,000 / 100 / 50. All match. Settle plates are optional (note d). ISO 5 samples should normally give no growth (note e).
   - *Resolution:* no conflict. n274 is the citation of record.
4. **FDA-AP XII content (row n75, unverified).**
   - The primary XII text names as essential release-review elements: EM and PM data; support-system output (HEPA/HVAC, WFI, steam generator); equipment functioning (batch alarm report, filter integrity); and documentation of interventions and stoppages (row n362). It does **not** list sterilisation/depyrogenation records or time-limit adherence *in XII*.
   - *Resolution:* ST-70 keeps those dossier sections but bases them on 211.188/211.192, FDA-AP VIII and IX.C, and EU 8.45.
5. **Filter integrity timing (row n76, unverified).**
   - Confirmed by FDA-AP IX.B: a pre-use test *can* be performed, and post-use testing *should routinely* be performed.
   - EU 8.87 (row n511) expects PUPSIT.
   - *Resolution:* EU PUPSIT with a risk-assessed waiver path (ST-52).
6. **Time limits (row n72, secondary).**
   - Confirmed against the FDA-AP VIII text box, which restates 211.111.
   - *Resolution:* merged with EU 8.18 into the union list in ST-37.
7. **Tunnel HEPA test frequency.**
   - Row n500 notes that EU 8.67 says "at least biannually", which is ambiguous (twice a year, or every two years).
   - FDA-AP IV.D.2 (row n284) says twice a year for the aseptic room and names tunnel and oven filters.
   - *Resolution:* default and maximum 6 months (ST-47, ST-17).
8. **Pressure differentials.**
   - Row n410: EU minimum 10 Pa, a *guidance value*.
   - Row n280: FDA at least 10–15 Pa between classes, and at least 12.5 Pa from an aseptic room to an unclassified room at all times.
   - *Resolution:* floor 10 Pa between graded rooms, 12.5 Pa to unclassified rooms (ST-17). Whether to ship a 12.5/15 Pa default is an open question.
9. **Gowning requalification interval.**
   - Row n447 (EU): at least annually for all Grade A/B staff.
   - Row n292 (FDA): annual is normally enough *for automated, low-intervention* operations, with more frequent requalification after adverse findings.
   - *Resolution:* ≤12 months for everyone, shortened for manual processes (ST-08).
10. **Isolate identification level.**
    - Row n558 (EU 9.31): species level for Grade A/B.
    - Row n350 (FDA-AP X.B): species, *or genus where appropriate*.
    - *Resolution:* species for A/B (ST-21).
11. **Glove sampling frequency.**
    - Row n297 (FDA V.C): daily or with each lot.
    - Row n554 (EU 9.25): at every Grade B exit and after critical interventions, followed by an outer-glove change.
    - *Resolution:* union (ST-22).
12. **Filter reuse.**
    - Row n334 (FDA IX.B): reuse possible if validation states the maximum number of lots.
    - Row n516 (EU 8.94): one batch, and no more than one working day of continuous use unless validated.
    - *Resolution:* EU cap by default. Multi-lot reuse only on US-only lines with validation (ST-53).
13. **Filter pore size.** Not a real conflict.
    - Row n507: ≤0.22 µm nominal.
    - Row n333: FDA 0.2 µm; FDA-AP footnote treats 0.2 and 0.22 as interchangeable.
    - Row n29 (211.72): the 0.2 µm (0.45 µm if manufacturing conditions require) figure applies to the non-fibre-releasing filter that must follow a fibre-releasing one.
    - *Resolution:* a 0.45 µm filter is never accepted as the sterilising filter (ST-50).
14. **Media-fill incubation.**
    - Row n569 (EU 9.44): conditions justified and validated; **no numbers**.
    - Row n327 (FDA IX.A.8): 20–35 °C, ±2.5 °C, ≥14 days, ≥7 days per temperature with the lower first.
    - *Resolution:* FDA numbers enforced as defaults (ST-32). The catalog does not attribute them to Annex 1.
15. **Isolator background.**
    - Row n414 (EU 4.20): open isolator ≥ Grade C, closed ≥ Grade D.
    - Row n368 (FDA App. 1.C): commonly ISO 8, never unclassified.
    - *Resolution:* EU floors (ST-74).
16. **Viable limits: ISO 8 vs Grade D.**
    - Row n274: FDA ISO 8 = 100 CFU/m³ and 50 per 4 h.
    - Row n544 (EU Table 6): Grade D = 200 and 100.
    - *Resolution:* for US-market products the FDA values apply to rooms that FDA would class ISO 8 (ST-20).
17. **Sterility sample points.**
    - Row n577 (EU 10.6): start and end, plus after critical interventions, per load/sub-batch and per lyo load.
    - Row n356 (FDA XI.B): start, middle and end, plus after interventions or excursions.
    - *Resolution:* union (ST-66).
18. **SAL wording.** Row n382 records that the FDA-AP glossary parenthetical states the SAL probability inverted. *Resolution:* configure SAL as ≤10⁻⁶ probability of a non-sterile unit (ST-60, ST-43).
19. **Scope of 211.42(c)(10) (row n5, "confirmed").** The regulation requires the facility *systems* to exist. It does not itself require a batch EM plan or a "released for aseptic operation" gate. *Resolution:* those gates cite FDA-AP and 211.192, not 211.42 alone (ST-14, ST-18, ST-24).
20. **Row n29 ("corrected").** 211.94(c)-(d) apply to every dosage form. *Resolution:* only the sterilisation/depyrogenation parts are used in this catalog (ST-41). Filter-integrity rules are *not* based on 211.72 (ST-50, ST-52).
21. **Grade A ≥5 µm limit.** Not a row conflict, but easy to get wrong.
    - Classification Table 1: "not specified".
    - Monitoring Table 5: 29/m³.
    - *Resolution:* ST-19 applies 29/m³ to monitoring only.

---

## "Not an eBMR concern"

| Row | Reason |
|---|---|
| n584 | Facility and equipment *design* expectations: impervious surfaces, no recesses, sealed ceilings, no sinks or drains in Grade A/B, trapped drains, windows and cameras, P&IDs, utility installation records, no exposed pipework (EU 4.5–4.9, 4.17, 5.1, 6.5, 6.6). These are verified by facility qualification, not batch execution. The eBMR only reads the resulting qualification status (ST-14). |

Facility-only fragments inside otherwise covered rows are also *not* re-checked per batch:
- conveyor partition rule (n434, EU 5.8);
- counter tubing ≤1 m and bends (n434, EU 5.9), which is a qualification item;
- crimper extraction station (n475, EU 8.26);
- hydraulic/heating equipment located outside the filling room (n444, EU 6.21);
- BFS airflow and zone design (n375).

---

## Open questions

1. **APS "approximately every six months".** Should any tolerance be allowed (for example +30 days with a documented QA decision)? The shipped default is none: last success + 6 months.
2. **DP default between graded rooms.** Keep the 10 Pa floor, or ship 12.5 Pa / 15 Pa for customers exporting to the US?
3. **Glove sanitisation before sampling.** The minimum interval (design default 5 min) needs each customer's SOP value.
4. **AQL values for visible particles** (0.65 appears only in secondary sources). USP <790>/<1790> were not verified in this pass, and the FDA 2021 guidance is still draft. Customer QA must set the plan.
5. **Parametric release.** EU Annex 17 and FDA's 2010 guidance and CPG 490.200 are not in the inputs. Verify before building the ST-61 parametric path.
6. **Lyo cycle-record requirements.** The FDA 1993 lyo guide is not in the inputs (row n78). Verify the parameter list for ST-59.
7. **21 CFR Part 4** post-QMSR cross-references for combination products (row n86) are unverified.
8. **"Extended period" of inactivity** that triggers APS revalidation (EU 9.49; FDA "extended shutdowns"): no number exists in either text. Site parameter needed.
9. **Glove/sleeve replacement frequency, maximum gown wear time, maximum laundry cycles, clean-up period, disinfectant rotation.** All come from site qualification. The catalog ships no numbers, and deliberately so.
10. **FDA APS tiers on US-only lines.** Should they be offered at all? Most Indian exporters serve both markets, so an EU-only rule set would be simpler and safer.
11. **Integration boundary.** Water, steam, EMS/BMS, LIMS and LMS data are *read* by the eBMR. Confirm which module owns sampling schedules, such as the daily WFI sample and EM programme versions.
12. **Reconciliation with the India catalog.** Where Revised Schedule M differs (for example grade tables or APS frequency), confirm that the stricter value is loaded into the ST-01 floor table.
13. **Rows marked secondary/unverified** (n72, n73, n74, n75, n76, n77, n78, n79, n86). n72–n76 were checked here against the FDA-AP text. n77, n78, n79 and n86 remain outside the uploaded texts.

---

## Controls most likely to be implemented wrongly

1. **ST-33 APS failure consequences.** The EU rule (any positive fails the APS; quarantine of everything made after the failure; review back to the last successful APS; normally ≥3 repeats) must win on any line that makes EU product. The FDA tiers apply only to US-only lines.
2. **ST-29/ST-30 APS frequency granularity.** EU requires twice a year per *process × line × shift*; FDA is per line. Operators need a successful APS every 12 months. Manual aseptic work needs 3 initial runs, then one about every 6 months *per operator per configuration*.
3. **ST-19/ST-20 EM limits.** Grade A ≥5 µm = 29/m³ for *monitoring* but "not specified" for *classification*. Continuous Grade A monitoring at ≥28 L/min. Grade A viable = no growth, with no alert tier. FDA ISO 8 (100/50) is stricter than EU Grade D (200/100). Settle plates ≤4 h (ST-18).
4. **ST-52 filter integrity.** PUPSIT is expected (EU), with only a documented risk-assessed waiver. Post-use testing happens before removal from the housing. In a redundant train only the primary is tested post-use if it passes. A serially validated train needs *all* filters to pass.
5. **ST-64 CCI.** 100% CCI for glass ampoules, BFS and fusion-sealed containers ≤100 mL. Visual inspection is never a CCI method. Vacuum-retention test before certification.
6. **ST-32 APS incubation and unit accountability.** The 20–35 °C / ±2.5 °C / ≥14 d / ≥7 d per temperature (lower first) rule is **FDA's**; Annex 1 only requires justified, validated conditions. All integral units are incubated, including cosmetic rejects. Removal is capped at the catalogue number and never exceeds production [EU hard].

Runners-up: ST-21 (action-excursion batch linkage from sampling to reporting), ST-58 (sterilise before every load on a manually loaded lyophiliser from 25 Aug 2024), ST-17 (12.5 Pa toward unclassified rooms), ST-14 (6/12-month requalification caps).
