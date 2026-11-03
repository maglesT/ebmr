# Decision record 0026: a dynamic library of tablet blocks; freeze the extras

- **Date:** 1 November 2026
- **Decided by:** project owner (maglesT). The direction change was sent through the portfolio lead on 1 November.
  The plan `docs/build-plan/dynamic-library/plan.html` (published to the owner as a private page and emailed) was
  approved in the session with "approved, start with S0 and S1".
- **Amends:** the build outline section 6.6 (block contract), ADRs 0010 and 0011 (block types are vendor code), and
  the Phase 7 backlog. Slices C (R11, view-only record) and D (R12, dissolution) stay paused and are absorbed by S5
  and S8.

## Problem

Every new tablet product needed a software session. A process step is a block, and a block type is a TypeScript
program: TB-01 to TB-24 (about 9,300 lines), with per-block SQL guards, a per-block screen layout and pharmacopoeia
limits held as code constants. The product had also grown in directions that are not needed now, while the core was
not right.

## Decision

1. **Library blocks are data.** A block is a digital form built from a small, fixed set of field types (number with
   unit and limits, text, yes/no, choice, date/time, timer, weighing, material lot, equipment/room, container, sample,
   test result, calculation) plus signatures. Field types stay vendor code. A library block definition is versioned,
   hashed, audited and approved by QA before use. Adding or changing one is data entry, not code.
2. **Formulation (master record).** It is assembled on screen from library blocks with the product's own values
   (limits, frequencies, methods, equipment classes, counts). It keeps the existing preparer, independent checker and
   QA approval (PR-02). Batches are generated from it at its listed sizes.
3. **Compliance stance.** The preparer and QA are responsible for the content being correct (21 CFR 211.186, Revised
   Schedule M). The software enforces approval before use, versions, audit trail, e-signatures and access. It also
   checks entered values against the formulation's limits and runs basic sanity checks: required fields, lower limit
   below upper limit, compatible units, nested tiers, and every CPP or IPC with limits (PR-03). It does not try to
   validate every combination of blocks.
4. **Owner decisions O-1 to O-8 (plan section 6), approved as recommended:**
   - O-1: the direction and the freeze list.
   - O-2 (DI-04): verification evidence for a master becomes the validator's sanity report, the independent check
     and QA approval. A sandbox run is optional, which matches the control's own text. The control file's text is
     not edited. Implemented in S9 by recipe-core 1830 (recorded in DI-04's `implemented_by`): a sandbox run is optional;
     one recorded that did not pass keeps the evidence incomplete.
   - O-3: library blocks need no per-block simulator model or golden fixture. One generic simulator and one generic
     golden test cover all of them. "Customers cannot create primitive types" stays true for field types.
   - O-4 (PR-02, PR-03): the automated consistency checks are the sanity checks of point 3.
   - O-5: pharmacopoeia limits become reference limits on the library test. A product limit looser than the reference
     needs a written reason (a warning), not a refusal. A limit looser than the product's registered specification for
     a market is still refused (plan review, 1 November). The PR-08 tiers stay enforced.
   - O-6: TB-01..24 and existing masters keep running and stay in CI. They leave the designer palette after S11.
     Nothing is deleted.
   - O-7: frozen areas keep their unit tests on every PR. Moving their E2E groups to a weekly run changes the test
     cadence of decision 0008, so it waits for the owner's explicit decision (plan review, 1 November). Until then,
     every group keeps running on every PR.
   - O-8: batch sizes stay a list of approved sizes, scaled by the system and approved together (IN-13 and PR-01 as
     written).
5. **Plan review (1 November, approved with additions; owner: keep 11 slices).**
   - Calculations read values from outside the step: a formula line, the batch size, a lot's approved assay, and an
     earlier step's value (S1).
   - Conditional fields, shown when an earlier field has a given answer (S1).
   - The formulation pins each block's version and content hash at approval, and batches inherit it (S1 hash, S9 pin).
   - **O-9 (decision 0008 §2), decided by the owner on 1 November: option (b).** The database does not recompute
     calculated fields of library blocks in SQL. It stores the server's figure with its evaluation record (inputs,
     formula hash, language version), so every figure can be re-verified, and it still checks entered values against
     the formulation's limits.
   - PQR is frozen, not dropped; Schedule M requires it.
6. **Freeze, not delete:** injectables, the site gateway, simulators, analytics/MSPC, the ERP/LIMS/QMS/LMS
   integrations, the QP package, contract giver, EU importer register, PQR, dashboards, CAPA, training, incidents,
   alarms, kiosk extras, the sandbox test-run evidence package, and the Phase 7 product backlog (R7, R8 P1-P12, R11,
   R12). Their code and tests stay in the repo and in CI, untouched, and get no new work.

## Slices

S0 (this record and PROGRESS.md), S1 (block-definition model and sanity checks), S2 (generic handler), S3 (library
storage and approval), S4 (registry bridge), S5 (generic renderer), S6 (smart fields), S7 and S8 (seed catalogue), S9
(formulation builder and approval), S10 (batch generation), S11 (acceptance: three tablets with zero code changes). See
the plan, section 5.

S11a (2 November 2026) passes: three tablets set up from the library through the screens, each sandbox batch run through every
library step at the further size, with no tablet-specific code. The acceptance run found five generic defects, fixed in shared
code with tests (see PROGRESS.md). Open findings: the issue screen's typed tablet count is not tied to the chosen size for
masters from a formula; a timer exception prints an unrounded duration; release-test blocks name QC roles no floor session
carries (they cannot sit in a master yet).
