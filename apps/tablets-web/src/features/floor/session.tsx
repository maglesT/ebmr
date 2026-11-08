/**
 * The floor's view of the session (module C4): who is signed in, and whether this terminal needs a badge tap
 * per entry (SessionView.attribution: NONE on office PCs, TAP or TAP_PIN on kiosks; decision D8).
 *
 * Session changes: C1's access Provider dispatches a window CustomEvent `ebmr:session-change` with
 * {reason: SWITCH | LOCK | UNLOCK | ENDED, personId}; the boot state's person changes too. Pending entries are
 * discarded on SWITCH, LOCK and ENDED, and whenever the person differs, so an entry is never sent under
 * another person (INV-40). A step form's unsent draft (typed, never sent) is the exception at LOCK: it stays behind
 * the lock screen and is there again when the same person unlocks; an unlock or switch by anyone else drops it, so the
 * next person never sees or sends it (owner, runtime gaps G10: a lock lost the blend end typed before it).
 * Nothing here is stored: the session lives in the boot state (memory) only.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
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
  reason: 'SWITCH' | 'LOCK' | 'UNLOCK' | 'ENDED' | 'PERSON_CHANGED';
  personId: string | null;
}

/** Reasons that discard pending entries even when the person is the same. */
const DISCARDING: ReadonlySet<string> = new Set(['SWITCH', 'LOCK', 'ENDED']);

/** Without a session nothing can be sent; a tap is required by default (fails closed). */
export const NO_SESSION: FloorSession = { personId: null, legalName: null, loginName: null, role: null, attribution: 'TAP', deviceCode: null, roomCode: null };

export const FloorSessionContext = createContext<FloorSession>(NO_SESSION);

export function useFloorSession(): FloorSession {
  return useContext(FloorSessionContext);
}

/** The person signed in and the role they work as: what the server computes a view for. */
export type Viewer = Pick<FloorSession, 'personId' | 'role'>;

/** Who is signed in at the moment of the call; null when that is not known here (see useSignedInNow). */
export type SignedInNow = () => Viewer | null;

/**
 * Who is signed in now, for work that ends after an await (a command's or a signature's answer arrives later): the
 * getter reads the latest session at the moment it is called, never the one of the render that started the work.
 * Once the component is gone it answers null: who is signed in is then not known here, so nothing computed for a
 * person is put in place on the strength of it (INV-40, DI-34).
 */
export function useSignedInNow(): SignedInNow {
  const session = useFloorSession();
  const now = useRef<Viewer | null>(session);
  useLayoutEffect(() => {
    now.current = session;
    return () => {
      now.current = null;
    };
  });
  return useCallback(() => now.current, []);
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
 * Calls `onChange` when pending entries must go: a switch, lock or end of the session, any session event
 * naming another person, or the session's person changing in the boot state. With `keepOnLock` (a step form's unsent
 * draft) a lock alone does not call it: the draft waits for the unlock, and an unlock naming another person, a switch
 * or the end of the session still drops it.
 */
export function useSessionChange(onChange: (detail: SessionChangeDetail) => void, options: { keepOnLock?: boolean } = {}): void {
  const keepOnLock = options.keepOnLock === true;
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
      const reason = detail?.reason ?? 'SWITCH';
      if (keepOnLock && reason === 'LOCK' && personId === current.current) return;
      if (DISCARDING.has(reason) || personId !== current.current) callback.current({ reason, personId });
    };
    window.addEventListener(SESSION_CHANGE_EVENT, listener);
    return () => window.removeEventListener(SESSION_CHANGE_EVENT, listener);
  }, [keepOnLock]);
}
