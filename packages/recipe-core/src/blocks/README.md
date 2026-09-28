# Blocks (`recipe-core/src/blocks`)

Phase 2, module B1. The block contract, the block registry and the generic block versions the
engine executes in this release. Outline 6.6 ("Block contract"), ADR 0010 decisions 1, 3 and 4,
ADR 0011. A block type is vendor code, versioned as `type@version`; customers configure blocks in the
MBR but cannot create primitive types.

```ts
import { blocks, engine } from '@ebmr/recipe-core';

const registry = blocks.genericBlockRegistry().extend(...editionBlocks); // TB-xx / IB-xx later
registry.report();                  // per version: the contract parts it still lacks
registry.unregistered(catalogue);   // validator catalogue types with no executable version
const def = engine.defineBatch(mbr, { registry });
```

## Contract (`contract.ts`)

Every `BlockVersion` carries: a configuration schema, a data schema (block entry kinds and optional
start data), cross-field configuration checks (`checkConfig`: errors refuse the definition, warnings
need a recorded justification), an execution handler (phase blocks) or the engine functions that
implement it (batch, stage, hold-point, construct and service blocks), exception rules mapped to the
review-by-exception taxonomy, a simulator model, a golden fixture, the tests that prove it, and the
rendering parts (shop-floor UI, review renderer, true-copy renderer, paper rendering, translations).

Handlers are pure and never mutate engine state. They read a `HandlerView` (the step, its
configuration, recorded data, entries, containers, sub-lot, the MBR and the expression service) and
return effects that the engine applies:

| Hook | When | Returns |
|---|---|---|
| `computedItems` | definition | parameters the block computes; the engine refuses typing them (INV-25) |
| `beforeStart` | START_STEP | refusals (e.g. G-24 authorisation from start data) |
| `acceptEntry` | RECORD_ENTRY (after the schema) | normalised entry, containers, exceptions, or a refusal; `verificationRequired` |
| `onValue` | RECORD_DATA | failed flag, exceptions, notifications (expected answers, excursions) |
| `computeItems` | PERFORMED | block-computed items with the entries they came from (net totals) |
| `onPerform` | PERFORMED | exceptions and notifications (tolerance, sampling shortfall) |
| `beforePerform` | PERFORMED | refusals (acknowledgement, BOM lines, planned containers) |
| `meanings` | PERFORMED / check | extra signature meanings accepted |
| `executedQuantityItem`, `targetTolerance` | corrections | executed target comparison (outline 5.2.3) |

`validateSchema` refuses unknown fields and JavaScript numbers where decimal text is required
(GMP values are decimal strings, never `number`).

## Registry (`registry.ts`)

`new BlockRegistry(versions)` registers each `type@version` once. A phase block without a handler,
configuration schema, data schema, exception rules or simulator model is refused at registration, and
`defineBatch` refuses an MBR whose phase uses a version the registry cannot execute (ENG-DEF-BLOCK)
or a configuration outside its schema (ENG-DEF-CONFIG). `report()` lists the missing contract parts
of each version; `missingExecutionParts` is empty for every Phase 2 version, and only the rendering
parts are missing (they arrive with the UI and renderer work; CI will then refuse an incomplete
version). `unregistered(catalogue)` names the catalogue types still without an executable version.
`extend(...)` returns a registry with more versions (edition blocks, test stand-ins).

## Generic block versions (`generic/`)

| Block | Title | Level | Key rules (codes) | Controls |
|---|---|---|---|---|
| G-01 | Issuance and header | batch | engine `issue()`: size, number, markets, variant and header inputs checked | PR-01, PR-10, IN-18 |
| G-02 | Stage frame and summary | stage | closes only on the responsible person's sign-off; summary derived | PR-16, IN-15 |
| G-03 | Instruction and acknowledgement | phase | SOP must be an MBR reference (G03-SOP-REF); version in force recorded (G03-SOP-VERSION); no PERFORMED before acknowledgement (G03-NOT-ACKNOWLEDGED) | PR-03, DI-10 |
| G-04 | Process parameter record | phase | limits and tiers through the engine | PR-08, IN-13, DI-30 |
| G-05 | Observation capture | phase | paper original attached makes a second-person check mandatory | PR-11, DI-28, DI-41 |
| G-07 | Weighing and dispensing | phase | lot status, expiry, retest, identity, material hard blocks (G07-LOT-*, G07-WRONG-MATERIAL); net = gross - tare computed, never typed (G07-NET); every BOM line dispensed (G07-BOM-INCOMPLETE); tolerance exception; manual fallback needs a second person; target without tolerance is a warning needing justification | PR-18, PR-19, PR-20, IN-23, IN-24, INV-25 |
| G-08 | Identification and charge-in | phase | only planned containers of this batch and sub-lot, label matches, not consumed (G08-*); every planned container charged | PR-21, DI-30, IN-26 |
| G-11 | Environmental condition check | phase | out-of-limit is an ENVIRONMENT_EXCURSION with notification of production and QA | PR-25, IN-39 |
| G-12 | Sampling | phase | system-generated sample ids and labels; unplanned points refused (G12-NOT-PLANNED); shortfall exception | PR-29, IN-20 |
| G-13 | IPC with readings and statistics | phase | every reading kept; categorical FAIL is IPC_RESULT_FAILED; repeats never replace | PR-29, IN-35, DI-29 |
| G-14 | Calculation | phase | computes with an evaluation record; a failure is CALCULATION_FAILED, never a silent zero | PR-31, DI-33, INV-25 |
| G-15 | Timer, hold time, transfer | phase | issued-by and received-by two persons (G15-TRANSFER); time constraints through the engine | PR-30, IN-13, INV-20 |
| G-16 | Verification / witness | phase | unexpected answer is an exception; check by a person not involved | PR-14, DI-30, INV-03 |
| G-17 | QA hold point | hold point | engine `dispositionHoldPoint()`; negative disposition holds the batch | PR-45, IN-37 |
| G-18 | Exception and deviation link | service | engine exceptions, deviation links and dispositions | PR-13, DI-26 |
| G-19 | Flow control (incl. replicate) | construct | engine token game, decisions, sub-lots | DI-34, INV-19 |
| G-20 | Yield and reconciliation | phase | computed yield judged against its tiers | PR-31, PR-39, DI-33 |
| G-22 | Output containers | phase | container ids per sub-lot, net computed, only produced intermediates | PR-38, PR-45, INV-25 |
| G-23 | Returns, rejects, destruction | phase | batch-coded material, method and witness for destruction (G23-*) | PR-40, PR-46, IN-35 |
| G-24 | Reprocessing / rework gate | phase | QA authorisation with investigation and risk evaluation before start (G24-NOT-AUTHORISED, G24-SELF-AUTHORISED); same product, age, percentage, source-batch limits, no chained recovery (G24-*); QC testing decision exception | PR-47, IN-19 |

Each block's exact controls are in its `controls` field; `report()` returns them.

## Tests

`test/blocks/golden.test.ts` (registry, contract completeness, schemas, every phase block's golden
fixture through the engine), `test/blocks/material.test.ts` (G-07, G-08, G-22, G-23) and
`test/blocks/process.test.ts` (G-03, G-05, G-11, G-12, G-13, G-15, G-24). Engine-level blocks are
proven by `test/engine/*.test.ts`.

## Later phases

G-06 (automated equipment phase), G-09 (equipment status), G-10 (room and line clearance), G-21
(printed materials) and G-25 (sign-off, review and release) need database-backed status, device
interfaces or the review work and arrive in Phase 3 and 4; `unregistered()` reports them. Material
lot status, expiry and identity arrive with each entry today; Phase 3 checks them against site
services at the database. Rendering parts arrive with the UI (Phase 2 screens) and renderers (Phase 4).
The edition blocks (TB-xx, IB-xx) register through `extend()`.
