/**
 * ST-29 minimum (tablets 1910): a change record names, at the firm's choice, the filling lines for which the change
 * requires an aseptic process simulation; QA's approval withdraws each named line's qualification in the database, so the
 * fitness guard refuses the line until it is recorded QUALIFIED again. The list is set only while the record is OPEN and
 * its rows are never changed.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { actorOfBrowser, refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

let server: TestServer;
let steward: TestBrowser;
let qa: TestBrowser;

beforeAll(async () => {
  server = await startSigningServer('GMP');
  [steward, qa] = await Promise.all([server.asPersona('steward'), server.asPersona('qaInvestigator')]);
}, 600_000);
afterAll(async () => {
  await server?.close();
});

const tag = (): string => randomUUID().slice(0, 6).toUpperCase();

/** A qualified PROCESS unit (a filling line), defined and qualified by the master-data steward. */
async function qualifiedLine(): Promise<string> {
  const t = tag();
  valueOf(await steward.call(routes.plant.defineEquipmentClass, { body: { code: `FIL${t}`, kind: 'PROCESS', description: 'Aseptic vial filling line', cleanHold: '72 hours', dirtyHold: '24 hours' } }));
  const eq = valueOf(await steward.call(routes.plant.defineEquipment, { body: { code: `FL-${t}`, name: 'Vial filling line (RABS)', classCode: `FIL${t}` } }));
  valueOf(await steward.call(routes.plant.equipmentEvent, { params: { code: eq.code }, body: { event: 'EVENT', kind: 'QUALIFIED', detail: 'IQ/OQ/PQ and APS approved', reference: `QUAL-${t}` } }));
  return eq.code;
}

const fitness = async (code: string): Promise<{ fit: string; problems: string[] }> =>
  (
    await server.db.admin.query<{ fit: string; problems: string[] }>(
      `select plant.equipment_fitness(e.id) as fit,
              array(select jsonb_array_elements_text(plant.equipment_use_assessment(e.id, 'ANY', clock_timestamp() + interval '1 hour') -> 'problems')) as problems
         from plant.equipment e where e.code = $1`,
      [code],
    )
  ).rows[0]!;

const approve = async (number: string): Promise<void> => {
  const signed = await signAction(server, qa, 'qaInvestigator', { kind: 'CONFIG_CHANGE_ACT', act: 'APPROVE', number });
  expect(signed.ok, signed.ok ? '' : JSON.stringify(signed.error)).toBe(true);
};

const raise = async (number: string, apsLines?: string[]) =>
  valueOf(
    await steward.call(routes.config.raiseChangeRecord, {
      body: { number, title: 'Filling line HVAC rebalanced', description: 'Air handling unit of the filling room replaced', areas: ['RBE_RULE'], ...(apsLines ? { apsLines } : {}) },
    }),
  );

/** The steward's own command on the application role (CONFIG.CHANGE_RAISE). */
const asSteward = async <T,>(sql: string, params: unknown[]): Promise<T> =>
  withCommand(server.db.app, await actorOfBrowser(server, steward, 'steward'), async (c) => (await c.query(sql, params)).rows[0] as T);

describe('an APS required by an approved change (ST-29; tablets 1910)', () => {
  it('[ST-29] approving a change that names a line withdraws its qualification: the fitness guard refuses it until it is qualified again; a change naming no line withdraws nothing', async () => {
    const [line, other] = [await qualifiedLine(), await qualifiedLine()];
    const number = `CR-APS-${tag()}`;
    expect(await raise(number, [line])).toMatchObject({ number, state: 'OPEN', apsLines: [line] });
    expect((await fitness(line)).fit).toBe('QUALIFIED');

    await approve(number);
    const after = await fitness(line);
    expect(after.fit).toBe('NOT_QUALIFIED');
    expect(after.problems).toContain('the unit is NOT_QUALIFIED');
    const { rows } = await server.db.admin.query<{ kind: string; reference: string; detail: string; by: string }>(
      `select v.kind, v.reference, v.detail, p.legal_name as by from plant.equipment_event v join plant.equipment e on e.id = v.equipment_id
         join iam.person p on p.id = v.person_id where e.code = $1 and v.kind = 'QUALIFICATION_WITHDRAWN'`,
      [line],
    );
    expect(rows).toEqual([{ kind: 'QUALIFICATION_WITHDRAWN', reference: number, detail: `APS required by change ${number}`, by: 'Divya Menon' }]);
    expect(valueOf(await qa.call(routes.config.changeRecords, { query: { state: 'APPROVED' } })).changeRecords.find((r) => r.number === number)?.apsLines).toEqual([line]);
    // The unit not named keeps its qualification; a change without a list withdraws nothing.
    expect((await fitness(other)).fit).toBe('QUALIFIED');
    const plain = `CR-NOAPS-${tag()}`;
    expect(await raise(plain)).toMatchObject({ apsLines: [] });
    await approve(plain);
    expect((await fitness(other)).fit).toBe('QUALIFIED');
    expect((await server.db.admin.query("select 1 from plant.equipment_event where reference = $1 and kind = 'QUALIFICATION_WITHDRAWN'", [plain])).rowCount).toBe(0);

    // After the APS the line is recorded QUALIFIED again (MASTERDATA.CHANGE) and is usable.
    valueOf(await steward.call(routes.plant.equipmentEvent, { params: { code: line }, body: { event: 'EVENT', kind: 'QUALIFIED', detail: 'APS passed after the change', reference: `APS-${number}` } }));
    const requalified = await fitness(line);
    expect(requalified.fit).toBe('QUALIFIED');
    expect(requalified.problems).not.toContain('the unit is NOT_QUALIFIED');
  }, 300_000);

  it('[ST-29] the database sets the list only while the change record is open, never changes a listed row, and refuses an unknown unit', async () => {
    const [line, late] = [await qualifiedLine(), await qualifiedLine()];
    const open = `CR-APS-${tag()}`;
    await raise(open);
    await expect(asSteward('select plant.require_aps_after_change($1, $2::text[])', [open, ['NO-SUCH-LINE']])).rejects.toThrow(/EBMR-CFG-020 .*unknown equipment unit NO-SUCH-LINE/);
    // Over HTTP too: the raise is one command, so a record with an unknown unit is not raised at all.
    const bad = `CR-APS-${tag()}`;
    expect(refusalOf(await steward.call(routes.config.raiseChangeRecord, { body: { number: bad, title: 't', description: 'd', areas: ['RBE_RULE'], apsLines: ['NO-SUCH-LINE'] } }))).toBeTruthy();
    expect((await server.db.admin.query('select 1 from platform.change_record where number = $1', [bad])).rowCount).toBe(0);

    expect(await asSteward<{ n: number }>('select plant.require_aps_after_change($1, $2::text[]) as n', [open, [line]])).toEqual({ n: 1 });
    await approve(open);
    expect((await fitness(line)).fit).toBe('NOT_QUALIFIED');
    // Approved: no unit is added, through the command or by a direct write of the superuser.
    await expect(asSteward('select plant.require_aps_after_change($1, $2::text[])', [open, [late]])).rejects.toThrow(/EBMR-CFG-020 change record \S+ is APPROVED/);
    const direct = `insert into plant.aps_required_line (change_record_id, equipment_id, person_id, account_id)
                    select c.id, e.id, gen_random_uuid(), gen_random_uuid() from platform.change_record c, plant.equipment e where c.number = $1 and e.code = $2`;
    await expect(server.db.admin.query(direct, [open, late])).rejects.toThrow(/EBMR-CFG-020 .*this record is APPROVED/);
    valueOf(await steward.call(routes.config.closeChangeRecord, { params: { number: open }, body: { note: 'Done' } }));
    await expect(asSteward('select plant.require_aps_after_change($1, $2::text[])', [open, [late]])).rejects.toThrow(/EBMR-CFG-020 change record \S+ is CLOSED/);
    await expect(server.db.admin.query(direct, [open, late])).rejects.toThrow(/EBMR-CFG-020 .*this record is CLOSED/);

    // The listed rows: the application role may not write them, and nobody changes or removes them.
    const sel = 'from plant.aps_required_line where change_record_id = (select id from platform.change_record where number = $1)';
    await expect(server.db.app.query(`update plant.aps_required_line set person_id = gen_random_uuid() where change_record_id = (select id from platform.change_record where number = $1)`, [open])).rejects.toThrow(/permission denied/);
    await expect(server.db.app.query(`delete ${sel}`, [open])).rejects.toThrow(/permission denied/);
    await expect(server.db.admin.query(`update plant.aps_required_line set person_id = gen_random_uuid() where change_record_id = (select id from platform.change_record where number = $1)`, [open])).rejects.toThrow(/EBMR-AUDIT-004/);
    await expect(server.db.admin.query(`delete ${sel}`, [open])).rejects.toThrow(/EBMR-AUDIT-004/);
    expect((await server.db.admin.query(`select 1 ${sel}`, [open])).rowCount).toBe(1);
    expect((await fitness(late)).fit).toBe('QUALIFIED');
  }, 300_000);

  it('[ST-29][DI-37] the APS list is in the signed content through the kernel content extension aps_lines; the provider row stays the kernel\'s and the kernel function reads no module table (tablets 1914)', async () => {
    const [b, a] = [await qualifiedLine(), await qualifiedLine()];
    const listed = `CR-APS-${tag()}`;
    const plain = `CR-NOAPS-${tag()}`;
    await raise(listed, [b, a]);
    await raise(plain);
    const q = async (sql: string, id: string): Promise<Record<string, unknown>> => (await server.db.admin.query<{ v: Record<string, unknown> }>(sql, [id])).rows[0]!.v;
    const provided = (id: string) => q("select esig.provide('config_change_record', $1) as v", id);

    // The provider is the kernel's function; plant adds its lines as a registered extension.
    expect((await server.db.admin.query("select function_oid::text as f from esig.content_provider where aggregate_type = 'config_change_record'")).rows).toEqual([
      { f: 'platform.change_record_content(text)' },
    ]);
    expect((await server.db.admin.query("select extension_key as k, function_oid::text as f from platform.content_extension where aggregate_type = 'config_change_record'")).rows).toEqual([
      { k: 'aps_lines', f: 'plant.change_record_aps_lines(text)' },
    ]);
    // The kernel function is kernel 1407's definition again (1914 restores it after 1910's copy) and names no plant object.
    expect(providerText('../../sql/1914_aps_lines_content_extension.sql')).toBe(providerText('../../../../packages/kernel/sql/1407_esig_content_extensions.sql'));
    const src = (await server.db.admin.query<{ s: string }>("select prosrc as s from pg_proc where oid = 'platform.change_record_content(text)'::regprocedure")).rows[0]!.s;
    expect(src).not.toMatch(/plant\.|aps_/);
    expect(src).toContain("esig.extend_content('config_change_record'");

    // The listed units are in the content, sorted; a record without a list has the kernel's six keys only.
    const p = await provided(listed);
    expect((p['content'] as Record<string, unknown>)['aps_lines']).toEqual([b, a].sort());
    expect(Object.keys(p['content'] as object).sort()).toEqual(['aps_lines', 'areas', 'description', 'number', 'raised_at', 'raised_by', 'title']);
    expect(Object.keys((await provided(plain))['content'] as object).sort()).toEqual(['areas', 'description', 'number', 'raised_at', 'raised_by', 'title']);
    expect(await provided('CR-NO-SUCH-RECORD')).toEqual({ exists: false, provider: true });
    expect(await q('select plant.change_record_aps_lines($1) as v', plain)).toEqual({});

    // QA signs the content with the list: the canonical text QA is shown names both units, the signature binds that
    // hash (not the hash of the content without the list), and the approval withdraws both lines.
    await approve(listed);
    const r = (await server.db.admin.query<{ text: string; hash: string; signed: string; without: string }>(
      `select esig.content_for_signing('config_change_record', $1) ->> 'canonical' as text,
              esig.content_hash_of('config_change_record', $1, esig.provide('config_change_record', $1)) as hash,
              (select s.content_hash from esig.signature s where s.aggregate_type = 'config_change_record' and s.aggregate_id = $1) as signed,
              esig.content_hash_of('config_change_record', $1, esig.provide('config_change_record', $1) #- '{content,aps_lines}') as without`,
      [listed],
    )).rows[0]!;
    expect(r.text).toContain(`"aps_lines":${JSON.stringify([b, a].sort())}`);
    expect(r.signed).toBe(r.hash);
    expect(r.signed).not.toBe(r.without);
    expect([(await fitness(a)).fit, (await fitness(b)).fit]).toEqual(['NOT_QUALIFIED', 'NOT_QUALIFIED']);
  }, 300_000);

  it('[ST-29][DI-37] a change record approved under the 1910 content keeps its signed content and hash under the 1914 content extension, with and without listed units', async () => {
    // The 1910 function as that migration wrote it (kernel 1195 plus the in-kernel aps_lines), put back in place of
    // platform.change_record_content while QA signs: the state of an installation before 1914. The provider row is not
    // touched, before, during or after.
    const asOwner = async (stmt: string): Promise<void> => {
      const c = await server.db.admin.connect();
      try {
        await c.query('set role ebmr_owner');
        await c.query(stmt);
      } finally {
        await c.query('reset role');
        c.release();
      }
    };
    const providerRow = async (): Promise<unknown> =>
      (await server.db.admin.query("select function_oid::text as f, description, registered_at::text as at from esig.content_provider where aggregate_type = 'config_change_record'")).rows;
    const row = await providerRow();
    const [b, a] = [await qualifiedLine(), await qualifiedLine()];
    const listed = `CR-APS-${tag()}`;
    const plain = `CR-NOAPS-${tag()}`;
    const before: Record<string, { content: unknown; hash: string; signed: string }> = {};
    await asOwner(providerText('../../sql/1910_aps_required_by_change.sql'));
    try {
      await raise(listed, [b, a]);
      await raise(plain);
      for (const n of [listed, plain]) {
        await approve(n);
        const r = (await server.db.admin.query<{ content: unknown; hash: string; signed: string }>(
          `select esig.provide('config_change_record', $1) -> 'content' as content,
                  esig.content_hash_of('config_change_record', $1, esig.provide('config_change_record', $1)) as hash,
                  (select s.content_hash from esig.signature s where s.aggregate_type = 'config_change_record' and s.aggregate_id = $1) as signed`,
          [n],
        )).rows[0]!;
        expect(r.signed, n).toBe(r.hash);
        before[n] = r;
      }
      expect(await providerRow()).toEqual(row);
    } finally {
      await asOwner(providerText('../../sql/1914_aps_lines_content_extension.sql'));
    }
    expect((before[listed]!.content as Record<string, unknown>)['aps_lines']).toEqual([b, a].sort());
    expect(before[plain]!.content).not.toHaveProperty('aps_lines');

    // After 1914, through the kernel's provider and the extension: the same content and the same hash, and the
    // integrity job finds nothing.
    expect(await providerRow()).toEqual(row);
    for (const n of [listed, plain]) {
      const r = (await server.db.admin.query<{ content: unknown; hash: string; problems: string[] }>(
        `select esig.provide('config_change_record', $1) -> 'content' as content,
                esig.content_hash_of('config_change_record', $1, esig.provide('config_change_record', $1)) as hash,
                array(select v.problem from esig.verify_signatures() v join esig.signature s on s.id = v.signature_id
                       where s.aggregate_type = 'config_change_record' and s.aggregate_id = $1) as problems`,
        [n],
      )).rows[0]!;
      expect(r.content, n).toEqual(before[n]!.content);
      expect(r.hash, n).toBe(before[n]!.hash);
      expect(r.hash, n).toBe(before[n]!.signed);
      expect(r.problems, n).toEqual([]);
    }
  }, 300_000);
});

/** The CREATE OR REPLACE of platform.change_record_content in a migration file (relative to this file). */
function providerText(file: string): string {
  const m = /create or replace function platform\.change_record_content\(p_id text\)[\s\S]*?\n\$\$;/.exec(readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'));
  expect(m, file).not.toBeNull();
  return m![0];
}
