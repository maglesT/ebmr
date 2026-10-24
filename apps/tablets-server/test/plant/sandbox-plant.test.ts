/**
 * Phase 7 slice 7o (decision D-7o-1; requirements R4, R8): the plant and containers routes are served on the sandbox too,
 * so a master's test run records its plant acts (rooms, units, cleanings, occupancies, containers) as a GMP batch does.
 * Each installation serves them against its own database only: a sandbox act never reaches the GMP database, and a GMP
 * act never reaches the sandbox's (DI-05). GMP keeps its routes unchanged (the route matrix is compared elsewhere).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { isNotStartableRefusal, SANDBOX_PLANT } from '../../src/cli/sandbox-plant.ts';
import { valueOf } from '../esig/support.ts';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
let sbx: TestServer;

beforeAll(async () => {
  [gmp, sbx] = await Promise.all([startServer('GMP'), startServer('SANDBOX')]);
}, 300_000);

afterAll(async () => {
  await Promise.all([gmp?.close(), sbx?.close()]);
});

const count = async (s: TestServer, sql: string, params: unknown[]): Promise<number> => Number((await s.db.admin.query<{ n: string }>(sql, params)).rows[0]?.n ?? '0');

describe('the plant on both installations, each against its own database (slice 7o)', () => {
  it('[DI-05][DI-17] a room, a unit and a cleaning recorded on the sandbox are in the sandbox database only; the same codes recorded on GMP stay GMP\'s; neither installation lists the other\'s', async () => {
    const tag = randomBytes(3).toString('hex').toUpperCase();
    const room = `RM-${tag}`;
    const unit = `TEST-BLD-${tag}`;
    const sSteward = await sbx.asPersona('steward');
    valueOf(await sSteward.call(routes.plant.defineArea, { body: { code: room, kind: 'ROOM', name: 'Sandbox blending room' } }));
    valueOf(await sSteward.call(routes.plant.defineEquipmentClass, { body: { code: `EQC-${tag}`, kind: 'PROCESS', description: 'Blender (sandbox)', cleanHold: '72 hours', dirtyHold: '48 hours' } }));
    valueOf(await sSteward.call(routes.plant.defineEquipment, { body: { code: unit, name: 'Blender (sandbox)', classCode: `EQC-${tag}`, areaCode: room } }));
    const tech = await sbx.asPersona('technician1');
    const cleaning = valueOf(await tech.call(routes.plant.startCleaning, { body: { target: 'AREA', code: room, level: 'MAJOR', method: 'MANUAL' } }));
    expect(await count(sbx, 'select count(*) as n from plant.area where code = $1', [room])).toBe(1);
    expect(await count(sbx, 'select count(*) as n from plant.equipment where code = $1', [unit])).toBe(1);
    expect(await count(sbx, 'select count(*) as n from plant.cleaning where id = $1', [cleaning.cleaningId])).toBe(1);
    // Nothing of it in the GMP database, and GMP's list does not show it.
    expect(await count(gmp, 'select count(*) as n from plant.area where code = $1', [room])).toBe(0);
    expect(await count(gmp, 'select count(*) as n from plant.equipment where code = $1', [unit])).toBe(0);
    expect(await count(gmp, 'select count(*) as n from plant.cleaning where id = $1', [cleaning.cleaningId])).toBe(0);
    const gSteward = await gmp.asPersona('steward');
    expect(valueOf(await gSteward.call(routes.plant.areas, {})).areas.map((a) => a.code)).not.toContain(room);
    // The same room code on GMP is GMP's own record; the sandbox's stays one.
    valueOf(await gSteward.call(routes.plant.defineArea, { body: { code: room, kind: 'ROOM', name: 'GMP blending room' } }));
    expect(await count(gmp, 'select count(*) as n from plant.area where code = $1', [room])).toBe(1);
    expect(await count(sbx, 'select count(*) as n from plant.area where code = $1', [room])).toBe(1);
    expect(valueOf(await sSteward.call(routes.plant.areas, {})).areas.find((a) => a.code === room)?.name).toBe('Sandbox blending room');
    // The installation answers in its own name: the sandbox's every answer carries its installation stamp.
    expect(sbx.built.ctx.installation).toBe('SANDBOX');
  });

  it('[DI-05] the DEMO-ONLY sandbox plant labels every unit TEST- (its instruments are devices, EBMR-SBX-022; a test run\'s entries name units), never a GMP label', () => {
    const labels = SANDBOX_PLANT.units.map(([code]) => code);
    expect(labels.length).toBeGreaterThan(16);
    expect(labels.filter((l) => !l.startsWith('TEST-'))).toEqual([]);
  });

  it('[DI-05] the set-up skips a cleaning only for the refusal that the unit is not in a state to start one (EBMR-PLANT-042), never for any text that holds CLEAN', () => {
    expect(isNotStartableRefusal({ code: 'EBMR-PLANT-042' })).toBe(true);
    expect(isNotStartableRefusal({ code: 'EBMR-PLANT-041' })).toBe(false);
    expect(isNotStartableRefusal({ code: 'EBMR-PLANT-043' })).toBe(false);
  });
});
