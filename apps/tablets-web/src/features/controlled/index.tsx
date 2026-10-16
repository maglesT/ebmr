/**
 * Web feature `controlled` (Phase 6 slice 6e, GMP): controlled-substance mode, draft control IN-53 (status U: NDPS Act and
 * Rules not verified; every screen shows the draft banner). QA records a product's flag under a change record and a
 * second QA person approves it; custodians propose, sign and countersign each dispensing, transfer, return and
 * destruction of a controlled API lot (the dispensing prompt names the lot, batch and net to weigh); the batch's account
 * panel shows the controlled balance at the yield steps with its checkpoints; the register export is run and checked for
 * reproduction. Every value and gate is the server's.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { ControlledBalancePage } from './ControlledBalancePage.tsx';
import { ControlledPage } from './ControlledPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/controlled', component: ControlledPage }),
    createRoute({ getParentRoute: () => root, path: '/controlled/batches/$batchId', component: ControlledBalancePage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  {
    id: 'controlled',
    title: 'Controlled substances (draft)',
    description: 'Product flags, dual custody of the controlled API, the balance at yield checkpoints and the register export. Draft: NDPS rules not verified.',
    to: '/controlled',
    installations: ['GMP'],
    available: true,
  },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
