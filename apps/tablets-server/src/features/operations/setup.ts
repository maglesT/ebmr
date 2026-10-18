/**
 * The first-run set-up from the browser (Phase 7 slice 7g-4; decision 0025 point 2; kernel 1375). The route needs no
 * session (nobody exists to sign in yet); what protects it is the database's own check of the one-time set-up token
 * the installer printed (its SHA-256 only is stored; used up in the set-up's transaction; 5 minutes to 7 days), the
 * refusal once the installation is set up (EBMR-SETUP-001, EBMR-IAM-190), the server's rate limit on the route and the
 * same-origin checks every non-GET request passes (platform/http/security.ts). On a GMP installation the token is the
 * only way in: a person on the network who has not got it reaches nothing (D-P7g4-2).
 *
 * What the browser sends: the site (code, name, and the time zone it showed, which must be the one in force: the set-up
 * does not change it, D-P7g4-3; DI-09, DI-27), the first system administrator and process owner with
 * their first passwords (hashed here, argon2id, kernel identity; stored as BOOTSTRAP credentials that must be changed at
 * the first sign-in), and this browser's device key, which becomes the administrator's console (BOOTSTRAP-CONSOLE-1, a
 * PERSONAL terminal). The process owner's console is a placeholder fingerprint nobody holds a key for (D-P7g4-4): the
 * owner signs in from any terminal the administrator registers, or from this one.
 *
 * The seal key (DEMO-ONLY as a file; a KMS or HSM in production): when the server has a seal-key path (EBMR_SEAL_KEY_FILE)
 * with nothing in it, the set-up generates an HMAC-SHA256 key there (0600, never overwritten) and registers its id in the
 * same transaction as the accounts (esig.seal_key: the id and algorithm, never the secret); the server signs with it
 * from then on. The file is written first and removed again when the database refuses the set-up.
 */
import { createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { esig, identity } from '@ebmr/kernel';
import type { SetupDoneView, SetupRequest, SetupStateView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { spkiFingerprint } from '../../platform/auth/device-proof.ts';
import { refusal } from '../../platform/http/refusal.ts';

export function sealKeyState(app: AppContext): SetupStateView['sealKey'] {
  const file = app.config.sealKeyFile;
  if (!file) return 'NOT_CONFIGURED';
  return existsSync(file) ? 'PRESENT' : 'GENERATE';
}

export async function setupState(app: AppContext): Promise<SetupStateView> {
  const { rows } = await app.pools.app.query<{ s: { bootstrapped: boolean; tokenIssued: boolean; zone: string; site: { code: string; name: string } | null }; demo: boolean }>(
    'select iam.setup_state() as s, tab.is_demo_installation() as demo',
  );
  const s = rows[0]?.s;
  if (!s) throw new Error('iam.setup_state returned nothing');
  return {
    required: !s.bootstrapped,
    installation: app.installation,
    demo: rows[0]?.demo === true,
    tokenIssued: s.tokenIssued,
    siteZone: s.zone,
    site: s.site,
    sealKey: sealKeyState(app),
  };
}

const invalidConsole = () =>
  refusal(400, {
    code: 'SETUP_CONSOLE_KEY',
    kind: 'INVALID_INPUT',
    whatHappened: 'The set-up was not done: this browser\'s device key is not an ECDSA P-256 public key.',
    controls: ['DI-20'],
    whatYouCanDo: ['Reload the page and start the set-up again.'],
  });

/** The console key must be the P-256 public key the browser's device store makes (device/keystore.ts). */
function consoleFingerprint(spki: string): string {
  try {
    const key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw invalidConsole();
  } catch (e) {
    if (e instanceof Error && e.name === 'HttpRefusal') throw e;
    throw invalidConsole();
  }
  return spkiFingerprint(spki);
}

export async function runSetup(app: AppContext, body: SetupRequest): Promise<SetupDoneView> {
  const consoleFp = consoleFingerprint(body.consoleSpki);
  const ownerConsole = randomBytes(32).toString('hex');
  const sealFile = app.config.sealKeyFile;
  const generate = body.generateSealKey && sealKeyState(app) === 'GENERATE' && sealFile !== null;
  const seal = generate ? { keyId: `seal-${randomBytes(6).toString('hex')}`, algorithm: 'HMAC-SHA256' as const, secret: randomBytes(32).toString('base64') } : null;
  const [adminVerifier, ownerVerifier] = await Promise.all([identity.hashSecret(body.administrator.password), identity.hashSecret(body.processOwner.password)]);
  if (seal && sealFile) {
    // 'wx': never over a key that appeared meanwhile.
    writeFileSync(sealFile, `${JSON.stringify({ ...seal, label: 'seal key generated at the first-run set-up' }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  }
  const zone = body.site.zone.trim();
  let result: { site_code: string; zone: string };
  try {
    const { rows } = await app.pools.app.query<{ r: { site_code: string; zone: string } }>('select iam.first_run_setup($1, $2::jsonb) as r', [
      body.token,
      JSON.stringify({
        site: { code: body.site.code, name: body.site.name, zone },
        administrator: { legalName: body.administrator.legalName, loginName: body.administrator.loginName, verifier: adminVerifier, console: consoleFp },
        processOwner: { legalName: body.processOwner.legalName, loginName: body.processOwner.loginName, verifier: ownerVerifier, console: ownerConsole },
        sealKey: seal ? { keyId: seal.keyId, algorithm: seal.algorithm } : null,
      }),
    ]);
    const r = rows[0]?.r;
    if (!r) throw new Error('iam.first_run_setup returned nothing');
    result = r;
  } catch (error) {
    if (seal && sealFile) rmSync(sealFile, { force: true });
    app.log.warn({ err: error instanceof Error ? error.message : String(error) }, 'the first-run set-up was refused');
    throw error;
  }
  if (seal) app.sealKey = esig.hmacSealKey(seal.keyId, Buffer.from(seal.secret, 'base64'));
  const label = app.installation === 'SANDBOX' ? 'TEST-' : '';
  app.log.warn({ site: result.site_code, zone: result.zone, administrator: body.administrator.loginName, processOwner: body.processOwner.loginName }, 'the installation was set up from the browser (first-run set-up)');
  return {
    siteCode: result.site_code,
    siteZone: result.zone,
    administratorLogin: body.administrator.loginName,
    processOwnerLogin: body.processOwner.loginName,
    consoleDeviceCode: `${label}BOOTSTRAP-CONSOLE-1`,
    sealKeyId: seal?.keyId ?? null,
  };
}
