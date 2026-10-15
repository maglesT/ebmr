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
} as const satisfies SystemContract['refusalCodes'];

export const OPCUA: SystemContract = {
  system: 'OPCUA',
  inbound: {
    'opcua.series_chunk': { summary: 'Native samples of one tag of one unit, with source timestamps, raw values and status codes (DI-32)', versions: { '1': SeriesChunkV1 } },
    'opcua.alarm': { summary: 'An alarm occurrence of a unit raised, cleared or acknowledged at the source (DI-49)', versions: { '1': EquipmentAlarmV1 } },
    'opcua.equipment_event': { summary: 'An equipment event: state change, recipe loaded or mismatched, phase, operator action, fault', versions: { '1': EquipmentEventV1 } },
  },
  outbound: [],
  refusalCodes: EQUIPMENT_DATA_REFUSALS,
};
