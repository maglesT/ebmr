/**
 * Shared UI components: design tokens, primitives, the typed English catalogue; identity, audit, floor and
 * machine components arrive with modules C1 and C4. Browser-safe: React (peer), react-aria-components, the API
 * contract and expr only (.dependency-cruiser.cjs ui-kit-allowed-deps).
 */
export { PACKAGE } from './package.ts';

export * from './tokens/index.ts';
export * from './i18n/index.ts';
export * from './primitives/index.ts';
export * as identity from './identity/index.ts';
export * as audit from './audit/index.ts';
export * as floor from './floor/index.ts';
export * as machines from './machines/index.ts';
