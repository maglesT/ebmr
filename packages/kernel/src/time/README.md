# Trusted time (kernel module B5, part 1)

Build outline 5.6; control **DI-27**; invariant **INV-16**. Schema `platform`, migrations
`packages/kernel/sql/0500`, `0520`, `0530`. Tests: `packages/kernel/test/platform/{time-model,site-time,drift-monitor}.test.ts`.

This is the only place in `src` that may read the JavaScript clock. It does not need to: every GMP
time comes from the database clock (`clock_timestamp()`).

## Two times per event (INV-16)

| Column | Set by | Meaning |
|---|---|---|
| `recorded_at` | database, always | When the entry was committed. Authoritative for ordering and audit. |
| `occurred_at` + `occurred_trust` | caller, optional | Claimed or source time: `DEVICE_SYNCED`, `DEVICE_UNSYNCED`, `USER_CLAIMED`, `PAPER`. |

- **How the database time is enforced.** Every event-time column has `default clock_timestamp()` and is
  registered with `platform.enforce_db_time(table, columns)` (migrations only). Its trigger overwrites any
  supplied value on insert and keeps the stored value on update. The application role gets
  column-level INSERT grants that leave these columns out, so supplying one is refused outright.
  `platform.time_model_violations()` is the invariant query and must return no rows.
- **`platform.check_occurred_at(occurred_at, trust, step_started_at, recorded_at)`**: the event time must
  lie between the step start and `recorded_at`, and a trust level must go with it.
  `platform.check_step_order(event_at, previous_at, next_at)` keeps the items of a step in order.
- **`platform.time_basis(occurred_at, trust, recorded_at)`**: the time that drives time constraints. It is
  `occurred_at` only when the trust is `DEVICE_SYNCED`, otherwise `recorded_at`. Tables store the
  choice in `time_basis` and `time_basis_at`.
- **Late entries.** A person-claimed time (`USER_CLAIMED`, `PAPER`) makes an entry late.
  `platform.assess_late_entry(...)` returns `is_late`, `window_ends_at` and `beyond_window`, and
  `platform.check_late_entry(...)` enforces the rules:
  - a late entry needs a reason (EBMR-PLAT-015);
  - beyond the window it needs a supervisor co-signature with meaning `LATE_ENTRY_APPROVED`,
    verified through the SIGNATURE hook (EBMR-PLAT-016, 007, 008);
  - one co-signature approves one entry only (076 in the demo table).

  The window is set by the policy values `time.late_entry_window_mode` (`PLANNED_STEP_END` by default,
  or `FIXED_INTERVAL`) and `time.late_entry_window_min` (default 15).
- **Status guards at both instants.** `platform.guard_instants(occurred_at, trust, recorded_at)` in SQL and
  `guardInstants` / `evaluateAtInstants` in TypeScript return the instants to evaluate. If any
  evaluation fails, the caller raises a GMP exception (`exceptionRequired`).
- **Monotonic order.** `platform.next_aggregate_seq(type, id, recorded_at)` (owner-only; call it from
  triggers) gives each aggregate event the next counter value. A `recorded_at` earlier than the
  aggregate's latest one is returned as `regressed` and logged in `platform.time_anomaly`.
- **Demonstration of the pattern.** `platform.stub_step` and `platform.stub_step_entry` show how block
  tables will apply all of the above. Their trigger `platform.stub_step_entry_time_model()` sets
  `review_flags` to any of `LATE_ENTRY`, `LATE_BEYOND_WINDOW`, `DEVICE_TIME_UNSYNCED`,
  `CLOCK_REGRESSION` and `TIME_FAULT_WINDOW`.

## Site time (`site-time.ts`, `instant.ts`)

- `Instant` holds bigint microseconds since the epoch in UTC (the database's precision). Durations are
  bigint microseconds, taken from UTC instants, so a daylight-saving change cannot distort them.
- `siteTime(instant, zone)` returns `YYYY-MM-DD HH:MM:SS +HH:MM (Zone)`. It uses Intl only, and the
  result does not depend on the browser, the process time zone or the local clock. SQL
  `platform.site_time_text` returns the same text; a test compares the two around DST changes.
- `siteCalendarDay` and `platform.site_calendar_day` give the site-local day for "daily" rules.
- A zone must be an IANA `Area/Location` name or `UTC` (`isValidTimeZone`, `platform.is_valid_time_zone`).
  `IST`, `EST` and bare offsets are refused.

## Drift monitor (`drift-monitor.ts`, migration 0520)

- **Time sources.** `platform.time_source` is a validated configuration item: kind NTP, endpoint, a
  reference such as NPL or NIC traceability, validated_by and a validation reference. Sources are
  added with `platform.register_time_source` and switched with `platform.set_time_source_active`,
  both requiring the permission `platform.time_source.manage`. The table is audited.
- **Running a check.** `runDriftCheck(pool, { node, actor, references })` reads each injected
  `TimeReference`. It computes the offset against the database clock, bracketing each read with
  `clock_timestamp()`, and calls `platform.record_drift_check`. That function stores an insert-only,
  audited sample for every active source.
- **Alarms and incidents.** Each condition raises one alarm while it lasts:

  | Alarm | Raised when | Incident requested |
  |---|---|---|
  | `DRIFT_EXCEEDED` | a reachable source's absolute offset is above `time.drift_alarm_threshold_s` (default 1 s, allowed 0.1-5 s) | yes |
  | `REFERENCE_LOST` | no source can be reached | yes |
  | `NO_TIME_SOURCE` | no source is active | yes |
  | `REFERENCE_DEGRADED` | fewer sources are reachable than `time.min_references` (default 2) | no |

  An alarm clears once its condition is gone. `platform.clear_alarm` clears one by hand and needs a
  reason plus the permission `platform.alarm.clear`.
- **Incident hook.** `platform.raise_time_incident(kind, node, severity, details)` writes the alarm and
  the outbox message `incident.requested` (payload: `incident_type` DATA_INTEGRITY, `incident_source`
  TIME_SYNC, severity, alarm id, window start). The lead wires this message to
  `records.raise_incident`.
- **Flagging entries.** `platform.time_fault_windows()` spans from the last good sample to the
  clearance. `platform.entries_in_time_fault_windows()` lists every audited GMP entry recorded in a
  window, for review. Capture is never blocked; entries made while a fault is open carry
  `TIME_FAULT_WINDOW`.

## Calling it from other modules

- A GMP table with an event time:
  - declare `recorded_at timestamptz not null default clock_timestamp()` and call
    `select platform.enforce_db_time('<schema>.<table>', array['recorded_at'])` in the migration;
  - grant INSERT on explicit columns only;
  - add `occurred_at timestamptz` and `occurred_trust platform.time_trust` where a claimed time is
    meaningful;
  - call `check_occurred_at`, `time_basis`, `assess_late_entry` and `check_late_entry` from its
    BEFORE INSERT trigger, as `stub_step_entry_time_model` does.
- Display: `siteTime(Instant.parse(row.recorded_at_text), siteZone).display`.
