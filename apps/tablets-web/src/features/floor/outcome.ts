/**
 * How the floor reads the answer to a command (module C4; decision D1; DI-28). Pure, so it is tested alone.
 *
 * - SAVED: the server committed (2xx and a response that parses).
 * - LOST: no usable answer (network failure, a response that does not parse, a non-2xx without a refusal
 *   envelope, the wrong installation) or a server-side failure marked retryable (5xx). The outcome is unknown,
 *   so the entry is NOT SAVED and may only be resent with the same idempotency key (the server replays a
 *   committed first attempt).
 * - STALE: 409 because the run moved on (optimistic locking); nothing was saved.
 * - SWITCH_USER: the badge belongs to another person; the entry is discarded, never sent as that person.
 * - REFUSED: any other refusal envelope: a definite answer, nothing was saved.
 * That reading holds for a first send. For a resend after a lost answer, see `answersForEntry`.
 */
import type { CallError, RefusalEnvelope, Result } from '@ebmr/api-contract';

export type CommandOutcome<T> =
  | { kind: 'SAVED'; value: T }
  | { kind: 'LOST'; message: string }
  | { kind: 'STALE'; envelope: RefusalEnvelope }
  | { kind: 'SWITCH_USER'; envelope: RefusalEnvelope }
  | { kind: 'REFUSED'; envelope: RefusalEnvelope; status: number };

function isStale(status: number, envelope: RefusalEnvelope): boolean {
  const r = envelope.refusal;
  return status === 409 && (r.kind === 'STALE' || /STALE/.test(r.code));
}

/**
 * Whether an answer settles an entry whose earlier answer was lost (decision D1; DI-28). After a lost answer the
 * first send may or may not have committed, so a resend settles the entry only when the answer speaks for the
 * entry's idempotency key itself:
 * - SAVED: the first send's stored result replayed, or this send committed;
 * - a refusal from the engine (code ENG-...), and only on a route where the server runs the engine after it has
 *   claimed the key (`engineAfterClaim`: the run command, where a known key replays its stored result, a stored
 *   engine refusal included). Other routes check the request with the engine before the claim (issuing a test
 *   batch: packages.ts checkIssue), so there an engine refusal says nothing about the first send either.
 * Every other refusal can come before the key is claimed (no or locked session, role not chosen, CSRF, device
 * proof, rate limit, a badge or PIN not accepted, another person's badge, a kernel or request check at the start
 * of the command) and says nothing about the first send: the entry stays NOT SAVED under the same key and payload.
 * Until the server marks which refusals come after the claim, this is the stricter reading.
 */
export function answersForEntry<T>(outcome: CommandOutcome<T>, engineAfterClaim: boolean): boolean {
  switch (outcome.kind) {
    case 'SAVED':
      return true;
    case 'LOST':
    case 'SWITCH_USER':
      return false;
    case 'STALE':
    case 'REFUSED':
      return engineAfterClaim && outcome.envelope.refusal.code.startsWith('ENG-');
  }
}

export function classifyOutcome<T>(result: Result<T, CallError>): CommandOutcome<T> {
  if (result.ok) return { kind: 'SAVED', value: result.value };
  const e = result.error;
  switch (e.kind) {
    case 'NETWORK':
      return { kind: 'LOST', message: e.message };
    case 'PROTOCOL':
      return { kind: 'LOST', message: e.message };
    case 'INSTALLATION_MISMATCH':
      return { kind: 'LOST', message: `answer from ${e.actual ?? 'an unknown installation'}` };
    case 'REFUSAL': {
      const { status, envelope } = e;
      if (envelope.refusal.kind === 'SWITCH_USER') return { kind: 'SWITCH_USER', envelope };
      if (isStale(status, envelope)) return { kind: 'STALE', envelope };
      if (status >= 500 && envelope.retryable) return { kind: 'LOST', message: envelope.refusal.whatHappened };
      return { kind: 'REFUSED', envelope, status };
    }
  }
}
