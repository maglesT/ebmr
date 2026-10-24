# Slice 7o: the R4 end-to-end proofs (own products from formula to released lot)

Requirement R4 of `demo-trial-requirements.md` (and R8 P3, capability C3): a company's own tablet product built on the
screens without a template and made into a released lot, twice: "Demotab 400 mg, wet granulation, film coated, alu-alu"
and the second check product, an invented rabeprazole sodium 20 mg enteric-coated tablet with three coating layers in a
row (seal, enteric, top), each to its own weight gain.

## The owner's question (23 October 2026)

Can one recipe coat the same tablets two or three times in a row, each coat with its own target weight gain? Engine,
validator, simulation and database: yes, unchanged (test `test/blocks/coating/three-layers.test.ts`: three TB-18 layers
with their own core and gain items pass the validator and definition, the simulation covers each layer's loop, and a
batch's three weight gains are each computed against that layer's own core sample). Nothing in tablets SQL 0910 to 0913
assumes one coating per batch. On screen it needed the designer's "Add a coating layer" (below).

## Decisions

- **D-7o-1** (lead approved): the plant, the containers and the batch's plant reads are served on the sandbox too, each
  installation against its own database (ADR 0021). Before, no master with the database-backed blocks a GMP batch needs
  could pass a sandbox test run on screen, so none could get its SANDBOX_RUN evidence there. The sandbox set-up with the
  GMP samples seeds a DEMO-ONLY plant mirroring the GMP demo plant by room and class (`cli/sandbox-plant.ts`,
  `--sandbox-plant`), with sandbox kiosks for GRAN-1, COMP-1, COAT-1, INSP-1, PL-2 and the people it needs (two cleaning
  technicians, stores, the designated dispenser). The seeds' direct SANDBOX_RUN evidence (demo set-up, golden worlds)
  stays where it is today; it can be replaced by real sandbox runs later.
- **D-7o-2**: "Add a coating layer" in the designer (a stage that coats offers it on any of its steps, before or after):
  the layer's own TB-03 suspension, TB-18 cores step with its own core item (mg, 6 decimals, validated range, second
  person) and TB-18 coating loop to its own gain item (process end point in %, the layer's maximum and, for a functional
  film, minimum). The layer copies the settings of the master's coating step when there is one. The three layers of the
  rabeprazole product sit in one coating stage: the tablets stay in the pan between coats, and a stage boundary would ask
  for a room clearance with product in the pan. Each layer is its own TB-18 cores step and coating loop.
- **D-7o-3**: a packaging master for a company's own product is a copy of an approved packaging master of another
  product (New master record, "A packaging master for a product, as a copy of an approved packaging master";
  `designer/packaging-copy.ts`): the pack, its sizes, line and blocks are the source's; the header names the product
  (name and dosage form from the product master); every printed item (G-21) takes the product's own printed material and
  artwork version for each market, wherever the source named the old material (TB-21 webs). A printed item left with
  another product's print is refused.
- **D-7o-4**: a lot's approved assay result (what TB-01 reads) and a printed lot's artwork version (what G-21 checks) are
  recorded on screen (`execution.recordLotAssay`, `execution.recordLotArtwork`, both installations): before, only the
  demo seed recorded them. On GMP the assay values are the lot's approved LIMS results, chosen on the lot page (tablets
  1001: a typed value is refused); in the sandbox the steward types a test lot's values on the Test lots screen.
- **D-7o-5**: a master copied from an approved master for another formula takes this formula's standard quantity per
  tablet: a calculation of the source that is its formula's mg per tablet times the batch size (route W's dispensing
  standard) is written from the new formula, and a golden case naming it (it held for the source's formula) is left out.
  The weights and limits that follow the tablet's weight (core mean, the run's weight checks, pan load) are the author's
  edits in the designer, as for any new product.

- **D-7o-6** (after merging main, slice 7k's one-act plant entry): a test run's plant entry has the sandbox family route
  `execution.plantEntry` (`/api/test-runs/:runId/steps/:stepKey/plant-entries`, SANDBOX), the same handler as GMP's
  `batches.plantEntry`; the floor picks the installation's family (`family.ts`), as for every other run command. Every
  unit of the DEMO-ONLY sandbox plant is TEST- labelled: an instrument is a registered device (EBMR-SBX-022) and a test
  run's entries name units, which the sandbox records only by TEST- identifiers (DI-05).
- **D-7o-7** (lead's (d)): "Send a production order" also offers every product whose current master version is APPROVED
  with an ACTIVE market authorisation, for the family's first approved batch size, with the master's own BOM scaled in
  exact decimals (`operations/erp-orders.ts`, `authorisedTemplates`); a demo template wins for its product.
- Found by the R4 browser runs and fixed, each with its test: a copy for another formula wrote the salt-adjusted quantity
  of an active a base-stated TB-01 step dispenses (INV-25, recipe-core 0690) and replaced the source's MATERIAL
  documents by material-master pins; a master from a formula pinned a material to its material-master version although
  a MATERIAL document was in force (the register then called it unknown); the designer could not remove an optional
  group whose members are required (a copied acid stage, TB15-STAGE).
- Found by the sandbox runs and fixed, each with its test: a test run's disposal could not name its own output container
  (the identifier rule read the label as a lot number: tablets 1700, and the record's free-text rule did not count it a
  bound word: recipe-core 1701); the replay check asked a phase created not applicable (an untaken branch) for stored
  content, so the run was exported as not passed (execution/verify.ts); the cleaning a test run's stages need was read
  on GMP only (`batches.cleaningNeeds` now ANY; the plant screen lists the floor's runs).
- Result: Demotab passes tests 1 to 3 in the browser (materials, product, formula, master copied and edited, change
  control, the whole processing run on the sandbox's kiosks, its result as evidence, four signatures, IN authorisation).
  The rabeprazole master with the seal, enteric and top coats added in the designer passes the checks and goes to the
  sandbox (tests 1 and 2).

## Notes

- TODO (R8 C4, slice 7p): the P3 browser test uses TB-15's acid and buffer disintegration and the existing release tests;
  when 7p's two-stage dissolution requirement (acid stage must not release, buffer stage must) is merged, add it to the
  rabeprazole product's specification and the P3 test.

## Built so far

- Three-layer proof (engine, validator, simulation, database): `apps/tablets-server/test/blocks/coating/three-layers.test.ts`.
- Designer op and form: `apps/tablets-web/src/features/designer/model/coating-layer.ts`, `components/CoatingLayerForm.tsx`;
  test `apps/tablets-web/test/designer/coating-layer.test.ts`.
- Sandbox plant: contract installations, features, web gates, `cli/sandbox-plant.ts`, personas; tests
  `apps/tablets-server/test/plant/sandbox-plant.test.ts`, the sandbox case in `apps/tablets-web/test/floor/step-plant-acts.test.tsx`;
  route matrix re-recorded (GMP rows identical; sandbox rows gain the new routes and the new sandbox roles).
