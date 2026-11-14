/**
 * Who is offered which office act (Phase 3 slice 6 screens). Display only: an act not offered to a role is hidden so the
 * screen shows each person their own work, but the server and the database decide every act (permissions, separation
 * of duties); an act shown to a role that may not do it is refused with the server's words.
 */
import { routes } from '@ebmr/api-contract';
import { useApiQuery } from '../api/hooks.ts';

export type ActGroup = 'QA' | 'QC' | 'PRODUCTION_HEAD' | 'PRODUCTION_FLOOR' | 'STEP_EXECUTE' | 'PLANNING' | 'FORMULA_AUTHOR' | 'FORMULA_APPROVER' | 'MASTER_CONFIRMER' | 'MASTER_ENTRY' | 'PLANT_MASTER' | 'PLANT_VERIFIER' | 'STORES' | 'US_QCU' | 'EU_QP';

const GROUPS: Readonly<Record<ActGroup, RegExp>> = {
  QA: /^(QA_[A-Z_]+|QA|AUTHORISED_PERSON|HEAD_OF_QA)$/,
  QC: /^(QC_[A-Z_]+|HEAD_OF_QC)$/,
  // Phase 4 slice 1 (review): production's approval of the record and its answers to QA's queries.
  PRODUCTION_HEAD: /^(HEAD_OF_PRODUCTION|PRODUCTION_SUPERVISOR|SHIFT_SUPERVISOR)$/,
  // Phase 4 slice 1 (containers): the floor's acts on output containers (close, sort, the second person's check).
  PRODUCTION_FLOOR: /^(OPERATOR|DISPENSER|VERIFIER|PRODUCTION_VERIFIER|SHIFT_SUPERVISOR|PRODUCTION_SUPERVISOR|HEAD_OF_PRODUCTION)$/,
  // Demo report 13 November 2026 (bug 4): the floor acts the database grants on STEP.EXECUTE alone (kernel 0120, recipe-core
  // 0200: the operator roles), such as ending a room's or unit's use; a supervisor is not offered them.
  STEP_EXECUTE: /^(OPERATOR|PRODUCTION_OPERATOR)$/,
  PLANNING: /^(BATCH_ISSUER|PRODUCTION_PLANNER|HEAD_OF_PRODUCTION|SHIFT_SUPERVISOR|PRODUCTION_SUPERVISOR)$/,
  FORMULA_AUTHOR: /^(FORMULATION_STEWARD|MASTER_DATA_STEWARD|MBR_AUTHOR)$/,
  FORMULA_APPROVER: /^(QA_[A-Z_]+|HEAD_OF_QC|HEAD_OF_PRODUCTION|FORMULATION_STEWARD|MASTER_DATA_STEWARD)$/,
  // ERP master changes (ERP_MASTER_CONFIRMED, site-services 0802): the QA MBR approver's.
  MASTER_CONFIRMER: /^QA_MBR_APPROVER$/,
  // Slice 7j (R4, site-services 1530): products and materials entered on screen (MASTER_DATA.ENTER).
  MASTER_ENTRY: /^MASTER_DATA_STEWARD$/,
  PLANT_MASTER: /^(MASTER_DATA_STEWARD|SYSTEM_ADMINISTRATOR|ENGINEERING[A-Z_]*|MAINTENANCE_TECHNICIAN)$/,
  PLANT_VERIFIER: /^(QA_[A-Z_]+|SHIFT_SUPERVISOR|PRODUCTION_SUPERVISOR|PRODUCTION_VERIFIER|VERIFIER|HEAD_OF_PRODUCTION|MAINTENANCE_TECHNICIAN|ENGINEERING[A-Z_]*)$/,
  STORES: /^(STORES[A-Z_]*|WAREHOUSE[A-Z_]*|QC_[A-Z_]+|QA_[A-Z_]+|HEAD_OF_QC)$/,
  // Phase 4 slice 4: the US quality unit's disposition (RELEASE.US_DISPOSITION) and the in-system EU QP (PR-55).
  US_QCU: /^US_QCU_SIGNER$/,
  EU_QP: /^EU_QP$/,
};

/** Whether `role` is offered the acts of `group`. */
export function offered(role: string | null | undefined, group: ActGroup): boolean {
  return role !== null && role !== undefined && GROUPS[group].test(role);
}

/** The declared role of the session (null until known). */
export function useSessionRole(): string | null {
  const s = useApiQuery(routes.session.get, {}, { staleTime: 60_000 });
  return s.data?.role ?? null;
}

/** The roles the session's account holds now (empty until known). */
export function useSessionRoles(): readonly string[] {
  const s = useApiQuery(routes.session.get, {}, { staleTime: 60_000 });
  return s.data?.roles ?? [];
}

/** Whether the session's role is offered the acts of `group`. */
export function useOffered(group: ActGroup): boolean {
  return offered(useSessionRole(), group);
}
