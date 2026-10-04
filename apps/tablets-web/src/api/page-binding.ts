/**
 * Which sign-in this page works in (review F41, round 4; DI-13, DI-14, DI-38; ADR 0017 item 4). Cookies ignore ports,
 * so a page on another port of this computer can set this installation's session cookie when the browser holds none
 * (another person's live session), and another tab's sign-in replaces the cookie while this page works. The page
 * therefore names, on every request, the key of its own terminal (the SHA-256 of the public key it signs device proofs
 * with: the kernel's device fingerprint) and the person its session started with, and the server serves as nobody a
 * session opened on another terminal (SESSION_OTHER_TERMINAL) or of another person (SESSION_CHANGED).
 *
 * The person is kept per tab (sessionStorage of this origin, which no page of another port can read or write), so a
 * reload keeps it; a new tab starts with none and works in the session the browser holds, which it shows. Without site
 * storage it is kept in memory for the page's life.
 */
import { base64ToBytes } from '../device/base64.ts';

const KEY = 'ebmr.page.person';

/** The person when site storage cannot keep it. */
let remembered: string | null = null;

/** The person this page's session started with, or undefined when the page holds no session. */
export function pagePerson(): string | undefined {
  try {
    const stored = window.sessionStorage.getItem(KEY);
    if (stored !== null) return stored;
  } catch {
    // site storage blocked: the page's memory only
  }
  return remembered ?? undefined;
}

/** The page now works in a session of `personId` (sign-in, switch of person, start-up), or in none (null). */
export function bindPagePerson(personId: string | null): void {
  remembered = personId;
  try {
    if (personId === null) window.sessionStorage.removeItem(KEY);
    else window.sessionStorage.setItem(KEY, personId);
  } catch {
    // site storage blocked: kept in memory
  }
}

/** The key of this terminal as the server knows it: the SHA-256 (hex) of its public key's SPKI (DER, given in base64). */
export async function terminalKeyOf(publicKeySpki: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', base64ToBytes(publicKeySpki)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}
