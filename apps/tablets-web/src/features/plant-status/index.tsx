/**
 * Web feature `plant-status` (Phase 6 slice 6b, builder B; GMP): the plant alarm list with the acknowledgment (DI-49),
 * the batch alarm log (shown on the batch review and the floor step screens), the equipment status board (PR-22), the
 * line station display (PR-35), the rooms with their conditions and spills (PR-15, PR-25, PR-27) and the trend viewer
 * over native series (DI-32), and the area authorisations of the qualification matrix (PR-15). Every value and
 * gate is the database's (contract ns/alarms.ts, ns/plant-rules.ts, the displays of ns/equipment-data.ts).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { AlarmsPage } from './AlarmsPage.tsx';
import { AreaAuthorisationsPage } from './AreaAuthorisationsPage.tsx';
import { LineStationPage } from './LineStationPage.tsx';
import { RoomsPage } from './RoomsPage.tsx';
import { StatusBoardPage } from './StatusBoardPage.tsx';
import { parseTrendSearch, TrendsPage } from './TrendsPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/alarms', component: AlarmsPage }),
    createRoute({ getParentRoute: () => root, path: '/status-board', component: StatusBoardPage }),
    createRoute({ getParentRoute: () => root, path: '/line-station/$code', component: LineStationPage }),
    createRoute({ getParentRoute: () => root, path: '/rooms', component: RoomsPage }),
    createRoute({ getParentRoute: () => root, path: '/area-authorisations', component: AreaAuthorisationsPage }),
    createRoute({ getParentRoute: () => root, path: '/trends', validateSearch: parseTrendSearch, component: TrendsPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'alarms', title: 'Plant alarms', description: 'Alarms from Batchwright itself, the equipment and the EMS, with their source times; acknowledge with the action taken.', to: '/alarms', installations: ['GMP'], available: true },
  { id: 'status-board', title: 'Equipment status board', description: 'Every unit, room and line: state, batch, cleaning state and open alarms.', to: '/status-board', installations: ['GMP'], available: true },
  { id: 'area-authorisations', title: 'Area authorisations', description: 'Who may work in each controlled area: record, withdraw and see the current authorisations.', to: '/area-authorisations', installations: ['GMP'], available: true },
  { id: 'trends', title: 'Trends', description: 'Native equipment and room data of a batch, a unit or a room, zoomed over the samples as received.', to: '/trends', installations: ['GMP'], available: true },
  { id: 'rooms', title: 'Rooms and lines', description: 'Cleaning state, clean hold, controlled areas, spills, and each room\'s temperature and humidity.', to: '/rooms', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
