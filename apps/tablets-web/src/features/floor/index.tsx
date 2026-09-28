/**
 * STUB created by the lead's spine (C0). Ownership passes to C4: sandbox test runs and the shop-floor step screen.
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
  { id: 'packages', title: 'Test-run packages', description: 'Import MBR test packages sent from GMP and issue TEST- batches.', to: '/packages', installations: ['SANDBOX'], available: false },
  { id: 'runs', title: 'Test runs', description: 'Runs, their record and the replay check.', to: '/runs', installations: ['SANDBOX'], available: false },
  { id: 'cockpit', title: 'What you can do now', description: 'The work queue of the room of this terminal.', to: '/cockpit', installations: ['SANDBOX'], available: false },
];

/** Supplies this module's port implementations; the stub leaves the defaults of app/ports.tsx in place. */
export function Provider({ children }: { children: ReactNode }) {
  return children;
}
