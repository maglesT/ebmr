/**
 * The one-command installer (Phase 7 slice 7g-4; decision 0025 point 2), never run for real here: its answers are
 * checked as the server would check them, a dry run plans every step and changes nothing, the files it writes say what
 * the server needs, and a second run with the same answers keeps what the first made (passwords, keys, the database)
 * and issues no token once the installation is set up. The machine is a fake InstallEnv that records what is done.
 */
import { describe, expect, it } from 'vitest';
import { defaults, problems, type Answers } from '../src/answers.ts';
import { prepareRun } from '../src/cli.ts';
import { runPlan, type ExecResult, type InstallEnv } from '../src/run.ts';

interface Fake extends InstallEnv {
  files: Map<string, { content: string; mode: number }>;
  dirs: Set<string>;
  execs: string[];
  dbCalls: string[];
  lines: string[];
  state: { database: boolean; bootstrapped: boolean; passwords: Map<string, string>; tokens: string[]; clusters: { name: string; port: number }[] };
}

function fakeEnv(): Fake {
  const files = new Map<string, { content: string; mode: number }>();
  const dirs = new Set<string>();
  const execs: string[] = [];
  const dbCalls: string[] = [];
  const lines: string[] = [];
  const state = { database: false, bootstrapped: false, passwords: new Map<string, string>(), tokens: [] as string[], clusters: [] as { name: string; port: number }[] };
  const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
  return {
    files, dirs, execs, dbCalls, lines, state,
    exec: (cmd, args, opts) => {
      execs.push(`${opts?.asUser ? `[${opts.asUser}] ` : ''}${cmd} ${args.join(' ')}`);
      if (cmd.endsWith('node')) return Promise.resolve(ok('v22.22.0'));
      if (cmd === 'pnpm' && args[0] === '--version') return Promise.resolve(ok('10.33.0'));
      if (cmd === 'pg_dump') return Promise.resolve(ok('pg_dump (PostgreSQL) 16.4'));
      if (cmd === 'caddy') return Promise.resolve(ok('v2.8.4'));
      if (cmd === 'docker') return Promise.resolve(ok('Docker Compose version v2.29'));
      if (cmd === 'pg_createcluster') state.clusters.push({ name: args[1] ?? '', port: Number(args[3]) });
      return Promise.resolve(ok());
    },
    exists: (p) => files.has(p),
    readFile: (p) => files.get(p)?.content ?? null,
    writeFile: (p, content, mode) => void files.set(p, { content, mode }),
    mkdir: (p) => void dirs.add(p),
    clusters: () => Promise.resolve([...state.clusters]),
    db: {
      databaseExists: () => Promise.resolve(state.database),
      createDatabase: (_u, a) => {
        dbCalls.push(`create ${a.database}`);
        state.database = true;
        return Promise.resolve();
      },
      migrate: (_u, a) => {
        dbCalls.push(`migrate ${a.database}`);
        return Promise.resolve(0);
      },
      markDemo: (_u, d) => {
        dbCalls.push(`mark-demo ${d}`);
        return Promise.resolve();
      },
      setRolePassword: (_u, _a, role, pw) => {
        state.passwords.set(role, pw);
        return Promise.resolve();
      },
      isBootstrapped: () => Promise.resolve(state.bootstrapped),
      issueSetupToken: (_u, _d, sha) => {
        state.tokens.push(sha);
        return Promise.resolve();
      },
    },
    answers: () => Promise.resolve(true),
    sleep: () => Promise.resolve(),
    log: (l) => void lines.push(l),
  };
}

const gmp = (): Answers =>
  defaults('/opt/ebmr', { installation: 'GMP', domain: 'ebmr.plant.example.in', tls: { mode: 'LETSENCRYPT', email: 'it@plant.example.in' }, postgres: { mode: 'LOCAL', cluster: 'ebmr', port: 5433 } });
const sandboxDemo = (): Answers =>
  defaults('/opt/ebmr', {
    installation: 'SANDBOX', demo: true, domain: 'demo.plant.example.in', tls: { mode: 'PROVIDED', certFile: '/etc/ssl/demo.pem', keyFile: '/etc/ssl/demo.key' },
    postgres: { mode: 'EXISTING', adminUrl: 'postgres://postgres:secret@db.internal:5432/postgres' }, service: 'COMPOSE',
  });

let n = 0;
const random = { hex: () => (n++).toString(16).padStart(64, '0'), password: () => `pw-${String(n++)}` };

describe('the installer (decision 0025)', () => {
  it('refuses answers the server would refuse: a sandbox outside its names, a demo without a demo name, a GMP server without TLS, Let\'s Encrypt on localhost', () => {
    expect(problems(gmp())).toEqual([]);
    expect(problems(sandboxDemo())).toEqual([]);
    expect(problems(defaults('/opt', { installation: 'SANDBOX', database: 'ebmr_tablets_sbx' }))).toContainEqual(expect.stringMatching(/ebmr_sandbox_/));
    expect(problems(defaults('/opt', { demo: true, database: 'ebmr_tablets' }))).toContainEqual(expect.stringMatching(/_demo/));
    expect(problems(defaults('/opt', { installation: 'GMP', demo: false, tls: { mode: 'NONE' } }))).toContainEqual(expect.stringMatching(/DI-13/));
    expect(problems(defaults('/opt', { domain: 'localhost', tls: { mode: 'LETSENCRYPT', email: 'it@x.in' } }))).toContainEqual(expect.stringMatching(/public domain/));
    expect(problems(defaults('/opt', { domain: 'plant.example.in', tls: { mode: 'NONE' }, demo: true, database: 'ebmr_tablets_demo' }))).toContainEqual(expect.stringMatching(/localhost/));
    expect(problems(defaults('/opt', { installation: 'GMP', database: 'ebmr_sandbox_tablets' }))).toContainEqual(expect.stringMatching(/sandbox prefix/));
  });

  it('a dry run of a GMP installation (local cluster, Let\'s Encrypt, systemd) plans every step and changes nothing', async () => {
    const env = fakeEnv();
    const a = gmp();
    const { actions, ctx } = prepareRun(a, env, '/usr/bin/node', random);
    const out = await runPlan(a, actions, env, { dryRun: true, ...ctx });
    expect(out).toEqual({ token: null, setUp: false });
    expect(env.execs).toEqual([]);
    expect(env.files.size).toBe(0);
    expect(env.dirs.size).toBe(0);
    expect(env.dbCalls).toEqual([]);
    const text = env.lines.join('\n');
    for (const step of [
      'would check node 22.12 or later', 'would check Caddy', 'would create the PostgreSQL 16 cluster ebmr on port 5433', 'would set the installer\'s superuser ebmr_install',
      'would create the GMP database ebmr_tablets', 'would set the passwords of the login roles ebmr_app, ebmr_authn, ebmr_listener, ebmr_analytics, ebmr_backup',
      'would write /etc/ebmr/ebmr-gmp/server.env', 'would run pnpm --dir /opt/ebmr --filter @ebmr/tablets-web build', 'would write /etc/ebmr/ebmr-gmp/Caddyfile',
      'would write /etc/systemd/system/ebmr-gmp.service', 'would write /etc/systemd/system/ebmr-gmp-proxy.service', 'would run systemctl enable --now ebmr-gmp.service ebmr-gmp-proxy.service',
      'would wait until the server answers http://127.0.0.1:3001/api/meta', 'would print the set-up URL https://ebmr.plant.example.in/ and a one-time set-up token',
    ]) {
      expect(text).toContain(step);
    }
    // The order: the database before the roles' passwords, the files before the service, the service before the token.
    const at = (s: string) => text.indexOf(s);
    expect(at('would create the GMP database')).toBeLessThan(at('would set the passwords'));
    expect(at('would write /etc/ebmr/ebmr-gmp/server.env')).toBeLessThan(at('would run systemctl enable'));
    expect(at('would run systemctl enable')).toBeLessThan(at('would print the set-up URL'));
    // No secret is printed: the passwords of the connections are masked.
    expect(text).toContain('EBMR_DB_APP_URL=postgres://ebmr_app:********@localhost:5433/ebmr_tablets');
    expect(text).not.toMatch(/pw-\d+/);
  });

  it('the files of a GMP installation: a production server on https, no superuser connection kept, the backup role, Caddy with Let\'s Encrypt, a confined systemd unit', () => {
    const env = fakeEnv();
    const a = gmp();
    const { actions } = prepareRun(a, env, '/usr/bin/node', random);
    const file = (path: string): string => {
      const x = actions.find((y) => (y.kind === 'write' || y.kind === 'keep') && y.path === path);
      if (!x || (x.kind !== 'write' && x.kind !== 'keep')) throw new Error(`no file ${path}`);
      return x.content;
    };
    const envText = file('/etc/ebmr/ebmr-gmp/server.env');
    expect(envText).toContain('EBMR_INSTALLATION=GMP');
    expect(envText).toContain('EBMR_ENV=production');
    expect(envText).toContain('EBMR_PUBLIC_ORIGIN=https://ebmr.plant.example.in');
    expect(envText).toMatch(/EBMR_BACKUP_SOURCE_URL=postgres:\/\/ebmr_backup:pw-\d+@localhost:5433\/ebmr_tablets/);
    expect(envText).toContain('EBMR_SEAL_KEY_FILE=/var/lib/ebmr/ebmr-gmp/keys/gmp-seal-key.json');
    expect(envText).not.toContain('EBMR_PG_ADMIN_URL');
    expect(envText).not.toContain('EBMR_DEMO=');
    expect(file('/etc/ebmr/ebmr-gmp/Caddyfile')).toContain('email it@plant.example.in');
    expect(file('/etc/ebmr/ebmr-gmp/Caddyfile')).toContain('reverse_proxy 127.0.0.1:3001');
    const unit = file('/etc/systemd/system/ebmr-gmp.service');
    expect(unit).toContain('ExecStart=/usr/bin/node --import tsx apps/tablets-server/src/main.ts');
    expect(unit).toContain('EnvironmentFile=/etc/ebmr/ebmr-gmp/server.env');
    expect(unit).toContain('ProtectSystem=strict');
    expect(unit).toContain('ReadWritePaths=/var/lib/ebmr/ebmr-gmp');
    const answers = JSON.parse(file('/etc/ebmr/ebmr-gmp/install-answers.json')) as Answers;
    expect(answers.installation).toBe('GMP');
  });

  it('the files of a sandbox demo installation (an existing server, a provided certificate, docker compose): the demo switches, the superuser connection for its resets, the compose services; the superuser connection is not kept in the answers', () => {
    const env = fakeEnv();
    const a = sandboxDemo();
    const { actions } = prepareRun(a, env, '/usr/bin/node', random);
    expect(actions.some((x) => x.kind === 'demo-marker')).toBe(true);
    expect(actions.some((x) => x.kind === 'cluster')).toBe(false);
    const write = (path: string) => {
      const x = actions.find((y) => y.kind === 'write' && y.path === path);
      return x && x.kind === 'write' ? x.content : '';
    };
    const envText = write('/etc/ebmr/ebmr-sandbox-demo/server.env');
    expect(envText).toContain('EBMR_INSTALLATION=SANDBOX');
    expect(envText).toContain('EBMR_ENV=development');
    expect(envText).toContain('EBMR_DEMO=1');
    expect(envText).toContain('EBMR_PG_ADMIN_URL=postgres://postgres:secret@db.internal:5432/postgres');
    expect(envText).toContain('EBMR_WEB_DIST=/app/apps/tablets-web/dist');
    expect(envText).toMatch(/EBMR_DB_APP_URL=postgres:\/\/ebmr_sandbox:pw-\d+@db\.internal:5432\/ebmr_sandbox_tablets_demo/);
    const compose = write('/etc/ebmr/ebmr-sandbox-demo/docker-compose.yml');
    expect(compose).toContain('image: node:22.12.0-bookworm');
    expect(compose).toContain('image: caddy:2.8.4');
    expect(compose).toContain('/etc/ssl/demo.pem:/etc/ssl/demo.pem:ro');
    expect(write('/etc/ebmr/ebmr-sandbox-demo/Caddyfile')).toContain('tls /etc/ssl/demo.pem /etc/ssl/demo.key');
    expect(write('/etc/ebmr/ebmr-sandbox-demo/install-answers.json')).not.toContain('secret');
    expect(actions.some((x) => x.kind === 'exec' && x.cmd === 'docker' && x.args.includes('up'))).toBe(true);
  });

  it('runs again safely: the second run keeps the cluster, the passwords, the keys and the database (migrated, not created), and once the installation is set up it issues no token', async () => {
    const env = fakeEnv();
    const a = gmp();
    const first = prepareRun(a, env, '/usr/bin/node', random);
    const one = await runPlan(a, first.actions, env, { dryRun: false, ...first.ctx });
    expect(one.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.state.tokens).toHaveLength(1);
    expect(env.dbCalls).toEqual(['create ebmr_tablets']);
    expect(env.execs.filter((e) => e.startsWith('pg_createcluster'))).toHaveLength(1);
    expect(env.execs.some((e) => e.startsWith('[postgres] psql -p 5433'))).toBe(true);
    const passwords = new Map(env.state.passwords);
    const keys = env.files.get('/var/lib/ebmr/ebmr-gmp/keys/gmp-secrets.json')?.content;
    expect(env.files.get('/etc/ebmr/ebmr-gmp/server.env')?.mode).toBe(0o600);

    const second = prepareRun(a, env, '/usr/bin/node', random);
    const two = await runPlan(a, second.actions, env, { dryRun: false, ...second.ctx });
    expect(env.execs.filter((e) => e.startsWith('pg_createcluster'))).toHaveLength(1);
    expect(env.dbCalls).toEqual(['create ebmr_tablets', 'migrate ebmr_tablets']);
    expect(env.state.passwords).toEqual(passwords);
    expect(env.files.get('/var/lib/ebmr/ebmr-gmp/keys/gmp-secrets.json')?.content).toBe(keys);
    expect(env.lines.some((l) => l.startsWith('keep /var/lib/ebmr/ebmr-gmp/keys/gmp-secrets.json'))).toBe(true);
    expect(two.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.state.tokens).toHaveLength(2);

    env.state.bootstrapped = true;
    const third = prepareRun(a, env, '/usr/bin/node', random);
    const three = await runPlan(a, third.actions, env, { dryRun: false, ...third.ctx });
    expect(three).toEqual({ token: null, setUp: true });
    expect(env.state.tokens).toHaveLength(2);
  });

  it('stops at a missing prerequisite and says which', async () => {
    const env = fakeEnv();
    env.exec = (cmd) => Promise.resolve(cmd === 'pnpm' ? { code: 127, stdout: '', stderr: 'pnpm: not found' } : { code: 0, stdout: 'v22.22.0 16 v2', stderr: '' });
    const a = gmp();
    const { actions, ctx } = prepareRun(a, env, '/usr/bin/node', random);
    await expect(runPlan(a, actions, env, { dryRun: false, ...ctx })).rejects.toThrow(/pnpm 10 is needed/);
    expect(env.dbCalls).toEqual([]);
  });
});
