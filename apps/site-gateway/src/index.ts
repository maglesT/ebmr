/**
 * Site gateway: scale and printer drivers, OPC UA client, buffering, device identity.
 *
 * It never imports the kernel or a database driver (.dependency-cruiser.cjs rule
 * gateway-and-simulators-no-db): it depends on the zod-only scale contract of the integration SDK.
 * The gateway process arrives with module C5 (src/main.ts).
 */
import { SCALE_CONTRACT } from '@ebmr/integration-sdk/scale';

export const PACKAGE = { name: '@ebmr/site-gateway', version: '0.1.0' } as const;

/** Exact versions of the shared contracts this module was built against (ADR 0015). */
export const BUILT_AGAINST = [SCALE_CONTRACT] as const;
