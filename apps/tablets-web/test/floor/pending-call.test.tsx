/**
 * useRunCommand (module C4) driven directly: one entry, one tap, one request, even when the save is pressed twice
 * in the same moment; office terminals send without a tap.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_HEADER, type FetchLike } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { setTransport } from '../../src/api/client.ts';
import { BadgeTapPortProvider } from '../../src/app/ports.tsx';
import { FloorSessionContext, type FloorSession } from '../../src/features/floor/session.tsx';
import { useRunCommand } from '../../src/features/floor/usePendingCall.ts';
import { fakeTap, OPERATOR, RUN_ID } from './support.tsx';

function setup(session: FloorSession) {
  const sent: { key: string | null; body: unknown }[] = [];
  const transport: FetchLike = (url, init) => {
    sent.push({ key: init.headers[IDEMPOTENCY_HEADER] ?? null, body: init.body ? JSON.parse(init.body) : null });
    return Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify({ accepted: true, version: 8, step: example('step-g04-parameters') })) });
  };
  setTransport(transport);
  const tap = fakeTap();
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <FloorSessionContext.Provider value={session}>
        <BadgeTapPortProvider value={tap}>{children}</BadgeTapPortProvider>
      </FloorSessionContext.Provider>
    </QueryClientProvider>
  );
  return { sent, tap, wrapper };
}

describe('useRunCommand', () => {
  it('[INV-40] two presses in the same moment make one entry: one tap, one request', async () => {
    const { sent, tap, wrapper } = setup(OPERATOR);
    const { result } = renderHook(() => useRunCommand(RUN_ID, 'p-blend@', 'Save blend time'), { wrapper });
    act(() => {
      result.current.send({ type: 'START_STEP', stepKey: 'p-blend@' }, 7);
      result.current.send({ type: 'START_STEP', stepKey: 'p-blend@' }, 7);
    });
    await waitFor(() => expect(result.current.state).toBe('saved'));
    expect(tap.requestTap).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it('on an office terminal (attribution NONE) the entry is sent at once, with an idempotency key and no attribution', async () => {
    const { sent, tap, wrapper } = setup({ ...OPERATOR, attribution: 'NONE', deviceCode: 'TEST-PC-01' });
    const { result } = renderHook(() => useRunCommand(RUN_ID, 'p-blend@', 'Save blend time'), { wrapper });
    act(() => result.current.send({ type: 'START_STEP', stepKey: 'p-blend@' }, 7));
    await waitFor(() => expect(result.current.state).toBe('saved'));
    expect(tap.requestTap).not.toHaveBeenCalled();
    expect(sent[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[0]?.body).toEqual({ expectedVersion: 7, intent: { type: 'START_STEP', stepKey: 'p-blend@' }, viewStepKey: 'p-blend@' });
  });

  it('without a signed-in person nothing is sent', () => {
    const { sent, tap, wrapper } = setup({ ...OPERATOR, personId: null });
    const { result } = renderHook(() => useRunCommand(RUN_ID, 'p-blend@', 'Save'), { wrapper });
    act(() => result.current.send({ type: 'START_STEP', stepKey: 'p-blend@' }, 7));
    expect(result.current.state).toBe('editing');
    expect(tap.requestTap).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});
