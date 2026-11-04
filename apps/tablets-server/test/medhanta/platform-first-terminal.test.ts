/**
 * MEDHANTA platform: the first browser terminal of a platform installation (kernel 1402, cli/first-terminal.ts; lead
 * decision of 4 Nov 2026 from the platform rehearsal). The standalone build enrols its first consoles in its first-run
 * set-up. The platform build has none, so the platform's operator registers the first terminal as an installation step.
 *
 * Control DI-20 (devices: only registered devices act, recorded with who registered them).
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { APP_LOGIN, asAdmin, copyDatabase, dropDatabase, uniqueSuffix, urlFor } from '@ebmr/test-kit';
import { registerFirstTerminal } from '../../src/cli/first-terminal.ts';
import { platformMigrate } from '../../src/cli/platform-migrate.ts';
import { platformInitDatabase } from '../support/platform-db.ts';

const platform = `ebmr_ftplat_${uniqueSuffix()}`;
const standalone = `ebmr_ftsolo_${uniqueSuffix()}`;
const fp = (): string => createHash('sha256').update(randomBytes(16)).digest('hex');

beforeAll(async () => {
  await platformInitDatabase(platform);
  await platformMigrate({ url: urlFor(platform), passwords: { authn: 'x'.repeat(16), analytics: 'y'.repeat(16) }, keysDir: mkdtempSync(join(tmpdir(), 'ebmr-ft-keys-')), setLogins: false });
  await copyDatabase(inject('serverTemplates').gmp.template, standalone);
}, 300_000);
afterAll(async () => {
  await Promise.all([dropDatabase(platform).catch(() => undefined), dropDatabase(standalone).catch(() => undefined)]);
});

describe('the first terminal of a platform installation (DI-20)', () => {
  it('[DI-20] the operator registers the first browser terminal on the platform build; it is then a registered device, recorded as the platform\'s installation act', async () => {
    const key = fp();
    // A fresh platform database names no site yet: the operator gives it.
    await expect(registerFirstTerminal(urlFor(platform), { code: 'PC-ADMIN-01', fingerprint: key })).rejects.toThrow(/EBMR-IAM-306/);
    const d = await registerFirstTerminal(urlFor(platform), { code: 'PC-ADMIN-01', fingerprint: key, site: 'SITE-1' });
    expect(d).toEqual({ code: 'PC-ADMIN-01', deviceClass: 'PERSONAL', site: 'SITE-1', fingerprint: key });
    const resolved = await asAdmin(platform, async (c) => (await c.query<{ r: { accepted: boolean; code: string } }>('select iam.resolve_device($1) as r', [key])).rows[0]?.r);
    expect(resolved).toMatchObject({ accepted: true, code: 'PC-ADMIN-01' });
    const by = await asAdmin(platform, async (c) => (await c.query<{ ok: boolean }>(
      'select d.registered_by_person = m.register_person as ok from iam.device d, iam.platform_mode m where d.code = $1', ['PC-ADMIN-01'])).rows[0]?.ok);
    expect(by).toBe(true);
    // Once the register names a site, a second terminal takes it; a key or code already registered is refused.
    const second = await registerFirstTerminal(urlFor(platform), { code: 'KIOSK-01', fingerprint: fp(), deviceClass: 'SHARED' });
    expect([second.site, second.deviceClass]).toEqual(['SITE-1', 'SHARED']);
    await expect(registerFirstTerminal(urlFor(platform), { code: 'PC-ADMIN-02', fingerprint: key })).rejects.toThrow();
  });

  it('[DI-20] refused on a standalone build, for a non-browser class, and to the application login', async () => {
    await expect(registerFirstTerminal(urlFor(standalone), { code: 'PC-X', fingerprint: fp(), site: 'SITE-1' })).rejects.toThrow(/EBMR-IAM-300/);
    await expect(asAdmin(platform, (c) => c.query("select iam.platform_register_terminal('GA-01', $1, 'SITE-1', 'GRADE_A_B')", [fp()]))).rejects.toThrow(/EBMR-IAM-306/);
    await expect(registerFirstTerminal(urlFor(platform, APP_LOGIN), { code: 'PC-Y', fingerprint: fp(), site: 'SITE-1' })).rejects.toMatchObject({ code: '42501' });
  });
});
