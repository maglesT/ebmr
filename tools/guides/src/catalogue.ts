/**
 * The permission, role and signature-meaning lists of the guides, read from a database built from the migrations
 * (kernel, site services, recipe-core and the Tablets SQL, as the server builds an edition database), so the lists are
 * what the code grants, not what a page says. `pnpm guides:lists` writes docs/guides/reference/permissions.md;
 * tools/guides/test/guides.test.ts builds the same database and fails when the page is out of date.
 */
import { fileURLToPath } from 'node:url';
import { createTemplateDatabase, dropDatabase, editionMigrationSources, openDatabase } from '../../../packages/test-kit/src/index.ts';
import { GENERATED_NOTE, table } from './md.ts';

export const TABLETS_SQL = fileURLToPath(new URL('../../../apps/tablets-server/sql', import.meta.url));

export interface Permission {
  code: string;
  domain: string;
  effect: string;
  description: string;
}

export interface Role {
  code: string;
  name: string;
  group: string;
  description: string;
  accountKinds: string[];
  permissions: string[];
}

export interface Meaning {
  code: string;
  version: number;
  category: string;
  roleClass: string;
  title: string;
  permissions: string[];
}

export interface Catalogue {
  permissions: Permission[];
  roles: Role[];
  meanings: Meaning[];
}

interface Queryable {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/** The catalogue as the database holds it now (live role permissions; the vendor meanings' current active versions). */
export async function readCatalogue(db: Queryable): Promise<Catalogue> {
  const permissions = (await db.query<Permission>('select code, domain, effect, description from iam.permission order by code collate "C"')).rows;
  const roles = (
    await db.query<Role>(
      `select r.code, r.name, r.role_group as "group", r.description, r.account_kinds as "accountKinds",
              coalesce(array(select p.permission_code from iam.role_permission p where p.role_code = r.code and p.removed_at is null
                             order by p.permission_code collate "C"), '{}') as permissions
         from iam.role r order by r.code collate "C"`,
    )
  ).rows;
  const meanings = (
    await db.query<Meaning>(
      `select * from (select distinct on (m.code) m.code, m.version, m.category, m.role_class as "roleClass", m.title, m.permissions
                        from esig.meaning_type m where m.origin = 'VENDOR' and m.status = 'ACTIVE'
                       order by m.code, m.version desc) v
        order by v.code collate "C"`,
    )
  ).rows;
  return { permissions, roles, meanings };
}

/** Builds an edition database from the migrations, reads its catalogue and drops it. */
export async function catalogueFromMigrations(adminUrl?: string): Promise<Catalogue> {
  const url = adminUrl ?? process.env['EBMR_PG_ADMIN_URL'];
  const name = await createTemplateDatabase(editionMigrationSources([{ namespace: 'tablets', directory: TABLETS_SQL }]), { prefix: 'ebmr_guides', ...(url ? { adminUrl: url } : {}) });
  const db = openDatabase(name, 'GMP', { ...(url ? { adminUrl: url } : {}), max: 1 });
  try {
    return await readCatalogue(db.admin);
  } finally {
    await db.close();
    await dropDatabase(name, url);
  }
}

const DOMAIN_TEXT: Readonly<Record<string, string>> = {
  GMP: 'GMP work: records, signatures and decisions on batches and master data',
  GOVERNANCE: 'Governance of the system: configuration, validation and access reviews',
  ADMINISTRATION: 'Administration: accounts, devices and platform settings (never with a GMP right, INV-11)',
  READ_ONLY: 'Reading only',
};

/** docs/guides/reference/permissions.md. */
export function renderPermissions(c: Catalogue): string {
  const domains = [...new Set(c.permissions.map((p) => p.domain))].sort();
  const holders = (code: string) => c.roles.filter((r) => r.permissions.includes(code)).map((r) => r.code);
  const out = [
    '# Rights, roles and signature meanings',
    '',
    GENERATED_NOTE,
    '',
    'Every right (permission) the system checks, the roles that hold it, and the meaning of each electronic signature it',
    'asks for. The guides name the right and the meaning of each task; this page lists them all as the database grants',
    'them. A person acts through a role granted to their account for a scope (site, product); a role grant needs a',
    'requester and a second person who approves it.',
    '',
    `In all: ${c.permissions.length} rights, ${c.roles.length} roles, ${c.meanings.length} signature meanings.`,
    '',
    '## Rights by domain',
    '',
  ];
  for (const d of domains) {
    out.push(`### ${d}`, '', `${DOMAIN_TEXT[d] ?? d}.`, '');
    out.push(table(['Right', 'Effect', 'What it allows', 'Roles that hold it'], c.permissions.filter((p) => p.domain === d).map((p) => [`\`${p.code}\``, p.effect, p.description, holders(p.code).join(', ') || '(none by default)'])));
    out.push('');
  }
  out.push('## Roles', '');
  out.push(table(['Role', 'Name', 'Group', 'Accounts', 'Rights'], c.roles.map((r) => [`\`${r.code}\``, r.name, r.group, r.accountKinds.join(', '), r.permissions.join(', ') || '(none)'])));
  out.push('', '## Signature meanings', '');
  out.push('Each electronic signature states one of these meanings; the signer must hold one of its rights.', '');
  out.push(table(['Meaning', 'Title', 'Category', 'Signer', 'Rights that may sign it'], c.meanings.map((m) => [`\`${m.code}\``, m.title, m.category, m.roleClass, m.permissions.join(', ') || '(any)'])));
  out.push('');
  return out.join('\n');
}
