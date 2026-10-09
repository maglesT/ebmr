/**
 * The live display stream of a scale (SSE via the server's relay): display only, never recorded, never sent back.
 * Samples are parsed with the contract's LiveReadingEvent schema; anything else is ignored. A page holds one stream per
 * scale, shared by all its gauges of that scale (review F61), and follows the kiosk's lock and unlock (review F62).
 */
import { useEffect, useState } from 'react';
import { LiveReadingEvent, routes } from '@ebmr/api-contract';
import { machines } from '@ebmr/ui-kit';
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

export interface LiveState {
  sample: LiveSample | null;
  connected: boolean;
}

const WAITING: LiveState = { sample: null, connected: false };

/** One scale's stream, shared by every gauge of the page that shows that scale. */
interface Channel {
  listeners: Set<(state: LiveState) => void>;
  state(): LiveState;
  stop(): void;
}

/**
 * The open streams of the page, one per scale (review F61). A browser keeps at most six connections to one server
 * (HTTP/1.1) for all its tabs; a weighing form shows a gauge in its tare slot and in its gross slot, and a stream per
 * gauge let two shown weighing windows hold four of them, so the reads and saves of every screen waited behind them.
 */
const channels = new Map<string, Channel>();

function openChannel(deviceCode: string): Channel {
  const url = api.url(routes.devices.live, { params: { code: deviceCode } });
  const listeners = new Set<(state: LiveState) => void>();
  let state: LiveState = WAITING;
  const publish = (next: LiveState): void => {
    state = next;
    for (const listener of listeners) listener(next);
  };
  let source: LiveSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let pause: number = LIVE_RETRY_MS.first;
  /** The kiosk is locked or the session ended: the server refuses the stream (423), so nothing is asked for until the unlock. */
  let locked = false;
  // The last weight is never shown once its stream has gone: the gauge waits for the scale again.
  const lost = (): void => {
    source?.close();
    source = null;
    if (state !== WAITING) publish(WAITING);
  };
  const open = (): void => {
    retry = undefined;
    const current = factory(url);
    source = current;
    current.onmessage = (event) => {
      try {
        const parsed = LiveReadingEvent.safeParse(JSON.parse(event.data));
        if (parsed.success && parsed.data.deviceCode === deviceCode) {
          publish({ sample: parsed.data, connected: true });
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
  /** Lets the stream go and, unless the page is hidden or the kiosk locked, opens a new one now, from the first pause. */
  const restart = (): void => {
    clearTimeout(retry);
    retry = undefined;
    lost();
    pause = LIVE_RETRY_MS.first;
    if (!document.hidden && !locked) open();
  };
  // A hidden page lets its stream go and opens a new one when it is shown again: streams held by hidden tabs would
  // leave the shown one no connection.
  document.addEventListener('visibilitychange', restart);
  // The access controller announces the lock, the unlock, a switch of person and the end of the session (review F62):
  // at the lock the stream goes and nothing is retried (each try would be refused); at the unlock or a switch it opens
  // at once, not at the next retry, which a refused stream had pushed up to 15 s away.
  const offSession = machines.onSessionChange((change) => {
    locked = change.reason === 'LOCK' || change.reason === 'ENDED';
    restart();
  });
  if (!document.hidden) open();
  return {
    listeners,
    state: () => state,
    stop: () => {
      document.removeEventListener('visibilitychange', restart);
      offSession();
      clearTimeout(retry);
      retry = undefined;
      source?.close();
      source = null;
    },
  };
}

/** Follows a scale's shared stream; the stream opens with its first follower and closes after its last (review F61). */
function follow(deviceCode: string, listener: (state: LiveState) => void): () => void {
  let channel = channels.get(deviceCode);
  if (!channel) {
    channel = openChannel(deviceCode);
    channels.set(deviceCode, channel);
  }
  const joined = channel;
  joined.listeners.add(listener);
  listener(joined.state());
  return () => {
    joined.listeners.delete(listener);
    if (joined.listeners.size === 0 && channels.get(deviceCode) === joined) {
      channels.delete(deviceCode);
      joined.stop();
    }
  };
}

export function useLiveReading(deviceCode: string | null): LiveState {
  const [state, setState] = useState<LiveState>(WAITING);
  useEffect(() => {
    if (!deviceCode) return undefined;
    const leave = follow(deviceCode, setState);
    return () => {
      leave();
      setState(WAITING);
    };
  }, [deviceCode]);
  return state;
}
