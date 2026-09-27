/**
 * Injectables edition web application.
 *
 * Phase 0 skeleton: exposes the package identity only. Real modules arrive in the phase
 * that owns them (see docs/outline/build-outline.md section 11).
 */
import { PACKAGE as UiKitPackage } from '@ebmr/ui-kit';

export const PACKAGE = { name: '@ebmr/injectables-web', version: '0.1.0' } as const;

/** Exact versions of the shared packages this module was built against (ADR 0015). */
export const BUILT_AGAINST = [UiKitPackage] as const;
