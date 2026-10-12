/**
 * Web feature `notifications` (Phase 4 slice 3c, GMP): the notification centre (outline 7.3; IN-39 clause 2). The
 * notifications of the departments the session's role belongs to, newest first, each acknowledged by a person of that
 * department.
 */
import { useState } from 'react';
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { routes as api } from '@ebmr/api-contract';
import { floor } from '@ebmr/ui-kit';
import type { HomeTile } from '../../app/feature.ts';
import { useApiQuery } from '../../api/hooks.ts';
import { NotificationList } from './NotificationList.tsx';

const DEPARTMENT: Readonly<Record<string, string>> = { PRODUCTION: 'Production', QA: 'Quality assurance' };

function NotificationCentrePage() {
  const [show, setShow] = useState<'OPEN' | 'ALL'>('OPEN');
  const q = useApiQuery(api.notifications.list, { query: {} });
  const departments = q.data?.departments ?? [];
  return (
    <>
      <h1>Notification centre</h1>
      <p data-testid="notification-departments">
        {departments.length === 0 ? 'Your role belongs to no department that receives notifications.' : `Your departments: ${departments.map((d) => DEPARTMENT[d] ?? d).join(', ')}.`}
      </p>
      <floor.ChoiceGroup
        label="Show"
        options={[
          { value: 'OPEN', label: 'Waiting for my acknowledgement' },
          { value: 'ALL', label: 'All' },
        ]}
        value={show}
        onChange={(v) => setShow(v === 'ALL' ? 'ALL' : 'OPEN')}
      />
      <NotificationList openOnly={show === 'OPEN'} empty={show === 'OPEN' ? 'Nothing is waiting for your acknowledgement.' : 'No notification.'} />
    </>
  );
}

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [createRoute({ getParentRoute: () => root, path: '/notifications', component: NotificationCentrePage })];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'notifications', title: 'Notification centre', description: 'Release and rejection notices for production and QA, acknowledged one by one.', to: '/notifications', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
