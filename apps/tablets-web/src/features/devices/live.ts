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

let factory: (url: string) => LiveSource = (url) => new EventSource(url, { withCredentials: false });

/** Replaces the EventSource factory (tests). */
export function setLiveSourceFactory(f: (url: string) => LiveSource): void {
  factory = f;
}

export function useLiveReading(deviceCode: string | null): { sample: LiveSample | null; connected: boolean } {
  const [sample, setSample] = useState<LiveSample | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!deviceCode) return undefined;
    const source = factory(api.url(routes.devices.live, { params: { code: deviceCode } }));
    source.onmessage = (event) => {
      try {
        const parsed = LiveReadingEvent.safeParse(JSON.parse(event.data));
        if (parsed.success && parsed.data.deviceCode === deviceCode) {
          setSample(parsed.data);
          setConnected(true);
        }
      } catch {
        // a malformed display sample is dropped
      }
    };
    source.onerror = () => setConnected(false);
    return () => {
      source.close();
      setSample(null);
      setConnected(false);
    };
  }, [deviceCode]);
  return { sample, connected };
}
