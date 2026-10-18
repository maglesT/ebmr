# The periodic evaluation pack (as planned; checked at 7f)

This section is written from the plan of slice 7b-2 (DI-11 clause 1, DI-44 clause 1) and is checked against the build at
the Phase 7 exit.

A computerised system is evaluated periodically: is it still in its validated state, and does it still do what it
should? For a chosen period the installation generates the **evaluation pack**:

- the changes and the configuration changes of the period;
- the deviations and incidents linked to the system;
- the audit-trail reviews done;
- the access recertifications;
- the backups and the restore drills;
- the alarms of the integrations;
- the open known issues.

Each entry names its source log and row, so a reviewer can trace it back. The pack is read through the reporting path
(`ebmr_report`), stored with its hash, and signed off by QA with a signature bound to that hash.

Part of the same pack is the **periodic readability report**: a sample of closed records (seeded, so the sample can be
repeated), each opened and rendered with its audit trail, with the result and the render hash listed per record. It
shows that old records can still be read in full.

| Task | Screen | Right | Signature meaning |
|---|---|---|---|
| Record the periodic review of the system (system owner) | the platform interface | `SYSTEM.PERIODIC_REVIEW` | none |
| Generate the pack for a period, and have QA sign it off | (as planned; checked at 7f) | (as planned) | (as planned) |

The procedure for running the evaluation will be in the handbook's runbooks when slice 7b-2 lands.
