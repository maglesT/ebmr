/**
 * Web feature `quality` (Phase 3 slice 6, GMP): deviation-lite (list, raise, link, investigate, finding, conclude,
 * close, cancel), material lots (receive, LIMS-lite results, approve, OOS link, retest, release and reject), the QC
 * extra-testing decision of a batch, the ERP import status, and reprocessing (authorisations, residue reservation).
 * Phase 4 slice 2c: the full deviation record, specifications and editions, lot status events and samples, returned goods.
 */
import { createRoute, Link, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { BatchQualityPage } from './BatchQualityPage.tsx';
import { DeviationPage } from './DeviationPage.tsx';
import { DeviationsPage } from './DeviationsPage.tsx';
import { ApprovedManufacturersPage } from './ApprovedManufacturersPage.tsx';
import { DeliveryReceiptPage } from './DeliveryReceiptPage.tsx';
import { ErpStatusPage } from './ErpStatusPage.tsx';
import { LotReceiptPage } from './LotReceiptPage.tsx';
import { LotPage } from './LotPage.tsx';
import { UpdatePotencyPage } from './UpdatePotencyPage.tsx';
import { LotsPage } from './LotsPage.tsx';
import { ReprocessingPage } from './ReprocessingPage.tsx';
import { ReturnsPage } from './ReturnsPage.tsx';
import { SpecificationsPage } from './SpecificationsPage.tsx';
import { VendorRoutesPage } from './VendorRoutesPage.tsx';

function QualityHome() {
  return (
    <>
      <h1>Quality</h1>
      <ul>
        <li>
          <Link to="/quality/deviations">Deviations</Link>
        </li>
        <li>
          <Link to="/quality/lots">Material lots</Link>
        </li>
        <li>
          <Link to="/quality/receipt">Receive a delivery</Link>
        </li>
        <li>
          <Link to="/quality/approved-manufacturers">Approved manufacturers</Link>
        </li>
        <li>
          <Link to="/quality/specifications">Specifications</Link>
        </li>
        <li>
          <Link to="/quality/returns">Returned goods</Link>
        </li>
        <li>
          <Link to="/quality/extra-testing">Extra testing of a batch</Link>
        </li>
        <li>
          <Link to="/quality/reprocessing">Reprocessing</Link>
        </li>
        <li>
          <Link to="/quality/erp">ERP import status</Link>
        </li>
        <li>
          <Link to="/quality/vendor-routes">Vendor-history routes</Link>
        </li>
      </ul>
    </>
  );
}

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/quality', component: QualityHome }),
    createRoute({ getParentRoute: () => root, path: '/quality/deviations', component: DeviationsPage }),
    createRoute({ getParentRoute: () => root, path: '/quality/deviations/$deviationId', component: DeviationPage }),
    createRoute({ getParentRoute: () => root, path: '/quality/lots', component: LotsPage }),
    createRoute({ getParentRoute: () => root, path: '/quality/lots/$lotId', component: LotPage }),
    createRoute({ getParentRoute: () => root, path: '/quality/lots/$lotId/potency', component: UpdatePotencyPage }),
    createRoute({ getParentRoute: () => root, path: '/quality/specifications', component: SpecificationsPage }),
    createRoute({ getParentRoute: () => root, path: '/quality/returns', component: ReturnsPage }),
    createRoute({ getParentRoute: () => root, path: '/quality/extra-testing', component: BatchQualityPage }),
    createRoute({ getParentRoute: () => root, path: '/quality/reprocessing', component: ReprocessingPage }),
    createRoute({ getParentRoute: () => root, path: '/quality/vendor-routes', component: VendorRoutesPage }),
    createRoute({ getParentRoute: () => root, path: '/quality/erp', component: ErpStatusPage }),
    // Phase 6 slice 6a builder A: receipt with supplier batches, the receipt record and the approved-manufacturer register (PR-17).
    createRoute({ getParentRoute: () => root, path: '/quality/receipt', component: DeliveryReceiptPage }),
    createRoute({ getParentRoute: () => root, path: '/quality/lots/$lotId/receipt', component: LotReceiptPage }),
    createRoute({ getParentRoute: () => root, path: '/quality/approved-manufacturers', component: ApprovedManufacturersPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'quality', title: 'Quality', description: 'Deviations, lots and results, extra testing, reprocessing, ERP status.', to: '/quality', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
