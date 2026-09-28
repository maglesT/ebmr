/**
 * The floor's view of the session (module C4): who is signed in, and whether this terminal needs a badge tap
 * per entry (SessionView.attribution: NONE on office PCs, TAP or TAP_PIN on kiosks; decision D8).
 *
 * Session changes: C1's access Provider dispatches a window CustomEvent `ebmr:session-change` with
 * {reason: SWITCH | LOCK | UNLOCK | LOCKED_BY_SERVER, personId}; the boot state's person changes too. A pending
 * entry listens to both and is discarded when the person changes, so it is never sent under another person.
 * Nothing here is stored: the session lives in the boot state (memory) only.
 */
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useBoot } from '../../app/boot.tsx';

export type AttributionMode = 'NONE' | 'TAP' | 'TAP_PIN';

export interface FloorSession {
  personId: string | null;
  legalName: string | null;
  loginName: string | null;
  role: string | null;
  attribution: AttributionMode;
  deviceCode: string | null;
  roomCode: string | null;
}

export const SESSION_CHANGE_EVENT = 'ebmr:session-change';

export interface SessionChangeDetail {
  reason: 'SWITCH' | 'LOCK' | 'UNLOCK' | 'LOCKED_BY_SERVER' | 'PERSON_CHANGED';
  personId: string | null;
}

/** Without a session nothing can be sent; a tap is required by default (fails closed). */
export const NO_SESSION: FloorSession = { personId: null, legalName: null, loginName: null, role: null, attribution: 'TAP', deviceCode: null, roomCode: null };

export const FloorSessionContext = createContext<FloorSession>(NO_SESSION);

export function useFloorSession(): FloorSession {
  return useContext(FloorSessionContext);
}

/** Supplies the floor session from the boot state (the feature's Provider renders inside BootProvider). */
export function FloorSessionProvider({ children }: { children: ReactNode }) {
  const boot = useBoot();
  const s = boot.session;
  const value: FloorSession = s
    ? {
        personId: s.person.personId,
        legalName: s.person.legalName,
        loginName: s.person.loginName,
        role: s.role,
        attribution: s.attribution,
        deviceCode: s.device.deviceCode,
        roomCode: s.device.roomCode,
      }
    : NO_SESSION;
  return <FloorSessionContext.Provider value={value}>{children}</FloorSessionContext.Provider>;
}

/**
 * Calls `onChange` when the person on this terminal may have changed: a switch-user event, any session event
 * naming another person, or the session's person changing in the boot state.
 */
export function useSessionChange(onChange: (detail: SessionChangeDetail) => void): void {
  const session = useFloorSession();
  const current = useRef(session.personId);
  const callback = useRef(onChange);
  useEffect(() => {
    callback.current = onChange;
  });
  useEffect(() => {
    if (current.current !== session.personId) {
      current.current = session.personId;
      callback.current({ reason: 'PERSON_CHANGED', personId: session.personId });
    }
  }, [session.personId]);
  useEffect(() => {
    const listener = (e: Event) => {
      const detail = (e as CustomEvent<Partial<SessionChangeDetail> | undefined>).detail;
      const personId = typeof detail?.personId === 'string' ? detail.personId : null;
      if (detail?.reason === 'SWITCH' || personId !== current.current) callback.current({ reason: detail?.reason ?? 'SWITCH', personId });
    };
    window.addEventListener(SESSION_CHANGE_EVENT, listener);
    return () => window.removeEventListener(SESSION_CHANGE_EVENT, listener);
  }, []);
}
