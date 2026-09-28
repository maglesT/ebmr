/**
 * The badge of a kiosk signing (plan section 6, steps 2-4; decision D2): the signer taps for the challenge
 * (attribution of the challenge command) and then enters the PIN; the signature authentication is badge and PIN
 * (BADGE_PIN, purpose SIGNATURE). The contract's PIN credentials carry no badge UID, so the server keeps the UID
 * of the challenge's own tap here, in process memory only:
 *  - keyed by challenge and bound to the session's cookie token and person;
 *  - kept at most 130 s (the challenge lives 120 s at most), then dropped;
 *  - dropped as soon as the signature authentication succeeded (single use).
 * It never reaches a database, a log or a response. After a restart the signer simply taps again (fails closed).
 * A multi-process deployment needs a shared, encrypted store instead (A2).
 */
export const BADGE_TTL_MS = 130_000;

interface Entry {
  badgeUid: string;
  tokenHash: string;
  personId: string;
  at: number;
}

export class ChallengeBadgeStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  remember(challengeId: string, entry: { badgeUid: string; tokenHash: string; personId: string }): void {
    this.prune();
    this.entries.set(challengeId, { ...entry, at: this.now() });
  }

  /** The badge UID of the challenge's tap, when the same session and person ask within the time limit. */
  peek(challengeId: string, tokenHash: string, personId: string): string | null {
    this.prune();
    const e = this.entries.get(challengeId);
    if (!e || e.tokenHash !== tokenHash || e.personId !== personId) return null;
    return e.badgeUid;
  }

  forget(challengeId: string): void {
    this.entries.delete(challengeId);
  }

  size(): number {
    this.prune();
    return this.entries.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, e] of this.entries) if (t - e.at > BADGE_TTL_MS) this.entries.delete(k);
  }
}
