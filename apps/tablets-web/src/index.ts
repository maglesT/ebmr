/** Tablets edition web application (the SPA's entry is main.tsx; this module exposes its identity). */
import { PACKAGE as UiKitPackage } from '@ebmr/ui-kit';

export const PACKAGE = { name: '@ebmr/tablets-web', version: '0.1.0' } as const;

/** Exact versions of the shared packages this module was built against (ADR 0015). */
export const BUILT_AGAINST = [UiKitPackage] as const;
