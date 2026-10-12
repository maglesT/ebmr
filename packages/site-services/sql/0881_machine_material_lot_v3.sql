-- GENERATED from packages/site-services/src/lots/machine.ts by packages/site-services/src/lots/write-seeds.ts (kernel state.machineSeedSql). Do not edit.
-- Publishes machine material_lot version 3 (aggregate type material_lot).
-- A published version is immutable: change the machine by adding a new version and a new migration.
set local role ebmr_owner;

select platform.publish_machine_version($machine$
{
  "machine": "material_lot",
  "version": 3,
  "aggregate_type": "material_lot",
  "description": "Material lot usage status, version 3: as version 2, and a released finished lot is recalled or rejected after release, and a rejected one disposed of, only by the release model's recorded acts (outline 5.2.6; L-19, PR-46, IN-05 (e))",
  "create_permission": "material.handle",
  "initial": "QUARANTINE",
  "states": [
    "CONSUMED",
    "DESTROYED",
    "ON_HOLD",
    "QUARANTINE",
    "RECALLED",
    "REJECTED",
    "RELEASED",
    "RELEASED_FOR_FURTHER_PROCESSING",
    "RETURNED"
  ],
  "final_states": [
    "CONSUMED",
    "DESTROYED"
  ],
  "transitions": [
    {
      "from": "ON_HOLD",
      "event": "RECALL",
      "to": "RECALLED",
      "guards": [
        "material_lot.command_recorded",
        "platform.reason_given"
      ],
      "signature": "MATERIAL_LOT_STATUS_DECIDED",
      "permission": "material.qa_disposition"
    },
    {
      "from": "ON_HOLD",
      "event": "REJECT",
      "to": "REJECTED",
      "guards": [
        "material_lot.command_recorded",
        "platform.reason_given"
      ],
      "signature": "MATERIAL_LOT_REJECTED",
      "permission": "material.qa_disposition"
    },
    {
      "from": "ON_HOLD",
      "event": "RELEASE_RECALL",
      "to": "RECALLED",
      "guards": [
        "material_lot.command_recorded",
        "material_lot.after_release_decision"
      ],
      "signature": null,
      "permission": "release.manufacturer"
    },
    {
      "from": "ON_HOLD",
      "event": "RELEASE_REJECT",
      "to": "REJECTED",
      "guards": [
        "material_lot.command_recorded",
        "material_lot.after_release_decision"
      ],
      "signature": null,
      "permission": "release.manufacturer"
    },
    {
      "from": "ON_HOLD",
      "event": "RETURN",
      "to": "RETURNED",
      "guards": [
        "material_lot.command_recorded",
        "platform.reason_given"
      ],
      "signature": "MATERIAL_LOT_STATUS_DECIDED",
      "permission": "material.qa_disposition"
    },
    {
      "from": "ON_HOLD",
      "event": "UNHOLD",
      "to": "RELEASED",
      "guards": [
        "material_lot.command_recorded",
        "platform.reason_given",
        "material_lot.within_dates"
      ],
      "signature": "MATERIAL_LOT_STATUS_DECIDED",
      "permission": "material.qa_disposition"
    },
    {
      "from": "QUARANTINE",
      "event": "MANUFACTURER_REJECT",
      "to": "REJECTED",
      "guards": [
        "material_lot.command_recorded",
        "material_lot.manufacturer_decision"
      ],
      "signature": null,
      "permission": "release.manufacturer"
    },
    {
      "from": "QUARANTINE",
      "event": "MANUFACTURER_RELEASE",
      "to": "RELEASED",
      "guards": [
        "material_lot.command_recorded",
        "material_lot.manufacturer_decision"
      ],
      "signature": null,
      "permission": "release.manufacturer"
    },
    {
      "from": "QUARANTINE",
      "event": "REJECT",
      "to": "REJECTED",
      "guards": [
        "material_lot.command_recorded",
        "platform.reason_given",
        "material_lot.not_finished"
      ],
      "signature": "MATERIAL_LOT_REJECTED",
      "permission": "material.release"
    },
    {
      "from": "QUARANTINE",
      "event": "RELEASE",
      "to": "RELEASED",
      "guards": [
        "material_lot.command_recorded",
        "material_lot.not_finished",
        "material_lot.not_intermediate",
        "material_lot.signer_is_actor",
        "material_lot.within_dates",
        "material_lot.release_route_satisfied"
      ],
      "signature": "MATERIAL_LOT_RELEASED",
      "permission": "material.release"
    },
    {
      "from": "QUARANTINE",
      "event": "RELEASE_FOR_FURTHER_PROCESSING",
      "to": "RELEASED_FOR_FURTHER_PROCESSING",
      "guards": [
        "material_lot.command_recorded",
        "platform.reason_given",
        "material_lot.not_finished",
        "material_lot.intermediate_only",
        "material_lot.within_dates"
      ],
      "signature": "MATERIAL_LOT_STATUS_DECIDED",
      "permission": "material.qa_disposition"
    },
    {
      "from": "RECALLED",
      "event": "DESTROY",
      "to": "DESTROYED",
      "guards": [
        "material_lot.command_recorded",
        "material_lot.destruction_witnessed"
      ],
      "signature": "MATERIAL_DESTRUCTION_WITNESSED",
      "permission": "material.handle"
    },
    {
      "from": "RECALLED",
      "event": "DISPOSAL_DESTROY",
      "to": "DESTROYED",
      "guards": [
        "material_lot.command_recorded",
        "material_lot.disposal_recorded"
      ],
      "signature": null,
      "permission": "step.witness"
    },
    {
      "from": "RECALLED",
      "event": "DISPOSAL_RETURN",
      "to": "RETURNED",
      "guards": [
        "material_lot.command_recorded",
        "material_lot.disposal_recorded"
      ],
      "signature": null,
      "permission": "release.disposal"
    },
    {
      "from": "REJECTED",
      "event": "DESTROY",
      "to": "DESTROYED",
      "guards": [
        "material_lot.command_recorded",
        "material_lot.destruction_witnessed"
      ],
      "signature": "MATERIAL_DESTRUCTION_WITNESSED",
      "permission": "material.handle"
    },
    {
      "from": "REJECTED",
      "event": "DISPOSAL_DESTROY",
      "to": "DESTROYED",
      "guards": [
        "material_lot.command_recorded",
        "material_lot.disposal_recorded"
      ],
      "signature": null,
      "permission": "step.witness"
    },
    {
      "from": "REJECTED",
      "event": "DISPOSAL_RETURN",
      "to": "RETURNED",
      "guards": [
        "material_lot.command_recorded",
        "material_lot.disposal_recorded"
      ],
      "signature": null,
      "permission": "release.disposal"
    },
    {
      "from": "RELEASED",
      "event": "CONSUME",
      "to": "CONSUMED",
      "guards": [
        "material_lot.command_recorded",
        "material_lot.quantity_zero"
      ],
      "signature": null,
      "permission": "dispense.execute"
    },
    {
      "from": "RELEASED",
      "event": "HOLD",
      "to": "ON_HOLD",
      "guards": [
        "material_lot.command_recorded",
        "platform.reason_given"
      ],
      "signature": "MATERIAL_LOT_STATUS_DECIDED",
      "permission": "material.qa_disposition"
    },
    {
      "from": "RELEASED",
      "event": "RECALL",
      "to": "RECALLED",
      "guards": [
        "material_lot.command_recorded",
        "platform.reason_given"
      ],
      "signature": "MATERIAL_LOT_STATUS_DECIDED",
      "permission": "material.qa_disposition"
    },
    {
      "from": "RELEASED",
      "event": "RELEASE_RECALL",
      "to": "RECALLED",
      "guards": [
        "material_lot.command_recorded",
        "material_lot.after_release_decision"
      ],
      "signature": null,
      "permission": "release.manufacturer"
    },
    {
      "from": "RELEASED",
      "event": "RELEASE_REJECT",
      "to": "REJECTED",
      "guards": [
        "material_lot.command_recorded",
        "material_lot.after_release_decision"
      ],
      "signature": null,
      "permission": "release.manufacturer"
    },
    {
      "from": "RELEASED",
      "event": "RETURN",
      "to": "RETURNED",
      "guards": [
        "material_lot.command_recorded",
        "platform.reason_given"
      ],
      "signature": "MATERIAL_LOT_STATUS_DECIDED",
      "permission": "material.qa_disposition"
    },
    {
      "from": "RELEASED_FOR_FURTHER_PROCESSING",
      "event": "CONSUME",
      "to": "CONSUMED",
      "guards": [
        "material_lot.command_recorded",
        "material_lot.quantity_zero"
      ],
      "signature": null,
      "permission": "dispense.execute"
    },
    {
      "from": "RELEASED_FOR_FURTHER_PROCESSING",
      "event": "RECALL",
      "to": "RECALLED",
      "guards": [
        "material_lot.command_recorded",
        "platform.reason_given"
      ],
      "signature": "MATERIAL_LOT_STATUS_DECIDED",
      "permission": "material.qa_disposition"
    },
    {
      "from": "RELEASED_FOR_FURTHER_PROCESSING",
      "event": "REJECT",
      "to": "REJECTED",
      "guards": [
        "material_lot.command_recorded",
        "platform.reason_given"
      ],
      "signature": "MATERIAL_LOT_REJECTED",
      "permission": "material.qa_disposition"
    },
    {
      "from": "RELEASED_FOR_FURTHER_PROCESSING",
      "event": "RETURN",
      "to": "RETURNED",
      "guards": [
        "material_lot.command_recorded",
        "platform.reason_given"
      ],
      "signature": "MATERIAL_LOT_STATUS_DECIDED",
      "permission": "material.qa_disposition"
    },
    {
      "from": "RETURNED",
      "event": "DESTROY",
      "to": "DESTROYED",
      "guards": [
        "material_lot.command_recorded",
        "material_lot.destruction_witnessed"
      ],
      "signature": "MATERIAL_DESTRUCTION_WITNESSED",
      "permission": "material.handle"
    }
  ],
  "definition_hash": "668d9ddc58e0c2bbc7a7b61ba9f5d86e661ed88ddc2535a5987c56a34a925751"
}
$machine$::jsonb);

reset role;
