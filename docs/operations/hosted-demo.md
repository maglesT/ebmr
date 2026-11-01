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
| Code | a git checkout of `main` in `/opt/batchwright`, owned by the user `batchwright`, fetched with a read-only deploy key (`/home/batchwright/.ssh/github_deploy`); since 25 October 2026 at 9fc3c5ae (slice 7s). Until then the `deploy/demo-server` branch (v1.0.0-rc.1 plus the demo's public origins, which main also has); that tree is kept in `/opt/batchwright.rc1-backup` |
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
   (15 to 25 minutes since slice 7s). The flag also loads GMP's DEMO-ONLY sample records: an approved master, a batch
   record ready for review, the release path (a lot ready for release and one not ready), the packaging-order demo, the
   demo routes W, D and S, the beta-lactam suite (7n), the sustained-release product (7p) and the rabeprazole demo (7s). Without it the
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
The same card is on the GMP and sandbox sites themselves: Operations, "Credential card (DEMO-ONLY)" (slice 7k, R3.13;
a demo installation only, every other installation refuses it).

Slice 7k (requirements R3.12 and R5 of the hosted-demo trials):
- `pnpm demo` stops the whole stack and exits non-zero when a server, the gateway or a simulator dies, so
  `Restart=on-failure` brings the site back; the servers themselves survive a PostgreSQL restart (a lost connection is
  logged and replaced).
- Production orders: the samples leave two GB-T-02 processing and two bottle orders open besides the ones they use, and
  GB-T-02 has second lots for four more batches. More orders: Operations, Simulators, "Send a production order" (one
  order of a demo product as the ERP interface, a new number each time). It replaces `/home/batchwright/post-demo-order.mjs`,
  which can be removed. A reset (with the samples) leaves exactly the seeded orders and lots.

## The beta-lactam suite (slice 7n, R7)

`--with-gmp-samples` also builds demo route B, a beta-lactam product in its dedicated suite
(`apps/tablets-server/src/cli/demo-route-beta-lactam.ts`; the demo part is
[Making an antibiotic safely](../guides/user-guide/10-antibiotic-dedicated-suite.md)):

| Item | Value |
|---|---|
| Product | `CXC-325` Cefexemplone proxetil and clavexemplate potassium tablets 325 mg (invented), film coated, direct compression, alu-alu cold form with a desiccant laminate |
| Site rule | SITE-1 a penicillin facility (proposed by the steward, approved by QA) |
| Rooms and line | `BL-DISP`, `BL-BLEND`, `BL-COMP`, `BL-COAT`, line `BL-PL`; each dedicated to beta-lactam products with a second QA person's approval; the suite's humidity limit 30 % RH (dispensing G-11, coating TB-18) |
| Kiosks | `KIOSK-BL-DISP`, `KIOSK-BL-BLEND`, `KIOSK-BL-COMP`, `KIOSK-BL-COAT`, `KIOSK-BL-PACK` |
| Units | balances `BAL-BLD-01`, `BAL-BLB-01`, `BAL-BLC-01`, `BAL-BLT-01`, `BAL-BLP-01`; `BLD-BL-01`, `PRESS-BL-01` (tooling `TS-RTB-01`), `COATER-BL-01`, `CFORM-BL-01`, `CTN-BL-01` |
| Orders and lots | `PO-RTB-0001` to `0003` (processing), `PO-RTBPK-0001` to `0004` (packaging); lots `RTB-*` |
| Not seeded | the product's beta-lactam classification: the steward proposes it and QA approves it on **Plant rules** during the demo |

## The rabeprazole demo (slice 7s, R8 P3)

`--with-gmp-samples` also loads P3 ready for a presenter (`apps/tablets-server/src/cli/demo-p3.ts`, set-up option
`--gmp-p3-demo`; the presenter's script is [rabeprazole-demo-script.md](rabeprazole-demo-script.md), the same path as
the `p3-demo` browser test):

| Item | Value |
|---|---|
| Product | `RAB-GR-20` Rabeprazole sodium 20 mg gastro-resistant tablets (invented data), licence DEMO/MH/25/0703 |
| Masters | processing `RAB-WG-DEMO` (wet granulation; seal, enteric and top coats), packaging `RAB-CF-DEMO` (cold form); both approved and authorised for IN |
| Specification | the product's assay and the two-stage dissolution as one profile test (acid at most 10 % at 2 h, buffer at least 75 % at 45 min) |
| Lots | `RAB-API-0001` (with its assay), `RAB-FOIL-0001`, `RAB-CTN-0001` (with artwork); excipients from the route W lots |
| Numbering and tooling | `RAB{YY}{SEQ:3}` and `{PARENT}/P{SEQ:2}`; tooling set `TS-RAB-DEMO` |
| Not seeded | the orders: the presenter sends them from Operations, Simulators |

## Operating it

- Status and logs: `systemctl status batchwright-demo`, `journalctl -u batchwright-demo -f`.
- Reset the demo to its first state: `systemctl stop batchwright-demo`, then as `batchwright` `pnpm demo:setup
  --with-gmp-samples` (it recreates both databases; 15 to 25 minutes with the samples), then `systemctl start
  batchwright-demo`. The reset script `/usr/local/bin/batchwright-demo-reset` does these three steps (as root; it loads
  the environment file, which only root can read).
- After a reset, every browser that used the demo clears its site data for both host names (the installed demo
  terminal's key and the session belong to the old databases, so the server no longer knows them), then picks a demo
  terminal again. In Chrome or Edge: the padlock, Site settings, Delete data; in Firefox: the padlock, Clear cookies and
  site data.
- New code (since 25 October 2026): `/usr/local/bin/batchwright-demo-update` as root. It stops the service, fetches
  `main` as `batchwright` (`git fetch --depth 50 origin main && git reset --hard origin/main`), runs
  `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile`, runs the reset script and prints the deployed
  commit; it stops at the first failing command (`set -e`). Every update resets the demo data.

## The gateway's journals (1 November 2026)

The site gateway journals every reading it forwards under `var/demo/gateway-journal/`. The demo's device simulator sends
about 20 process readings a second even when idle (about 400 MB a day), and on 1 November the process journal had passed
2 GiB (12.5 million lines). Before the fix that followed, the gateway read each journal whole at start, and Node refuses
one read past 2 GiB, so the gateway no longer started (`ERR_FS_FILE_TOO_LARGE`, the service restarting in a loop).

- Every journal is now read line by line at start. Nothing is moved aside or trimmed by hand: device sequences must
  continue (the server keeps each gateway device's sequence unique), and the journal refuses to start if its lines do
  not follow on.
- The process journal seals what the server holds. Once every line is delivered and the active
  `process-journal.jsonl` is past 64 MiB, the file is renamed to `process-journal.sealed-<first>-<last>.jsonl`, never
  changed again, and `process-checkpoint.json` records the sealed lines and each device's last sequence. A start reads
  the checkpoint and the active file only.
- **The first start after the fix** reads the old single file once, about a minute for 12.5 million lines on a small
  machine, then seals it. `pnpm demo` waits 45 s for the gateway, then logs "site gateway not ready" and goes on, and
  the gateway comes up when its start ends; the scales and process readings follow then. If the service's unit has a
  start limit (systemd's default is 90 s for units that report readiness), raise it before that start with
  `systemctl edit batchwright-demo`, adding `[Service]` and `TimeoutStartSec=15min`. Later starts take seconds.
- Sealed segments stay on disk (about 400 MB a day of demo readings). Delete them only when the demo data is reset, or
  archive them. `batchwright-demo-update` resets the demo data; to deploy this fix without a reset, run its steps
  without the reset script.

## Known gaps

Deferred to deployment (decision D-P7R-17):

- E3: GMP has no simulated balance or gateway; the scale simulator and the gateway serve the sandbox only. Every GMP
  weighing on the demo is the manual two-person path.
- E4: the scale simulator's console listens on 127.0.0.1:4002 only; presenters reach it through an SSH tunnel
  (`ssh -L 4002:127.0.0.1:4002 root@<ip>`, then http://localhost:4002).
- E6: behind the proxy every request comes from 127.0.0.1, so the server's per-address rate limits are shared by all
  visitors (the per-identifier limits still apply); the trusted-proxy setting of decision 0021 stays optional.
