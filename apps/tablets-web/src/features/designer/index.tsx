/**
 * Web feature `designer` (module C2): the document-first MBR designer on the GMP installation. Routes: the master
 * records library (/mbr), new from template (/mbr/new) and the designer of one version (/mbr/versions/$versionId).
 * No port Provider: the designer uses C1's signature ceremony only in A2 (MBR_TRANSITION).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { DesignerPage } from './DesignerPage.tsx';
import { Library } from './Library.tsx';
import { NewFromTemplate } from './NewFromTemplate.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/mbr', component: Library }),
    createRoute({ getParentRoute: () => root, path: '/mbr/new', component: NewFromTemplate }),
    createRoute({ getParentRoute: () => root, path: '/mbr/versions/$versionId', component: DesignerPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'master-records', title: 'Master records', description: 'MBR families, versions and the document-first designer.', to: '/mbr', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
