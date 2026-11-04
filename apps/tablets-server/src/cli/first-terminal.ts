/**
 * The first browser terminal of a platform installation (kernel 1402; DI-20). The platform's operator runs it once, as
 * the database superuser, after the browser has opened the site: its "not an enrolled terminal" page records the
 * browser's key fingerprint in an UNREGISTERED_DEVICE alert (iam.security_alert, details.fingerprint; the runbook reads
 * it). Later terminals are registered on the device screens by a person holding ebmr.iam.device_manage.
 *
 *   MIGRATE_DATABASE_URL=<superuser URL of the ebmr database> ebmr first-terminal --code PC-ADMIN-01 --fingerprint <hex>
 *     [--site SITE-1] [--class PERSONAL|SHARED]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export interface FirstTerminal {
  code: string;
  /** The browser key's SHA-256 fingerprint (hex). */
  fingerprint: string;
  site?: string;
  deviceClass?: 'PERSONAL' | 'SHARED';
}

/** Registers the terminal; returns its code, class, site and fingerprint as the register holds them. */
export async function registerFirstTerminal(url: string, t: FirstTerminal): Promise<{ code: string; deviceClass: string; site: string; fingerprint: string }> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('begin');
    const { rows: made } = await client.query<{ id: string }>('select iam.platform_register_terminal($1, $2, $3, $4) as id',
      [t.code, t.fingerprint, t.site ?? null, t.deviceClass ?? 'PERSONAL']);
    const { rows } = await client.query<{ code: string; device_class: string; site_code: string; key_fingerprint: string }>(
      'select code, device_class, site_code, key_fingerprint from iam.device where id = $1', [made[0]?.id]);
    await client.query('commit');
    const d = rows[0];
    if (!d) throw new Error('the terminal was not registered');
    return { code: d.code, deviceClass: d.device_class, site: d.site_code, fingerprint: d.key_fingerprint };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({
    options: { code: { type: 'string' }, fingerprint: { type: 'string' }, site: { type: 'string' }, class: { type: 'string' } },
  });
  const url = process.env['MIGRATE_DATABASE_URL'];
  if (!url || !values.code || !values.fingerprint || (values.class !== undefined && values.class !== 'PERSONAL' && values.class !== 'SHARED')) {
    console.error('usage: MIGRATE_DATABASE_URL=... ebmr first-terminal --code CODE --fingerprint HEX [--site SITE] [--class PERSONAL|SHARED]');
    process.exit(2);
  }
  const d = await registerFirstTerminal(url, {
    code: values.code, fingerprint: values.fingerprint,
    ...(values.site ? { site: values.site } : {}), ...(values.class ? { deviceClass: values.class } : {}),
  });
  console.log(`ebmr: terminal ${d.code} (${d.deviceClass}, site ${d.site}) registered for key ${d.fingerprint}`);
}
