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

// ---- Phase 2, module A3: MBR life cycle, per-market effectivity, selection at issue ---------------
// Namespace `lifecycle`; the database (sql/0100-0180, schema recipe) enforces. See lifecycle/README.md.
export * as lifecycle from './lifecycle/index.ts';
// ---- end of module A3 exports ---------------------------------------------------------------------

// ---- Phase 2, module B1: execution engine and engine-level generic blocks --------------------------
// Namespaces, like the A2 modules. See engine/README.md and blocks/README.md.
export * as engine from './engine/index.ts';
export * as blocks from './blocks/index.ts';
// ---- end of module B1 exports ---------------------------------------------------------------------

// ---- Phase 2 apps, module C3: database-backed execution store (node-only; stub until C3 lands) -----
export * as execution from './execution/index.ts';
