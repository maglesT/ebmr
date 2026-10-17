/**
 * Test harness: template databases and copies, sandbox provisioning (one stage, then the bootstrap), the demo and E2E
 * persona catalogue, seeding through the kernel's identity administration, persona sessions and device keys.
 * Later: golden batches, the invariant SQL library, bypass helpers.
 *
 * Product code never imports this package (dependency-cruiser product-never-imports-test-kit), except the
 * tablets server's set-up CLI, which seeds demo and E2E databases.
 */
import { PACKAGE as KernelPackage } from '@ebmr/kernel';

export const PACKAGE = { name: '@ebmr/test-kit', version: '0.1.0' } as const;

/** Exact versions of the shared packages this module was built against (ADR 0015). */
export const BUILT_AGAINST = [KernelPackage] as const;

export * from './analytics-history.ts';
export * from './analytics-review-history.ts';
export * from './db.ts';
export * from './keys.ts';
export * from './personas.ts';
export * from './sandbox.ts';
export * from './seed.ts';
export * from './validation.ts';
