-- GENERATED from packages/kernel/src/state/machines/sample-record.ts by packages/kernel/src/state/write-seeds.ts. Do not edit.
-- Publishes machine sample_record version 1 (aggregate type sample_record).
-- A published version is immutable: change the machine by adding a new version and a new migration.
set local role ebmr_owner;

select platform.publish_machine_version($machine$
{
  "machine": "sample_record",
  "version": 1,
  "aggregate_type": "sample_record",
  "description": "Sample controlled-record life cycle proving the state-machine engine (Phase 1)",
  "initial": "DRAFT",
  "states": [
    "APPROVED",
    "CHECKED",
    "DRAFT",
    "RETIRED",
    "SUBMITTED",
    "SUPERSEDED"
  ],
  "final_states": [
    "RETIRED",
    "SUPERSEDED"
  ],
  "transitions": [
    {
      "from": "APPROVED",
      "event": "RETIRE",
      "to": "RETIRED",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "sample_record.retire"
    },
    {
      "from": "APPROVED",
      "event": "SUPERSEDE",
      "to": "SUPERSEDED",
      "guards": [],
      "signature": null,
      "permission": "sample_record.approve"
    },
    {
      "from": "CHECKED",
      "event": "APPROVE",
      "to": "APPROVED",
      "guards": [],
      "signature": "APPROVED",
      "permission": "sample_record.approve"
    },
    {
      "from": "CHECKED",
      "event": "RETURN",
      "to": "DRAFT",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "sample_record.approve"
    },
    {
      "from": "DRAFT",
      "event": "SUBMIT",
      "to": "SUBMITTED",
      "guards": [
        "sample_record.has_body"
      ],
      "signature": null,
      "permission": "sample_record.submit"
    },
    {
      "from": "SUBMITTED",
      "event": "CHECK",
      "to": "CHECKED",
      "guards": [],
      "signature": "CHECKED",
      "permission": "sample_record.check"
    },
    {
      "from": "SUBMITTED",
      "event": "RETURN",
      "to": "DRAFT",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "sample_record.check"
    }
  ],
  "definition_hash": "e5cc37742b6c50bf314c788241c6549efe5eacf3020a3d3619d7f2442d940219"
}
$machine$::jsonb);

reset role;
