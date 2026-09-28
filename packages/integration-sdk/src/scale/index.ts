/**
 * Scale contract (`@ebmr/integration-sdk/scale`): readings, capture requests and errors shared by the site
 * gateway, the scale simulator and the tablets server's gateway listener (Phase 2 apps plan section 10).
 * zod only; never the kernel, so the gateway and the simulators stay free of the database.
 *
 * Stub created by the lead's spine (C0); ownership passes to module C5, which replaces this file with the
 * ScaleReading schema, the capture request and response, the error classes and the MT-SICS codec.
 */
import { z } from 'zod';

export const SCALE_CONTRACT = { name: '@ebmr/integration-sdk/scale', version: '0.1.0' } as const;

/** Placeholder until C5 lands: the reading statuses the plan names. */
export const ScaleStatus = z.enum(['OK', 'UNSTABLE', 'OVERLOAD', 'UNDERLOAD', 'OFFLINE', 'ERROR']);
export type ScaleStatus = z.infer<typeof ScaleStatus>;
