/**
 * The files the installer writes (pure: the tests read them in a dry run): the server's environment file, the systemd
 * units or the docker compose file, and the reverse proxy's Caddyfile (TLS: Caddy's own ACME client for Let's Encrypt,
 * or the site's certificate). Secrets are passed in; a dry run passes placeholders.
 */
import { join } from 'node:path';
import { publicOrigin, type Answers } from './answers.ts';

export interface Secrets {
  /** Passwords of the login roles (ebmr_app, ebmr_authn, ...), by role. */
  roles: Readonly<Record<string, string>>;
  /** The superuser connection a demo or sandbox server keeps for its demo data and resets (EBMR_PG_ADMIN_URL). */
  adminUrl: string | null;
}

/** The login roles of an installation and their variable, by kind (kernel 0001, 0100, 0800, 0980, 1240). */
/**
 * The sandbox admits no login role but its own (kernel 0800, INV-18), so a sandbox's backups read through the
 * superuser connection the server keeps there (EBMR_PG_ADMIN_URL); a GMP installation's through ebmr_backup, a login
 * role the installer creates with pg_read_all_data and BYPASSRLS and nothing else.
 */
export function loginRoles(a: Answers): { role: string; variable: string }[] {
  return a.installation === 'GMP'
    ? [
        { role: 'ebmr_app', variable: 'EBMR_DB_APP_URL' },
        { role: 'ebmr_authn', variable: 'EBMR_DB_AUTHN_URL' },
        { role: 'ebmr_listener', variable: 'EBMR_DB_LISTENER_URL' },
        { role: 'ebmr_analytics', variable: 'EBMR_DB_ANALYTICS_URL' },
        { role: 'ebmr_backup', variable: 'EBMR_BACKUP_SOURCE_URL' },
      ]
    : [
        { role: 'ebmr_sandbox', variable: 'EBMR_DB_APP_URL' },
        { role: 'ebmr_sandbox', variable: 'EBMR_DB_AUTHN_URL' },
        { role: 'ebmr_sandbox_listener', variable: 'EBMR_DB_LISTENER_URL' },
      ];
}

export function pgHostPort(a: Answers): { host: string; port: number } {
  if (a.postgres.mode === 'LOCAL') return { host: 'localhost', port: a.postgres.port };
  const u = new URL(a.postgres.adminUrl);
  return { host: u.hostname, port: u.port === '' ? 5432 : Number(u.port) };
}

export const keysDirOf = (a: Answers): string => join(a.dataDir, 'keys');
const prefixOf = (a: Answers): string => (a.installation === 'GMP' ? 'gmp' : 'sandbox');

/** The server's environment file (EBMR_* variables, apps/tablets-server/src/config.ts). */
export function envFile(a: Answers, s: Secrets): string {
  const { host, port } = pgHostPort(a);
  const url = (role: string): string => `postgres://${role}:${encodeURIComponent(s.roles[role] ?? '')}@${host}:${String(port)}/${a.database}`;
  const keys = keysDirOf(a);
  const prefix = prefixOf(a);
  const production = !a.demo;
  // In the compose file the checkout is mounted at /app.
  const root = a.service === 'COMPOSE' ? '/app' : a.installDir;
  const lines: [string, string][] = [
    ['EBMR_INSTALLATION', a.installation],
    ['EBMR_ENV', production ? 'production' : 'development'],
    ['EBMR_DATABASE', a.database],
    ['EBMR_PG_HOST', host],
    ['EBMR_PG_PORT', String(port)],
    ...loginRoles(a).map(({ role, variable }): [string, string] => [variable, url(role)]),
    ['EBMR_PUBLIC_ORIGIN', publicOrigin(a)],
    ['EBMR_HOST', '127.0.0.1'],
    ['EBMR_PORT', String(a.port)],
    ['EBMR_WEB_DIST', join(root, 'apps/tablets-web/dist')],
    ['EBMR_SECRETS_FILE', join(keys, `${prefix}-secrets.json`)],
    ['EBMR_SEAL_KEY_FILE', join(keys, `${prefix}-seal-key.json`)],
    ['EBMR_SERVICE_KEYS_FILE', join(keys, `${prefix}-service-keys.json`)],
    ['EBMR_EXCHANGE_DIR', join(a.dataDir, 'exchange')],
    ['EBMR_NUMBER_LEDGER_FILE', join(a.dataDir, 'numbers.ledger.jsonl')],
    ['EBMR_BACKUP_DIR', join(a.dataDir, 'backups')],
    ['EBMR_BACKUP_KEY_FILE', join(keys, `${prefix}-backup-key`)],
    ['EBMR_BACKUP_KEY_REF', `file:${join(keys, `${prefix}-backup-key`)}`],
    ['EBMR_KEYS_DIR', keys],
    ['EBMR_LOG_LEVEL', 'info'],
  ];
  if (a.demo) {
    lines.push(['EBMR_DEMO', '1'], ['EBMR_DEMO_KEYS_FILE', join(keys, `${prefix}-demo-devices.json`)]);
  }
  // The demo conveniences recreate the database (demo and sandbox installations only; refused for production GMP).
  if (s.adminUrl && (a.demo || a.installation === 'SANDBOX')) lines.push(['EBMR_PG_ADMIN_URL', s.adminUrl]);
  return `# Batchwright Tablets server ${a.name}: written by the installer (tools/install). Secrets: keep this file 0600.\n${lines.map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

/** The reverse proxy's configuration (TLS); null without TLS (the server answers on localhost only). */
export function caddyfile(a: Answers): string | null {
  if (a.tls.mode === 'NONE') return null;
  const site = a.tls.mode === 'PROVIDED' ? `${a.domain} {\n  tls ${a.tls.certFile} ${a.tls.keyFile}\n  reverse_proxy 127.0.0.1:${String(a.port)}\n}\n` : `${a.domain} {\n  reverse_proxy 127.0.0.1:${String(a.port)}\n}\n`;
  const global = a.tls.mode === 'LETSENCRYPT' ? `{\n  email ${a.tls.email}\n}\n\n` : '';
  return `# Batchwright Tablets ${a.name}: TLS in front of the server (written by the installer).\n${global}${site}`;
}

/** The systemd units: the server, and the proxy when there is TLS. */
export function systemdUnits(a: Answers, nodeBin: string): { file: string; content: string }[] {
  const server = `[Unit]
Description=Batchwright Tablets server ${a.name} (${a.installation}${a.demo ? ', demo' : ''})
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=ebmr
Group=ebmr
WorkingDirectory=${a.installDir}
EnvironmentFile=${join(a.configDir, 'server.env')}
ExecStart=${nodeBin} --import tsx apps/tablets-server/src/main.ts
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${a.dataDir}

[Install]
WantedBy=multi-user.target
`;
  const units = [{ file: `/etc/systemd/system/${a.name}.service`, content: server }];
  const caddy = caddyfile(a);
  if (caddy) {
    units.push({
      file: `/etc/systemd/system/${a.name}-proxy.service`,
      content: `[Unit]
Description=Batchwright Tablets ${a.name}: TLS proxy (Caddy)
After=network-online.target ${a.name}.service
Wants=network-online.target

[Service]
Type=simple
User=ebmr
Group=ebmr
Environment=XDG_DATA_HOME=${join(a.dataDir, 'caddy')}
ExecStart=/usr/bin/caddy run --config ${join(a.configDir, 'Caddyfile')} --adapter caddyfile
Restart=on-failure
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
`,
    });
  }
  return units;
}

/** The docker compose file (the server from the checkout in node 22, and the proxy). */
export function composeFile(a: Answers): string {
  const caddy = caddyfile(a);
  const certs = a.tls.mode === 'PROVIDED' ? [`      - ${a.tls.certFile}:${a.tls.certFile}:ro`, `      - ${a.tls.keyFile}:${a.tls.keyFile}:ro`] : [];
  const proxy = caddy
    ? `  proxy:
    image: caddy:2.8.4
    network_mode: host
    restart: unless-stopped
    volumes:
      - ${join(a.configDir, 'Caddyfile')}:/etc/caddy/Caddyfile:ro
      - ${join(a.dataDir, 'caddy')}:/data
${certs.join('\n')}${certs.length ? '\n' : ''}`
    : '';
  return `# Batchwright Tablets ${a.name}: written by the installer (tools/install).
name: ${a.name}
services:
  server:
    image: node:22.12.0-bookworm
    working_dir: /app
    command: ["node", "--import", "tsx", "apps/tablets-server/src/main.ts"]
    env_file: ["${join(a.configDir, 'server.env')}"]
    network_mode: host
    restart: unless-stopped
    volumes:
      - ${a.installDir}:/app:ro
      - ${a.dataDir}:${a.dataDir}
${proxy}`;
}
