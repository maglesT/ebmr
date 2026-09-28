/**
 * STUB created by the lead's spine (C0). Ownership passes to C1: the audit trail viewer (routes and auditLink).
 * The module replaces this file (routes, home tiles and, where it applies, the port Provider).
 */
import type { AnyRootRoute, AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';

export function routes(root: AnyRootRoute): AnyRoute[] {
  void root;
  return [];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'audit-trail', title: 'Audit trail', description: 'The hash-chained audit trail of this installation, with chain verification.', to: '/audit', installations: ['GMP', 'SANDBOX'], available: false },
];

/** Supplies this module's port implementations; the stub leaves the defaults of app/ports.tsx in place. */
export function Provider({ children }: { children: ReactNode }) {
  return children;
}
