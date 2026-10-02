/**
 * The live display stream of a scale (SSE via the server's relay): display only, never recorded, never sent back.
 * Samples are parsed with the contract's LiveReadingEvent schema; anything else is ignored.
 */
import { useEffect, useState } from 'react';
import { LiveReadingEvent, routes } from '@ebmr/api-contract';
import { api } from '../../api/client.ts';

export type LiveSample = ReturnType<typeof LiveReadingEvent.parse>;

/** What the hook needs of an EventSource (tests supply a fake). */
export interface LiveSource {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

/** Same-origin EventSource: the session cookie goes with it; the server checks the session and the room. */
function eventSource(url: string): LiveSource {
  const es = new EventSource(url);
  const source: LiveSource = { onmessage: null, onerror: null, close: () => es.close() };
  es.onmessage = (ev: MessageEvent<unknown>) => source.onmessage?.({ data: typeof ev.data === 'string' ? ev.data : '' });
  es.onerror = () => source.onerror?.();
  return source;
}

let factory: (url: string) => LiveSource = eventSource;

/** Replaces the EventSource factory (tests). */
export function setLiveSourceFactory(f: (url: string) => LiveSource): void {
  factory = f;
}

/**
 * When a stream fails it is closed and opened again after a pause, doubling from the first pause up to the longest.
 * A browser gives up for good on a stream the server refuses (the kiosk locked, the session ended), and the gauge
 * would wait for the scale until the page is reloaded.
 */
export const LIVE_RETRY_MS = { first: 1_000, longest: 15_000 } as const;

export function useLiveReading(deviceCode: string | null): { sample: LiveSample | null; connected: boolean } {
  const [sample, setSample] = useState<LiveSample | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!deviceCode) return undefined;
    const url = api.url(routes.devices.live, { params: { code: deviceCode } });
    let source: LiveSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let pause: number = LIVE_RETRY_MS.first;
    // The last weight is never shown once its stream has gone: the gauge waits for the scale again.
    const lost = (): void => {
      source?.close();
      source = null;
      setSample(null);
      setConnected(false);
    };
    const open = (): void => {
      retry = undefined;
      const current = factory(url);
      source = current;
      current.onmessage = (event) => {
        try {
          const parsed = LiveReadingEvent.safeParse(JSON.parse(event.data));
          if (parsed.success && parsed.data.deviceCode === deviceCode) {
            setSample(parsed.data);
            setConnected(true);
            pause = LIVE_RETRY_MS.first;
          }
        } catch {
          // a malformed display sample is dropped
        }
      };
      current.onerror = () => {
        if (source !== current) return;
        lost();
        retry = setTimeout(open, pause);
        pause = Math.min(pause * 2, LIVE_RETRY_MS.longest);
      };
    };
    // A hidden page lets its stream go and opens a new one when it is shown again: a browser keeps at most six
    // connections to one server (HTTP/1.1) for all its tabs, and streams held by hidden tabs leave the shown one none.
    const onVisibility = (): void => {
      clearTimeout(retry);
      retry = undefined;
      lost();
      pause = LIVE_RETRY_MS.first;
      if (!document.hidden) open();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) open();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(retry);
      lost();
    };
  }, [deviceCode]);
  return { sample, connected };
}
