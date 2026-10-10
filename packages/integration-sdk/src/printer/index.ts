/**
 * Printer and coder contract (`@ebmr/integration-sdk/printer`, Phase 3 slice 4a, G-21, K-20): print jobs with the
 * record's variable data, the printer's echo and the job acknowledgement, the print events (printed counts, reader,
 * vision and challenge results, faults) with their pure validators, and the codec of the printer simulator's protocol.
 * Shared by the site gateway, the simulators and the tablets server's gateway listener.
 *
 * zod and node built-ins only; never the kernel or a database driver. Values are text, never JavaScript numbers.
 */
export const PRINTER_CONTRACT = { name: '@ebmr/integration-sdk/printer', version: '0.1.0' } as const;

export * from './wire.ts';
export * from './sim-protocol.ts';
