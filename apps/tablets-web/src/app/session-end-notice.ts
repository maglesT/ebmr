/**
 * R3.11 (hosted-demo trials, October 2026): a kiosk went back to "Tap your badge" without a word when its person signed in
 * on another kiosk. The server's NO_SESSION then says why ("Priya Nair signed in on KIOSK-DISP-1; this session ended.",
 * details.endReason SUPERSEDED); the session control keeps those words here and the sign-in screen shows them until the
 * next sign-in. Only the server's words, only in this page's memory (never stored).
 */
let notice: string | null = null;

export function setSessionEndNotice(text: string | null): void {
  notice = text;
}

/** The words of the last session end the server explained, or null. */
export function sessionEndNotice(): string | null {
  return notice;
}
