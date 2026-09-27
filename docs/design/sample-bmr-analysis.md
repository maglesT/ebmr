# User-supplied example BMR — structural analysis (TABLETS edition coverage test, NOT a template to copy)

Source: user upload, 16-page paper BMR (Pharmaguideline sample, Atorvastatin 40 mg film-coated tablets, wet granulation, 2,00,000 tabs).
User instruction: "this is not reference, this is just example". The product itself is irrelevant. Latest user direction: TWO separate products —
a Tablets edition customisable within tablet manufacturing, and an Injectables edition customisable within injectable manufacturing (NOT one general system).
Use: every element below must be expressible with the Tablets edition's configurable building blocks (without product-specific code). Items marked [GAP-RISK] are
things a naive design would miss.

## Document-level
- Controlled-document header repeated on every page: BMR no., BMR revision/date, reference MFR (master formula) no. + revision/date,
  product, batch size (units), batch no., batch quantity (kg), composition/label claim, mfg date, exp date, issued by/received by + dates,
  supersedes, reason for change, manufacturing licence no., material code, shelf life rule ("36 months or API expiry, whichever is less") [GAP-RISK: expiry = min(rule-based date, API lot expiry)],
  storage condition, marketed by, serial no.
- MBR approval block: prepared (QA) / checked (Production) / reviewed (Production head) / approved (QA & QC head) -> configurable approval route with roles.
- History of change table (revision, supersedes, reason) -> MBR version history.
- Abbreviations -> glossary (nice-to-have).

## Batch summary (auto-generated in eBMR)
- Per stage (Granulation / Compression / Coating): commencement & completion dates, area used, previous product + its batch no., checked by.
- Statement "batch has / has not been completed according to MFR", "deviation sheet attached Y/N", actual yield, rework generated, total yield %.
  -> in eBMR these are COMPUTED from execution data, never typed.

## Building blocks evidenced by the example
1. Instruction / safety precautions acknowledgement (general notes, PPE, SOP references) — must support SOP reference links.
2. Equipment cleaning-status verification table: equipment, capacity, equipment ID, previous product & batch, cleaned on, checked by, re-checked by
   -> equipment-status check block pulling from equipment logbook; dual verification.
3. Bill of materials + weighing/dispensing: ingredient, qty per unit, qty for batch, QC release ref (A.R. no.) + date, balance no., gross/tare/net,
   weighed by / checked by; material must be QC-approved and within retest date.
   Potency adjustment formula (salt-to-base with molecular-weight ratio and assay "as is"): qty = LC × (100/assay) × (batch size/10^6) × (MW salt/MW base)
   -> calculation engine with verified calculation ("calculation checked by Production and QA") [GAP-RISK: compensating excipient qty to keep compression weight constant].
   Requisition / issue workflow (requested by, stores supervisor, issued on).
4. Separate BOM sections per stage (granulation BOM, coating BOM).
5. Area / line clearance: previous product & batch, checklist items (previous labels, product, containers removed; area clean; machine set;
   QA approval to start stage; temperature & RH recorded), checked by Production, re-checked by QA, satisfactory / not satisfactory -> gating block.
6. Process step with SOP reference, date-time FROM/TO, done by, checked by.
7. Parameter entry with target ranges (dampers 80–100 %, inlet temp 50–55 °C, outlet 30–35 °C, pan RPM 1–5, air pressure 2–4 kg/cm², pump 15–35 RPM).
8. Timed operations ("mix 10 min slow speed", "add solution within 4 min") -> timer/duration capture with limits.
9. Optional/conditional entries ("if necessary add extra IPA, record weight") -> conditional data entry.
10. Loop until endpoint ("dry until LOD 2.0–3.5 %; redry if required and repeat stage 6.0") [GAP-RISK: loops/repeat with every iteration recorded].
11. Sieve / screen integrity check before AND after use.
12. Rework / reprocessing addition: source batch no., mfg/exp dates, quantity; limit ≤ 3 % of batch; rework must be ≤ 3 months old; rework added increases
    theoretical yield. [GAP-RISK: constraint checks across batches; regulatory — FDA 211.115 requires approved reprocessing procedures + QC unit review.]
13. Container-wise output weighing (gross/tare/net per container, totals, balance ID).
14. Stage yield with standard and permissible range (e.g. std 99.5 %, permissible 99.0–100.0 %); theoretical = standard + rework added.
15. Machine set-up record: machine used, operator, punches & dies description, cleanliness of punches, balance check, lubricant level, time started.
16. In-process controls on a double-sided press: LEFT and RIGHT channels for each test [GAP-RISK: multi-channel IPC].
    Tests: weight of 20 tablets (±2 %), hardness (NLT 6 kg/cm²), thickness (3.4 ± 0.2 mm), disintegration (NMT 15 min), friability (NMT 1 %), machine speed, temp, RH.
17. Initial checks at start: 35 individual readings L and R (appearance, individual weight, thickness).
18. Periodic IPC schedule: weight of 20 tabs every 15 min; hardness & thickness (3 tabs) every 30 min; DT (6 tabs), weight variation, friability every 2 h
    -> scheduled/recurring IPC with reminders and overdue flags [GAP-RISK].
19. Weight variation: 20 individual weights, average, max/min allowed vs actual, limit ±7.5 % of average -> multi-reading statistics + acceptance rule engine.
20. Friability: weight before, after 100 rotations, % loss (calculated).
21. Unit count from weight: no. of tablets = net weight / average weight.
22. Inspection & rejection: reusable residue vs rejects for destruction (weights + counts), inspection time from/to, inspected by.
23. Destruction record with witness (Production + QA).
24. QC sampling request ("intimate QA to draw sample") -> sample request block, LIMS hand-off, result gate.
25. QA hold point / stage release: "approved / not approved for coating", "release for packing" with QA results summary.
26. Batch reconciliation: standard batch size, rework added, theoretical, actual, %, variance; % yield = (A + B) / T × 100 with A = actual, B = rework generated.
27. Yield statement across stages (input, actual, %, std, permissible lower/upper).
28. Environmental conditions (temperature, RH) at stage start.

## Weaknesses of the paper format that the eBMR must eliminate
- Manual calculations and transcription (potency, yields, counts) -> engine computes, shows formula, verifier confirms.
- Free-text "has/has not", "Y/N" -> derived from data.
- Ranges printed but not enforced -> hard/soft limits with deviation trigger.
- Loops, extra additions, reworks recorded ad hoc -> structured.
- Header repeated on each page; signatures without meaning/time -> Part 11 signature manifestation.
- IP (Indian Pharmacopoeia) references -> in our FDA/EU scope, compendial references must be master data (USP / Ph. Eur. / other), not hard-coded.
