/**
 * The installer's plan (Phase 7 slice 7g-4; decision 0025 point 2): from the answers, the actions that put a Batchwright
 * Tablets server on this machine, in order. The plan is pure (planInstall); runPlan performs it through an InstallEnv,
 * or in a dry run only says what it would do. Every action is idempotent, so the installer can run again with the same
 * answers: a cluster, role, database or file already there is kept (the role passwords and secrets are read back from
 * the files of the earlier run), pending migrations are applied, the web app is built again, the service restarted,
 * and, while the installation is not set up, a new one-time set-up token is printed.
 *
 *  1. the prerequisites (node 22, pnpm, PostgreSQL 16 client tools, the reverse proxy when there is TLS);
 *  2. PostgreSQL: a local 16 cluster (pg_createcluster) with an installer superuser whose password changes every run, or
 *     the superuser connection of an existing server;
 *  3. the database: created and migrated through the kernel's own paths (a GMP database: test-kit createGmpDatabase; a
 *     sandbox: kernel provisionSandboxDatabase, DI-05), or its pending migrations applied; a demo installation marked
 *     (tab.mark_demo_installation, decision D6);
 *  4. the login roles' passwords (strong, random, kept in the environment file only), and the backup role (GMP);
 *  5. the OS user, the directories, the secrets (CSRF and nonce keys, the backup key), the environment file;
 *  6. the web app's build; TLS (Caddy: Let's Encrypt through its ACME client, or the site's certificate); the systemd
 *     units or the docker compose file; the service started and its answer awaited;
 *  7. the set-up URL and the one-time set-up token (iam.issue_setup_token, kernel 1375; only its SHA-256 is stored).
 */
import { join } from 'node:path';
import { publicOrigin, storable, type Answers } from './answers.ts';
import { caddyfile, composeFile, envFile, keysDirOf, loginRoles, systemdUnits, type Secrets } from './render.ts';

export type Action =
  | { kind: 'check'; title: string; cmd: string; args: string[]; need: string }
  | { kind: 'exec'; title: string; cmd: string; args: string[]; asUser?: string }
  | { kind: 'mkdir'; path: string; mode: number }
  | { kind: 'write'; title: string; path: string; content: string; mode: number; secret?: boolean }
  /** Writes `content` only when `path` does not exist yet (a key generated once). */
  | { kind: 'keep'; title: string; path: string; content: string; mode: number }
  | { kind: 'cluster'; cluster: string; port: number }
  | { kind: 'installer-superuser'; cluster: string; port: number }
  | { kind: 'database' }
  | { kind: 'demo-marker' }
  | { kind: 'role-passwords' }
  | { kind: 'wait'; url: string }
  | { kind: 'setup-token' };

export interface PlanInputs {
  /** The node binary the service runs (process.execPath on this machine). */
  nodeBin: string;
  /** Role passwords and the admin connection of an earlier run, read back from its environment file. */
  secrets: Secrets;
  /** Random secret material (64 hex characters each): the CSRF key, the nonce key, the backup key. */
  random: () => string;
}

const prefixOf = (a: Answers): string => (a.installation === 'GMP' ? 'gmp' : 'sandbox');

export function planInstall(a: Answers, inputs: PlanInputs): Action[] {
  const keys = keysDirOf(a);
  const prefix = prefixOf(a);
  const tls = caddyfile(a);
  const actions: Action[] = [
    { kind: 'check', title: 'node 22.12 or later', cmd: inputs.nodeBin, args: ['--version'], need: 'v22' },
    { kind: 'check', title: 'pnpm 10', cmd: 'pnpm', args: ['--version'], need: '10.' },
    { kind: 'check', title: 'pg_dump of PostgreSQL 16 (backups)', cmd: 'pg_dump', args: ['--version'], need: ' 16' },
  ];
  if (tls && a.service === 'SYSTEMD') actions.push({ kind: 'check', title: 'Caddy, the TLS proxy (apt install caddy)', cmd: 'caddy', args: ['version'], need: 'v2' });
  if (a.service === 'COMPOSE') actions.push({ kind: 'check', title: 'docker compose', cmd: 'docker', args: ['compose', 'version'], need: 'version' });
  if (a.postgres.mode === 'LOCAL') {
    actions.push({ kind: 'cluster', cluster: a.postgres.cluster, port: a.postgres.port }, { kind: 'installer-superuser', cluster: a.postgres.cluster, port: a.postgres.port });
  }
  actions.push({ kind: 'database' });
  if (a.demo) actions.push({ kind: 'demo-marker' });
  actions.push({ kind: 'role-passwords' });
  if (a.service === 'SYSTEMD') {
    actions.push({ kind: 'exec', title: 'the ebmr OS user (no shell, no home login)', cmd: 'sh', args: ['-c', 'id ebmr >/dev/null 2>&1 || useradd --system --user-group --shell /usr/sbin/nologin --home-dir /var/lib/ebmr ebmr'] });
  }
  for (const d of [a.configDir, a.dataDir, keys, join(a.dataDir, 'exchange', 'to-sandbox'), join(a.dataDir, 'exchange', 'to-gmp'), join(a.dataDir, 'backups'), join(a.dataDir, 'caddy')]) {
    actions.push({ kind: 'mkdir', path: d, mode: 0o750 });
  }
  actions.push(
    { kind: 'keep', title: 'the CSRF and nonce keys', path: join(keys, `${prefix}-secrets.json`), content: `${JSON.stringify({ csrfHmacKey: inputs.random(), nonceKey: inputs.random() }, null, 2)}\n`, mode: 0o600 },
    { kind: 'keep', title: 'the backup encryption key', path: join(keys, `${prefix}-backup-key`), content: `${inputs.random()}\n`, mode: 0o600 },
    { kind: 'keep', title: 'the service-keys file (service identities and adapters)', path: join(keys, `${prefix}-service-keys.json`), content: `${JSON.stringify({ services: [] }, null, 2)}\n`, mode: 0o600 },
    { kind: 'write', title: 'the server environment file', path: join(a.configDir, 'server.env'), content: envFile(a, inputs.secrets), mode: 0o600, secret: true },
    { kind: 'write', title: 'the answers, for the next run (no secret)', path: join(a.configDir, 'install-answers.json'), content: `${JSON.stringify(storable(a), null, 2)}\n`, mode: 0o640 },
  );
  if (a.service === 'SYSTEMD') {
    actions.push({ kind: 'exec', title: 'the ebmr user owns the data directory', cmd: 'chown', args: ['-R', 'ebmr:ebmr', a.dataDir] });
    actions.push({ kind: 'exec', title: 'the ebmr user reads the configuration', cmd: 'chown', args: ['-R', 'root:ebmr', a.configDir] });
  }
  actions.push({ kind: 'exec', title: 'the web app (vite build)', cmd: 'pnpm', args: ['--dir', a.installDir, '--filter', '@ebmr/tablets-web', 'build'] });
  if (tls) actions.push({ kind: 'write', title: 'the TLS proxy configuration (Caddyfile)', path: join(a.configDir, 'Caddyfile'), content: tls, mode: 0o640 });
  if (a.service === 'SYSTEMD') {
    const units = systemdUnits(a, inputs.nodeBin);
    for (const u of units) actions.push({ kind: 'write', title: `the systemd unit ${u.file}`, path: u.file, content: u.content, mode: 0o644 });
    actions.push(
      { kind: 'exec', title: 'systemd reads the units', cmd: 'systemctl', args: ['daemon-reload'] },
      { kind: 'exec', title: 'the service starts (and at every boot)', cmd: 'systemctl', args: ['enable', '--now', ...units.map((u) => u.file.split('/').pop() ?? '')] },
      { kind: 'exec', title: 'the service runs the new configuration', cmd: 'systemctl', args: ['restart', ...units.map((u) => u.file.split('/').pop() ?? '')] },
    );
  } else {
    const file = join(a.configDir, 'docker-compose.yml');
    actions.push(
      { kind: 'write', title: 'the docker compose file', path: file, content: composeFile(a), mode: 0o640 },
      { kind: 'exec', title: 'the containers start', cmd: 'docker', args: ['compose', '-f', file, 'up', '-d', '--force-recreate'] },
    );
  }
  actions.push({ kind: 'wait', url: `http://127.0.0.1:${String(a.port)}/api/meta` }, { kind: 'setup-token' });
  return actions;
}

/** The login roles whose passwords the installer sets (each once; the sandbox's application role serves both pools). */
export function rolesOf(a: Answers): string[] {
  return [...new Set(loginRoles(a).map((r) => r.role))];
}

/** Reads the role passwords back from an earlier run's environment file (so a run again keeps them). */
export function secretsFromEnvFile(text: string | null, a: Answers): Partial<Record<string, string>> {
  if (!text) return {};
  const out: Record<string, string> = {};
  for (const { role, variable } of loginRoles(a)) {
    const line = text.split('\n').find((l) => l.startsWith(`${variable}=`));
    const url = line?.slice(variable.length + 1);
    if (!url) continue;
    try {
      const u = new URL(url);
      if (u.username === role && u.password) out[role] = decodeURIComponent(u.password);
    } catch {
      // a line that is not a URL is ignored: a new password is set
    }
  }
  return out;
}

export const setupUrl = (a: Answers): string => `${publicOrigin(a)}/`;
