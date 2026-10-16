/**
 * OPC UA contract (Phase 6 slice 6b-0; DI-49, DI-32, DI-31, DI-20; plan "Slice 6b"; fixed signatures in
 * docs/build-plan/phase-6/slice-6b-0-interfaces.md). The site gateway is the OPC UA client (apps/site-gateway
 * drivers/opcua.ts); it speaks to the equipment's OPC UA servers and hands the eBMR two streams:
 *
 *  - the process readings of the released tags (ACTUAL, SETPOINT_READBACK, ALARM, ALARM_CLEARED) on the existing
 *    gateway path `/gw/v1/process-readings` (tablets 0820), unchanged, so G-06 entries stand on them as today;
 *  - the messages below, as inbound envelopes (6a adapter framework) through the gateway's feed endpoint, which the
 *    server's OPCUA adapter worker pulls: native series chunks, alarm occurrences that are not tag readings (OPC UA
 *    Alarms and Conditions: a reject burst, a door, a feed gap) and equipment events.
 *
 * Node ids are derived from the released tag names (process/tags.ts), never renamed: `nsu=<OPCUA_NAMESPACE_URI>;s=
 * <equipmentCode>/<tag>`. An endpoint is reached only with SignAndEncrypt and a certificate enrolled for it (D-P6b-2).
 *
 * Receiving commands (recipe-core 0960): plant.receive_series_chunk, plant.receive_equipment_alarm,
 * plant.receive_equipment_event.
 */
import { z } from 'zod';
import { PROCESS_TAGS, tagSpec, type TagSpec } from '../../process/tags.ts';
import type { SystemContract } from '../contract.ts';
import { EquipmentAlarmV1, EquipmentEventV1, SeriesChunkV1 } from '../equipment-data.ts';

/** The namespace of the eBMR's tag map on an equipment OPC UA server. */
export const OPCUA_NAMESPACE_URI = 'urn:ebmr:process:tags:v1';

/** The recipe version node of a unit (read by the gateway and compared with the MBR's, plan 6b "recipe version read"). */
export const RECIPE_VERSION_TAG = 'recipe.version';

const EQUIPMENT_CODE = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;

/** The node id of `tag` on unit `equipmentCode` (an expanded node id with the namespace URI and a string identifier). */
export function opcuaNodeId(equipmentCode: string, tag: string): string {
  if (!EQUIPMENT_CODE.test(equipmentCode)) throw new Error(`${equipmentCode} is not an equipment code`);
  if (!tagSpec(tag) && tag !== RECIPE_VERSION_TAG) throw new Error(`${tag} is not a released process tag`);
  return `nsu=${OPCUA_NAMESPACE_URI};s=${equipmentCode}/${tag}`;
}

/** The unit and tag a node id names, or null when it is not a node of the eBMR's tag map. */
export function parseOpcuaNodeId(nodeId: string): { equipmentCode: string; tag: string } | null {
  const prefix = `nsu=${OPCUA_NAMESPACE_URI};s=`;
  if (!nodeId.startsWith(prefix)) return null;
  const rest = nodeId.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const equipmentCode = rest.slice(0, slash);
  const tag = rest.slice(slash + 1);
  if (!EQUIPMENT_CODE.test(equipmentCode)) return null;
  if (!tagSpec(tag) && tag !== RECIPE_VERSION_TAG) return null;
  return { equipmentCode, tag };
}

export interface OpcuaTagEntry extends Pick<TagSpec, 'equipment' | 'unit' | 'scale' | 'setpoint' | 'counter'> {
  readonly browseName: string;
}

/** The tag map: every released process tag with its browse name (the tag itself), unit and fraction digits. */
export const OPCUA_TAG_MAP: Readonly<Record<string, OpcuaTagEntry>> = Object.fromEntries(
  PROCESS_TAGS.map((t) => [t.tag, { browseName: t.tag, equipment: t.equipment, unit: t.unit, scale: t.scale, setpoint: t.setpoint, counter: t.counter }]),
);

/** D-P6b-2: the security policies accepted, always with SignAndEncrypt; anonymous and None-mode endpoints are refused (DI-13). */
export const OPCUA_SECURITY_POLICIES = ['Basic256Sha256', 'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsaPss'] as const;

/** One enrolled endpoint (DI-20: registered with its certificate thumbprint and the room or line it serves). */
export const OpcuaEndpoint = z.strictObject({
  endpointUrl: z.string().regex(/^opc\.tcp:\/\/[\x21-\x7E]{1,200}$/, 'opc.tcp://host:port/path'),
  securityMode: z.literal('SignAndEncrypt'),
  securityPolicy: z.enum(OPCUA_SECURITY_POLICIES),
  /** SHA-256 (lower-case hex) of the server certificate's DER bytes; a changed certificate is refused with an alarm. */
  certificateThumbprint: z.string().regex(/^[0-9a-f]{64}$/),
  /** The units this endpoint serves (plant.equipment codes). */
  equipmentCodes: z.array(z.string().regex(EQUIPMENT_CODE)).min(1).max(64),
  /** The room or line it is installed in (plant.area code); a relocated endpoint is refused (DI-20). */
  areaCode: z.string().regex(EQUIPMENT_CODE),
});
export type OpcuaEndpoint = z.infer<typeof OpcuaEndpoint>;

// ---------------------------------------------------------------------------------------------------------------
// Slice 6b builder A (additive; DI-20, D-P6b-2): the endpoint's session as the gateway opened it
// ---------------------------------------------------------------------------------------------------------------

/** The node on which an equipment OPC UA server states the room or line it is installed in (plant.area code). */
export const ENDPOINT_LOCATION_NODE = `nsu=${OPCUA_NAMESPACE_URI};s=_endpoint/location`;

/**
 * The setpoint node of a setpoint tag of a unit (written by the gateway's download, read back separately); the tag's own
 * node carries the measured value. Only for the released setpoint tags.
 */
export function opcuaSetpointNodeId(equipmentCode: string, tag: string): string {
  if (!tagSpec(tag)?.setpoint) throw new Error(`${tag} is not a released setpoint tag`);
  return `${opcuaNodeId(equipmentCode, tag)}/setpoint`;
}

/** The node listing a unit's limit alarms active now, as `CODE|tag` entries joined by `;` (empty when none). */
export function opcuaActiveAlarmsNodeId(equipmentCode: string): string {
  if (!EQUIPMENT_CODE.test(equipmentCode)) throw new Error(`${equipmentCode} is not an equipment code`);
  return `nsu=${OPCUA_NAMESPACE_URI};s=${equipmentCode}/_alarms/active`;
}

/**
 * The node on which a unit publishes each alarm occurrence transition (EquipmentAlarmV1) and equipment event
 * (EquipmentEventV1) as one JSON value per change, `{"alarm": {...}}` or `{"event": {...}}` (D-P6b-A-3: the gateway
 * monitors it with a queue, so every change arrives; a real endpoint's Alarms and Conditions map onto the same port).
 */
export function opcuaEventsNodeId(equipmentCode: string): string {
  if (!EQUIPMENT_CODE.test(equipmentCode)) throw new Error(`${equipmentCode} is not an equipment code`);
  return `nsu=${OPCUA_NAMESPACE_URI};s=${equipmentCode}/_events`;
}

/** An endpoint's code: its device code in the device registry (iam.device, class INSTRUMENT). */
export const EndpointCode = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/, 'a device code of the device registry');

/**
 * `opcua.endpoint_session` v1: what the gateway found when it opened (or re-opened) a session to an endpoint: the
 * security it got, the SHA-256 of the server certificate presented, the location the server reports and the units it
 * serves. The gateway sends it on its feed before any data of that session; recipe-core 0961 judges it against the
 * enrolment (device registry: certificate thumbprint, room or line, status; plant.opcua_endpoint: URL, policy, units)
 * and records it VALID or REFUSED with an alarm. Data of a unit are accepted only under its endpoint's latest VALID
 * session that still matches the enrolment (DI-20: an unregistered, re-keyed or relocated endpoint is refused).
 */
export const OpcuaEndpointSessionV1 = z.strictObject({
  endpointCode: EndpointCode,
  endpointUrl: z.string().regex(/^opc\.tcp:\/\/[\x21-\x7E]{1,200}$/, 'opc.tcp://host:port/path'),
  securityMode: z.enum(['None', 'Sign', 'SignAndEncrypt']),
  securityPolicy: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
  certificateThumbprint: z.string().regex(/^[0-9a-f]{64}$/),
  /** The room or line the server reports on ENDPOINT_LOCATION_NODE, or null when it reports none. */
  reportedLocation: z.string().regex(EQUIPMENT_CODE).nullable(),
  equipmentCodes: z.array(z.string().regex(EQUIPMENT_CODE)).min(1).max(64),
  openedAt: z.string().regex(/^(0|[1-9][0-9]{0,15})$/),
});
export type OpcuaEndpointSessionV1 = z.infer<typeof OpcuaEndpointSessionV1>;

/** The refusals of the equipment-data and alarm receiving commands (recipe-core 0960), shared by OPCUA and EMS. */
export const EQUIPMENT_DATA_REFUSALS = {
  'EBMR-EQD-001': 'MALFORMED',
  'EBMR-EQD-002': 'WRONG_IDENTITY',
  'EBMR-EQD-003': 'OUT_OF_RANGE',
  'EBMR-EQD-004': 'DUPLICATE',
  'EBMR-EQD-005': 'OUT_OF_ORDER',
  'EBMR-ALM-001': 'MALFORMED',
  'EBMR-ALM-002': 'WRONG_IDENTITY',
  'EBMR-ALM-003': 'OUT_OF_RANGE',
  'EBMR-ALM-004': 'DUPLICATE',
  'EBMR-ALM-005': 'OUT_OF_ORDER',
  // Slice 6b builder A (recipe-core 0961): a malformed endpoint session; a wrong endpoint is recorded, not refused.
  'EBMR-EQD-020': 'MALFORMED',
} as const satisfies SystemContract['refusalCodes'];

export const OPCUA: SystemContract = {
  system: 'OPCUA',
  inbound: {
    'opcua.series_chunk': { summary: 'Native samples of one tag of one unit, with source timestamps, raw values and status codes (DI-32)', versions: { '1': SeriesChunkV1 } },
    'opcua.alarm': { summary: 'An alarm occurrence of a unit raised, cleared or acknowledged at the source (DI-49)', versions: { '1': EquipmentAlarmV1 } },
    'opcua.equipment_event': { summary: 'An equipment event: state change, recipe loaded or mismatched, phase, operator action, fault', versions: { '1': EquipmentEventV1 } },
    'opcua.endpoint_session': { summary: 'A session the gateway opened to an enrolled endpoint: security, certificate, location, units (DI-20)', versions: { '1': OpcuaEndpointSessionV1 } },
  },
  outbound: [],
  refusalCodes: EQUIPMENT_DATA_REFUSALS,
};
