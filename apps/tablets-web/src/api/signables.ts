/**
 * What the ceremony signs for the Phase 3 slice 6 signable actions: the aggregate and the meaning (C1's ceremony asks
 * for them before it reads the content to be signed).
 *
 * STOPGAP (planner decision, 11 October 2026): the server is to give the signable descriptor (aggregate type and id,
 * meaning, expected state) on every view, or per choice where the meaning depends on the person's choice. Until a view
 * carries it, the screens take the defaults below, kept in this one file. A view's own `signable` (FormulaVersionView
 * today) or a proposal's meaning (ProposedActView) always wins over a default. Where a default is wrong, the server's
 * content read refuses it and nothing is signed: the database stays the decider.
 */
import type { SignableAction } from '@ebmr/api-contract';

export interface SignSubject {
  aggregateType: string;
  aggregateId: string;
  meaning: string;
}

type S6Action = Extract<SignableAction, { kind: 'QUALITY_ACT' | 'LOT_DECISION' | 'REPROCESSING_ACT' | 'MASTER_DATA_APPROVE' | 'ACT_APPROVAL' | 'PLANT_VERIFY' | 'GMP_BATCH_ISSUE' }>;

export interface SubjectFacts {
  /** The aggregate a view names for the act (wins over the default). */
  signable?: { aggregateType: string; aggregateId: string } | null;
  /** The meaning a view names for the act (wins over the default). */
  meaning?: string | null;
  /** LOT_DECISION REJECT: the lot's status now (a reject from quarantine has its own meaning). */
  lotStatus?: string;
}

function defaults(a: S6Action, facts: SubjectFacts): SignSubject {
  switch (a.kind) {
    case 'GMP_BATCH_ISSUE':
      return { aggregateType: 'batch_issue', aggregateId: a.batchId, meaning: 'ISSUED' };
    case 'QUALITY_ACT':
      switch (a.act) {
        case 'DEVIATION_CONCLUDE':
          return { aggregateType: 'deviation', aggregateId: a.subjectId, meaning: 'DEVIATION_CONCLUDED' };
        case 'DEVIATION_CLOSE':
          return { aggregateType: 'deviation', aggregateId: a.subjectId, meaning: 'DEVIATION_CLOSED' };
        case 'LOT_RESULT_APPROVE':
          return { aggregateType: 'lot_test_result', aggregateId: a.subjectId, meaning: 'QC_RESULT_APPROVED' };
        case 'QC_EXTRA_TESTING_DECISION':
          // The decision and its tests are part of the aggregate id (planner, 11 October 2026).
          return { aggregateType: 'qc_extra_testing', aggregateId: `${a.subjectId}/${a.input.decision ?? ''}/${(a.input.tests ?? []).join('+')}`, meaning: 'QC_EXTRA_TESTING_DECIDED' };
        case 'LOT_RETEST':
          return { aggregateType: 'material_lot', aggregateId: a.subjectId, meaning: 'QC_RESULT_APPROVED' };
      }
      break;
    case 'LOT_DECISION':
      return {
        aggregateType: 'material_lot',
        aggregateId: a.lotId,
        meaning: a.decision === 'RELEASE' ? 'MATERIAL_LOT_RELEASED' : facts.lotStatus === 'QUARANTINE' ? 'MATERIAL_LOT_REJECTED' : 'MATERIAL_LOT_STATUS_DECIDED',
      };
    case 'REPROCESSING_ACT':
      switch (a.act) {
        case 'RESERVE_RESIDUE':
          return { aggregateType: 'output_container', aggregateId: a.subjectId, meaning: 'RESIDUE_RESERVED' };
        case 'AUTHORISE_ADDITION':
          return { aggregateType: 'reprocessing_authorisation', aggregateId: a.subjectId, meaning: 'REPROCESSING_AUTHORISED' };
        case 'AUTHORISE_REQUEST':
          return { aggregateType: 'reprocessing_request', aggregateId: a.subjectId, meaning: 'REPROCESSING_AUTHORISED' };
      }
      break;
    case 'MASTER_DATA_APPROVE':
      return { aggregateType: 'formula_version', aggregateId: a.versionId, meaning: 'FORMULA_APPROVED' };
    case 'ACT_APPROVAL':
      return { aggregateType: 'batch_act', aggregateId: a.actId, meaning: 'VOID_AUTHORISED' };
    case 'PLANT_VERIFY':
      switch (a.act) {
        case 'CLEANING':
          return { aggregateType: 'plant_cleaning', aggregateId: a.id, meaning: 'LOGBOOK_DOUBLE_CHECKED' };
        case 'REPAIR':
          return { aggregateType: 'plant_equipment_repair', aggregateId: a.id, meaning: 'LOGBOOK_DOUBLE_CHECKED' };
        case 'CLEARANCE':
          return { aggregateType: 'plant_clearance', aggregateId: a.id, meaning: 'LINE_CLEARANCE_VERIFIED' };
      }
  }
  throw new Error('unreachable');
}

/** The aggregate and meaning the ceremony signs for `action`: the view's own descriptor first, else the default. */
export function subjectOf(action: S6Action, facts: SubjectFacts = {}): SignSubject {
  const d = defaults(action, facts);
  return {
    aggregateType: facts.signable?.aggregateType ?? d.aggregateType,
    aggregateId: facts.signable?.aggregateId ?? d.aggregateId,
    meaning: facts.meaning ?? d.meaning,
  };
}
