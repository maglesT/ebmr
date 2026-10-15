/**
 * Web feature `plant-status` (Phase 6 slice 6b, builder B; GMP): the plant alarm list with the acknowledgment (DI-49),
 * the batch alarm log (shown on the batch review and the floor step screens), the equipment status board (PR-22), the
 * line station display (PR-35) and the rooms with their conditions and spills (PR-15, PR-25, PR-27). Every value and
 * gate is the database's (contract ns/alarms.ts, ns/plant-rules.ts, the displays of ns/equipment-data.ts).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { AlarmsPage } from './AlarmsPage.tsx';
import { LineStationPage } from './LineStationPage.tsx';
import { RoomsPage } from './RoomsPage.tsx';
import { StatusBoardPage } from './StatusBoardPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/alarms', component: AlarmsPage }),
    createRoute({ getParentRoute: () => root, path: '/status-board', component: StatusBoardPage }),
    createRoute({ getParentRoute: () => root, path: '/line-station/$code', component: LineStationPage }),
    createRoute({ getParentRoute: () => root, path: '/rooms', component: RoomsPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'alarms', title: 'Plant alarms', description: 'Alarms from the eBMR, the equipment and the EMS, with their source times; acknowledge with the action taken.', to: '/alarms', installations: ['GMP'], available: true },
  { id: 'status-board', title: 'Equipment status board', description: 'Every unit, room and line: state, batch, cleaning state and open alarms.', to: '/status-board', installations: ['GMP'], available: true },
  { id: 'rooms', title: 'Rooms and lines', description: 'Cleaning state, clean hold, controlled areas, spills, and each room\'s temperature and humidity.', to: '/rooms', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
