/**
 * Site gateway: scale and printer drivers, OPC UA client, buffering, device identity.
 *
 * Phase 0 skeleton: exposes the package identity only. Real modules arrive in the phase
 * that owns them (see docs/outline/build-outline.md section 11).
 */
import { PACKAGE as KernelPackage } from '@ebmr/kernel';
import { PACKAGE as IntegrationSdkPackage } from '@ebmr/integration-sdk';

export const PACKAGE = { name: '@ebmr/site-gateway', version: '0.1.0' } as const;

/** Exact versions of the shared packages this module was built against (ADR 0015). */
export const BUILT_AGAINST = [KernelPackage, IntegrationSdkPackage] as const;
