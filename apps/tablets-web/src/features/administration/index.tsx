/**
 * Web feature `administration` (Phase 7 slice 7g-1, decision 0025): people and access (people and accounts, role grants,
 * recertification, break-glass) and the device registry (terminals and hardening, gateway keys, device bindings,
 * adapters and the gateway feed binding), on both installations. Every act is the database's to allow or refuse.
 * Slice 7g-5: role-permission requests and their decision, delegations of signing authority, and the US e-signature
 * certification letter (GovernancePages.tsx).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { BreakGlassPage, RecertificationPage } from './AccessReviewPages.tsx';
import { DevicesPage } from './DevicesPage.tsx';
import { DelegationsPage, RolePermissionsPage, UsEsigCertificationPage } from './GovernancePages.tsx';
import { GrantsPage } from './GrantsPage.tsx';
import { PeoplePage } from './PeoplePage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/admin/people', component: PeoplePage }),
    createRoute({ getParentRoute: () => root, path: '/admin/grants', component: GrantsPage }),
    createRoute({ getParentRoute: () => root, path: '/admin/recertification', component: RecertificationPage }),
    createRoute({ getParentRoute: () => root, path: '/admin/break-glass', component: BreakGlassPage }),
    createRoute({ getParentRoute: () => root, path: '/admin/devices', component: DevicesPage }),
    createRoute({ getParentRoute: () => root, path: '/admin/role-permissions', component: RolePermissionsPage }),
    createRoute({ getParentRoute: () => root, path: '/admin/delegations', component: DelegationsPage }),
    createRoute({ getParentRoute: () => root, path: '/admin/us-esig-certification', component: UsEsigCertificationPage }),
  ];
}

const BOTH = ['GMP', 'SANDBOX'] as const;

export const homeTiles: readonly HomeTile[] = [
  { id: 'admin-people', title: 'People and accounts', description: 'Record people and identity checks, open accounts, issue first passwords, PINs and badges.', to: '/admin/people', installations: BOTH, available: true },
  { id: 'admin-grants', title: 'Role grants', description: 'Request a role for an account; a second person approves it.', to: '/admin/grants', installations: BOTH, available: true },
  { id: 'admin-recertification', title: 'Access recertification', description: 'Confirm that each account still needs its grants, or revoke them.', to: '/admin/recertification', installations: BOTH, available: true },
  { id: 'admin-break-glass', title: 'Break-glass access', description: 'Sealed emergency access: requested by its holder, approved and reviewed by a second person.', to: '/admin/break-glass', installations: BOTH, available: true },
  { id: 'admin-devices', title: 'Terminals and devices', description: 'Register terminals and devices, attest kiosk hardening, enrol gateway keys, bind balances and the gateway feed.', to: '/admin/devices', installations: BOTH, available: true },
  { id: 'admin-role-permissions', title: 'Role permissions', description: 'Request a permission for a role; a second person approves it under a change record.', to: '/admin/role-permissions', installations: BOTH, available: true },
  { id: 'admin-delegations', title: 'Delegations of signing authority', description: 'Delegate a delegable signature to a named person for a period; a third person approves it.', to: '/admin/delegations', installations: BOTH, available: true },
  { id: 'admin-us-esig-certification', title: 'US e-signature certification', description: 'Record the legal entity\'s certification letter on electronic signatures to the US agency.', to: '/admin/us-esig-certification', installations: BOTH, available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
