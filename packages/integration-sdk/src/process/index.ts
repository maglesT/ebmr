/**
 * Process equipment contract (`@ebmr/integration-sdk/process`, Phase 3 slice 3a, G-06): the press and coater tags,
 * the readings, setpoint downloads and acknowledgements on the gateway uplink with their validator, and the codec of
 * the process simulators' protocol. Shared by the site gateway, the simulators and the tablets server's gateway
 * listener.
 *
 * zod and node built-ins only; never the kernel or a database driver (.dependency-cruiser.cjs rule
 * gateway-and-simulators-no-db). Values are decimal text, never JavaScript numbers.
 */
export const PROCESS_CONTRACT = { name: '@ebmr/integration-sdk/process', version: '0.1.0' } as const;

export * from './tags.ts';
export * from './wire.ts';
export * from './sim-protocol.ts';
