/**
 * Database-backed execution store (node-only; Phase 2 apps plan section 7; module C3). Reachable only from
 * the root export (`import { execution } from '@ebmr/recipe-core'`), never from the browser-safe
 * `@ebmr/recipe-core/pure` subpath. See README.md in this folder.
 */
export const EXECUTION_STORE_READY = true as const;

export * from './test-package.ts';
export * from './store.ts';
export * from './run.ts';
export * from './verify.ts';
export * from './register.ts';
