/**
 * Which clock a first-login change ticket's two minutes (decision C0-2; decision 0004 X44) run on: platform/clock.ts,
 * the only reader of the process clock, as for proof tickets (proof-ticket-clock.test.ts). They ran on the server's
 * uptime, which was the wall clock less the start time, so a wall clock set back let a ticket outlive its two minutes
 * (round-1 verifier of clock-and-tag). Now a ticket lapses when either the process's monotonic clock or the host's wall
 * clock says its two minutes are up. Both clocks are faked: vi.setSystemTime steps the wall clock only;
 * vi.advanceTimersByTime moves both. The login flow that issues and uses the ticket is in login.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANGE_TICKET_TTL_MS, ChangeTicketStore, SHOP_FLOOR_CHANGE_TICKET_TTL_MS } from '../../src/platform/auth/change-tickets.ts';

const HOUR_MS = 3_600_000;
const ENTRY = { authEventId: 'auth-1', method: 'PASSWORD', identifier: 'op.one', fingerprint: 'fp-1' } as const;

/** Steps the host's wall clock by `ms`; the monotonic clock does not move. */
const stepWallClock = (ms: number): void => {
  vi.setSystemTime(Date.now() + ms);
};

const peek = (store: ChangeTicketStore, ticket: string): string | null => store.peek(ticket, ENTRY.method, ENTRY.identifier, ENTRY.fingerprint);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance', 'Date'], now: Date.UTC(2026, 9, 1, 6) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('change tickets', () => {
  it('[DI-15] a change ticket lives two minutes', () => {
    const store = new ChangeTicketStore();
    const ticket = store.issue(ENTRY);
    vi.advanceTimersByTime(CHANGE_TICKET_TTL_MS);
    expect(peek(store, ticket)).toBe('auth-1');
    vi.advanceTimersByTime(1);
    expect(peek(store, ticket)).toBeNull();
  });

  it('[DI-15] a wall clock set back does not lengthen a change ticket: its two minutes run on the monotonic clock', () => {
    const store = new ChangeTicketStore();
    const ticket = store.issue(ENTRY);
    stepWallClock(-HOUR_MS);
    vi.advanceTimersByTime(CHANGE_TICKET_TTL_MS);
    expect(peek(store, ticket)).toBe('auth-1');
    vi.advanceTimersByTime(1);
    expect(peek(store, ticket)).toBeNull();
  });

  it('[DI-15] a wall clock set forward, as after the host was suspended, shortens a change ticket', () => {
    const store = new ChangeTicketStore();
    const ticket = store.issue(ENTRY);
    vi.advanceTimersByTime(1_000);
    stepWallClock(CHANGE_TICKET_TTL_MS - 1_000);
    expect(peek(store, ticket)).toBe('auth-1');
    stepWallClock(1);
    expect(peek(store, ticket)).toBeNull();
    const after = store.issue(ENTRY);
    vi.advanceTimersByTime(CHANGE_TICKET_TTL_MS);
    expect(peek(store, after)).toBe('auth-1');
  });

  it('[DI-15][DI-38] a change ticket issued on a shared shop-floor terminal lives one minute (F04); no ticket lives longer than two', () => {
    expect(SHOP_FLOOR_CHANGE_TICKET_TTL_MS).toBe(60_000);
    const store = new ChangeTicketStore();
    const kiosk = store.issue(ENTRY, SHOP_FLOOR_CHANGE_TICKET_TTL_MS);
    const office = store.issue(ENTRY);
    const tooLong = store.issue(ENTRY, 10 * CHANGE_TICKET_TTL_MS);
    vi.advanceTimersByTime(SHOP_FLOOR_CHANGE_TICKET_TTL_MS);
    expect(peek(store, kiosk)).toBe('auth-1');
    vi.advanceTimersByTime(1);
    expect(peek(store, kiosk)).toBeNull();
    expect(peek(store, office)).toBe('auth-1');
    vi.advanceTimersByTime(CHANGE_TICKET_TTL_MS - SHOP_FLOOR_CHANGE_TICKET_TTL_MS);
    expect(peek(store, office)).toBeNull();
    expect(peek(store, tooLong)).toBeNull();
  });
});
