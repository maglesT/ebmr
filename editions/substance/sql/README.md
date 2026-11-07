# Migrations of the API edition (`substance` namespace)

The API edition's own SQL (`docs/build-plan/api/plan.md`, `platform-fit.md`; handbook page
`docs/handbook/modules/substance.md`). The files run after the `tablets` namespace in the product `ebmr`'s one
database. The lead reserved the numbers 5000 to 5999 for them. A rule here fires only on records of the `substance`
edition and never changes how tablets or injectables behave. The edition list itself is shared (kernel 1403
`kernel.editions()`) and is not changed here.

| Migration | What |
|---|---|
| 5000 | The schema `substance`; the row that lets the library pack block API-PACK complete an API packaging record; the API edition's G-REL hook (`substance.grel_edition_items`: the existing tablets items that fit any packaging order, plus the drums or bags examined) |
| 5003 | The AS controls of slice A1 (AS-01 to AS-10, AS-14 to AS-16, AS-18, AS-24) in the names a test run may cite (`recipe.engine_name`), kept equal to the control register |
| 5004 | `substance.post_intermediate_lot`: a processing batch of the API edition posts its output as an INTERMEDIATE lot (site-services 1732) |
| 5005 | The certificate of analysis of a released API lot (plan C3, AS-17): `substance.coa_document` reads it from the records, `substance.prepare_coa` keeps it as a true copy, `substance.sign_coa` records the quality unit's COA_APPROVED signature (new vendor meaning, right RELEASE.MANUFACTURER); `substance_coa` is a RECORD-class record of the tablets read class |
