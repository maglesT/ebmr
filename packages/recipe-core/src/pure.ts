/**
 * Browser-safe subpath `@ebmr/recipe-core/pure` (Phase 2 apps plan section 3).
 *
 * Re-exports the pure folders: the flow model, validator, limits, simulator, execution engine and
 * blocks. None of them imports the kernel, a database driver or a node core module
 * (.dependency-cruiser.cjs rules recipe-core-pure-no-kernel and pure-code-no-node-core), so the web
 * app, the UI kit and the API contract can use them. The MBR life cycle (`lifecycle`) and the
 * database-backed execution store (`execution`) are node-only and reachable from the root export only.
 */
export const PACKAGE = { name: '@ebmr/recipe-core', version: '0.1.0' } as const;

export * as flow from './flow/index.ts';
export * as validator from './validator/index.ts';
export * as limits from './limits/index.ts';
export * as simulator from './simulator/index.ts';
export * as engine from './engine/index.ts';
export * as blocks from './blocks/index.ts';
export * as library from './library/index.ts';
