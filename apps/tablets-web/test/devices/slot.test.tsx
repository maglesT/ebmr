/**
 * The scale capture slot and live gauge (module C5), against contract fixtures and a fake live stream.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { setTransport } from '../../src/api/client.ts';
import { createFixtureFetch } from '../../src/api/fixture-fetch.ts';
import { ScaleCaptureSlot } from '../../src/app/ports.tsx';
import { compareDecimal, gaugeGeometry } from '../../src/features/devices/decimal.ts';
import { Provider } from '../../src/features/devices/index.tsx';
import { setLiveSourceFactory, type LiveSource } from '../../src/features/devices/live.ts';

const scale = (status: 'ONLINE' | 'OFFLINE' | 'UNKNOWN') => ({
  deviceCode: 'TEST-BAL-01',
  roomCode: 'DISP-1',
  status,
  lastHeartbeat: null,
  gatewayCode: 'TEST-GW-01',
  resolution: '0.001',
  unit: 'kg',
});

const sources: { url: string; source: LiveSource }[] = [];
setLiveSourceFactory((url) => {
  const source: LiveSource = { onmessage: null, onerror: null, close: vi.fn() };
  sources.push({ url, source });
  return source;
});

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <Provider>{children}</Provider>
    </QueryClientProvider>
  );
}

function push(sample: Record<string, unknown>) {
  act(() => {
    for (const s of sources) s.source.onmessage?.({ data: JSON.stringify(sample) });
  });
}

afterEach(() => {
  sources.length = 0;
});

describe('gauge geometry (decimal text, never numbers)', () => {
  it('compares decimal text exactly', () => {
    expect(compareDecimal('12.50', '12.5')).toBe(0);
    expect(compareDecimal('0.1', '0.09')).toBe(1);
    expect(compareDecimal('-1.000', '0')).toBe(-1);
  });

  it('places the band, target and value; clamps the marker; says below, inside or above', () => {
    const g = gaugeGeometry('12.500', { low: '12.000', high: '13.000', target: '12.500', unit: 'kg' });
    expect(g).toMatchObject({ lowPct: 16.6, highPct: 83.3, targetPct: 50, valuePct: 50, position: 'IN' });
    expect(gaugeGeometry('11.000', { low: '12.000', high: '13.000', unit: 'kg' })).toMatchObject({ valuePct: 0, position: 'BELOW' });
    expect(gaugeGeometry('13.001', { low: '12.000', high: '13.000', unit: 'kg' })?.position).toBe('ABOVE');
    expect(gaugeGeometry('5.000', { target: '10.000', unit: 'kg' })).toMatchObject({ valuePct: 25, position: null });
    expect(gaugeGeometry('5.000', undefined)).toBeNull();
  });
});

describe('ScaleCaptureSlot (C5 provider)', () => {
  it('[DI-32] shows the live weight labelled "live, not recorded"; a capture hands over the server\'s reading', async () => {
    const reading = example('reading');
    const captured: unknown[] = [];
    setTransport(
      createFixtureFetch(
        {
          'devices.scales': { scales: [scale('ONLINE')] },
          'devices.capture': ({ params, body }: { params: Record<string, string>; body: unknown }) => {
            captured.push({ params, body });
            return reading;
          },
        },
        { installation: 'SANDBOX' },
      ),
    );
    const onCaptured = vi.fn();
    render(wrap(<ScaleCaptureSlot deviceCodes={['TEST-BAL-01']} purpose="TARE" onCaptured={onCaptured} band={{ low: '1.000', high: '1.500', unit: 'kg' }} />));
    expect(await screen.findByText('live, not recorded')).toBeTruthy();
    expect(sources[0]?.url).toBe('/api/devices/scales/TEST-BAL-01/live');
    push({ deviceCode: 'TEST-BAL-01', value: '1.249', unit: 'kg', stable: false, status: 'UNSTABLE' });
    expect(screen.getByTestId('live-value').textContent).toBe('1.249 kg');
    expect(screen.getByText('Settling')).toBeTruthy();
    push({ deviceCode: 'TEST-BAL-01', value: '1.250', unit: 'kg', stable: true, status: 'OK' });
    expect(screen.getByText('Stable')).toBeTruthy();
    expect(screen.getByText(/Inside the range \(display only/)).toBeTruthy();
    // A sample of another scale is ignored.
    push({ deviceCode: 'TEST-BAL-02', value: '9.999', unit: 'kg', stable: true, status: 'OK' });
    expect(screen.getByTestId('live-value').textContent).toBe('1.250 kg');
    fireEvent.click(screen.getByRole('button', { name: 'Capture tare' }));
    await waitFor(() => expect(onCaptured).toHaveBeenCalledWith(reading));
    // The browser sent the purpose only: never a weight, a device reading or a time.
    expect(captured).toEqual([{ params: { code: 'TEST-BAL-01' }, body: { purpose: 'TARE' } }]);
  });

  it('with the scale offline it says so and points to the manual two-person path (no gauge, no capture)', async () => {
    setTransport(createFixtureFetch({ 'devices.scales': { scales: [scale('OFFLINE')] } }, { installation: 'SANDBOX' }));
    render(wrap(<ScaleCaptureSlot deviceCodes={['TEST-BAL-01']} purpose="GROSS" onCaptured={vi.fn()} />));
    expect(await screen.findByText('Scale offline: manual entry needs a second person')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Capture gross' })).toBeNull();
    expect(sources).toHaveLength(0);
  });

  it('shows the server\'s refusal in plain language and does not hand over anything', async () => {
    setTransport(
      createFixtureFetch(
        {
          'devices.scales': { scales: [scale('ONLINE')] },
          'devices.capture': {
            status: 422,
            body: {
              refusal: { code: 'CAPTURE_FAILED', kind: 'NOT_SAVED', whatHappened: 'No usable weight was taken from the scale.', why: 'TEST-BAL-01 did not settle within 10 s', controls: ['DI-32'], whatYouCanDo: ['Check the load on the scale and try again.'], whoCanHelp: [] },
              correlationId: 'x',
              retryable: true,
            },
          },
        },
        { installation: 'SANDBOX' },
      ),
    );
    const onCaptured = vi.fn();
    render(wrap(<ScaleCaptureSlot deviceCodes={['TEST-BAL-01']} purpose="GROSS" onCaptured={onCaptured} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Capture gross' }));
    expect(await screen.findByText('No usable weight was taken from the scale.')).toBeTruthy();
    expect(screen.getByText('TEST-BAL-01 did not settle within 10 s')).toBeTruthy();
    expect(onCaptured).not.toHaveBeenCalled();
  });

  it('a step without a scale of this room gets the manual path', async () => {
    setTransport(createFixtureFetch({ 'devices.scales': { scales: [scale('ONLINE')] } }, { installation: 'SANDBOX' }));
    render(wrap(<ScaleCaptureSlot deviceCodes={['TEST-BAL-02']} purpose="GROSS" onCaptured={vi.fn()} />));
    expect(await screen.findByText('No scale of this room is available for this step')).toBeTruthy();
  });
});
