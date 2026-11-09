# Edition namespaces

Each directory here holds the SQL of one edition that runs in the same database after the core (kernel, site services,
recipe-core) and the server's own migrations. Test set-ups, the validation ledger and the SQL mutation harness take them
from `EDITION_NAMESPACES` in `packages/test-kit/src/db.ts`, in this fixed order:

| Namespace | Edition | Migration numbers | Since |
|---|---|---|---|
| `substance` | API (Batchwright Substance) | 5000–5999 | API plan A0 |
| `injectables` | Injectables (Batchwright Injectables) | 3000–3999 (reserved by the lead, 9 November 2026) | I-1c2 |

- A new edition namespace is added at the end of the list, so a fresh database and an upgraded one apply the
  namespaces in the same order. A directory here that the list does not name, or a listed one that is missing, fails
  every set-up loudly.
- Migrations are numbered within the namespace's own range, cleared with the lead. An applied migration is checksummed
  and never edited: a change is a new migration.
