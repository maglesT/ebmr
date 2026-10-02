# Decision record 0006: a product formulation library in Phase 3; an example generics pack in Phase 6

- **Date:** 2 October 2026
- **Decided by:** project owner (maglesT), by default (decision record 0004: "go for defaults for any question"). The
  owner asked whether actual formulations of products could be offered for choosing, rather than every company
  loading its own; the default below was proposed and the owner answered "continue".
- **Context:** the demo template (dc-mini) carries an invented paracetamol formula at 100 % label claim. Process
  templates (direct compression, wet and dry granulation, compression IPC, film and sugar coating) are generic and
  ship with the product. A company's formula (composition per unit, overages, the potency basis of the active, batch
  sizes) is part of its registered dossier and confidential; it differs between companies for the same product.

## Decision

1. **Phase 3: a company formulation library.** A site records each registered formula once per product, strength and
   batch size, as master data under change control (two-person approval, versioned, audit-trailed like any master
   data). Creating an MBR from a process template offers "Choose a product": the chosen formula fills the bill of
   materials and its quantities. Every quantity is computed, never typed (INV-25), including the potency-, assay- and
   LOD-adjusted quantity of the active with the compensating excipient (TB-01, function library C-01..C-06): the
   dispensing step shows the adjustment from the lot's certificate values. A formula change after an MBR was approved
   is a new MBR version, as for any master data the MBR pins.
2. **Phase 6: an example generics pack.** 10 to 15 common products built only from public sources (pharmacopoeial
   monographs, published excipient listings, the inactive-ingredient limits FDA publishes), each labelled on every
   screen and printout as an example and not a registered formula. Examples serve training, the sandbox and design
   work; an example cannot be issued for a GMP batch as it is: a site adopts one only by approving it as its own
   formula in the library (1), which makes the site responsible for it matching its dossier. The owner may ask for the
   pack earlier.
3. **Nothing ships with a real company's formula**, and no formula is copied from a non-public source.

## What changes

| Item | Before | Now |
|---|---|---|
| Phase 3 scope (outline section 11) | TB-01..TB-24, master data, lots, ERP stub, LIMS-lite, deviation-lite | Adds the formulation library and "Choose a product" (1). TB-01 is unchanged and is where the potency adjustment is proven (GB-T-01's salt-to-base potency with compensating excipient). |
| Phase 6 scope | Hardening, validation pack, deployment | Adds the example generics pack (2). |
| Demo template dc-mini | Invented formula at 100 % label claim | Unchanged until Phase 3; then it is rebuilt from a library formula with a potency-adjusted active. |
