# D-6: a library block's equipment class from the plant's classes (owner's MGL-SR-BL report, item 9)

The report: library equipment classes are free text, not checked against the plant's classes. The plant had no vessel
or viscometer classes, so the user created them (SS-VESSEL-STIRRER, VISCOMETER).

## Why it matters

The run accepts only a unit whose plant class is the class the formulation names (block-version.ts,
LIB-EQUIPMENT-CLASS). So a mistyped or invented class was accepted on the master and refused only on the floor.

## Change (lead-approved 8 November 2026, option A)

1. Designer: a library step's equipment-class slot is a choice of the plant's classes (`plant.equipmentClasses`), shown
   as code, description and kind. A link opens Plant master data, where a missing class is defined. A saved value that
   is not a plant class stays shown, marked "not a plant class". Free text only when the class list cannot be read.
2. Validator: GMP-EQUIPMENT-CLASS-PLANT, a WARNING (justified or fixed) when a library step names a class the plant does
   not hold. The binding duty stays LIB-USE-EQUIPMENT-CLASS: the instructions name the principal equipment (21 CFR
   211.186(b)(9)). No clause refuses a master over a class missing from the register, and the run already refuses a
   unit of another class (recipe-core 0521, LIB-EQUIPMENT-CLASS). The server gives the validator the plant's class codes
   (`plantClasses`, read from plant.equipment_class); without them (the web's own check, a simulation job) the rule says
   nothing.
3. E2E order (no change to what each flow proves): the library acceptance flows (`acceptance.ts`,
   `injectables-acceptance.ts`) define on the GMP plant the classes the product's blocks name before the author adds the
   blocks. The units and their qualification come later, as before; the class step is skipped for a class already
   listed.

## Residual (not in D-6)

The stage-binding picker (StageEditor) still lists the document-management EQUIPMENT_CLASS records. Their codes must
equal the plant's class codes for a batch to run (recipe-core 0521); the demo seeds both today.

## Tests

- `packages/recipe-core/test/validator/plant-classes.test.ts`: a plant class passes; a missing one is a warning naming
  the class and slot; without the plant's classes nothing is said.
- `apps/tablets-web/test/designer/library-blocks.test.tsx`: the choice lists the plant's classes, marks a saved class
  the plant lacks, links to Plant master data, and records the chosen code.
- E2E: the 7 library groups (library-wg-fc, library-dc, library-rabe-ec, library-caps, library-softgel,
  library-inj-vial, and rest for the shared support), run together on GitHub.
