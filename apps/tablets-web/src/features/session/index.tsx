/**
 * Web feature `session` (C0): the home screen, the about page (slice 7e, decision 0020) and the demo device picker
 * route. The sign-in screens are shown by the shell before any route (app/App.tsx).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { About } from './About.tsx';
import { DemoPicker } from './DemoPicker.tsx';
import { Home } from './Home.tsx';

export { DemoPicker, NotEnrolled } from './DemoPicker.tsx';
export { KioskLogin, OfficeLogin, PlatformLogin, RoleChoice } from './Login.tsx';
export { About } from './About.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/', component: Home }),
    createRoute({ getParentRoute: () => root, path: '/about', component: About }),
    createRoute({ getParentRoute: () => root, path: '/demo/devices', component: DemoPicker }),
  ];
}

export const homeTiles: readonly HomeTile[] = [];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
