/**
 * The ActorContext of a request (kernel withCommand): built from the resolved session only. Source UI; site
 * zone from the configuration; device and room from the kernel registry, never from the client. On shared
 * terminals the attribution hook adds the fresh badge-tap authentication event (INV-40).
 */
import type { ActorContext } from '@ebmr/kernel';
import { refusal } from '../http/refusal.ts';
import type { ResolvedSession } from './session.ts';

export interface ActorExtras {
  correlationId: string;
  authEventId?: string;
  reasonCode?: string;
  reasonText?: string;
}

export function actorFrom(session: ResolvedSession, siteZone: string, extras: ActorExtras): ActorContext & { deviceId: string } {
  if (!session.roleCode) {
    throw refusal(409, {
      code: 'ROLE_CHOICE_REQUIRED',
      kind: 'NOT_ALLOWED',
      whatHappened: 'Choose the role you are working in before you continue.',
      whatYouCanDo: ['Pick one of your roles.'],
      details: { roles: session.roles.join(',') },
    });
  }
  return {
    personId: session.personId,
    accountId: session.accountId,
    roleCode: session.roleCode,
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    source: 'UI',
    siteZone,
    legalName: session.legalName,
    correlationId: extras.correlationId,
    ...(extras.authEventId ? { authEventId: extras.authEventId } : {}),
    ...(extras.reasonCode ? { reasonCode: extras.reasonCode } : {}),
    ...(extras.reasonText ? { reasonText: extras.reasonText } : {}),
  };
}
