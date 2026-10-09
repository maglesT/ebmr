/**
 * Web feature `session` (C0): the home screen and the demo device picker route. The sign-in screens are shown
 * by the shell before any route (app/App.tsx).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { DemoPicker } from './DemoPicker.tsx';
import { Home } from './Home.tsx';

export { DemoPicker, NotEnrolled } from './DemoPicker.tsx';
export { KioskLogin, OfficeLogin, RoleChoice } from './Login.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/', component: Home }),
    createRoute({ getParentRoute: () => root, path: '/demo/devices', component: DemoPicker }),
  ];
}

export const homeTiles: readonly HomeTile[] = [];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
