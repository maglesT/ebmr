/**
 * The persona and terminal catalogue of the demo and E2E installations (Phase 2 apps plan, module C0).
 *
 * Every credential here is DEMO-ONLY: it exists in demo and E2E databases (and the test templates), never in
 * a real installation. Sandbox identifiers start with TEST- (DI-05). Persona set N (N >= 1) adds the suffix
 * -wN to keys, login names and badge identifiers, and -wA, -wB, ... to names, so each Playwright worker has its own
 * persons (the kernel allows one shop-floor session per person). A name never carries a digit: in the sandbox a word
 * that joins letters and digits reads as a batch or lot number (EBMR-SBX-024, kernel 1040).
 */
import type { InstallationKind } from './db.ts';

export const SITE_CODE = 'SITE-1';
// No site time zone here: contexts declare the database's site policy site.zone (seed.ts siteZoneOf; DI-27).

export type TerminalClass = 'PERSONAL' | 'SHARED' | 'GRADE_A_B' | 'SERVER' | 'INSTRUMENT';

export interface TerminalSpec {
  code: string;
  installation: InstallationKind;
  deviceClass: TerminalClass;
  room?: string;
  description: string;
  /** ECDSA P-256 browser key (office PCs and kiosks), Ed25519 service key, or no key (instruments behind the gateway). */
  key: 'BROWSER' | 'SERVICE' | 'NONE';
}

export const TERMINALS: readonly TerminalSpec[] = [
  { code: 'PC-DESIGN-01', installation: 'GMP', deviceClass: 'PERSONAL', description: 'MBR design office PC', key: 'BROWSER' },
  { code: 'PC-QA-01', installation: 'GMP', deviceClass: 'PERSONAL', description: 'QA office PC', key: 'BROWSER' },
  { code: 'PC-QA-02', installation: 'GMP', deviceClass: 'PERSONAL', description: 'Second QA office PC (record review and release)', key: 'BROWSER' },
  { code: 'PC-QA-03', installation: 'GMP', deviceClass: 'PERSONAL', description: 'Third QA office PC (security checks)', key: 'BROWSER' },
  // Phase 4 slice 4c: the market dispositions spec has its own office PC (no shared device rate limit).
  { code: 'PC-QA-04', installation: 'GMP', deviceClass: 'PERSONAL', description: 'Fourth QA office PC (market dispositions and certification intake)', key: 'BROWSER' },
  { code: 'PC-PLAN-02', installation: 'GMP', deviceClass: 'PERSONAL', description: 'Second production office PC (plant cleaning and verification)', key: 'BROWSER' },
  { code: 'PC-PLAN-01', installation: 'GMP', deviceClass: 'PERSONAL', description: 'Production planning office PC (GMP batch issue)', key: 'BROWSER' },
  { code: 'PC-QC-01', installation: 'GMP', deviceClass: 'PERSONAL', description: 'QC laboratory office PC (results, approvals, deviation-lite)', key: 'BROWSER' },
  { code: 'SRV-ERP-01', installation: 'GMP', deviceClass: 'SERVER', description: 'ERP interface host (product and material masters, production orders)', key: 'SERVICE' },
  { code: 'KIOSK-DISP-1', installation: 'GMP', deviceClass: 'SHARED', room: 'DISP-1', description: 'Shop-floor kiosk, dispensing booth DISP-1 (GMP batches)', key: 'BROWSER' },
  // Phase 3 slice 6c (demo seed, backlog 3b): a second GMP kiosk and the GMP site gateway's server terminal.
  { code: 'KIOSK-GRAN-1', installation: 'GMP', deviceClass: 'SHARED', room: 'GRAN-1', description: 'Shop-floor kiosk, granulation suite GRAN-1 (GMP batches)', key: 'BROWSER' },
  // Phase 3 slice 6d (GB-T-01): a kiosk in each room of the golden batch's later stages.
  { code: 'KIOSK-BLEND-1', installation: 'GMP', deviceClass: 'SHARED', room: 'BLEND-1', description: 'Shop-floor kiosk, blending room BLEND-1 (GMP batches)', key: 'BROWSER' },
  { code: 'KIOSK-COMP-1', installation: 'GMP', deviceClass: 'SHARED', room: 'COMP-1', description: 'Shop-floor kiosk, compression room COMP-1 (GMP batches)', key: 'BROWSER' },
  { code: 'KIOSK-COAT-1', installation: 'GMP', deviceClass: 'SHARED', room: 'COAT-1', description: 'Shop-floor kiosk, coating room COAT-1 (GMP batches)', key: 'BROWSER' },
  { code: 'KIOSK-INSP-1', installation: 'GMP', deviceClass: 'SHARED', room: 'INSP-1', description: 'Shop-floor kiosk, inspection room INSP-1 (GMP batches)', key: 'BROWSER' },
  { code: 'GW-01', installation: 'GMP', deviceClass: 'SERVER', description: 'Site gateway (scales, instruments and process equipment), GMP installation', key: 'SERVICE' },
  // Phase 4 slice 1b (D-P4-9): the GMP server's in-process time sweeper, so missed-check holds run on GMP too.
  { code: 'SRV-SWEEPER-01', installation: 'GMP', deviceClass: 'SERVER', description: 'GMP server: in-process time sweeper identity (time limits, overdue in-process checks, interface losses)', key: 'SERVICE' },
  { code: 'TEST-PC-01', installation: 'SANDBOX', deviceClass: 'PERSONAL', description: 'Sandbox office PC (batch issue, package import)', key: 'BROWSER' },
  { code: 'TEST-KIOSK-DISP-1', installation: 'SANDBOX', deviceClass: 'SHARED', room: 'DISP-1', description: 'Shop-floor kiosk, dispensing booth DISP-1', key: 'BROWSER' },
  { code: 'TEST-KIOSK-BLEND-1', installation: 'SANDBOX', deviceClass: 'SHARED', room: 'BLEND-1', description: 'Shop-floor kiosk, blending room BLEND-1', key: 'BROWSER' },
  { code: 'TEST-BAL-01', installation: 'SANDBOX', deviceClass: 'INSTRUMENT', room: 'DISP-1', description: 'Balance 60 kg in DISP-1 (simulated MT-SICS scale behind the site gateway)', key: 'NONE' },
  { code: 'TEST-BAL-02', installation: 'SANDBOX', deviceClass: 'INSTRUMENT', room: 'BLEND-1', description: 'Balance 300 kg in BLEND-1 (behind the site gateway)', key: 'NONE' },
  { code: 'TEST-SRV-SWEEPER', installation: 'SANDBOX', deviceClass: 'SERVER', description: 'Sandbox server: in-process time sweeper identity', key: 'SERVICE' },
  { code: 'TEST-SRV-MONITOR', installation: 'SANDBOX', deviceClass: 'SERVER', description: 'Sandbox server: in-process gateway API monitor identity', key: 'SERVICE' },
  { code: 'TEST-GW-01', installation: 'SANDBOX', deviceClass: 'SERVER', description: 'Site gateway (scales), sandbox installation', key: 'SERVICE' },
];

export interface PersonaSpec {
  key: string;
  installation: InstallationKind;
  legalName: string;
  loginName: string;
  /** The persona's role; with `alsoRoles`, the first of its roles and the one the test-kit's own sessions declare. */
  roleCode: string;
  /**
   * Further roles, granted exactly as `roleCode` is (requested by the administrator, approved by the process owner).
   * A person who holds several roles chooses one at each sign-in, and the session acts in that role only: it cannot
   * change it, the person signs in again to act in another (tablets 0001 tab.set_session_role, EBMR-TAB-015).
   */
  alsoRoles?: readonly string[];
  /** Kiosk personas log in with badge and PIN; the others with user ID and password. */
  kiosk: boolean;
  /** The terminal the persona uses in the demo. */
  homeTerminal: string;
  title: string;
  /** DEMO-ONLY credentials (persona set 0; other sets add -wN). */
  demo: { password: string; pin?: string; badgeUid?: string };
}

export const PERSONAS: readonly PersonaSpec[] = [
  // GMP (designer and MBR life cycle)
  { key: 'author', installation: 'GMP', legalName: 'Asha Rao', loginName: 'asha.rao', roleCode: 'MBR_AUTHOR', kiosk: false, homeTerminal: 'PC-DESIGN-01', title: 'MBR author', demo: { password: 'Demo-Author-2026!' } },
  { key: 'checker', installation: 'GMP', legalName: 'Vikram Shah', loginName: 'vikram.shah', roleCode: 'MBR_CHECKER', kiosk: false, homeTerminal: 'PC-DESIGN-01', title: 'MBR checker', demo: { password: 'Demo-Checker-2026!' } },
  { key: 'approver', installation: 'GMP', legalName: 'Meera Iyer', loginName: 'meera.iyer', roleCode: 'QA_MBR_APPROVER', kiosk: false, homeTerminal: 'PC-QA-01', title: 'QA MBR approver', demo: { password: 'Demo-Approver-2026!' } },
  { key: 'regulatory', installation: 'GMP', legalName: 'Rahul Menon', loginName: 'rahul.menon', roleCode: 'REGULATORY_SIGNER', kiosk: false, homeTerminal: 'PC-QA-01', title: 'Regulatory signer', demo: { password: 'Demo-Regulatory-2026!' } },
  { key: 'steward', installation: 'GMP', legalName: 'Neha Joshi', loginName: 'neha.joshi', roleCode: 'MASTER_DATA_STEWARD', kiosk: false, homeTerminal: 'PC-QA-01', title: 'Master-data steward (reference documents)', demo: { password: 'Demo-Steward-2026!' } },
  // GMP (batch issue and execution; Phase 3 slice 2b)
  { key: 'issuer', installation: 'GMP', legalName: 'Rohan Gupta', loginName: 'rohan.gupta', roleCode: 'BATCH_ISSUER', kiosk: false, homeTerminal: 'PC-PLAN-01', title: 'Batch issuer', demo: { password: 'Demo-GmpIssuer-2026!' } },
  { key: 'operator1', installation: 'GMP', legalName: 'Priya Nair', loginName: 'priya.nair', roleCode: 'OPERATOR', kiosk: true, homeTerminal: 'KIOSK-DISP-1', title: 'Operator', demo: { password: 'Demo-GmpOperator1-2026!', pin: '482917', badgeUid: '04B10000000001' } },
  // GMP (quality and master data; Phase 3 slice 5a): LIMS-lite results and their approval, deviation-lite investigation
  // and its QA conclusion by a second QA person (S7), the quality-unit authorisation of reprocessing.
  { key: 'qcAnalyst', installation: 'GMP', legalName: 'Sunita Bose', loginName: 'sunita.bose', roleCode: 'QC_ANALYST', kiosk: false, homeTerminal: 'PC-QC-01', title: 'QC analyst', demo: { password: 'Demo-QcAnalyst-2026!' } },
  { key: 'qcApprover', installation: 'GMP', legalName: 'Karan Malhotra', loginName: 'karan.malhotra', roleCode: 'HEAD_OF_QC', kiosk: false, homeTerminal: 'PC-QC-01', title: 'Head of QC (result approver)', demo: { password: 'Demo-QcApprover-2026!' } },
  { key: 'qaInvestigator', installation: 'GMP', legalName: 'Divya Menon', loginName: 'divya.menon', roleCode: 'QA_REVIEWER', kiosk: false, homeTerminal: 'PC-QA-01', title: 'QA investigator', demo: { password: 'Demo-QaInvestigator-2026!' } },
  { key: 'qaApprover2', installation: 'GMP', legalName: 'Arvind Rao', loginName: 'arvind.rao', roleCode: 'QA_REVIEWER', kiosk: false, homeTerminal: 'PC-QA-01', title: 'QA approver (second QA person)', demo: { password: 'Demo-QaApprover2-2026!' } },
  { key: 'qcuAuthoriser', installation: 'GMP', legalName: 'Shalini Kapoor', loginName: 'shalini.kapoor', roleCode: 'AUTHORISED_PERSON', kiosk: false, homeTerminal: 'PC-QA-01', title: 'Quality-unit authoriser (reprocessing)', demo: { password: 'Demo-QcuAuthoriser-2026!' } },
  // GMP (shop floor; Phase 3 slice 6c, backlog 3b): the second operator, the verifier, the shift supervisor, QA on the
  // floor and the head of production, so a GMP batch is performed, verified, dispositioned and approved by distinct people.
  { key: 'operator2', installation: 'GMP', legalName: 'Arjun Das', loginName: 'arjun.das', roleCode: 'OPERATOR', kiosk: true, homeTerminal: 'KIOSK-GRAN-1', title: 'Operator', demo: { password: 'Demo-GmpOperator2-2026!', pin: '573106', badgeUid: '04B10000000002' } },
  { key: 'verifier1', installation: 'GMP', legalName: 'Kavya Reddy', loginName: 'kavya.reddy', roleCode: 'VERIFIER', kiosk: true, homeTerminal: 'KIOSK-DISP-1', title: 'Verifier', demo: { password: 'Demo-GmpVerifier1-2026!', pin: '815243', badgeUid: '04B10000000003' } },
  { key: 'supervisor1', installation: 'GMP', legalName: 'Sanjay Kulkarni', loginName: 'sanjay.kulkarni', roleCode: 'SHIFT_SUPERVISOR', kiosk: true, homeTerminal: 'KIOSK-GRAN-1', title: 'Shift supervisor', demo: { password: 'Demo-GmpSupervisor1-2026!', pin: '260489', badgeUid: '04B10000000004' } },
  { key: 'qa1', installation: 'GMP', legalName: 'Fatima Sheikh', loginName: 'fatima.sheikh', roleCode: 'QA_SHOP_FLOOR', kiosk: true, homeTerminal: 'KIOSK-GRAN-1', title: 'QA (shop floor)', demo: { password: 'Demo-GmpQa1-2026!', pin: '937462', badgeUid: '04B10000000005' } },
  { key: 'stores', installation: 'GMP', legalName: 'Manoj Pillai', loginName: 'manoj.pillai', roleCode: 'WAREHOUSE_LABELLING', kiosk: false, homeTerminal: 'PC-PLAN-01', title: 'Warehouse (receipt and labelling)', demo: { password: 'Demo-GmpWarehouse1-2026!' } },
  // Plant cleaning and its verification by a second technician (slice 6b e2e).
  { key: 'technician1', installation: 'GMP', legalName: 'Ravi Shetty', loginName: 'ravi.shetty', roleCode: 'MAINTENANCE_TECHNICIAN', kiosk: false, homeTerminal: 'PC-PLAN-01', title: 'Maintenance and cleaning technician', demo: { password: 'Demo-GmpTechnician1-2026!' } },
  { key: 'technician2', installation: 'GMP', legalName: 'Anita Desai', loginName: 'anita.desai', roleCode: 'MAINTENANCE_TECHNICIAN', kiosk: false, homeTerminal: 'PC-PLAN-01', title: 'Maintenance and cleaning technician (verifier)', demo: { password: 'Demo-GmpTechnician2-2026!' } },
  { key: 'head1', installation: 'GMP', legalName: 'Lakshmi Iyengar', loginName: 'lakshmi.iyengar', roleCode: 'HEAD_OF_PRODUCTION', kiosk: false, homeTerminal: 'PC-PLAN-01', title: 'Head of production', demo: { password: 'Demo-GmpHeadProd1-2026!' } },
  // Sandbox (test runs on the shop floor)
  { key: 'issuer', installation: 'SANDBOX', legalName: 'TEST-Rohan Gupta', loginName: 'test-issuer', roleCode: 'BATCH_ISSUER', kiosk: false, homeTerminal: 'TEST-PC-01', title: 'Batch issuer', demo: { password: 'Demo-Issuer-2026!' } },
  { key: 'steward', installation: 'SANDBOX', legalName: 'TEST-Neha Joshi', loginName: 'test-steward', roleCode: 'MASTER_DATA_STEWARD', kiosk: false, homeTerminal: 'TEST-PC-01', title: 'Master-data steward (test lots)', demo: { password: 'Demo-Steward-2026!' } },
  { key: 'operator1', installation: 'SANDBOX', legalName: 'TEST-Priya Nair', loginName: 'test-operator-1', roleCode: 'OPERATOR', kiosk: true, homeTerminal: 'TEST-KIOSK-DISP-1', title: 'Operator', demo: { password: 'Demo-Operator1-2026!', pin: '482913', badgeUid: '04A10000000001' } },
  { key: 'operator2', installation: 'SANDBOX', legalName: 'TEST-Arjun Das', loginName: 'test-operator-2', roleCode: 'OPERATOR', kiosk: true, homeTerminal: 'TEST-KIOSK-BLEND-1', title: 'Operator', demo: { password: 'Demo-Operator2-2026!', pin: '573024', badgeUid: '04A10000000002' } },
  { key: 'verifier1', installation: 'SANDBOX', legalName: 'TEST-Kavya Reddy', loginName: 'test-verifier-1', roleCode: 'VERIFIER', kiosk: true, homeTerminal: 'TEST-KIOSK-DISP-1', title: 'Verifier', demo: { password: 'Demo-Verifier1-2026!', pin: '691357', badgeUid: '04A10000000011' } },
  { key: 'verifier2', installation: 'SANDBOX', legalName: 'TEST-Imran Khan', loginName: 'test-verifier-2', roleCode: 'VERIFIER', kiosk: true, homeTerminal: 'TEST-KIOSK-BLEND-1', title: 'Verifier', demo: { password: 'Demo-Verifier2-2026!', pin: '715926', badgeUid: '04A10000000012' } },
  { key: 'supervisor1', installation: 'SANDBOX', legalName: 'TEST-Sanjay Kulkarni', loginName: 'test-supervisor-1', roleCode: 'SHIFT_SUPERVISOR', kiosk: true, homeTerminal: 'TEST-KIOSK-BLEND-1', title: 'Shift supervisor', demo: { password: 'Demo-Supervisor1-2026!', pin: '846201', badgeUid: '04A10000000021' } },
  { key: 'qa1', installation: 'SANDBOX', legalName: 'TEST-Fatima Sheikh', loginName: 'test-qa-1', roleCode: 'QA_SHOP_FLOOR', kiosk: true, homeTerminal: 'TEST-KIOSK-BLEND-1', title: 'QA (shop floor)', demo: { password: 'Demo-QaFloor1-2026!', pin: '935172', badgeUid: '04A10000000031' } },
  // The approvers of an abort (head of production and QA reviewer) and of a result invalidation (QA reviewer), who hold
  // the authority the kernel asks for BATCH_ABORT_APPROVED and INVALIDATION_APPROVED (kernel 0930; Phase 3 slice 2).
  { key: 'head1', installation: 'SANDBOX', legalName: 'TEST-Lakshmi Iyengar', loginName: 'test-head-1', roleCode: 'HEAD_OF_PRODUCTION', kiosk: false, homeTerminal: 'TEST-PC-01', title: 'Head of production', demo: { password: 'Demo-HeadProd1-2026!' } },
  { key: 'qareviewer1', installation: 'SANDBOX', legalName: 'TEST-Anil Varma', loginName: 'test-qa-reviewer-1', roleCode: 'QA_REVIEWER', kiosk: false, homeTerminal: 'TEST-PC-01', title: 'QA reviewer', demo: { password: 'Demo-QaReview1-2026!' } },
  // The one person with two roles: OPERATOR to perform a step and VERIFIER to verify one. The role rule lets them verify,
  // so only the segregation rule keeps them from verifying a step they performed (INV-03; E2E floor spec).
  { key: 'operatorVerifier1', installation: 'SANDBOX', legalName: 'TEST-Deepa Pillai', loginName: 'test-operator-verifier-1', roleCode: 'OPERATOR', alsoRoles: ['VERIFIER'], kiosk: true, homeTerminal: 'TEST-KIOSK-DISP-1', title: 'Operator and verifier (two roles)', demo: { password: 'Demo-OpVerifier1-2026!', pin: '358264', badgeUid: '04A10000000041' } },
];

/** The service identities (SERVICES): the sandbox's three, and the GMP installation's ERP interface, gateway and sweeper. */
export type ServiceKey = 'sweeper' | 'gateway' | 'monitor' | 'erpInterface';

export interface ServiceSpec {
  key: ServiceKey;
  /** The installation the identity is seeded in. */
  installation: InstallationKind;
  legalName: string;
  loginName: string;
  accountKind: 'SERVICE' | 'INTEGRATION';
  /** The one role the identity is granted, and the role its contexts declare (DI-17: only what it needs). */
  roleCode: string;
  terminal: string;
}

/**
 * Service identities. Of the sandbox (plan section 2): the in-process sweeper, the site gateway and the server's
 * in-process gateway API monitor. Each holds only the role its work needs, and that role only the permission its work
 * uses (DI-17 least privilege; INV-20):
 *  - the sweeper holds EXECUTION_SWEEPER (recipe-core 0260: EXECUTION.SWEEP and nothing else; SERVICE accounts only);
 *  - the gateway holds SITE_GATEWAY (tablets migration 0290: INTERFACE.WRITE and nothing else; INTEGRATION accounts
 *    only), the permission of tab.ingest_reading and tab.record_heartbeat. It does not hold the kernel's broad
 *    SERVICE_ACCOUNT, whose other permissions (record purge and retention, true copies, backups, counters, external
 *    batch numbers, time checks, incidents, market rules, record reads) belong to the kernel's own service jobs;
 *  - the monitor holds GATEWAY_API_MONITOR (tablets migration 0340: GATEWAY.API_CONTACT_RECORD and nothing else;
 *    SERVICE accounts only), the permission of tab.record_gateway_api_contact: the server records through it whether
 *    it reaches each gateway's API.
 * SITE_GATEWAY and GATEWAY_API_MONITOR exist only in a tablets edition database, so the seed runs on one
 * (editionMigrationSources with the tablets SQL, as the server, the demo and the E2E runs build it).
 */
export const SERVICES: readonly ServiceSpec[] = [
  { key: 'sweeper', installation: 'SANDBOX', legalName: 'TEST-sweeper', loginName: 'test-sweeper', accountKind: 'SERVICE', roleCode: 'EXECUTION_SWEEPER', terminal: 'TEST-SRV-SWEEPER' },
  { key: 'gateway', installation: 'SANDBOX', legalName: 'TEST-gw', loginName: 'test-gw', accountKind: 'INTEGRATION', roleCode: 'SITE_GATEWAY', terminal: 'TEST-GW-01' },
  { key: 'monitor', installation: 'SANDBOX', legalName: 'TEST-gw-monitor', loginName: 'test-gw-monitor', accountKind: 'SERVICE', roleCode: 'GATEWAY_API_MONITOR', terminal: 'TEST-SRV-MONITOR' },
  // GMP: the ERP interface (site services 0732: ERP_INTERFACE, INTERFACE.WRITE and nothing else; INTEGRATION accounts
  // only), which posts the product and material masters and the production orders (slice 5a, D-S5-4).
  { key: 'erpInterface', installation: 'GMP', legalName: 'ERP interface', loginName: 'erp.interface', accountKind: 'INTEGRATION', roleCode: 'ERP_INTERFACE', terminal: 'SRV-ERP-01' },
  // GMP: the site gateway (Phase 3 slice 6c, backlog 3b), with the sandbox gateway's role (INTERFACE.WRITE only).
  { key: 'gateway', installation: 'GMP', legalName: 'Site gateway GW-01', loginName: 'gw-01', accountKind: 'INTEGRATION', roleCode: 'SITE_GATEWAY', terminal: 'GW-01' },
  // GMP: the time sweeper (Phase 4 slice 1b, D-P4-9): a reserved non-human SERVICE account in EXECUTION_SWEEPER only (recipe-core
  // 0260: EXECUTION.SWEEP and nothing else; no STEP.EXECUTE), as the sandbox's.
  { key: 'sweeper', installation: 'GMP', legalName: 'Execution time sweeper', loginName: 'svc.sweeper', accountKind: 'SERVICE', roleCode: 'EXECUTION_SWEEPER', terminal: 'SRV-SWEEPER-01' },
];

/** Names of the installation's first administrator and process owner (sandbox names carry TEST-). */
export const BOOTSTRAP_NAMES: Readonly<Record<InstallationKind, { admin: [string, string]; owner: [string, string] }>> = {
  GMP: { admin: ['Demo Administrator', 'demo.admin'], owner: ['Demo Process Owner', 'demo.owner'] },
  SANDBOX: { admin: ['TEST-Administrator', 'test-admin'], owner: ['TEST-Process Owner', 'test-owner'] },
};

/** The letters of persona set `n` in a name: 1 = A, 26 = Z, 27 = AA (no digits; see the header). */
export function setLetters(n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`a persona set with letters is 1 or more, not ${String(n)}`);
  let out = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) out = String.fromCharCode(65 + ((k - 1) % 26)) + out;
  return out;
}

/** The persona of set `n` (0 = the demo set): suffix -wN on keys, logins, passwords and badges, -w<letters> on names. */
export function personaForSet(p: PersonaSpec, set: number): PersonaSpec {
  if (set === 0) return p;
  const suffix = `-w${set}`;
  // Badge UIDs are 14 hex digits: 04A1, the set number in 4 digits, then the persona's own 6 digits.
  const badge = p.demo.badgeUid ? `${p.demo.badgeUid.slice(0, 4)}${String(set).padStart(4, '0')}${p.demo.badgeUid.slice(8)}` : undefined;
  return {
    ...p,
    key: `${p.key}${suffix}`,
    legalName: `${p.legalName}-w${setLetters(set)}`,
    loginName: `${p.loginName}${suffix}`,
    demo: { password: `${p.demo.password}${suffix}`, ...(p.demo.pin ? { pin: p.demo.pin } : {}), ...(badge ? { badgeUid: badge } : {}) },
  };
}
