# Module C2-designer: Document-first MBR designer (GMP server + web), template dc-mini with real validation adapters, test-package export, usability protocol

Depends on: C0-spine

## Paths owned
- `apps/tablets-server/`:
  - `src/features/designer/**`:
    - routes;
    - `adapters/{market-minima,references,expressions}.ts`;
    - `palette.ts`;
    - `simulate-worker.ts` (node:worker_threads);
    - `package-export.ts` (exchange writer);
    - `templates/dc-mini.mbr.json`;
    - `seed.ts` (reference documents);
    - `index.ts` (replaces the stub; A2 registers `MBR_TRANSITION`).
  - `sql/0150-0199`:
    - `tab.reference_document` (DMS stand-in, insert-only, audited; MASTERDATA.CHANGE writer);
    - `tab.designer_justification` (insert-only, audited, keyed by version and finding key).
  - `test/designer/**`.
- `apps/tablets-web/src/features/designer/**`:
  - library, new-from-template, document view with sections 0-11, row editor, `model/ops.ts` (pure edit operations with undo and redo), findings panel, simulation panel, send-to-sandbox;
  - `test/designer/**`.
- `tools/e2e/specs/designer/**`.
- `docs/validation/designer-usability-protocol.md`.
- Control YAMLs of the controls below.

## Day-1 spike (report it to the lead the same day)

Write `templates/dc-mini.mbr.json` (plan section 8):
- 2 stages and about 13 steps;
- markets IN, with a US variant test;
- references pinned by hash to the seeded `tab.reference_document` rows (SOP-DISP-001, SOP-BLEND-002, SOP-CLEAN-003, MAT-PCM, MAT-MCC, MAT-MGS, SYS-WEIGH-01 as the weighing system per F6, REG-PCM500, PH-EUR-11, VR-BLEND-01);
- G-04 blend time and speed with nested ALERT, internal ACTION and REGISTERED tiers and sources;
- G-07 DEVICE capture;
- performer and checker roles in the engine vocabulary (`PRODUCTION_OPERATOR`, `PRODUCTION_VERIFIER`, `PRODUCTION_SUPERVISOR`, `QA`).

Build the real validation context:
- `flow.createExprService()` and `flow.genericBlockCatalog`;
- a ReferencePort over `tab.reference_document`;
- a MarketMinimaPort over the kernel market engine with the published tablets rule table. It returns LIMIT minima for bound keys and UNRESOLVED on any failure, so it fails closed.

A server test proves:
- `validateMbr` + `gate` pass with zero errors and every warning justified;
- `simulate` passes with full coverage.

Once C3's G-09/G-10 v1 land, a second assertion proves `defineBatch(template, {installation: 'SANDBOX'})` succeeds. If the gates cannot pass, stop and report to the lead; never weaken a rule.

## A1 deliverables

**Server (GMP only; refused on SANDBOX)**
- `GET /api/mbr/templates`, `GET /api/mbr/families`.
- `POST /api/mbr/families`: template, familyCode, product, strength, batch sizes, markets with IN locked. It calls `lifecycle.defineFamily` + `createVersion` + `saveContent`, giving a DRAFT.
- `GET /api/mbr/versions/:id`: VersionView with content, revision, hash, state, evidence and justifications.
- `PUT /api/mbr/versions/:id/content {baseRevision, content, note}`: `lifecycle.saveContent` in a command; 409 when stale; DRAFT only.
- `POST /api/mbr/validate {versionId, content}`: no writes; findings with rule, controls, severity, subject path and plain message.
- `POST /api/mbr/versions/:id/simulate`: a worker thread with a timeout; SIMULATION watermark; no writes.
- `POST /api/mbr/versions/:id/justifications`.
- `POST /api/mbr/versions/:id/start-verification`: `validateAndStartVerification`.
- `POST /api/mbr/versions/:id/test-package`: writes an `ebmr.mbr-test-package v1` file to the exchange `to-sandbox` directory (O_EXCL, packageHash, GMP stamp), adds a business audit entry on `mbr_version:<id>`, and returns `{packageId, sandboxUrl}`. Needs MBR.AUTHOR.
- `GET /api/mbr/palette`: descriptors from the recipe-core registry and catalogue (plain name, type@version, roles, significant flag, config schema, default config, availability). SANDBOX_ONLY versions are badged "sandbox only until Phase 3"; G-06 and G-21 are hidden.
- `GET /api/reference-documents`.

**Web**
- Library with state chips; new from template.
- The document view:
  - title and signature block;
  - product and batch sizes, markets, references, BOM, equipment and rooms;
  - parameters and limits table (tier, source, rounding) with DecimalField;
  - calculations (read-only in A1);
  - the numbered procedure (stage → operation → step rows: No., Instruction, Records, Done by, Checked by);
  - constructs as read-only labelled boxes; hold times; yields.
- Editing without drag, through menus and the keyboard:
  - insert, move and delete a phase in a sequence;
  - edit title, instruction and SOP reference;
  - a schema-driven config form;
  - parameters and limit tiers;
  - performer and checker roles.
- A findings panel from the debounced server validate, grouped by section, with jump-to-node and justify.
- Save revision with a change note; a localStorage draft (D7); 409 conflict handling.
- A simulation panel with the watermark; start verification; send to sandbox, which opens the sandbox link.
- An audit link to the version chain (C1's `auditLink`).
- Pure edit operations: a property test that any sequence keeps `flow.parseMbr` ok and ids unique.

## A2
- Validation live in a Web Worker from `@ebmr/recipe-core/pure`, with the server staying authoritative.
- Construct editing (wrap and unwrap: loop, alternative, per-sub-lot, parallel).
- A formula editor with expr diagnostics.
- BOM and IPC wizards; a second template with G-13, G-12 and G-14.
- Import of sandbox run reports (Ed25519, SANDBOX stamp, passed, replayVerified, exact content hash) → `recordEvidence(SANDBOX_RUN)`.
- The `MBR_TRANSITION` signable (SUBMIT, CHECK, APPROVE) with the office ceremony.
- The approval rendition and structured diff; operator preview; market panel; where-used; the canvas.
- Run the usability protocol with 3 authors.

## Contract
- **Consumes:** the frozen `designer` namespace and C1's ceremony (A2).
- **Provides:** the template, the exchange package format and the palette descriptors.

## Tests (IDs in names)

**Server**
- `[PR-03]` Deleting the clearance step gives GMP-STAGE-CLEARANCE naming PR-03; start verification is refused.
- `[PR-08]` A limit-tier nesting error is named.
- `[IN-02]` The rationale gate.
- `[INV-34]` Generic content minima through the market adapter; the adapter fails closed on UNRESOLVED.
- `[DI-04]`:
  - the validator report is bound to the content hash;
  - a new revision voids evidence;
  - simulation is stamped SIMULATION.
- `[PR-06]` Save only in DRAFT; a stale revision gets 409.
- `[PR-01]` Only approved discrete batch sizes are accepted.
- `[DI-05]` Designer routes are absent on SANDBOX; the package carries a GMP stamp.

**Web and E2E**
- Component tests: findings map to document locations; DecimalField limits.
- E2E `designer.spec` [PR-03][DI-04]:
  1. new from template;
  2. edit a limit;
  3. delete the clearance step and see the finding; jump to it; restore;
  4. justify; save; simulate; send to sandbox;
  5. the audit trail shows the revision.
- axe on the designer.

## Controls
PR-01, PR-03, PR-06 (UI part), PR-08 (static), IN-02, DI-04, DI-05 (export side), INV-34 (generic).

## Must not
- Execute batches or write execution tables.
- Relax a validator rule or a market minimum to make the template pass.
- Edit the contract, recipe-core src (other than using it), or the kernel.
- Let `localStorage` hold anything but unsaved authoring drafts.
