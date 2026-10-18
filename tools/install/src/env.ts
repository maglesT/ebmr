/**
 * The installer's InstallEnv on this machine: programs (as another OS user through runuser when asked), files, the
 * local clusters, and the database through the kernel's and test-kit's own paths (createGmpDatabase, the kernel's sandbox
 * provisioning and upgrade, migrate), always with the superuser connection of this run.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { migrate, sandbox } from '@ebmr/kernel';
import { asAdmin, createGmpDatabase, databaseExists, editionMigrationSources } from '@ebmr/test-kit';
import type { Answers } from './answers.ts';
import type { ExecResult, InstallEnv } from './run.ts';

export const TABLETS_SQL = new URL('../../../apps/tablets-server/sql', import.meta.url).pathname;
const sources = () => editionMigrationSources([{ namespace: 'tablets', directory: TABLETS_SQL }]);
const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export function realEnv(log: (line: string) => void = (l) => console.log(l)): InstallEnv {
  const exec = (cmd: string, args: readonly string[], opts?: { asUser?: string }): Promise<ExecResult> =>
    new Promise((resolve) => {
      const [c, a] = opts?.asUser ? ['runuser', ['-u', opts.asUser, '--', cmd, ...args]] : [cmd, [...args]];
      const child = spawn(c, a, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      child.once('error', (e) => resolve({ code: 127, stdout, stderr: e.message }));
      child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  return {
    exec,
    exists: (p) => existsSync(p),
    readFile: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
    writeFile: (p, content, mode) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, { mode });
      chmodSync(p, mode);
    },
    mkdir: (p, mode) => mkdirSync(p, { recursive: true, mode }),
    async clusters() {
      const r = await exec('pg_lsclusters', ['--no-header']);
      if (r.code !== 0) return [];
      return r.stdout
        .split('\n')
        .map((l) => l.trim().split(/\s+/))
        .filter((f) => f[0] === '16' && f[1] && f[2])
        .map((f) => ({ name: f[1] ?? '', port: Number(f[2]) }));
    },
    db: {
      databaseExists: (adminUrl, database) => databaseExists(database, adminUrl),
      async createDatabase(adminUrl, a: Answers) {
        if (a.installation === 'GMP') await createGmpDatabase(a.database, sources(), adminUrl);
        else await sandbox.provisionSandboxDatabase({ adminUrl, database: a.database, sources: sources() });
      },
      async migrate(adminUrl, a: Answers) {
        if (a.installation === 'SANDBOX') return (await sandbox.upgradeSandboxDatabase({ adminUrl, database: a.database, sources: sources() })).applied.length;
        const applied = await asAdmin(a.database, (c) => migrate(c, sources()), adminUrl);
        await asAdmin(a.database, (c) => c.query('select sandbox.apply_connect_policy()'), adminUrl);
        return applied.length;
      },
      async markDemo(adminUrl, database) {
        await asAdmin(database, (c) => c.query('select tab.mark_demo_installation($1)', ['demo installation set up by the installer']), adminUrl);
      },
      async setRolePassword(adminUrl, a: Answers, role, password) {
        await asAdmin(a.database, async (c) => {
          if (role === 'ebmr_backup') {
            // Reads every table for pg_dump and nothing else (GMP only; a sandbox admits no other login, kernel 0800).
            await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'ebmr_backup') then create role ebmr_backup login bypassrls; end if; end $$`);
            await c.query('grant pg_read_all_data to ebmr_backup');
            await c.query(`grant connect on database ${ident(a.database)} to ebmr_backup`);
          }
          await c.query(`alter role ${ident(role)} with password ${pg.escapeLiteral(password)}`);
        }, adminUrl);
      },
      isBootstrapped: async (adminUrl, database) => asAdmin(database, async (c) => (await c.query<{ b: boolean }>('select iam.is_bootstrapped() as b')).rows[0]?.b === true, adminUrl),
      async issueSetupToken(adminUrl, database, sha256, minutes) {
        await asAdmin(database, (c) => c.query('select iam.issue_setup_token($1, $2)', [sha256, minutes]), adminUrl);
      },
    },
    async answers(url) {
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(2000) })).status === 200;
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
  };
}
