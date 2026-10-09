/**
 * First-login secret change (DI-15). An initial or reset secret is single use: the login that proves it gets a
 * restricted CREDENTIAL_CHANGE authentication event, and no session. The server keeps that event for two minutes (one on
 * a shared shop-floor terminal: review F04) behind a random ticket (in memory, hashed), bound to the same identifier and
 * terminal; the change request presents the ticket instead of the already-used secret. The minutes are read from
 * platform/clock.ts (the only reader of the process clock): a ticket lapses when either the monotonic or the wall clock
 * says they are up (X44).
 */
import { createHash, randomBytes } from 'node:crypto';
import { elapsedMs, moment, type Moment } from '../clock.ts';

interface Ticket {
  authEventId: string;
  method: string;
  identifier: string;
  fingerprint: string;
  issuedAt: Moment;
  /** How long this ticket lives (CHANGE_TICKET_TTL_MS, or SHOP_FLOOR_CHANGE_TICKET_TTL_MS on a shared terminal). */
  ttlMs: number;
}

/** How long a change ticket lives: two minutes. */
export const CHANGE_TICKET_TTL_MS = 120_000;
/**
 * On a shared shop-floor terminal (SHARED, GRADE_A_B) one minute: the default attribution window of a command there,
 * which the kernel applies to the change itself (kernel 0990, review F04: the next person at the kiosk must not find a
 * change still open). The database decides; a shorter policy window is refused there (EBMR-IAM-092).
 */
export const SHOP_FLOOR_CHANGE_TICKET_TTL_MS = 60_000;
const hash = (t: string): string => createHash('sha256').update(t).digest('hex');

export class ChangeTicketStore {
  private readonly tickets = new Map<string, Ticket>();

  issue(entry: Omit<Ticket, 'issuedAt' | 'ttlMs'>, ttlMs: number = CHANGE_TICKET_TTL_MS): string {
    const now = moment();
    for (const [k, v] of this.tickets) if (elapsedMs(v.issuedAt, now) > v.ttlMs) this.tickets.delete(k);
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(hash(ticket), { ...entry, issuedAt: now, ttlMs: Math.min(ttlMs, CHANGE_TICKET_TTL_MS) });
    return ticket;
  }

  /** The authentication event behind a ticket, for the same identifier and terminal; null otherwise. Not removed: a refused new secret may be retried. */
  peek(ticket: string, method: string, identifier: string, fingerprint: string): string | null {
    const t = this.tickets.get(hash(ticket));
    if (!t || elapsedMs(t.issuedAt, moment()) > t.ttlMs || t.method !== method || t.identifier !== identifier || t.fingerprint !== fingerprint) return null;
    return t.authEventId;
  }

  consume(ticket: string): void {
    this.tickets.delete(hash(ticket));
  }
}
