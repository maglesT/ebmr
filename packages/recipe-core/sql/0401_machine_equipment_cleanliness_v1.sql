-- GENERATED from packages/recipe-core/src/plant/machine.ts by packages/recipe-core/src/plant/write-seeds.ts (kernel state.machineSeedSql). Do not edit.
-- Publishes machine equipment_cleanliness version 1 (aggregate type plant_equipment).
-- A published version is immutable: change the machine by adding a new version and a new migration.
set local role ebmr_owner;

select platform.publish_machine_version($machine$
{
  "machine": "equipment_cleanliness",
  "version": 1,
  "aggregate_type": "plant_equipment",
  "description": "PROCESS equipment cleanliness: cleaning with a verifier, use for one batch at a time (outline 5.2.8; IN-25, INV-12)",
  "create_permission": "masterdata.change",
  "initial": "DIRTY",
  "states": [
    "CLEAN",
    "CLEANING",
    "DIRTY",
    "IN_PRODUCT"
  ],
  "final_states": [],
  "transitions": [
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
      "event": "START_USE",
      "to": "IN_PRODUCT",
      "guards": [
        "plant.equipment_use_open"
      ],
      "signature": null,
      "permission": "step.execute"
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
      "from": "IN_PRODUCT",
      "event": "END_USE",
      "to": "DIRTY",
      "guards": [
        "plant.equipment_no_use_open"
      ],
      "signature": null,
      "permission": "step.execute"
    }
  ],
  "definition_hash": "9be2f411d60290b2a424f6fb0b14e68f5ddb1e11c4eb4eebab32671e08d7090d"
}
$machine$::jsonb);

reset role;
