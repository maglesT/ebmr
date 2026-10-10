/**
 * The serialisation L3 stub process (Phase 3 slice 4a): pools, serial events and hashed pool reports over HTTP for
 * the tablets server; state lasts for the run of the process.
 *
 *   EBMR_L3_HTTP=127.0.0.1:4041 EBMR_SIM_SEED=42 node --import tsx apps/simulators/src/serialisation/main.ts
 *
 * It binds a loopback address unless told otherwise, and stops on SIGTERM or SIGINT.
 */
import { startL3Stub } from './server.ts';

async function main(): Promise<void> {
  const env = process.env;
  const seed = Number(env['EBMR_SIM_SEED'] ?? '42');
  if (!Number.isInteger(seed)) throw new Error('EBMR_SIM_SEED must be an integer');
  const text = env['EBMR_L3_HTTP'] && env['EBMR_L3_HTTP'] !== '' ? env['EBMR_L3_HTTP'] : '127.0.0.1:4041';
  const m = /^(.+):(\d+)$/.exec(text);
  if (!m) throw new Error(`not a host:port address: ${text}`);
  const l3 = await startL3Stub({ seed, http: { host: m[1] ?? '127.0.0.1', port: Number(m[2]) } });
  console.log(`serialisation L3 stub: http port ${l3.port} (SIMULATOR, DEMO-ONLY)`);
  const stop = (signal: string) => {
    console.log(`serialisation L3 stub stopping (${signal})`);
    void l3.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(`serialisation L3 stub refused to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
