/**
 * Web feature `master-records` (Phase 7 slice 7g-2, decision 0025; GMP): the acts on master records that had no screen.
 * Routes: the life-cycle signatures and market authorisations of a version (/mbr/versions/$versionId/signing) and the
 * labelling specimens (/mbr/specimens). Slice 7g WP3: the change records with their validation and regulatory
 * assessments (/mbr/change-records), a version's periodic review and risk-assessment links (/mbr/versions/$versionId/review)
 * and its labelling declaration (/mbr/versions/$versionId/labelling). Decision 0026 slice S3: the block library
 * (/mbr/library), signed through LIBRARY_ACT. Every rule, state and refusal is the server's;
 * signatures go through C1's ceremony (MBR_TRANSITION, MBR_MARKET_ACT, SPECIMEN_ACT).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { ChangeRecordsPage } from './ChangeRecordsPage.tsx';
import { LabellingPage } from './LabellingPage.tsx';
import { LibraryPage } from './LibraryPage.tsx';
import { MbrSigningPage } from './MbrSigningPage.tsx';
import { SpecimensPage } from './SpecimensPage.tsx';
import { VersionReviewPage } from './VersionReviewPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/mbr/versions/$versionId/signing', component: MbrSigningPage }),
    createRoute({ getParentRoute: () => root, path: '/mbr/specimens', component: SpecimensPage }),
    createRoute({ getParentRoute: () => root, path: '/mbr/change-records', component: ChangeRecordsPage }),
    createRoute({ getParentRoute: () => root, path: '/mbr/versions/$versionId/review', component: VersionReviewPage }),
    createRoute({ getParentRoute: () => root, path: '/mbr/versions/$versionId/labelling', component: LabellingPage }),
    // Decision 0026 slice S3: the library of block definitions.
    createRoute({ getParentRoute: () => root, path: '/mbr/library', component: LibraryPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'block-library', title: 'Block library', description: 'The library of block definitions (forms built from typed fields), their versions and QA approval.', to: '/mbr/library', installations: ['GMP'], available: true },
  { id: 'labelling-specimens', title: 'Labelling specimens', description: 'The label and printed packaging specimens and their QA approval.', to: '/mbr/specimens', installations: ['GMP'], available: true },
  { id: 'mbr-change-records', title: 'MBR change records', description: 'The validation and per-market regulatory assessments of master-record changes.', to: '/mbr/change-records', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
