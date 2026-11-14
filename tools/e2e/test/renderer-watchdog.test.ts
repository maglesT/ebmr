/**
 * The renderer watchdog (fixtures/renderer-watchdog.ts): a page whose renderer stops answering fails the test about
 * STALL_MS after the stall, with where it was stuck, instead of at the test timeout (the I-6 E2E stalls). A fake clock
 * and probe make the timing deterministic; the real CDP probe is exercised by every E2E page.
 */
import { describe, expect, it } from 'vitest';
import { PROBE_MS, STALL_MS, watch, type Clock, type Probe } from '../fixtures/renderer-watchdog.ts';

function fakeClock(): Clock & { advance(ms: number): Promise<void> } {
  let t = 0;
  const timers: { ms: number; next: number; fn: () => void; on: boolean }[] = [];
  return {
    now: () => t,
    every: (ms, fn) => {
      const timer = { ms, next: t + ms, fn, on: true };
      timers.push(timer);
      return () => {
        timer.on = false;
      };
    },
    advance: async (ms) => {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => x.on && x.next <= end).sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        t = due.next;
        due.next += due.ms;
        due.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      t = end;
    },
  };
}

function probe(answers: 'always' | 'never' | 'reject', stack: string[] | null = null) {
  const calls = { ping: 0, where: 0, close: 0 };
  const p: Probe = {
    ping: () => {
      calls.ping += 1;
      return answers === 'always' ? Promise.resolve(1) : answers === 'reject' ? Promise.reject(new Error('navigating')) : new Promise(() => undefined);
    },
    where: () => {
      calls.where += 1;
      return Promise.resolve(stack);
    },
    close: () => {
      calls.close += 1;
      return Promise.resolve();
    },
  };
  return { p, calls };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('renderer watchdog', () => {
  it('leaves a page that answers alone, however long the test runs', async () => {
    const clock = fakeClock();
    const { p, calls } = probe('always');
    const reports: string[] = [];
    watch(p, clock, (r) => reports.push(r));
    await clock.advance(60 * 60_000);
    await flush();
    expect(reports).toEqual([]);
    expect(calls.close).toBe(0);
    expect(calls.ping).toBeGreaterThan(100);
  });

  it('counts a refused probe (the page navigating or closing) as an answer, not a stall', async () => {
    const clock = fakeClock();
    const { p, calls } = probe('reject');
    const reports: string[] = [];
    watch(p, clock, (r) => reports.push(r));
    await clock.advance(10 * 60_000);
    await flush();
    expect(reports).toEqual([]);
    expect(calls.close).toBe(0);
  });

  it('a renderer silent for the action timeout is reported with its JavaScript stack and closed, once', async () => {
    const clock = fakeClock();
    const { p, calls } = probe('never', ['spin http://localhost/assets/index.js:1:200']);
    const reports: string[] = [];
    watch(p, clock, (r) => reports.push(r));
    await clock.advance(STALL_MS);
    await flush();
    expect(reports).toEqual([]);
    await clock.advance(PROBE_MS);
    await flush();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/did not answer for 3\d s/);
    expect(reports[0]).toContain('spin http://localhost/assets/index.js:1:200');
    expect(calls.close).toBe(1);
    expect(calls.ping).toBe(1);
    await clock.advance(10 * 60_000);
    await flush();
    expect(reports).toHaveLength(1);
    expect(calls.close).toBe(1);
  });

  it('says so when the stuck main thread is not running script', async () => {
    const clock = fakeClock();
    const { p } = probe('never', null);
    const reports: string[] = [];
    watch(p, clock, (r) => reports.push(r));
    await clock.advance(STALL_MS + PROBE_MS);
    await flush();
    expect(reports[0]).toContain('not running script');
  });

  it('stops probing once stopped (the page closed normally)', async () => {
    const clock = fakeClock();
    const { p, calls } = probe('never');
    const reports: string[] = [];
    const stop = watch(p, clock, (r) => reports.push(r));
    await clock.advance(PROBE_MS);
    stop();
    await clock.advance(10 * 60_000);
    await flush();
    expect(reports).toEqual([]);
    expect(calls.ping).toBe(1);
  });
});
