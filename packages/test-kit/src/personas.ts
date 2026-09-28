/**
 * The persona and terminal catalogue of the demo and E2E installations (Phase 2 apps plan, module C0).
 *
 * Every credential here is DEMO-ONLY: it exists in demo and E2E databases (and the test templates), never in
 * a real installation. Sandbox identifiers start with TEST- (DI-05). Persona set N (N >= 1) adds the suffix
 * -wN to names, login names and badge identifiers, so each Playwright worker has its own persons (the kernel
 * allows one shop-floor session per person).
 */
import type { InstallationKind } from './db.ts';

export const SITE_CODE = 'SITE-1';
export const SITE_ZONE = 'Asia/Kolkata';

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
  { code: 'TEST-PC-01', installation: 'SANDBOX', deviceClass: 'PERSONAL', description: 'Sandbox office PC (batch issue, package import)', key: 'BROWSER' },
  { code: 'TEST-KIOSK-DISP-1', installation: 'SANDBOX', deviceClass: 'SHARED', room: 'DISP-1', description: 'Shop-floor kiosk, dispensing booth DISP-1', key: 'BROWSER' },
  { code: 'TEST-KIOSK-BLEND-1', installation: 'SANDBOX', deviceClass: 'SHARED', room: 'BLEND-1', description: 'Shop-floor kiosk, blending room BLEND-1', key: 'BROWSER' },
  { code: 'TEST-BAL-01', installation: 'SANDBOX', deviceClass: 'INSTRUMENT', room: 'DISP-1', description: 'Balance 60 kg in DISP-1 (simulated MT-SICS scale behind the site gateway)', key: 'NONE' },
  { code: 'TEST-BAL-02', installation: 'SANDBOX', deviceClass: 'INSTRUMENT', room: 'BLEND-1', description: 'Balance 300 kg in BLEND-1 (behind the site gateway)', key: 'NONE' },
  { code: 'TEST-SRV-SWEEPER', installation: 'SANDBOX', deviceClass: 'SERVER', description: 'Sandbox server: in-process time sweeper identity', key: 'SERVICE' },
  { code: 'TEST-GW-01', installation: 'SANDBOX', deviceClass: 'SERVER', description: 'Site gateway (scales), sandbox installation', key: 'SERVICE' },
];

export interface PersonaSpec {
  key: string;
  installation: InstallationKind;
  legalName: string;
  loginName: string;
  roleCode: string;
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
  // Sandbox (test runs on the shop floor)
  { key: 'issuer', installation: 'SANDBOX', legalName: 'TEST-Rohan Gupta', loginName: 'test-issuer', roleCode: 'BATCH_ISSUER', kiosk: false, homeTerminal: 'TEST-PC-01', title: 'Batch issuer', demo: { password: 'Demo-Issuer-2026!' } },
  { key: 'steward', installation: 'SANDBOX', legalName: 'TEST-Neha Joshi', loginName: 'test-steward', roleCode: 'MASTER_DATA_STEWARD', kiosk: false, homeTerminal: 'TEST-PC-01', title: 'Master-data steward (test lots)', demo: { password: 'Demo-Steward-2026!' } },
  { key: 'operator1', installation: 'SANDBOX', legalName: 'TEST-Priya Nair', loginName: 'test-operator-1', roleCode: 'OPERATOR', kiosk: true, homeTerminal: 'TEST-KIOSK-DISP-1', title: 'Operator', demo: { password: 'Demo-Operator1-2026!', pin: '482913', badgeUid: '04A10000000001' } },
  { key: 'operator2', installation: 'SANDBOX', legalName: 'TEST-Arjun Das', loginName: 'test-operator-2', roleCode: 'OPERATOR', kiosk: true, homeTerminal: 'TEST-KIOSK-BLEND-1', title: 'Operator', demo: { password: 'Demo-Operator2-2026!', pin: '573024', badgeUid: '04A10000000002' } },
  { key: 'verifier1', installation: 'SANDBOX', legalName: 'TEST-Kavya Reddy', loginName: 'test-verifier-1', roleCode: 'VERIFIER', kiosk: true, homeTerminal: 'TEST-KIOSK-DISP-1', title: 'Verifier', demo: { password: 'Demo-Verifier1-2026!', pin: '691357', badgeUid: '04A10000000011' } },
  { key: 'verifier2', installation: 'SANDBOX', legalName: 'TEST-Imran Khan', loginName: 'test-verifier-2', roleCode: 'VERIFIER', kiosk: true, homeTerminal: 'TEST-KIOSK-BLEND-1', title: 'Verifier', demo: { password: 'Demo-Verifier2-2026!', pin: '715926', badgeUid: '04A10000000012' } },
  { key: 'supervisor1', installation: 'SANDBOX', legalName: 'TEST-Sanjay Kulkarni', loginName: 'test-supervisor-1', roleCode: 'SHIFT_SUPERVISOR', kiosk: true, homeTerminal: 'TEST-KIOSK-BLEND-1', title: 'Shift supervisor', demo: { password: 'Demo-Supervisor1-2026!', pin: '846201', badgeUid: '04A10000000021' } },
  { key: 'qa1', installation: 'SANDBOX', legalName: 'TEST-Fatima Sheikh', loginName: 'test-qa-1', roleCode: 'QA_SHOP_FLOOR', kiosk: true, homeTerminal: 'TEST-KIOSK-BLEND-1', title: 'QA (shop floor)', demo: { password: 'Demo-QaFloor1-2026!', pin: '935172', badgeUid: '04A10000000031' } },
];

export interface ServiceSpec {
  key: 'sweeper' | 'gateway';
  legalName: string;
  loginName: string;
  accountKind: 'SERVICE' | 'INTEGRATION';
  terminal: string;
}

/** Service identities of the sandbox (plan section 2): the in-process sweeper and the site gateway. */
export const SERVICES: readonly ServiceSpec[] = [
  { key: 'sweeper', legalName: 'TEST-sweeper', loginName: 'test-sweeper', accountKind: 'SERVICE', terminal: 'TEST-SRV-SWEEPER' },
  { key: 'gateway', legalName: 'TEST-gw', loginName: 'test-gw', accountKind: 'INTEGRATION', terminal: 'TEST-GW-01' },
];

/** Names of the installation's first administrator and process owner (sandbox names carry TEST-). */
export const BOOTSTRAP_NAMES: Readonly<Record<InstallationKind, { admin: [string, string]; owner: [string, string] }>> = {
  GMP: { admin: ['Demo Administrator', 'demo.admin'], owner: ['Demo Process Owner', 'demo.owner'] },
  SANDBOX: { admin: ['TEST-Administrator', 'test-admin'], owner: ['TEST-Process Owner', 'test-owner'] },
};

/** The persona of set `n` (0 = the demo set): suffix -wN on names, logins and badges. */
export function personaForSet(p: PersonaSpec, set: number): PersonaSpec {
  if (set === 0) return p;
  const suffix = `-w${set}`;
  // Badge UIDs are 14 hex digits: 04A1, the set number in 4 digits, then the persona's own 6 digits.
  const badge = p.demo.badgeUid ? `${p.demo.badgeUid.slice(0, 4)}${String(set).padStart(4, '0')}${p.demo.badgeUid.slice(8)}` : undefined;
  return {
    ...p,
    key: `${p.key}${suffix}`,
    legalName: `${p.legalName}${suffix}`,
    loginName: `${p.loginName}${suffix}`,
    demo: { password: `${p.demo.password}${suffix}`, ...(p.demo.pin ? { pin: p.demo.pin } : {}), ...(badge ? { badgeUid: badge } : {}) },
  };
}
