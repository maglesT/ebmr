# Glossary

**Draft**

Every pharma, regulatory and project term a developer meets in the code, in alphabetical order. Each entry has the
meaning in plain words and "Where" it shows up. If a term is missing, add it here. Start with the
[primer](01-pharma-primer.md) if the whole subject is new. Regulations are paraphrased, never quoted. Writing rules:
[STYLE.md](STYLE.md).

Module pages: [kernel](modules/kernel.md), [site-services](modules/site-services.md), [expr](modules/expr.md),
[recipe-core](modules/recipe-core.md), [api-contract](modules/api-contract.md),
[tablets-server](modules/tablets-server.md), [tablets-web](modules/tablets-web.md),
[integrations](modules/integrations.md), [shared-kits](modules/shared-kits.md),
[injectables](modules/injectables.md), [tools](modules/tools.md).

Quick jump: [A](#a) [B](#b) [C](#c) [D](#d) [E](#e) [F](#f) [G](#g) [H](#h) [I](#i) [K](#k) [L](#l) [M](#m)
[N](#n) [O](#o) [P](#p) [Q](#q) [R](#r) [S](#s) [T](#t) [U](#u) [V](#v) [W](#w) and the lists at the end:
[invariants](#invariants-inv-01-to-inv-48), [generic blocks and gates](#generic-blocks-and-gates-g-01-to-g-25),
[states](#state-names-that-recur).

## Numbers and symbols

- **21 CFR Part 11** — US rule on electronic records and electronic signatures. Says what an audit trail, a unique
  signature and a signature's meaning must look like. Where: the signature and audit design in
  [kernel](modules/kernel.md); controls in the `DI` family (for example
  [DI-36](../../compliance/controls/DI-36.yaml)).
- **21 CFR Parts 210 and 211** — US current GMP rules for finished drugs (211 covers batch records, review and
  laboratory controls). Where: the `PR` and `DI` control sources; US dispositions in
  [recipe-core](modules/recipe-core.md).

## A
- **Administrator** — a person who manages accounts, devices and settings. May not hold any GMP role (INV-11). Where:
  [kernel](modules/kernel.md); control [DI-18](../../compliance/controls/DI-18.yaml).
- **ADR (architecture decision record)** — a short document that records why a technical choice was made. Lives in
  `docs/adr/` (0001 to 0019). Example: ADR 0008, market profile engine; ADR 0013, manufacturer release plus market
  dispositions. Not the same as a *decision record*.
- **ALCOA+** — the data-integrity checklist: records are Attributable, Legible, Contemporaneous, Original and
  Accurate, plus Complete, Consistent, Enduring and Available. Where: everywhere; see the table in the
  [primer](01-pharma-primer.md).
- **ALERT, ACTION, CRITICAL** — the three severities of an *exception*. ALERT is informational and needs a
  disposition, ACTION usually blocks, CRITICAL always blocks. Where: `Severity` in
  `packages/api-contract/src/ns/execution.ts`; [recipe-core](modules/recipe-core.md).
- **Amendment** — the only way to change a locked batch record. QA opens it with a signature and a reason; entries
  are appended, the original is never edited. Opening it suspends the release of lots made from the record. Where:
  `AMENDMENT_OPEN` and `AMENDMENT_CLOSE` in `packages/api-contract/src/ns/records-lock.ts`;
  [recipe-core](modules/recipe-core.md).
- **Anchor** — a copy of an audit-chain checkpoint stored outside the main data, so tampering shows up. Where:
  [kernel](modules/kernel.md); INV-08; ADR 0007.
- **Anhydrous basis** — a measurement stated as if the material had no water. The as-is purity is the stated purity
  times (100 - water %) / 100. GB-T-01 example: 99.20 x (100 - 0.80) / 100 = 98.4064 %. Where: dispensing
  calculations in [expr](modules/expr.md).
- **Annex 11 (EU GMP)** — the EU rules for computerised systems: validation, audit trail review, data checks,
  electronic signatures. Where: `DI` controls; the audit-trail review.
- **Annex 16 (EU GMP)** — the EU rules on certification by a QP and batch release. Where: the EU disposition.
- **AP (authorised person)** — the India-licensed person who certifies each finished lot before it leaves the factory.
  Signs the *manufacturer release*. Where: role `AUTHORISED_PERSON`; [recipe-core](modules/recipe-core.md);
  [IN-05](../../compliance/controls/IN-05.yaml).
- **API (active pharmaceutical ingredient)** — the ingredient that does the medical work, also "the active". In the
  demo data: "Exemplazine sodium" (GB-T-01) and "Exemplafen" (GB-T-02). Do not confuse it with an HTTP API; context
  tells which. Where: formula lines with role `ACTIVE`.
- **Approved technical staff** — people the licence names for production and testing. Where: [IN-04](../../compliance/controls/IN-04.yaml).
- **Archive** — the long-term store of closed batch records with their evidence exports. Where:
  `packages/api-contract/src/ns/archive.ts`; [kernel](modules/kernel.md).
- **Assay** — a lab test that measures how much active ingredient a sample holds. Where: lot results, finished-lot
  tests (GB-T-02: ASSAY 99.6 %). [site-services](modules/site-services.md).
- **Atomic key (rule key)** — one single rule value in the market engine (for example one retention period or one hold
  time). For each key the engine picks the value that satisfies India plus all markets. Where: INV-28; [kernel](modules/kernel.md).
- **Attribution** — tying an action to a named person and role. Request bodies carry it via `withAttribution`. Where:
  `packages/api-contract/src/common.ts`.
- **Audit trail** — the computer-made, tamper-evident log of who changed what, when and why. Where:
  [kernel](modules/kernel.md); [DI-22](../../compliance/controls/DI-22.yaml), [DI-23](../../compliance/controls/DI-23.yaml).
- **Audit-trail review** — a person reads the audit events of a batch and signs, as part of batch review. Where:
  `AUDIT_TRAIL_REVIEW` act; [DI-25](../../compliance/controls/DI-25.yaml); INV-48.

## B
- **B-xx** — rows of the India market-resolution table in the outline: how India-specific rules are resolved for a
  batch. Where: `docs/outline/build-outline.md`.

- **Badge and PIN** — a way to sign in or sign by presenting a card and a code, used on shop-floor terminals.
  `BADGE_PIN` is a signing method; the other is `PASSWORD`. Where: [kernel](modules/kernel.md).
- **Batch** — one defined quantity of a medicine made in one run, treated as uniform; identified by a batch number.
  Where: everywhere. See the [primer](01-pharma-primer.md).
- **Batch number** — the unique, never-reused identifier of a batch. Kept in an allocation register that also records
  how every number was used. Where: [site-services](modules/site-services.md) (`0600_batch_number_register.sql`);
  [IN-18](../../compliance/controls/IN-18.yaml); INV-27.
- **Batch status** — `ISSUED`, `IN_PROGRESS`, `ON_HOLD`, `EXECUTION_COMPLETE`, `ABORTED`, `CANCELLED`. Where:
  `BatchStatus` in `packages/api-contract/src/ns/batches.ts`.
- **Block** — one configurable unit of a master record flow (a phase), for example weighing or IPC. The generic list is
  G-01 to G-25; the Tablets-specific ones are TB-01 to TB-24. See *generic blocks* at the end.
- **BMR (batch manufacturing record)** — the executed record of one batch. Also called the batch record. Compare *MBR*.
- **Break-glass administrator** — an emergency administrator account with extra audit, role `BREAK_GLASS_ADMIN`.
  Where: [kernel](modules/kernel.md).
- **Bridging validity** — a time-limited signed record that keeps an older MBR version usable for a market while
  that market's authorisation for the new version is pending. Where: INV-17; [recipe-core](modules/recipe-core.md).
- **Bright stock** — product that is filled into its container but not yet labelled, set aside with a tag and labelled
  later, only for the same batch and product, and only within a maximum hold time. Where: block
  `apps/tablets-server/src/blocks/tb-23.ts`; [PR-38](../../compliance/controls/PR-38.yaml).
- **Bulk** — the finished but unpackaged product (for example tablets in drums), or the bulk container list that a
  packaging order draws from. Where: `POST /api/batches/:id/bulk`; [recipe-core](modules/recipe-core.md).

## C
- **CAPA (corrective and preventive action)** — the actions taken to remove the cause of a problem and stop it
  returning. Here recorded on a deviation's closure basis; no separate CAPA register yet. Where:
  `packages/api-contract/src/ns/deviation.ts`; [IN-01](../../compliance/controls/IN-01.yaml).
- **CDSCO** — India's central drug regulator (Central Drugs Standard Control Organisation). Works with state
  regulators. Where: licence checks in [site-services](modules/site-services.md).
- **Certificate of analysis (CoA)** — the lab's document of test results for a lot. Where: the EU QP package.
- **cGMP** — "current" good manufacturing practice: the US phrasing, meaning the rule is judged by today's standard,
  not an old one. See *GMP*.
- **Challenge (authentication)** — the one-time request the server makes before a signature; the signature must
  consume the matching fresh authentication event (INV-10). Where: [kernel](modules/kernel.md) `esig`.
- **Change control** — the controlled way to change anything that touches quality (master records, materials,
  equipment). Where: [PR-06](../../compliance/controls/PR-06.yaml), [IN-03](../../compliance/controls/IN-03.yaml);
  the `CHANGE_RECORD` evidence kind.
- **Checked (MBR state)** — the stage where an independent checker has signed the draft master. See *MBR life cycle*.
- **Cleaning status** — whether process equipment is clean and for how long. Equipment is used only if clean
  (INV-12). Where: block G-09.
- **Clearance (line clearance)** — a documented check that a room or line is empty of the previous product, labels and
  paper before a new batch starts. Where: block G-10; INV-15; [IN-21](../../compliance/controls/IN-21.yaml).
- **Closure basis** — the written conclusion of a deviation (root-cause method, CAPA references, other batches
  assessed). Where: `deviation.ts`.
- **Compendial** — from a pharmacopoeia (a book of official test methods and limits, such as IP, USP, Ph. Eur.).
  Where: specifications in [site-services](modules/site-services.md).
- **Compensating excipient** — a filler whose amount is reduced to make up for a heavier active after potency
  adjustment, so the total batch weight stays right. Example: microcrystalline cellulose in GB-T-01 (7.131 kg).
- **Container state** — `OPEN`, `CLOSED`, `HELD`, `SORTED`, `REJECTED`, `RELEASED_BY_QA`. Where: `ContainerState` in
  `ns/containers.ts`.
- **Contingency form** — a numbered paper form used when the system is down or for a hybrid step. States: `ISSUED`,
  `RETURNED`, `TRANSCRIBED`, `VERIFIED`, `VOIDED`, `MISSING`. Where: `ContingencyFormState` in
  `packages/api-contract/src/ns/archive.ts`; [DI-43](../../compliance/controls/DI-43.yaml); INV-27.
- **Control (compliance control)** — a requirement in the register that the software must prove, with an ID such as
  DI-22. See *control-ID families*.
- **Control recipe** — the resolved, scaled, hashed copy of the MBR that one batch runs. Never changes after issue
  (INV-02). Where: [recipe-core](modules/recipe-core.md).
- **Control-ID families** — `DI`, `PR`, `IN`, `ST`. See the section below.
- **CTD/dossier** — the filed submission to the regulator. Appears in sterile controls (ST-70). Where: `ST` family.

## D
- **Data integrity (DI)** — trust in the record: complete, consistent, accurate. See *ALCOA+*.
- **Data point** — one recorded value with its unit, who, when and how it was captured. Insert-only (INV-06).
- **Decision record** — an owner decision, in `docs/decisions/` (0001 to 0016). Example: 0008 sets testing depth;
  0013 requires this handbook. Compare *ADR*.
- **Deviation** — a departure from approved instructions or specifications. States: `OPEN`, `UNDER_INVESTIGATION`,
  `IMPACT_ASSESSED`, `PENDING_CLOSURE`, `CLOSED`, `CANCELLED`. Classes: `MINOR`, `MAJOR`, `CRITICAL`. Impact per
  subject and market: `NONE`, `POTENTIAL`, `CONFIRMED`. Where: `deviation.ts`;
  [site-services](modules/site-services.md); [PR-49](../../compliance/controls/PR-49.yaml).
- **DI** — see *control-ID families*.
- **Digital signature certificate (DSC)** — a government-recognised e-signature on a token. Not used in v1; password
  and badge signatures with Part 11 properties are used instead.
- **Direct compression** — making tablets by compressing a dry blend without granulation. Example: GB-T-02.
- **Disintegrant, glidant, lubricant, binder, diluent** — excipient roles. See the [primer](01-pharma-primer.md).
- **Dispensing** — weighing each ingredient from stock into labelled containers for a batch. Block G-07 and TB-01.
- **Dual custody** — two different people sign each handover of a controlled substance: the first custodian who
  dispenses, transfers, returns or destroys it, and a second one (the witness of a destruction) who countersigns; one
  person never fills both places. Where: `recipe.controlled_custody` in [recipe-core](modules/recipe-core.md); IN-53.
- **Disposition** — the decision on a lot or an exception. For lots: manufacturer release or market disposition.
  For exceptions: `NO_IMPACT` or `DEVIATION_RAISED`. Where: [recipe-core](modules/recipe-core.md).
- **Dissolution** — a test that measures how fast the tablet releases its active in a liquid. Appears as a finished-lot
  test (GB-T-02: DISSOLUTION 93 %).
- **Drugs Rules, 1945** — the Indian rules (under the Drugs and Cosmetics Act) that include licences (Forms 25, 28, ...)
  and Schedule M.
- **DSCSA** — see *serialisation*.
- **D-xx (defaults)** — "D" numbers record a default choice that was taken when a question was open, for example
  D-5-7 (slice 5 default 7), D-P4-15 (Phase 4 default 15), D-S6-5 (Phase 3 slice 6), D-6a-7 (Phase 4 slice 6a). The
  pattern is `D-<phase or slice>-<n>`. Decision 0004 says every open question takes its stated default unless the
  owner says otherwise. Where: code comments; `docs/build-plan/`; `docs/decisions/phase-*-open-questions.md`.

## E
- **eBMR** — electronic batch manufacturing record: this product.
- **EBMR-xxx-nnn codes** — the project's error codes, grouped by area (IAM identity, EXE execution, DEV devices and readings, SITE site services (deviations are SITE-3xx),
  MKT market, REC records, ESIG signatures, REV review, REL release, DSP disposition, LCK locking, IND India, SBX
  sandbox and so on). Full list: [error codes](reference/error-codes.md) (generated).
- **Edition** — one of the two products: Tablets or Injectables. Controls list the editions they apply to; the trace gate
  covers only editions listed in `phase.yaml`. Where: `compliance/phase.yaml`.
- **EMS (environmental monitoring system)** — measures air and surface cleanliness in sterile areas. Injectables
  matter (ST family, INV-23). Where: [injectables](modules/injectables.md).
- **ENG-xxx codes** — refusal codes of the execution engine, for example `ENG-STALE` (someone else changed the batch)
  and `ENG-SEGREGATION` (the person is involved and cannot disposition). Shown to the user with the controls they
  protect. Where: `packages/recipe-core/src/engine/engine.ts`.
- **Epoch (evidence epoch)** — a version counter on a lot or batch that goes up with any write that can affect release.
  G-REL is computed with an epoch and re-checked at signing; if it moved, the signature is refused (INV-05). Where:
  `packages/recipe-core/sql/0718_review_gates_and_epoch_rows.sql`; type `GrelEpoch` in
  `packages/api-contract/src/ns/release.ts`; outline 5.7.
- **ERP (enterprise resource planning)** — the company's business system (orders, materials, stock). Here a stub plays
  the ERP; it imports products, materials and production orders and asks before shipping. Where:
  [site-services](modules/site-services.md); [integrations](modules/integrations.md); INV-42.
- **E-signature (electronic signature)** — see the [primer](01-pharma-primer.md). Where: [kernel](modules/kernel.md) `esig`.
- **Exception** — an automatic flag when something is outside a limit or a rule. Has a severity and must be
  dispositioned. Distinct from a deviation, which is the investigated record. Where: `Severity`, exception register in
  [recipe-core](modules/recipe-core.md); INV-41.
- **Excipient** — any ingredient other than the active.
- **Expert decision** — the external expert's verdict on a control (`PENDING`, `FOLLOW`, `DONT_FOLLOW`, `MODIFY`). All
  242 are `PENDING` (the 241 of the review pack and the draft IN-53, whose `pack_version` is `draft`). Never change it yourself. Where: each file in `compliance/controls/`.
- **Export permission** — an Indian permission to make a product only for export when it is not approved for India.
  Where: `ns/india.ts`; D-6-2.
- **Expression language** — the project's own exact-decimal calculation language with units and rounding. Where:
  [expr](modules/expr.md); ADR 0005.

## F
- **FBD (fluid bed dryer)** — dries wet granules by blowing warm air through them. Used in GB-T-01.
- **FDA** — US Food and Drug Administration.
- **Finished lot** — the packed product lot that is released and sold. A processing batch can make several packaging
  lots over time. Where: `0842_finished_and_returned_lots.sql` in site-services.
- **F-numbers (findings)** — numbered findings from review passes, for example F34 of the Phase 3 exit review. Each fix
  has a test that fails on the old code. Where: `docs/progress/history.md` (search for "F34"), commit messages; the
  fix-finding skill.
- **Form 25, 28, 25A, 28A** — Indian manufacturing licence forms. 25 and 28 are manufacturing licences for different
  product classes (28 is for the sterile classes); the "A" forms are loan licences. In the contract the form is
  `FORM_25` or `FORM_28`; `LicenceForm` also lists `25A` and `28A`. Where: `ns/india.ts`; [IN-30](../../compliance/controls/IN-30.yaml).
- **Formula line roles** — `ACTIVE`, `EXCIPIENT`, `COATING`, `PROCESSING_AID`.

## G
- **Genealogy** — the links between a product and everything that went into it (ingredient lots, equipment, other
  batches). Created in the same transaction as every consumption (INV-14). Used for recalls. Where:
  [IN-29](../../compliance/controls/IN-29.yaml).
- **GMP** — Good Manufacturing Practice. See the [primer](01-pharma-primer.md). A "GMP installation" is a real one
  (`InstallationKind` `GMP`); a *sandbox* is the other kind.
- **Golden batch** — a fully scripted demo batch whose expected quantities were computed by hand before the first run,
  then run end to end in tests. GB-T-01 and GB-T-02. Where: `apps/tablets-server/test/golden/`.
- **Governing market** — the market whose rule decided a resolved value. Stored with each rule evaluation (INV-29).
- **Granulation** — making powder into grains. Wet granulation adds a liquid binder; dry granulation compacts powder.
- **G-xx, G-REL** — see *generic blocks and gates* at the end. G-REL is the release gate.

## H
- **Hash** — a SHA-256 fingerprint. Used for signed content, the issued recipe, the true copies and the audit chain.
- **Hazard class** — `NONE`, `SEX_HORMONE`, `STEROID`, `CYTOTOXIC`: the risk that decides if an area must be dedicated.
  Where: `ns/india.ts`; [IN-27](../../compliance/controls/IN-27.yaml).
- **H-COAT, H-PACK** — QA hold points in the GB-T-01 flow: "approved for coating" and "release for packing". Bulk may be
  issued to a packaging order only after H-PACK is signed. Where: `ns/planning.ts`; [tablets-server](modules/tablets-server.md).
- **High-water mark** — the point in the audit trail up to which events were reviewed. Where: INV-48; `review.ts`.
- **Hold** — a batch or container stopped on purpose. A batch `ON_HOLD` cannot start or complete steps. A hold time
  is also the maximum time an intermediate may wait. Types: `SUPERVISOR`, `QA`.
- **Hybrid step** — a step done partly on paper, with a declared linkage to the electronic record. Where: DI-43.

## I
- **ICH** — International Council for Harmonisation; its guidelines (for example Q9 risk management, Q10 quality
  system) are cited in some controls.
- **Idempotency key** — a client token that makes a retried request harmless. Where: outline 5.7;
  `platform_idempotency.sql` in [kernel](modules/kernel.md).
- **IN** — see *control-ID families*.
- **INELIGIBLE** — a market disposition state: the market cannot be added because the evaluation has an unmet final
  item (GB-T-02 and the US).
- **Injectables edition** — the sterile edition (not built yet; Phase 5). Where: [injectables](modules/injectables.md).
- **In-process control (IPC)** — a check made during production. Block G-13. Where: [PR-29](../../compliance/controls/PR-29.yaml) (see the outline's block table).
- **Investigator** — a person assigned to investigate a deviation or OOS; recorded on the record.
- **Involvement set** — the people who took part in a batch (performed, entered, corrected, verified, handed over). Review
  and release signers must be outside it (INV-35). Where: `0306_disposition_involvement.sql`,
  `0310_involvement_from_rows.sql` in [recipe-core](modules/recipe-core.md).
- **INV-xx** — see *invariants* below.
- **IP, USP, Ph. Eur.** — Indian, US and European pharmacopoeias.
- **IQ, OQ, PQ** — installation, operational and performance qualification. See *validation*.
- **ISA-95 / B2MML** — standards for exchanging data between the factory and business systems. Where: ERP adapter
  design in [integrations](modules/integrations.md).
- **Issue (batch issue)** — the moment a batch moves from `PLANNED` to `ISSUED`: the MBR version is pinned, the recipe
  is resolved and hashed, the batch number registered. Signable action `GMP_BATCH_ISSUE`. Where:
  `0170_batch_issue.sql`.

## K
- **K-xx/TB-xx, KB-xx/IB-xx** — building-block numbers from the process specifications: K-xx and TB-xx from the
  Tablets specification, KB-xx and IB-xx from the Injectables one. G-xx is the canonical generic list they map to
  (outline section 6.6 holds the alias table). The Tablets edition's blocks live in `apps/tablets-server/src/blocks/`
  (`tb-01.ts` to `tb-24.ts`).

## L
- **Label reconciliation** — see *reconciliation*.
- **Limit tiers** — `REGISTERED` (filed with the regulator), `VALIDATED`, `INTERNAL_ACTION`, `ALERT`. Where:
  `LimitTierWire` in `ns/execution.ts`; [ST-01](../../compliance/controls/ST-01.yaml).
- **LIMS (laboratory information management system)** — the lab's system for samples, tests and results. The
  project has "LIMS-lite" inside site-services. Where: [site-services](modules/site-services.md);
  `0740_lims_lite.sql`.
- **LMS (learning management system)** — a system that holds training records. A training gate checks that signers are
  trained and qualified (INV-26). Where: [kernel](modules/kernel.md) qualifications.
- **Loan licence** — a manufacturing licence in which one company makes product on another company's licence
  (Forms 25A, 28A). In the contract `LicenceKind` is `MANUFACTURING` or `LOAN`. Where: `ns/india.ts`.
- **Lock (record lock)** — see *amendment*; a processing record locks at bulk reconciliation closure, a packaging
  record at its lot's first manufacturer disposition (INV-21).
- **LOD (loss on drying)** — the moisture content found by drying a sample. A loop in GB-T-01.
- **Lot** — a defined quantity of one material or finished product received or made at one time. Material lots have a
  release route (`IDENTITY_TESTED` or `VENDOR_HISTORY`). Where: [site-services](modules/site-services.md); INV-13.
- **L-xx** — items L-01 to L-68 of the logic, usability and buildability review of the outline. Outline v0.2 resolved
  each one (`resolution-log.md` records how), and the outline text carries the item number where the resolution
  landed, for example L-19 (the after-release states) or L-25 (versioned switches). Code comments and test names cite
  them as the design source. Where: `docs/outline/build-outline.md`.

## M
- **MA (marketing authorisation)** — the regulator's approval to sell a product. Each MBR version must conform to it
  per market. Where: `0160_market_authorisation.sql`; [PR-04](../../compliance/controls/PR-04.yaml).
- **Manufacturer release** — the AP's certification of a finished lot. Always required. See the
  [primer](01-pharma-primer.md). States: `NOT_READY`, `READY`, `RELEASED`, `REJECTED`, `RELEASE_SUSPENDED`,
  `RECALLED`, `REJECTED_AFTER_RELEASE`. Where: `ManufacturerReleaseState` in `ns/release.ts`.
- **Market** — a country or region the product is sold in. Codes: `IN`, `US`, `EU`. India is always in the set (INV-28).
- **Market disposition** — one decision per finished lot and export market. States: `NOT_READY`, `READY`, `RELEASED`,
  `REJECTED`, `AWAITING_QP_CERTIFICATION`, `CERTIFIED`, `REJECTED_BY_QP`, `INELIGIBLE`, `RELEASE_SUSPENDED`, `REMOVED`,
  `RECALLED`, `REJECTED_AFTER_RELEASE`. Where: `MarketDispositionState` in `ns/release.ts`; INV-39.
- **Market profile** — the engine that turns the rules of every market in scope into one stored resolved value per
  rule key, "stricter wins". Where: [kernel](modules/kernel.md); ADR 0008; [IN-52](../../compliance/controls/IN-52.yaml).
- **Market-add evaluation** — the checklist signed when a market is added to an already released lot. An unmet final
  item makes that market `INELIGIBLE` (INV-43). Signable action `RELEASE_ACT` with `MARKET_ADD`.
- **MBR (master batch record)** — the approved recipe. Versions pass `DRAFT`, `SUBMITTED`, `CHECKED`, `APPROVED`, then
  `CURRENT` (or `BRIDGING`) and later `SUPERSEDED`. See the [primer](01-pharma-primer.md). Where: [recipe-core](modules/recipe-core.md).
- **Meaning (of a signature)** — why the person signed, for example `PERFORMED`, `VERIFIED`, `WITNESSED`,
  `QA_REVIEWED`, `AUDIT_TRAIL_REVIEWED`, `TRUE_COPY_VERIFIED`. The signature record stores it with the signed content.
  Where: [kernel](modules/kernel.md) `esig`; [DI-36](../../compliance/controls/DI-36.yaml).
- **Migration** — a numbered SQL file that changes the database. Where: `packages/*/sql/`; handbook page 5.
- **MW form / base** — molecular weight of the salt versus the free base; their ratio is the *salt factor*.

## N
- **Non-conforming material** — material that fails a requirement. Only handled through deviation, rework or
  rejection.
- **NOT_READY, READY, RELEASED, RELEASE_SUSPENDED, RECALLED** — release states. See the *state names* list at the end.

## O
- **NDPS** — India's Narcotic Drugs and Psychotropic Substances Act 1985 and Rules 1985: the law on making and keeping
  stock accounts of such substances. Not in the inputs, so not verified (status U): the draft control IN-53 and its
  register export follow outline decision 14 until it is. Where: controlled-substance mode in
  [recipe-core](modules/recipe-core.md).
- **Occurred_at / recorded_at** — two times per event. `recorded_at` is the database clock and rules ordering and
  audit; `occurred_at` is a claimed or source time with a trust level (`DEVICE_SYNCED` or `DEVICE_UNSYNC`...). INV-16.
- **OOS (out of specification)** — a lab result outside its limit. Starts a lab investigation. Where:
  `kind: 'OOS'` in `deviation.ts`; [IN-20](../../compliance/controls/IN-20.yaml).
- **OOT (out of trend)** — a result still within limits but outside the normal pattern.
- **Operator** — role that does the work.
- **Outbox** — a table of events to send out reliably after commit. Where: `platform_outbox.sql` in [kernel](modules/kernel.md).

## P
- **Packaging order** — a GMP batch of a PACKAGING master that packs one issued processing batch. Where:
  `ns/planning.ts`.
- **Part 11** — see *21 CFR Part 11*.
- **Person / account** — a person is a human; accounts are what they log in with. One active GMP-capable account per
  person; accounts are never deleted or reused (INV-11). Where: [kernel](modules/kernel.md).
- **Phase** — a stage of the build plan (1 to 7). Two meanings: (1) the project phase (the current phase is in
  `compliance/phase.yaml`); (2) a *phase* inside a master record: one configured block. Context decides.
- **phase.yaml** — `compliance/phase.yaml`. Holds `current_phase` and the editions the trace gate covers. A control is due
  when its `target_phase` is at or before the current phase; CI then needs a passing test for it.
- **Policy** — a configurable rule with a version. A newer policy never applies to a batch issued earlier (INV-47).
- **PPQ (process performance qualification)** — commercial-scale batches that prove a process is repeatable. G-REL checks
  its outcome or the concurrent-release rule.
- **PQR / APR (product quality review)** — a periodic review of all batches of a product. Where: `ns/pqr.ts`;
  [IN-01](../../compliance/controls/IN-01.yaml), [PR-58](../../compliance/controls/PR-58.yaml).
- **PR** — see *control-ID families*.
- **Process window** — an allowed time or range for a process step; timers of kinds `TIMER`, `HOLD`, `PROCESS_WINDOW`,
  `USE_BY`, `EXPOSURE`.
- **Production approval** — the production head's signature on a finished record before QA review (INV-30).
- **Projection** — a read model derived from system-of-record tables. GMP decisions never read a projection (INV-38).

## Q
- **QA (quality assurance)** — the independent function that approves masters, reviews records, handles deviations and
  signs quality gates. Roles include `QA_REVIEWER`, `QA_MBR_APPROVER`, `QA_SHOP_FLOOR`.
- **QC (quality control)** — the laboratory function. Roles include `QC_ANALYST`, `HEAD_OF_QC`.
- **QCU (quality control unit)** — the US term for the unit with authority over approval and rejection. In the code, the
  QCU decides the US disposition and authorises reprocessing. PR-54, PR-47.
- **QMS (quality management system)** — the company's system for deviations, CAPA, change control and audits. Here only
  its status is read through an interface, within a freshness bound (INV-38).
- **QP package** — the true-copy bundle of records issued to the EU QP. Signable action `QP_PACKAGE_ACT`.
- **QP (qualified person)** — the EU's personally responsible certifier of each batch. Role `EU_QP_READER` gives the
  read-only, time-boxed access to the package. Where: `ns/qp-shipping.ts`; [DI-39](../../compliance/controls/DI-39.yaml).
- **Quarantine** — status of goods that may not be used or sold until released. Where: [DI-39](../../compliance/controls/DI-39.yaml).

## R
- **Raw data** — the first capture of a value from a device or a person. Any data a quality decision relies on is raw.
  Where: [DI-01](../../compliance/controls/DI-01.yaml).
- **RBE (review by exception)** — a rule set that lets reviewers focus on exceptions. See the [primer](01-pharma-primer.md).
- **Recall** — pulling a released lot back from the market. `RECALLED` is terminal. [IN-29](../../compliance/controls/IN-29.yaml).
- **Reconciliation** — matching what was issued to what was used, returned, destroyed and kept. Yield, printed-material
  and serial reconciliation. Where: G-20, G-21; [PR-39](../../compliance/controls/PR-39.yaml); INV-32.
- **Recovery addition** — adding milled material from an earlier batch of the same product into a new blend within a cap.
  Case 2 in GB-T-01. Where: G-24; INV-33; [PR-47](../../compliance/controls/PR-47.yaml).
- **Register** — three uses: (1) the *control register*, the data in `compliance/controls/` plus `tools/register` that
  validates it and builds the traceability matrix; (2) the *batch number register*; (3) the *record-type register*
  (DI-01). Check the context.
- **Replicate section** — a part of a master record repeated for N units (for example two sub-lots). ADR 0004.
- **Reprocessing** — running non-conforming or leftover material through a step again. New batch number linked to the
  parent (INV-33).
- **Reserve / retention sample** — a sample kept for later checks: finished lots (reserve) and starting materials
  (retention). Where: [IN-32](../../compliance/controls/IN-32.yaml); `ns/samples.ts`.
- **Retention** — how long a record must be kept and when it may be destroyed. The latest of all applicable rules.
  Where: INV-22; [DI-47](../../compliance/controls/DI-47.yaml), [IN-08](../../compliance/controls/IN-08.yaml).
- **Review pack** — the external expert's package of 241 controls (v0.9). Source of the control register.
- **Role** — a set of permissions held by a person. Roles seen in code: `OPERATOR`, `SUPERVISOR`, `QA_REVIEWER`,
  `QA_MBR_APPROVER`, `QA_SHOP_FLOOR`, `QC_ANALYST`, `HEAD_OF_QC`, `AUTHORISED_PERSON`, `SYSTEM_ADMINISTRATOR`,
  `BREAK_GLASS_ADMIN`, `EU_QP_READER`.
- **R-xx** — items R-01 to R-35 of the regulatory review of the outline, resolved in outline v0.2 (for example R-04).
  Code comments and test names cite them next to the control. Where: `docs/outline/build-outline.md`.

## S
- **Salt factor** — molecular weight of the salt form divided by that of the free base. GB-T-01: 322.33 / 300.35 =
  1.073181. Where: dispensing calculations.
- **Sandbox** — a separate database for test, training and simulation work. GMP batches can never come from it, and its
  identifiers look different on purpose. `InstallationKind` is `GMP` or `SANDBOX`. Where:
  `sandbox_*.sql` in [kernel](modules/kernel.md); INV-18; [DI-05](../../compliance/controls/DI-05.yaml).
- **Schedule H2** — an Indian schedule that puts extra record duties on certain drugs; details are not fully confirmed, so the code keeps a payload stub bound to the record (D-P4-14). Where: `ns/india.ts`.
- **Schedule M** — Part of India's Drugs Rules that sets GMP. The revised version applies from the compliance
  dates the government set. Cited as "Schedule M" with a section number. Where: `IN` controls.
- **Serialisation** — giving each pack a unique code (and shippers an SSCC) for tracking. Where:
  `packages/integration-sdk/src/serialisation/`; block G-21.
- **Severity** — see *ALERT, ACTION, CRITICAL*.
- **Signable action** — a named kind of signing event with a fixed content and role rule, such as
  `MANUFACTURER_RELEASE`, `REVIEW_ACT`, `QUALITY_ACT`, `RELEASE_ACT`, `RECORD_LOCK_ACT`, `ARCHIVE_ACT`, `INDIA_ACT`,
  `LOT_DECISION`, `PQR_SIGN_OFF`. Where: `packages/api-contract/src/signable.ts`; [DI-35](../../compliance/controls/DI-35.yaml).
- **Signature** — see *e-signature* and *meaning*. Signatures are inserted only by the signing function (INV-10) and
  become invalid if the signed content changes (INV-09).
- **Site services** — the shared database for persons, lots, deviations and ERP masters. Where:
  [site-services](modules/site-services.md); ADR 0001.
- **SOP (standard operating procedure)** — a controlled written procedure. Pinned by version in the batch (DI-10).
- **Sponsor/loan** — see *loan licence*.
- **SSCC** — serial shipping container code on a shipper box; issued by the database.
- **ST** — see *control-ID families*.
- **Stage** — one part of the process bound to a room, line or equipment train; each ends with a sign-off.
- **Step status** — `PENDING`, `ENABLED`, `IN_PROGRESS`, `ATTEMPT_HANDED_OVER`, `AWAITING_VERIFICATION`, `COMPLETED`,
  `NOT_APPLICABLE`, `SKIPPED`. Where: `StepStatus` in `ns/execution.ts`.
- **Stricter rule wins** — the project principle: of all rule sets that apply, use the strictest; India's is the floor.
- **S-numbers (S4, S17, ...)** — rows of the segregation-of-duties register (outline section 7.2): which roles must be
  different people for an act. Some rows are configurable switches with a safe default (S4: may the checker also
  approve an MBR; default no); others are locked and can never be switched off (S10 reviewer and disposition-signer
  independence, S17 the approved-technical-staff gate). Not to be confused with "service S-3" in the building-block
  table. Where: outline 7.2.

## T
- **TB-xx** — Tablets-edition blocks TB-01 to TB-24 (dispensing TB-01, bulk-gate and bottle-line TB-23, finished-pack
  TB-24). Where: `apps/tablets-server/src/blocks/`.
- **Tenant** — the legal owner of records. Site-owned resources belong to the site. Where: outline 4.
- **Theoretical yield** — the amount you would get with no loss; computed (INV-25).
- **Tombstone** — the stub a purge leaves, with the chain checkpoint (INV-22).
- **Traceability matrix** — the generated map control to design element to test. Built by `tools/register`; the CI trace
  gate fails when a control due at the current phase has no test named with its ID. Where: [tools](modules/tools.md);
  [control map](reference/control-map.md).
- **True copy** — a certified, exact copy of a record; marked as a copy; verifiable offline by its hash.
  `TRUE_COPY`, `PDF_TRUE_COPY` (PDF/A-3). Where: `archive.ts`; [DI-41](../../compliance/controls/DI-41.yaml).

## U
- **U (status)** — "unconfirmed": a legal detail waiting for counsel to confirm. Example: exact instrument and label
  particulars of Rule 94. Where: outline.
- **UCUM** — a standard for unit codes; the expression language uses it. [expr](modules/expr.md); ADR 0005.
- **UNDER_AMENDMENT** — state of a locked record while an amendment is open.

## V
- **Validation** — documented proof that a system or process fits its use. IQ, OQ, PQ, PPQ, CSV. See the
  [primer](01-pharma-primer.md). Where: [shared-kits](modules/shared-kits.md); [DI-03](../../compliance/controls/DI-03.yaml).
- **Vendor-history route** — a way to release an excipient lot for use on the supplier's track record, without an
  identity test, for India-only batches. Not accepted for the US. GB-T-02 uses it for `GBT2-MCC-V01`. Where:
  `0710_material_lots.sql`, `0720_lot_release_signed_route.sql`; [IN-24](../../compliance/controls/IN-24.yaml).
- **Verification** — a second person confirms a critical step. Meaning `VERIFIED`; also `WITNESSED`. INV-03.
- **Version pin** — a batch references library items by version and hash, never "latest" (DI-10).

## W
- **Witness** — a person who watches and signs for a one-off act, such as destruction of rejects (G-23).
- **WORM** — write once, read many storage. A deployment concern (decision 0003).

## Control-ID families

The register holds 242 controls in four families (241 from the review pack and the draft IN-53, controlled substances), one YAML file each in
[compliance/controls/](../../compliance/controls/). A control has an ID, a title, the editions, a type (`ENFORCED`,
`CONFIGURABLE`, `DESIGN_CHOICE`), a target phase, the regulatory sources and a behaviour text. Tests that prove a control
carry its ID in the test name.

| Family | Count | Plain meaning | Examples |
|---|---|---|---|
| **DI** | 50 | Data integrity and electronic records: audit trail, signatures, copies, retention, access, hybrid paper. | [DI-22](../../compliance/controls/DI-22.yaml) audit trail content, [DI-36](../../compliance/controls/DI-36.yaml) signature manifestation, [DI-41](../../compliance/controls/DI-41.yaml) true copies |
| **PR** | 60 | The production record: master records, execution, weighing, yields, reconciliation, deviations in line, release, markets. | [PR-02](../../compliance/controls/PR-02.yaml) master approval, [PR-31](../../compliance/controls/PR-31.yaml) yield, [PR-56](../../compliance/controls/PR-56.yaml) market dispositions |
| **IN** | 52 | India-specific rules from Schedule M and the Drugs Rules: AP, licences, batch numbering, retention, samples. | [IN-05](../../compliance/controls/IN-05.yaml) AP disposition, [IN-18](../../compliance/controls/IN-18.yaml) batch numbering |
| **ST** | 79 | Sterile (injectable) products: sterility assurance, environmental monitoring, filters, container closure, plus the cross-cutting limit floor. Mostly Injectables, due after Tablets v1. | [ST-01](../../compliance/controls/ST-01.yaml) regulatory floor for every numeric limit |

Do not confuse these with other letter-number labels in comments: `G-xx` (generic blocks), `TB-xx`, `IB-xx` (injectables
blocks), `K-xx`/`KB-xx` (old block numbers), `L-xx`, `R-xx`, `S-xx` (outline notes and switches), `F-xx` (review
findings), `D-xx` (defaults), `INV-xx` (invariants), `ENG-xxx` and `EBMR-xxx-nnn` (error codes).

## Invariants (INV-01 to INV-48)

An invariant is a rule that must hold at every moment. The outline's table (section 5.x, "Invariants") defines them;
the database enforces as many as it can. In plain words:

| ID | Plain meaning |
|---|---|
| INV-01 | A GMP batch has exactly one pinned, unchangeable MBR version that was valid for every market in its set when issued. |
| INV-02 | The issued recipe never changes; its stored hash matches. |
| INV-03 | A verifier or witness is never someone who performed, entered or corrected that step. |
| INV-04 | Author, checker and approver of an MBR are different people; nobody who edited it since it was last a draft may check or approve. |
| INV-05 | At the instant of release or market disposition, G-REL holds at an unchanged evidence epoch. |
| INV-06 | Data points, calculations, genealogy, signatures and audit events are insert-only; corrections add linked rows with a reason. |
| INV-07 | Every GMP insert or update writes an audit event in the same transaction. |
| INV-08 | Every audit chain verifies from its last checkpoint; anchors match, or a signed restore covers the gap. |
| INV-09 | A signature is valid only while its content hash is unchanged. |
| INV-10 | Every signature consumes one unused authentication event of the same person; only the signing function inserts signatures. |
| INV-11 | No person holds an administrator role and a GMP role; one active GMP account per person; accounts are never deleted or reused. |
| INV-12 | Process equipment occupancy never overlaps; equipment is used only clean, qualified and calibrated. |
| INV-13 | Material is consumed only from usable lots with a valid release route and reservation; lot quantity never goes negative. |
| INV-14 | Every consumption and output creates genealogy links in the same transaction. |
| INV-15 | A stage or order starts in a room or line only after a passed clearance recorded after the previous use. |
| INV-16 | Event times come from the database clock; claimed or source times are stored separately with a trust level. |
| INV-17 | At most one CURRENT version per MBR family, scope and market; BRIDGING only through a signed, time-limited record. |
| INV-18 | Test, simulation and training data live in a separate database; GMP batches come only from CURRENT or BRIDGING versions. |
| INV-19 | Loops and replicate sections never exceed their maximum without an exception. |
| INV-20 | No step finishes before its minimum duration; every maximum breach raises an exception. |
| INV-21 | A locked record changes only through the amendment process; a processing record locks only at bulk reconciliation closure. |
| INV-22 | Nothing is purged before its retain-until date or while on hold; purge only through the retention function, leaving a tombstone. |
| INV-23 | Injectables: aseptic filling only in an in-operation area with an active environmental monitoring session, valid APS and qualified operators. |
| INV-24 | Tablets: compression only with inspected tooling within stroke limits. |
| INV-25 | Derived values (expiry, yields, scaled quantities, counts) are computed, never typed. |
| INV-26 | Every signer and data-enterer held the required role and qualification at that instant; the evaluation is stored. |
| INV-27 | Batch numbers, contingency-form numbers, user IDs and signature IDs are never reused, even after a restore. |
| INV-28 | India is in every market set; each resolved rule is at least as strict as India's. |
| INV-29 | Every rule evaluation stores the value, governing market, branch and rule-table version. |
| INV-30 | Production approval comes before QA review. |
| INV-31 | No verification by zero humans; single-person automated checking only for the step types the US automated-equipment rule covers. |
| INV-32 | Labelling and printed-material reconciliation always runs; no waiver for Indian-made product. |
| INV-33 | Whole-batch reprocessing gets a new batch number linked to its parents; every reprocessing or recovery addition is linked by genealogy. |
| INV-34 | An MBR cannot become CURRENT unless intermediates have hold times, timers and yield checkpoints have limits and sources, and the IPC interval meets its rule. |
| INV-35 | The audit-trail review, manufacturer release and market dispositions are signed only by people outside the batch's involvement set. |
| INV-36 | Injectables: filter integrity tests before use and after use, with the backup and serial rules. |
| INV-37 | Injectables: a passing sterility test never overrides a process failure. |
| INV-38 | GMP decisions never read a projection; they read system-of-record tables, and external mirrors only within their freshness bound. |
| INV-39 | One market's disposition never changes another's, except that all need the manufacturer release RELEASED at that instant, and suspending it suspends the dependants. |
| INV-40 | Every GMP command from a shared device carries a fresh authentication of the person it is attributed to. |
| INV-41 | A failing evaluation never becomes passing without an approved invalidation record; its exception is closed only by disposition. |
| INV-42 | No shipment without a current manufacturer release or with an open post-release link; EU-destined lots only to the named importer in quarantine until certified. |
| INV-43 | A market disposition cannot become READY while its market-add evaluation has an unmet item. |
| INV-44 | Injectables: APS record arithmetic (filled = incubated + justified non-incubated + set-up units). |
| INV-45 | Injectables: container closure integrity testing rules (100 % CCI for small fusion-sealed containers; visual inspection is never a CCI method). |
| INV-46 | Deviation-to-batch links are insert-only; one ends only with an "assessed, not affected" record. |
| INV-47 | No policy loosening applies to a batch issued before the loosening's effective date. |
| INV-48 | At disposition, the audit-trail review's high-water mark covers every in-scope event, or a signed delta review exists. |

Where: `docs/outline/build-outline.md` (table of invariants); tests carry `[INV-xx]` in their names.

## Generic blocks and gates (G-01 to G-25)

A *block* is one configurable phase of a master record flow. A "gate" in this project means either a block that stops a
flow until a rule is met, or the release gate G-REL. The canonical list (aliases K-xx, KB-xx in the outline):

| Block | What it does |
|---|---|
| G-01 | Issuance and header (batch number, product, markets). |
| G-02 | Stage frame and summary (stage start, sign-off). |
| G-03 | Instruction and acknowledgement. |
| G-04 | Process parameter record. |
| G-05 | Observation capture. |
| G-06 | Automated equipment phase (press, coater; readings from simulators in Phase 3). |
| G-07 | Weighing and dispensing. |
| G-08 | Identification and charge-in of materials. |
| G-09 | Equipment status, cleaning, logbook. |
| G-10 | Room and line status, clearance. |
| G-11 | Environmental condition check. |
| G-12 | Sampling. |
| G-13 | IPC with readings and statistics. |
| G-14 | Calculation. |
| G-15 | Timer, hold time, transfer. |
| G-16 | Verification and witness. |
| G-17 | QA hold point (for example H-COAT, H-PACK). |
| G-18 | Exception and deviation link. |
| G-19 | Flow control, including replicate sections. |
| G-20 | Yield and reconciliation. |
| G-21 | Printed materials, coding, challenges, serialisation. |
| G-22 | Output containers, holds, split and merge. |
| G-23 | Returns, rejects, witnessed destruction. |
| G-24 | Reprocessing and rework gate. |
| G-25 | Sign-off, review, release and market disposition. |
| **G-REL** | The **release gate**: one computed checklist for a finished lot and market. Items are grouped (G1 to G11 core groups, `E.` edition items); every item must be green before the AP or market authority signs. See the [primer](01-pharma-primer.md). Item IDs look like `G3.NAME` or `E.NAME`. |

Where: the outline's section 6.6; [recipe-core](modules/recipe-core.md) for the generic guards,
[tablets-server](modules/tablets-server.md) for TB-xx blocks.

## State names that recur

| Group | Values | Where |
|---|---|---|
| Manufacturer release | `NOT_READY`, `READY`, `RELEASED`, `REJECTED`, `RELEASE_SUSPENDED`, `RECALLED`, `REJECTED_AFTER_RELEASE` | `ns/release.ts` |
| Market disposition | the manufacturer values plus `AWAITING_QP_CERTIFICATION`, `CERTIFIED`, `REJECTED_BY_QP`, `INELIGIBLE`, `REMOVED` | `ns/release.ts` |
| Batch | `ISSUED`, `IN_PROGRESS`, `ON_HOLD`, `EXECUTION_COMPLETE`, `ABORTED`, `CANCELLED` | `ns/batches.ts` |
| Step | `PENDING`, `ENABLED`, `IN_PROGRESS`, `ATTEMPT_HANDED_OVER`, `AWAITING_VERIFICATION`, `COMPLETED`, `NOT_APPLICABLE`, `SKIPPED` | `ns/execution.ts` |
| Deviation | `OPEN`, `UNDER_INVESTIGATION`, `IMPACT_ASSESSED`, `PENDING_CLOSURE`, `CLOSED`, `CANCELLED` | `ns/deviation.ts` |
| Container | `OPEN`, `CLOSED`, `HELD`, `SORTED`, `REJECTED`, `RELEASED_BY_QA` | `ns/containers.ts` |
| Exception | `OPEN`, `DISPOSITIONED` | `ns/execution.ts` |
| Stage sign-off | `NOT_STARTED`, `IN_PROGRESS`, `AWAITING_SIGN_OFF`, `SIGNED_OFF` | `ns/execution.ts` |
| Contingency form | `ISSUED`, `RETURNED`, `TRANSCRIBED`, `VERIFIED`, `VOIDED`, `MISSING` | `ns/archive.ts` |
| Licence | `DRAFT`, `APPROVED`, `SUSPENDED` | `ns/india.ts` |
| Record lock | `UNLOCKED`, `LOCKED`, `UNDER_AMENDMENT` | `ns/records-lock.ts` |
| Timer | `RUNNING`, `WARNING`, `BREACHED`, `MET`, `VOIDED` | `ns/execution.ts` |
| Device reading status | `OK`, `UNSTABLE`, `OVERLOAD`, `UNDERLOAD`, `OFFLINE`, `ERROR` | `ns/devices.ts` |
| Evidence export | `ASSEMBLED`, `CERTIFIED` | `ns/archive.ts` |
