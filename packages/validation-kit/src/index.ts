/**
 * Validation pack generators: URS, risk assessment, trace matrix, test records.
 *
 * Phase 0 skeleton: exposes the package identity only. Real modules arrive in the phase
 * that owns them (see docs/outline/build-outline.md section 11).
 */
import { PACKAGE as KernelPackage } from '@ebmr/kernel';

export const PACKAGE = { name: '@ebmr/validation-kit', version: '0.1.0' } as const;

/** Exact versions of the shared packages this module was built against (ADR 0015). */
export const BUILT_AGAINST = [KernelPackage] as const;

/** The evidence bundle v1 (Phase 7 slice 7-0; docs/build-plan/phase-7/slice-7-0-interfaces.md section 1). */
export type * from './bundle/types.ts';
export { BUNDLE_SCHEMA, BUNDLE_SORT_KEYS, BUNDLE_VERSION, BundleError, type BundleErrorCode, bundleSha256, canonicalJson, compareText, parseBundle } from './bundle/validate.ts';
