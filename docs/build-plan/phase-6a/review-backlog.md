# Phase 6A review backlog

The residuals of the Phase 6A exit review (slice 6A-7, 17 October 2026; one pass over e0bc24e..ddf3dfe, serious
defects only, decision 0008). Each has a full entry, with what was checked, in the "6A-7 review" subsection of
[phase-6a-plan.md](phase-6a-plan.md). The residuals of the slice quick reviews are in each slice's "as built" section of
the same plan.

Fixed (each in the [defect log](../../handbook/08-defect-log.md)):
- P6A7-1 (high; DI-52, DI-53): the two flag-grouping designs of 6A-4 (key) and 6A-3 (signal) disagreed, and a later
  raise of a dispositioned hit took a fresh verdict without superseding the current one or giving a reason (kernel
  1280, server reads).
- P6A7-2 (high; DI-53): the review priority's audit-trail term was hidden in the server only; the application role read
  it from `analytics.review_priority_v1` and `analytics.output_v1` (kernel 1281).
- P6A7-3 (high; DI-51, DI-52): every completed batch reran every method, and each run's SPC charts, rule flags and rate
  groups held the site's whole history, in insert-only, audited tables (package and runner; no migration).
- P6A5-2 (lead item): QA's FALSE_ALARM on an audit-trail flag key now takes the hit off the review priority (kernel
  1282, package and runner).

Backlog for the owner:
- Medium P6A7-4: a run still reads its whole inputs on the GMP primary (`report.cpp_value_v1` over every GMP batch,
  read by five methods on every completed batch) and sorts and hashes them in the server's event loop. Suggested, when
  a real site's history is measured: a recency bound in the input views (as `report.series_ref_v1` has), or the runner
  on a reporting replica or its own worker process.
- Medium P6A7-5: the flag table still grows by one row per hit and run (now bounded per run, and nightly for the
  audit-trail methods), and the flag views group the whole table on each read. Suggested: measure at a real site; a
  stored group column (on insert) or an index when it matters.
- Low (DI-53) P6A7-6: the score's top reasons are chosen with the audit-trail term among them, so a viewer without
  ANALYTICS.DI_REVIEW can see fewer reasons than the other terms would give, which hints that a term is hidden.
  Suggested: choose the top reasons among the other terms and add the audit-trail reason after them.
- Low (DI-53) P6A7-7: `analytics.method_monitor_v1` and `analytics.run_v1` show the monthly and per-run counts of the
  audit-trail methods' flags to every ANALYTICS.VIEW holder (site-wide counts; no person, rule or entry).
- Low (DI-51) P6A7-8: the runner does not check that its connection is `ebmr_analytics`; a misconfigured
  `EBMR_DB_ANALYTICS_URL` would run it with another role's rights (no server pool checks its role today). Suggested: a
  start-up check of `current_user` and its attributes.
- Low P6A7-9: the audit-trail key leaves out the method version (6A-4's design, kept): a verdict on ATA.RULES
  version 1's key also covers the same hit raised by a later version.
- Carried from 6A-3: two SPC reference sets in force for one chart both chart it, and the screen shows the newest.
