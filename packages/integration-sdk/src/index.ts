/**
 * Adapter contracts for external systems (ERP, LIMS, QMS, LMS, EMS, scales, printers, OPC UA).
 *
 * Phase 0 skeleton: exposes the package identity only. Real modules arrive in the phase
 * that owns them (see docs/outline/build-outline.md section 11).
 */
import { PACKAGE as KernelPackage } from '@ebmr/kernel';

export const PACKAGE = { name: '@ebmr/integration-sdk', version: '0.1.0' } as const;

/** Exact versions of the shared packages this module was built against (ADR 0015). */
export const BUILT_AGAINST = [KernelPackage] as const;
