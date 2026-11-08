# D-5: copied and skeleton names (owner's MGL-SR-BL report, items 7 and 13)

The report:
- Item 7: "From the formula, as a copy of an approved master" did not rename the source's names. RTD-DC-62AB still
  showed "Exemplazine sodium dispensed" and "Printed tablets"; the product has two actives.
- Item 13: skeleton wording survives into the product: "Final blend", "Blend yield / Materials charged to the
  blender", "Final blend discharged".

## Cause (item 7)

`renameMaterials` (from-formula.ts) paired a copy BOM line only with the source line of the same id. The source's
active is `BOM-<its line id>`; a formula whose lines have other ids and other materials matches neither by id nor by
material, so nothing paired and nothing was renamed. Two actives is not the cause: any formula whose line ids differ
from the source's missed it.

"Printed tablets" is the source's printing stage (`printedNet`, `I-PRINTED`): structure, not a material name. The
author deletes the stage or renames its items.

## Change (lead-approved 8 November 2026; no migration)

1. A copy line still stands for the source line of its own id. Failing that, a source ingredient line the copy dropped
   pairs with a copy line the source did not have, of the same BOM role, one to one in formula order. An unpaired line
   renames nothing: no name is guessed.
2. The copy tells its author what it did. The first revision's note names each rename that changed a name ("A -> B")
   and says every other name is the source's, to check in the draft. The version view carries the saved revision's
   note (`savedNote`), and the designer shows it under its toolbar.
3. Item 13: UPDATE_INTERMEDIATE_NAME `{ intermediateId, name }` (checkName; the id stays), a name field on each
   intermediate in section 9. With D-8's UPDATE_PARAMETER_NAME, UPDATE_CALCULATION and UPDATE_YIELD, every skeleton or
   copied name can be the product's own. Like every op, it changes only a DRAFT: the server saves no content change
   to an approved version (EBMR-RCP-021).

## Tests

- `apps/tablets-server/test/designer/copy-formula.test.ts`: two actives under other line ids, where the source's
  active is renamed to the first and nothing to the second; injectables, renamed the same way, and nothing renamed
  when nothing pairs. Both fail without the pairing.
- `apps/tablets-web/test/designer/intermediate-name.test.ts`: the op, its refusals, undo.
- `apps/tablets-server/test/designer/copy-names.test.ts`: the copy's first revision carries the note through the
  route; the approved source's intermediate is not renamed (EBMR-RCP-021).
