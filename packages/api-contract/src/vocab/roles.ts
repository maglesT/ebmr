/**
 * Role vocabularies (Phase 2 apps plan section 7, decision D4).
 *
 * The engine and the MBR name roles in the engine vocabulary (PRODUCTION_OPERATOR, QA, ...); the kernel grants
 * kernel roles (OPERATOR, QA_SHOP_FLOOR, ...). The server maps a session's DECLARED kernel role to an engine
 * role through a permission, and only when the stored authority evaluation (INV-26) allows that permission at
 * the actor's location. The authoritative map is the table tab.engine_role_map (C3); this mirror is for
 * display and for the test that proves both agree.
 */
export const ENGINE_ROLES = [
  'PRODUCTION_OPERATOR',
  'DISPENSER',
  'PRODUCTION_VERIFIER',
  'PRODUCTION_SUPERVISOR',
  'STAGE_RESPONSIBLE',
  'HEAD_OF_PRODUCTION',
  'QA',
  'QA_REVIEWER',
] as const;
export type EngineRole = (typeof ENGINE_ROLES)[number];

export const KERNEL_SHOP_FLOOR_ROLES = [
  'OPERATOR',
  'DISPENSER',
  'VERIFIER',
  'SHIFT_SUPERVISOR',
  'STAGE_RESPONSIBLE',
  'HEAD_OF_PRODUCTION',
  'QA_SHOP_FLOOR',
  'QA_REVIEWER',
] as const;
export type KernelShopFloorRole = (typeof KERNEL_SHOP_FLOOR_ROLES)[number];

export interface RoleMapping {
  kernelRole: KernelShopFloorRole;
  engineRole: EngineRole;
  /** The permission whose stored evaluation must allow the mapping. */
  viaPermission: string;
}

/** Mirror of tab.engine_role_map (plan section 7 table). */
export const ENGINE_ROLE_MAP: readonly RoleMapping[] = [
  { kernelRole: 'OPERATOR', engineRole: 'PRODUCTION_OPERATOR', viaPermission: 'STEP.EXECUTE' },
  { kernelRole: 'DISPENSER', engineRole: 'DISPENSER', viaPermission: 'DISPENSE.EXECUTE' },
  { kernelRole: 'VERIFIER', engineRole: 'PRODUCTION_VERIFIER', viaPermission: 'STEP.VERIFY' },
  { kernelRole: 'SHIFT_SUPERVISOR', engineRole: 'PRODUCTION_SUPERVISOR', viaPermission: 'STEP.SUPERVISE' },
  { kernelRole: 'STAGE_RESPONSIBLE', engineRole: 'STAGE_RESPONSIBLE', viaPermission: 'RECORD.PRODUCTION_APPROVE' },
  { kernelRole: 'HEAD_OF_PRODUCTION', engineRole: 'HEAD_OF_PRODUCTION', viaPermission: 'RECORD.PRODUCTION_APPROVE' },
  { kernelRole: 'QA_SHOP_FLOOR', engineRole: 'QA', viaPermission: 'QA.FLOOR_APPROVE' },
  { kernelRole: 'QA_REVIEWER', engineRole: 'QA_REVIEWER', viaPermission: 'RECORD.QA_REVIEW' },
];

/** The engine policy pinned per run, in engine vocabulary (engine DEFAULT_POLICY). */
export const PINNED_POLICY_ROLES = {
  qaRoles: ['QA'],
  supervisorRoles: ['PRODUCTION_SUPERVISOR', 'HEAD_OF_PRODUCTION'],
  productionHeadRoles: ['HEAD_OF_PRODUCTION'],
  replicateCountRoles: ['PRODUCTION_SUPERVISOR', 'HEAD_OF_PRODUCTION'],
  fallbackVerifierRoles: ['PRODUCTION_VERIFIER', 'PRODUCTION_SUPERVISOR', 'QA'],
} as const satisfies Record<string, readonly EngineRole[]>;

/**
 * The engine roles in which a person may give each kind of second-person check, as delivered (Phase 2 exit follow-up
 * T12.DOC round 4): a kernel role carrying the engine role (ENGINE_ROLE_MAP) also holds the permission the kernel signs
 * that check with, STEP.WITNESS for a witness and STEP.VERIFY for a later review (kernel 0120: VERIFIER holds both,
 * QA_SHOP_FLOOR only STEP.WITNESS, SHIFT_SUPERVISOR neither). Mirror for the designer's document; the server reads the
 * installation's own from tab.engine_role_map and the kernel role permissions (designer adapters `checkerRoles`), and
 * apps/tablets-server test execution/witness-without-printout proves both agree and that the run refuses everyone else.
 */
export const CHECKER_ROLES = {
  witness: ['PRODUCTION_VERIFIER', 'QA'],
  review: ['PRODUCTION_VERIFIER'],
} as const satisfies Record<'witness' | 'review', readonly EngineRole[]>;

/** Plain-language names of the roles for screens. */
export const ROLE_TITLES: Readonly<Record<string, string>> = {
  PRODUCTION_OPERATOR: 'Production operator',
  DISPENSER: 'Dispenser',
  PRODUCTION_VERIFIER: 'Production verifier',
  PRODUCTION_SUPERVISOR: 'Production supervisor',
  STAGE_RESPONSIBLE: 'Stage responsible',
  HEAD_OF_PRODUCTION: 'Head of production',
  QA: 'QA (shop floor)',
  QA_REVIEWER: 'QA reviewer',
  OPERATOR: 'Operator',
  VERIFIER: 'Verifier',
  SHIFT_SUPERVISOR: 'Shift supervisor',
  QA_SHOP_FLOOR: 'QA (shop floor)',
  BATCH_ISSUER: 'Batch issuer',
  MBR_AUTHOR: 'MBR author',
  MBR_CHECKER: 'MBR checker',
  QA_MBR_APPROVER: 'QA MBR approver',
  REGULATORY_SIGNER: 'Regulatory signer',
  SYSTEM_ADMINISTRATOR: 'System administrator',
  PROCESS_OWNER: 'Process owner',
  SERVICE_ACCOUNT: 'Service account',
};
