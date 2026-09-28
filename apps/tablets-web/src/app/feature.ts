/**
 * What a web feature's index.ts exports (module C0): routes under the root route, home tiles, and optionally a
 * Provider that supplies port implementations (C1: ceremony and badge tap; C5: scale slot). The feature list is
 * fixed in app/features.ts; each module replaces only its own index.ts.
 */
import type { AnyRootRoute, AnyRoute } from '@tanstack/react-router';
import type { ComponentType, ReactNode } from 'react';

export interface HomeTile {
  id: string;
  title: string;
  description: string;
  /** Route path the tile opens. */
  to: string;
  installations: readonly ('GMP' | 'SANDBOX')[];
  /** False until the owning module lands (the tile shows "Not available yet"). */
  available: boolean;
}

export interface WebFeature {
  routes?: (root: AnyRootRoute) => AnyRoute[];
  homeTiles?: readonly HomeTile[];
  Provider?: ComponentType<{ children: ReactNode }>;
}
