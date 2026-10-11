/**
 * Who is offered which office act (Phase 3 slice 6 screens). Display only: an act not offered to a role is hidden so the
 * screen shows each person their own work, but the server and the database decide every act (permissions, separation
 * of duties); an act shown to a role that may not do it is refused with the server's words.
 */
import { routes } from '@ebmr/api-contract';
import { useApiQuery } from '../api/hooks.ts';

export type ActGroup = 'QA' | 'QC' | 'PLANNING' | 'FORMULA_AUTHOR' | 'FORMULA_APPROVER' | 'MASTER_CONFIRMER' | 'PLANT_MASTER' | 'PLANT_VERIFIER' | 'STORES';

const GROUPS: Readonly<Record<ActGroup, RegExp>> = {
  QA: /^(QA_[A-Z_]+|QA|AUTHORISED_PERSON|HEAD_OF_QA)$/,
  QC: /^(QC_[A-Z_]+|HEAD_OF_QC)$/,
  PLANNING: /^(BATCH_ISSUER|PRODUCTION_PLANNER|HEAD_OF_PRODUCTION|SHIFT_SUPERVISOR|PRODUCTION_SUPERVISOR)$/,
  FORMULA_AUTHOR: /^(FORMULATION_STEWARD|MASTER_DATA_STEWARD|MBR_AUTHOR)$/,
  FORMULA_APPROVER: /^(QA_[A-Z_]+|HEAD_OF_QC|HEAD_OF_PRODUCTION|FORMULATION_STEWARD|MASTER_DATA_STEWARD)$/,
  // ERP master changes (ERP_MASTER_CONFIRMED, site-services 0802): the QA MBR approver's.
  MASTER_CONFIRMER: /^QA_MBR_APPROVER$/,
  PLANT_MASTER: /^(MASTER_DATA_STEWARD|SYSTEM_ADMINISTRATOR|ENGINEERING[A-Z_]*|MAINTENANCE_TECHNICIAN)$/,
  PLANT_VERIFIER: /^(QA_[A-Z_]+|SHIFT_SUPERVISOR|PRODUCTION_SUPERVISOR|PRODUCTION_VERIFIER|VERIFIER|HEAD_OF_PRODUCTION|MAINTENANCE_TECHNICIAN|ENGINEERING[A-Z_]*)$/,
  STORES: /^(STORES[A-Z_]*|WAREHOUSE[A-Z_]*|QC_[A-Z_]+|QA_[A-Z_]+|HEAD_OF_QC)$/,
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

/** Whether the session's role is offered the acts of `group`. */
export function useOffered(group: ActGroup): boolean {
  return offered(useSessionRole(), group);
}
