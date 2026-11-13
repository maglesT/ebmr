/**
 * ST-29 minimum (tablets 1910): a change record names, at the firm's choice, the filling lines for which the change
 * requires an aseptic process simulation; QA's approval withdraws each named line's qualification in the database, so the
 * fitness guard refuses the line until it is recorded QUALIFIED again. The list is set only while the record is OPEN and
 * its rows are never changed.
 */
import { randomUUID } from 'node:crypto';
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
});
