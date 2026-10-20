# The hosted demo (DEMO-ONLY)

The Batchwright Tablets demo on a server the owner provides (decisions 0021 and 0025). It runs the demo stack of
`tools/demo` (`pnpm demo:setup`, `pnpm demo`) behind Caddy, which terminates HTTPS with Let's Encrypt. Everything in it
is DEMO-ONLY: keys, personas, passwords and data. It is for showing the product, never for GMP records.

## The installation of 19 October 2026

| Item | Value |
|---|---|
| Server | Hostinger VPS KVM 8 (8 vCPU, 32 GB, 400 GB NVMe), India, Ubuntu 24.04 LTS, IP 187.126.126.5 |
| GMP installation | https://187-126-126-5.sslip.io |
| Sandbox (TEST, NOT GMP) | https://sandbox.187-126-126-5.sslip.io |
| Code | the `deploy/demo-server` branch (v1.0.0-rc.1 plus the demo's public origins), in `/opt/batchwright`, owned by the user `batchwright` |
| Service | `batchwright-demo.service` (systemd, restarts on failure, starts at boot); Caddy (`/etc/caddy/Caddyfile`) |
| Database | PostgreSQL 16 on loopback only; the admin role's random password in `/etc/batchwright/demo.env` (mode 600) |
| Firewall | ufw: 22, 80 and 443 only; unattended security upgrades on |

The names use sslip.io (a host name that resolves to the IP inside it), so HTTPS works without a domain. With a domain,
point its A record (and `sandbox.` under it) at the IP, replace the two host names in the Caddyfile and in the service's
`EBMR_DEMO_GMP_ORIGIN` and `EBMR_DEMO_SANDBOX_ORIGIN`, then `systemctl daemon-reload && systemctl restart
batchwright-demo && systemctl reload caddy`.

## Building it again

As root on a fresh Ubuntu 24.04 server with the deploy key in `~/.ssh/authorized_keys`:

1. Packages: `apt-get install -y ufw unattended-upgrades postgresql-16 git curl gnupg`; Node 22 from NodeSource;
   Caddy from its official repository; `corepack enable` (pnpm comes from `packageManager` in package.json).
2. Firewall: `ufw default deny incoming; ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp; ufw --force enable`.
3. Database: a superuser login role `ebmr_dev` with a random password, written as
   `EBMR_PG_ADMIN_URL=postgres://ebmr_dev:<password>@localhost:5432/postgres` into `/etc/batchwright/demo.env` (600).
4. Code: `useradd -m batchwright`; from a checkout, `git archive --format=tar <ref> | ssh root@<ip> 'runuser -u
   batchwright -- tar -x -C /opt/batchwright'`; then as `batchwright`: `pnpm install --frozen-lockfile`.
5. Demo data: as `batchwright`, with the environment file loaded and `TZ=UTC`: `pnpm demo:setup --with-gmp-samples`
   (about 11 minutes). The flag also loads GMP's DEMO-ONLY sample records: an approved master, a batch record ready for
   review, the release path (a lot ready for release and one not ready) and the packaging-order demo. Without it the
   set-up takes a minute or two and GMP has no approved master, batch or lot.
6. The Caddyfile (two sites, `reverse_proxy 127.0.0.1:3001` for GMP and `127.0.0.1:3011` for the sandbox) and the unit
   `batchwright-demo.service` (`User=batchwright`, `WorkingDirectory=/opt/batchwright`, `EnvironmentFile` the file
   above, `Environment=TZ=UTC`, the two `EBMR_DEMO_*_ORIGIN` variables, `ExecStart=/usr/bin/pnpm demo`,
   `Restart=on-failure`); `systemctl enable --now batchwright-demo; systemctl reload caddy`.
7. Check: `curl https://<gmp host>/api/meta` answers with `"demo":true` and the https public origin; sign in through
   the demo terminal picker in a browser.

The credential card (the DEMO-ONLY personas, the administrator `demo.admin` and the process owner `demo.owner`, with
their passwords; those two passwords are new at each set-up) is printed by the service at start:
`journalctl -u batchwright-demo | sed -n '/DEMO-ONLY credentials/,$p'`.

## Operating it

- Status and logs: `systemctl status batchwright-demo`, `journalctl -u batchwright-demo -f`.
- Reset the demo to its first state: `systemctl stop batchwright-demo`, then as `batchwright` `pnpm demo:setup
  --with-gmp-samples` (it recreates both databases; about 11 minutes with the samples), then `systemctl start
  batchwright-demo`. The reset script `/usr/local/bin/batchwright-demo-reset` does these three steps.
- After a reset, every browser that used the demo clears its site data for both host names (the installed demo
  terminal's key and the session belong to the old databases, so the server no longer knows them), then picks a demo
  terminal again. In Chrome or Edge: the padlock, Site settings, Delete data; in Firefox: the padlock, Clear cookies and
  site data.
- New code: copy the new tree as in step 4, `pnpm install --frozen-lockfile`, reset as above.

## Known gaps

Deferred to deployment (decision D-P7R-17):

- E3: GMP has no simulated balance or gateway; the scale simulator and the gateway serve the sandbox only. Every GMP
  weighing on the demo is the manual two-person path.
- E4: the scale simulator's console listens on 127.0.0.1:4002 only; presenters reach it through an SSH tunnel
  (`ssh -L 4002:127.0.0.1:4002 root@<ip>`, then http://localhost:4002).
- E6: behind the proxy every request comes from 127.0.0.1, so the server's per-address rate limits are shared by all
  visitors (the per-identifier limits still apply); the trusted-proxy setting of decision 0021 stays optional.
