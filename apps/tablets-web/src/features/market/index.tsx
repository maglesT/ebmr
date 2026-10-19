/**
 * Web feature `market` (Phase 7 slice 7g, work package WP3; GMP; decision 0025): the market, plant and compendial
 * configuration screens: market policies and a batch's pins (/market/policies), site values (/market/site-values), the
 * EU qualified-person register (/qp-register), the compendial rule sets (/compendial-rule-sets) and the plant
 * configuration (/plant/configuration). Every rule, state and refusal is the server's; signatures go through C1's
 * ceremony (MARKET_LOOSENING, QP_REGISTER, RULE_SET_VERIFY).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { HomeTile } from '../../app/feature.ts';
import { PlantConfigPage } from './PlantConfigPage.tsx';
import { PoliciesPage } from './PoliciesPage.tsx';
import { QpRegisterPage } from './QpRegisterPage.tsx';
import { RuleSetsPage } from './RuleSetsPage.tsx';
import { SiteValuesPage } from './SiteValuesPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/market/policies', component: PoliciesPage }),
    createRoute({ getParentRoute: () => root, path: '/market/site-values', component: SiteValuesPage }),
    createRoute({ getParentRoute: () => root, path: '/qp-register', component: QpRegisterPage }),
    createRoute({ getParentRoute: () => root, path: '/compendial-rule-sets', component: RuleSetsPage }),
    createRoute({ getParentRoute: () => root, path: '/plant/configuration', component: PlantConfigPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'market-policies', title: 'Market policies', description: 'Policy switches, their versions and approvals, and what each batch pinned.', to: '/market/policies', installations: ['GMP'], available: true },
  { id: 'site-values', title: 'Site values', description: 'A site\'s own values for rule keys, and the approval of a loosening.', to: '/market/site-values', installations: ['GMP'], available: true },
  { id: 'qp-register', title: 'QP register', description: 'The EU qualified persons registered on each importer\'s authorisation.', to: '/qp-register', installations: ['GMP'], available: true },
  { id: 'compendial-rule-sets', title: 'Compendial rule sets', description: 'QA\'s verification of each rule set against the official text.', to: '/compendial-rule-sets', installations: ['GMP'], available: true },
  { id: 'plant-configuration', title: 'Plant configuration', description: 'Alarm codes, equipment campaigns, utility feed ages and line isolations.', to: '/plant/configuration', installations: ['GMP'], available: true },
];
