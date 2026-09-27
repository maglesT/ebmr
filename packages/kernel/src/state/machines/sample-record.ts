/**
 * Sample machine: a simplified controlled-record life cycle, used to prove the state-machine
 * engine end to end (build outline 5.2.1 shows the full MBR version machine that Phase 2 builds).
 *
 *   DRAFT --SUBMIT--> SUBMITTED --CHECK [Sig CHECKED]--> CHECKED --APPROVE [Sig APPROVED]--> APPROVED
 *   SUBMITTED / CHECKED --RETURN [reason]--> DRAFT
 *   APPROVED --SUPERSEDE--> SUPERSEDED (final)      APPROVED --RETIRE [reason]--> RETIRED (final)
 *
 * Independence of author, checker and approver is enforced by the signature module's guards,
 * not by this machine.
 */
import { setup } from 'xstate';
import { gmp, type MachineDescriptor } from '../definition.ts';

export const sampleRecordMachine = setup({}).createMachine({
  id: 'sample_record',
  initial: 'DRAFT',
  states: {
    DRAFT: {
      on: { SUBMIT: gmp('SUBMITTED', { guards: ['sample_record.has_body'], permission: 'sample_record.submit' }) },
    },
    SUBMITTED: {
      on: {
        CHECK: gmp('CHECKED', { signature: 'CHECKED', permission: 'sample_record.check' }),
        RETURN: gmp('DRAFT', { guards: ['platform.reason_given'], permission: 'sample_record.check' }),
      },
    },
    CHECKED: {
      on: {
        APPROVE: gmp('APPROVED', { signature: 'APPROVED', permission: 'sample_record.approve' }),
        RETURN: gmp('DRAFT', { guards: ['platform.reason_given'], permission: 'sample_record.approve' }),
      },
    },
    APPROVED: {
      on: {
        SUPERSEDE: gmp('SUPERSEDED', { permission: 'sample_record.approve' }),
        RETIRE: gmp('RETIRED', { guards: ['platform.reason_given'], permission: 'sample_record.retire' }),
      },
    },
    SUPERSEDED: { type: 'final' },
    RETIRED: { type: 'final' },
  },
});

export const SAMPLE_RECORD_V1: MachineDescriptor = {
  code: 'sample_record',
  version: 1,
  aggregateType: 'sample_record',
  description: 'Sample controlled-record life cycle proving the state-machine engine (Phase 1)',
  machine: sampleRecordMachine,
  seedFile: '0552_machine_sample_record_v1.sql',
};
