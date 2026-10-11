/**
 * Scale contract (`@ebmr/integration-sdk/scale`): readings, capture requests and errors, the gateway uplink and
 * the MT-SICS codec, shared by the site gateway, the scale simulator and the tablets server's gateway listener
 * (Phase 2 apps plan section 10; module C5).
 *
 * zod and node built-ins only; never the kernel or a database driver, so the gateway and the simulators stay
 * free of the database (.dependency-cruiser.cjs rule gateway-and-simulators-no-db). Weights are decimal text,
 * never JavaScript numbers.
 */
export const SCALE_CONTRACT = { name: '@ebmr/integration-sdk/scale', version: '0.1.0' } as const;

export * from './decimal.ts';
export * from './instruments.ts';
export * from './mt-sics.ts';
export * from './reading.ts';
export * from './wire.ts';

/** The ScaleStatus of the C0 stub: the statuses a reading can carry (value and type). */
export { ReadingStatus as ScaleStatus } from './reading.ts';
