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
| The pack block API-PACK (drums or bags, labels, reconciliation, examination) | [seed/substance.ts](../../../packages/recipe-core/src/library/seed/substance.ts) |
| A blank API master and its blank packaging master in the designer | [from-formula.ts](../../../apps/tablets-server/src/features/designer/from-formula.ts) |
| The chain from library blocks to a released lot, over the routes | [api-chain.test.ts](../../../apps/tablets-server/test/substance/api-chain.test.ts) |

## How a batch reaches release

1. The designer starts an API master BLANK from the formula of a product whose dosage form is API or Intermediate; it
   ends with QA's release for packing (H-PACK) in a stage of its own. Its packaging master starts PACKAGING_BLANK: the
   pack type, the formula's batch sizes, a packing stage with its room clearance, and no formula pin.
2. A packaging master packs to the end when its procedure holds a step of the library block API-PACK
   (`recipe.packaging_completion_block`, row of migration 5000; recipe-core 1873 lets a library block name it).
3. The packaging order takes the processing batch's bulk after H-PACK, packs it and the stores post the finished lot
   (tablets 1150 `tab.post_finished_lot`, edition SUBSTANCE).
4. The release gate G-REL asks `substance.grel_edition_items` (migration 5000) for the edition's items: labels
   reconciled, yields, posted quantity equal to the net mass packed, the packed containers examined, and the generic
   container, rule-set and reprocessing items of the tablets hook. Anything that cannot be shown is RED.
5. The market guard (kernel 1404) refuses a tablets or sterile rule key on an API scope: an API master binds the kernel
   rule table only.

## The certificate of analysis (plan C3, AS-17)

Migration 5002. The CoA of a released finished lot of the API edition is read only from existing records
(`substance.coa_document`): the product's name and grade (the monograph reference of the specification in effect), the
lot and batch numbers, the release date (the manufacturer release decision), the retest and expiry dates, each test of the
specification with its limits and the latest approved result, and the manufacturer's name and address from the
manufacturing licence. No record holds the manufacturer's telephone; the CoA shows it as not on record.

1. The authorised person prepares it (`substance.prepare_coa`, right RELEASE.MANUFACTURER): refused while a problem
   stands; the document and its SHA-256 are stored insert-only (`substance.coa`), the true copy.
2. The quality unit signs it through the usual ceremony (signable action COA_ACT, aggregate `substance_coa`, meaning
   COA_APPROVED, state PREPARED); `substance.sign_coa` refuses a CoA whose lot's records changed since it was prepared.
3. The screen is `/release/$lotId/coa`, linked from the release page of a released lot.
