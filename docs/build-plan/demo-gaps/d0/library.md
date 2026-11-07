# Library block refusals: inventory and basis (decision 0026)

Scope: every ERROR an author, QA approver or operator can hit with a library block. Sources read: `packages/recipe-core/src/library/{check-definition,check-use,integration,block-version}.ts`,
`blocks/generic/material.ts` (lotProblems, reused by library lot fields), `limits/nesting.ts`, SQL `packages/recipe-core/sql/1800, 1810, 1820, 1862, 1871, 1872`
(latest definition of each function), `apps/tablets-server/sql/1803, 1806` (latest `tab.library_smart_problem` is 1806), and
`apps/tablets-server/src/features/library/index.ts`.

Basis classes: **(a)** binding clause (all "per repo sources": the control YAML `sources` lines; official texts not consulted), **(b)** real technical need, **(c)** neither.
Paths are relative to `packages/recipe-core/src/library/` unless given in full.

## 1. Drafting a definition (checkBlockDefinition; server `draft` route refuses 422 with the first error's code)

| # | Code | File:line | Refuses | Cited | Class | Basis / note |
|---|---|---|---|---|---|---|
| 1 | LIB-CODE | check-definition.ts:121 | code not `^[A-Z][A-Z0-9-]{1,39}$` | PR-03 | b | identifier the registry type `LIB-<code>` and the DB (EBMR-LIB-003) key on |
| 2 | LIB-VERSION | :122 | version not a whole number >= 1 | PR-05 | a+b | PR-05 (211.100(a), EU Ch.4 4.3/4.5, Annex 11 s10, per repo): masters under version control; integer needed for ordering |
| 3 | LIB-TITLE | :123 | no title | PR-03 | b | the designer, palette and records need a name; also DB row column |
| 4 | LIB-CATEGORY | :124 | category not in PROCESS/COATING/TEST_IPC/TEST_RELEASE/CONTROL/PACKAGING | PR-03 | b | category drives default roles (integration.ts descriptorOf); list is coarse, does not block any dosage form |
| 5 | LIB-EDITION | :125 | edition not generic/tablets/injectables/substance | PR-03 | b | edition is data the DB checks (EBMR-LIB-023) |
| 6 | LIB-ROLES | :127 | roles empty or unknown | PR-03 | b | the validator's role vocabulary (significant step, IPC etc.) |
| 7 | LIB-NO-FIELDS | :130, :195 | no section, or sections with no field at all | PR-03 | c | Nothing requires a step to capture a value; a "read and confirm / sign" block is legitimate. Proposal: relax to allow a fieldless block whose role is INSTRUCTION or SIGN_OFF (the PERFORMED signature is the record); today the author must add a dummy YES_NO or use generic G-03. Low impact. |
| 8 | LIB-SECTION-ID | :144-145 | bad or duplicate section id | PR-03 | b | entry kind = section id; must be unique |
| 9 | LIB-SECTION-TITLE | :147 | section without title | PR-03 | a | PR-03 (211.186(b)(9), EU 4.17-4.18, per repo): instructions the operator follows must be complete; a nameless section is no instruction. Also usability. |
| 10 | LIB-FIELD-ID | :153, :203 | bad id, or id used twice (fields + inputs) | PR-03 | b | calculations and limits refer to ids |
| 11 | LIB-FIELD-RESERVED | :203 | id in kind/lots/equipment/computed/field/duration/balance | PR-03 | b | collides with entry members; `balance` triggers DB scale-weighing rules (S11) |
| 12 | LIB-FIELD-TYPE | :200 | unknown field type | PR-03 | b | engine cannot run it |
| 13 | LIB-FIELD-LABEL | :204 | field without a label | PR-03 | a | as #9: the operator must know what to record (211.186(b)(9)/211.188 complete record, per repo) |
| 14 | LIB-FIELD-UNIT | :207-210, :231, :235 | missing or invalid UCUM unit; timer not a time unit; weighing not a mass unit | PR-03 | b | unit conversion and limit comparison; a weighing goes to a balance (mass); volume dosing uses NUMBER (PROC-DISP-LIQUID exists) |
| 15 | LIB-CRITICAL-NO-LIMIT | :215 | CPP/IPC field (critical) with no limit slot | PR-03, PR-08 | a | 211.110(b) and 211.186(b)(9), EU 4.18(d)-(e) (per repo): in-process specifications/limits for critical steps. Supports exactly. |
| 16 | LIB-FIELD-DECIMALS | :220 | decimals outside 0-12 | PR-03 | c | Sanity bound, no clause; harmless. Proposal: keep as is (or widen if a real need appears); not worth changing. |
| 17 | LIB-CALC-REQUIRED | :226 | CALC field marked `required: false` | INV-25 | c | The flag is meaningless on a computed field; refusing it is tidiness, not safety (INV-25 is satisfied anyway: calc is never typed). Proposal: relax to a WARNING ("ignored") or strip the flag. |
| 18 | LIB-TIMER-REPEAT | :230 | timer in a repeating section | (PR-03) | b | the runtime keys timers by field id once per step (block-version.ts acceptTimer :555-567). Engine limit: a per-iteration timer (e.g. each FBD re-drying cycle) cannot be one block; workaround is an MBR loop around the block. See section 6. |
| 19 | LIB-FIELD-PATTERN | :243 | invalid regex | PR-03 | b | cannot run |
| 20 | LIB-FIELD-LENGTH | :246 | maxLength outside 1-4000 | PR-03 | c | Sanity bound, no clause. Proposal: keep (harmless) or drop the 4000 ceiling. |
| 21 | LIB-FIELD-EXPECTED | :249 | expected answer not boolean | PR-03 | b | type |
| 22 | LIB-CHOICE-OPTIONS | :253-255 | < 2 options, empty option, duplicate option | PR-03 | b | duplicates are ambiguous; a 1-option choice is a confirmation (YES_NO exists) |
| 23 | LIB-CHOICE-NOT-ALLOWED | :257-258 | not-allowed value not an option; every option not allowed | PR-03 | b | no answer could pass |
| 24 | LIB-EQUIPMENT-KIND | :262 | kind not EQUIPMENT/ROOM/LINE/BALANCE/INSTRUMENT | PR-03 | b | register lookup by kind; class is free text so no dosage form is blocked |
| 25 | LIB-CONTAINER-ACTION | :265 | container action not REGISTER/CONSUME | PR-03 | b | cannot run |
| 26 | LIB-TEST-NO-LIMIT | :270 | TEST_RESULT with no statistic | PR-03, PR-29 | a | 211.110(a)-(b), 211.160(b) (per repo): tests have acceptance criteria. Descriptive tests use YES_NO/CHOICE, so not blocking. |
| 27 | LIB-TEST-STATISTIC | :272-273 | unknown or duplicate statistic | PR-03 | b | each statistic has one limit slot |
| 28 | LIB-INPUT-KIND / -ID / -LABEL / -UNIT | :292, :295-296, :298, :300 | bad external input | DI-33 | b | calculation inputs must be typed and unique |
| 29 | LIB-INPUT-LOT | :303 | LOT_ASSAY input naming no lot/weighing field | DI-33 | b | value read must exist |
| 30 | LIB-SHOW-WHEN | :320-324 | condition on unknown, later, other-section or non-yes/no/choice field, or invalid answer | PR-03 | b | the runtime reads the condition from the one entry being recorded (block-version.ts `shown`); a cross-section condition would never fire |
| 31 | LIB-CALC-EXPRESSION | :332, :361 | no formula; type/unit errors; reads a later or unknown field | PR-03, DI-33 | b | value read before written, no cycles, units convert (211.68(b)/211.194(a)(5) check of calculations, per repo, supports the "checked formula" part) |
| 32 | LIB-CALC-TIMER, LIB-CALC-DATE-TIME | :353 | calc reads a timer or a typed date/time | PR-03, DI-33 | b | runtime hands neither to a calculation, so every entry would fail. Limits expressiveness: an elapsed time between two typed instants cannot be computed in a block (use the timer or a master time constraint) |
| 33 | LIB-CALC-CONDITIONAL | :360 | calc reads a conditional field under another condition | DI-33 | b | input may never exist |
| 34 | LIB-REPEAT-KIND | :374 | unknown repeat | PR-03 | b | cannot run |
| 35 | LIB-REPEAT-UNTIL | :172, :177-178 | UNTIL_PASS endpoint missing, conditional, or with no limit/expected answer | PR-03, INV-20 | b | loop must be able to end (INV-20 as cited is about time limits; the real basis is termination) |
| 36 | LIB-SLOT-NAME / LIB-SLOT-DUPLICATE | :184, :188 | bad slot name; slot used twice | PR-03 | b | formulation fills each slot once |
| 37 | LIB-REFERENCE-SLOT / -BOUND / -UNIT | :388, :392-396, :398 | reference limit for no slot; no bound; not decimal; low > high; unit does not convert | PR-08 | b | consistency, unit conversion |
| 38 | LIB-REFERENCE-NOTE | :391 | reference limit without its source note | IN-33 | a | IN-33 (Schedule M PQS resources, IP references, 17.3.2, per repo): limits state their pharmacopoeial source and edition. Supports. |
| 39 | LIB-SIGNATURE-PERFORMED | :407 | no PERFORMED signature | DI-35, ST-33 | a | 211.188(b)(11), EU 4.20 (per repo, via DI-35): identity of who performed each significant step. Supports. Citation defect: ST-33 is "APS failure consequences" (aseptic simulation), unrelated; should be PR-14/DI-35. |
| 40 | LIB-SIGNATURE-MEANING | :410-411 | unknown meaning; same meaning listed twice | DI-35 | b / c | unknown meaning: b. Duplicate meaning: c (no clause forbids two CHECKED signatures by different roles, e.g. production supervisor and IPQA). Proposal: allow a repeated meaning when the roles differ. |
| 41 | LIB-SIGNATURE-ROLE | :413 | signature without a role | DI-35 | a | Part 11 11.10(g) authority checks, 211.188(b)(11) (per repo): who may sign must be defined |
| 42 | LIB-INVALID (fallback) / server 422 | apps/tablets-server/src/features/library/index.ts:115 | wrapper: draft refused while any ERROR above exists | - | - | not a separate rule |

## 2. Database at draft, approval, retirement (recipe-core 1800, 1871/1872; IAM)

| # | Code | File:line | Refuses | Cited | Class | Basis / note |
|---|---|---|---|---|---|---|
| 43 | IAM (require_permission MBR.AUTHOR / MBR.APPROVE; assert_not_administrator) | sql/1800:153-154, 182-183, 215-216; 1820:12-16 | drafting without MBR.AUTHOR, approving/retiring without MBR.APPROVE, any act by the administrator | - | a | Part 11 11.10(d),(g) limited access and authority checks; segregation of admin from GMP acts (FDA DI Q&A, Annex 11 s12, per repo) |
| 44 | EBMR-LIB-001 | sql/1800_library_blocks.sql:67, :71 | row code/version/title/category differ from definition; no section or no signature list | PR-03 | b | row integrity |
| 45 | EBMR-LIB-002 | :74 | content_hash not canonical hash | PR-05 | b | hash integrity (what QA approves is what runs) |
| 46 | EBMR-LIB-003 | :156 | code/version shape | PR-03 | b | as #1 |
| 47 | EBMR-LIB-004 | :163 | version is not max+1 | PR-05 | a+b | PR-05 (Ch.4 4.3/4.5, 211.100(a), per repo): each change is a new controlled version; sequential order is technical |
| 48 | EBMR-LIB-023 | sql/1871_library_block_edition.sql:38 (+ check constraint; list from 1872:23) | unknown edition | PR-05 | b | data integrity |
| 49 | EBMR-LIB-005 | 1800:185, :218 | unknown block id | - | b | |
| 50 | EBMR-LIB-006 | :189 | approving a block that is not DRAFT | - | b | state machine |
| 51 | EBMR-LIB-007 | :192 | approver is the author | DI-35, 0026 | a | 211.100(a)/211.186(a) (per repo): master instructions reviewed and approved by QA, master record independently checked by a second person. Supports. |
| 52 | EBMR-LIB-007 | :197, :200 | signature invalid/not in force; signer is not the actor | DI-35 | a | Part 11 11.50, 11.70, 11.100, 11.200 (per repo): signature linked to the signer and the record |
| 53 | EBMR-LIB-008 | :221 | retirement without reason | DI-22 | a | Annex 11 s9 and 11.10(e) (per repo): reason for a GMP-relevant change. Supports (retirement is a change of status). |
| 54 | EBMR-LIB-008 | :225 | retiring a block that is not APPROVED | - | b | state machine |

## 3. Using a block in a master (checkBlockUse via engine checkConfig; snapshots; DB at master approval and batch issue)

| # | Code | File:line | Refuses | Cited | Class | Basis / note |
|---|---|---|---|---|---|---|
| 55 | LIB-USE-BLOCK | check-use.ts:33 | use checked against another code@version | PR-03 | b | |
| 56 | LIB-USE-HASH | :44 | pinned hash differs from the definition | PR-05, DI-10 | a+b | 211.188(a) accurate reproduction of the approved master; DI-10 version in force (per repo); hash integrity |
| 57 | LIB-USE-UNKNOWN-SLOT | :48 | value for a slot the block does not have | PR-03 | b | |
| 58 | LIB-USE-MARKET-RULE | :55 | market rule on a slot with no limits | PR-08 | b | a market rule binds limits |
| 59 | LIB-USE-BOM-LINE | :63-64 | formula-line slot empty, or not a line of the master's BOM | DI-33, PR-18, IN-23, INV-25 | a+b | 211.186(b)(4)-(5) components, 211.101 (per repo); the lot field would have no material to check. Multi-stage API: an in-house intermediate must be a BOM line of the next stage's master (normal practice). |
| 60 | LIB-USE-STEP-VALUE | :69 | earlier-step value slot not named | DI-33 | b | value read before written |
| 61 | LIB-USE-LIMIT-MISSING | :76 | required (critical/IPC/loop endpoint/test statistic) limit not given | PR-03, PR-08 | a | 211.110(b), 211.186(b)(9), EU 4.18(d)-(e) (per repo). Supports. |
| 62 | LIB-USE-TARGET (target without limits) | :77 | a target on a slot with no limits | PR-08 | c | No clause requires limits for a non-critical set point; a target alone ("aim 45 rpm") is a normal instruction. Proposal: relax to allow a target without limits on a non-required slot (no judgement, recorded as instruction). |
| 63 | LIB-USE-TARGET (bad value / outside limits) | :135, :142 | target not decimal, or outside its own innermost limit | PR-08 | b | consistency |
| 64 | LIB-USE-EQUIPMENT-CLASS | :88 | equipment class not named | PR-03 | a | 211.186(b)(9)/EU 4.18(b) (per repo): instructions name the principal equipment |
| 65 | LIB-USE-COUNT | :91-92 | count missing or not a whole number 1-9,999,999 as text | PR-03 | b | (no JS number for GMP values; count drives repeats). Side effect: a COUNT section can never be 0, see #95 |
| 66 | LIB-USE-INTERVAL | :97-99 | interval missing, <= 0, or not a time | PR-29 | b | cannot schedule; frequency itself is a 211.110(a) item (per repo) |
| 67 | LIB-USE-LIMIT-UNIT (invalid unit) | :105 | limit unit not a unit | PR-08 | b | |
| 68 | LIB-USE-LIMIT-UNIT (other unit) | :109 | limit written in a convertible but different unit from the field | PR-08 | b | DB compares in one unit (1810 header). Design simplification, not a clause; the UI could convert on save. Not blocking. |
| 69 | LIB-USE-LIMIT-NO_RANGES / DUPLICATE_TIER / NO_BOUND / EMPTY_RANGE / NOT_NESTED / NOT_NESTED_AFTER_ROUNDING / BAD_VALUE | check-use.ts:115 (from limits/nesting.ts:64-118) | malformed tiered limit | PR-08 | b | logical consistency of the tier model (alert inside action inside registered/validated) |
| 70 | LIB-USE-POINTS | :170, :174, :179 | points for a non-profile test; profile with no point; duplicate/empty point id | PR-03 | b | |
| 71 | LIB-SNAPSHOT-DUPLICATE | integration.ts:33 | code@version carried twice | PR-05 | b | |
| 72 | ENG-DEF-LIBRARY-BLOCK | integration.ts:83-86 | any definition error in a carried snapshot (re-runs #1-41) | as #1-41 | b | wrapper; no batch on a malformed snapshot |
| 73 | EBMR-LIB-021 | sql/1810_library_execution.sql:374 (library_snapshot_problem :331-364) | master approval: snapshot not in library, hash differs, still DRAFT, RETIRED, LIB step with no snapshot, pinned hash not the snapshot's | PR-05, 0026 | a | 211.100(a), 211.186(a) (per repo): only QA-approved, current instructions in an approved master. Supports. |
| 74 | EBMR-LIB-022 | 1810:389 | batch issue: same, but a retired version still serves masters approved on it | PR-05 | a | 211.188(a) (per repo): batch record reproduces the approved master |
| 75 | EBMR-LIB-024 | sql/1871_library_block_edition.sql:73 | master approval with a block of another edition (not generic) | PR-05, ADR 0001 amendment | c | No clause; ADR convention. Every seed block except injectables (17) and one substance block has no `edition` member and so is `tablets`: an injectables or API (substance) master cannot use the seed's line clearance, room check, sifting, milling, FBD/tray drying, blending, hold, transfer or packaging blocks without re-drafting a copy. Proposal: keep the check but re-tag edition-neutral seed blocks `generic` (controls, PROC-SIFT/MILL/FBD/TRAY-DRY/BLEND/HOLD/TRANSFER, packaging), or relax to allow a tablets block in another edition when QA's approval names that edition. |
| 76 | (web filter) | apps/tablets-web/src/features/designer/components/LibraryBlocks.tsx:43 | picker lists only APPROVED blocks of the master's edition or generic | - | b/c | follows #75 |

## 4. Using a block in a batch (engine handler, block-version.ts; DB triggers)

| # | Code | File:line | Refuses | Cited | Class | Basis / note |
|---|---|---|---|---|---|---|
| 77 | LIB-ENTRY-KIND | block-version.ts:616 | entry for a section the block lacks | PR-03 | b | |
| 78 | LIB-SECTION-ONCE | :399 | second entry of a ONCE section | PR-03 | a+b | DI-22 (11.10(e), Annex 11 s9, per repo): change by correction with reason, never by a second silent record |
| 79 | LIB-SECTION-COUNT | :400 | more entries than the count | PR-03 | b | |
| 80 | LIB-SECTION-PASSED | :403 | repeat after the loop passed | INV-20 | b | loop semantics (also guards against re-testing after a pass) |
| 81 | LIB-SECTION-MAX | :405 | repeat beyond the maximum | INV-20 | a+b | the formulation's validated maximum; a further attempt must go through the exception (211.192 investigation, per repo) |
| 82 | LIB-ENTRY-HIDDEN | :414 | value for a field its condition hides | PR-03 | b | |
| 83 | LIB-ENTRY-REQUIRED | :418 | required field empty | PR-03 | a | 211.188(b) complete record of each step (per repo) |
| 84 | LIB-ENTRY-POINTS / LIB-ENTRY-REPLICATES | :427, :429 | readings not for exactly the points; wrong number of replicates | PR-03, PR-29 | a | 211.194(a), 211.110 sample size (per repo): all results of the planned test |
| 85 | LIB-LOT-FACTS, LIB-LOT-BOM-LINE | :442, :449 | lot facts missing/forged; formula line not on BOM | PR-18, IN-23, INV-25 | a+b | 211.84/211.86/211.101 (per repo) |
| 86 | G07-WRONG-MATERIAL / G07-LOT-STATUS / G07-LOT-EXPIRED / G07-LOT-RETEST / G07-LOT-IDENTITY | src/blocks/generic/material.ts:31-39 | wrong material, not released, expired, past retest, no identity test for US/EU | PR-18, IN-23, IN-24, PR-21, PR-46 | a | 211.80-211.89 (released, identity, retest), Schedule M 14.14-14.20 (per repo). Supports. |
| 87 | LIB-EQUIPMENT-FACTS / -CLASS / -FITNESS | :457-459 | equipment not in register, wrong class, not qualified/calibrated | PR-19, IN-11 | a | 211.63/211.67/211.68 suitable, cleaned, calibrated equipment (not in the repo's cited sources: PR-19 is dispensing, IN-11 is certified evidence export; citation defect, likely should name an equipment-status control) |
| 88 | LIB-CALC-FAILED | :475-476 | calculation cannot be evaluated or gives no number | DI-33 | b | |
| 89 | LIB-TIMER-STARTED / -NOT-STARTED / -STOPPED / -UNIT | :555-557, :567 | timer double start, stop without start, double stop, non-time unit | PR-30 | b | |
| 90 | LIB-PERFORM-NOT-PASSED | :638 | completing a loop that has not passed and is not at its maximum | INV-20 | a | 211.110 (per repo): an IPC that fails is not silently passed over |
| 91 | LIB-PERFORM-TIMER | :643 | completing with a required timer still running | PR-30 | a | 211.111 time limits (per repo) |
| 92 | EBMR-LIB-020 | sql/1862_library_limits_judgement.sql:411 (library_limits_problem, latest, :114-394) | row whose value breaches a limit without the matching LIB_LIMIT_BREACH (tier, severity, deviation); a breach exception with no breach; stray LIB_REPEAT_LIMIT_REACHED; limit not in field unit | PR-08 | a | 211.110(b)/211.192 (per repo): out-of-limit results are recorded and investigated. Supports. |
| 93 | EBMR-LIB-020 (timer) | 1862:~176-197 | timer stop without start; duration not from trusted start/stop | PR-30 | a | 11.10(e) secure time-stamps; 211.111 (per repo) |
| 94 | EBMR-LIB-020 (calc) | 1862:~218-225 | calculated field without its evaluation record, or with one its condition hides | DI-33, O-9 | a | 211.194(a)(5), Annex 11 s4.7 (per repo): calculations reconstructable |
| 95 | EBMR-LIB-020 (loop) | 1862:~241-256 | repeat beyond max; repeat after pass; last repeat without pass and without exception | INV-20 | a+b | as #80/#81 |
| 96 | EBMR-LIB-020 (snapshot) | 1862:~160 | entry of a block the master does not carry | PR-05 | b | |
| 97 | EBMR-TAB-480 | apps/tablets-server/sql/1803_library_smart_fields.sql:110 (problems from latest tab.library_smart_problem, 1806_library_lot_bom_line.sql:64-101) | lot not in register / forged facts / not usable / BOM line missing; equipment not in register / forged / wrong class / unfit; hand-keyed weighing without second person | PR-18, PR-19, IN-23, DI-30, PR-14 | a | 211.84, 211.101(c)-(d) second-person verification of weighing, 211.68 (per repo). Supports. |
| 98 | LIB-PERFORM-SECTION | block-version.ts:632-633 | completing the step while any section has no entry (COUNT: fewer than count) | PR-03 | c | `SectionDef` has no optional flag and a count cannot be 0 (#65), so every section must happen at least once. No clause requires an event that did not occur to be recorded; 211.188 asks for a record of what was done. Event-type sections (extra binder/fluid addition, alarm acknowledgement, re-sieving, rework, filter bag change, reconstitution check only when used) cannot be expressed as optional. Proposal: add a section-level `required: false` (or a section `showWhen` on an earlier section's answer) and enforce "at least once" only for required sections. |
| 99 | LIB-NOT-FOUND | apps/tablets-server/src/features/library/index.ts:129, :162 | stored block cannot be read back | - | b | stale state |

Not a refusal but worth knowing: `loadCatalogue` (index.ts:137-152) silently skips seed items whose definition has errors or whose code is already held.

## 5. Warnings (not refusals)

- LIB-REPEAT-NO-MAX (check-definition.ts:376): UNTIL_PASS with no maximum-repeats slot; record why none is needed (INV-20).
- LIB-USE-LOOSER-THAN-REFERENCE (check-use.ts:157): product limit looser than the block's reference limit; a written justification clears it (PR-08, IN-33; O-5).
- LIB-CALC-EXPRESSION with severity WARNING (check-definition.ts:361): any warning the expression checker returns passes through with its own severity.

## 6. Real formulations

- Bilayer tablet: expressible (PROC-COMPRESS-BILAYER, PROC-COMPRESS-TRILAYER in seed; a block may be used in several steps, slots are per use).
- Capsule pellets: expressible (multiparticulates.ts, capsule-fill.ts; tablets edition).
- Injectable powder + solvent: expressible within the injectables edition; but #75 forces copies of generic controls (line clearance, room check) because the seed tags them `tablets`. #98 blocks an "only if used" section (e.g. a reconstitution check that applies to one presentation) inside one block.
- API multi-stage: #75 is the main obstacle (substance master cannot use the seed's sift/mill/dry/blend/hold/transfer blocks); intermediates must be BOM lines of the next stage's master (#59, normal practice).
- General engine limits (b, not regulatory): #18 no timer inside a repeating section (per-cycle drying/coating timers need an MBR loop around the block); #30 conditions only within one section; #32 no calculation over timers or typed date/times.

## 7. TB-04, TB-05, TB-18 "existing masters only"

Not library blocks and not a bug: intended. TB-01 to TB-24 are the code-built tablet blocks. Decision 0026 point O-6
(`docs/decisions/0026-dynamic-library-and-freeze.md:44`): they keep running and stay in CI but "leave the designer palette after S11".
Implemented in `apps/tablets-server/src/features/designer/palette.ts:26-28` (`retiredFromPalette = /^TB-\d{2}$/`, `RETIRED_BADGE =
'existing masters only (library replaces it)'`) and :110-111 (`insertable: !retiredFromPalette(b.type)`); documented in
`packages/api-contract/src/ns/designer.ts:144-149`; the web palette shows only insertable blocks
(`apps/tablets-web/src/features/designer/components/ProcedureTable.tsx:145`). The string does not appear in the web code or the
library seed. Their library replacements are seed blocks PROC-RMG (wet granulation, for TB-04), PROC-FBD (fluid-bed drying, for TB-05)
and the pan-coat/COAT-* blocks in `seed/coating.ts` (for TB-18), inserted through "Add library block"
(`LibraryBlocks.tsx`, which lists APPROVED library blocks of the master's edition). One residue: the designer's "Add a coating layer"
(`packages/recipe-core/src/flow/coating-layer.ts`) still builds TB-18 steps, but only by copying an existing TB-18 step of the master,
which is consistent with "existing masters only".
