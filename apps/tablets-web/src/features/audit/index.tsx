/**
 * Web feature `audit` (module C1; plan section 11): the audit trail viewer at /audit on both installations, and
 * the deep-link helpers auditLink / auditHref for the other modules' screens.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { AuditPage } from './AuditPage.tsx';
import { parseAuditSearch } from './links.ts';

export { auditHref, auditLink, type AuditSearch } from './links.ts';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [createRoute({ getParentRoute: () => root, path: '/audit', validateSearch: parseAuditSearch, component: AuditPage })];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'audit-trail', title: 'Audit trail', description: 'The hash-chained audit trail of this installation, with chain verification.', to: '/audit', installations: ['GMP', 'SANDBOX'], available: true },
];

/** This module supplies no port. */
export function Provider({ children }: { children: ReactNode }) {
  return children;
}
