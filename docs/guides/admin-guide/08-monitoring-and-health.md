# Monitoring and the health page

## The integration health page

**Integration health** (`/integrations`) lists every registered adapter with its last message, the age of its data, its
open alarms and its last reconciliation; one adapter's page (`/integrations/$adapterCode`) shows its newest messages
and its newest refusals. An adapter that cannot start (for example EBMR-INT-034, mutual TLS missing off loopback) shows
its worker BLOCKED with the reason.

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| See the health of every adapter | `/integrations` | `RECORD.READ` | none |
| See one adapter's messages and refusals | `/integrations/$adapterCode` | `RECORD.READ` | none |
| Clear a platform alarm once its cause is fixed (DI lead) | the platform interface | `PLATFORM.ALARM_CLEAR` | none |

## Alarms

| Alarm source | Where it shows | Who acts |
|---|---|---|
| Integration alarms (sequence gap, out of order, wrong identity, reconciliation mismatch) | `/integrations` | the system owner and the DI lead |
| Process alarms from the equipment (OPC UA) and the EMS | `/alarms` | the shop floor (acknowledge with the action taken) |
| Batchwright's own alarms (for example a test package not reaching the sandbox) | `/alarms` | the system administrator |
| Continuity alarms (a failed backup) | the continuity interface | the system administrator |

## Time

Every record's time is the database's clock, shown in the site's time zone. The time sources the site trusts are
registered (`PLATFORM.TIME_SOURCE_MANAGE`) and validated by the DI lead (`PLATFORM.TIME_SOURCE_VALIDATE`); the time
checks are recorded by the platform's service account (`PLATFORM.TIME_CHECK_RECORD`). A time-sync fault raises an
incident ([Incident handling](11-incident-handling.md)).

## Dashboards

**Dashboards** (`/dashboards`) and the **Equipment status board** (`/status-board`) give the plant's state at a glance.
A line-status display account (`STATUS_DISPLAY`) can show the status board on a screen on the floor; it can only read.
