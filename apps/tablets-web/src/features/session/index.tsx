/**
 * Web feature `session` (C0): the home screen and its work lists (declutter D3), the about page (slice 7e, decision 0020) and the demo device picker
 * route. The sign-in screens are shown by the shell before any route (app/App.tsx).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { About } from './About.tsx';
import { DemoPicker } from './DemoPicker.tsx';
import { Home } from './Home.tsx';
import { MyBatchesPage, ToReleasePage, ToReviewPage, ToSignPage } from './work.tsx';

export { DemoPicker, NotEnrolled } from './DemoPicker.tsx';
export { KioskLogin, OfficeLogin, PlatformLogin, RoleChoice } from './Login.tsx';
export { About } from './About.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/', component: Home }),
    createRoute({ getParentRoute: () => root, path: '/about', component: About }),
    createRoute({ getParentRoute: () => root, path: '/demo/devices', component: DemoPicker }),
    // Declutter D3: the lists the home's work cards open.
    createRoute({ getParentRoute: () => root, path: '/work/my-batches', component: MyBatchesPage }),
    createRoute({ getParentRoute: () => root, path: '/work/to-sign', component: ToSignPage }),
    createRoute({ getParentRoute: () => root, path: '/work/to-review', component: ToReviewPage }),
    createRoute({ getParentRoute: () => root, path: '/work/to-release', component: ToReleasePage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
