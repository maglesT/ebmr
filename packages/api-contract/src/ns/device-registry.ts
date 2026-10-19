/**
 * Namespace `deviceRegistry` (Phase 7 slice 7g-1, decision 0025): the registration of terminals and devices on a screen.
 * Every route runs the database's own function under the person's named account; the database decides every rule
 * (DI-19, DI-20, DI-31):
 *  - terminals: `iam.register_device`, `iam.relocate_device`, `iam.set_device_status` (IAM.DEVICE_MANAGE) and the
 *    hardening attestation of a shared or Grade A/B kiosk, `continuity.record_hardening_attestation`
 *    (CONTINUITY.HARDENING_ATTEST);
 *  - behind a gateway key: balances `tab.bind_instrument`, printers and readers `tab.bind_print_device`, process
 *    equipment `tab.bind_process_device`, and the end of each binding (IAM.DEVICE_MANAGE);
 *  - the gateway's signing key `tab.enrol_gateway_key` / `tab.revoke_gateway_key`, the OPC UA feed binding of slice 7a
 *    `tab.bind_gateway_feed`, and the registration of an integration adapter `iam.register_integration_adapter`.
 * A key fingerprint is public (the SHA-256 of a public key); no private key travels here.
 */
import { z } from 'zod';
import { Base64Text, Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

const Text = (max: number) => z.string().trim().min(1).max(max);
const Code = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'a code of letters, digits, dot, underscore or hyphen');
const Serial = z.string().trim().regex(/^[!#-~]{1,32}$/, 'a serial of 1 to 32 printable characters without spaces or quotes');

export const RegistryDeviceClass = z.enum(['PERSONAL', 'SHARED', 'GRADE_A_B', 'SERVER', 'INSTRUMENT']);

export const TerminalView = z.strictObject({
  deviceId: Uuid,
  code: z.string(),
  deviceClass: RegistryDeviceClass,
  siteCode: z.string(),
  roomCode: z.string().nullable(),
  lineCode: z.string().nullable(),
  status: z.enum(['ACTIVE', 'BLOCKED', 'DECOMMISSIONED']),
  statusReason: z.string().nullable(),
  /** The SHA-256 of the terminal's public key (lowercase hex). */
  fingerprint: z.string(),
  description: z.string(),
  registeredBy: PersonRef,
  registeredAt: Instant,
  /** Shared and Grade A/B kiosks: the hardening attestation in force (DI-19); null for other classes or none yet. */
  hardening: z.strictObject({ attestationId: Uuid, result: z.string(), method: z.string(), evidenceRef: z.string(), validUntil: Instant.nullable(), attestedBy: PersonRef }).nullable(),
  hardeningRequired: z.boolean(),
});
export type TerminalView = z.infer<typeof TerminalView>;

export const GatewayKeyView = z.strictObject({
  keyId: Uuid,
  gatewayCode: z.string(),
  loginName: z.string(),
  fingerprint: z.string(),
  status: z.string(),
  enrolledBy: PersonRef,
  enrolledAt: Instant,
  revokedAt: Instant.nullable(),
  revokedReason: z.string().nullable(),
});
export type GatewayKeyView = z.infer<typeof GatewayKeyView>;

export const BoundDeviceView = z.strictObject({
  bindingId: Uuid,
  kind: z.enum(['BALANCE', 'PRINT', 'PROCESS']),
  deviceCode: z.string(),
  gatewayCode: z.string(),
  gatewayKeyId: Uuid,
  serial: z.string(),
  /** Balance: unit and resolution; print: PRINTER, READER, VISION, CHECKWEIGHER or LEAFLET_DETECTOR; process: the equipment kind. */
  detail: z.string(),
  boundBy: PersonRef,
  boundAt: Instant,
  endedAt: Instant.nullable(),
  endedReason: z.string().nullable(),
});
export type BoundDeviceView = z.infer<typeof BoundDeviceView>;

export const AdapterView = z.strictObject({
  adapterId: Uuid,
  code: z.string(),
  sourceSystem: z.string(),
  loginName: z.string(),
  deviceCode: z.string(),
  status: z.string(),
  description: z.string(),
  registeredBy: PersonRef,
  registeredAt: Instant,
  /** OPC UA adapters: the gateway whose signed feed it pulls (slice 7a), with the binding. */
  feed: z.strictObject({ bindingId: Uuid, gatewayCode: z.string(), boundBy: PersonRef, boundAt: Instant }).nullable(),
});
export type AdapterView = z.infer<typeof AdapterView>;

export const DeviceRegistryView = z.strictObject({
  siteCode: z.string().nullable(),
  terminals: z.array(TerminalView),
  gatewayKeys: z.array(GatewayKeyView),
  bindings: z.array(BoundDeviceView),
  adapters: z.array(AdapterView),
  /** Accounts a gateway key or an adapter may run under (INTEGRATION accounts that are not disabled). */
  integrationAccounts: z.array(z.strictObject({ accountId: Uuid, loginName: z.string(), status: z.string() })),
  /** The source systems an adapter may be registered for. */
  sourceSystems: z.array(z.string()),
});
export type DeviceRegistryView = z.infer<typeof DeviceRegistryView>;

// Phase 7 slice 7g, work package 2: per-entry attribution, OPC UA endpoint identities, process devices' plant units.

export const OpcuaEndpointView = z.strictObject({
  deviceCode: z.string(),
  version: z.number().int().positive(),
  status: z.enum(['ENROLLED', 'RETIRED']),
  endpointUrl: z.string(),
  securityPolicy: z.string(),
  certificateThumbprint: z.string(),
  equipmentCodes: z.array(z.string()),
  reason: z.string(),
  recordedBy: PersonRef,
  recordedAt: Instant,
});
export type OpcuaEndpointView = z.infer<typeof OpcuaEndpointView>;

export const DeviceConfigurationView = z.strictObject({
  /** The per-entry attribution of each kiosk class now (decision D8): TAP or TAP_PIN. */
  attribution: z.array(z.strictObject({ deviceClass: z.enum(['SHARED', 'GRADE_A_B']), method: z.enum(['TAP', 'TAP_PIN']) })),
  /** Each OPC UA endpoint's enrolment in force (its latest version). */
  opcuaEndpoints: z.array(OpcuaEndpointView),
  /** Each active process device binding with the plant unit it is linked to (null before the link). */
  processDeviceUnits: z.array(z.strictObject({ bindingId: Uuid, deviceCode: z.string(), equipmentCode: z.string().nullable() })),
});
export type DeviceConfigurationView = z.infer<typeof DeviceConfigurationView>;

const SecurityPolicy = z.enum(['Basic256Sha256', 'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsaPss']);

const deviceParams = z.strictObject({ deviceId: Uuid });
const reason = { reason: Text(2000) };

export const deviceRegistry = {
  list: defineRoute({
    id: 'deviceRegistry.list',
    method: 'GET',
    path: '/api/admin/devices',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'Registered terminals and devices, gateway keys, device bindings and integration adapters with their feed bindings (administration roles)',
    response: DeviceRegistryView,
  }),
  registerTerminal: defineRoute({
    id: 'deviceRegistry.registerTerminal',
    method: 'POST',
    path: '/api/admin/devices',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Register a terminal or device with its class, room and key fingerprint (IAM.DEVICE_MANAGE)',
    body: withAttribution({
      code: Code,
      deviceClass: RegistryDeviceClass,
      room: Code.optional(),
      line: Code.optional(),
      fingerprint: z.string().trim().regex(/^[0-9a-f]{64}$/, 'the SHA-256 of the public key, 64 lowercase hexadecimal digits'),
      description: Text(500),
    }),
    response: TerminalView,
  }),
  relocateTerminal: defineRoute({
    id: 'deviceRegistry.relocateTerminal',
    method: 'POST',
    path: '/api/admin/devices/:deviceId/location',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Move a terminal to another room or line; its sessions end (IAM.DEVICE_MANAGE)',
    params: deviceParams,
    body: withAttribution({ room: Code.optional(), line: Code.optional(), ...reason }),
    response: TerminalView,
  }),
  setTerminalStatus: defineRoute({
    id: 'deviceRegistry.setTerminalStatus',
    method: 'POST',
    path: '/api/admin/devices/:deviceId/status',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Block, re-activate or decommission a terminal; its sessions end (IAM.DEVICE_MANAGE)',
    params: deviceParams,
    body: withAttribution({ status: z.enum(['ACTIVE', 'BLOCKED', 'DECOMMISSIONED']), ...reason }),
    response: TerminalView,
  }),
  attestHardening: defineRoute({
    id: 'deviceRegistry.attestHardening',
    method: 'POST',
    path: '/api/admin/devices/:deviceId/hardening',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Attest the hardening of a shared or Grade A/B kiosk: USB storage, kiosk mode, malware protection, OS patches (CONTINUITY.HARDENING_ATTEST)',
    params: deviceParams,
    body: withAttribution({
      usbMassStorageBlocked: z.boolean(),
      kioskModeEnforced: z.boolean(),
      malwareProtectionActive: z.boolean(),
      osPatchWithinSla: z.boolean(),
      osBuild: Text(100).optional(),
      method: z.enum(['MDM_COMPLIANCE_REPORT', 'MANUAL_INSPECTION']),
      evidenceRef: Text(200),
      validityDays: z.number().int().min(30).max(365).optional(),
    }),
    response: TerminalView,
  }),
  bindDevice: defineRoute({
    id: 'deviceRegistry.bindDevice',
    method: 'POST',
    path: '/api/admin/device-bindings',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Bind a registered INSTRUMENT behind a gateway key: a balance (unit, resolution), a printer or reader, or process equipment (IAM.DEVICE_MANAGE)',
    body: withAttribution({
      kind: z.enum(['BALANCE', 'PRINT', 'PROCESS']),
      gatewayKeyId: Uuid,
      deviceCode: Code,
      serial: Serial,
      /** BALANCE only. */
      unit: z.string().trim().min(1).max(8).optional(),
      resolution: z.string().trim().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/, 'a decimal as text').optional(),
      /** PRINT: PRINTER, READER, VISION, CHECKWEIGHER, LEAFLET_DETECTOR; PROCESS: the equipment kind. */
      deviceKind: Code.optional(),
    }),
    response: BoundDeviceView,
  }),
  endBinding: defineRoute({
    id: 'deviceRegistry.endBinding',
    method: 'POST',
    path: '/api/admin/device-bindings/:bindingId/end',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'End a device binding (IAM.DEVICE_MANAGE)',
    params: z.strictObject({ bindingId: Uuid }),
    body: withAttribution({ kind: z.enum(['BALANCE', 'PRINT', 'PROCESS']), ...reason }),
    response: BoundDeviceView,
  }),
  enrolGatewayKey: defineRoute({
    id: 'deviceRegistry.enrolGatewayKey',
    method: 'POST',
    path: '/api/admin/gateway-keys',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Enrol a gateway\'s Ed25519 public key (SPKI, base64) for its SERVER device and INTEGRATION login (IAM.DEVICE_MANAGE)',
    body: withAttribution({ gatewayCode: Code, publicKeySpki: Base64Text.max(200), loginName: Text(128) }),
    response: GatewayKeyView,
  }),
  revokeGatewayKey: defineRoute({
    id: 'deviceRegistry.revokeGatewayKey',
    method: 'POST',
    path: '/api/admin/gateway-keys/:keyId/revocation',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Revoke a gateway key: from now on an envelope or reading signed with it is refused (IAM.DEVICE_MANAGE)',
    params: z.strictObject({ keyId: Uuid }),
    body: withAttribution({ ...reason }),
    response: GatewayKeyView,
  }),
  bindGatewayFeed: defineRoute({
    id: 'deviceRegistry.bindGatewayFeed',
    method: 'POST',
    path: '/api/admin/gateway-feeds',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Bind an OPC UA adapter to the signed feed of a gateway with an enrolled key; a gateway\'s feed has one adapter (slice 7a; IAM.DEVICE_MANAGE)',
    body: withAttribution({ adapterCode: Code, gatewayCode: Code, ...reason }),
    response: AdapterView,
  }),
  registerAdapter: defineRoute({
    id: 'deviceRegistry.registerAdapter',
    method: 'POST',
    path: '/api/admin/adapters',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Register an integration adapter under an INTEGRATION account on an active SERVER device (IAM.DEVICE_MANAGE)',
    body: withAttribution({ code: Code, sourceSystem: Code, accountId: Uuid, deviceId: Uuid, description: Text(500) }),
    response: AdapterView,
  }),
  // Phase 7 slice 7g, work package 2.
  configuration: defineRoute({
    id: 'deviceRegistry.configuration',
    method: 'GET',
    path: '/api/admin/device-configuration',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'The per-entry attribution of each kiosk class, the OPC UA endpoint identities and the plant unit of each process device (administration roles)',
    response: DeviceConfigurationView,
  }),
  setAttributionMethod: defineRoute({
    id: 'deviceRegistry.setAttributionMethod',
    method: 'POST',
    path: '/api/admin/attribution-methods',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Set the per-entry attribution of a kiosk class, a badge tap or a tap with a PIN (IAM.POLICY_MANAGE; decision D8)',
    body: withAttribution({ deviceClass: z.enum(['SHARED', 'GRADE_A_B']), method: z.enum(['TAP', 'TAP_PIN']), ...reason }),
    response: DeviceConfigurationView,
  }),
  revokeHardening: defineRoute({
    id: 'deviceRegistry.revokeHardening',
    method: 'POST',
    path: '/api/admin/hardening-attestations/:attestationId/revocation',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Revoke a kiosk\'s hardening attestation with the reason; the kiosk is no longer attested (CONTINUITY.HARDENING_ATTEST)',
    params: z.strictObject({ attestationId: Uuid }),
    body: withAttribution({ ...reason }),
    response: TerminalView,
  }),
  enrolOpcuaEndpoint: defineRoute({
    id: 'deviceRegistry.enrolOpcuaEndpoint',
    method: 'POST',
    path: '/api/admin/opcua-endpoints',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Enrol an OPC UA endpoint\'s identity: a registered instrument, its opc.tcp URL under SignAndEncrypt, the units it serves (IAM.DEVICE_MANAGE)',
    body: withAttribution({
      deviceCode: Code,
      endpointUrl: z.string().trim().regex(/^opc\.tcp:\/\/[!-~]{1,200}$/, 'an opc.tcp URL'),
      securityPolicy: SecurityPolicy,
      equipmentCodes: z.array(Code).min(1).max(64),
      ...reason,
    }),
    response: OpcuaEndpointView,
  }),
  retireOpcuaEndpoint: defineRoute({
    id: 'deviceRegistry.retireOpcuaEndpoint',
    method: 'POST',
    path: '/api/admin/opcua-endpoints/:deviceCode/retirement',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Retire an enrolled OPC UA endpoint with the reason (IAM.DEVICE_MANAGE)',
    params: z.strictObject({ deviceCode: Code }),
    body: withAttribution({ ...reason }),
    response: OpcuaEndpointView,
  }),
  linkProcessDeviceUnit: defineRoute({
    id: 'deviceRegistry.linkProcessDeviceUnit',
    method: 'POST',
    path: '/api/admin/device-bindings/:bindingId/unit',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Link an active process device binding to the PROCESS unit of the plant it is (IAM.DEVICE_MANAGE; one device per unit)',
    params: z.strictObject({ bindingId: Uuid }),
    body: withAttribution({ equipmentCode: Code, ...reason }),
    response: DeviceConfigurationView,
  }),
  setAdapterStatus: defineRoute({
    id: 'deviceRegistry.setAdapterStatus',
    method: 'POST',
    path: '/api/admin/adapters/:adapterCode/status',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Block, re-activate or decommission an integration adapter with the reason (IAM.DEVICE_MANAGE)',
    params: z.strictObject({ adapterCode: Code }),
    body: withAttribution({ status: z.enum(['ACTIVE', 'BLOCKED', 'DECOMMISSIONED']), ...reason }),
    response: AdapterView,
  }),
} as const;

export const DEVICE_REGISTRY_ROUTE_IDS: readonly string[] = Object.values(deviceRegistry).map((r) => r.id);
