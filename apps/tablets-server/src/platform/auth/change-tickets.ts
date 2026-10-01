/**
 * First-login secret change (DI-15). An initial or reset secret is single use: the login that proves it gets a
 * restricted CREDENTIAL_CHANGE authentication event, and no session. The server keeps that event for two
 * minutes behind a random ticket (in memory, hashed), bound to the same identifier and terminal; the change
 * request presents the ticket instead of the already-used secret. The two minutes are read from platform/clock.ts (the
 * only reader of the process clock): a ticket lapses when either the monotonic or the wall clock says they are up (X44).
 */
import { createHash, randomBytes } from 'node:crypto';
import { elapsedMs, moment, type Moment } from '../clock.ts';

interface Ticket {
  authEventId: string;
  method: string;
  identifier: string;
  fingerprint: string;
  issuedAt: Moment;
}

/** How long a change ticket lives: two minutes. */
export const CHANGE_TICKET_TTL_MS = 120_000;
const hash = (t: string): string => createHash('sha256').update(t).digest('hex');

export class ChangeTicketStore {
  private readonly tickets = new Map<string, Ticket>();

  issue(entry: Omit<Ticket, 'issuedAt'>): string {
    const now = moment();
    for (const [k, v] of this.tickets) if (elapsedMs(v.issuedAt, now) > CHANGE_TICKET_TTL_MS) this.tickets.delete(k);
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(hash(ticket), { ...entry, issuedAt: now });
    return ticket;
  }

  /** The authentication event behind a ticket, for the same identifier and terminal; null otherwise. Not removed: a refused new secret may be retried. */
  peek(ticket: string, method: string, identifier: string, fingerprint: string): string | null {
    const t = this.tickets.get(hash(ticket));
    if (!t || elapsedMs(t.issuedAt, moment()) > CHANGE_TICKET_TTL_MS || t.method !== method || t.identifier !== identifier || t.fingerprint !== fingerprint) return null;
    return t.authEventId;
  }

  consume(ticket: string): void {
    this.tickets.delete(hash(ticket));
  }
}
