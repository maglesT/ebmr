-- GENERATED from packages/recipe-core/src/plant/machine.ts by packages/recipe-core/src/plant/write-seeds.ts (kernel state.machineSeedSql). Do not edit.
-- Publishes machine area_status version 1 (aggregate type plant_area).
-- A published version is immutable: change the machine by adding a new version and a new migration.
set local role ebmr_owner;

select platform.publish_machine_version($machine$
{
  "machine": "area_status",
  "version": 1,
  "aggregate_type": "plant_area",
  "description": "Room and line status: cleaning, clearance of the required type, use, out of service (outline 5.2.8; IN-21, INV-15)",
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
  "definition_hash": "8ad4b8ede768a8439212883e7176ccbb413a69fdcf7b00f865150406c0580ef2"
}
$machine$::jsonb);

reset role;
