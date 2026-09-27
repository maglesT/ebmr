# Phase 1: open questions for the owner and the expert

Collected from the Phase 1 module builds. Each item states the default the build uses today, so nothing is blocked;
the owner (or the expert, where marked) confirms or changes it. Changing a default is a data or policy change, not a
redesign, unless noted. Status: all OPEN.

## Time (module: platform)

| # | Question | Default in the build | Options |
|---|---|---|---|
| T1 | A device with synced time can be slightly ahead of the server. Should a tolerance apply to the rule "claimed time is not later than the server's record time"? | No tolerance: such an entry is refused. | Tolerance equal to the drift alarm threshold (default 1 s). |
| T2 | Which entries count as "late"? | Only times a person claims (typed, or transcribed from paper). Device-buffered times are not late. | Also treat buffered device times as late. |
| T3 | Late-entry window when a step has no planned end. | Fixed interval (policy, default 15 min; allowed 0-1440). | Other value. |
| T4 | Severity of losing every time reference. | MAJOR incident. | CRITICAL. |
| T5 | A server clock stepping back. | Flagged and ordered by counter, no incident. | Raise an incident. |

## Records, retention and incidents (module: records)

| # | Question | Default | Options |
|---|---|---|---|
| R1 | Must MAJOR incidents (not only CRITICAL) have a root cause and CAPA before closure? | Yes; the highest severity the incident ever had counts. | Only CRITICAL. |
| R2 | Data used for a decision (e.g., a result feeding an acceptance limit) classified as DERIVED rather than RAW. | Refused: decision data must be RAW (the DI-01 text). | Allow DERIVED where the raw inputs are kept. |
| R3 | Retention when an input date is missing or no rule applies. | Retention stays OPEN (nothing can be purged). | (QA to confirm.) |
| R4 | Retention for aborted batches and for EU batches never certified (design defaults in outline 3.3.6). | As in the outline. | QA to confirm (expert). |
| R5 | CERT-In 6-hour reporting and the Form 25 / Form 28 retention periods come from secondary sources. | Used, marked "verify". | Confirm against the official texts (expert). |

## Market rules (module: market)

| # | Question | Default | Options |
|---|---|---|---|
| M1 | HEPA filter leak-test interval for Grade A/B: the outline fixes 6 months everywhere (a DESIGN value, which a site cannot loosen), but IN-43's test expects India-only lines to warn at 6 months and block at 12. | 6 months, no loosening. | Keep India-only at warn 6 / block 12 (makes the value loosenable for India-only lines). Expert. |
| M2 | Interpretations in the seed rule data: manufacture + 5 years retention for every licence form; EU test records treated as batch documentation; management review and EU PUPSIT typed as guidance; FDA 2004 aseptic values typed as guidance. | As listed; each row carries a note. | Expert to confirm row by row. |
| M3 | Rule rows whose effective date could not be verified. | 2023-12-28 (Revised Schedule M notification), noted on the row. | Expert to supply dates. |

## Identity and access (module: identity)

| # | Question | Default | Options |
|---|---|---|---|
| I1 | US e-signature certification to FDA (21 CFR 11.100(c)) when a batch includes the US market. | BLOCK issue until the certification record exists (outline position; `proposed_modify` on DI-15). | FLAG only. Expert. |
| I2 | Training gate on execution and verification. | Always a hard block (every site is India-licensed). | Flag-and-review option of DI-21 (not offered today). |
| I3 | Break-glass administration. | Application-level break-glass with second-person approval, CRITICAL alarm, no signing rights, review after the window. Database-superuser break-glass stays an operations procedure. | Confirm. |

## Continuity (module: continuity)

| # | Question | Default | Options |
|---|---|---|---|
| C1 | How much data may be lost in a failure (RPO) and how fast the system must be back (RTO). | Proposals in docs/operations/ha-and-restore.md. | Owner to set. |
| C2 | Backup schedule and write-once (WORM) storage product. | Proposal in the same document. | Owner to choose. |
| C3 | Separation of database administrators from backup-storage administrators. | Recommended (two different people). | Owner to confirm. |
| C4 | A data-only reload into existing tables keeps the database identity and is detected only by the external ledger check. | Documented residual risk. | Accept, or require ledger export after every backup. |

## Roles and permissions (authorization wiring)

| # | Question | Default | Options |
|---|---|---|---|
| A1 | Who publishes market rule tables and who publishes source corrections? | Master-data steward publishes; only the regulatory signer publishes source corrections. | Other split. |
| A2 | Who changes policies and switches (e.g., relaxations)? | QA MBR approver. | Head of QA, process owner. |
| A3 | Who reports incidents to CERT-In? | QA reviewer or CSV/DI lead (not IT administrators). | IT security officer (would need a non-GMP permission). |
| A4 | The CSV/DI lead is treated as a GMP role, so that person can never also be a system administrator. | Yes. | Treat as governance-only. |
| A5 | Service identities (time monitor, backup agent, retention job, interfaces) currently share one role. | Planned split into one role per service in Phase 2 (least privilege). | Keep shared. |
