# Batchwright Tablets guides

![Batchwright Tablets](../brand/batchwright-tablets.svg)

by ![Medhanta](../brand/medhanta-logo-278x148.png)

Batchwright is the electronic batch manufacturing record system by Medhanta. These are its two guides for the
Tablets edition, for the people who use and run it. The developer handbook is separate:
[docs/handbook](../handbook/README.md).

| Guide | For whom |
|---|---|
| [User guide](user-guide/README.md) | Everyone who works in Batchwright: the shop floor, QA, the authorised person, master data, MBR authors, the data-integrity lead, the controlled-substance roles |
| [Administrator guide](admin-guide/README.md) | The system administrator, the system owner and the CSV / data-integrity lead: installation, configuration, access, devices, interfaces, backups, monitoring, validation and incidents |

Generated reference, shared by both guides (do not edit by hand; run `pnpm guides:lists`):

- [Rights, roles and signature meanings](reference/permissions.md): every right the system checks, the roles that hold
  it, and the meaning of every electronic signature.
- [Screens](reference/screens.md): every screen by its address, with the home tile that opens it.

**Building the guides.** `pnpm guides:build` writes each guide as one self-contained HTML file and a PDF into
`.reports/guides/` (`--no-pdf` for the HTML only). The PDF is printed by the browser suite's Chromium. The files are
not committed; they are rebuilt from these pages.

**Your records are yours.** Batchwright shows its name and the Medhanta logo on its own screens only: the sign-in
page, the header and the about page. A batch record, true copy, label, report or certificate carries your company's
name and site, never ours (decision 0020).
