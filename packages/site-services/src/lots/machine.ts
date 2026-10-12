/**
 * The material lot state machine (build outline 5.2.9 "Material lot"; controls INV-13, IN-24 (a)(c), PR-18).
 *
 * Defined once as a flat XState 5 machine with GMP metadata on each transition (`gmp()` from the kernel
 * state engine). The database transition table is generated from it (sql/0711_machine_material_lot_v1.sql,
 * written by write-seeds.ts) and a test proves both agree. Guards are SQL functions registered by
 * sql/0710_material_lots.sql; they run inside platform.transition with the lot's state row locked.
 *
 *   QUARANTINE (incl. on test) --RELEASE [Sig MATERIAL_LOT_RELEASED, QC/QA]--> RELEASED (with a recorded release route)
 *   QUARANTINE --RELEASE_FOR_FURTHER_PROCESSING [Sig MATERIAL_LOT_STATUS_DECIDED, QA]--> RELEASED_FOR_FURTHER_PROCESSING (intermediates)
 *   QUARANTINE --REJECT [Sig MATERIAL_LOT_REJECTED]--> REJECTED
 *   RELEASED <--HOLD / UNHOLD [Sig MATERIAL_LOT_STATUS_DECIDED, QA]--> ON_HOLD
 *   RELEASED / ON_HOLD / RELEASED_FOR_FURTHER_PROCESSING --RETURN / RECALL [QA]--> RETURNED / RECALLED
 *   ON_HOLD / RELEASED_FOR_FURTHER_PROCESSING --REJECT [QA]--> REJECTED
 *   RELEASED / RELEASED_FOR_FURTHER_PROCESSING --CONSUME (quantity zero)--> CONSUMED
 *   REJECTED / RETURNED / RECALLED --DESTROY [Sig MATERIAL_DESTRUCTION_WITNESSED, witness other than the performer]--> DESTROYED
 *
 * RETEST_DUE and EXPIRED are not stored states: they are computed from the lot's dates at database time
 * (site.material_lot_usage). A FINISHED lot never leaves quarantine through this machine (the batch release
 * model of outline 5.2.6 releases finished product): every exit from QUARANTINE refuses it. Version 2 (sql/0861, Phase 4
 * slice 3a) adds that model's two exits: QUARANTINE --MANUFACTURER_RELEASE / MANUFACTURER_REJECT [RELEASE.MANUFACTURER,
 * guard material_lot.manufacturer_decision]--> RELEASED / REJECTED, fired only by the recorded manufacturer release.
 *
 * Every transition is fired only by the site.* command functions (guard material_lot.command_recorded): a
 * direct platform.transition call by the application is refused, so the side effects (reservation
 * revocation, the recorded release route) can never be skipped.
 */
import { state } from "@ebmr/kernel";
import { setup } from "xstate";

const { gmp } = state;

export const MATERIAL_LOT_MACHINE = "material_lot";
export const MATERIAL_LOT_AGGREGATE = "material_lot";

export const MATERIAL_LOT_STATES = [
  "QUARANTINE",
  "RELEASED",
  "RELEASED_FOR_FURTHER_PROCESSING",
  "REJECTED",
  "ON_HOLD",
  "RETURNED",
  "RECALLED",
  "CONSUMED",
  "DESTROYED",
] as const;
export type MaterialLotState = (typeof MATERIAL_LOT_STATES)[number];

/** States from which material may be reserved and consumed (when within retest and expiry). */
export const USABLE_LOT_STATES: readonly MaterialLotState[] = [
  "RELEASED",
  "RELEASED_FOR_FURTHER_PROCESSING",
];

export const MATERIAL_LOT_EVENTS = [
  "RELEASE",
  "RELEASE_FOR_FURTHER_PROCESSING",
  "REJECT",
  "HOLD",
  "UNHOLD",
  "RETURN",
  "RECALL",
  "CONSUME",
  "DESTROY",
] as const;
export type MaterialLotEvent = (typeof MATERIAL_LOT_EVENTS)[number];

/** Guard codes registered in the database (sql/0710_material_lots.sql). */
export const LOT_GUARDS = {
  reasonGiven: "platform.reason_given",
  commandRecorded: "material_lot.command_recorded",
  notFinished: "material_lot.not_finished",
  notIntermediate: "material_lot.not_intermediate",
  intermediateOnly: "material_lot.intermediate_only",
  releaseRouteSatisfied: "material_lot.release_route_satisfied",
  withinDates: "material_lot.within_dates",
  signerIsActor: "material_lot.signer_is_actor",
  quantityZero: "material_lot.quantity_zero",
  destructionWitnessed: "material_lot.destruction_witnessed",
  /** Version 2 (site-services 0860): the manufacturer release recorded this decision on the finished lot in this transaction. */
  manufacturerDecision: "material_lot.manufacturer_decision",
  /** Version 3 (site-services 0880): the AP's after-release decision for IN (RECALL, REJECT_AFTER_RELEASE) recorded in this transaction. */
  afterReleaseDecision: "material_lot.after_release_decision",
  /** Version 3 (site-services 0880): the lot's disposal (PR-46) completed in this transaction by the route the event names. */
  disposalRecorded: "material_lot.disposal_recorded",
} as const;

/** Platform permission names (mapped by iam.platform_permission_code to MATERIAL.HANDLE, MATERIAL.RELEASE, ...). */
export const LOT_PERMISSIONS = {
  handle: "material.handle",
  release: "material.release",
  qaDisposition: "material.qa_disposition",
  dispense: "dispense.execute",
  /** Version 2: the AP's (or named delegate's) manufacturer release (RELEASE.MANUFACTURER). */
  manufacturerRelease: "release.manufacturer",
  /** Version 3: the person recording a disposal by return (RELEASE.DISPOSAL, recipe-core 0840). */
  disposal: "release.disposal",
  /** Version 3: the independent witness completing a witnessed destruction (STEP.WITNESS). */
  witness: "step.witness",
} as const;

/** Signature meanings of the lot machine (vendor minimum types added by sql/0710_material_lots.sql). */
export const LOT_MEANINGS = {
  released: "MATERIAL_LOT_RELEASED",
  rejected: "MATERIAL_LOT_REJECTED",
  statusDecided: "MATERIAL_LOT_STATUS_DECIDED",
  destructionWitnessed: "MATERIAL_DESTRUCTION_WITNESSED",
  vendorRouteEnabled: "VENDOR_ROUTE_ENABLED",
} as const;

const G = LOT_GUARDS;
const P = LOT_PERMISSIONS;
const M = LOT_MEANINGS;

const qaDecision = (target: MaterialLotState, extra: readonly string[] = []) =>
  gmp(target, {
    guards: [G.commandRecorded, G.reasonGiven, ...extra],
    signature: M.statusDecided,
    permission: P.qaDisposition,
  });
const qaReject = gmp("REJECTED", {
  guards: [G.commandRecorded, G.reasonGiven],
  signature: M.rejected,
  permission: P.qaDisposition,
});
const consume = gmp("CONSUMED", {
  guards: [G.commandRecorded, G.quantityZero],
  permission: P.dispense,
});
const destroy = gmp("DESTROYED", {
  guards: [G.commandRecorded, G.destructionWitnessed],
  signature: M.destructionWitnessed,
  permission: P.handle,
});

const quarantineV1 = {
  RELEASE: gmp("RELEASED", {
    guards: [
      G.commandRecorded,
      G.notFinished,
      G.notIntermediate,
      G.signerIsActor,
      G.withinDates,
      G.releaseRouteSatisfied,
    ],
    signature: M.released,
    permission: P.release,
  }),
  RELEASE_FOR_FURTHER_PROCESSING: qaDecision(
    "RELEASED_FOR_FURTHER_PROCESSING",
    [G.notFinished, G.intermediateOnly, G.withinDates],
  ),
  REJECT: gmp("REJECTED", {
    guards: [G.commandRecorded, G.reasonGiven, G.notFinished],
    signature: M.rejected,
    permission: P.release,
  }),
};

/**
 * Version 2 (Phase 4 slice 3a; outline 5.2.6; IN-05 (a)): a FINISHED lot leaves quarantine only through the manufacturer
 * release. The decision is the AP's MANUFACTURER_RELEASE signature over the G-REL checklist (recipe-core
 * recipe.record_manufacturer_release); the lot's transition is fired by that act in the same transaction, so it carries
 * no signature of its own: its guard reads the decision the act recorded in this transaction.
 */
const manufacturerDecision = (target: MaterialLotState) =>
  gmp(target, {
    guards: [G.commandRecorded, G.manufacturerDecision],
    permission: P.manufacturerRelease,
  });

/** The events of version 2: version 1's and the two decisions of the manufacturer release. */
export const MATERIAL_LOT_V2_EVENTS = [
  ...MATERIAL_LOT_EVENTS,
  "MANUFACTURER_RELEASE",
  "MANUFACTURER_REJECT",
] as const;

const statesAfterQuarantine = {
  RELEASED: {
    on: {
      HOLD: qaDecision("ON_HOLD"),
      RETURN: qaDecision("RETURNED"),
      RECALL: qaDecision("RECALLED"),
      CONSUME: consume,
    },
  },
  RELEASED_FOR_FURTHER_PROCESSING: {
    on: {
      REJECT: qaReject,
      RETURN: qaDecision("RETURNED"),
      RECALL: qaDecision("RECALLED"),
      CONSUME: consume,
    },
  },
  ON_HOLD: {
    on: {
      UNHOLD: qaDecision("RELEASED", [G.withinDates]),
      REJECT: qaReject,
      RETURN: qaDecision("RETURNED"),
      RECALL: qaDecision("RECALLED"),
    },
  },
  REJECTED: { on: { DESTROY: destroy } },
  RETURNED: { on: { DESTROY: destroy } },
  RECALLED: { on: { DESTROY: destroy } },
  CONSUMED: { type: "final" as const },
  DESTROYED: { type: "final" as const },
};

export const materialLotMachine = setup({}).createMachine({
  id: MATERIAL_LOT_MACHINE,
  initial: "QUARANTINE",
  states: { QUARANTINE: { on: quarantineV1 }, ...statesAfterQuarantine },
});

export const materialLotMachineV2 = setup({}).createMachine({
  id: MATERIAL_LOT_MACHINE,
  initial: "QUARANTINE",
  states: {
    QUARANTINE: {
      on: {
        ...quarantineV1,
        MANUFACTURER_RELEASE: manufacturerDecision("RELEASED"),
        MANUFACTURER_REJECT: manufacturerDecision("REJECTED"),
      },
    },
    ...statesAfterQuarantine,
  },
});

/**
 * Version 3 (Phase 4 slice 5a; outline 5.2.6 "After release" and "Rejected lots"; L-19, PR-46, IN-05 (e)): the release
 * model's after-release decisions and the disposal of a rejected finished lot, each fired only by its recorded act in the
 * same transaction (recipe-core 0840), with no signature of its own (the act's signature is on its own record):
 *   RELEASED / ON_HOLD --RELEASE_RECALL [RELEASE.MANUFACTURER]--> RECALLED      (the AP recalled the lot for IN)
 *   RELEASED / ON_HOLD --RELEASE_REJECT [RELEASE.MANUFACTURER]--> REJECTED      (the AP rejected it after release for IN)
 *   REJECTED / RECALLED --DISPOSAL_DESTROY [STEP.WITNESS]--> DESTROYED          (the witness completed the destruction)
 *   REJECTED / RECALLED --DISPOSAL_RETURN [RELEASE.DISPOSAL]--> RETURNED        (returned to the supplier or customer)
 * A disposal by reprocessing leaves the lot REJECTED: the reprocessing batch it names consumes it (Phase 3).
 */
const afterRelease = (target: MaterialLotState) =>
  gmp(target, { guards: [G.commandRecorded, G.afterReleaseDecision], permission: P.manufacturerRelease });
const disposal = (target: MaterialLotState, permission: string) =>
  gmp(target, { guards: [G.commandRecorded, G.disposalRecorded], permission });

/** The events of version 3: version 2's and the after-release and disposal exits. */
export const MATERIAL_LOT_V3_EVENTS = [
  ...MATERIAL_LOT_V2_EVENTS,
  "RELEASE_RECALL",
  "RELEASE_REJECT",
  "DISPOSAL_DESTROY",
  "DISPOSAL_RETURN",
] as const;

export const materialLotMachineV3 = setup({}).createMachine({
  id: MATERIAL_LOT_MACHINE,
  initial: "QUARANTINE",
  states: {
    QUARANTINE: {
      on: {
        ...quarantineV1,
        MANUFACTURER_RELEASE: manufacturerDecision("RELEASED"),
        MANUFACTURER_REJECT: manufacturerDecision("REJECTED"),
      },
    },
    ...statesAfterQuarantine,
    RELEASED: { on: { ...statesAfterQuarantine.RELEASED.on, RELEASE_RECALL: afterRelease("RECALLED"), RELEASE_REJECT: afterRelease("REJECTED") } },
    ON_HOLD: { on: { ...statesAfterQuarantine.ON_HOLD.on, RELEASE_RECALL: afterRelease("RECALLED"), RELEASE_REJECT: afterRelease("REJECTED") } },
    REJECTED: { on: { ...statesAfterQuarantine.REJECTED.on, DISPOSAL_DESTROY: disposal("DESTROYED", P.witness), DISPOSAL_RETURN: disposal("RETURNED", P.disposal) } },
    RECALLED: { on: { ...statesAfterQuarantine.RECALLED.on, DISPOSAL_DESTROY: disposal("DESTROYED", P.witness), DISPOSAL_RETURN: disposal("RETURNED", P.disposal) } },
  },
});

export const MATERIAL_LOT_V1: state.MachineDescriptor = {
  code: MATERIAL_LOT_MACHINE,
  version: 1,
  aggregateType: MATERIAL_LOT_AGGREGATE,
  description:
    "Material lot usage status: quarantine, release with a recorded route, hold, return, recall, consumption and witnessed destruction (outline 5.2.9)",
  // Receiving a lot into quarantine is a warehouse act (MATERIAL.HANDLE); site.receive_lot checks it too.
  createPermission: LOT_PERMISSIONS.handle,
  machine: materialLotMachine,
  seedFile: "0711_machine_material_lot_v1.sql",
};

export const MATERIAL_LOT_V2: state.MachineDescriptor = {
  code: MATERIAL_LOT_MACHINE,
  version: 2,
  aggregateType: MATERIAL_LOT_AGGREGATE,
  description:
    "Material lot usage status, version 2: as version 1, and a finished lot leaves quarantine only through the manufacturer release (outline 5.2.6, 5.2.9; IN-05 (a))",
  createPermission: LOT_PERMISSIONS.handle,
  machine: materialLotMachineV2,
  seedFile: "0861_machine_material_lot_v2.sql",
};

export const MATERIAL_LOT_V3: state.MachineDescriptor = {
  code: MATERIAL_LOT_MACHINE,
  version: 3,
  aggregateType: MATERIAL_LOT_AGGREGATE,
  description:
    "Material lot usage status, version 3: as version 2, and a released finished lot is recalled or rejected after release, and a rejected one disposed of, only by the release model's recorded acts (outline 5.2.6; L-19, PR-46, IN-05 (e))",
  createPermission: LOT_PERMISSIONS.handle,
  machine: materialLotMachineV3,
  seedFile: "0881_machine_material_lot_v3.sql",
};
