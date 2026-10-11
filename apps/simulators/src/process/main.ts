/**
 * A process simulator process (Phase 3 slice 3a): a tablet press or a film coater speaking `ebmr.sim-process.v1`; since
 * slice 6c (D-S6-8) any kind of process equipment (EQUIPMENT_KINDS: granulator, dryer, blender, roller compactor,
 * blister machine, bottle line, cartoner too).
 *
 *   EBMR_SIM_EQUIPMENT=PRESS EBMR_SIM_TCP=127.0.0.1:4011 EBMR_SIM_HTTP=127.0.0.1:4012 EBMR_SIM_SERIAL=PRESS-0001 \
 *     EBMR_SIM_SEED=42 node --import tsx apps/simulators/src/process/main.ts
 *
 * Defaults: PRESS on 127.0.0.1:4011 (console 4012, serial PRESS-0001); COATER on 127.0.0.1:4021 (console 4022, serial
 * COATER-0001); any other kind on 127.0.0.1:4041 (console 4042, serial <KIND>-0001). EBMR_SIM_RUNNING=1 starts the
 * equipment running. It binds loopback addresses only unless told
 * otherwise, and stops on SIGTERM or SIGINT.
 */
import { EQUIPMENT_KINDS, type EquipmentKind } from '@ebmr/integration-sdk/process';
import { startProcessSimulator } from './server.ts';

function address(value: string | undefined, fallback: string): { host: string; port: number } {
  const text = value && value !== '' ? value : fallback;
  const m = /^(.+):(\d+)$/.exec(text);
  if (!m) throw new Error(`not a host:port address: ${text}`);
  return { host: m[1] ?? '127.0.0.1', port: Number(m[2]) };
}

async function main(): Promise<void> {
  const env = process.env;
  const equipment = (env['EBMR_SIM_EQUIPMENT'] ?? 'PRESS') as EquipmentKind;
  if (!(EQUIPMENT_KINDS as readonly string[]).includes(equipment)) throw new Error(`EBMR_SIM_EQUIPMENT must be one of ${EQUIPMENT_KINDS.join(', ')}`);
  const port = equipment === 'PRESS' ? 4011 : equipment === 'COATER' ? 4021 : 4041;
  const seed = Number(env['EBMR_SIM_SEED'] ?? '42');
  if (!Number.isInteger(seed)) throw new Error('EBMR_SIM_SEED must be an integer');
  const sim = await startProcessSimulator({
    equipment,
    tcp: address(env['EBMR_SIM_TCP'], `127.0.0.1:${String(port)}`),
    http: address(env['EBMR_SIM_HTTP'], `127.0.0.1:${String(port + 1)}`),
    serial: env['EBMR_SIM_SERIAL'] ?? `${equipment.replace(/_/g, '-')}-0001`,
    seed,
    running: env['EBMR_SIM_RUNNING'] === '1' || env['EBMR_SIM_RUNNING'] === 'true',
  });
  console.log(`${equipment.toLowerCase()} simulator ${sim.model.serial}: ebmr.sim-process.v1 on tcp port ${sim.tcpPort}, console on http port ${String(sim.httpPort)} (SIMULATOR, DEMO-ONLY)`);
  const stop = (signal: string) => {
    console.log(`${equipment.toLowerCase()} simulator stopping (${signal})`);
    void sim.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(`process simulator refused to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
