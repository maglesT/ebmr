/**
 * The live display streams of a page (features/devices/live.ts), with the app's own EventSource wrapper against a
 * stand-in global EventSource that counts the connections still open (Phase 2 exit review F61, F62).
 *
 * F61: a browser keeps six connections per server for all its tabs over HTTP/1.1, and every capture slot of a weighing
 * form (tare and gross) held its own stream to the same scale; two shown weighing windows held four. One stream per
 * scale and page now serves every gauge of that scale; it opens with the first and closes after the last.
 * F62: while the kiosk is locked every reopen is refused (423) and the pause grows to 15 s; the gauge waited for the
 * next scheduled retry after the unlock. The page now stops retrying at the lock and opens the stream at once at the
 * unlock or a switch of person.
 */
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { machines } from '@ebmr/ui-kit';
import { ScaleSlot } from '../../src/features/devices/ScaleSlot.tsx';
import { LIVE_RETRY_MS, useLiveReading } from '../../src/features/devices/live.ts';
import { renderFloor, stepFixtures, stepPath, stepVariant } from '../floor/support.tsx';

const created: FakeEventSource[] = [];
class FakeEventSource {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor(readonly url: string) {
    created.push(this);
  }
  close(): void {
    this.readyState = 2;
  }
}
const openStreams = (): string[] => created.filter((s) => s.readyState !== 2).map((s) => s.url);
const last = (): FakeEventSource => created[created.length - 1] as FakeEventSource;
const SAMPLE = { deviceCode: 'TEST-BAL-01', value: '1.250', unit: 'kg', stable: true, status: 'OK' };
const deliver = (es: FakeEventSource, sample: Record<string, unknown> = SAMPLE): void => {
  act(() => {
    es.readyState = 1;
    es.onmessage?.({ data: JSON.stringify(sample) } as MessageEvent);
  });
};
/** What a browser's EventSource does when the server refuses the stream (423 while locked): error, closed for good. */
const refuse = (es: FakeEventSource): void => {
  act(() => {
    es.readyState = 2;
    es.onerror?.();
  });
};
const announce = (reason: 'LOCK' | 'UNLOCK' | 'SWITCH' | 'ENDED'): void => {
  act(() => machines.announceSessionChange({ reason, personId: reason === 'ENDED' ? null : 'p-op1' }));
};
let hidden = false;
const setHidden = (value: boolean): void => {
  act(() => {
    hidden = value;
    document.dispatchEvent(new Event('visibilitychange'));
  });
};
const wait = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

const saved = (globalThis as { EventSource?: unknown }).EventSource;
beforeAll(() => {
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
});
afterAll(() => {
  (globalThis as { EventSource?: unknown }).EventSource = saved;
});
beforeEach(() => {
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  created.length = 0;
});

const g07 = stepVariant('step-g07-weighing', (v) => {
  if (v.run.scale) v.run.scale = { ...v.run.scale, deviceCode: 'TEST-BAL-01', status: 'ONLINE' };
  v.run.scales = v.run.scale ? [v.run.scale] : [];
});
const scaleRow = (deviceCode: string) => ({ deviceCode, roomCode: 'DISP-1', status: 'ONLINE', lastHeartbeat: null, gatewayCode: 'TEST-GW-01', resolution: '0.001', unit: 'kg' });

describe('one live stream per scale and page (F61)', () => {
  it('a shown weighing form with one online scale holds one stream to it for its two capture slots', async () => {
    const ui = renderFloor(stepPath('p-disp-api@'), { scaleSlot: ScaleSlot, fixtures: { ...stepFixtures(g07), 'devices.scales': { scales: [scaleRow('TEST-BAL-01')] } } });
    await screen.findByTestId('form-CONTAINER_WEIGHING');
    await waitFor(() => expect(screen.getAllByTestId('gauge-TEST-BAL-01')).toHaveLength(2));
    expect(openStreams()).toEqual(['/api/devices/scales/TEST-BAL-01/live']);
    // Both gauges show the one stream's weight.
    deliver(last());
    expect(screen.getAllByTestId('live-value').map((e) => e.textContent?.includes('1.250'))).toEqual([true, true]);
    ui.unmount();
    expect(openStreams()).toEqual([]);
  });

  it('two users of one scale share one stream, which closes after the last leaves; another scale gets its own', () => {
    const a = renderHook(() => useLiveReading('TEST-BAL-01'));
    const b = renderHook(() => useLiveReading('TEST-BAL-01'));
    const other = renderHook(() => useLiveReading('TEST-BAL-02'));
    expect(openStreams()).toEqual(['/api/devices/scales/TEST-BAL-01/live', '/api/devices/scales/TEST-BAL-02/live']);
    deliver(created[0] as FakeEventSource);
    expect([a.result.current, b.result.current, other.result.current]).toEqual([
      { sample: SAMPLE, connected: true },
      { sample: SAMPLE, connected: true },
      { sample: null, connected: false },
    ]);
    a.unmount();
    expect(openStreams()).toHaveLength(2);
    // A user that joins an open stream sees its last weight at once.
    const c = renderHook(() => useLiveReading('TEST-BAL-01'));
    expect(c.result.current).toEqual({ sample: SAMPLE, connected: true });
    b.unmount();
    c.unmount();
    expect(openStreams()).toEqual(['/api/devices/scales/TEST-BAL-02/live']);
    other.unmount();
    expect(openStreams()).toEqual([]);
  });

  it('a failed shared stream is reopened once for all its users, and a hidden page lets it go', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = renderHook(() => useLiveReading('TEST-BAL-01'));
    const b = renderHook(() => useLiveReading('TEST-BAL-01'));
    deliver(last());
    refuse(last());
    expect([a.result.current, b.result.current]).toEqual([
      { sample: null, connected: false },
      { sample: null, connected: false },
    ]);
    wait(LIVE_RETRY_MS.first);
    expect(created).toHaveLength(2);
    setHidden(true);
    expect(openStreams()).toEqual([]);
    setHidden(false);
    expect(openStreams()).toHaveLength(1);
    expect(created).toHaveLength(3);
  });
});

describe('the live stream at a lock and an unlock (F62)', () => {
  it('stops at the lock, asks nothing while locked, and opens at once at the unlock', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { result } = renderHook(() => useLiveReading('TEST-BAL-01'));
    deliver(last());
    announce('LOCK');
    expect({ open: openStreams(), state: result.current }).toEqual({ open: [], state: { sample: null, connected: false } });
    // While locked: neither the time passing nor the page shown again opens a stream the server would refuse.
    wait(60_000);
    setHidden(true);
    setHidden(false);
    expect(created).toHaveLength(1);
    announce('UNLOCK');
    expect(created).toHaveLength(2);
    expect(openStreams()).toEqual(['/api/devices/scales/TEST-BAL-01/live']);
    deliver(last());
    expect(result.current).toEqual({ sample: SAMPLE, connected: true });
  });

  it('a stream refused until its pause reached 15 s opens at once at the unlock, not at the next retry', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderHook(() => useLiveReading('TEST-BAL-01'));
    // The server locked the session (idle lock) before the page heard of it: each reopen is refused.
    for (const pause of [1_000, 2_000, 4_000, 8_000]) {
      refuse(last());
      wait(pause);
    }
    refuse(last());
    const before = created.length;
    wait(1_000);
    expect(created).toHaveLength(before);
    announce('UNLOCK');
    expect(created).toHaveLength(before + 1);
  });

  it('a switch of person opens the stream at once; the end of the session stops it', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderHook(() => useLiveReading('TEST-BAL-01'));
    announce('LOCK');
    announce('SWITCH');
    expect(openStreams()).toHaveLength(1);
    announce('ENDED');
    expect(openStreams()).toEqual([]);
    wait(60_000);
    expect(openStreams()).toEqual([]);
  });
});
