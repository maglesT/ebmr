/**
 * Tablets edition server.
 *
 * Phase 0 skeleton: exposes the package identity only. Real modules arrive in the phase
 * that owns them (see docs/outline/build-outline.md section 11).
 */
import { PACKAGE as KernelPackage } from '@ebmr/kernel';
import { PACKAGE as SiteServicesPackage } from '@ebmr/site-services';
import { PACKAGE as ExprPackage } from '@ebmr/expr';
import { PACKAGE as RecipeCorePackage } from '@ebmr/recipe-core';
import { PACKAGE as IntegrationSdkPackage } from '@ebmr/integration-sdk';

export const PACKAGE = { name: '@ebmr/tablets-server', version: '0.1.0' } as const;

/** Exact versions of the shared packages this module was built against (ADR 0015). */
export const BUILT_AGAINST = [KernelPackage, SiteServicesPackage, ExprPackage, RecipeCorePackage, IntegrationSdkPackage] as const;
