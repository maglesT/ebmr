/**
 * The MT-SICS scale simulator process (module C5), started by `pnpm demo` and the E2E stack:
 *
 *   EBMR_SIM_TCP=127.0.0.1:4001 EBMR_SIM_HTTP=127.0.0.1:4002 EBMR_SIM_SERIAL=SIM-0001 EBMR_SIM_SEED=42 \
 *     node --import tsx apps/simulators/src/scale/main.ts
 *
 * Optional: EBMR_SIM_INSTRUMENT (default BALANCE; since slice 6c, D-S6-8, also MOISTURE_ANALYSER, HARDNESS_TESTER,
 * FRIABILATOR, DISINTEGRATION_TESTER, LEAK_TESTER or CHECKWEIGHER on the same protocol), EBMR_SIM_RESOLUTION, EBMR_SIM_UNIT
 * and EBMR_SIM_CAPACITY (default the instrument's: 0.001 kg up to 60.000 for a balance), and for tests
 * EBMR_SIM_SETTLE_MS (1200), EBMR_SIM_STABILITY_TIMEOUT_MS (4000), EBMR_SIM_SLOW_MS (3000). It binds loopback
 * addresses only unless told otherwise, and stops on SIGTERM or SIGINT.
 */
import { INSTRUMENT_KINDS, INSTRUMENT_PROFILES, instrumentUnitProblem, type InstrumentKind } from '@ebmr/integration-sdk/scale';
import { startScaleSimulator } from './server.ts';

function ms(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number of milliseconds`);
  return n;
}

function address(value: string | undefined, fallback: string): { host: string; port: number } {
  const text = value && value !== '' ? value : fallback;
  const m = /^(.+):(\d+)$/.exec(text);
  if (!m) throw new Error(`not a host:port address: ${text}`);
  return { host: m[1] ?? '127.0.0.1', port: Number(m[2]) };
}

const optional = <K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> => (value === undefined ? {} : ({ [key]: value } as Partial<Record<K, number>>));

async function main(): Promise<void> {
  const env = process.env;
  const seed = Number(env['EBMR_SIM_SEED'] ?? '42');
  if (!Number.isInteger(seed)) throw new Error('EBMR_SIM_SEED must be an integer');
  const kind = (env['EBMR_SIM_INSTRUMENT'] ?? 'BALANCE') as InstrumentKind;
  if (!(INSTRUMENT_KINDS as readonly string[]).includes(kind)) throw new Error(`EBMR_SIM_INSTRUMENT must be one of ${INSTRUMENT_KINDS.join(', ')}`);
  const profile = INSTRUMENT_PROFILES[kind];
  const unit = env['EBMR_SIM_UNIT'] ?? profile.units[0];
  const unitProblem = instrumentUnitProblem(kind, unit);
  if (unitProblem) throw new Error(unitProblem);
  const sim = await startScaleSimulator({
    tcp: address(env['EBMR_SIM_TCP'], '127.0.0.1:4001'),
    http: address(env['EBMR_SIM_HTTP'], '127.0.0.1:4002'),
    serial: env['EBMR_SIM_SERIAL'] ?? 'SIM-0001',
    seed,
    resolution: env['EBMR_SIM_RESOLUTION'] ?? profile.resolution,
    unit,
    capacity: env['EBMR_SIM_CAPACITY'] ?? profile.capacity,
    ...optional('settleMs', ms(env['EBMR_SIM_SETTLE_MS'], 'EBMR_SIM_SETTLE_MS')),
    ...optional('stabilityTimeoutMs', ms(env['EBMR_SIM_STABILITY_TIMEOUT_MS'], 'EBMR_SIM_STABILITY_TIMEOUT_MS')),
    ...optional('slowMs', ms(env['EBMR_SIM_SLOW_MS'], 'EBMR_SIM_SLOW_MS')),
  });
  console.log(`${kind === 'BALANCE' ? 'scale' : kind.toLowerCase().replace(/_/g, ' ')} simulator ${sim.model.serial}: MT-SICS on tcp port ${sim.tcpPort}, console on http port ${String(sim.httpPort)} (SIMULATOR, DEMO-ONLY)`);
  const stop = (signal: string) => {
    console.log(`scale simulator stopping (${signal})`);
    void sim.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(`scale simulator refused to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
