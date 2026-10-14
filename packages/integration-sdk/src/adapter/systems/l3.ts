/**
 * Placeholder contract: Serialisation L3/L4 (slice 6c; the pool contract in ../../serialisation stays the device-side one).
 * Phase 6 slice 6a-0 reserves the system name and the module; the owning slice adds the message types (additive only).
 */
import type { SystemContract } from '../contract.ts';

export const L3: SystemContract = { system: 'L3', inbound: {}, outbound: [], refusalCodes: {} };
