# How to write the handbook

## Language

- Easy English. Short sentences, plain words. One idea per sentence.
- Explain each pharma or technical term the first time a page uses it, and link it to the [glossary](02-glossary.md).
- Use the demo data for examples: GB-T-01 (wet granulation, blisters, India) and GB-T-02 (direct compression,
  bottles, US added after vendor history INELIGIBLE). See `apps/tablets-server/test/golden/`.
- Paraphrase regulations in plain words. Never paste regulation text beyond a short phrase. Cite the clause
  (for example "21 CFR 11.10(e)", "EU GMP Annex 11 section 9", "Schedule M") and say what it means for the code.
- No model names, no people's names except the owner role.

## "Why this exists" box

Every guard (a database function, trigger, constraint or server check that refuses something) gets one:

> **Why this exists**
> - **Pharma reason:** a person who wrote a record must not approve it (four-eyes principle).
> - **Control:** [DI-01](../../compliance/controls/DI-01.yaml), invariant INV-03.
> - **Code:** [`records.approve_record_type`](../../packages/kernel/sql/0400_records_register.sql#sym=records.approve_record_type)
> - **Tests:** [register.test.ts](../../packages/kernel/test/records/register.test.ts), tests named `[DI-01]`.
> - **Error:** `EBMR-REC-017`.

## Links (checked by a test)

- Link files with relative Markdown links: `[0230_esig_sign.sql](../../packages/kernel/sql/0230_esig_sign.sql)`.
- Link a function, trigger, type or constant with the fragment `#sym=<name>`:
  `[esig.sign](../../packages/kernel/sql/0230_esig_sign.sql#sym=esig.sign)`. The link checker fails when the file
  does not define `<name>` (SQL `create [or replace] function|procedure|trigger|view|table <name>`, TypeScript
  `function|const|class|interface|type|enum <name>` or `export`). For a SQL function replaced by later migrations,
  link the migration that holds the version in force (the [database catalogue](reference/db-catalogue.md) lists it).
- Do not use line-number links (`#L12`); they drift.
- Link controls to their YAML file: `[DI-01](../../compliance/controls/DI-01.yaml)`.

## Page shape

- Title, then one paragraph: what the page covers and who should read it.
- **Draft** at the top until the page is complete.
- A "Where the code is" section near the top with links.
- Diagrams in Mermaid (` ```mermaid `), so they render on GitHub and are diffable.
- Keep each module guide's sections: what it does; pharma context; main tables; main functions and guards (with
  "Why this exists" boxes); state machines; how to test it; pitfalls; related pages.

## Generated pages

`code-map.md` and everything in `reference/` are written by `pnpm handbook` from the repository (migrations, the route
table, the contract, the control register and `modules.yaml`). Never edit them by hand; `pnpm handbook:check` (and a
test) fails when they are out of date.
