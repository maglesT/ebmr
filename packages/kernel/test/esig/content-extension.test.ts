/**
 * DI-37, INV-09 (kernel 1407; injectables review pass I-6, item 2, lead's option (a)): a module adds keys to the signed
 * content of a kernel aggregate through the content-extension catalogue, never by replacing the kernel's provider or
 * re-registering it. The catalogue is the owner's and insert-only; the provider merges every extension in extension-key
 * order and refuses an extension that would overwrite a key, so the content and its hash are the same on every call, and
 * a record no extension adds to keeps kernel 1195's content and hash exactly.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { raiseChangeRecord, approveChangeRecord } from '../../src/config/change-control.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { seedActor, seedAdministration, type SeededActor } from '../identity/seed.ts';
import { signFor } from '../records/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { expectPermissionDenied, expectRefused } from './helpers.ts';

let db: TestDatabase;
let owner: SeededActor;
let qa: SeededActor;

const KIND = 'config_change_record';

beforeAll(async () => {
  db = await createTestDatabase();
  ({ owner } = await seedAdministration(db));
  qa = await seedActor(db, { roleCode: 'QA_REVIEWER' });
  // Test extensions: each returns the value the test puts in ext_test.output for it and the record (none: NULL).
  await db.admin.query(`
    create schema ext_test;
    grant usage on schema ext_test to public;
    create table ext_test.output (ext text not null, id text not null, v jsonb, primary key (ext, id));
    grant select on ext_test.output to public;
    create function ext_test.a_ext(p_id text) returns jsonb language sql stable as $$ select v from ext_test.output where ext = 'a' and id = p_id $$;
    create function ext_test.b_ext(p_id text) returns jsonb language sql stable as $$ select v from ext_test.output where ext = 'b' and id = p_id $$;
    create function ext_test.c_ext(p_id text) returns jsonb language sql immutable as $$ select null::jsonb $$;
    create function ext_test.gone(p_id text) returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create function ext_test.volatile_ext(p_id text) returns jsonb language sql volatile as $$ select '{}'::jsonb $$;
    create function ext_test.wrong_args(p_id uuid) returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create function ext_test.wrong_result(p_id text) returns json language sql stable as $$ select '{}'::json $$;`);
});
afterAll(async () => {
  await db.drop();
});

const again = <T extends ActorContext>(ctx: T): T => ({ ...ctx, correlationId: randomUUID() });
const newNumber = (): string => `CR-${randomBytes(4).toString('hex').toUpperCase()}`;
async function raise(): Promise<string> {
  const number = newNumber();
  await withCommand(db.app, again(owner), (c) => raiseChangeRecord(c, { number, title: `Change ${number}`, description: 'test configuration change', areas: ['RBE_RULE'] }));
  return number;
}
async function approve(number: string): Promise<void> {
  const sig = await signFor(db, qa, { type: KIND, id: number }, 'CONFIG_CHANGE_APPROVED', 'OPEN');
  await withCommand(db.app, again(qa), (c) => approveChangeRecord(c, number, sig));
}
/** As the owner role, the way a migration runs. */
async function asOwner(sql: string, params: unknown[] = []): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('set role ebmr_owner');
    await c.query(sql, params);
  } finally {
    await c.query('reset role');
    c.release();
  }
}
const register = (key: string, fn: string, kind = KIND, description = 'test extension'): Promise<void> =>
  asOwner('select esig.register_content_extension($1, $2, $3::regprocedure, $4)', [kind, key, fn, description]);
const output = (ext: string, id: string, v: unknown): Promise<unknown> =>
  db.admin.query('insert into ext_test.output (ext, id, v) values ($1, $2, $3::jsonb) on conflict (ext, id) do update set v = excluded.v', [ext, id, v === null ? null : JSON.stringify(v)]);
const provided = async (id: string): Promise<{ v: Record<string, unknown>; hash: string }> =>
  (await db.admin.query<{ v: Record<string, unknown>; hash: string }>(
    `select esig.provide($1, $2) as v, esig.content_hash_of($1, $2, esig.provide($1, $2)) as hash`, [KIND, id])).rows[0]!;
const providerRow = async (): Promise<unknown> =>
  (await db.admin.query("select function_oid::text as f, description, registered_at::text as at from esig.content_provider where aggregate_type = $1", [KIND])).rows;
const extensions = async (): Promise<unknown> =>
  (await db.admin.query('select aggregate_type, extension_key, function_oid::text as f, description from platform.content_extension order by 1, 2')).rows;

describe('the content-extension catalogue (kernel 1407)', () => {
  it('[DI-37] only the owner adds an extension, nobody changes or removes one, and every insert is checked whoever writes it: signature, volatility, a provider that merges, a new key and function', async () => {
    const before = await providerRow();
    expect((before as { f: string }[]).map((r) => r.f)).toEqual(['platform.change_record_content(text)']);
    expect(await extensions()).toEqual([]);

    // The application role reads the catalogue and nothing more.
    await expect(db.app.query('select count(*) from platform.content_extension')).resolves.toBeTruthy();
    await expectPermissionDenied(db.app.query("insert into platform.content_extension (aggregate_type, extension_key, function_oid, description) values ($1, 'x', 'ext_test.a_ext(text)', 'd')", [KIND]));
    await expectPermissionDenied(db.app.query("select esig.register_content_extension($1, 'x', 'ext_test.a_ext(text)', 'd')", [KIND]));
    await expectPermissionDenied(db.app.query("select esig.extend_content($1, 'x', '{}'::jsonb)", [KIND]));

    // The function: (text) returns jsonb, STABLE or IMMUTABLE.
    await expectRefused(register('x', 'ext_test.wrong_args(uuid)'), 'EBMR-ESIG-094', /extension signature/);
    await expectRefused(register('x', 'ext_test.wrong_result(text)'), 'EBMR-ESIG-094', /extension signature/);
    await expectRefused(register('x', 'ext_test.volatile_ext(text)'), 'EBMR-ESIG-094', /STABLE or IMMUTABLE/);
    // The aggregate type: one with a provider, and a provider that merges extensions.
    await expectRefused(register('x', 'ext_test.a_ext(text)', 'no_such_kind'), 'EBMR-ESIG-094', /content provider of no_such_kind does not merge/);
    await expectRefused(register('x', 'ext_test.a_ext(text)', 'esig_stub'), 'EBMR-ESIG-094', /content provider of esig_stub does not merge/);
    // The key and the description.
    await expect(register('X-1', 'ext_test.a_ext(text)')).rejects.toThrow(/content_extension_extension_key_check/);
    await expect(register('x', 'ext_test.a_ext(text)', KIND, '  ')).rejects.toThrow(/content_extension_description_check/);
    expect(await extensions()).toEqual([]);

    await register('a_ext', 'ext_test.a_ext(text)');
    await register('b_ext', 'ext_test.b_ext(text)');
    await register('c_ext', 'ext_test.c_ext(text)');
    // Append-only: the same key with another function, or the same function under another key, is refused.
    await expectRefused(register('a_ext', 'ext_test.gone(text)'), 'EBMR-ESIG-094', /a_ext or ext_test\.gone\(text\) is already registered for config_change_record/);
    await expectRefused(register('z_ext', 'ext_test.b_ext(text)'), 'EBMR-ESIG-094', /already registered/);
    // A direct insert by the owner goes through the same checks.
    await expectRefused(asOwner("insert into platform.content_extension (aggregate_type, extension_key, function_oid, description) values ($1, 'd_ext', 'ext_test.volatile_ext(text)', 'd')", [KIND]), 'EBMR-ESIG-094');
    await expectRefused(asOwner("insert into platform.content_extension (aggregate_type, extension_key, function_oid, description) values ($1, 'a_ext', 'ext_test.gone(text)', 'd')", [KIND]), 'EBMR-ESIG-094', /already registered/);
    // Nobody, the superuser included, changes or removes a row.
    await expectRefused(db.admin.query("update platform.content_extension set description = 'changed' where extension_key = 'a_ext'"), 'EBMR-ESIG-001', /update refused/);
    await expectRefused(db.admin.query("update platform.content_extension set function_oid = 'ext_test.gone(text)' where extension_key = 'a_ext'"), 'EBMR-ESIG-001');
    await expectRefused(db.admin.query("delete from platform.content_extension where extension_key = 'a_ext'"), 'EBMR-ESIG-001', /delete refused/);
    await expectRefused(db.admin.query('truncate platform.content_extension'), 'EBMR-ESIG-001', /truncate refused/);

    expect(await extensions()).toEqual([
      { aggregate_type: KIND, extension_key: 'a_ext', f: 'ext_test.a_ext(text)', description: 'test extension' },
      { aggregate_type: KIND, extension_key: 'b_ext', f: 'ext_test.b_ext(text)', description: 'test extension' },
      { aggregate_type: KIND, extension_key: 'c_ext', f: 'ext_test.c_ext(text)', description: 'test extension' },
    ]);
    // The provider row of the aggregate type was never touched.
    expect(await providerRow()).toEqual(before);
  });

  it('[DI-37][INV-09] the provider merges every extension in extension-key order and refuses an overwrite or a non-object; a record no extension adds to keeps kernel 1195\'s content and hash', async () => {
    // Kernel 1195's provider as that migration wrote it, under another name: the reference content.
    const sql = readFileSync(fileURLToPath(new URL('../../sql/1195_configuration_change_control.sql', import.meta.url)), 'utf8');
    const m = /create function platform\.change_record_content\(p_id text\)[\s\S]*?\n\$\$;/.exec(sql);
    expect(m, 'the 1195 provider text').not.toBeNull();
    await asOwner(m![0].replace('create function platform.change_record_content(', 'create function platform.change_record_content_1195_test('));
    const kernel1195 = async (id: string): Promise<{ v: Record<string, unknown>; hash: string }> =>
      (await db.admin.query<{ v: Record<string, unknown>; hash: string }>(
        `select platform.change_record_content_1195_test($2) as v, esig.content_hash_of($1, $2, platform.change_record_content_1195_test($2) || '{"provider": true}') as hash`,
        [KIND, id])).rows[0]!;

    const plain = await raise();
    const listed = await raise();
    // The extensions of the first test are registered (a_ext, b_ext, c_ext); c_ext always returns NULL.
    expect((await extensions() as unknown[]).length).toBe(3);
    // No output for the record, or an empty object: 1195's content and hash exactly.
    await output('b', plain, {});
    const p = await provided(plain);
    const k = await kernel1195(plain);
    expect(p.v).toEqual({ ...k.v, provider: true });
    expect(p.hash).toBe(k.hash);

    // Lines of two extensions are merged into the content, nothing else changes, and the hash is the same on every call.
    await output('a', listed, { a_lines: ['L2', 'L1'] });
    await output('b', listed, { b_lines: ['M1'], b_note: 'n' });
    const l = await provided(listed);
    const lk = await kernel1195(listed);
    expect(l.v).toEqual({ ...lk.v, content: { ...(lk.v['content'] as object), a_lines: ['L2', 'L1'], b_lines: ['M1'], b_note: 'n' }, provider: true });
    expect(l.hash).not.toBe(lk.hash);
    expect((await provided(listed)).hash).toBe(l.hash);

    // QA signs the merged content; the signature binds its hash, and the integrity job finds nothing.
    await approve(listed);
    await approve(plain);
    const signed = await db.admin.query<{ id: string; hash: string; problems: string[] }>(
      `select s.aggregate_id as id, s.content_hash as hash,
              array(select v.problem from esig.verify_signatures() v where v.signature_id = s.id) as problems
         from esig.signature s where s.aggregate_type = $1 and s.aggregate_id = any($2::text[]) order by s.aggregate_id`, [KIND, [listed, plain]]);
    expect(Object.fromEntries(signed.rows.map((r) => [r.id, [r.hash, r.problems]]))).toEqual({ [listed]: [l.hash, []], [plain]: [k.hash, []] });

    // A key the kernel's content already has is never overwritten.
    const other = await raise();
    await output('b', other, { title: 'Another title' });
    await expectRefused(provided(other), 'EBMR-ESIG-095', /extension b_ext of config_change_record returned a key the content already has/);
    // Nor one an earlier extension added: the later one in key order (b_ext after a_ext) is refused.
    await output('b', other, { shared: 'b' });
    await output('a', other, { shared: 'a' });
    await expectRefused(provided(other), 'EBMR-ESIG-095', /extension b_ext of config_change_record returned a key/);
    // A result that is not an object is refused; the first extension in key order is called first.
    await output('a', other, ['x']);
    await expectRefused(provided(other), 'EBMR-ESIG-095', /extension a_ext of config_change_record must return an object/);
    await output('a', other, 'x');
    await expectRefused(provided(other), 'EBMR-ESIG-095', /extension a_ext of config_change_record must return an object/);
    // A JSON null is no object either; an SQL NULL adds nothing.
    await output('a', other, 'null-json');
    await db.admin.query("update ext_test.output set v = 'null'::jsonb where ext = 'a' and id = $1", [other]);
    await expectRefused(provided(other), 'EBMR-ESIG-095', /extension a_ext of config_change_record must return an object/);
    await output('a', other, null);
    await output('b', other, null);
    expect((await provided(other)).v).toEqual({ ...(await kernel1195(other)).v, provider: true });

    // An extension whose function was dropped stops the content, never silently drops its lines.
    await register('d_gone', 'ext_test.gone(text)');
    await db.admin.query('drop function ext_test.gone(text)');
    await expectRefused(provided(plain), 'EBMR-ESIG-095', /the function of content extension d_gone of config_change_record no longer exists/);
  });
});
