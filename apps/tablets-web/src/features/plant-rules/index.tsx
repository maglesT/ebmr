/**
 * Web feature `plant-rules` (Phase 7 slice 7g-2, decision 0025; GMP): the penicillin facility rules and beta-lactam
 * classifications, their proposals and QA's approval (/plant-rules; PR-27, recipe-core 1210).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { PlantRulesPage } from './PlantRulesPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [createRoute({ getParentRoute: () => root, path: '/plant-rules', component: PlantRulesPage })];
}

export const homeTiles: readonly HomeTile[] = [
  {
    id: 'plant-rules',
    title: 'Penicillin and beta-lactam rules',
    description: 'Which sites are penicillin facilities and which materials and products are beta-lactam: proposals and QA approval.',
    to: '/plant-rules',
    installations: ['GMP'],
    available: true,
  },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
