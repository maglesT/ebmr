/**
 * Site services shared by both editions at one site: persons, qualifications, lots and reservations, batch numbers, devices.
 *
 * Phase 1: the batch-number allocation register (src/batch-numbers/README.md). The other site data
 * arrive in the phase that owns them (see docs/outline/build-outline.md section 11).
 */
import { PACKAGE as KernelPackage } from '@ebmr/kernel';

export const PACKAGE = { name: '@ebmr/site-services', version: '0.1.0' } as const;

/** Exact versions of the shared packages this module was built against (ADR 0015). */
export const BUILT_AGAINST = [KernelPackage] as const;

export * from './batch-numbers/index.ts';
