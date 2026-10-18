# Incident handling

The incident register (DI-12) keeps every incident of the system: interface failures, lost connections, crashes,
repeated signature failures, time-sync faults, print failures, integrity-check failures, and incidents raised by a
person. Each incident is linked to the records it affects and carries a severity.

## The life of an incident

1. **Raised**, automatically or by a person (`INCIDENT.RAISE`, held by most roles). Each raise and link also writes a
   plain-language entry into the linked record's own audit trail, so the batch's audit-trail review sees it.
2. **Under investigation** (`INCIDENT.INVESTIGATE`): impact assessed per linked record. A linked record stays blocked for
   disposition until the incident is closed or assessed for that record.
3. **Closed** (`INCIDENT.CLOSE`): an incident whose severity was ever major or critical needs a root cause and a CAPA
   reference to close; a downgrade does not avoid it.

Every incident table is insert-only: the current state is derived from the base row and its events, so nothing is ever
overwritten.

| Task | Function | Right |
|---|---|---|
| Raise an incident and link records to it | `records.raise_incident`, `records.link_incident` | `INCIDENT.RAISE` |
| Start the investigation and assess its impact on a record | `records.start_incident_investigation`, `records.assess_incident_impact` | `INCIDENT.INVESTIGATE` |
| Reclassify its severity | `records.reclassify_incident` | `INCIDENT.INVESTIGATE` |
| Close it (root cause and CAPA reference for a major or critical one) | `records.close_incident` | `INCIDENT.CLOSE` |

## The CERT-In reporting step (as built)

A cyber incident in India is reportable to CERT-In within a short window. Batchwright records the step:

| Task | Function | Right |
|---|---|---|
| Mark an incident as reportable to CERT-In | `records.mark_incident_cert_in_reportable` | `INCIDENT.CERT_IN_REPORT` |
| List the reports still due, with their deadlines | `records.pending_cert_in_reports` | none (a read) |
| Record the report made (when, reference) | `records.record_cert_in_report` | `INCIDENT.CERT_IN_REPORT` |

The window is 6 hours from the incident, taken from secondary sources on the CERT-In Directions of April 2022; it is
**not yet verified against the official text** and lives in one function (`records.cert_in_reporting_window`), so it
can be corrected in one place. Confirm it with your legal team. The report itself is made through CERT-In's own channel;
Batchwright records that it was made and when. In v1.0 the register has no screen (see [Known issues](12-known-issues.md)).
