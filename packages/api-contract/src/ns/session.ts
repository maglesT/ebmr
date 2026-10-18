/**
 * Namespace `session` (C0): device identity, demo device picker, login, role choice, first-login secret
 * change, the current session and logout (Phase 2 apps plan section 5). Lock, unlock, keep-alive and user
 * switch are in namespace `access` (C1).
 *
 * The session cookie holds an opaque random token, never the kernel session id; the CSRF token comes back
 * in SessionView and is sent as X-CSRF-Token on every non-GET request.
 */
import { z } from 'zod';
import { Base64Text, DeviceProof, Empty, InstallationKind, PersonRef } from '../common.ts';
import { defineRoute } from '../route.ts';

export const DeviceClass = z.enum(['PERSONAL', 'SHARED', 'GRADE_A_B', 'SERVER', 'INSTRUMENT']);
export type DeviceClass = z.infer<typeof DeviceClass>;
export const LoginMethod = z.enum(['PASSWORD', 'BADGE_PIN']);
export type LoginMethod = z.infer<typeof LoginMethod>;

/** The terminal as the server knows it from its enrolled key (never what the browser claims). */
export const DeviceView = z.strictObject({
  deviceCode: z.string(),
  deviceClass: DeviceClass,
  siteCode: z.string(),
  roomCode: z.string().nullable(),
  lineCode: z.string().nullable(),
  /** OFFICE for PERSONAL devices; FLOOR (kiosk density) for SHARED and GRADE_A_B terminals. */
  density: z.enum(['OFFICE', 'FLOOR']),
  /** PASSWORD on office devices, BADGE_PIN on kiosks. */
  loginMethods: z.array(LoginMethod),
});
export type DeviceView = z.infer<typeof DeviceView>;

export const SessionView = z.strictObject({
  person: PersonRef,
  /** Roles the account holds now. */
  roles: z.array(z.string()),
  /** The declared role of this session; null until chosen when the account holds several. */
  role: z.string().nullable(),
  roleChoiceRequired: z.boolean(),
  device: DeviceView,
  installation: InstallationKind,
  locked: z.boolean(),
  idleTimeoutSeconds: z.number().int().positive(),
  /**
   * Seconds until the inactivity lock, by the database's clock when the view was made (WCAG 2.2.1; outline 7.4: the page
   * warns before it, and a keep-alive extends it); null when the session is not active (locked, or its role withdrawn).
   */
  idleLockInSeconds: z.number().int().nonnegative().nullable(),
  /** Seconds until the absolute timeout ends the session (no keep-alive extends it); null once it has ended. */
  endsInSeconds: z.number().int().nonnegative().nullable(),
  csrfToken: z.string().min(1),
  /** Per-entry attribution on this device (decision D8): NONE on office devices, TAP (default) or TAP_PIN on kiosks. */
  attribution: z.enum(['NONE', 'TAP', 'TAP_PIN']),
});
export type SessionView = z.infer<typeof SessionView>;

/** A demo terminal the picker can install into this browser (DEMO-ONLY keys; demo databases only). */
export const DemoDeviceView = z.strictObject({
  deviceCode: z.string(),
  deviceClass: DeviceClass,
  roomCode: z.string().nullable(),
  description: z.string(),
  /** PKCS#8 DER of the DEMO-ONLY private key, base64; the picker imports it as non-extractable. */
  privateKeyPkcs8: Base64Text,
  /** SPKI DER of the public key, base64. */
  publicKeySpki: Base64Text,
  /**
   * Demo persons who log in on this terminal, with their DEMO-ONLY badge UID for the demo badge-reader drawer
   * (no password or PIN: the credential card is printed by `pnpm demo`).
   */
  personas: z.array(z.strictObject({ legalName: z.string(), loginName: z.string(), role: z.string(), badgeUid: z.string().nullable() })),
});
export type DemoDeviceView = z.infer<typeof DemoDeviceView>;

export const LoginRequest = z.strictObject({
  method: LoginMethod,
  /** Login name (PASSWORD) or badge UID from the reader (BADGE_PIN). */
  identifier: z.string().min(1).max(128),
  /** Password or PIN; never logged, never stored by the browser. */
  secret: z.string().min(1).max(256),
  /** Declared role when the account holds several (else chosen after login). */
  roleCode: z.string().optional(),
  proof: DeviceProof,
});

/**
 * A secret change proves the current secret either by the ticket a MUST_CHANGE_SECRET login refusal returned
 * (an initial secret is single use, so the refused login already used it) or by the current secret itself.
 */
export const ChangeSecretRequest = z
  .strictObject({
    method: LoginMethod,
    identifier: z.string().min(1).max(128),
    currentSecret: z.string().min(1).max(256).optional(),
    changeTicket: z.string().min(16).max(128).optional(),
    newSecret: z.string().min(1).max(256),
    kind: z.enum(['PASSWORD', 'PIN']),
    proof: DeviceProof,
  })
  .refine((r) => (r.currentSecret === undefined) !== (r.changeTicket === undefined), { message: 'give either the current secret or the change ticket' });

/**
 * Asking for a device nonce (DI-19, DI-20). `spki` is the public key (SPKI DER, base64) of the terminal that will sign
 * with the nonce: the nonce is bound to it, and a proof signed with any other key is refused. `lastNonce` is the nonce
 * of this terminal's last device proof, if it has made one: when that proof succeeded (an enrolled, active browser
 * terminal) within the last ten minutes, it is the request's proof ticket, good once, and the request counts toward the
 * terminal's own rate limit. Without a ticket it counts toward the allowance its address shares with every such request.
 */
export const DeviceNonceRequest = z.strictObject({
  spki: Base64Text.max(512),
  lastNonce: z.string().min(16).max(128).optional(),
});

export const session = {
  deviceNonce: defineRoute({
    id: 'session.deviceNonce',
    method: 'POST',
    path: '/api/session/device-nonce',
    installation: 'ANY',
    auth: 'NONE',
    mutating: true,
    summary: 'A single-use nonce (60 s) for the next device proof',
    body: DeviceNonceRequest,
    response: z.strictObject({ nonce: z.string().min(16), expiresInSeconds: z.number().int().positive() }),
  }),
  identify: defineRoute({
    id: 'session.identify',
    method: 'POST',
    path: '/api/session/identify',
    installation: 'ANY',
    auth: 'NONE',
    mutating: true,
    summary: 'Which registered terminal this browser is (device proof; DI-20)',
    body: z.strictObject({ proof: DeviceProof }),
    response: DeviceView,
  }),
  demoDevices: defineRoute({
    id: 'session.demoDevices',
    method: 'GET',
    path: '/api/demo/devices',
    installation: 'ANY',
    auth: 'NONE',
    mutating: false,
    summary: 'Demo terminals and their DEMO-ONLY keys (404 unless EBMR_DEMO=1 and the database is a demo database)',
    response: z.strictObject({ devices: z.array(DemoDeviceView) }),
  }),
  login: defineRoute({
    id: 'session.login',
    method: 'POST',
    path: '/api/session/login',
    installation: 'ANY',
    auth: 'NONE',
    mutating: true,
    summary: 'Log in with user ID and password (office) or badge and PIN (kiosk)',
    body: LoginRequest,
    response: SessionView,
  }),
  changeSecret: defineRoute({
    id: 'session.changeSecret',
    method: 'POST',
    path: '/api/session/change-secret',
    installation: 'ANY',
    auth: 'NONE',
    mutating: true,
    summary: 'Change an initial, reset or aged password or PIN (first login)',
    body: ChangeSecretRequest,
    response: z.strictObject({ changed: z.literal(true) }),
  }),
  get: defineRoute({
    id: 'session.get',
    method: 'GET',
    path: '/api/session',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'The current session (401 without one)',
    response: SessionView,
  }),
  chooseRole: defineRoute({
    id: 'session.chooseRole',
    method: 'POST',
    path: '/api/session/role',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    idempotency: 'NONE',
    summary: 'Declare the role of this session when the account holds several',
    body: z.strictObject({ roleCode: z.string().min(1) }),
    response: SessionView,
  }),
  logout: defineRoute({
    id: 'session.logout',
    method: 'POST',
    path: '/api/session/logout',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    idempotency: 'NONE',
    summary: 'End the session and unbind its cookie',
    body: Empty,
    response: z.strictObject({ loggedOut: z.literal(true) }),
  }),
} as const;
