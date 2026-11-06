# Migrations of the API edition (`substance` namespace)

The API edition's own SQL (`docs/build-plan/api/plan.md`, `platform-fit.md`; handbook page
`docs/handbook/modules/substance.md`). The files run after the `tablets` namespace in the product `ebmr`'s one
database. The lead reserved the numbers 5000 to 5999 for them. A rule here fires only on records of the `substance`
edition and never changes how tablets or injectables behave. The edition list itself is shared (kernel 1403
`kernel.editions()`) and is not changed here.

| Migration | What |
|---|---|
| 5000 | The schema `substance`; the row that lets the library pack block API-PACK complete an API packaging record; the API edition's G-REL hook (`substance.grel_edition_items`: the existing tablets items that fit any packaging order, plus the drums or bags examined) |
