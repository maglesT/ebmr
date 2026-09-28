/**
 * Start-up guards (DI-05, INV-18; plan section 2):
 *  - the database must be of the configured kind (kernel sandbox.assertInstallationKind): a GMP server refuses
 *    a sandbox and vice versa; a copy under the wrong name reports no kind at all (EBMR-SBX-004) and is refused;
 *  - demo switches need EBMR_DEMO=1 AND the tab.demo_installation marker (decision D6);
 *  - production refuses http origins and demo switches (config.ts).
 */
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { z } from 'zod';
import { sandbox } from '@ebmr/kernel';
import { DemoDeviceView, type DemoDeviceView as DemoDevice } from '@ebmr/api-contract';
import type { ServerConfig } from '../config.ts';
import type { DemoState } from './context.ts';

export async function assertInstallation(pool: pg.Pool, config: ServerConfig): Promise<void> {
  await sandbox.assertInstallationKind(pool, config.installation);
}

export async function isDemoDatabase(pool: pg.Pool): Promise<boolean> {
  const { rows } = await pool.query<{ d: boolean }>('select tab.is_demo_installation() as d');
  return rows[0]?.d === true;
}

const DemoKeysFile = z.object({ installation: z.enum(['GMP', 'SANDBOX']), devices: z.array(DemoDeviceView) });

/** Demo state: enabled only with EBMR_DEMO=1 and the marker; the devices come from the DEMO-ONLY keys file. */
export async function demoState(pool: pg.Pool, config: ServerConfig): Promise<DemoState & { warning: string | null }> {
  if (!config.demoRequested) return { enabled: false, devices: [], warning: null };
  if (!(await isDemoDatabase(pool))) {
    return { enabled: false, devices: [], warning: 'EBMR_DEMO=1 is ignored: the database carries no demo-installation marker (decision D6)' };
  }
  let devices: DemoDevice[] = [];
  if (config.demoKeysFile) {
    const file = DemoKeysFile.parse(JSON.parse(readFileSync(config.demoKeysFile, 'utf8')));
    if (file.installation !== config.installation) throw new Error(`the demo keys file is for ${file.installation}, not ${config.installation}`);
    devices = file.devices;
  }
  return { enabled: true, devices, warning: null };
}
