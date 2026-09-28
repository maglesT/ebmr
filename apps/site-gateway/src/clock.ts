/**
 * The site gateway's only clock read (ESLint allows Date.now here and nowhere else in the gateway).
 *
 * - wallUs: the gateway host's wall clock in UTC epoch microseconds. It stamps a reading's sourceTimeUs; its
 *   trust is DEVICE_UNSYNCED unless the configuration reports a synchronised clock. GMP time of record is always
 *   the server's database clock (recorded_at).
 * - monoUs: a monotonic clock for durations (how long a reading waited before its upload, timeouts). It is only
 *   meaningful within one process lifetime.
 */
export interface GatewayClock {
  wallUs(): bigint;
  monoUs(): bigint;
}

export const systemClock: GatewayClock = {
  wallUs: () => BigInt(Date.now()) * 1000n,
  monoUs: () => process.hrtime.bigint() / 1000n,
};
