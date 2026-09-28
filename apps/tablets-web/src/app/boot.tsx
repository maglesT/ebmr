/**
 * Start-up of the SPA (plan section 5): /api/meta (installation, watermark, server time), the terminal key from
 * IndexedDB, device identification by proof, then the session. Credentials and the CSRF token never enter
 * TanStack Query caches: they live in this component's state and in the API client's memory only.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { routes, type CallError, type DeviceView, type MetaView, type SessionView } from '@ebmr/api-contract';
import { api, apiState, deviceProof } from '../api/client.ts';
import { forgetDeviceKey, loadDeviceKey, type StoredDeviceKey } from '../device/keystore.ts';
import { anchorServerTime } from './clock.ts';

export type BootPhase = 'loading' | 'failed' | 'mismatch' | 'no-device' | 'device-refused' | 'signed-out' | 'ready';

export interface BootState {
  phase: BootPhase;
  meta: MetaView | null;
  deviceKey: StoredDeviceKey | null;
  device: DeviceView | null;
  session: SessionView | null;
  problem: string | null;
}

export interface Boot extends BootState {
  /** Re-runs the whole start-up (after choosing a terminal). */
  restart(): void;
  setSession(session: SessionView | null): void;
  signOut(): Promise<void>;
  forgetTerminal(): Promise<void>;
}

const BootContext = createContext<Boot | null>(null);

export function useBoot(): Boot {
  const b = useContext(BootContext);
  if (!b) throw new Error('useBoot outside BootProvider');
  return b;
}

const describe = (e: CallError): string => (e.kind === 'REFUSAL' ? `${e.envelope.refusal.whatHappened} ${e.envelope.refusal.why}`.trim() : e.kind === 'NETWORK' ? 'The server cannot be reached.' : e.kind === 'PROTOCOL' ? e.message : 'Installation mismatch.');

async function runBoot(): Promise<BootState> {
  const empty: BootState = { phase: 'loading', meta: null, deviceKey: null, device: null, session: null, problem: null };
  apiState.installation = undefined;
  const meta = await api.call(routes.meta.get);
  if (!meta.ok) return { ...empty, phase: 'failed', problem: describe(meta.error) };
  apiState.installation = meta.value.installation;
  anchorServerTime(meta.value.serverTime.us);
  document.documentElement.dataset['installation'] = meta.value.installation.toLowerCase();
  const withMeta = { ...empty, meta: meta.value };
  if (window.location.pathname === '/demo/devices') return { ...withMeta, phase: 'no-device' };
  const deviceKey = await loadDeviceKey();
  if (!deviceKey) return { ...withMeta, phase: 'no-device' };
  const proof = await deviceProof(deviceKey, 'POST', '/api/session/identify', {});
  const device = await api.call(routes.session.identify, { body: { proof } });
  if (!device.ok) return { ...withMeta, deviceKey, phase: 'device-refused', problem: describe(device.error) };
  document.documentElement.dataset['density'] = device.value.density.toLowerCase();
  const session = await api.call(routes.session.get);
  if (!session.ok) {
    apiState.csrfToken = undefined;
    return { ...withMeta, deviceKey, device: device.value, phase: 'signed-out' };
  }
  apiState.csrfToken = session.value.csrfToken;
  return { ...withMeta, deviceKey, device: device.value, session: session.value, phase: 'ready' };
}

export function BootProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BootState>({ phase: 'loading', meta: null, deviceKey: null, device: null, session: null, problem: null });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let live = true;
    const onMismatch = () => setState((s) => ({ ...s, phase: 'mismatch' }));
    apiState.onMismatch.add(onMismatch);
    runBoot()
      .then((s) => {
        if (live) setState(apiState.mismatch ? { ...s, phase: 'mismatch' } : s);
      })
      .catch((e: unknown) => {
        if (live) setState((s) => ({ ...s, phase: 'failed', problem: e instanceof Error ? e.message : String(e) }));
      });
    return () => {
      live = false;
      apiState.onMismatch.delete(onMismatch);
    };
  }, [generation]);

  const restart = useCallback(() => setGeneration((g) => g + 1), []);
  const setSession = useCallback((session: SessionView | null) => {
    apiState.csrfToken = session?.csrfToken;
    setState((s) => ({ ...s, session, phase: session ? 'ready' : s.device ? 'signed-out' : s.phase }));
  }, []);
  const signOut = useCallback(async () => {
    await api.call(routes.session.logout, { body: {} });
    apiState.csrfToken = undefined;
    setState((s) => ({ ...s, session: null, phase: 'signed-out' }));
  }, []);
  const forgetTerminal = useCallback(async () => {
    await forgetDeviceKey();
    setGeneration((g) => g + 1);
  }, []);

  const value = useMemo<Boot>(() => ({ ...state, restart, setSession, signOut, forgetTerminal }), [state, restart, setSession, signOut, forgetTerminal]);
  return <BootContext.Provider value={value}>{children}</BootContext.Provider>;
}
