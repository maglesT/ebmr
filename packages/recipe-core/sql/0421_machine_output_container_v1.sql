-- GENERATED from packages/recipe-core/src/containers/machine.ts by packages/recipe-core/src/lifecycle/write-seeds.ts (kernel state.machineSeedSql). Do not edit.
-- Publishes machine output_container version 1 (aggregate type output_container).
-- A published version is immutable: change the machine by adding a new version and a new migration.
set local role ebmr_owner;

select platform.publish_machine_version($machine$
{
  "machine": "output_container",
  "version": 1,
  "aggregate_type": "output_container",
  "description": "Output container: open, closed, held by an in-process failure over its open interval, sorted, rejected or released by QA (outline 5.2.9, L-30; TB-11)",
  "create_permission": "step.execute",
  "initial": "OPEN",
  "states": [
    "CLOSED",
    "HELD",
    "OPEN",
    "REJECTED",
    "RELEASED_BY_QA",
    "SORTED"
  ],
  "final_states": [
    "REJECTED"
  ],
  "transitions": [
    {
      "from": "CLOSED",
      "event": "HOLD",
      "to": "HELD",
      "guards": [
        "output_container.hold_recorded"
      ],
      "signature": null,
      "permission": "step.execute"
    },
    {
      "from": "HELD",
      "event": "REJECT",
      "to": "REJECTED",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "qa.floor_approve"
    },
    {
      "from": "HELD",
      "event": "RELEASE",
      "to": "RELEASED_BY_QA",
      "guards": [],
      "signature": "OUTPUT_CONTAINER_RELEASED",
      "permission": "qa.floor_approve"
    },
    {
      "from": "HELD",
      "event": "SORT",
      "to": "SORTED",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "step.execute"
    },
    {
      "from": "OPEN",
      "event": "CLOSE",
      "to": "CLOSED",
      "guards": [
        "output_container.closed"
      ],
      "signature": null,
      "permission": "step.execute"
    },
    {
      "from": "RELEASED_BY_QA",
      "event": "HOLD",
      "to": "HELD",
      "guards": [
        "output_container.hold_recorded"
      ],
      "signature": null,
      "permission": "step.execute"
    },
    {
      "from": "SORTED",
      "event": "REJECT",
      "to": "REJECTED",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "qa.floor_approve"
    },
    {
      "from": "SORTED",
      "event": "RELEASE",
      "to": "RELEASED_BY_QA",
      "guards": [],
      "signature": "OUTPUT_CONTAINER_RELEASED",
      "permission": "qa.floor_approve"
    }
  ],
  "definition_hash": "38d426f7870dc1d696791ce385c7752e5afeaebabd093b5da22c84e0210cf973"
}
$machine$::jsonb);

reset role;
