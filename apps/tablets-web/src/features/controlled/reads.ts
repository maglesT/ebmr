/**
 * The reads the controlled-substance screens show, read again after every act (route ids, so `useRefresh` invalidates
 * each by its prefix).
 */
import { routes } from '@ebmr/api-contract';

export const CONTROLLED_READS: readonly string[] = [
  routes.controlled.products.id,
  routes.controlled.custody.id,
  routes.controlled.balance.id,
  routes.controlled.registerExtracts.id,
  routes.controlled.registerExtract.id,
];

/** A server code as words (display only). */
export const words = (code: string): string => code.charAt(0) + code.slice(1).toLowerCase().replaceAll('_', ' ');

/** Roles that record (QA MBR approver) or approve (also the QA reviewer) a flag; the server decides. */
export const FLAG_RECORDERS = /^QA_MBR_APPROVER$/;
export const FLAG_APPROVERS = /^(QA_MBR_APPROVER|QA_REVIEWER)$/;
/** Roles that hold a custodian's place (CONTROLLED.CUSTODY). */
export const CUSTODIANS = /^(DISPENSER|WAREHOUSE_LABELLING|VERIFIER|SHIFT_SUPERVISOR|QA_SHOP_FLOOR)$/;
/** Roles that record and sign a checkpoint (CONTROLLED.BALANCE). */
export const BALANCE_SIGNERS = /^(SHIFT_SUPERVISOR|STAGE_RESPONSIBLE|QA_SHOP_FLOOR)$/;
/** Roles that run the register export (CONTROLLED.REGISTER). */
export const REGISTER_RUNNERS = /^(QA_REVIEWER|HEAD_OF_QC|AUTHORISED_PERSON|WAREHOUSE_LABELLING)$/;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const QUANTITY = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
export const DAY = /^\d{4}-\d{2}-\d{2}$/;
