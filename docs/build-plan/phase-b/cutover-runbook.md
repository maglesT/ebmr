# Cutover runbook: the live Batchwright onto the Medhanta platform (Phase B slice 7)

Written, not run. All products go live together: the lead's joint go-live plan decides the day and when the names
open. This runbook mirrors MMS's `docs/07-cutover-runbook.md` (at 1166c43). The commands are databsee's (main, checked
by the lead on 4 November 2026).

| | |
|---|---|
| Domain | `187-126-126-5.sslip.io`, `proxy: external` (the host's Caddy keeps ports 80 and 443) |
| Batchwright | `https://ebmr.187-126-126-5.sslip.io`, the `ebmr` service on `127.0.0.1:8109` |
| Core | the bare domain, **at the joint go-live only**. Until then the standalone demo keeps the bare domain, untouched. |
| Move tool | `ebmr move` in the ebmr image (`tools/platform`, slice 6; `move-record.md`) |
| Platform databases | `ebmr`, `identity`, `master_data` on the platform's `db` service |

Shorthands used below:

```sh
# Both files are needed with proxy: external, as apply's composeFiles() does. The project name is fixed: medhanta.
alias plat='docker compose -f /opt/medhanta/current/deploy/compose.yml -f /opt/medhanta/current/deploy/compose.external.yml'
# A manual run needs the pinned image, else the image tag is "none" (MMS lesson).
export EBMR_COMMIT=$(jq -r .source.commit /opt/medhanta/current/apps/ebmr/manifest.json)
SU=<platform superuser>   # the db service's superuser
# The move's two connections, as superuser on the db service (set them in the shell, never in a file):
# SOURCE_URL=<URL of ebmr_move_source on db:5432>  PLATFORM_URL=<URL of database postgres on db:5432>
```

## Before the day

1. **Merged and pinned.** Phase B slices 1–6 are on Batchwright's main. databsee pins that commit in
   `apps/ebmr/manifest.json`, and the signed bundle is built (`.github/workflows/apply.yml`).
2. **Customer file.** `customers/<name>.yaml` has:
   - `domain: 187-126-126-5.sslip.io` and `proxy: external`;
   - the ebmr link line ready, but not yet switched on: `ebmr: { master_data: [equipment_v1, instrument_v1, room_v1, material_v1, product_v1] }`;
   - the ebmr licence, also not yet on.
3. **Core is ready.**
   - The people who sign off and the mover (`--by`) exist in core.
   - The person who will hold `ebmr.system.configure` (the first Batchwright administrator on the platform) holds no
     GMP code (INV-11).
   - The demo company's master data and its `ebmr.*` grants (slice 5, `demo-grants.md`) are in place.
4. **Rehearsed.** A dry run of the whole day on a copy has passed:
   - restore the standalone dump into a scratch platform;
   - run steps 3–7 below, without step 9;
   - keep the move's report with this runbook.
5. **People to link.** Every standalone login that is already a core person is listed for `--link` and confirmed by the
   site (same person). The dry run refuses any other login core already has.
6. **Keys.** The standalone installation's keys directory is at hand, with the seal key and the gateway's service keys.
   Signatures show and verify only with the same seal key.

## On the day

1. **Freeze.** Announce the freeze. Stop the standalone Batchwright server (its own service on the host). Nobody
   records, signs or administers anything in Batchwright or core until sign-off.
2. **Check, then back up the frozen data.** On the host's PostgreSQL:
   ```sh
   pg_dump --format=custom --file /backups/standalone-ebmr-$(date +%F).dump ebmr_tablets_demo
   sha256sum /backups/standalone-ebmr-*.dump
   ```
   Keep the dump and its sum with the move's records. This is also the fallback for the old app.
3. **Restore the dump into a scratch database** on the platform's server, for the move to read:
   ```sh
   plat exec -T db createdb -U $SU ebmr_move_source
   plat exec -T db psql -U $SU -d ebmr_move_source -c 'revoke all on database ebmr_move_source from public'
   plat exec -T db pg_restore -U $SU --no-owner --no-privileges -d ebmr_move_source < /backups/standalone-ebmr-<date>.dump
   ```
4. **Licence on.**
   - In `customers/<name>.yaml`, switch on the ebmr licence and its `links:` (master_data). Add a change_ref and a
     reason, commit, and let `apply.yml` apply the signed bundle. By hand on the server:
     `/opt/medhanta/current/deploy/apply.sh <bundle>.tar` (signature next to it).
   - Apply runs `ebmr migrate` (as superuser), then permissions, logins, links, start and health. It re-applies the
     previous config if anything fails.
   - Then stop ebmr again (`plat stop ebmr`) and check that its database is empty: the move checks this itself and
     refuses otherwise. Nobody opens `ebmr.<domain>` yet; the host Caddy block is not added until step 9.
5. **Snapshot the platform databases.** The rollback restores these:
   ```sh
   for db in ebmr identity master_data; do
     plat exec -T db pg_dump -U $SU --format=custom $db > /backups/pre-ebmr-move-$db.dump && sha256sum /backups/pre-ebmr-move-$db.dump
   done
   ```
   From here to sign-off: **no other move and no core administration.**
6. **Copy the keys.** Copy the standalone seal key file into the ebmr keys volume, so moved signatures keep showing and
   verifying. Copy the gateway's service keys file too, if the site gateway is used. Both go to `/var/lib/ebmr/keys`;
   the volume belongs to the node user, mode 0600.
   - The compose service must point `EBMR_SEAL_KEY_FILE` at that file.
   - **To confirm with the lead:** the variable is in the ebmr compose service or `ebmr.env`.
7. **Dry run, then the move.** Both run with the pinned image and `--no-deps`:
   ```sh
   plat run --name ebmr-move --no-deps \
     -e SOURCE_DATABASE_URL="$SOURCE_URL" -e PLATFORM_DATABASE_URL="$PLATFORM_URL" \
     ebmr move --by <core login> --verified-by "<name>" --verified-how "<how>" \
       --link <login,login> --code-map tools/platform/demo-code-map.json --report-dir /tmp/move
   docker cp ebmr-move:/tmp/move ./ebmr-move-dry && docker rm ebmr-move
   ```
   - Read the dry run's `platform-move.json`. It must say `PASS`, with no refused person or item. The people, their
     codes, notes and the items must be what the site expects.
   - Then run the same command with `--commit`, and copy its report out the same way.
   - On `FAIL` with stage `NOT_COMMITTED`, nothing was written: fix the cause and run again.
   - On any other stage (`EBMR_COMMITTED`, `EBMR_REPLACED`, `MASTER_DATA_COMMITTED`), it is a partial move: **go to
     Rollback**.
   - `--code-map` is for the demo only. A real site's master items are linked by code, or created as moved items.
8. **Check on the platform.**
   - Apply once more (`apply.sh`), so the moved `ebmr` database gets the platform's database set-up again: links and
     their grants, logins, the migrator's idempotent run and keys. Then start ebmr.
   - Check that the health is green.
   - A moved person signs in at `ebmr.<domain>`, which is reachable on the server only, through a hosts entry or a
     temporary host block. Their records open, signatures show, and work mode and codes are as in the report.
   - The first administrator (the `ebmr.system.configure` holder) opens the administration screens.
   - Deviations and Operations read the published views through their links.
   - Each new person's password is set in core (the report lists them; the credential is "reset in core").
9. **Records of the move.** File with the change record:
   - the move's reports (dry run and commit);
   - the upgrade drill's record from the report directory;
   - the dumps' SHA-256 sums;
   - the checks of step 8.

   The report also lists the signatures `esig.verify_signatures()` flagged in the source and carried over (issue #95).
10. **Owner go/no-go.** The owner (and the QA head) sign off on the records, or call Rollback.
11. **Switch**, at the joint go-live, when the lead's plan says so:
    - Copy the `ebmr.<domain>` block, and core's block for the bare domain, from `/var/lib/medhanta/state/Caddyfile.host`
      into the host Caddyfile. Do not `import` it: the state folder is root-only.
    - Remove the standalone demo's host block for the bare domain.
    - Run `caddy reload` on the host.

    ```
    187-126-126-5.sslip.io {
      reverse_proxy 127.0.0.1:<core port>
    }
    ebmr.187-126-126-5.sslip.io {
      reverse_proxy 127.0.0.1:8109
    }
    ```

## Rollback

In this order (owner fix: the same order everywhere). **No other move and no core administration between the snapshot
and the rollback.**

1. Stop ebmr and core: `plat stop ebmr core`.
2. Restore the three snapshots of step 5:
   ```sh
   for db in ebmr identity master_data; do
     plat exec -T db dropdb -U $SU --force $db
     plat exec -T db pg_restore -U $SU --create -d postgres < /backups/pre-ebmr-move-$db.dump
   done
   ```
3. Start core: `plat start core`.
4. Licence off: in `customers/<name>.yaml`, switch the ebmr licence and its links off, commit, and apply. If the host
   Caddy already has the ebmr block, comment it out and run `caddy reload`.
5. Old app: start the standalone Batchwright server on the host again. Its database was never changed (step 2's dump
   is the fallback). Lift the freeze there.

## After sign-off

- Drop the scratch source database: `plat exec -T db dropdb -U $SU ebmr_move_source`.
- Keep the dumps for the retention period the change record names. Then delete them, with the seal key copy kept
  wherever keys are kept.
- The standalone demo stays stopped. Its host block for the bare domain was removed at the switch.
- Branch `standalone` (0bb289c) stays the frozen fallback until the owner retires it.

## A fresh platform installation (no standalone to move)

This is the platform first-run set-up left open in slice 2. On the platform build the set-up screen's first
administrator and process owner would be local accounts, which the platform build has switched off. Until that screen is
adapted, a fresh site comes up through the move, with no new code:

1. Set up a scratch standalone installation with the site's code, name and time zone, and generate its seal key
   (`apps/tablets-server/src/cli/setup.ts`, no demo switches). It holds only the bootstrap administrator and process
   owner.
2. Move it as on the day, steps 3–9. The two bootstrap people become core people; `--link` them when core has them.
   Their codes come from core, and the `ebmr.system.configure` holder is the first administrator.
