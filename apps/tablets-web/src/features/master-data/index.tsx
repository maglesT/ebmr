/**
 * Web feature `master-data` (Phase 3 slice 6, GMP): the formulation library (formulas, versions, approval with the
 * ceremony, the composition only with FORMULA.READ), the ERP products and materials (read only) and the plant
 * definitions. "Choose a product" lives in the designer's create flow (features/designer).
 */
import { createRoute, Link, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { ErpMastersPage } from './ErpPage.tsx';
import { FormulaPage } from './FormulaPage.tsx';
import { FormulasPage } from './FormulasPage.tsx';
import { PlantMasterPage } from './PlantMasterPage.tsx';

function MasterDataHome() {
  return (
    <>
      <h1>Master data</h1>
      <ul>
        <li>
          <Link to="/master-data/formulas">Formulas</Link>
        </li>
        <li>
          <Link to="/master-data/erp">Products and materials</Link>
        </li>
        <li>
          <Link to="/master-data/plant">Plant</Link>
        </li>
      </ul>
    </>
  );
}

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/master-data', component: MasterDataHome }),
    createRoute({ getParentRoute: () => root, path: '/master-data/formulas', component: FormulasPage }),
    createRoute({ getParentRoute: () => root, path: '/master-data/formulas/$formulaId', component: FormulaPage }),
    createRoute({ getParentRoute: () => root, path: '/master-data/erp', component: ErpMastersPage }),
    createRoute({ getParentRoute: () => root, path: '/master-data/plant', component: PlantMasterPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'master-data', title: 'Master data', description: 'Formulas, products and materials, plant definitions.', to: '/master-data', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
