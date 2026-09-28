/**
 * STUB created by the lead's spine (C0). Ownership passes to C5: scales: the real ScaleCaptureSlot (live gauge, capture tare and gross), supplied through Provider below.
 * The module replaces this file (routes, home tiles and the port Provider); app/ports.tsx holds the port
 * contexts and their stub defaults.
 */
import type { AnyRootRoute, AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';

export function routes(root: AnyRootRoute): AnyRoute[] {
  void root;
  return [];
}

export const homeTiles: readonly HomeTile[] = [];

/** Supplies this module's port implementations; the stub leaves the defaults of app/ports.tsx in place. */
export function Provider({ children }: { children: ReactNode }) {
  return children;
}
