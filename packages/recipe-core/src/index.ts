/**
 * Recipe engine: flow model, validator, execution engine, simulator, limits, generic blocks, MBR life cycle.
 *
 * Phase 0 skeleton: exposes the package identity only. Real modules arrive in the phase
 * that owns them (see docs/outline/build-outline.md section 11).
 */
import { PACKAGE as KernelPackage } from '@ebmr/kernel';
import { PACKAGE as ExprPackage } from '@ebmr/expr';

export const PACKAGE = { name: '@ebmr/recipe-core', version: '0.1.0' } as const;

/** Exact versions of the shared packages this module was built against (ADR 0015). */
export const BUILT_AGAINST = [KernelPackage, ExprPackage] as const;

// ---- Phase 2, module A2: MBR flow model, compiler, validator, limits, simulator -----------------
// Exported as namespaces (like the kernel) so other modules' names never clash. See flow/README.md.
export * as flow from './flow/index.ts';
export * as validator from './validator/index.ts';
export * as limits from './limits/index.ts';
export * as simulator from './simulator/index.ts';
// ---- end of module A2 exports ---------------------------------------------------------------------
