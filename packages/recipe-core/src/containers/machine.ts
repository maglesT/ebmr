/**
 * The output-container state machine (build outline 5.2.9 "Output containers", L-30; TB-11).
 *
 * Defined once as a flat XState 5 machine with GMP metadata (`gmp()` from the kernel state engine); the database
 * transition table is generated from it (sql/0421_machine_output_container_v1.sql, written by
 * lifecycle/write-seeds.ts). Guards are SQL functions registered by sql/0420_output_containers.sql.
 *
 *   OPEN --CLOSE [closed recorded]--> CLOSED --HOLD [hold recorded]--> HELD
 *   HELD --SORT [reason]--> SORTED
 *   HELD | SORTED --REJECT [reason, QA]--> REJECTED
 *   HELD | SORTED --RELEASE [Sig OUTPUT_CONTAINER_RELEASED, QA]--> RELEASED_BY_QA
 *   RELEASED_BY_QA --HOLD [hold recorded]--> HELD   (a later failure whose interval covers it)
 *
 * Usable (merge, charge, pack): CLOSED once bracketed by a passing in-process check recorded after its close, or
 * RELEASED_BY_QA; never HELD or SORTED (a sorted container still needs the QA release). The database decides
 * (plant.container_usable_problem).
 */
import { state } from '@ebmr/kernel';
import { setup } from 'xstate';

const { gmp } = state;

export const OUTPUT_CONTAINER_MACHINE = 'output_container';
export const OUTPUT_CONTAINER_AGGREGATE = 'output_container';

export const OUTPUT_CONTAINER_STATES = ['OPEN', 'CLOSED', 'HELD', 'SORTED', 'REJECTED', 'RELEASED_BY_QA'] as const;
export type OutputContainerState = (typeof OUTPUT_CONTAINER_STATES)[number];

export const OUTPUT_CONTAINER_EVENTS = ['CLOSE', 'HOLD', 'SORT', 'REJECT', 'RELEASE'] as const;
export type OutputContainerEvent = (typeof OUTPUT_CONTAINER_EVENTS)[number];

/** Guard codes registered in the database (sql/0420_output_containers.sql). */
export const CONTAINER_GUARDS = {
  reasonGiven: 'platform.reason_given',
  closed: 'output_container.closed',
  holdRecorded: 'output_container.hold_recorded',
} as const;

/** Platform permission names (STEP.EXECUTE for the floor, QA.FLOOR_APPROVE for the quality unit). */
export const CONTAINER_PERMISSIONS = {
  execute: 'step.execute',
  qa: 'qa.floor_approve',
} as const;

/** The signature meaning of the QA release (sql/0420). */
export const CONTAINER_RELEASE_MEANING = 'OUTPUT_CONTAINER_RELEASED';

const G = CONTAINER_GUARDS;
const P = CONTAINER_PERMISSIONS;

const hold = gmp('HELD', { guards: [G.holdRecorded], permission: P.execute });
const reject = gmp('REJECTED', { guards: [G.reasonGiven], permission: P.qa });
const release = gmp('RELEASED_BY_QA', { signature: CONTAINER_RELEASE_MEANING, permission: P.qa });

export const outputContainerMachine = setup({}).createMachine({
  id: OUTPUT_CONTAINER_MACHINE,
  initial: 'OPEN',
  states: {
    OPEN: { on: { CLOSE: gmp('CLOSED', { guards: [G.closed], permission: P.execute }) } },
    CLOSED: { on: { HOLD: hold } },
    HELD: {
      on: {
        SORT: gmp('SORTED', { guards: [G.reasonGiven], permission: P.execute }),
        REJECT: reject,
        RELEASE: release,
      },
    },
    SORTED: { on: { REJECT: reject, RELEASE: release } },
    RELEASED_BY_QA: { on: { HOLD: hold } },
    REJECTED: { type: 'final' },
  },
});

export const OUTPUT_CONTAINER_V1: state.MachineDescriptor = {
  code: OUTPUT_CONTAINER_MACHINE,
  version: 1,
  aggregateType: OUTPUT_CONTAINER_AGGREGATE,
  description: 'Output container: open, closed, held by an in-process failure over its open interval, sorted, rejected or released by QA (outline 5.2.9, L-30; TB-11)',
  // Opening a container is a floor act (plant.open_container also checks STEP.EXECUTE in the product scope).
  createPermission: CONTAINER_PERMISSIONS.execute,
  machine: outputContainerMachine,
  seedFile: '0421_machine_output_container_v1.sql',
};
