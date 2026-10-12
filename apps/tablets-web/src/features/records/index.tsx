/**
 * Web feature `records` (Phase 4 slice 5c, GMP): record locking and amendment (outline 5.2.8; INV-21, R-04; plan
 * D-5-7). The lock state of a batch's processing record and of each packaging record made from it, the open amendment
 * of a locked record under a linked deviation or change record (which suspends the release of every released lot made
 * from it and opens the authorised person's market-impact tasks), and the signed close that locks it again.
 * Every state, gate and meaning is the server's; the browser computes none of them.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { RecordLockPage } from './RecordLockPage.tsx';
import { RecordLocksPage } from './RecordLocksPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/records', component: RecordLocksPage }),
    createRoute({ getParentRoute: () => root, path: '/records/$batchId', component: RecordLockPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'records', title: 'Record locks and amendments', description: 'Locked processing and packaging records, open amendments with their linked deviation or change record, and the signed close.', to: '/records', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
