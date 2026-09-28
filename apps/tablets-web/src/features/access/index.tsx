/**
 * STUB created by the lead's spine (C0). Ownership passes to C1: kiosk access (lock, unlock, keep-alive, switch user) and the real CeremonyProvider and BadgeTapProvider, supplied through Provider below.
 * The module replaces this file (routes, home tiles and the port Provider); app/ports.tsx holds the port
 * contexts and their stub defaults.
 */
import type { AnyRootRoute, AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';

export function routes(_root: AnyRootRoute): AnyRoute[] {
  return [];
}

export const homeTiles: readonly HomeTile[] = [];

/** Supplies this module's port implementations; the stub leaves the defaults of app/ports.tsx in place. */
export function Provider({ children }: { children: ReactNode }) {
  return children;
}
