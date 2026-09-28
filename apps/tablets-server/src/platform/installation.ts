/**
 * Start-up guards (DI-05, INV-18; plan section 2):
 *  - the database must be of the configured kind (kernel sandbox.assertInstallationKind): a GMP server refuses
 *    a sandbox and vice versa; a copy under the wrong name reports no kind at all (EBMR-SBX-004) and is refused;
 *  - the site's time zone is the site policy site.zone (DI-27), which every actor context must declare
 *    (EBMR-IAM-118): the policy must hold an IANA zone name, and EBMR_SITE_ZONE, when set, must name the same zone;
 *    a change while the server runs is caught by the SiteZoneGuard (site-zone.ts);
 *  - demo switches need EBMR_DEMO=1 AND the tab.demo_installation marker (decision D6);
 *  - production refuses http origins and demo switches (config.ts).
 */
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { z } from 'zod';
import { sandbox, time } from '@ebmr/kernel';
import { DemoDeviceView, type DemoDeviceView as DemoDevice } from '@ebmr/api-contract';
import { ConfigError, type EnvConfig } from '../config.ts';
import type { DemoState } from './context.ts';
import { readPolicySiteZone } from './site-zone.ts';

export async function assertInstallation(pool: pg.Pool, config: EnvConfig): Promise<void> {
  await sandbox.assertInstallationKind(pool, config.installation);
}

/**
 * The site's time zone (DI-27): the site policy site.zone, the one zone the kernel accepts in an actor context
 * (EBMR-IAM-118). Refuses a policy value that is not an IANA zone name, and an EBMR_SITE_ZONE naming another zone.
 */
export async function siteZoneFromPolicy(pool: pg.Pool, config: Pick<EnvConfig, 'expectedSiteZone'>): Promise<string> {
  const zone = await readPolicySiteZone(pool);
  if (zone === null || !time.isValidTimeZone(zone)) {
    throw new ConfigError(`the site policy site.zone holds ${zone === null ? 'no value' : `"${zone}"`}, which is not an IANA time zone name; correct the policy (DI-27)`);
  }
  if (config.expectedSiteZone !== null && config.expectedSiteZone !== zone) {
    throw new ConfigError(
      `EBMR_SITE_ZONE is ${config.expectedSiteZone}, but the site's time zone (policy site.zone) is ${zone}; set EBMR_SITE_ZONE to ${zone} or remove it (DI-27)`,
    );
  }
  return zone;
}

export async function isDemoDatabase(pool: pg.Pool): Promise<boolean> {
  const { rows } = await pool.query<{ d: boolean }>('select tab.is_demo_installation() as d');
  return rows[0]?.d === true;
}

const DemoKeysFile = z.object({ installation: z.enum(['GMP', 'SANDBOX']), devices: z.array(DemoDeviceView) });

/** Demo state: enabled only with EBMR_DEMO=1 and the marker; the devices come from the DEMO-ONLY keys file. */
export async function demoState(pool: pg.Pool, config: EnvConfig): Promise<DemoState & { warning: string | null }> {
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
