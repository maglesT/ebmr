/**
 * Site gateway (module C5): MT-SICS scale drivers, the fsync'd hash-chained reading journal, Ed25519-signed
 * readings, the uplink to the server's gateway listener under an INTEGRATION identity, and the API the server uses
 * for capture and the live display. The process entry is src/main.ts (EBMR_GW_CONFIG).
 *
 * It never imports the kernel or a database driver (.dependency-cruiser.cjs rule gateway-and-simulators-no-db):
 * it depends on the zod-only scale and process contracts of the integration SDK. Presses and coaters (process-uplink.ts)
 * arrive with Phase 3 slice 3a; printers and OPC UA in later phases.
 */
import { PROCESS_CONTRACT } from '@ebmr/integration-sdk/process';
import { SCALE_CONTRACT } from '@ebmr/integration-sdk/scale';

export const PACKAGE = { name: '@ebmr/site-gateway', version: '0.1.0' } as const;

/** Exact versions of the shared contracts this module was built against (ADR 0015). */
export const BUILT_AGAINST = [SCALE_CONTRACT, PROCESS_CONTRACT] as const;

export { startGatewayApi } from './api.ts';
export { loadGatewayConfig, parseGatewayConfig, type GatewayConfig } from './config.ts';
export { SiteGateway, type GatewayAlarmRecord } from './gateway.ts';
export { Journal, JournalIntegrityError } from './journal.ts';
export { ProcessJournal, ProcessJournalIntegrityError } from './process-journal.ts';
export { ProcessGateway, type GatewaySession, type ProcessAlarm } from './process-uplink.ts';
