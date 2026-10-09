/**
 * Display clock (plan section 3): countdowns and "last saved" ages on screen come from the server's time
 * (/api/meta serverTime) plus the monotonic performance.now(); the browser never formats or decides GMP time.
 * The only module of the web app allowed to read a clock.
 */
let anchor: { serverMs: number; perf: number } | null = null;

/** Anchors the display clock at a server instant (epoch microseconds text) received now. */
export function anchorServerTime(us: string): void {
  anchor = { serverMs: Number(BigInt(us) / 1000n), perf: performance.now() };
}

/** Server time now, in epoch milliseconds, for display countdowns only; null before the first anchor. */
export function serverNowMs(): number | null {
  return anchor ? anchor.serverMs + (performance.now() - anchor.perf) : null;
}

/** Whole seconds until a server instant (epoch microseconds text), for countdowns; null when unknown. */
export function secondsUntil(us: string): number | null {
  const now = serverNowMs();
  return now === null ? null : Math.max(0, Math.floor((Number(BigInt(us) / 1000n) - now) / 1000));
}

/** Whole seconds since a server instant (epoch microseconds text), for display ages only; null when unknown. */
export function secondsSince(us: string): number | null {
  const now = serverNowMs();
  return now === null ? null : Math.max(0, Math.floor((now - Number(BigInt(us) / 1000n)) / 1000));
}
