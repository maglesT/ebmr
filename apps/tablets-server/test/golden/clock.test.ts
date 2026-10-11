/**
 * The golden batches' clock (D-S6-6): the database under libfaketime follows the offset file, forward only, and the
 * tablets server's trusted time (tab.now_micros) follows the database. Runs only in the `golden` CI job (and locally on a
 * libfaketime cluster), where EBMR_FAKETIME_FILE names the offset file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../support/harness.ts';
import { advanceMinutes, goldenClockAvailable, offsetSeconds } from './clock.ts';

describe.runIf(goldenClockAvailable)('the golden clock (libfaketime offset, D-S6-6)', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer('GMP');
  }, 300_000);
  afterAll(async () => {
    await server?.close();
  });

  const dbSeconds = async (): Promise<bigint> => BigInt((await server.db.app.query<{ s: string }>('select (tab.now_micros()::bigint / 1000000)::text as s')).rows[0]?.s ?? '0');
  const hostSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

  it('[meta] the database clock runs ahead of the host by the offset; moving the offset forward moves the database clock, never back', async () => {
    const before = offsetSeconds();
    const ahead0 = (await dbSeconds()) - hostSeconds();
    expect(ahead0 >= before - 2n && ahead0 <= before + 2n).toBe(true);
    advanceMinutes(90);
    expect(offsetSeconds()).toBe(before + 5400n);
    const ahead1 = (await dbSeconds()) - hostSeconds();
    expect(ahead1 >= before + 5398n && ahead1 <= before + 5402n).toBe(true);
    expect(() => advanceMinutes(-1)).toThrow(/only moves forward/);
    expect(() => advanceMinutes(0)).toThrow(/only moves forward/);
  });
});
