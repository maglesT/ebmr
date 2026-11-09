-- GENERATED from packages/recipe-core/src/plant/machine.ts by packages/recipe-core/src/plant/write-seeds.ts (kernel state.machineSeedSql). Do not edit.
-- Handbook: modules/recipe-core.md
-- Publishes machine area_status version 2 (aggregate type plant_area).
-- A published version is immutable: change the machine by adding a new version and a new migration.
set local role ebmr_owner;

select platform.publish_machine_version($machine$
{
  "machine": "area_status",
  "version": 2,
  "aggregate_type": "plant_area",
  "description": "Room and line status: version 1 and CLEAR_UNCHECKED, the clearance of a stage whose clearance step names no checker (injectables I-1c2 P3b; IN-21, INV-15, PR-34)",
  "create_permission": "masterdata.change",
  "initial": "DIRTY",
  "states": [
    "CLEAN",
    "CLEANING",
    "CLEARED_FOR_BATCH",
    "DIRTY",
    "IN_USE",
    "OUT_OF_SERVICE"
  ],
  "final_states": [],
  "transitions": [
    {
      "from": "CLEAN",
      "event": "CLEAR",
      "to": "CLEARED_FOR_BATCH",
      "guards": [
        "plant.clearance_passed"
      ],
      "signature": null,
      "permission": "step.verify"
    },
    {
      "from": "CLEAN",
      "event": "CLEAR_UNCHECKED",
      "to": "CLEARED_FOR_BATCH",
      "guards": [
        "plant.clearance_recorded_passed"
      ],
      "signature": null,
      "permission": "step.execute"
    },
    {
      "from": "CLEAN",
      "event": "MARK_DIRTY",
      "to": "DIRTY",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "logbook.entry"
    },
    {
      "from": "CLEAN",
      "event": "START_CLEANING",
      "to": "CLEANING",
      "guards": [
        "plant.cleaning_open"
      ],
      "signature": null,
      "permission": "logbook.entry"
    },
    {
      "from": "CLEAN",
      "event": "TAKE_OUT_OF_SERVICE",
      "to": "OUT_OF_SERVICE",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "logbook.entry"
    },
    {
      "from": "CLEANING",
      "event": "ABANDON_CLEANING",
      "to": "DIRTY",
      "guards": [
        "platform.reason_given",
        "plant.cleaning_abandoned"
      ],
      "signature": null,
      "permission": "logbook.entry"
    },
    {
      "from": "CLEANING",
      "event": "VERIFY_CLEANING",
      "to": "CLEAN",
      "guards": [
        "plant.cleaning_verified"
      ],
      "signature": null,
      "permission": "logbook.sign"
    },
    {
      "from": "CLEARED_FOR_BATCH",
      "event": "MARK_DIRTY",
      "to": "DIRTY",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "logbook.entry"
    },
    {
      "from": "CLEARED_FOR_BATCH",
      "event": "START",
      "to": "IN_USE",
      "guards": [
        "plant.area_occupancy_open"
      ],
      "signature": null,
      "permission": "step.execute"
    },
    {
      "from": "CLEARED_FOR_BATCH",
      "event": "TAKE_OUT_OF_SERVICE",
      "to": "OUT_OF_SERVICE",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "logbook.entry"
    },
    {
      "from": "DIRTY",
      "event": "START_CLEANING",
      "to": "CLEANING",
      "guards": [
        "plant.cleaning_open"
      ],
      "signature": null,
      "permission": "logbook.entry"
    },
    {
      "from": "DIRTY",
      "event": "TAKE_OUT_OF_SERVICE",
      "to": "OUT_OF_SERVICE",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "logbook.entry"
    },
    {
      "from": "IN_USE",
      "event": "RELEASE",
      "to": "DIRTY",
      "guards": [
        "plant.area_no_occupancy_open"
      ],
      "signature": null,
      "permission": "step.execute"
    },
    {
      "from": "OUT_OF_SERVICE",
      "event": "RETURN_TO_SERVICE",
      "to": "DIRTY",
      "guards": [
        "platform.reason_given"
      ],
      "signature": null,
      "permission": "logbook.entry"
    }
  ],
  "definition_hash": "f229a7ba531c49637d74b2c4e79f4b8a61ca7828fa9125f1a83ddf570a65d53d"
}
$machine$::jsonb);

reset role;
