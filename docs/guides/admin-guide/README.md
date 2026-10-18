# Batchwright Tablets: administrator guide

This guide is for the people who install and run Batchwright Tablets: the system administrator
(`SYSTEM_ADMINISTRATOR`), the system / process owner (`PROCESS_OWNER`) and the CSV / data-integrity lead
(`CSV_DI_LEAD`). It covers the installation and its qualification, configuration under change control, people and
their access, devices and gateways, the interfaces, the analytics runner, backups and drills, monitoring, the periodic
evaluation, the validation summary, incidents and the known issues.

An administrator never holds a GMP right: the system refuses a role that mixes administration with GMP work, and an
administration account cannot sign a GMP record (INV-11). Approvals of GMP configuration are QA's.

A section marked **(as planned; checked at 7f)** describes a feature of a slice that is not built yet (the periodic
evaluation pack, the validation summary approval screens, the scheduled reconciliation): it is written from the plan
and is checked against the build at the Phase 7 exit.

| Page | Covers |
|---|---|
| [Installation and the IQ](01-installation-and-iq.md) | What an installation is, its databases and servers, the installation qualification |
| [Configuration and change control](02-configuration-and-change-control.md) | Configuration areas, change records, the configuration history |
| [Users, roles and recertification](03-users-roles-and-recertification.md) | People, accounts, role grants with a second approver, recertification, badges, break-glass, vendor support |
| [Devices, gateways and their keys](04-devices-gateways-and-keys.md) | Terminals and their keys, balances and printers, the site gateway's signing key |
| [Adapters, mutual TLS and the system description](05-adapters-and-system-description.md) | The interfaces, their certificates, the approved system description |
| [The analytics runner](06-analytics-runner.md) | The runner, its database role, method versions and reference sets |
| [Backups, restore and upgrade drills](07-backups-restore-and-upgrade.md) | Backup jobs, the restore procedure and drills, upgrades |
| [Monitoring and the health page](08-monitoring-and-health.md) | Integration health, alarms, time sources |
| [The periodic evaluation pack](09-periodic-evaluation-pack.md) | (as planned; checked at 7f) |
| [The validation summary approval](10-validation-summary-approval.md) | The release identity and QA's approval (approval screens as planned) |
| [Incident handling](11-incident-handling.md) | The incident register and the CERT-In reporting step |
| [Known issues](12-known-issues.md) | What v1.0 does not do yet |

Reference: [Rights, roles and signature meanings](../reference/permissions.md) (generated from the code). The
developer's runbooks are in the handbook: [Operations runbooks](../../handbook/10-runbooks.md).
