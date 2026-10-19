/**
 * The release identity, the validation-summary approval and the approved system description (kernel 1300; Phase 7
 * slice 7-0; interfaces slice-7-0-interfaces.md section 4; DI-03, DI-06).
 *
 * The release is the SHA-256 of the migration ledger in namespace and name order, so the IQ can compute it from the
 * files. A validation summary is approved by a QA person's own signature bound to the running release and the
 * summary's hash; until one is, the database reports EBMR-VAL-001 (slice 7c gates the batch issue on it). An interface
 * of the system description is a configuration version written only under an approved change record. Run as the
 * application role, with bypass attempts.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { KERNEL_MIGRATIONS } from '../../src/db/migrate.ts';
import { seedActor, seedAdministration, type SeededActor } from '../identity/seed.ts';
import { signFor } from '../records/helpers.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
let qa: SeededActor;
let qa2: SeededActor;
let owner: SeededActor;
let operator: SeededActor;
let sysAdmin: SeededActor;

const again = <T extends ActorContext>(ctx: T): T => ({ ...ctx, correlationId: randomUUID() });
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const hex64 = (): string => randomBytes(32).toString('hex');

const schemaRelease = async (): Promise<string> => (await db.app.query<{ r: string }>('select platform.schema_release() as r')).rows[0]!.r;
const problem = async (): Promise<string | null> =>
  (await db.app.query<{ p: string | null }>('select platform.validation_summary_problem() as p')).rows[0]!.p;

const approve = (by: SeededActor, release: string, summary: string, signature: string | null, title = 'Validation summary of the test release') =>
  withCommand(db.app, again(by), async (c) =>
    (await c.query<{ id: string }>('select platform.approve_validation_summary($1, $2, $3, $4) as id', [release, summary, title, signature])).rows[0]!.id);
const signSummary = (by: SeededActor, release: string, summary: string) =>
  signFor(db, by, { type: 'validation_summary', id: `${release}@${summary}` }, 'VALIDATION_SUMMARY_APPROVED', 'PROPOSED');

const iface = (over: Record<string, unknown> = {}) => ({
  adapterCode: 'OPCUA-GW-1', sourceSystem: 'OPCUA', endpointHost: 'gateway.plant.local', transport: 'MTLS', signedFeed: true, status: 'DESCRIBED', ...over,
});
const describeIface = (ctx: ActorContext, def: Record<string, unknown>) =>
  withCommand(db.app, again(ctx), async (c) => (await c.query<{ id: string }>('select platform.describe_interface($1::jsonb) as id', [JSON.stringify(def)])).rows[0]!.id);
const described = async (code: string): Promise<boolean> =>
  (await db.app.query<{ d: boolean }>('select platform.interface_described($1) as d', [code])).rows[0]!.d;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureFixtureChangeRecord(db);
  sysAdmin = (await seedAdministration(db)).admin;
  [qa, qa2, owner, operator] = await Promise.all([
    seedActor(db, { roleCode: 'QA_REVIEWER' }),
    seedActor(db, { roleCode: 'QA_REVIEWER' }),
    seedActor(db, { roleCode: 'PROCESS_OWNER' }),
    seedActor(db, { roleCode: 'OPERATOR' }),
  ]);
}, 300_000);

afterAll(async () => {
  await db?.drop();
});

describe('the release identity (kernel 1300)', () => {
  it('[DI-03] the schema release is the SHA-256 of the migration ledger in namespace and name order, the same as computed from the files', async () => {
    const release = await schemaRelease();
    expect(release).toMatch(/^[0-9a-f]{64}$/);
    // From the ledger, in byte order of namespace then name (not the apply order).
    const { rows } = await db.admin.query<{ namespace: string; name: string; checksum: string }>('select namespace, name, checksum from public.schema_migration');
    const lines = rows
      .map((r) => `${r.namespace}/${r.name}/${r.checksum}`)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(release).toBe(sha(lines.join('\n')));
    // Each ledger line is computable from the migration file itself, as tools/validation computes the bundle's release:
    // the kernel's lines are exactly its files with their SHA-256.
    const files = readdirSync(KERNEL_MIGRATIONS.directory).filter((f) => f.endsWith('.sql')).sort();
    const fromFiles = files.map((f) => `kernel/${f}/${sha(readFileSync(join(KERNEL_MIGRATIONS.directory, f), 'utf8'))}`);
    expect(lines.filter((l) => l.startsWith('kernel/'))).toEqual(fromFiles);
  });

  it('[DI-03] the ledger is not writable by the application role, so the release cannot be faked from a session', async () => {
    await expect(db.app.query("insert into public.schema_migration (namespace, name, checksum) values ('kernel', '9999_fake.sql', 'x')")).rejects.toThrow(/permission denied/);
  });
});

describe('the validation-summary approval (kernel 1300)', () => {
  it('[DI-03] until a validation summary of the running release is approved, the database reports EBMR-VAL-001', async () => {
    expect(await problem()).toMatch(/^EBMR-VAL-001 release [0-9a-f]{64} has no approved validation summary/);
  });

  it('[DI-03] a validation summary is approved only by a QA person with their own signature bound to the running release and the summary hash', async () => {
    const release = await schemaRelease();
    const summary = hex64();
    const sig = await signSummary(qa, release, summary);
    // Administrators never, other roles never, a session alone never.
    await expect(approve(sysAdmin, release, summary, sig)).rejects.toThrow(/EBMR-IAM-042/);
    await expect(approve(operator, release, summary, sig)).rejects.toThrow(/EBMR-IAM-040/);
    await expect(db.app.query('select platform.approve_validation_summary($1, $2, $3, $4)', [release, summary, 'x', sig])).rejects.toThrow(/EBMR-IAM/);
    // Malformed, another release, no signature.
    await expect(approve(qa, 'abc', summary, sig)).rejects.toThrow(/EBMR-VAL-003/);
    await expect(approve(qa, release, summary.toUpperCase(), sig)).rejects.toThrow(/EBMR-VAL-003/);
    await expect(approve(qa, release, summary, sig, ' ')).rejects.toThrow(/EBMR-VAL-003/);
    await expect(approve(qa, hex64(), summary, sig)).rejects.toThrow(/EBMR-VAL-004/);
    await expect(approve(qa, release, summary, null)).rejects.toThrow(/EBMR-VAL-006/);
    // The signature binds this summary: it approves no other one, and another QA person cannot use it.
    await expect(approve(qa, release, hex64(), sig)).rejects.toThrow(/EBMR-ESIG/);
    await expect(approve(qa2, release, summary, sig)).rejects.toThrow(/EBMR-VAL-006/);
    expect(await problem()).toMatch(/^EBMR-VAL-001/);
    // The signer's own approval is recorded, once.
    const id = await approve(qa, release, summary, sig);
    const { rows } = await db.admin.query<{ schema_release: string; summary_sha256: string; approved_by_person: string; approved_signature: string }>(
      'select schema_release, summary_sha256, approved_by_person::text, approved_signature::text from platform.validation_summary where id = $1',
      [id],
    );
    expect(rows).toEqual([{ schema_release: release, summary_sha256: summary, approved_by_person: qa.personId, approved_signature: sig }]);
    await expect(approve(qa, release, summary, sig)).rejects.toThrow(/EBMR-VAL-005/);
    expect(await problem()).toBeNull();
  });

  it('[DI-03] the signed content is APPROVED only for the approved release and summary pair, and another summary of the same release is approved on its own (title up to 200 characters)', async () => {
    const release = await schemaRelease();
    const { rows: done } = await db.admin.query<{ s: string }>('select summary_sha256 as s from platform.validation_summary where schema_release = $1 limit 1', [release]);
    const approved = done[0]!.s;
    const state = async (id: string): Promise<string> =>
      (await db.app.query<{ s: string }>("select platform.validation_summary_content($1) ->> 'state' as s", [id])).rows[0]!.s;
    const next = hex64();
    expect(await state(`${release}@${approved}`)).toBe('APPROVED');
    expect(await state(`${release}@${next}`)).toBe('PROPOSED');
    expect(await state(`${hex64()}@${approved}`)).toBe('PROPOSED');
    const title = 'T'.repeat(200);
    const sig = await signSummary(qa2, release, next);
    await expect(approve(qa2, release, next, sig, `${title}x`)).rejects.toThrow(/EBMR-VAL-003/);
    const id = await approve(qa2, release, next, sig, title);
    const { rows } = await db.admin.query<{ title: string; by: string }>('select title, approved_by_person::text as by from platform.validation_summary where id = $1', [id]);
    expect(rows).toEqual([{ title, by: qa2.personId }]);
    expect(await state(`${release}@${next}`)).toBe('APPROVED');
  });

  it('[DI-03] an approved validation summary is insert-only and in the audit trail', async () => {
    await expect(db.app.query("update platform.validation_summary set title = 'changed'")).rejects.toThrow(/permission denied/);
    await expect(db.admin.query("update platform.validation_summary set title = 'changed'")).rejects.toThrow(/EBMR-/);
    await expect(db.admin.query('delete from platform.validation_summary')).rejects.toThrow(/EBMR-/);
    const { rows } = await db.admin.query<{ n: string }>("select count(*)::text as n from kernel.audit_event where chain_key like 'validation_summary:%'");
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });
});

describe('the approved system description (kernel 1300)', () => {
  it('[DI-06] an interface is described only by the system owner under an approved change record, and an administrator never does', async () => {
    await expect(describeIface(sysAdmin, iface())).rejects.toThrow(/EBMR-IAM-042/);
    await expect(describeIface(underChange(sysAdmin), iface())).rejects.toThrow(/EBMR-IAM-042/);
    await expect(describeIface(underChange(operator), iface())).rejects.toThrow(/EBMR-IAM-040/);
    await expect(describeIface(owner, iface())).rejects.toThrow(/EBMR-CFG-001/);
    await expect(describeIface(underChange(owner, 'CR-NOT-THERE'), iface())).rejects.toThrow(/EBMR-CFG-002/);
    for (const bad of [{ adapterCode: 'opcua' }, { sourceSystem: 'FTP' }, { endpointHost: 'a b' }, { transport: 'TLS' }, { signedFeed: 'yes' }, { status: 'ACTIVE' }]) {
      await expect(describeIface(underChange(owner), iface(bad)), JSON.stringify(bad)).rejects.toThrow(/EBMR-INT-036/);
    }
    // A loopback interface is on this host; the OPC UA feed is signed.
    await expect(describeIface(underChange(owner), iface({ adapterCode: 'ERP-1', sourceSystem: 'ERP_WMS', transport: 'LOOPBACK', signedFeed: false })))
      .rejects.toThrow(/system_interface_check/);
    await expect(describeIface(underChange(owner), iface({ signedFeed: false }))).rejects.toThrow(/system_interface_check/);
    expect(await described('OPCUA-GW-1')).toBe(false);
  });

  it('[DI-06] a described interface is in force until it is withdrawn, and every version names its change record', async () => {
    await describeIface(underChange(owner), iface());
    await describeIface(underChange(owner), iface({ adapterCode: 'ERP-1', sourceSystem: 'ERP_WMS', endpointHost: '127.0.0.1', transport: 'LOOPBACK', signedFeed: false }));
    expect(await described('OPCUA-GW-1')).toBe(true);
    expect(await described('ERP-1')).toBe(true);
    expect(await described('LMS-1')).toBe(false);
    await describeIface(underChange(owner), iface({ adapterCode: 'ERP-1', sourceSystem: 'ERP_WMS', endpointHost: '127.0.0.1', transport: 'LOOPBACK', signedFeed: false, status: 'WITHDRAWN' }));
    expect(await described('ERP-1')).toBe(false);
    const current = await db.app.query<{ adapter_code: string; status: string; transport: string }>(
      'select adapter_code, status, transport from platform.system_description() order by adapter_code');
    expect(current.rows).toEqual([
      { adapter_code: 'ERP-1', status: 'WITHDRAWN', transport: 'LOOPBACK' },
      { adapter_code: 'OPCUA-GW-1', status: 'DESCRIBED', transport: 'MTLS' },
    ]);
    const versions = await db.admin.query<{ n: string }>(
      "select count(*)::text as n from platform.config_version v join platform.change_record c on c.id = v.change_record_id where v.area = 'SYSTEM_DESCRIPTION'");
    expect(versions.rows[0]!.n).toBe('3');
    // Insert-only: a version is never changed.
    await expect(db.app.query("update platform.system_interface set status = 'DESCRIBED'")).rejects.toThrow(/permission denied/);
  });
});
