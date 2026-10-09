/**
 * The live display stream of a scale (features/devices/live.ts) against a fake stream: a stream that fails is opened
 * again after a pause that doubles up to a limit (a browser gives up for good on a stream the server refused, as after
 * the kiosk locks), the last weight is never shown once its stream has gone, and a hidden page lets its stream go.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_RETRY_MS, setLiveSourceFactory, useLiveReading, type LiveSource } from '../../src/features/devices/live.ts';

const opened: { url: string; source: LiveSource; close: ReturnType<typeof vi.fn> }[] = [];
setLiveSourceFactory((url) => {
  const close = vi.fn();
  const source: LiveSource = { onmessage: null, onerror: null, close };
  opened.push({ url, source, close });
  return source;
});

const SAMPLE = { deviceCode: 'TEST-BAL-01', value: '1.250', unit: 'kg', stable: true, status: 'OK' };
const last = () => opened[opened.length - 1] as (typeof opened)[number];
const send = (sample: Record<string, unknown> = SAMPLE): void => {
  act(() => {
    last().source.onmessage?.({ data: JSON.stringify(sample) });
  });
};
const fail = (entry = last()): void => {
  act(() => {
    entry.source.onerror?.();
  });
};
const wait = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};
let hidden = false;
const setHidden = (value: boolean): void => {
  act(() => {
    hidden = value;
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  opened.length = 0;
});

describe('live scale stream', () => {
  it('opens the scale\'s stream and shows its samples only; no scale, no stream', () => {
    const none = renderHook(() => useLiveReading(null));
    expect(opened).toHaveLength(0);
    none.unmount();
    const { result } = renderHook(() => useLiveReading('TEST-BAL-01'));
    expect(opened).toHaveLength(1);
    expect(last().url).toContain('/api/devices/scales/TEST-BAL-01/live');
    send({ ...SAMPLE, deviceCode: 'TEST-BAL-02' });
    expect(result.current).toEqual({ sample: null, connected: false });
    send();
    expect(result.current).toEqual({ sample: SAMPLE, connected: true });
  });

  it('a failed stream is closed, its last weight cleared, and opened again after 1 s, 2 s, 4 s … up to 15 s', () => {
    const { result } = renderHook(() => useLiveReading('TEST-BAL-01'));
    send();
    const pauses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const failed = last();
      fail(failed);
      expect(failed.close).toHaveBeenCalled();
      expect(result.current).toEqual({ sample: null, connected: false });
      const before = opened.length;
      let waited = 0;
      while (opened.length === before && waited < 60_000) {
        wait(500);
        waited += 500;
      }
      pauses.push(waited);
    }
    expect(pauses).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
    expect(LIVE_RETRY_MS).toEqual({ first: 1_000, longest: 15_000 });
    // A sample on the new stream shows again, and the next failure starts from the first pause.
    send();
    expect(result.current).toEqual({ sample: SAMPLE, connected: true });
    fail();
    wait(999);
    const count = opened.length;
    wait(1);
    expect(opened).toHaveLength(count + 1);
  });

  it('an error from a stream that was already replaced changes nothing', () => {
    const { result } = renderHook(() => useLiveReading('TEST-BAL-01'));
    const first = last();
    fail(first);
    wait(1_000);
    send();
    fail(first);
    expect(result.current).toEqual({ sample: SAMPLE, connected: true });
    wait(60_000);
    expect(opened).toHaveLength(2);
  });

  it('a hidden page lets its stream go and opens a new one when shown; nothing is opened while hidden', () => {
    const { result } = renderHook(() => useLiveReading('TEST-BAL-01'));
    send();
    fail();
    setHidden(true);
    expect(result.current).toEqual({ sample: null, connected: false });
    // The pending reopen is cancelled while the page is hidden.
    wait(60_000);
    expect(opened).toHaveLength(1);
    setHidden(false);
    expect(opened).toHaveLength(2);
    send();
    setHidden(true);
    expect(last().close).toHaveBeenCalled();
    expect(result.current).toEqual({ sample: null, connected: false });
    setHidden(false);
    expect(opened).toHaveLength(3);
  });

  it('a page that starts hidden opens its stream when it is first shown', () => {
    hidden = true;
    renderHook(() => useLiveReading('TEST-BAL-01'));
    expect(opened).toHaveLength(0);
    setHidden(false);
    expect(opened).toHaveLength(1);
  });

  it('leaving the page closes the stream and opens nothing more', () => {
    const { unmount } = renderHook(() => useLiveReading('TEST-BAL-01'));
    fail();
    unmount();
    wait(60_000);
    expect(opened).toHaveLength(1);
    setHidden(false);
    expect(opened).toHaveLength(1);
    const again = renderHook(() => useLiveReading('TEST-BAL-01'));
    const entry = last();
    again.unmount();
    expect(entry.close).toHaveBeenCalled();
  });
});
