/**
 * Placeholder contract: EMS (environmental monitoring: room temperature and relative humidity for Tablets rooms; slice 6b).
 * Phase 6 slice 6a-0 reserves the system name and the module; the owning slice adds the message types (additive only).
 */
import type { SystemContract } from '../contract.ts';

export const EMS: SystemContract = { system: 'EMS', inbound: {}, outbound: [], refusalCodes: {} };
