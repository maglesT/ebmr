/**
 * Database-backed execution store (node-only; Phase 2 apps plan section 7). Stub created by the
 * lead's spine (C0); ownership passes to module C3, which replaces this file with issue, lock,
 * append, load, replayExecution and the content-provider helpers.
 *
 * Reachable only from the root export (`import { execution } from '@ebmr/recipe-core'`), never from
 * the browser-safe `@ebmr/recipe-core/pure` subpath.
 */
export const EXECUTION_STORE_READY = false as const;
