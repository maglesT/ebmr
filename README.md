# Phase 6 mutation campaign: raw reports (decision 0019)

Backup of the campaign's working reports, pushed every 30 minutes while it runs, so a pod restart resumes with
`--resume` (SQL harness) or the incremental files (Stryker) instead of starting over. Not for merging; the results
are written up in `docs/build-plan/phase-6/mutation-results.md` on the Phase 6 branch.

- `sql-mutation/<stream>/report.json`, `summary.md`, `<stream>.log`: copy back to `.reports/sql-mutation/`.
- `stryker-phase6/<feature>.json`, `<feature>.incremental.json`, `<feature>.log`: copy back to `.reports/stryker-phase6/`.
