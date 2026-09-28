/**
 * The server's only reads of the process clock (ESLint allows Date.now here and nowhere else in the app).
 * GMP time always comes from the database (dbNowUs in platform/db/commands.ts); this clock only serves
 * operational purposes that never enter a record: uptime and log timing.
 */
const startedAtMs = Date.now();

/** Milliseconds since the process started (operational only; never a GMP time). */
export function uptimeMs(): number {
  return Date.now() - startedAtMs;
}
