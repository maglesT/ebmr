# Batchwright developer handbook

![Batchwright Tablets](../brand/batchwright-tablets.svg)

by ![Medhanta](../brand/medhanta-logo-278x148.png)

**Batchwright by Medhanta**: the electronic batch manufacturing record system, editions Tablets and Injectables
(decision [0020](../decisions/0020-product-name-batchwright.md)). In the code and in this handbook it keeps its working
name, eBMR: the packages, schemas, environment variables and the `ebmr` prefix do not change. The product's users and
administrators have their own guides: [docs/guides](../guides/README.md).

Start here if you are a developer joining this project. The handbook explains what the software does, why
(the pharma rules behind it), and how the code does it. You do not need to know pharma: the primer and the glossary
explain every term. Owner decisions 0013 (the handbook) and 0014 (the code map) set what it holds.

Status (14 October 2026): Phases 1 to 4 are being documented. A page marked **Draft** is still being written.

## Reading order

1. [Pharma for developers](01-pharma-primer.md): what a batch record is, why GMP, who signs what, release, deviations,
   recalls. Read this first if "batch record" or "QP" means nothing to you.
2. [Glossary](02-glossary.md): every pharma, regulatory and project term used in the code (G-REL, AP, QP, INV-xx, ...).
3. [Architecture](03-architecture.md): packages, boundaries, where the rules live (mostly in PostgreSQL), how a
   request travels from screen to database.
4. [The life of a batch](04-life-of-a-batch.md): one batch from master record to release, recall and archive, step by
   step, with the screens, routes, database functions and triggers each step passes through.
5. The module guides in [modules/](modules/): one page per package or app.
6. [Database reference](05-database.md): migrations, security conventions, the function and trigger catalogue.
7. [Testing and debugging](06-testing-and-debugging.md): test layers, golden batches, browser suite, mutation runs,
   CI failures with this project's real cases.
8. [How to add a feature safely](07-adding-a-feature.md): a worked example.
9. [Defects and lessons](08-defect-log.md) and [Removed and replaced](09-removed-and-replaced.md): the history.
10. [Operations runbooks](10-runbooks.md).

Generated reference (do not edit by hand; run `pnpm handbook`):

- [Code map](code-map.md): every module with its migrations, database functions and triggers, server files, routes,
  contract file, screens, tests and controls.
- [Database catalogue](reference/db-catalogue.md): every function and trigger, where it is defined and replaced.
- [Control-to-code map](reference/control-map.md): each control with the code and tests that carry it.
- [Error codes](reference/error-codes.md): every `EBMR-...` code and where it is raised.

The module list behind the generated pages is [modules.yaml](modules.yaml). Writing rules: [STYLE.md](STYLE.md).

## Module guides

| Page | Covers |
|---|---|
| [analytics](modules/analytics.md) | `packages/analytics`: advisory analytics (Phase 6A; the page arrives at the 6A exit): methods, the analytics role and schema |
| [kernel](modules/kernel.md) | `packages/kernel`: identity, access, e-signatures, audit trail, time, records, market rules, sandbox |
| [site-services](modules/site-services.md) | `packages/site-services`: batch numbers, lots, deviations, specifications, LIMS-lite, ERP masters |
| [expr](modules/expr.md) | `packages/expr`: the calculation language (exact decimals, units, rounding) |
| [recipe-core](modules/recipe-core.md) | `packages/recipe-core`: flows, validator, execution, limits, MBR life cycle, review, release |
| [api-contract](modules/api-contract.md) | `packages/api-contract`: the route table and the request and response shapes |
| [tablets-server](modules/tablets-server.md) | `apps/tablets-server`: the Tablets edition's server, its features and its migrations |
| [tablets-web](modules/tablets-web.md) | `apps/tablets-web`: the Tablets edition's screens |
| [record-viewer](modules/record-viewer.md) | `apps/record-viewer`: the stand-alone, offline viewer of a full export (verifies, then shows, read-only) |
| [integrations](modules/integrations.md) | `packages/integration-sdk`, `apps/site-gateway`, `apps/simulators` |
| [shared-kits](modules/shared-kits.md) | `packages/ui-kit`, `packages/test-kit`, `packages/validation-kit` |
| [validation-kit](modules/validation-kit.md) | `packages/validation-kit`: the evidence bundle and the validation pack generators (Phase 7) |
| [injectables](modules/injectables.md) | `apps/injectables-*`: placeholders for Phase 5 |
| [substance](modules/substance.md) | `editions/substance`: the API edition's migrations, its pack block and its release items |
| [tools](modules/tools.md) | `tools/*`: register, boundaries, SQL mutation, demo, end-to-end suite, handbook |
| [tools-validation](modules/tools-validation.md) | `tools/validation`: the evidence bundle, the pack, the IQ and OQ scripts, the build statuses |
