/**
 * Reads are made for the signed-in person: what a screen offers (the server's actions, their reasons, the
 * cockpit) is computed for the viewer. When the person or the declared role on this browser changes (a switch
 * of user on a kiosk, a sign-out, a lock by another person's switch), every cached read is dropped and the
 * screens on show fetch again, so one person never acts on what was computed for another (DI-34, INV-03).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useBoot } from './boot.tsx';

/** Drops every cached read whenever `who` changes (after the first render). */
export function ResetReadsOnPersonChange({ who }: { who: string }) {
  const qc = useQueryClient();
  const last = useRef(who);
  useEffect(() => {
    if (last.current === who) return;
    last.current = who;
    void qc.resetQueries();
  }, [who, qc]);
  return null;
}

/** The person and declared role of the boot state's session ('' when signed out). */
export function SessionScopedReads() {
  const s = useBoot().session;
  return <ResetReadsOnPersonChange who={s ? `${s.person.personId}|${s.role ?? ''}` : ''} />;
}
