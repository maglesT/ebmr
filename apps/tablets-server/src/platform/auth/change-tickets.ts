/**
 * First-login secret change (DI-15). An initial or reset secret is single use: the login that proves it gets a
 * restricted CREDENTIAL_CHANGE authentication event, and no session. The server keeps that event for two
 * minutes behind a random ticket (in memory, hashed), bound to the same identifier and terminal; the change
 * request presents the ticket instead of the already-used secret.
 */
import { createHash, randomBytes } from 'node:crypto';
import { uptimeMs } from '../clock.ts';

interface Ticket {
  authEventId: string;
  method: string;
  identifier: string;
  fingerprint: string;
  expiresAtMs: number;
}

const TTL_MS = 120_000;
const hash = (t: string): string => createHash('sha256').update(t).digest('hex');

export class ChangeTicketStore {
  private readonly tickets = new Map<string, Ticket>();

  issue(entry: Omit<Ticket, 'expiresAtMs'>): string {
    const now = uptimeMs();
    for (const [k, v] of this.tickets) if (v.expiresAtMs < now) this.tickets.delete(k);
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(hash(ticket), { ...entry, expiresAtMs: now + TTL_MS });
    return ticket;
  }

  /** The authentication event behind a ticket, for the same identifier and terminal; null otherwise. Not removed: a refused new secret may be retried. */
  peek(ticket: string, method: string, identifier: string, fingerprint: string): string | null {
    const t = this.tickets.get(hash(ticket));
    if (!t || t.expiresAtMs < uptimeMs() || t.method !== method || t.identifier !== identifier || t.fingerprint !== fingerprint) return null;
    return t.authEventId;
  }

  consume(ticket: string): void {
    this.tickets.delete(hash(ticket));
  }
}
