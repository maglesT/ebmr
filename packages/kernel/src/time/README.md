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
- **The trust is not the caller's word.** `platform.check_time_trust_source(trust)` refuses a device time
  (`DEVICE_SYNCED`, `DEVICE_UNSYNCED`) unless the validated command comes from a machine identity: an
  instrument interface or gateway, source `INTEGRATION` or `SYSTEM`, which only service and integration
  accounts can use (EBMR-PLAT-009). A person (source `UI` or `API`) typing a time, even one read off an
  instrument display, states `USER_CLAIMED` (or `PAPER`) and goes through the late-entry rules below.
  `mayClaimTrust(source, trust)` mirrors it in TypeScript.
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
- **Site zone of an entry.** `platform.entry_site_zone()` returns the site's zone (`kernel.site_zone()`, the
  identity module's policy `site.zone`), never a zone the client declares, and refuses a command whose
  context declares another zone (EBMR-PLAT-023), as e-signatures do (EBMR-ESIG-035). The stored offset
  and the site-local calendar day therefore always belong to the site (DI-27).
- **Demonstration of the pattern.** `platform.stub_step` and `platform.stub_step_entry` show how block
  tables will apply all of the above. Their trigger `platform.stub_step_entry_time_model()` sets
  `review_flags` to any of `LATE_ENTRY`, `LATE_BEYOND_WINDOW`, `DEVICE_TIME_UNSYNCED`,
  `CLOCK_REGRESSION` and `TIME_FAULT_WINDOW`. `platform.refuse_administrator()` keeps administrators
  out of them (DI-18, EBMR-IAM-042).

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
  reference such as NPL or NIC traceability, validated_by and a validation reference. No person alone
  decides which references the monitor trusts (DI-27, DI-24):
  - `platform.register_time_source(...)` (permission `platform.time_source.manage`, the system
    administrator) records a pending registration in `platform.time_source_registration`, naming the
    validator: an active person other than the registrant (EBMR-PLAT-033). The monitor does not use it.
  - `platform.confirm_time_source(registration_id)`: the named validator, holding
    `platform.time_source.validate` (the CSV / data-integrity lead, kernel 0900), confirms it in their
    own command (EBMR-PLAT-034 for anyone else). Only then does the source exist in
    `platform.time_source`, active, with `validated_by` taken from that command.
  - `platform.set_time_source_active` switches a source with `platform.time_source.manage` and a reason;
    a deactivation that leaves fewer active sources than `time.min_references` needs
    `platform.time_source.validate` instead (EBMR-PLAT-035).
  All three tables are audited on the chain `time_source:<id>`.
- **Running a check.** `runDriftCheck(pool, { node, actor, references })` reads each injected
  `TimeReference`. It computes the offset against the database clock, bracketing each read with
  `clock_timestamp()`, and calls `platform.record_drift_check`. That function stores an insert-only,
  audited sample for every active source. The default read timeout is twice the threshold
  (`defaultReadTimeoutMs`): a slower read cannot give a usable reading.
- **What a reading proves.** Offsets and uncertainties are stored exactly as measured (no precision
  limit, so a clock reset to 1970 alarms instead of overflowing). The threshold keeps the three
  decimals its setting allows (`max_scale`). Each sample stores three verdicts, computed from the
  stored values and held to them by check constraints:
  - `within_threshold`: |offset| + uncertainty is within the threshold, which proves the clock was good;
  - `over_threshold`: |offset| is above the threshold and the reading is conclusive;
  - `usable`: the uncertainty is within the threshold, or even |offset| - uncertainty is above it. A
    reading that is too uncertain proves nothing: it neither raises nor clears an offset alarm, and it
    counts as no usable reference.
- **Alarms and incidents.** Each condition raises one alarm while it lasts:

  | Alarm | Raised when | Clears when | Incident requested |
  |---|---|---|---|
  | `DRIFT_EXCEEDED` | a usable reading is over `time.drift_alarm_threshold_s` (default 1 s, allowed 0.1-5 s) | every usable reading proves the clock within it | yes |
  | `REFERENCE_LOST` | no usable reading | a usable reading | yes |
  | `NO_TIME_SOURCE` | no source is active | a source is active | yes |
  | `REFERENCE_DEGRADED` | fewer usable readings than `time.min_references` (default 2) | enough usable readings | no |

  Only `record_drift_check` raises and clears these, from recorded readings. `platform.report_time_fault`
  lets a time service (source SYSTEM, `platform.time_check.record`) report a fault the monitor does not
  evaluate (today `CLOCK_REGRESSION`; EBMR-PLAT-036 for the monitored kinds), so nobody can raise an
  alarm early and keep the monitor from raising its own. `platform.clear_alarm` clears such an alarm by
  hand and needs a reason plus the permission `platform.alarm.clear`.
- **Incident hook.** `platform.raise_time_incident(kind, node, severity, details)` (owner only) writes the
  alarm, raises the data-integrity incident (kernel 0900) and the outbox message `incident.requested`.
- **Flagging entries.** `platform.time_fault_windows()` spans from the last good sample to the
  clearance. It is bounded by audit positions (`platform.audit_position()`, the highest audit-event id
  handed out): each sample records it, an alarm starts at its last good sample's position and a
  clearance records the position when it was made. `platform.entries_in_time_fault_windows()` lists
  every audited GMP entry whose audit event lies in that range, for review, whatever time the faulty
  clock stamped on it, so entries recorded across a clock step are listed too. Capture is never
  blocked; entries made while a fault is open carry `TIME_FAULT_WINDOW`.
- **A silent monitor.** `platform.time_monitor_violations()` (must return no rows) reports every node
  whose newest check is older than `time.drift_check_max_age_s` (default 300 s).

## Calling it from other modules

- A GMP table with an event time:
  - declare `recorded_at timestamptz not null default clock_timestamp()` and call
    `select platform.enforce_db_time('<schema>.<table>', array['recorded_at'])` in the migration;
  - grant INSERT on explicit columns only;
  - add `occurred_at timestamptz` and `occurred_trust platform.time_trust` where a claimed time is
    meaningful;
  - call `check_occurred_at`, `check_time_trust_source`, `time_basis`, `assess_late_entry` and
    `check_late_entry` from its BEFORE INSERT trigger, and store `entry_site_zone()`, as
    `stub_step_entry_time_model` does.
- `platform.time_model_violations()` must return no rows for the whole installation. A registered
  column is checked for its forcing trigger, default and privileges. An audited table's unregistered
  `recorded_at` is reported when the application role may write it or its default is not the database
  clock.
- Display: `siteTime(Instant.parse(row.recorded_at_text), siteZone).display`.
