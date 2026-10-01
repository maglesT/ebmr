/**
 * Device identity (DI-20; plan section 5). Each browser origin holds a non-extractable ECDSA P-256 key; the
 * fingerprint is kernel identity.deviceFingerprint(SPKI DER). Authentication calls carry
 * proof = {spki, nonce, sig}, where sig is over `nonce|METHOD|path|sha256hex(canonical JSON of the body without
 * its proof)`. The server verifies the proof and resolves the device through the kernel registry; it never
 * trusts what the browser reports. DeviceIdentityProvider is an interface so mTLS can replace this later.
 *
 * The nonce is bound to the key that asked for it (nonces.ts), and a successful proof leaves a proof ticket (below):
 * the terminal's next nonce request shows it to count toward the terminal's own rate limit (bind.ts `by: 'DEVICE'`).
 */
import { createPublicKey, verify } from 'node:crypto';
import type pg from 'pg';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { identity } from '@ebmr/kernel';
import type { DeviceProof } from '@ebmr/api-contract';
import { refusal } from '../http/refusal.ts';
import { consumeNonce, nonceHmac } from './nonces.ts';

export interface IdentifiedDevice {
  fingerprint: string;
  device: identity.DeviceInfo;
}

export interface ProofSubject {
  method: string;
  /** URL path without the query string. */
  path: string;
  /** The request body without the member that carries the proof. */
  body: unknown;
}

export interface DeviceIdentityProvider {
  identify(proof: DeviceProof | undefined, subject: ProofSubject): Promise<IdentifiedDevice>;
  /**
   * The proof ticket of a nonce request (decision 0004 X26): true when `lastNonce` is the nonce of a successful device
   * proof by this key as an active browser terminal (PERSONAL, SHARED or GRADE_A_B), made within PROOF_TICKET_TTL_MS,
   * and not shown before; it is used up here. Only such a request counts toward the terminal's own rate-limit count
   * (bind.ts, `by: 'DEVICE'`): a caller who has not proven with the key (a copied public key, an invented one) has none.
   * In memory, no query and no alert.
   */
  takeProofTicket(spki: string, lastNonce: string): boolean;
  /**
   * The id of the active browser terminal enrolled with this public key now, or null: a plain read of the registry that
   * proves nothing and raises no alert. The rate-limit gate asks it for a request that shows a ticket, so a terminal
   * blocked since its last proof loses its own count at once.
   */
  enrolledTerminal(spki: string): Promise<string | null>;
}

/** The fingerprint of a claimed public key, decoded as a proof's key is (base64 SPKI DER). */
export function spkiFingerprint(spki: string): string {
  return identity.deviceFingerprint(Buffer.from(spki, 'base64'));
}

/** Terminals that sign device proofs in a browser (a nonce is asked for by nothing else). */
const BROWSER_TERMINAL_CLASSES: readonly string[] = ['PERSONAL', 'SHARED', 'GRADE_A_B'];

/** How long the nonce of a successful proof serves as the terminal's proof ticket (decision 0004 X26). */
export const PROOF_TICKET_TTL_MS = 10 * 60_000;
/** Tickets kept per key (browsers that share a key each show their own last nonce); the oldest goes first. */
const TICKETS_PER_KEY = 16;
/** Keys with tickets (only keys of enrolled terminals that proved get one); the least recently proven goes first. */
const MAX_TICKET_KEYS = 10_000;

/**
 * Proof tickets in the server's memory, per key fingerprint: the HMAC of the nonce each successful proof used, until
 * PROOF_TICKET_TTL_MS after it. A ticket answers `take` once. A restart forgets them all, and a terminal's next nonce
 * request then counts as unproven once (the stricter side).
 */
export class ProofTickets {
  private readonly byKey = new Map<string, Map<string, number>>();

  constructor(private readonly now: () => number = Date.now) {}

  record(fingerprint: string, hmac: string): void {
    const now = this.now();
    const tickets = this.byKey.get(fingerprint) ?? new Map<string, number>();
    this.byKey.delete(fingerprint);
    for (const [h, until] of tickets) if (until <= now) tickets.delete(h);
    tickets.set(hmac, now + PROOF_TICKET_TTL_MS);
    for (const h of tickets.keys()) {
      if (tickets.size <= TICKETS_PER_KEY) break;
      tickets.delete(h);
    }
    this.byKey.set(fingerprint, tickets);
    for (const k of this.byKey.keys()) {
      if (this.byKey.size <= MAX_TICKET_KEYS) break;
      this.byKey.delete(k);
    }
  }

  take(fingerprint: string, hmac: string): boolean {
    const tickets = this.byKey.get(fingerprint);
    const until = tickets?.get(hmac);
    if (tickets === undefined || until === undefined) return false;
    tickets.delete(hmac);
    if (tickets.size === 0) this.byKey.delete(fingerprint);
    return until > this.now();
  }
}

/** The text a device signs (the browser builds the same with expr's canonicalJson and sha256Hex). */
export function proofMessage(nonce: string, subject: ProofSubject): string {
  return `${nonce}|${subject.method.toUpperCase()}|${subject.path}|${sha256Hex(canonicalJson(subject.body ?? {}))}`;
}

/** The body without one member (the proof, or the attribution that carries its own proof). */
export function without(body: unknown, member: string): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const { [member]: _removed, ...rest } = body as Record<string, unknown>;
  void _removed;
  return rest;
}

const proofRefused = (why: string, reason: string) =>
  refusal(403, {
    code: 'DEVICE_PROOF',
    kind: 'NOT_ALLOWED',
    whatHappened: 'This terminal could not prove which registered device it is.',
    why,
    controls: ['DI-20'],
    whatYouCanDo: ['Reload the page and try again. If it happens again, the terminal needs to be enrolled.'],
    whoCanHelp: ['The system administrator (device enrolment)'],
    details: { reason },
  });

/**
 * Proof of possession of a WebCrypto P-256 key, resolved through the kernel device registry. Nonces live in
 * the application pool; iam.resolve_device is granted to the authentication service only.
 */
export function webCryptoDeviceProvider(pool: pg.Pool, authnPool: pg.Pool, nonceKey: string, tickets = new ProofTickets()): DeviceIdentityProvider {
  return {
    async identify(proof, subject) {
      if (!proof) throw proofRefused('The request carried no device proof.', 'MISSING');
      // The nonce is bound to the key that asked for it: one asked for under another key is not found.
      const fingerprint = spkiFingerprint(proof.spki);
      if (!(await consumeNonce(pool, nonceKey, proof.nonce, fingerprint))) {
        throw proofRefused('The device proof used a nonce that is unknown, already used, older than 60 seconds or issued for another device key.', 'NONCE');
      }
      let ok: boolean;
      try {
        const key = createPublicKey({ key: Buffer.from(proof.spki, 'base64'), format: 'der', type: 'spki' });
        if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
          throw proofRefused('The device key is not an ECDSA P-256 key.', 'KEY_TYPE');
        }
        ok = verify('sha256', Buffer.from(proofMessage(proof.nonce, subject), 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(proof.sig, 'base64'));
      } catch (error) {
        if (error instanceof Error && error.name === 'HttpRefusal') throw error;
        throw proofRefused('The device key or signature could not be read.', 'MALFORMED');
      }
      if (!ok) throw proofRefused('The device signature does not match this request.', 'SIGNATURE');
      let device: identity.DeviceInfo;
      try {
        device = await identity.resolveDevice(authnPool, fingerprint);
      } catch (error) {
        throw proofRefused(error instanceof Error ? error.message : String(error), 'UNREGISTERED');
      }
      if (BROWSER_TERMINAL_CLASSES.includes(device.deviceClass)) tickets.record(fingerprint, nonceHmac(nonceKey, proof.nonce, fingerprint));
      return { fingerprint, device };
    },
    takeProofTicket(spki, lastNonce) {
      const fingerprint = spkiFingerprint(spki);
      return tickets.take(fingerprint, nonceHmac(nonceKey, lastNonce, fingerprint));
    },
    async enrolledTerminal(spki) {
      // A plain read of the registry (the application role may read iam.device), not iam.resolve_device: the claim is
      // not a device check and must not raise UNREGISTERED_DEVICE or BLOCKED_DEVICE_USE alerts.
      const { rows } = await pool.query<{ id: string }>(
        `select id from iam.device where key_fingerprint = $1 and status = 'ACTIVE' and device_class = any($2::text[])`,
        [spkiFingerprint(spki), BROWSER_TERMINAL_CLASSES],
      );
      return rows[0]?.id ?? null;
    },
  };
}
