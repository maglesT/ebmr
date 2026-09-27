# eBMR: Electronic Batch Manufacturing Record system

Two separate products for pharmaceutical manufacturers in India, many of whom export:

- **Tablets edition**: customisable within tablet manufacturing (direct compression, wet and dry granulation, coating, bilayer, blister/strip/bottle packing).
- **Injectables edition**: customisable within sterile injectables (aseptic fill of vials, ampoules and prefilled syringes, freeze-dried products, terminal sterilisation; isolator, RABS, BFS, FFS and single-use technology).

Both editions share one internal compliance core (audit trail, electronic signatures, identity and access, trusted time).
Every batch follows India's **Revised Schedule M**. **US FDA** and **EU GMP** rules are added for each product's export markets, and the stricter rule wins where they differ.

## Status

| Stage | State |
|---|---|
| Regulatory research (India, US FDA, EU GMP) | Done: 678 clause-level requirements, 587 checked against official texts |
| Control catalogs | Done: 241 controls (A data integrity, B production and release, C sterile, D India) |
| Expert review pack (PDF) | Delivered, awaiting the expert's Follow / Don't follow / Modify decisions |
| Edition specs (building blocks, formulas, features, UX, roles) | Done |
| Architecture | Done (web app, TypeScript, PostgreSQL; see `docs/design/architecture.md`) |
| Build outline | In progress (`docs/outline/`) |
| Code | Not started. Starts after the outline is approved |

`PROGRESS.md` holds the running decision log and next steps.

## Repository layout

```
docs/
  regulatory/
    review-pack/          PDF for the external expert (241 controls, sign-off page)
    control-catalogs/     A-D control catalogs (each control traces to register rows nNNN)
    register/             requirements.jsonl: 678 clause-level requirements (stable row numbers)
    verification/         checks of the research against the official texts
    research/             raw research outputs (FDA, EU, Schedule M, processes, features, configurability)
    sources-extracted/    text extracted from the official documents the user supplied
  design/                 architecture, edition specs, features/UX/roles, sample BMR analysis
  outline/                build outline (for approval before coding)
tools/regulatory/         register merge/split/coverage scripts; PDF review-pack builder
```

The scripts in `tools/regulatory/` still point at the working folder they were written in. Making them run from the repo is part of the first build phase.

## Planned stack

Web application in TypeScript end to end (Fastify, Zod, Kysely, React, Vite, XState), with PostgreSQL as the only system of record and a separate database per edition. It will be a pnpm monorepo, with shared packages for the compliance kernel, the calculation language and the recipe engine, plus one app per edition. The full reasoning is in `docs/design/architecture.md`.

## Sources

The files in `docs/regulatory/sources-extracted/` are text extracted from official public documents the project owner downloaded:
- 21 CFR Parts 11 and 211 (eCFR, 24 Sep 2026)
- EudraLex Volume 4: Chapter 4 (2011), Chapter 5 (2015), Annex 1 (2022), Annex 11 (2011)
- FDA guidance: Data Integrity Q&A (2018), Aseptic Processing (2004)
- Revised Schedule M, G.S.R. 922(E), 28 Dec 2023, from a compressed copy with some pages missing

They are kept for verification only. All requirement text in this repository is paraphrased.
