/**
 * Phase B slice 6 (docs/build-plan/phase-b/platform-move-plan.md, "Data move"; PL-01, PL-03, PL-07, PL-08, PL-13): the
 * move of a standalone Batchwright onto the MEDHANTA platform, after MMS's db/move-to-platform.ts.
 *
 *  1. Refuses unless the platform's ebmr database is a platform build that holds no records yet (the start-up and
 *     migration rows do not count).
 *  2. The source is dumped (pg_dump: one consistent snapshot; the source is never changed) and restored on the
 *     platform server; every table's rows are counted and hashed on both sides (PL-13).
 *  3. The upgrade drill (tools/drills) copies the restored database, applies the platform's migrations and compares
 *     every table, chain, rendering and spot check; it must PASS. The platform build is then switched on in the copy
 *     (platform-migrate.ts finishPlatformBuild), and esig.verify_signatures() must find nothing.
 *  4. People (human accounts only; service and interface accounts stay local): each gets a core login (the old one in
 *     lower case, u + it when it starts with a digit), an employee and its version 1, a credential that core must reset
 *     (Batchwright's argon2id verifiers cannot become core's scrypt ones; no hash is copied), and the ebmr.* codes of
 *     their live role grants (iam.role_permission, without the codes the manifest leaves out). Deactivated, suspended
 *     or locked people get no codes; a --link person (already in core) keeps their identity and credential, gets the
 *     codes they lack, or loses their ebmr.* codes when they are off in the source. Administration and GMP codes
 *     together: no codes, reported (INV-11). Administrators also get core.people.manage and core.masterdata.edit.
 *  5. Master items (product, room, equipment, instrument, material): each local code is linked in md.item_map to the
 *     master item of the code map's code (--code-map), or of the same code, created as a moved item when core has none.
 *  6. One unit: identity, then master_data, then the ebmr copy are opened in that order; the copy commits first, takes
 *     the place of the platform's empty ebmr database, then master_data commits, then identity. A failure after the
 *     copy committed is rolled back by the runbook (restore of the three databases' snapshots).
 *
 * Without --commit nothing is written to identity, master_data or ebmr: the work databases are dropped and the report
 * says what the move would do.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { finishPlatformBuild, platformSources } from '../../../apps/tablets-server/src/cli/platform-migrate.ts';
import { runUpgradeDrill } from '../../drills/src/upgrade.ts';

export const MOVE_REASON = 'Moved from the standalone Batchwright (Phase B slice 6)';
export const PRODUCT = 'ebmr';
/** The codes the manifest leaves out (permission-list.md, "Not in the manifest"): core, the platform or service accounts do them. */
export const NOT_IN_MANIFEST = [
  'CONTINUITY.BACKUP_READ', 'CONTINUITY.BACKUP_RECORD', 'CONTINUITY.BACKUP_RUN', 'CONTINUITY.RESTORE_APPROVE', 'CONTINUITY.RESTORE_OPERATE',
  'ERP.MASTER_WRITE', 'EXECUTION.SWEEP', 'FEDERATION.ANSWER', 'GATEWAY.API_CONTACT_RECORD', 'GENEALOGY.FEDERATE', 'INTERFACE.WRITE',
] as const;
export const ADMIN_EXTRA = ['core.people.manage', 'core.masterdata.edit'] as const;
/** A core credential no password matches: core resets it (must change at first sign-in). */
export const RESET_IN_CORE = 'expired-temporary-password';
const CORE_LOGIN = /^[a-z][a-z0-9._-]{1,39}$/;
const MASTER_CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/;
export const MASTER_KINDS = ['product', 'room', 'equipment', 'instrument', 'material'] as const;
export type MasterKind = (typeof MASTER_KINDS)[number];
export type CodeMap = Partial<Record<MasterKind, Record<string, string>>>;

export interface MoveOptions {
  /** Superuser connection to the standalone database (its database name is the source). */
  sourceUrl: string;
  /** Superuser connection to the platform's server (PLATFORM_DATABASE_URL; any database). */
  platformUrl: string;
  databases?: { ebmr?: string; identity?: string; masterData?: string };
  /** Core login of the person who runs the move (changed_by of every row). */
  by: string;
  verifiedBy: string;
  verifiedHow: string;
  /** Logins of people core already has (the site confirmed they are the same person). */
  link?: readonly string[];
  codeMap?: CodeMap;
  commit: boolean;
  reportDir: string;
  /** Records rendered by the upgrade drill (default 3). */
  renderLimit?: number;
}

export interface PersonPlan {
  login: string;
  coreLogin: string | null;
  name: string;
  accountId: string;
  action: 'NEW' | 'LINK' | 'REFUSED';
  active: boolean;
  codes: string[];
  withdraw: string[];
  notes: string[];
  employeeId?: string;
}

export interface ItemPlan {
  kind: MasterKind;
  localCode: string;
  masterCode: string;
  name: string;
  active: boolean;
  action: 'MAPPED' | 'REUSED' | 'CREATED' | 'REFUSED';
  note?: string;
  masterId?: string;
}

export interface MoveReport {
  kind: 'ebmr.platform-move';
  result: 'PASS' | 'FAIL';
  committed: boolean;
  failures: string[];
  source: { database: string; tables: number; rows: number };
  restore: { mismatched: string[] };
  drill: { result: string; failures: string[]; report: string };
  /** esig.verify_signatures() after the move, and how many of them the source had already. */
  signatures: { problems: number; carriedOver: number };
  people: PersonPlan[];
  items: ItemPlan[];
  roleCodes: Record<string, string[]>;
  checks: Record<string, boolean>;
  /** How far a committing run got: a failure after EBMR_COMMITTED is a partial move the runbook rolls back. */
  stage: 'NOT_COMMITTED' | 'EBMR_COMMITTED' | 'EBMR_REPLACED' | 'MASTER_DATA_COMMITTED' | 'DONE';
}

const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const urlOf = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};
async function client(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}
async function withClient<T>(url: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = await client(url);
  try {
    return await work(c);
  } finally {
    await c.end();
  }
}

/** libpq's environment for a connection URL, so no password is on a command line (the process list). */
function pgEnv(url: string): NodeJS.ProcessEnv {
  const u = new URL(url);
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.slice(1)) };
  const mode = u.searchParams.get('sslmode');
  const root = u.searchParams.get('sslrootcert');
  if (mode) env['PGSSLMODE'] = mode;
  if (root) env['PGSSLROOTCERT'] = root;
  return env;
}

/** The core login of a Batchwright login: lower case, u + it when it starts with a digit; null when core cannot take it. */
export function coreLoginOf(login: string): string | null {
  const l = login.trim().toLowerCase();
  const c = /^[0-9]/.test(l) ? `u${l}` : l;
  return CORE_LOGIN.test(c) ? c : null;
}

/** Each table's row count and the SHA-256 of its sorted row hashes (PL-13). */
async function tableHashes(c: pg.Client): Promise<Map<string, { n: number; sha: string }>> {
  const { rows: tables } = await c.query<{ t: string }>(
    `select format('%I.%I', n.nspname, c.relname) as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_%' order by 1`);
  const out = new Map<string, { n: number; sha: string }>();
  for (const { t } of tables) {
    const { rows } = await c.query<{ n: string; sha: string | null }>(
      `select count(*)::text as n, encode(sha256(convert_to(coalesce(string_agg(h, ',' order by h), ''), 'UTF8')), 'hex') as sha
         from (select md5(x::text) as h from ${t} x) s`);
    out.set(t, { n: Number(rows[0]?.n ?? 0), sha: rows[0]?.sha ?? '' });
  }
  return out;
}

/** The platform's ebmr database holds no records yet: no human account, product, lot or batch (start-up rows do not count). */
async function emptyProblem(c: pg.Client): Promise<string | null> {
  const fn = await c.query<{ ok: boolean }>("select to_regprocedure('iam.platform_build()') is not null as ok");
  if (!fn.rows[0]?.ok) return 'the platform\'s ebmr database is not migrated (run the platform\'s apply first)';
  const { rows } = await c.query<{ build: boolean; n: string }>(
    `select iam.platform_build() as build,
            ((select count(*) from iam.account where kind = 'HUMAN') + (select count(*) from plant.product)
             + (select count(*) from site.material_lot) + (select count(*) from recipe.batch_execution))::text as n`);
  if (!rows[0]?.build) return 'the platform\'s ebmr database is not a platform build';
  if (rows[0].n !== '0') return 'the platform\'s ebmr database holds records already; the move runs only into a fresh one';
  return null;
}

/** Each role's platform codes: today's live role → permission map, without the codes the manifest leaves out. */
async function roleCodes(c: pg.Client): Promise<{ codes: Record<string, string[]>; adminRoles: Set<string>; domain: Map<string, string> }> {
  const { rows } = await c.query<{ role: string; code: string; domain: string }>(
    `select rp.role_code as role, p.code, p.domain from iam.role_permission rp join iam.permission p on p.code = rp.permission_code
      where rp.removed_at is null order by 1, 2`);
  const { rows: all } = await c.query<{ code: string; domain: string }>('select code, domain from iam.permission');
  const domain = new Map(all.map((p) => [`${PRODUCT}.${p.code.toLowerCase()}`, p.domain]));
  // An administration role (any ADMINISTRATION code, core's IAM.* ones included) keeps its administration, governance
  // and read-only codes only, and makes its holder an administrator (INV-11).
  const adminRoles = new Set(rows.filter((r) => r.domain === 'ADMINISTRATION').map((r) => r.role));
  const codes: Record<string, string[]> = {};
  for (const r of rows) {
    if (r.code.startsWith('IAM.') || (NOT_IN_MANIFEST as readonly string[]).includes(r.code)) continue;
    if (adminRoles.has(r.role) && r.domain === 'GMP') continue;
    (codes[r.role] ??= []).push(`${PRODUCT}.${r.code.toLowerCase()}`);
  }
  return { codes, adminRoles, domain };
}

async function planPeople(work: pg.Client, identity: pg.Client, link: ReadonlySet<string>): Promise<{ people: PersonPlan[]; roles: Record<string, string[]> }> {
  const rc = await roleCodes(work);
  const { rows } = await work.query<{ account_id: string; login: string; name: string; person_status: string; account_status: string; locked: boolean; roles: string[] }>(
    `select a.id::text as account_id, a.login_name as login, p.legal_name as name, p.status as person_status, a.status as account_status,
            iam.account_locked(a.id) as locked,
            coalesce(array_agg(distinct g.role_code) filter (where g.id is not null), '{}') as roles
       from iam.account a join iam.person p on p.id = a.person_id
       left join iam.role_grant g on g.account_id = a.id and iam.grant_is_live(g.status, g.valid_to, g.revoked_at)
      where a.kind = 'HUMAN' group by 1, 2, 3, 4, 5, 6 order by 2`);
  const people: PersonPlan[] = [];
  for (const r of rows) {
    const coreLogin = coreLoginOf(r.login);
    const on = r.person_status === 'ACTIVE' && r.account_status === 'ACTIVE' && !r.locked;
    const plan: PersonPlan = { login: r.login, coreLogin, name: r.name, accountId: r.account_id, action: 'NEW', active: r.person_status === 'ACTIVE' && r.account_status !== 'DISABLED', codes: [], withdraw: [], notes: [] };
    people.push(plan);
    if (!coreLogin) {
      plan.action = 'REFUSED';
      plan.notes.push('core cannot take this login');
      continue;
    }
    const found = await identity.query<{ id: string }>('select id::text as id from employee where login = $1', [coreLogin]);
    const existing = found.rows[0]?.id;
    if (existing && !link.has(r.login.toLowerCase()) && !link.has(coreLogin)) {
      plan.action = 'REFUSED';
      plan.notes.push(`core already has login ${coreLogin}: name it in --link when it is the same person`);
      continue;
    }
    if (existing) {
      plan.action = 'LINK';
      plan.employeeId = existing;
    }
    const held = existing
      ? (await identity.query<{ code: string }>(
          `select code from (select distinct on (product, code) product, code, granted from permission_grant where employee_id = $1
             order by product, code, at desc) g where granted`, [existing])).rows.map((x) => x.code)
      : [];
    const heldOwn = held.filter((c) => c.startsWith(`${PRODUCT}.`));
    const admin = r.roles.some((role) => rc.adminRoles.has(role));
    let codes = [...new Set(r.roles.flatMap((role) => rc.codes[role] ?? []))].sort();
    if (admin) codes = [...codes, ...ADMIN_EXTRA];
    // INV-11 over what the person will hold: these codes and the ebmr.* codes core holds for them already.
    const isGmp = (c: string) => rc.domain.get(c) === 'GMP';
    const isAdmin = (c: string) => rc.domain.get(c) === 'ADMINISTRATION' || (ADMIN_EXTRA as readonly string[]).includes(c);
    const together = [...codes, ...heldOwn];
    if ((admin || together.some(isAdmin)) && together.some(isGmp)) {
      plan.notes.push('administration and GMP codes together: no codes (INV-11); core gives them to two people');
      codes = [];
    }
    if (!on) {
      plan.notes.push(`${r.person_status === 'ACTIVE' ? r.account_status : 'left'}${r.locked ? ', locked' : ''} in the source: no codes`);
      codes = [];
    }
    plan.codes = codes.filter((c) => !held.includes(c));
    // A linked person: their ebmr.* codes become exactly the source's (none when off or refused under INV-11).
    plan.withdraw = heldOwn.filter((c) => !codes.includes(c));
    if (plan.action === 'NEW') plan.notes.push('password: reset in core (must change at first sign-in)');
  }
  return { people, roles: rc.codes };
}

async function planItems(work: pg.Client, master: pg.Client, codeMap: CodeMap): Promise<ItemPlan[]> {
  const { rows } = await work.query<{ kind: MasterKind; code: string; name: string; active: boolean }>(
    `select 'product' as kind, code, name, true as active from plant.product
     union select 'product', product_code, max(product_name), true from site.erp_product where product_code not in (select code from plant.product) group by 2
     union select 'room', code, name, true from plant.area where kind = 'ROOM'
     union select case when kind = 'INSTRUMENT' then 'instrument' else 'equipment' end, e.code, e.name,
                  not exists (select 1 from plant.equipment_event v where v.equipment_id = e.id and v.kind = 'RETIRED')
       from plant.equipment e
     union select 'material', material_code, max(material_name), true from site.erp_material group by 2
     union select 'material', material_code, max(material_name), true from site.material_lot
      where material_kind in ('API', 'EXCIPIENT', 'PRIMARY_PACKAGING', 'PRINTED_PACKAGING')
        and material_code not in (select material_code from site.erp_material) group by 2
     order by 1, 2`);
  const items: ItemPlan[] = [];
  const taken = new Map<string, string>();
  for (const r of rows) {
    const kindMap = codeMap[r.kind];
    const mapped = kindMap && Object.hasOwn(kindMap, r.code) ? kindMap[r.code] : undefined;
    const masterCode = mapped ?? r.code;
    const plan: ItemPlan = { kind: r.kind, localCode: r.code, masterCode, name: r.name, active: r.active, action: mapped ? 'MAPPED' : 'CREATED' };
    items.push(plan);
    const key = `${r.kind}:${masterCode}`;
    if (!MASTER_CODE.test(masterCode)) {
      plan.action = 'REFUSED';
      plan.note = 'not a master code';
      continue;
    }
    if (taken.has(key)) {
      plan.action = 'REFUSED';
      plan.note = `master item ${masterCode} is linked to ${taken.get(key) ?? ''} already`;
      continue;
    }
    taken.set(key, r.code);
    const found = await master.query<{ id: string }>('select id::text as id from item where kind = $1 and code = $2', [r.kind, masterCode]);
    if (found.rows[0]) {
      plan.masterId = found.rows[0].id;
      if (!mapped) plan.action = 'REUSED';
    } else if (mapped) {
      plan.action = 'REFUSED';
      plan.note = `the code map names ${masterCode}, which master data does not hold`;
    }
  }
  return items;
}

async function writeIdentity(identity: pg.Client, people: PersonPlan[], me: { id: string; name: string }, o: MoveOptions): Promise<void> {
  for (const p of people) {
    if (p.action === 'REFUSED') continue;
    if (p.action === 'NEW') {
      const { rows } = await identity.query<{ id: string }>(
        'insert into employee (login, identity_verified_by, identity_verified_how) values ($1, $2, $3) returning id::text as id', [p.coreLogin, o.verifiedBy, o.verifiedHow]);
      const id = rows[0]?.id;
      if (!id) throw new Error(`no employee id for ${p.login}`);
      p.employeeId = id;
      await identity.query(
        `insert into employee_version (employee_id, version, full_name, active, changed_by, changed_by_name, changed_at, reason)
         values ($1, 1, $2, $3, $4, $5, now(), $6)`, [p.employeeId, p.name, p.active, me.id, me.name, MOVE_REASON]);
      await identity.query(
        'insert into credential (employee_id, password_hash, must_change, changed_at, failed_count, locked_at) values ($1, $2, true, now(), 0, null)',
        [p.employeeId, RESET_IN_CORE]);
    }
    for (const [codes, granted] of [[p.codes, true], [p.withdraw, false]] as const) {
      for (const code of codes) {
        await identity.query(
          'insert into permission_grant (employee_id, product, code, granted, by_id, by_name, at, reason) values ($1, $2, $3, $4, $5, $6, now(), $7)',
          [p.employeeId, code.split('.')[0], code, granted, me.id, me.name, MOVE_REASON]);
      }
    }
  }
}

async function writeMaster(master: pg.Client, items: ItemPlan[], me: { id: string; name: string }): Promise<void> {
  for (const i of items) {
    if (i.action !== 'CREATED') continue;
    const { rows } = await master.query<{ id: string }>('insert into item (kind, code) values ($1, $2) returning id::text as id', [i.kind, i.masterCode]);
    const id = rows[0]?.id;
    if (!id) throw new Error(`no master id for ${i.kind} ${i.localCode}`);
    i.masterId = id;
    await master.query(
      `insert into item_version (item_id, version, name, fields, active, changed_by, changed_by_name, changed_at, reason)
       values ($1, 1, $2, '{}', $3, $4, $5, now(), $6)`, [i.masterId, i.name, i.active, me.id, me.name, MOVE_REASON]);
  }
}

export async function runMove(o: MoveOptions): Promise<MoveReport> {
  const db = { ebmr: o.databases?.ebmr ?? 'ebmr', identity: o.databases?.identity ?? 'identity', masterData: o.databases?.masterData ?? 'master_data' };
  const hex = randomBytes(4).toString('hex');
  const restored = `ebmr_move_src_${hex}`;
  const work = `ebmr_move_${hex}`;
  const report: MoveReport = {
    kind: 'ebmr.platform-move', result: 'FAIL', committed: false, failures: [], source: { database: new URL(o.sourceUrl).pathname.slice(1), tables: 0, rows: 0 },
    restore: { mismatched: [] }, drill: { result: 'NOT_RUN', failures: [], report: '' }, signatures: { problems: 0, carriedOver: 0 }, people: [], items: [], roleCodes: {}, checks: {}, stage: 'NOT_COMMITTED',
  };
  mkdirSync(o.reportDir, { recursive: true });
  const fail = (m: string) => report.failures.push(m);
  const admin = o.platformUrl;
  const dumpDir = mkdtempSync(join(tmpdir(), 'ebmr-move-'));
  let identity: pg.Client | null = null;
  let master: pg.Client | null = null;
  let workClient: pg.Client | null = null;
  try {
    const target = await withClient(urlOf(admin, db.ebmr), emptyProblem);
    if (target) throw new Error(target);
    const me = await withClient(urlOf(admin, db.identity), async (c) => (await c.query<{ id: string; name: string }>(
      `select e.id::text as id, v.full_name as name from employee e
         join lateral (select full_name from employee_version x where x.employee_id = e.id order by version desc limit 1) v on true where e.login = $1`, [o.by])).rows[0]);
    if (!me) throw new Error(`--by ${o.by} is no core login`);

    // 2. Dump and restore; every table counted and hashed on both sides (PL-13).
    const file = join(dumpDir, 'source.dump');
    execFileSync('pg_dump', ['--format=custom', '--file', file], { stdio: 'pipe', env: pgEnv(o.sourceUrl) });
    await withClient(admin, (c) => c.query(`create database ${quote(restored)} owner ebmr_owner`));
    execFileSync('pg_restore', ['--exit-on-error', '--dbname', restored, file], { stdio: 'pipe', env: pgEnv(urlOf(admin, restored)) });
    const [before, after] = await Promise.all([withClient(o.sourceUrl, tableHashes), withClient(urlOf(admin, restored), tableHashes)]);
    report.source.tables = before.size;
    report.source.rows = [...before.values()].reduce((s, t) => s + t.n, 0);
    for (const [t, h] of before) if (after.get(t)?.sha !== h.sha || after.get(t)?.n !== h.n) report.restore.mismatched.push(t);
    if (report.restore.mismatched.length > 0) fail(`the restored copy differs from the source in ${report.restore.mismatched.join(', ')}`);

    // 3. The platform's migrations on a copy, compared as the upgrade drill compares (PL-13), then the platform build.
    // A site without records yet (no signature) has nothing to render or sample; any other source keeps the full evidence.
    const empty = await withClient(urlOf(admin, restored), async (c) => (await c.query<{ e: boolean }>('select not exists (select 1 from esig.signature) as e')).rows[0]?.e === true);
    const drill = await runUpgradeDrill({
      adminUrl: admin, sourceDatabase: restored, sources: platformSources(), fromRelease: 'standalone (platform move)', reportDir: o.reportDir,
      renderLimit: o.renderLimit ?? 3, keepCopy: true, workDatabase: work, allowNoRecords: empty,
    });
    report.drill = { result: drill.report.result, failures: drill.report.failures, report: drill.markdownPath };
    if (drill.report.result !== 'PASS') fail(`the upgrade drill of the platform migrations did not pass: ${drill.report.failures.join('; ')}`);
    workClient = await client(urlOf(admin, work));
    await finishPlatformBuild(workClient);
    // The signatures move unchanged: the move adds no problem esig.verify_signatures() finds (a problem the source has
    // already is carried over and reported, never mended by the move).
    const problems = async (c: pg.Client) => new Set((await c.query<{ p: string }>("select signature_id::text || ' ' || problem as p from esig.verify_signatures()")).rows.map((r) => r.p));
    const [had, has] = [await withClient(o.sourceUrl, problems), await problems(workClient)];
    report.signatures = { problems: has.size, carriedOver: [...has].filter((p) => had.has(p)).length };
    const added = [...has].filter((p) => !had.has(p));
    if (added.length > 0) fail(`the move adds ${String(added.length)} signature problem(s): ${added.slice(0, 5).join('; ')}`);

    // 4, 5: the plan.
    identity = await client(urlOf(admin, db.identity));
    master = await client(urlOf(admin, db.masterData));
    await identity.query('begin');
    await master.query('begin');
    await workClient.query('begin');
    const planned = await planPeople(workClient, identity, new Set((o.link ?? []).map((l) => l.toLowerCase())));
    report.people = planned.people;
    report.roleCodes = planned.roles;
    report.items = await planItems(workClient, master, o.codeMap ?? {});
    for (const p of report.people) if (p.action === 'REFUSED') fail(`person ${p.login}: ${p.notes.join('; ')}`);
    for (const i of report.items) if (i.action === 'REFUSED') fail(`${i.kind} ${i.localCode}: ${i.note ?? ''}`);
    if (report.failures.length > 0) throw new Error('the move is refused; see the report');

    // 6. The writes, nested: identity, master_data, then the ebmr copy (which commits first).
    await writeIdentity(identity, report.people, me, o);
    await writeMaster(master, report.items, me);
    const ref = `platform move ${hex}`;
    for (const p of report.people) await workClient.query('select iam.platform_map_existing($1, $2, $3::uuid, $4)', [p.employeeId, p.coreLogin, p.accountId, ref]);
    for (const i of report.items) await workClient.query('insert into md.item_map (kind, local_code, master_id) values ($1, $2, $3)', [i.kind, i.localCode, i.masterId]);
    report.checks = await checks(workClient, report);
    for (const [name, ok] of Object.entries(report.checks)) if (!ok) fail(`check failed: ${name}`);
    if (report.failures.length > 0 || !o.commit) throw new Error(o.commit ? 'the move is refused; see the report' : 'dry run');

    await workClient.query('commit');
    await workClient.end();
    workClient = null;
    // From here the moved copy is kept whatever happens; a failure leaves a partial state the runbook rolls back.
    report.stage = 'EBMR_COMMITTED';
    await withClient(admin, async (c) => {
      // Again just before the swap: the platform's ebmr database still holds no records (its server is stopped).
      const late = await withClient(urlOf(admin, db.ebmr), emptyProblem);
      if (late) throw new Error(late);
      // The copy takes the old database's owner and its database-level grants (the platform's links: CONNECT).
      const { rows } = await c.query<{ g: string }>(
        `select format('grant %s on database %I to %s', a.privilege_type, $2::text,
                       case when a.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(a.grantee)) end) as g
           from pg_database d, aclexplode(d.datacl) a where d.datname = $1 and a.grantee <> d.datdba`, [db.ebmr, work]);
      await c.query(`alter database ${quote(work)} owner to ebmr_owner`);
      await c.query(`revoke all on database ${quote(work)} from public`);
      for (const { g } of rows) await c.query(g);
      await c.query(`drop database ${quote(db.ebmr)} with (force)`);
      await c.query(`alter database ${quote(work)} rename to ${quote(db.ebmr)}`);
    });
    report.stage = 'EBMR_REPLACED';
    await master.query('commit');
    report.stage = 'MASTER_DATA_COMMITTED';
    await identity.query('commit');
    report.stage = 'DONE';
    report.committed = true;
    report.result = 'PASS';
  } catch (error) {
    if ((error as Error).message === 'dry run') report.result = report.failures.length === 0 ? 'PASS' : 'FAIL';
    else if (!report.failures.includes((error as Error).message)) fail((error as Error).message);
    for (const c of [workClient, master, identity]) await c?.query('rollback').catch(() => undefined);
    if (report.stage !== 'NOT_COMMITTED') fail(`PARTIAL MOVE (stage ${report.stage}): roll back with the runbook (restore the snapshots of ebmr, identity and master_data)`);
  } finally {
    for (const c of [workClient, master, identity]) await c?.end().catch(() => undefined);
    // The committed copy is never dropped: before the swap it is ebmr_move_<hex>, after it the platform's ebmr.
    await withClient(admin, async (c) => {
      for (const d of report.stage === 'NOT_COMMITTED' ? [restored, work] : [restored]) await c.query(`drop database if exists ${quote(d)} with (force)`);
    }).catch(() => undefined);
    rmSync(dumpDir, { recursive: true, force: true });
    writeFileSync(join(o.reportDir, 'platform-move.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

/** The PL-13 checks of the copy before it commits. */
async function checks(c: pg.Client, r: MoveReport): Promise<Record<string, boolean>> {
  const moved = r.people.length;
  const q = async (sql: string, params: unknown[] = []) => (await c.query<{ v: boolean }>(sql, params)).rows[0]?.v === true;
  return {
    'every human account is mapped to a core employee': await q("select count(*) = $1 and count(*) = (select count(*) from iam.account where kind = 'HUMAN') as v from iam.platform_identity", [moved]),
    'no moved person keeps a local role grant': await q(
      "select not exists (select 1 from iam.role_grant g join iam.platform_identity i on i.account_id = g.account_id where iam.grant_is_live(g.status, g.valid_to, g.revoked_at)) as v"),
    'every master item is linked': await q('select count(*) = $1 as v from md.item_map', [r.items.length]),
    'no login reads a password or PIN verifier': await q(
      `select not exists (select 1 from unnest(array['ebmr_app', 'ebmr_authn', 'ebmr_report', 'ebmr_analytics', 'ebmr_listener']) r
                           where has_table_privilege(r, 'iam.credential_secret', 'SELECT') or has_table_privilege(r, 'iam.badge_secret', 'SELECT')
                              or has_function_privilege(r, 'iam.authn_prepare(text, text, text, text, uuid)', 'EXECUTE')
                              or has_function_privilege(r, 'iam.authn_secret_history(uuid, text)', 'EXECUTE')) as v`),
    'the platform build is on': await q('select iam.platform_build() as v'),
  };
}
