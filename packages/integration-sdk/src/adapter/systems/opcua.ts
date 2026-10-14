/**
 * Placeholder contract: OPC UA (equipment data, alarms and events; slice 6b, which fixes the node ids from the released tag names).
 * Phase 6 slice 6a-0 reserves the system name and the module; the owning slice adds the message types (additive only).
 */
import type { SystemContract } from '../contract.ts';

export const OPCUA: SystemContract = { system: 'OPCUA', inbound: {}, outbound: [], refusalCodes: {} };
