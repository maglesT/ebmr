/**
 * STUB created by the lead's spine (C0). Ownership passes to C2: the document-first MBR designer (GMP).
 * The module replaces this file (routes, home tiles and, where it applies, the port Provider).
 */
import type { AnyRootRoute, AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';

export function routes(_root: AnyRootRoute): AnyRoute[] {
  return [];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'master-records', title: 'Master records', description: 'MBR families, versions and the designer.', to: '/mbr', installations: ['GMP'], available: false },
];

/** Supplies this module's port implementations; the stub leaves the defaults of app/ports.tsx in place. */
export function Provider({ children }: { children: ReactNode }) {
  return children;
}
