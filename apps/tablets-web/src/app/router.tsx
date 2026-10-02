/**
 * The router (plan section 7): a code-based TanStack route tree composed from every feature's index.tsx, so
 * parallel modules never share a generated file.
 */
import { createRootRoute, createRouter } from '@tanstack/react-router';
import { WEB_FEATURES } from './features.ts';
import { NotFoundPage } from './not-found.tsx';
import { ShellOutlet } from './shell.tsx';

export function createAppRouter() {
  const root = createRootRoute({ component: ShellOutlet, notFoundComponent: NotFoundPage });
  const children = WEB_FEATURES.flatMap(([, f]) => f.routes?.(root) ?? []);
  return createRouter({ routeTree: root.addChildren(children), defaultPreload: false });
}
