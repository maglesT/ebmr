/**
 * Site gateway (module C5): MT-SICS scale drivers, the fsync'd hash-chained reading journal, Ed25519-signed
 * readings, the uplink to the server's gateway listener under an INTEGRATION identity, and the API the server uses
 * for capture and the live display. The process entry is src/main.ts (EBMR_GW_CONFIG).
 *
 * It never imports the kernel or a database driver (.dependency-cruiser.cjs rule gateway-and-simulators-no-db):
 * it depends on the zod-only scale contract of the integration SDK. Printers and OPC UA arrive in later phases.
 */
import { SCALE_CONTRACT } from '@ebmr/integration-sdk/scale';

export const PACKAGE = { name: '@ebmr/site-gateway', version: '0.1.0' } as const;

/** Exact versions of the shared contracts this module was built against (ADR 0015). */
export const BUILT_AGAINST = [SCALE_CONTRACT] as const;

export { startGatewayApi } from './api.ts';
export { loadGatewayConfig, parseGatewayConfig, type GatewayConfig } from './config.ts';
export { SiteGateway, type GatewayAlarmRecord } from './gateway.ts';
export { Journal, JournalIntegrityError } from './journal.ts';
