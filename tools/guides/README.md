# tools/guides

The user and administrator guides of Batchwright Tablets ([docs/guides](../../docs/guides/README.md); slice 7e).

- `pnpm guides:lists` writes `docs/guides/reference/permissions.md` (rights, roles and signature meanings, read from a
  database built from the migrations; needs `EBMR_PG_ADMIN_URL`) and `docs/guides/reference/screens.md` (the web app's
  routes and home tiles, parsed from its code).
- `pnpm guides:build` builds each guide into one self-contained HTML file and a PDF in `.reports/guides/` (`--no-pdf`
  for HTML only; the PDF is printed by the browser suite's Chromium).
- `tools/guides/test/guides.test.ts` fails when a reference page is out of date, when a guide names a screen, right,
  signature meaning or database function that does not exist (or a function that checks another right), or when a
  guide's HTML has an anchor that resolves nowhere.

Handbook: [tools-guides](../../docs/handbook/modules/tools.md#tools-guides-the-user-and-administrator-guides-slice-7e)
