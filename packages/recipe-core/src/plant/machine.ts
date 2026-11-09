/**
 * Plant state machines (build outline 5.2.8; Phase 3 slice 1, plan item 2; ADR 0012 decision 2).
 *
 * Defined once in XState with GMP metadata (`gmp()` from the kernel state engine); the database transition tables
 * are generated from them (sql/0401 and sql/0402, written by ./write-seeds.ts) and a test proves both agree.
 *
 * PROCESS equipment cleanliness (aggregate plant_equipment; instruments and utilities have no cleanliness state):
 *
 *   DIRTY --START_CLEANING--> CLEANING --VERIFY_CLEANING--> CLEAN --START_USE--> IN_PRODUCT --END_USE--> DIRTY
 *   CLEANING --ABANDON_CLEANING [reason]--> DIRTY;  CLEAN --START_CLEANING--> CLEANING (clean again, e.g. after the
 *   clean-hold expired or for a higher level);  CLEAN --MARK_DIRTY [reason]--> DIRTY
 *
 * Rooms and lines (aggregate plant_area):
 *
 *   DIRTY --START_CLEANING--> CLEANING --VERIFY_CLEANING--> CLEAN --CLEAR--> CLEARED_FOR_BATCH --START--> IN_USE
 *   IN_USE --RELEASE--> DIRTY;  OUT_OF_SERVICE from DIRTY, CLEAN and CLEARED_FOR_BATCH, back to DIRTY.
 *
 * Every guard is a consistency check against the plant rows (sql/0400): the rows are written only by the plant
 * command functions, which make the transition in the same transaction, so a transition called directly through
 * platform.transition without the command's rows is refused.
 */
import { state } from '@ebmr/kernel';
import { setup } from 'xstate';

const { gmp } = state;

export const EQUIPMENT_MACHINE = 'equipment_cleanliness';
export const EQUIPMENT_AGGREGATE = 'plant_equipment';
export const AREA_MACHINE = 'area_status';
export const AREA_AGGREGATE = 'plant_area';

export const EQUIPMENT_STATES = ['DIRTY', 'CLEANING', 'CLEAN', 'IN_PRODUCT'] as const;
export type EquipmentCleanliness = (typeof EQUIPMENT_STATES)[number];
export const EQUIPMENT_EVENTS = ['START_CLEANING', 'VERIFY_CLEANING', 'ABANDON_CLEANING', 'START_USE', 'END_USE', 'MARK_DIRTY'] as const;

export const AREA_STATES = ['DIRTY', 'CLEANING', 'CLEAN', 'CLEARED_FOR_BATCH', 'IN_USE', 'OUT_OF_SERVICE'] as const;
export type AreaStatus = (typeof AREA_STATES)[number];
export const AREA_EVENTS = [
  'START_CLEANING',
  'VERIFY_CLEANING',
  'ABANDON_CLEANING',
  'CLEAR',
  'START',
  'RELEASE',
  'MARK_DIRTY',
  'TAKE_OUT_OF_SERVICE',
  'RETURN_TO_SERVICE',
] as const;
/** area_status version 2 (injectables I-1c2 P3b, recipe-core 1887): version 1's events and CLEAR_UNCHECKED. */
export const AREA_EVENTS_V2 = [...AREA_EVENTS, 'CLEAR_UNCHECKED'] as const;

/** Guard codes registered by sql/0400_plant_foundation.sql. */
export const PLANT_GUARDS = {
  reasonGiven: 'platform.reason_given',
  cleaningOpen: 'plant.cleaning_open',
  cleaningVerified: 'plant.cleaning_verified',
  cleaningAbandoned: 'plant.cleaning_abandoned',
  useOpen: 'plant.equipment_use_open',
  noUseOpen: 'plant.equipment_no_use_open',
  clearancePassed: 'plant.clearance_passed',
  occupancyOpen: 'plant.area_occupancy_open',
  noOccupancyOpen: 'plant.area_no_occupancy_open',
  /** recipe-core 1886: an unused PASSED clearance recorded after the last occupancy, verified or not. */
  clearanceRecordedPassed: 'plant.clearance_recorded_passed',
} as const;

/** Platform permission names (iam.platform_permission_code maps them to the catalogue codes). */
export const PLANT_PERMISSIONS = {
  masterData: 'masterdata.change',
  logbookEntry: 'logbook.entry',
  logbookSign: 'logbook.sign',
  execute: 'step.execute',
  verify: 'step.verify',
} as const;

const G = PLANT_GUARDS;
const P = PLANT_PERMISSIONS;

const startCleaning = gmp('CLEANING', {
  guards: [G.cleaningOpen],
  permission: P.logbookEntry,
});
const verifyCleaning = gmp('CLEAN', {
  guards: [G.cleaningVerified],
  permission: P.logbookSign,
});
const abandonCleaning = gmp('DIRTY', {
  guards: [G.reasonGiven, G.cleaningAbandoned],
  permission: P.logbookEntry,
});
const markDirty = gmp('DIRTY', {
  guards: [G.reasonGiven],
  permission: P.logbookEntry,
});

export const equipmentCleanlinessMachine = setup({}).createMachine({
  id: EQUIPMENT_MACHINE,
  initial: 'DIRTY',
  states: {
    DIRTY: { on: { START_CLEANING: startCleaning } },
    CLEANING: {
      on: {
        VERIFY_CLEANING: verifyCleaning,
        ABANDON_CLEANING: abandonCleaning,
      },
    },
    CLEAN: {
      on: {
        START_USE: gmp('IN_PRODUCT', {
          guards: [G.useOpen],
          permission: P.execute,
        }),
        START_CLEANING: startCleaning,
        MARK_DIRTY: markDirty,
      },
    },
    IN_PRODUCT: {
      on: {
        END_USE: gmp('DIRTY', { guards: [G.noUseOpen], permission: P.execute }),
      },
    },
  },
});

const outOfService = gmp('OUT_OF_SERVICE', {
  guards: [G.reasonGiven],
  permission: P.logbookEntry,
});

/** The room and line status machine; version 2 adds `cleanExtra` to the events of CLEAN (areaStatusMachineV2). */
const areaStatusConfig = (cleanExtra: Record<string, ReturnType<typeof gmp>> = {}) => ({
  id: AREA_MACHINE,
  initial: 'DIRTY',
  states: {
    DIRTY: {
      on: { START_CLEANING: startCleaning, TAKE_OUT_OF_SERVICE: outOfService },
    },
    CLEANING: {
      on: {
        VERIFY_CLEANING: verifyCleaning,
        ABANDON_CLEANING: abandonCleaning,
      },
    },
    CLEAN: {
      on: {
        CLEAR: gmp('CLEARED_FOR_BATCH', {
          guards: [G.clearancePassed],
          permission: P.verify,
        }),
        START_CLEANING: startCleaning,
        MARK_DIRTY: markDirty,
        TAKE_OUT_OF_SERVICE: outOfService,
        ...cleanExtra,
      },
    },
    CLEARED_FOR_BATCH: {
      on: {
        START: gmp('IN_USE', {
          guards: [G.occupancyOpen],
          permission: P.execute,
        }),
        MARK_DIRTY: markDirty,
        TAKE_OUT_OF_SERVICE: outOfService,
      },
    },
    IN_USE: {
      on: {
        RELEASE: gmp('DIRTY', {
          guards: [G.noOccupancyOpen],
          permission: P.execute,
        }),
      },
    },
    OUT_OF_SERVICE: {
      on: {
        RETURN_TO_SERVICE: gmp('DIRTY', {
          guards: [G.reasonGiven],
          permission: P.logbookEntry,
        }),
      },
    },
  },
});

export const areaStatusMachine = setup({}).createMachine(areaStatusConfig());

/**
 * area_status version 2 (injectables I-1c2 P3b, lead ruling A5, 9 November 2026): version 1 and one more way from CLEAN to
 * CLEARED_FOR_BATCH, CLEAR_UNCHECKED, by the person who starts the batch (step.execute) on a passed clearance nobody
 * verified. Only plant.start_area_occupancy takes it, and only where the stage's clearance step in the master names no
 * checker (recipe.clearance_checked, recipe-core 1886): 211.130(e) and EU GMP 5.50 ask for an inspection before use and
 * no second person. CLEAR keeps step.verify. An area keeps the version it was created with: areas created before 1887
 * stay on version 1 (the stricter rule) until the owner decides.
 */
export const areaStatusMachineV2 = setup({}).createMachine(areaStatusConfig({
  CLEAR_UNCHECKED: gmp('CLEARED_FOR_BATCH', {
    guards: [G.clearanceRecordedPassed],
    permission: P.execute,
  }),
}));

export const EQUIPMENT_CLEANLINESS_V1: state.MachineDescriptor = {
  code: EQUIPMENT_MACHINE,
  version: 1,
  aggregateType: EQUIPMENT_AGGREGATE,
  description: 'PROCESS equipment cleanliness: cleaning with a verifier, use for one batch at a time (outline 5.2.8; IN-25, INV-12)',
  createPermission: P.masterData,
  machine: equipmentCleanlinessMachine,
  seedFile: '0401_machine_equipment_cleanliness_v1.sql',
};

export const AREA_STATUS_V1: state.MachineDescriptor = {
  code: AREA_MACHINE,
  version: 1,
  aggregateType: AREA_AGGREGATE,
  description: 'Room and line status: cleaning, clearance of the required type, use, out of service (outline 5.2.8; IN-21, INV-15)',
  createPermission: P.masterData,
  machine: areaStatusMachine,
  seedFile: '0402_machine_area_status_v1.sql',
};

export const AREA_STATUS_V2: state.MachineDescriptor = {
  code: AREA_MACHINE,
  version: 2,
  aggregateType: AREA_AGGREGATE,
  description: 'Room and line status: version 1 and CLEAR_UNCHECKED, the clearance of a stage whose clearance step names no checker (injectables I-1c2 P3b; IN-21, INV-15, PR-34)',
  createPermission: P.masterData,
  machine: areaStatusMachineV2,
  seedFile: '1887_machine_area_status_v2.sql',
};
