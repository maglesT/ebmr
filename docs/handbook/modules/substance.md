# substance: the API edition (Batchwright API)

**Draft.** Facts on this page were checked against the code on 5 November 2026 (API plan A1a).

The API edition makes active pharmaceutical ingredients and intermediates. It is the edition value `substance`, data in
the product's one database ([plan](../../build-plan/api/plan.md), [platform fit](../../build-plan/api/platform-fit.md)):
its masters are built from library blocks, its own SQL lives in the `substance` namespace (migrations 5000 to 5999,
after the tablets namespace), and it never changes how tablets or injectables behave.

## Where the code is

| What | Where |
|---|---|
| The edition's migrations | [editions/substance/sql](../../../editions/substance/sql/README.md) |
| The pack block API-PACK (each drum or bag a registered container, its net mass, closure and label checked) | [seed/substance.ts](../../../packages/recipe-core/src/library/seed/substance.ts) |
| A blank API master in the designer (ends with H-PACK), and the blank API packaging master (PACKAGING_BLANK) | [from-formula.ts](../../../apps/tablets-server/src/features/designer/from-formula.ts) |
| The screen-level acceptance (the master pair on screen) | [api.spec.ts](../../../tools/e2e/specs/library/api.spec.ts) |
| The chain from library blocks to a released lot, over the routes | [api-chain.test.ts](../../../apps/tablets-server/test/substance/api-chain.test.ts) |

## How a batch reaches release

1. The designer starts an API master BLANK from the formula of a product whose dosage form is API or Intermediate; it
   ends with QA's release for packing (H-PACK) in a stage of its own. The first packaging master starts from the same
   formula as a blank packaging master (start PACKAGING_BLANK, API plan A1b, plan section 4 row C6; offered only where the
   formula choice lists it, the API edition): the formula's product and batch sizes, not pinned to the formula (a
   packaging master carries no composition), the author's packing materials as its bill of materials, and one packing
   stage with the line clearance; the author adds the printed-materials block (G-21) and API-PACK from the library. Later
   packaging masters may also be copies of an approved one.
2. A packaging master packs to the end when its procedure holds a step of the library block API-PACK
   (`recipe.packaging_completion_block`, row of migration 5000; recipe-core 1873 lets a library block name it).
3. The packaging order takes the processing batch's bulk after H-PACK, packs it and the stores post the finished lot
   (tablets 1150 `tab.post_finished_lot`, edition SUBSTANCE).
4. The release gate G-REL asks `substance.grel_edition_items` (migration 5000) for the edition's items: the existing
   tablets items that apply to any packaging order (printed materials reconciled, yields, held containers, the bulk
   released, rule sets, reprocessing parents) and one group-9 item, the drums or bags examined (every API-PACK step
   completed; the core gate requires a group-9 answer). Anything that cannot be shown is RED.
5. The market guard (kernel 1404) refuses a tablets or sterile rule key on an API scope: an API master binds the kernel
   rule table only.

## Rework and reprocessing (plan A4a, AS-08, AS-19, AS-20)

No code of the edition's own: the API edition uses the existing mechanisms, and migration 5007 only names AS-19 and
AS-20. An intermediate lot that fails its specification is rejected by QA through the material-lot decision and cannot be
reserved by the next step. A rework is a master of its own, of record kind REPROCESSING and the same product; its batch is
planned only on the quality unit's authorised request, with a QA-concluded investigation linked to each parent, a stored
risk evaluation and the product's reprocessing permission (recipe-core 0624, 0625). The release item G3.EXTRA_TESTING
holds the reworked batch until QC records its decision on additional testing. A step that adds unreacted or reprocessed
material is a G-24 step with QA's signed authorisation (recipe-core 0621, 0622). The tests are in
[rework.test.ts](../../../apps/tablets-server/test/substance/rework.test.ts).

## Recovery of materials and solvents (plan A4b, AS-21)

No code of the edition's own either; migration 5008 only names AS-21. A second crop of the same batch is a step of the
approved master, and its lot is posted as `<batch>-2` in quarantine. A recovered solvent is the product of a recovery
master of the API edition, and its batch posts the solvent as a lot in quarantine. Either lot is reserved and weighed only
once QC has tested it and QA has released it for further processing. Fresh and recovered solvent are mixed as two G-07
weighings, and the genealogy shows both lots consumed. Not yet covered: mother liquor carried into a later batch through a
G-24 RECOVERY step, because only a press in-process failure can hold a container, so QA cannot release a container of an
API batch. The tests are in [recovery.test.ts](../../../apps/tablets-server/test/substance/recovery.test.ts).

## The certificate of analysis (plan C3, AS-17)

Migrations 5005 and 5006 (5006 enters AS-17 in the names a test run may cite, `recipe.engine_name`). The CoA of a released finished lot of the API edition is read only from existing records
(`substance.coa_document`): the product's name and grade (the monograph reference of the specification in effect), the
lot and batch numbers, the release date (the manufacturer release decision), the retest and expiry dates, each test of the
specification with its limits and the latest approved result, and the manufacturer's name and address from the
manufacturing licence, with its telephone when the licence records one (site-services 1735); without one the CoA shows the
telephone as not on record.

1. The authorised person prepares it (`substance.prepare_coa`, right RELEASE.MANUFACTURER): refused while a problem
   stands; the document and its SHA-256 are stored insert-only (`substance.coa`), the true copy.
2. The quality unit signs it through the usual ceremony (signable action COA_ACT, aggregate `substance_coa`, meaning
   COA_APPROVED, state PREPARED); `substance.sign_coa` refuses a CoA whose lot's records changed since it was prepared.
3. The screen is `/release/$lotId/coa`, linked from the release page of a released lot.
