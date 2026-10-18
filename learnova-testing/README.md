# Learnova testing inputs (transfer branch; not part of the Batchwright eBMR; never merge)

- learnova-compliance-requirements.md: the minimum compliance requirements LMS-01 to LMS-29.
- org_test_data_20_managers_80_employees.csv: test organisation (100 people, example.com).
- learnova-test-prompt.md: the test instructions and the shared-demo rules.

## Browser set-up in a cloud session (from a first attempt)

- Install Playwright in a scratch folder: `npm i playwright@1.56.1` (browser download is skipped by
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD; Chromium is at PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers; never `playwright install`).
- Launch headless Chromium with `proxy: { server: process.env.HTTPS_PROXY }`; TLS passes with no extra flags.
- `scripts/lib.mjs` is a helper from the first attempt: fix its Playwright import path to your install.
- Nothing was created on the portal by the first attempt (it only opened the landing page).
