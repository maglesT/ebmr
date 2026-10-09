/**
 * Web feature `devices` (module C5, sandbox): the real ScaleCaptureSlot for the step screen (live gauge labelled
 * "live, not recorded", stability indicator, tolerance band, capture tare / gross / check) supplied through the
 * port context of app/ports.tsx, and the Scales page (/devices/scales) with a check weight shown with its raw line.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { ScaleSlotProvider } from '../../app/ports.tsx';
import { dt } from './messages.ts';
import { ScaleSlot } from './ScaleSlot.tsx';
import { ScalesPage } from './ScalesPage.tsx';

export { LiveScaleGauge } from './LiveScaleGauge.tsx';
export { ScaleSlot } from './ScaleSlot.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [createRoute({ getParentRoute: () => root, path: '/devices/scales', component: ScalesPage })];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'scales', title: dt('tile.title'), description: dt('tile.description'), to: '/devices/scales', installations: ['SANDBOX'], available: true },
];

/** Supplies the scale capture slot to the step screen (C4) through the port context. */
export function Provider({ children }: { children: ReactNode }) {
  return <ScaleSlotProvider value={ScaleSlot}>{children}</ScaleSlotProvider>;
}
