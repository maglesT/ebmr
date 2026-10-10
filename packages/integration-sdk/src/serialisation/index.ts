/**
 * Serialisation contract (`@ebmr/integration-sdk/serialisation`, Phase 3 slice 4a, K-21, PR-42): the L3 stub's pools,
 * serial state events and hashed pool report, and the market code content (EU FMD, US DSCSA, India Schedule H2
 * batch-level QR) as data (D-S4-1). Shared by the serialisation stub in apps/simulators and the tablets server.
 *
 * zod and node built-ins only; never the kernel or a database driver.
 */
export const SERIALISATION_CONTRACT = { name: '@ebmr/integration-sdk/serialisation', version: '0.1.0' } as const;

export * from './market.ts';
export * from './wire.ts';
