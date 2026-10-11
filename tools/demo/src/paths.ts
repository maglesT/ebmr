/** Where the demo lives (plan section 2): databases, ports, the DEMO-ONLY keys and the exchange directory. */
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
export const VAR_DIR = join(REPO_ROOT, 'var');
export const DEMO_DIR = join(VAR_DIR, 'demo');
export const KEYS_DIR = join(DEMO_DIR, 'keys');
export const EXCHANGE_DIR = join(VAR_DIR, 'exchange');
export const WEB_DIST = join(REPO_ROOT, 'apps/tablets-web/dist');

export const SERVER_MAIN = join(REPO_ROOT, 'apps/tablets-server/src/main.ts');
export const SERVER_SETUP = join(REPO_ROOT, 'apps/tablets-server/src/cli/setup.ts');
/** Module C5 entry points (tolerated when missing until C5 lands). */
export const GATEWAY_MAIN = join(REPO_ROOT, 'apps/site-gateway/src/main.ts');
export const SIMULATOR_MAIN = join(REPO_ROOT, 'apps/simulators/src/scale/main.ts');
/** Slice 6c (D-S6-8): the process and printer simulators behind the demo gateway. */
export const PROCESS_SIMULATOR_MAIN = join(REPO_ROOT, 'apps/simulators/src/process/main.ts');
export const PRINTER_SIMULATOR_MAIN = join(REPO_ROOT, 'apps/simulators/src/printer/main.ts');

/**
 * The demo's simulated devices behind the gateway (slice 6c, D-S6-8): a press, a coater, a line printer and the
 * packaging-line devices (bottle line, cartoner), each on its own protocol and console port (DEMO-ONLY).
 */
export const DEMO_DEVICES = [
  { code: 'DEMO-PRESS-01', kind: 'PRESS', serial: 'PRESS-0001', tcp: 4011, http: 4012 },
  { code: 'DEMO-COATER-01', kind: 'COATER', serial: 'COATER-0001', tcp: 4021, http: 4022 },
  { code: 'DEMO-PRN-01', kind: 'PRINTER', serial: 'PRN-0001', tcp: 4031, http: 4032 },
  { code: 'DEMO-BOTTLE-01', kind: 'BOTTLE_LINE', serial: 'BOTTLE-LINE-0001', tcp: 4041, http: 4042 },
  { code: 'DEMO-CARTONER-01', kind: 'CARTONER', serial: 'CARTONER-0001', tcp: 4051, http: 4052 },
] as const;

export const DEMO_DATABASES = { GMP: 'ebmr_tablets_demo', SANDBOX: 'ebmr_sandbox_tablets_demo' } as const;

export interface StackPorts {
  gmp: number;
  sandbox: number;
  /** The sandbox server's gateway listener (the gateway's uplink). */
  gatewayListener: number;
  gateway: number;
  simulatorTcp: number;
  simulatorHttp: number;
}

export const DEMO_PORTS: StackPorts = { gmp: 3001, sandbox: 3011, gatewayListener: 3012, gateway: 3021, simulatorTcp: 4001, simulatorHttp: 4002 };
