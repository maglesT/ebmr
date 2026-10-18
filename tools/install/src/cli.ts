/**
 * The one-command installer of a Batchwright Tablets server (Phase 7 slice 7g-4; decision 0025 point 2: only putting the
 * software on a server stays a script). Run as root on the server, from the checkout:
 *
 *   tools/install/install.sh                      (checks node and pnpm, installs the dependencies, then runs this)
 *   pnpm install:server [--dry-run] [--answers answers.json] [--yes] [--issue-token]
 *
 * It asks for the installation kind (GMP or sandbox; a demo installation or not), the database (a local PostgreSQL 16
 * cluster it creates, or an existing server's superuser connection), the domain and TLS (Let's Encrypt through Caddy's
 * ACME client, a certificate the site provides, or none on localhost), and the service manager (systemd or docker
 * compose); then it does what plan.ts lists and prints the set-up URL and a one-time set-up token. With --dry-run it
 * says what it would do and changes nothing. --issue-token prints a new set-up token for an installation not yet set
 * up (the answers of the earlier run are read from its configuration directory). Running it again is safe.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { defaults, problems, type Answers } from './answers.ts';
import { realEnv } from './env.ts';
import { planInstall, rolesOf, secretsFromEnvFile, type Action } from './plan.ts';
import { runPlan, type InstallEnv } from './run.ts';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const hex = (): string => randomBytes(32).toString('hex');
const password = (): string => randomBytes(24).toString('base64url');

/** The superuser connection, passwords and plan of one run (pure but for the random material). */
export function prepareRun(a: Answers, env: Pick<InstallEnv, 'readFile'>, nodeBin: string, random = { hex, password }) {
  const earlier = secretsFromEnvFile(env.readFile(join(a.configDir, 'server.env')), a);
  const rolePasswords = Object.fromEntries(rolesOf(a).map((r) => [r, earlier[r] ?? random.password()]));
  const installerPassword = a.postgres.mode === 'LOCAL' ? random.password() : null;
  const adminUrl = a.postgres.mode === 'LOCAL' ? `postgres://ebmr_install:${encodeURIComponent(installerPassword ?? '')}@localhost:${String(a.postgres.port)}/postgres` : a.postgres.adminUrl;
  const keepAdmin = a.demo || a.installation === 'SANDBOX';
  const actions: Action[] = planInstall(a, { nodeBin, secrets: { roles: rolePasswords, adminUrl: keepAdmin ? adminUrl : null }, random: random.hex });
  return { actions, ctx: { adminUrl, installerPassword, rolePasswords } };
}

async function ask(a: Answers): Promise<Answers> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const q = async (text: string, fallback: string): Promise<string> => {
    const v = (await rl.question(`${text} [${fallback}]: `)).trim();
    return v === '' ? fallback : v;
  };
  try {
    const installation = (await q('Installation kind, GMP or SANDBOX (fixed for the life of the installation)', a.installation)).toUpperCase() === 'SANDBOX' ? 'SANDBOX' : 'GMP';
    const demo = /^y/i.test(await q('A demo installation (DEMO-ONLY demo data, resets and simulators)? y/n', a.demo ? 'y' : 'n'));
    const base = defaults(a.installDir, { installation, demo });
    const database = await q('Database name', base.database);
    const pgMode = (await q('PostgreSQL: LOCAL (create a 16 cluster here) or EXISTING (a server you give)', 'LOCAL')).toUpperCase();
    const postgres: Answers['postgres'] =
      pgMode === 'EXISTING'
        ? { mode: 'EXISTING', adminUrl: await q('Superuser connection (postgres://user:password@host:5432/postgres; not stored for GMP)', '') }
        : { mode: 'LOCAL', cluster: await q('Cluster name', 'ebmr'), port: Number(await q('Cluster port', '5432')) };
    const domain = await q('Domain the browsers use (localhost for this machine only)', base.domain);
    const tlsMode = (await q("TLS: LETSENCRYPT, PROVIDED (your certificate) or NONE (localhost only)", domain === 'localhost' ? 'NONE' : 'LETSENCRYPT')).toUpperCase();
    const tls: Answers['tls'] =
      tlsMode === 'LETSENCRYPT'
        ? { mode: 'LETSENCRYPT', email: await q("E-mail for the Let's Encrypt account", '') }
        : tlsMode === 'PROVIDED'
          ? { mode: 'PROVIDED', certFile: await q('Certificate file (PEM, with the chain)', ''), keyFile: await q('Private key file (PEM)', '') }
          : { mode: 'NONE' };
    const port = Number(await q('Server port (behind the proxy)', String(base.port)));
    const service = (await q('Service manager: SYSTEMD or COMPOSE', base.service)).toUpperCase() === 'COMPOSE' ? 'COMPOSE' : 'SYSTEMD';
    const name = await q('Service name', base.name);
    return defaults(a.installDir, { installation, demo, database, postgres, domain, tls, port, service, name, configDir: join('/etc/ebmr', name), dataDir: join('/var/lib/ebmr', name) });
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      answers: { type: 'string' },
      yes: { type: 'boolean', default: false },
      'issue-token': { type: 'boolean', default: false },
    },
  });
  let a = defaults(REPO_ROOT);
  if (values.answers) a = { ...a, ...(JSON.parse(readFileSync(values.answers, 'utf8')) as Partial<Answers>), installDir: REPO_ROOT };
  else if (!values['issue-token']) a = await ask(a);
  if (values['issue-token'] && !values.answers) {
    const file = join(a.configDir, 'install-answers.json');
    if (!existsSync(file)) throw new Error(`no earlier answers at ${file}: give them with --answers`);
    a = { ...a, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<Answers>) };
  }
  const wrong = problems(a);
  if (wrong.length > 0) throw new Error(`the answers are refused:\n  - ${wrong.join('\n  - ')}`);
  const env = realEnv();
  const { actions, ctx } = prepareRun(a, env, process.execPath);
  const chosen = values['issue-token'] ? actions.filter((x) => x.kind === 'installer-superuser' || x.kind === 'setup-token') : actions;
  if (!values['dry-run'] && !values.yes && !values['issue-token']) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = /^y/i.test(await rl.question(`Install ${a.name} (${a.installation}${a.demo ? ', demo' : ''}, database ${a.database}) now? y/n [n]: `));
    rl.close();
    if (!ok) return;
  }
  await runPlan(a, chosen, env, { dryRun: values['dry-run'], ...ctx });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(`install: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
