/**
 * The golden batches' device-nonce pacing (harness.ts, ServerOptions.paceDeviceNonces): a fast runner asked KIOSK-PACK-1
 * for more than DEVICE_NONCE_RATE_LIMIT.max nonces within one wall-clock minute in GB-T-01's blister orders and was
 * refused (RATE_LIMITED, PR #37 CI). The pacer makes the test wait; the server's limit itself is unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoncePacer } from './harness.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('NoncePacer (test harness)', () => {
  it('keeps each terminal under its own limit in any window and lets other terminals through', async () => {
    vi.useFakeTimers({ now: 0 });
    const p = new NoncePacer(3, 100, 60_000);
    for (let i = 0; i < 3; i += 1) await p.take('KIOSK-A');
    let fourth = false;
    void p.take('KIOSK-A').then(() => {
      fourth = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fourth).toBe(false);
    await p.take('KIOSK-B');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fourth).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(fourth).toBe(true);
  });

  it('keeps all terminals together under the address limit', async () => {
    vi.useFakeTimers({ now: 0 });
    const p = new NoncePacer(10, 2, 60_000);
    await p.take('KIOSK-A');
    await p.take('KIOSK-B');
    let third = false;
    void p.take('KIOSK-C').then(() => {
      third = true;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(third).toBe(false);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(third).toBe(true);
  });
});
