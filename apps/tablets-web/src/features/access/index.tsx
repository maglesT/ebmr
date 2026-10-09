/**
 * Web feature `access` (module C1): kiosk access and the e-signature ceremony, supplied to every screen through
 * the ports of app/ports.tsx:
 *  - BadgeTapPort: requestTap(reason, request) - a badge tap (and PIN on TAP_PIN classes) proven by the terminal
 *    key over the exact request; offerSwitch(refusal) - "Switch to <name>?" after a 409 SWITCH_USER;
 *  - SignatureCeremonyPort: sign(request) - the whole ceremony in a dialog;
 *  - SessionBanner: who is signed in, with Lock, Switch user (kiosks) and Sign out;
 * plus the lock overlay and the session poll. The DEMO-ONLY route /esig/demo signs a kernel stub entry through
 * the real ceremony (demo installations only).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { identity, machines, t } from '@ebmr/ui-kit';
import type { HomeTile } from '../../app/feature.ts';
import { useBoot } from '../../app/boot.tsx';
import { installationLabel } from '../../app/installation.ts';
import {
  BadgeTapPortProvider,
  CeremonyPortProvider,
  SessionBannerProvider,
  type BadgeTapPort,
  type SignatureCeremonyPort,
  type SignOutcome,
  type SignRequest,
} from '../../app/ports.tsx';
import { CeremonyHost, type SignJob } from './ceremony.tsx';
import { AccessRoot, isKiosk, useAccess } from './controller.tsx';
import { demoSearch, EsigDemo } from './EsigDemo.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({
      getParentRoute: () => root,
      path: '/esig/demo',
      validateSearch: (s: Record<string, unknown>) => demoSearch(s),
      component: EsigDemo,
    }),
  ];
}

export const homeTiles: readonly HomeTile[] = [];

/** The full identity banner (supplied to the shell through SessionBannerProvider). A stable module-level component. */
export function SessionBanner() {
  const boot = useBoot();
  const access = useAccess();
  const s = boot.session;
  if (!s) return null;
  return (
    <identity.IdentityBanner
      productName={t('app.name')}
      installation={boot.meta?.installation ?? s.installation}
      installationLabel={installationLabel(boot.meta?.installation ?? s.installation)}
      legalName={s.person.legalName}
      loginName={s.person.loginName}
      role={s.role ?? ''}
      deviceCode={s.device.deviceCode}
      roomCode={s.device.roomCode}
      kiosk={isKiosk(s)}
      attribution={s.attribution}
      onLock={access.lock}
      onSwitch={access.lockAndSwitch}
      onSignOut={() => void access.signOut()}
    />
  );
}

const busyRefusal = (): SignOutcome => ({
  status: 'REFUSED',
  refusal: {
    refusal: { code: 'SIGNING_OPEN', kind: 'STALE', whatHappened: 'Another signing is already open on this screen.', why: '', controls: ['DI-38'], whatYouCanDo: ['Finish or cancel it first.'], whoCanHelp: [] },
    correlationId: 'client',
    retryable: true,
  },
});

const noSessionRefusal = (): SignOutcome => ({
  status: 'REFUSED',
  refusal: {
    refusal: { code: 'NO_SESSION', kind: 'NOT_ALLOWED', whatHappened: 'You are not signed in on this installation.', why: '', controls: ['DI-38'], whatYouCanDo: ['Sign in again.'], whoCanHelp: [] },
    correlationId: 'client',
    retryable: false,
  },
});

/**
 * The SignatureCeremonyPort: one ceremony at a time, run by CeremonyHost. A ceremony belongs to the person who started
 * it: the request and any decision in it (a hold-point decision and comment, a disposition's justification) are theirs.
 * When another person is signed in, whatever the path (the ceremony's own "Switch to <name>?", "Switch user" on the
 * lock screen, a switch the session poll finds) or the session ends, the open ceremony ends with nothing signed
 * (CANCELLED) and its host, with any badge, PIN or secret it holds, is gone; the caller asks the new person for their
 * own (INV-40, DI-38, DI-14; Phase 2 exit review F39).
 */
function useCeremonyService() {
  const boot = useBoot();
  const [job, setJob] = useState<SignJob | null>(null);
  const resolver = useRef<((o: SignOutcome) => void) | null>(null);
  const counter = useRef(0);
  const sessionRef = useRef(boot.session);
  const jobRef = useRef<SignJob | null>(null);
  // A layout effect, so sign() knows the session the moment the page shows it: a passive effect ran later, and a
  // signing asked for in between (a screen's own effect, an observer of the page) was refused as "no session".
  useLayoutEffect(() => {
    sessionRef.current = boot.session;
    jobRef.current = job;
  });

  const port = useMemo<SignatureCeremonyPort>(
    () => ({
      sign(request: SignRequest) {
        const s = sessionRef.current;
        if (!s) return Promise.resolve(noSessionRefusal());
        if (resolver.current) return Promise.resolve(busyRefusal());
        counter.current += 1;
        const next: SignJob = { id: counter.current, request, kiosk: isKiosk(s), tapPin: s.attribution === 'TAP_PIN', personId: s.person.personId };
        return new Promise<SignOutcome>((resolve) => {
          resolver.current = resolve;
          setJob(next);
        });
      },
    }),
    [],
  );
  const finish = useCallback((o: SignOutcome) => {
    const r = resolver.current;
    resolver.current = null;
    jobRef.current = null;
    setJob(null);
    r?.(o);
  }, []);
  // Another person signed in (the session the page shows; also a switch only the session poll finds), or none: the
  // open ceremony ends, nothing signed (F39). As the floor's useSessionChange reacts to a change of person.
  const finishRef = useRef(finish);
  useEffect(() => {
    finishRef.current = finish;
  });
  const personId = boot.session?.person.personId ?? null;
  useEffect(() => {
    const j = jobRef.current;
    if (j && j.personId !== personId) finishRef.current({ status: 'CANCELLED' });
  }, [personId]);
  // The same as soon as a switch or the end is announced, before the page shows the new session.
  useEffect(
    () =>
      machines.onSessionChange((d) => {
        const j = jobRef.current;
        if (j && (d.reason === 'ENDED' || (d.personId !== null && d.personId !== j.personId))) finishRef.current({ status: 'CANCELLED' });
      }),
    [],
  );
  return { port, job, finish };
}

/** Supplies the ports of this module to every screen below it. */
function Ports({ ceremony, children }: { ceremony: SignatureCeremonyPort; children: ReactNode }) {
  const access = useAccess();
  const tap = useMemo<BadgeTapPort>(() => ({ requestTap: access.requestTap, offerSwitch: access.offerSwitch }), [access.requestTap, access.offerSwitch]);
  return (
    <BadgeTapPortProvider value={tap}>
      <CeremonyPortProvider value={ceremony}>
        <SessionBannerProvider value={SessionBanner}>{children}</SessionBannerProvider>
      </CeremonyPortProvider>
    </BadgeTapPortProvider>
  );
}

export function Provider({ children }: { children: ReactNode }) {
  const ceremony = useCeremonyService();
  return (
    <AccessRoot render={(ctl) => (ceremony.job ? <CeremonyHost key={ceremony.job.id} job={ceremony.job} ctl={ctl} onFinish={ceremony.finish} /> : null)}>
      <Ports ceremony={ceremony.port}>{children}</Ports>
    </AccessRoot>
  );
}
