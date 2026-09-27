/**
 * Simulators for equipment and external systems used in demos and tests.
 *
 * Phase 0 skeleton: exposes the package identity only. Real modules arrive in the phase
 * that owns them (see docs/outline/build-outline.md section 11).
 */
import { PACKAGE as IntegrationSdkPackage } from '@ebmr/integration-sdk';

export const PACKAGE = { name: '@ebmr/simulators', version: '0.1.0' } as const;

/** Exact versions of the shared packages this module was built against (ADR 0015). */
export const BUILT_AGAINST = [IntegrationSdkPackage] as const;
