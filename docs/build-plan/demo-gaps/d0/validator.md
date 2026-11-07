# Master-record validator: inventory of refusals (ERROR findings)

Scope: `packages/recipe-core/src/validator/rules-{structure,content,data,time,market}.ts` (48 `defineRule` calls; the six
GRAPH-* rules are made in a loop at rules-structure.ts:316-345) plus the one framework error in validate.ts. No other
package defines validator rules (grep for `defineRule(` and `ValidationRule` outside the validator: none).
Warnings only, so not listed: GMP-WITNESS-NO-ATTACHMENT, DATA-WEIGHED-UNITS, TIME-NEVER-APPLIES, the "unused" warnings of
DATA-SINGLE-WRITER and GMP-ACCEPTANCE-SCHEMES, the undecidable-guards warning of DATA-GUARDS, TIME-CONSISTENT "possibly".

Caveat: the clause basis comes from the repo's paraphrases (`compliance/controls/*.yaml` `sources`, and
`compliance/requirements/requirements.jsonl`); I did not have the official texts. Every (a) is "per repo sources" unless
it says otherwise. Classes: (a) a binding clause requires it; (b) the engine or record integrity needs it; (c) neither
(internal convention, design taste, ISA-88 form, or stricter than the clause).

INV-xx ids are outline invariants (build-outline.md section 9 table, lines 491-506), not control files. They are
internal design commitments, so citing one gives no regulatory basis by itself.

## Structure (rules-structure.ts)

| Rule | file:line | Refuses | Controls | Class | Basis / note | Proposal |
|---|---|---|---|---|---|---|
| FLOW-ID-UNIQUE | rules-structure.ts:20 | duplicate node, data, BOM, library, branch ids; an id used by an input and a parameter (or a calculation) at once | DI-34 | (b) | Ids key the graph, the numbering, the state and the SQL `ids` map (sql 0304:81-84, 0307:90-92 refuse duplicates too) | keep |
| FLOW-LEVELS (1) phase placement | rules-structure.ts:74-89 | a **phase directly in a stage** (not in an operation) | DI-34 | **(c)** | DI-34 sources (11.10(f), 211.100(b), EU 4.20(h), Annex 11) are about enforcing step order. None asks for an operation level. The only basis is ADR 0004 decision 1 (the ISA-88 tree). The engine does not need it (see the FLOW-LEVELS section below) | **relax**: `phase: ['STAGE','OPERATION']`; also let an OPERATION-level library element be called in a stage (expand.ts:131) |
| FLOW-LEVELS (2) phase/operation outside a stage; stage inside a stage | rules-structure.ts:74-89 | a phase or operation directly in the procedure; a stage inside a stage or an operation | DI-34 | (b) | A step needs its stage: the stage carries the room/line/equipment binding (DATA-REFERENCES needs the stage to bind each equipment ref), the sign-off frame (advance.ts:250-258) and the stage summary (stage-summary.ts:33). A nested stage would leave the binding and sign-off frames undefined. Untested, so keep | keep |
| FLOW-LEVELS (3) empty stage/operation | rules-structure.ts:90-92 | a stage or operation with no phase, hold point or library call | DI-34 | stage (b); operation **(c)** | An empty stage still needs a sign-off with nothing to sum up. An empty operation is harmless: compile.ts:84-86 joins open to close | operation: make it a warning |
| FLOW-LEVELS (4) no stage | rules-structure.ts:94-95 | a procedure with no stage | DI-34 | (b), partly (a) | Without a stage there is nowhere to bind the processing location and the principal equipment. Clause: EU Ch.4 4.18(a), Schedule M 17.3.6 (processing location and principal equipment), per repo sources (DI-34 does not cite them; PR-03 cites 4.18) | keep |
| FLOW-CONSTRUCTS | rules-structure.ts:99 | empty sequence; parallel with <2 branches or an empty branch; alternative with <2 branches or >1 empty branch; empty loop/replicate; hold point with no disposition | DI-34 | (b), one part (c) | A hold point with no disposition can never be released. An alternative needs a real choice. An empty loop or replicate would loop over nothing. **A one-branch parallel** is just a sequence and does no harm | parallel <2 branches: make it a warning |
| FLOW-LIBRARY | rules-structure.ts:134 | library-expansion problems: missing or unpinned element, recursion, depth, wrong level, unbound symbols | DI-34, DI-04 | (b); version pinning (a) | DI-04 / EU Ch.4 4.3: approved and effective versions only, per repo sources. LIB_LEVEL (expand.ts:131) carries the same ISA-88 rule as FLOW-LEVELS(1) | relax LIB_LEVEL together with FLOW-LEVELS(1) |
| FLOW-BLOCKS | rules-structure.ts:138 | block type not registered, retired version, not allowed as a step, wrong edition | DI-04 | (b) | The engine has no handler for these | keep |
| FLOW-LOOPS (bounds/data) | rules-structure.ts:150 | no valid maxIterations; bad or zero maxDuration; exit endpoint not declared; endpoint not recorded inside the loop; exit condition does not read the endpoint; nested loops on the same endpoint | DI-34, INV-19 | (b) | The loop must terminate and must be able to see a new value. A nested loop on the same endpoint is refused by the database (recipe-core 0303/0305, per the code comment) | keep |
| FLOW-LOOPS (test endpoint) | rules-structure.ts:166-176, 210-215 | a loop that repeats until an acceptance or release test passes (directly or through a calculation) | DI-34, INV-19 | (a) | Testing into compliance; reprocessing only by an authorised procedure. US DI Q&A Q13 (in the US-DI-10 row), EU Ch.5 5.67, Schedule M 14.32-14.34, per repo sources. DI-34 `sources` do **not** cite these; the basis is in the requirements file, not in the cited control | keep; cite the right control (e.g. PR-47/IN-19 per ADR 0004) |
| FLOW-REPLICATES | rules-structure.ts:231 | min count > max count | DI-34, INV-19 | (b) | Contradiction | keep |
| FLOW-DECISIONS | rules-structure.ts:241 | DATA mode: >1 otherwise, variant values, guard plus otherwise, no guard; operator choice: no roles, a branch with a condition; ISSUE variant: undeclared variant, branch with no value or with an unknown or duplicate value, a variant value no branch covers | DI-34 | (b) | The branch must be decidable exactly one way. Without a role nobody may choose | keep |
| FLOW-ROLES | rules-structure.ts:293 | a role outside the installation's engine roles; fails closed when no vocabulary is supplied | INV-26, PR-14, PR-45 | (b) | Nobody could ever sign the step. The database refuses it too (0324) | keep |
| GRAPH-START-END, -REACHABLE, -TERMINATES, -DECLARED-CYCLES, -MATCHED, -BOUNDARIES | rules-structure.ts:316-345 (graph-checks.ts:145-306) | not exactly one start and end; unreachable step; a step from which the end cannot be reached; undeclared cycle or bad back edge; unmatched split/join, wrong degree or join rule, duplicate graph id, dangling edge; a back edge crossing a region | DI-34 | (b) | The token game must be well formed and terminate. 11.10(f) sequencing presupposes it | keep |

## Data (rules-data.ts)

| Rule | file:line | Refuses | Controls | Class | Basis / note | Proposal |
|---|---|---|---|---|---|---|
| DATA-REFERENCES | rules-data.ts:31 | records/computes/reads/consumes/produces/uses an undeclared id; equipment the stage does not bind; unknown yield checkpoint or scheme; a reference not in the pinned list; a time constraint naming a missing step; a risk-reduction subject that is no step or value; golden-case ids | PR-03, DI-04 | (b) | The referenced thing must exist | keep |
| DATA-WRITTEN-BEFORE-READ | rules-data.ts:92 | a value read (by a step, calculation, guard, loop exit, replicate count or PAT criterion) before it is written on every path | DI-34, DI-04 | (b) | Value written before read | keep |
| DATA-SINGLE-WRITER | rules-data.ts:128 | a header/master-data input recorded by a step; two writers of one value that can run on the same path | DI-04 | (b) | One original per value (no silent overwrite: ALCOA "original"). Corrections go through the correction path | keep |
| DATA-EXPRESSIONS | rules-data.ts:156 | parse, type or unit errors; unbound library symbols; a calculation output that does not match its declared type, unit or tag; non-boolean conditions; a replicate count that is not a count | DI-04, DI-33 | (b) | The engine must be able to evaluate it. DI-33: validated calculation logic | keep |
| DATA-CALC-CYCLES | rules-data.ts:213 | calculations that depend on each other in a cycle | DI-04, DI-33 | (b) | They could never be computed | keep |
| DATA-GUARDS (cover/overlap) | rules-data.ts:283-284 | a data case no branch covers; two branches true at once | DI-34 | (b) | The batch would stall, or the choice would be ambiguous | keep |
| DATA-GUARDS (dead) | rules-data.ts:285 | a branch whose condition can never be true | DI-34 | **(c)** | Harmless to execution. Dead content is a quality concern, not a refusal reason | make it a warning (needs a justification) |
| DATA-PARALLEL (writes/equipment) | rules-data.ts:292 | parallel branches writing the same value or using the same PROCESS equipment; concurrent replicate instances on process equipment | DI-34 | (b) | Two writers racing; physically impossible use of one machine | keep |
| DATA-PARALLEL (BOM) | rules-data.ts:322 | two parallel branches consuming the same BOM line | DI-34 | (c)? | Splitting one component into portions dispensed in parallel is a normal practice. No clause forbids it. I did not check whether the engine or the database can count the line twice (not verified) | check the engine; if it copes, refuse only when the portions do not add up |
| DATA-UNITS | rules-data.ts:339 | an invalid unit; limits in another dimension; tablet hardness in a pressure unit or with non-force limits | PR-08, PR-03 | (b) | Limits must be comparable. Hardness is a force (outline L-39) | keep |

## Time (rules-time.ts)

| Rule | file:line | Refuses | Controls | Class | Basis / note | Proposal |
|---|---|---|---|---|---|---|
| TIME-BOUNDS | rules-time.ts:24 | no min and no max; non-time unit; non-microsecond or negative value; max of zero; min > max; warning time not below the max; same from/to event; zero or invalid hold time | INV-20, DI-34 | (b) | Must be computable and non-contradictory | keep |
| TIME-MIN-AT-ARRIVAL | rules-time.ts:119 | a minimum ending at a START the engine records by itself on token arrival (stage, operation, parallel, alternative, loop, replicate, hold point) | INV-20, PR-30 | (b) | The engine could not hold the event back, so the minimum would be broken silently (engine advance.ts afterFire) | keep |
| TIME-CONSISTENT | rules-time.ts:174 | time constraints (with hold times and loop maxima) that contradict each other | INV-20, DI-34 | (b) | They could not all be met | keep |

## Content (rules-content.ts)

| Rule | file:line | Refuses | Controls | Class | Basis / note | Proposal |
|---|---|---|---|---|---|---|
| GMP-HEADER (market, batch size) | rules-content.ts:45-50 | India missing from the market set; a market listed twice; no approved batch size | PR-03, INV-28 | (a); duplicate (b) | India: the Drugs Rules licence, so Schedule M always applies (IN-52; project rule). Batch size: 211.186(a) and EU 4.17(b) ask for a master per batch size; Schedule M 17.3.6 (per repo sources; PR-03 sources cite 211.186(b) and 4.17) | keep |
| GMP-HEADER (variants) | rules-content.ts:51-54 | a variant with <2 values or a repeated value | PR-03, INV-28 | (b) | A one-value variant decides nothing | keep (could be a warning) |
| GMP-TYPED-FIELDS (shape) | rules-content.ts:58-67 | decimal/count with no precision; decimal with no unit; a unit on a non-decimal; category with <2 distinct values | PR-03 | (b), partly (a) | Needed for limit evaluation and plausibility. 211.186(b)(4) asks for amounts in one weight system; DI-30 asks for plausibility checks (type, range, unit), per repo sources | keep |
| GMP-TYPED-FIELDS (critical TEXT) | rules-content.ts:68 | a CRITICAL parameter of free-text type | PR-03 | **(c)** | No clause bans free text. PR-03 `behaviour` says "typed field", which is the repo's own reading. Critical transcriptions such as a lot number or a label text are naturally text | relax: allow critical TEXT with a format/pattern or expected-value check plus the DI-30 accuracy check |
| GMP-CRITICAL-PARAMETERS | rules-content.ts:75 | a numeric IPC or critical CPP/endpoint/test with no limits; a critical manual entry with no accuracy check | PR-03, PR-08, DI-30 | (a) | 211.110(b) in-process specifications; EU 4.18(e) "in-process controls with their limits"; Schedule M 17.3.6. Accuracy check: Annex 11 section 6 (an additional check on critical data entered by hand), 211.68(b). Supported by the cited `sources` | keep |
| GMP-LIMITS | rules-content.ts:122 | tiers not nested (exactly or after rounding); a registered limit not citing the registration or pharmacopoeia; a validated range without a validation report; a pharmacopoeia source with no edition; a source-kind/reference-kind mismatch | PR-08, PR-03 | (b), partly (a) | Nesting: logic integrity. Registered limits come from the dossier (PR-08: Annex 16 section 3; 211.110(b)), per repo sources. The kind matching is the repo's own taxonomy: (b) consistency | keep |
| GMP-SIGNIFICANT-STEPS (performer/checker) | rules-content.ts:130 | a step with no performer; a significant step or critical hand entry with no checker; an automated step with no human checker | PR-03, IN-02 | (a) | 211.188(b)(11) (who performed and who supervised or checked each significant step); 211.101(c)-(d), 211.103; EU 4.20(c) ("where appropriate"); 211.68(c) (automated: one person checks the equipment). PR-03 sources cover 211.188 only indirectly; PR-14 is the matching control, but the rule cites PR-03/IN-02 | keep; cite PR-14 |
| GMP-SIGNIFICANT-STEPS (reductions) | rules-content.ts:139-148 | one-verifier automated mode, or a line clearance without a second person, with no declared risk-based reduction | PR-03, IN-02 | (a) one-verifier; **partly (c)** clearance | One verifier: 211.68(c) allows it under conditions; IN-02 (Schedule M QRM) gives the rationale. Clearance: 211.130(e), EU 5.50 and Schedule M 18.x ask for a documented check, not two persons. Schedule M Part VIII 7.x asks for an "independent, recorded check" on strip/blister lines only | clearance: ask for a second person only where the edition or line rule requires it (packaging, Part VIII 7), otherwise one person |
| GMP-WITNESS | rules-content.ts:159 | a critical hand entry with no device/scan/photo evidence, checked as VERIFIED (a later review) rather than WITNESSED | PR-03, DI-30 | (a)/(b) | The clauses say "checked" (211.188(b)(11)) or ask for an accuracy check (Annex 11 section 6). A later review of a typed value with no evidence cannot check its accuracy, so this follows from the check's purpose. Stricter than the clause wording | keep |
| GMP-CHECK-PERMISSION | rules-content.ts:251 | a check role that no installation role holding STEP.WITNESS/STEP.VERIFY carries | PR-14, DI-35, INV-26 | (b) | The check could never be given; the run would stop | keep |
| GMP-STAGE-CLEARANCE (presence) | rules-content.ts:287-302 | a bound or material stage with no clearance step | PR-03 | **partly (c)** | EU 4.18(c) / Schedule M 17.3.6 / SM-18: a check that equipment and work station are clear **before processing starts**; 211.188(b)(6) packaging area checks; EU 5.50 before packaging. The clause is per processing operation or area. The rule asks for a clearance in **every** stage, even when the next stage continues in the same room on the same batch | relax: one clearance per room/line entry, or let a stage declare that it continues the clearance of stage X |
| GMP-STAGE-CLEARANCE (order) | rules-content.ts:303-307 | a step that can run before its stage's clearance | PR-03 | (a) | "Before any processing" (same clauses) | keep |
| GMP-STAGE-YIELD | rules-content.ts:312 | a MATERIAL stage that can end without a yield/reconciliation step; material-processing steps after the yield step | PR-03, PR-31 | **partly (c)** | 211.103 "each appropriate phase"; 211.186(b)(6)-(7); EU 4.17(d) "relevant intermediate yields where applicable"; Schedule M 17.3.6 "pertinent intermediate yields". The clauses leave the choice of phase to the firm; every material stage is stricter. PR-03 `behaviour` itself allows "not applicable" with a signed justification for "where applicable" items. "Nothing after the yield" is design taste | relax: a stage may be marked "no intermediate yield" with a signed justification; nothing-after-yield becomes a warning |
| GMP-STAGE-NON-MATERIAL | rules-content.ts:350 | a step consuming or producing material in a stage declared NON_MATERIAL | PR-03 | (b) | Keeps the purpose declaration honest (otherwise the yield rule is bypassed) | keep |
| GMP-EQUIPMENT-STATUS | rules-content.ts:361 | non-utility equipment used before a status check, on every path, **within the same stage** | PR-03 | (a), partly (c) | EU 4.18(b)-(c) (equipment clean and fit for use before start); 211.67, 211.68(a); Schedule M 17.3.6. The facts are keyed by stage (rules-content.ts:366), so equipment kept in use across two stages must be checked again in each | allow a status check earlier in the same room/line to count |
| GMP-BOM-CONSUMED | rules-content.ts:387 | a BOM line never consumed; a BOM line not consumed on **every** completing path | PR-03 | (a)/(b); every-path **partly (c)** | 211.186(b)(3)-(4) complete component list with amounts; 211.101 dispensing. A component used only in one variant or branch (an ISSUE-variant alternative) is legitimate | relax: a BOM line may be bound to a variant value or branch and checked on those paths only |
| GMP-YIELDS | rules-content.ts:401 | a yield checkpoint with no min and max; one no step evaluates; an evaluating step that is not a yield block or does not compute the result; a yield step with no checkpoint or with library slots lacking limits | PR-03, INV-34, PR-31, PR-39 | (a); "computed, never typed" partly (c) | 211.186(b)(7) theoretical yield with upper and lower limits; EU 4.17(d); Schedule M 17.3.6. 211.103 allows a manual calculation verified by a second person, so a "never typed" yield is stricter (a DI-33/INV-25 design choice) | keep (owner may accept "computed" as policy) |
| GMP-INTERMEDIATES (hold time) | rules-content.ts:444-452 | an intermediate with no hold time; a hold time citing anything but a hold study or validation report | PR-03, INV-34, IN-13 | (a); source kind **partly (c)** | Schedule M 17.3.6 lists the hold time as an item of the master formula (IN-13 sources). No clause in the repo set names the kind of evidence | relax: also accept PROCESS_DATA/DOCUMENT with a justification |
| GMP-INTERMEDIATES (flow) | rules-content.ts:453-462 | never produced; never used and not a final output; used before it is produced on every path | PR-03, INV-34, IN-13 | (b) | The referenced thing must exist when it is used | keep |
| GMP-TIMERS | rules-content.ts:469 | a time constraint with no source, or a source that is not a validation, hold-study, registration, pharmacopoeia or rule-table reference; a timer step with no constraint | PR-03, INV-34, PR-30 | source **partly (c)**; timer step (b) | 211.111 asks for time limits "where appropriate", and EU 4.18(f) sets critical parameters such as time. Neither requires a validation reference (INV-34 is internal) | relax: also accept SOP/DOCUMENT sources (e.g. a company standard), perhaps with a warning |
| GMP-SPECIMENS | rules-content.ts:483 | a printed component with no specimen, or citing a reference that is not a specimen | PR-03, IN-14 | (a) | 211.186(b)(8) (sample or copy of each label); EU 4.19(e); Schedule M 17.3.7 | keep |
| GMP-REFERENCES | rules-content.ts:507 | a reference not pinned by hash; not effective (not yet effective, superseded, retired, withdrawn, hash mismatch, unknown); cited under the wrong kind | PR-03, DI-04 | (a)/(b) | EU 4.3 (documents approved, with an effective date) and superseded documents not usable (EU4-10 row), per repo sources. The hash is (b) | keep |
| GMP-RISK | rules-content.ts:534 | scale with <2 classes; a class not on the scale; a reduction with no class, no RA rationale, no subjects, wrong subject, or REVIEW_BY_EXCEPTION with no validation reference; a non-critical item with no MINOR_CLASSIFICATION reduction | IN-02 | (a) reductions; (b) scale; non-critical **partly (c)** | IN-02 / Schedule M Part I section 2 (QRM in proportion to risk). The repo's behaviour turns this into "no reduction without a linked RA", a fair reading. "Non-critical is a reduction" is the repo's default-critical policy, stricter than the clause; one reduction may cover many items, so the burden is small | keep, or allow an MBR-level criticality assessment as the rationale |
| GMP-SYSTEMS | rules-content.ts:580 | a step relying on automation or device capture that names no computerised system; an automation step with no recipe and version | DI-04 | (a) | DI-04 sources: the EU Ch.4 instructions preamble (computerised systems named), 211.68(b); Annex 11 | keep |
| GMP-PAT | rules-content.ts:595 | a PAT step with no method/model/acceptance criteria | DI-04 | (a) | EU Ch.4 preamble (PAT with acceptance criteria), per DI-04 sources | keep |
| GMP-REPROCESSING | rules-content.ts:604 | a reprocessing block with no declared case; an addition or recovery with no max %, max age and max source batches; max % outside 0-100; a validated re-treatment not inside a loop | PR-03 | case (a); limits **partly (c)**; re-treatment loop **(c)** | EU 5.67-5.69, Schedule M 14.32-14.34 and 211.115: a defined, authorised procedure after risk evaluation, with the effect on shelf life assessed. None asks for these three numeric caps. The loop form is a design convention. **PR-03 `sources` do not cite 5.67-5.69**; the right control is PR-47/IN-19 | keep the case; make the caps "as the procedure defines" (at least one bound plus a reference to the authorised procedure); re-treatment loop: a warning |
| GMP-ACCEPTANCE-SCHEMES | rules-content.ts:622 | no criterion; a duplicate criterion; no governing market or one outside the market set; bad criterion limits; a sampling plan smaller than a criterion needs | PR-08, PR-03 | (a)/(b) | 211.110(a)/211.160(b) (samples adequate for the test; specs per market); internal consistency | keep |

## Market and framework

| Rule | file:line | Refuses | Controls | Class | Basis / note | Proposal |
|---|---|---|---|---|---|---|
| MKT-MINIMA | rules-market.ts:122 | no market engine (fails closed); an unresolved rule key; a bound limit or time constraint looser than the market's resolved minimum, or bound with the wrong direction or a non-comparable unit; a required minimum nothing binds; a required content item no rule checks | PR-03, IN-52 | (a) + (b) | The strictest of India and the export markets wins (IN-52; project rule). Fail-closed: (b) | keep |
| (rule crash) | validate.ts:103 | a rule that throws | none | (b) | Fail closed | keep |

## Counts (rows above)

- (a) wholly: 15 (FLOW-LOOPS test endpoint, GMP-HEADER market/size, GMP-CRITICAL-PARAMETERS, GMP-SIGNIFICANT-STEPS performer/checker, GMP-WITNESS, GMP-STAGE-CLEARANCE order, GMP-SPECIMENS, GMP-REFERENCES, GMP-SYSTEMS, GMP-PAT, GMP-ACCEPTANCE-SCHEMES, MKT-MINIMA, GMP-YIELDS, GMP-INTERMEDIATES hold time, GMP-RISK reductions). Several of these mix in (b) parts.
- (b) wholly: 29 rows (structure 11, counting FLOW-LEVELS (2) and (4) and the GRAPH group as one row; data 8; time 3; content 6; framework 1).
- (c) or partly (c): 15. FLOW-LEVELS(1) phase-in-stage; FLOW-LEVELS(3) empty operation; FLOW-CONSTRUCTS one-branch parallel; DATA-GUARDS dead branch; DATA-PARALLEL shared BOM line (unverified); GMP-TYPED-FIELDS critical TEXT; GMP-SIGNIFICANT-STEPS clearance second person; GMP-STAGE-CLEARANCE per stage; GMP-STAGE-YIELD every material stage plus nothing-after-yield; GMP-EQUIPMENT-STATUS per-stage re-check; GMP-BOM-CONSUMED every path; GMP-INTERMEDIATES hold-time source kind; GMP-TIMERS source kind; GMP-RISK non-critical-as-reduction; GMP-REPROCESSING numeric caps and re-treatment loop. (GMP-YIELDS "never typed" is a lighter case and is not counted.)

Control-citation gaps (the cited control's `sources` do not carry the clause):
- FLOW-LOOPS test endpoint: DI-34 sources lack the OOS/reprocessing clauses.
- GMP-SIGNIFICANT-STEPS: cites PR-03/IN-02, but PR-14 is the matching control.
- GMP-REPROCESSING: cites PR-03, but the basis is EU 5.67-5.69 / Schedule M 14.32 (PR-47/IN-19).
- The INV-xx citations are internal invariants.

## FLOW-LEVELS: does the engine need a phase inside an operation?

**Verdict: no.** The engine, the graph, the numbering, the stage summary, the database and the execution views treat an
operation as an optional, generic scope. Nothing depends on a phase having an enclosing operation. What a phase does
need is an enclosing **stage**.

Evidence:
- Graph build: flow/compile.ts:74-88 compiles `stage` and `operation` with the same code (SCOPE_START, body, SCOPE_END,
  region `STAGE`/`OPERATION`). A phase in a stage body compiles like any other child. graph-checks.ts has no
  OPERATION-specific rule.
- Engine definition: engine/definition.ts:197-202 records only `stages` and `stageOf`. Step definitions carry
  `stage: stageOf.get(id)` (definition.ts:242); there is no operation field.
- Execution: engine/advance.ts:250-258 (SCOPE_END waits for the stage sign-off only when `def.stages.get(node.source)`);
  advance.ts:275-297 (SCOPE_START/END record node events for any scope and open a frame only for stages).
  An operation's START/END events exist only if an operation exists; nothing requires one.
- Stage summary: engine/stage-summary.ts:33 selects steps by `def.steps.get(i.step)?.stage === stageId`, by stage
  only. SQL sql/0319_stage_summary_content.sql:139,148 does the same (`... ->> 'stage' = v_stage`).
- Numbering: flow/numbering.ts:7-10 says outright that "a stage's children (operations, **or steps placed directly in the
  stage**) share one counter". numbering.ts:94-113 adds `operation` only when one exists. SQL numbering
  sql/0304_hold_point_first_version.sql:81-96 numbers stage/operation/phase/holdPoint generically with `p_stage`, so a
  phase in a stage gets number `2.3`.
- Database: sql/0316_finished_construct_ends.sql:72,90-93 (an operation's END and "content left" are checked only for
  nodes of kind operation); 0307:94-99, 0308:96, 0312:121, 0314:94/115 list operation among the generic constructs. No SQL
  checks placement levels (grep for level/placement wording in sql/: none).
- Validator internals: analysis.ts:37,148 keeps `operation` per node, but no rule reads it (grep `info.operation`: none).
  rules-time.ts:83 lists operation in ARRIVAL_STARTS only for a constraint that names one.
- Tablets server/web: apps/tablets-server/src/features/execution has no operation-specific code (grep: none). Stage
  references go through the numbering (views.ts:932-935). The designer already supports inserting a step at the start of
  a stage body (apps/tablets-web/src/features/designer/model/ops.ts:525). ops.ts:406-411 and
  apps/tablets-server/test/designer/new-stage.test.ts:1-5 show that the rule forced a workaround for demo finding D-1
  (7 November 2026): the clearance and status steps are wrapped in a synthetic "<name>: preparation" operation.

What would break if a phase sat directly in a stage:
1. FLOW-LEVELS itself (rules-structure.ts:74-89) and its test `[DI-34] FLOW-LEVELS: a phase outside an operation...`
   (packages/recipe-core/test/validator/structure.test.ts:29). That test only checks "directly in the procedure" and
   "stage in a stage", so it keeps passing if `phase: ['STAGE','OPERATION']`. property.test.ts:166 expects FLOW-LEVELS
   for some generated case; that case needs checking.
2. Library expansion: flow/expand.ts:131-137 (LIB_LEVEL) refuses an OPERATION-level element (one holding phases) called
   at stage level. It must be relaxed together with the rule, or such calls stay refused.
3. Documentation: ADR 0004 decision 1 states the hierarchy procedure -> stage -> operation -> phase, and ops.ts:409
   carries the rule in a comment. Changing it is an architecture decision (an ADR amendment), not a control change:
   no control's `sources` or `behaviour` asks for an operation level.
Nothing found in the engine, the SQL, the stage summary, the numbering or the execution views would break. Mixed
children (operations and phases side by side in one stage) also number fine, with one shared counter.

Keep: a phase must sit inside a **stage** (directly or through operations). Equipment binding (DATA-REFERENCES
rules-data.ts:36-44), stage sign-off (advance.ts:250-258), stage summary, stage clearance/yield/equipment-status facts
and the database's stage-keyed numbering all depend on it.
