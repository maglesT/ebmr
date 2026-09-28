/**
 * The MBR version state machine (build outline 5.2.1; ADR 0014 decision 1; ADR 0012 decision 2).
 *
 * Defined once, as a flat XState 5 machine with GMP metadata on each transition (`gmp()` from the
 * kernel state engine). The database transition table is generated from it
 * (sql/0140_machine_mbr_version_v1.sql, written by write-seeds.ts) and a consistency test proves
 * both agree. Guards are SQL functions registered by sql/0130_mbr_guards.sql; they run inside
 * platform.transition with the version row locked.
 *
 *   DRAFT --START_VERIFICATION--> IN_VERIFICATION --SUBMIT [Sig PREPARED]--> SUBMITTED
 *         --CHECK [Sig CHECKED]--> CHECKED --APPROVE [Sig APPROVED]--> APPROVED --RETIRE--> RETIRED
 *   IN_VERIFICATION / SUBMITTED / CHECKED --RETURN [reason]--> DRAFT (every signature superseded)
 *   any state before RETIRED --WITHDRAW [reason]--> WITHDRAWN (from APPROVED only if never authorised)
 *
 * Approval is about content. A version becomes usable for a market and scope only through a signed
 * market-authorisation record (CURRENT or BRIDGING, per market and scope; sql/0160), never through
 * this machine. APPROVED never returns to DRAFT (PR-06: approved content never changes; a change is
 * a new version derived from it).
 */
import { state } from '@ebmr/kernel';
import { setup } from 'xstate';

const { gmp } = state;

export const MBR_VERSION_MACHINE = 'mbr_version';
export const MBR_VERSION_AGGREGATE = 'mbr_version';

export const MBR_VERSION_STATES = ['DRAFT', 'IN_VERIFICATION', 'SUBMITTED', 'CHECKED', 'APPROVED', 'RETIRED', 'WITHDRAWN'] as const;
export type MbrVersionState = (typeof MBR_VERSION_STATES)[number];

export const MBR_VERSION_EVENTS = ['START_VERIFICATION', 'SUBMIT', 'CHECK', 'APPROVE', 'RETURN', 'WITHDRAW', 'RETIRE'] as const;
export type MbrVersionEvent = (typeof MBR_VERSION_EVENTS)[number];

/** Guard codes registered in the database (sql/0130_mbr_guards.sql). */
export const GUARDS = {
  reasonGiven: 'platform.reason_given',
  contentPresent: 'mbr_version.content_present',
  validatorPassed: 'mbr_version.validator_passed',
  evidenceComplete: 'mbr_version.evidence_complete',
  changeRecordLinked: 'mbr_version.change_record_linked',
  criticalElementsRiskAssessed: 'mbr_version.critical_elements_risk_assessed',
  preparedByAuthor: 'mbr_version.prepared_by_author',
  signedInState: 'mbr_version.signed_in_state',
  checkerIndependent: 'mbr_version.checker_independent',
  approverIndependent: 'mbr_version.approver_independent',
  effectiveDateSet: 'mbr_version.effective_date_set',
  reviewDueSet: 'mbr_version.review_due_set',
  changeControlComplete: 'mbr_version.change_control_complete',
  registeredRangesKept: 'mbr_version.registered_ranges_kept',
  inFlightDispositioned: 'mbr_version.in_flight_dispositioned',
  draftEntryRecorded: 'mbr_version.draft_entry_recorded',
  neverAuthorised: 'mbr_version.never_authorised',
  noOpenAuthorisation: 'mbr_version.no_open_authorisation',
} as const;

/** Platform permission names (mapped by iam.platform_permission_code to MBR.AUTHOR, MBR.SIGN_PREPARED, ...). */
export const PERMISSIONS = {
  author: 'mbr.author',
  signPrepared: 'mbr.sign_prepared',
  check: 'mbr.check',
  approve: 'mbr.approve',
} as const;

const G = GUARDS;
const P = PERMISSIONS;

const returnToDraft = (permission: string) => gmp('DRAFT', { guards: [G.reasonGiven, G.draftEntryRecorded], permission });
const withdraw = (permission: string, extra: readonly string[] = []) => gmp('WITHDRAWN', { guards: [G.reasonGiven, ...extra], permission });

export const mbrVersionMachine = setup({}).createMachine({
  id: MBR_VERSION_MACHINE,
  initial: 'DRAFT',
  states: {
    DRAFT: {
      on: {
        START_VERIFICATION: gmp('IN_VERIFICATION', { guards: [G.contentPresent, G.validatorPassed], permission: P.author }),
        WITHDRAW: withdraw(P.author),
      },
    },
    IN_VERIFICATION: {
      on: {
        SUBMIT: gmp('SUBMITTED', {
          guards: [G.signedInState, G.preparedByAuthor, G.evidenceComplete, G.changeRecordLinked, G.criticalElementsRiskAssessed],
          signature: 'PREPARED',
          permission: P.signPrepared,
        }),
        RETURN: returnToDraft(P.author),
        WITHDRAW: withdraw(P.author),
      },
    },
    SUBMITTED: {
      on: {
        CHECK: gmp('CHECKED', { guards: [G.signedInState, G.checkerIndependent], signature: 'CHECKED', permission: P.check }),
        RETURN: returnToDraft(P.check),
        WITHDRAW: withdraw(P.approve),
      },
    },
    CHECKED: {
      on: {
        APPROVE: gmp('APPROVED', {
          guards: [
            G.signedInState,
            G.approverIndependent,
            G.evidenceComplete,
            G.effectiveDateSet,
            G.reviewDueSet,
            G.changeControlComplete,
            G.registeredRangesKept,
            G.inFlightDispositioned,
          ],
          signature: 'APPROVED',
          permission: P.approve,
        }),
        RETURN: returnToDraft(P.approve),
        WITHDRAW: withdraw(P.approve),
      },
    },
    APPROVED: {
      on: {
        RETIRE: gmp('RETIRED', { guards: [G.reasonGiven, G.noOpenAuthorisation], permission: P.approve }),
        WITHDRAW: withdraw(P.approve, [G.neverAuthorised]),
      },
    },
    RETIRED: { type: 'final' },
    WITHDRAWN: { type: 'final' },
  },
});

export const MBR_VERSION_V1: state.MachineDescriptor = {
  code: MBR_VERSION_MACHINE,
  version: 1,
  aggregateType: MBR_VERSION_AGGREGATE,
  description: 'MBR version life cycle: preparation, verification, independent check and QA approval (outline 5.2.1; ADR 0014)',
  machine: mbrVersionMachine,
  seedFile: '0140_machine_mbr_version_v1.sql',
};
