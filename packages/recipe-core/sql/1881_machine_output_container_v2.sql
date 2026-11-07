-- GENERATED from packages/recipe-core/src/containers/machine.ts by packages/recipe-core/src/lifecycle/write-seeds.ts (kernel state.machineSeedSql). Do not edit.
-- Handbook: modules/recipe-core.md
-- Publishes machine output_container version 2 (aggregate type output_container).
-- A published version is immutable: change the machine by adding a new version and a new migration.
set local role ebmr_owner;

select platform.publish_machine_version($machine$
{
  "machine": "output_container",
  "version": 2,
  "aggregate_type": "output_container",
  "description": "Output container, version 2: as version 1, and the quality unit holds a closed or released container of its own decision, with its reason (ICH Q7 2.22, 14.40; AS-21)",
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
      "from": "CLOSED",
      "event": "QA_HOLD",
      "to": "HELD",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "qa.floor_approve"
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
      "from": "RELEASED_BY_QA",
      "event": "QA_HOLD",
      "to": "HELD",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "qa.floor_approve"
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
  "definition_hash": "1a025c8e9e53b077249eb51aa5076b5ec3902ede8eda494b184d123e97e9cb0c"
}
$machine$::jsonb);

reset role;
