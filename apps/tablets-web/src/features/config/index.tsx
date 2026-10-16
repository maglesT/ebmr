/**
 * Web feature `config` (Phase 6 slice 6f, builder A, GMP): configuration change control (DI-09) and the review-by-
 * exception rules (DI-26, PR-52). Change records (raise, QA approval through the signature ceremony CONFIG_CHANGE_ACT,
 * close), the configuration history as of a date with the diff between two dates, platform settings (adapter modes,
 * mirror freshness bounds) and the RBE rule editor, each change under a change record. Every gate is the database's:
 * a change without an approved change record covering its area is refused there (EBMR-CFG-001 to -004).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { ChangeRecordsPage } from './ChangeRecordsPage.tsx';
import { ConfigHistoryPage } from './ConfigHistoryPage.tsx';
import { RbeRulesPage } from './RbeRulesPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/config/change-records', component: ChangeRecordsPage }),
    createRoute({ getParentRoute: () => root, path: '/config/history', component: ConfigHistoryPage }),
    createRoute({ getParentRoute: () => root, path: '/config/rbe-rules', component: RbeRulesPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'config-change-records', title: 'Configuration change records', description: 'Raise a change record, have QA approve it with a signature, close it. Every configuration change names one.', to: '/config/change-records', installations: ['GMP'], available: true },
  { id: 'config-history', title: 'Configuration history', description: 'The configuration as of any date and what changed between two dates, with the change records; platform settings.', to: '/config/history', installations: ['GMP'], available: true },
  { id: 'config-rbe-rules', title: 'Review-by-exception rules', description: 'The rule of each review category: a mandatory category stays listed; a rule raises its severity, under a change record.', to: '/config/rbe-rules', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
