/**
 * The connected site of the Phase 6 exit demo (slice 6j; demo list of the phase-6 plan): the external systems as their
 * simulators, each its own process (the E2E harness never imports an app: it starts the entry file and talks HTTP), and
 * the adapters the servers start themselves (features/integrations/adapters/start.ts): an INTEGRATION identity per
 * adapter registered like a device (DI-20), its service key and terminal in the installation's service-keys file with
 * the feed `endpoint`, and the data classes the site runs in MIRROR mode under the E2E change record (DI-09; support.ts).
 * Everything here happens before the servers start (the mode is read once at start, D-P6a-5). DEMO-ONLY credentials.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { identity, withCommand } from '@ebmr/kernel';
import { REPO_ROOT, spawnNode, type RunningProcess } from '@ebmr/demo';
import type { DatabaseHandle, SiteSeed } from '@ebmr/test-kit';
import { because, letters, setMirrorMode, type Administration } from '../specs/phase6/support.ts';

export interface SimProcess {
  name: string;
  proc: RunningProcess;
  /** The first match of the ready line. */
  match: RegExpExecArray;
}

/** Starts `entry` (under apps/simulators/src or apps/site-gateway/src) and waits for `ready` in its output. */
export function startProcess(name: string, entry: string, env: Record<string, string>, ready: RegExp, echo = false): Promise<SimProcess> {
  let out = '';
  return new Promise((resolve, reject) => {
    let done = false;
    const proc = spawnNode({
      name, entry: join(REPO_ROOT, 'apps', entry), env, echo,
      onLine: (line) => {
        out += `${line}\n`;
        const m = ready.exec(out);
        if (m && !done) {
          done = true;
          clearTimeout(timer);
          resolve({ name, proc, match: m });
        }
      },
    });
    const timer = setTimeout(() => {
      if (!done) reject(new Error(`${name} did not start: ${out.slice(-1500)}`));
    }, 60_000);
    proc.child.once('exit', (code) => {
      if (!done) {
        clearTimeout(timer);
        reject(new Error(`${name} exited (${String(code)}): ${out.slice(-1500)}`));
      }
    });
  });
}

/** A feed simulator on a free loopback port; answers its origin. */
export async function startFeedSim(kind: 'ERP' | 'QMS' | 'LMS' | 'CMMS' | 'L3'): Promise<{ sim: SimProcess; origin: string }> {
  const spec = {
    ERP: { entry: 'simulators/src/erp/serve.ts', listen: 'EBMR_SIM_HTTP', ready: / on (http:\/\/[^ ]+) / },
    QMS: { entry: 'simulators/src/qms/main.ts', listen: 'EBMR_QMS_HTTP', ready: /http port (\d+)/ },
    LMS: { entry: 'simulators/src/lms/main.ts', listen: 'EBMR_LMS_HTTP', ready: /http port (\d+)/ },
    CMMS: { entry: 'simulators/src/cmms/main.ts', listen: 'EBMR_CMMS_HTTP', ready: /http port (\d+)/ },
    L3: { entry: 'simulators/src/serialisation/main.ts', listen: 'EBMR_L3_HTTP', ready: /http port (\d+)/ },
  }[kind];
  const sim = await startProcess(`sim-${kind.toLowerCase()}`, spec.entry, { [spec.listen]: '127.0.0.1:0', EBMR_SIM_SEED: '42' }, spec.ready);
  const m = sim.match[1] ?? '';
  return { sim, origin: /^\d+$/.test(m) ? `http://127.0.0.1:${m}` : new URL(m).origin };
}

export interface AdapterIdentity {
  code: string;
  loginName: string;
  serviceKey: string;
  fingerprint: string;
  accountId: string;
}

/**
 * An adapter's INTEGRATION identity (service key, `roleCode`) on its own SERVER device, registered for `system`
 * (iam.register_integration_adapter), as the server tests' adapterIdentity makes it; in the sandbox every name is a test
 * label (DI-05).
 */
export async function adapterIdentity(db: DatabaseHandle, seed: SiteSeed, adm: Administration, name: string, system: string, roleCode: string): Promise<AdapterIdentity> {
  const sandbox = seed.installation === 'SANDBOX';
  const tag = letters(6).toUpperCase();
  const loginName = `${sandbox ? 'test-' : ''}adapter.${name.toLowerCase()}.${tag.toLowerCase()}`;
  const fingerprint = randomBytes(32).toString('hex');
  const created = await withCommand(db.app, because(adm.admin, `Demo set-up: the ${name} adapter's identity`), async (c) => {
    const personId = await identity.createPerson(c, 'SYSTEM', `${sandbox ? 'TEST-' : ''}${name} adapter ${tag}`);
    const accountId = await identity.createAccount(c, { personId, loginName, kind: 'INTEGRATION' });
    const { secret } = await identity.issueInitialSecret(c, accountId, 'SERVICE_KEY');
    await identity.activateAccount(c, accountId);
    const grantId = await identity.requestRoleGrant(c, { accountId, roleCode, reason: `Demo set-up: ${name} adapter` });
    await identity.registerDevice(c, { code: `${sandbox ? 'TEST-' : ''}SRV-${name}-${tag}`, deviceClass: 'SERVER', site: seed.siteCode, fingerprint, description: `${name} adapter host (demo)` });
    return { personId, accountId, secret, grantId };
  });
  await withCommand(db.app, because(adm.owner, `Demo set-up: the ${name} adapter's identity`), (c) => identity.decideRoleGrant(c, created.grantId, true, 'approved for the demo'));
  const code = `${sandbox ? 'TEST-' : ''}${name}-${tag}`;
  const ev = await identity.authenticate(db.authn, { method: 'SERVICE_KEY', identifier: loginName, secret: created.secret, deviceFingerprint: fingerprint, purpose: 'LOGIN' });
  const s = await identity.openSession(db.app, ev.authEventId, fingerprint);
  await withCommand(db.app, because(adm.admin, `Demo set-up: register the ${name} adapter`), (c) =>
    c.query('select iam.register_integration_adapter($1, $2, $3, $4, $5)', [code, system, created.accountId, s.deviceId, `${name} feed (demo)`]));
  await identity.endSession(db.app, s.sessionId);
  return { code, loginName, serviceKey: created.secret, fingerprint, accountId: created.accountId };
}

/** Adds the adapter's entry (its server terminal, credentials and feed endpoint) to a service-keys file. */
export function addServiceEntry(file: string, terminal: string, a: AdapterIdentity, endpoint: string): void {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { services?: object[] };
  parsed.services = [...(parsed.services ?? []), { terminal, loginName: a.loginName, serviceKey: a.serviceKey, fingerprint: a.fingerprint, endpoint }];
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
}

export { setMirrorMode };
