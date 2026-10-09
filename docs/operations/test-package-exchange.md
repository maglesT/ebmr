# Test-package exchange: when an export does not reach the sandbox inbox

- **Status:** Phase 2 (module C2, decision D5). Administrator procedure for the refusals below; the owner may replace
  the manual steps with a recorded function later (see the last section).
- **Controls:** DI-05 (the GMP and sandbox installations stay apart; a recorded export and its file stay together),
  DI-04 (the file is exactly the recorded package).
- **Code:** `apps/tablets-server/src/features/designer/index.ts` (testPackage),
  `apps/tablets-server/src/features/designer/package-export.ts`. **Tests:**
  `apps/tablets-server/test/designer/package-publish.test.ts`.

## 1. How an export reaches the inbox

1. The export command writes the package to `<exchange>/to-sandbox/.staging/<packageHash>.<uuid>.tmp` (created
   exclusively, fsynced) and proves that the inbox takes a hard link of it.
2. It records the export (`tab.mbr_test_package_export`, with the entry "Test package ... exported for a sandbox test
   run" on the version's audit chain) and commits.
3. After the commit the staged file is hard-linked to `<exchange>/to-sandbox/<packageHash>.json`. That name is
   write-once: the server never replaces or removes a file under it.

Before an export is recorded, the command first publishes the staged packages of earlier recorded exports. While one
of them cannot be published, no new export is recorded. One export at a time passes this gate (a database advisory
lock taken by the export command), so a burst of exports cannot slip past it together.

A file is linked to a package's inbox name only after its text was checked to be exactly the recorded package (the
package hash is recomputed), and a file already under that name counts as published only when it holds that
package. Anything else is reported and left as it is.

## 2. What the author sees

| Answer | Meaning | Who acts |
|---|---|---|
| `TEST_PACKAGE_INBOX_UNAVAILABLE` (503) | Nothing was recorded: the inbox takes no hard link (a share without hard links, no permission, no space). | Administrator: fix the exchange directory (section 3, case A). |
| `TEST_PACKAGE_NOT_PUBLISHED` (503) | The export **is recorded**; its file is not in the inbox yet. | Author: send again from the same dialog. If that keeps failing, the next export shows `TEST_PACKAGE_INBOX_BEHIND`. |
| `TEST_PACKAGE_INBOX_BEHIND` (503) | Nothing was recorded: an earlier recorded export is still not in the inbox and could not be placed there now. **No test package can be exported on the installation until it is resolved.** | Administrator: section 3. |

The refusal's `why`, and the server log line "designer: recorded test packages that could not be published", list
each problem as `<staged file name>: <problem>`. The first 64 characters of the staged file name are the package
hash.

## 3. Recovery for `TEST_PACKAGE_INBOX_BEHIND`

Find the problem text for each staged file, then follow the matching case. Never edit a file in `to-sandbox/` or
`.staging/`, and never write a file into `to-sandbox/` by hand.

**A. A link error** (`EPERM`, `EACCES`, `ENOSPC`, `EXDEV`, `EIO`, ...). The exchange directory is at fault. Fix it:
the server's service account needs write access to `to-sandbox/` and `.staging/`, both must be on one file system
that supports hard links, and it needs free space. Then any of these publishes the package: the next export, the
author's resend from the same dialog, or a server restart (the server publishes pending packages at start-up). No
deviation is needed for a passing fault.

**B. "the staged file is not the recorded package ... (changed on disk)".** The staged copy of a recorded export was
changed outside the system. The server never publishes it.

1. Open a deviation: a GMP export file was changed outside the system. Copy the changed file into the deviation's
   evidence store before anything else happens to it.
2. If the author who exported it can still send it again from the same, still open dialog (the same idempotency key),
   that resend publishes the recorded package from the text its command stored, and the server removes the changed
   staged copy (its log names the path). Go to step 4.
3. Otherwise, move the changed file out of the exchange directory into the evidence store. The recorded export then
   stays on the version's audit trail without a file in the inbox; record that in the deviation. The author exports
   the version again, which is a new, separately recorded export. The recorded package never reached the inbox, so
   no sandbox test run used it.
4. Check (section 4).

**C. "the inbox file `<hash>.json` is not the recorded package ...".** The package's write-once inbox name holds
something else.

1. Open a deviation: a file that the GMP server did not publish is in the sandbox inbox under a recorded package's
   name. The sandbox importer recomputes both hashes and refuses such a file, so it was not test-run; confirm this on
   the sandbox's test packages list.
2. Move the file out of `to-sandbox/` into the deviation's evidence store.
3. The next export, the author's resend from the same dialog, or a server restart then publishes the staged package
   under its name. Check (section 4).

**D. "the staged file disappeared before its package was published".** A staged copy was removed while it was
waiting to be published. If section 4 shows its export recorded without a file, handle it as case B, step 3.

## 4. Checking that every recorded export has its file

With read access to the GMP database:

```sql
select package_hash, file_name, exported_at from tab.mbr_test_package_export order by exported_at desc;
```

Each `file_name` must be in `to-sandbox/`, and the sandbox's test packages list must show it without problems (it
recomputes the hashes). An export listed here without its file needs case B, step 3.

A staged file whose package hash has **no** row in this table belongs to an export command that did not commit (for
example one whose connection dropped while it committed; the server keeps such a file rather than risk deleting the
only copy of a recorded package). It is never published and never blocks an export. Once the query shows that no
export with its hash is recorded, and no export is running, move it out of `.staging/`.

## 5. Open for the owner

The database records an export, but not that its file reached the inbox. A "published" record written after the link
(a new table and an entry on the version's audit chain) would make an export without a file visible on the audit
trail, and would let a recorded function replace the manual steps of section 3. That is a design decision for the
owner.
