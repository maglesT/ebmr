/**
 * Namespace `access` (C1): kiosk lock and unlock, keep-alive and user switch (Phase 2 apps plan section 5,
 * "Lock, unlock, keep-alive and switch"). Paths stay under /api/session.
 */
import { z } from 'zod';
import { DeviceProof, Empty } from '../common.ts';
import { defineRoute } from '../route.ts';
import { SessionView } from './session.ts';

export const access = {
  lock: defineRoute({
    id: 'access.lock',
    method: 'POST',
    path: '/api/session/lock',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    idempotency: 'NONE',
    summary: 'Lock the session now (the kernel also locks it after the idle timeout)',
    body: Empty,
    response: SessionView,
  }),
  unlock: defineRoute({
    id: 'access.unlock',
    method: 'POST',
    path: '/api/session/unlock',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    idempotency: 'NONE',
    summary: 'Unlock with a fresh SESSION_UNLOCK authentication of the same person on the same device',
    body: z.strictObject({
      method: z.enum(['PASSWORD', 'BADGE_PIN']),
      identifier: z.string().min(1).max(128),
      secret: z.string().min(1).max(256),
      proof: DeviceProof,
    }),
    response: SessionView,
  }),
  keepAlive: defineRoute({
    id: 'access.keepAlive',
    method: 'POST',
    path: '/api/session/keep-alive',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    idempotency: 'NONE',
    summary: 'Extend the session before the idle lock (kiosks: a badge tap)',
    body: z.strictObject({ badgeUid: z.string().min(1).max(64).optional(), proof: DeviceProof.optional() }),
    response: SessionView,
  }),
  switchUser: defineRoute({
    id: 'access.switchUser',
    method: 'POST',
    path: '/api/session/switch',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    idempotency: 'NONE',
    summary: 'Switch user on a kiosk by badge and PIN: the old session locks, a new one opens with a new cookie',
    body: z.strictObject({
      badgeUid: z.string().min(1).max(64),
      pin: z.string().min(4).max(12),
      roleCode: z.string().optional(),
      proof: DeviceProof,
    }),
    response: SessionView,
  }),
} as const;
