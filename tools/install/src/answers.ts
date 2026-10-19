/**
 * The installer's answers (Phase 7 slice 7g-4; decision 0025 point 2): what the person is asked, with the defaults and
 * the checks that refuse an installation the server itself would refuse (an http origin for a production GMP server,
 * DI-13; a sandbox outside the ebmr_sandbox_ names, DI-05; a demo installation without a demo name, decision D6).
 */
import { join } from 'node:path';

export type PostgresAnswer =
  /** An existing PostgreSQL 16 server: a superuser connection the installer uses (never stored for a GMP installation). */
  | { mode: 'EXISTING'; adminUrl: string }
  /** A local PostgreSQL 16 cluster the installer creates (pg_createcluster) and reaches as the postgres OS user. */
  | { mode: 'LOCAL'; cluster: string; port: number };

export type TlsAnswer =
  /** Let's Encrypt through the reverse proxy's ACME client (Caddy obtains and renews the certificate). */
  | { mode: 'LETSENCRYPT'; email: string }
  /** A certificate and key the site provides (PEM files). */
  | { mode: 'PROVIDED'; certFile: string; keyFile: string }
  /** No TLS: only for a demo or sandbox installation on this machine (localhost). */
  | { mode: 'NONE' };

export interface Answers {
  installation: 'GMP' | 'SANDBOX';
  /** A demo installation: DEMO-ONLY conveniences (demo data, reset, simulators) on a demo-named database. */
  demo: boolean;
  database: string;
  postgres: PostgresAnswer;
  /** The host name the browsers use (the public origin's host). */
  domain: string;
  tls: TlsAnswer;
  /** The server's own port behind the proxy (loopback). */
  port: number;
  /** The checkout of the code (the repository root). */
  installDir: string;
  /** The service's name (systemd unit, compose project, directory names). */
  name: string;
  configDir: string;
  dataDir: string;
  service: 'SYSTEMD' | 'COMPOSE';
  /** How long the first-run set-up token stays valid. */
  tokenMinutes: number;
}

export const DATABASE_NAME = /^[a-z][a-z0-9_]{1,62}$/;
const HOST = /^(localhost|(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*)$/;
export const DEMO_NAME = /(_demo$|_e2e_[a-z0-9]+$)/;

export function defaults(installDir: string, over: Partial<Answers> = {}): Answers {
  const installation = over.installation ?? 'GMP';
  const demo = over.demo ?? false;
  const database = over.database ?? `${installation === 'SANDBOX' ? 'ebmr_sandbox_tablets' : 'ebmr_tablets'}${demo ? '_demo' : ''}`;
  const name = over.name ?? `ebmr-${installation === 'SANDBOX' ? 'sandbox' : 'gmp'}${demo ? '-demo' : ''}`;
  return {
    installation,
    demo,
    database,
    postgres: { mode: 'LOCAL', cluster: 'ebmr', port: 5432 },
    domain: 'localhost',
    tls: { mode: 'NONE' },
    port: installation === 'SANDBOX' ? 3011 : 3001,
    installDir,
    name,
    configDir: join('/etc/ebmr', name),
    dataDir: join('/var/lib/ebmr', name),
    service: 'SYSTEMD',
    tokenMinutes: 24 * 60,
    ...over,
  };
}

/** What is wrong with the answers (empty when nothing is). */
export function problems(a: Answers): string[] {
  const out: string[] = [];
  if (!DATABASE_NAME.test(a.database)) out.push(`the database name ${a.database} is 2 to 63 lowercase letters, digits or underscores, starting with a letter`);
  const sandboxName = a.database.startsWith('ebmr_sandbox_');
  if (a.installation === 'SANDBOX' && !sandboxName) out.push(`a sandbox database is named ebmr_sandbox_<edition> (DI-05); ${a.database} is not`);
  if (a.installation === 'GMP' && sandboxName) out.push(`a GMP database may not use the sandbox prefix ebmr_sandbox_ (DI-05)`);
  if (a.demo && !DEMO_NAME.test(a.database)) out.push(`a demo installation's database name ends in _demo (decision D6); ${a.database} does not`);
  if (!HOST.test(a.domain)) out.push(`${a.domain} is not a host name`);
  if (a.tls.mode === 'NONE' && a.domain !== 'localhost') out.push('without TLS the server is reachable on this machine only: the domain must be localhost');
  if (a.tls.mode === 'NONE' && a.installation === 'GMP' && !a.demo) out.push('a GMP installation that is not a demo one needs TLS (DI-13: the production server refuses an http origin)');
  if (a.tls.mode === 'LETSENCRYPT' && (a.domain === 'localhost' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.tls.email))) out.push("Let's Encrypt needs a public domain and an e-mail address for the account");
  if (!Number.isInteger(a.port) || a.port < 1024 || a.port > 65535) out.push('the server port is 1024 to 65535');
  if (a.postgres.mode === 'LOCAL' && (!/^[a-z][a-z0-9_]{0,30}$/.test(a.postgres.cluster) || !Number.isInteger(a.postgres.port) || a.postgres.port < 1024 || a.postgres.port > 65535)) {
    out.push('the local cluster has a name of lowercase letters, digits and underscores and a port of 1024 to 65535');
  }
  if (a.postgres.mode === 'EXISTING' && !/^postgres(ql)?:\/\//.test(a.postgres.adminUrl)) out.push('the PostgreSQL connection is a postgres:// URL of a superuser');
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(a.name)) out.push('the service name is 2 to 41 lowercase letters, digits or hyphens');
  if (!Number.isInteger(a.tokenMinutes) || a.tokenMinutes < 5 || a.tokenMinutes > 10080) out.push('the set-up token is valid for 5 minutes to 7 days');
  return out;
}

/** The browsers' origin. */
export function publicOrigin(a: Answers): string {
  return a.tls.mode === 'NONE' ? `http://localhost:${String(a.port)}` : `https://${a.domain}`;
}

/** The answers as kept for a later run (no secret: the superuser connection of an existing server is asked again). */
export function storable(a: Answers): Answers {
  return a.postgres.mode === 'EXISTING' ? { ...a, postgres: { mode: 'EXISTING', adminUrl: '' } } : a;
}
