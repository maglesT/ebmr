/**
 * Which clock a proof ticket's ten minutes (decision 0004 X26, X44) run on when none is given: platform/clock.ts, the
 * only reader of the process clock, as for change tickets (change-ticket-clock.test.ts). ProofTickets used to default to
 * Date.now passed by reference, a wall-clock read outside clock.ts that the lint rule, which matched only a call, let
 * through (final verifier, follow-up round 4). Then it ran on the server's uptime, which was the wall clock less the
 * start time, so a wall clock set back let a ticket outlive its ten minutes (round-1 verifier of clock-and-tag). Now a
 * moment is read from the process's monotonic clock and the host's wall clock, and a ticket lapses when either says its
 * ten minutes are up. Both clocks are faked here: vi.setSystemTime steps the wall clock and leaves the monotonic clock
 * where it is (a clock set by hand or by a time sync, or a host resumed from suspension); vi.advanceTimersByTime moves
 * both. The TTL rules themselves, with a clock passed in, are in device-nonce-limit.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROOF_TICKET_TTL_MS, ProofTickets } from '../../src/platform/auth/device-proof.ts';

const HOUR_MS = 3_600_000;

/** Steps the host's wall clock by `ms`; the monotonic clock does not move. */
const stepWallClock = (ms: number): void => {
  vi.setSystemTime(Date.now() + ms);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance', 'Date'], now: Date.UTC(2026, 9, 1, 6) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('proof tickets', () => {
  it("[DI-19] without a clock of its own, a proof ticket's ten minutes run on platform/clock.ts", () => {
    const tickets = new ProofTickets();
    tickets.record('key-a', 'h1');
    tickets.record('key-a', 'h2');
    vi.advanceTimersByTime(PROOF_TICKET_TTL_MS - 1);
    expect(tickets.take('key-a', 'h1')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tickets.take('key-a', 'h2')).toBe(false);
  });

  it('[DI-19] a wall clock set back does not lengthen a proof ticket: its ten minutes run on the monotonic clock', () => {
    const tickets = new ProofTickets();
    tickets.record('key-a', 'h1');
    tickets.record('key-a', 'h2');
    stepWallClock(-HOUR_MS);
    vi.advanceTimersByTime(PROOF_TICKET_TTL_MS - 1);
    expect(tickets.take('key-a', 'h1')).toBe(true);
    vi.advanceTimersByTime(1);
    // The wall clock says 50 minutes before the proof; the monotonic clock says ten minutes after it.
    expect(tickets.take('key-a', 'h2')).toBe(false);
  });

  it('[DI-19] a wall clock set forward, as after the host was suspended, shortens a proof ticket; one proven after the step lives its ten minutes', () => {
    const tickets = new ProofTickets();
    tickets.record('key-a', 'h1');
    tickets.record('key-a', 'h2');
    vi.advanceTimersByTime(1_000);
    stepWallClock(PROOF_TICKET_TTL_MS - 1_001);
    expect(tickets.take('key-a', 'h1')).toBe(true);
    stepWallClock(1);
    // The monotonic clock says one second after the proof; the wall clock says ten minutes.
    expect(tickets.take('key-a', 'h2')).toBe(false);
    tickets.record('key-a', 'h3');
    tickets.record('key-a', 'h4');
    vi.advanceTimersByTime(PROOF_TICKET_TTL_MS - 1);
    expect(tickets.take('key-a', 'h3')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tickets.take('key-a', 'h4')).toBe(false);
  });
});
