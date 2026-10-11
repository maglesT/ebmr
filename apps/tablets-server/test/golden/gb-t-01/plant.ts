/**
 * The plant of GB-T-01 (Phase 3 slice 6d), as the site records it: the steward defines the rooms, the equipment classes
 * (their codes are the MBR's equipment-class references) and the units through the master-data routes, and the product
 * in the plant product list (no route: a database command of the steward); the technician qualifies each unit (route)
 * and calibrates the balances (no route: the logbook command); the steward records the qualification (route); every process unit and room is cleaned by one technician
 * and the cleaning verified by the other (routes, PLANT_VERIFY with a signature).
 */
import { createHash, randomUUID } from 'node:crypto';
import { routes } from '@ebmr/api-contract';
import { identity, withCommand } from '@ebmr/kernel';
import { passwordActor, personaOf } from '@ebmr/test-kit';
import { GBT01_PRODUCT } from '../../../src/features/execution/seed-gb-t-01.ts';
import { refusalOf } from '../../esig/support.ts';
import type { TestBrowser } from '../../support/harness.ts';
import { asPersona, signOffice, type GoldenWorld } from './world.ts';

export const ROOMS = ['DISP-1', 'GRAN-1', 'BLEND-1', 'COMP-1', 'COAT-1', 'INSP-1'] as const;
export type Room = (typeof ROOMS)[number];

/** The balance of each room (class EQC-BAL) and the process units (classes as the MBR names them). */
export const BALANCE: Record<Room, string> = { 'DISP-1': 'BAL-DISP-01', 'GRAN-1': 'BAL-GRAN-01', 'BLEND-1': 'BAL-BLEND-01', 'COMP-1': 'BAL-COMP-01', 'COAT-1': 'BAL-COAT-01', 'INSP-1': 'BAL-INSP-01' };
export const UNITS = {
  RMG: { code: 'RMG-01', classCode: 'EQC-RMG', room: 'GRAN-1' as Room, name: 'Rapid mixer granulator 600 L' },
  FBD: { code: 'FBD-01', classCode: 'EQC-FBD', room: 'GRAN-1' as Room, name: 'Fluid-bed dryer 120 kg' },
  BLENDER: { code: 'BLD-01', classCode: 'EQC-BLENDER', room: 'BLEND-1' as Room, name: 'Octagonal blender 400 L' },
  PRESS: { code: 'PRESS-01', classCode: 'EQC-PRESS-GBT', room: 'COMP-1' as Room, name: 'Double-rotary press, 45 stations' },
  COATER: { code: 'COATER-01', classCode: 'EQC-COATER', room: 'COAT-1' as Room, name: 'Perforated coating pan 150 kg' },
} as const;
export type UnitRef = keyof typeof UNITS;

function ok<T>(r: { ok: true; value: T } | { ok: false; error: unknown }, what: string): T {
  if (!r.ok) throw new Error(`${what} was refused: ${JSON.stringify(refusalOf(r as never))}`);
  return r.value;
}

/** Cleans unit or room `code` (technician1) and verifies the cleaning (technician2, PLANT_VERIFY). */
export async function clean(w: GoldenWorld, target: 'EQUIPMENT' | 'AREA', code: string, level: 'MINOR' | 'MAJOR' = 'MAJOR'): Promise<void> {
  const t1 = w.b['technician1'] as TestBrowser;
  const t2 = w.b['technician2'] as TestBrowser;
  const c = ok(await t1.call(routes.plant.startCleaning, { body: { target, code, level, method: 'MANUAL' } }), `the cleaning of ${code}`);
  ok(await t1.call(routes.plant.completeCleaning, { params: { id: c.cleaningId }, body: {} }), `the completion of the cleaning of ${code}`);
  ok(await signOffice(w.seed, t2, 'technician2', { kind: 'PLANT_VERIFY', act: 'CLEANING', id: c.cleaningId }), `the verification of the cleaning of ${code}`);
}

export async function setUpPlant(w: GoldenWorld): Promise<void> {
  for (const k of ['technician1', 'technician2', 'head1', 'stores']) w.b[k] ??= await w.server.asPersona(k);
  const st = w.b['steward'] as TestBrowser;
  const p = routes.plant;
  await asPersona(w.server, st, 'steward', (c) => c.query('select plant.define_product($1::jsonb)', [JSON.stringify({ code: GBT01_PRODUCT.productCode, name: GBT01_PRODUCT.productName, highlyPotent: false })]), {
    reasonCode: 'NEW_PRODUCT',
    reasonText: 'GB-T-01 in the plant product list',
  });
  for (const room of ROOMS) ok(await st.call(p.defineArea, { body: { code: room, kind: 'ROOM', name: `Room ${room}` } }), `room ${room}`);
  ok(await st.call(p.defineEquipmentClass, { body: { code: 'EQC-BAL', kind: 'INSTRUMENT', description: 'Balance, platform, calibrated', calibrationRequired: true, checkRegime: 'PER_USE' } }), 'class EQC-BAL');
  for (const u of Object.values(UNITS)) {
    ok(await st.call(p.defineEquipmentClass, { body: { code: u.classCode, kind: 'PROCESS', description: u.name, cleanHold: '72 hours', dirtyHold: '48 hours' } }), `class ${u.classCode}`);
  }
  for (const room of ROOMS) ok(await st.call(p.defineEquipment, { body: { code: BALANCE[room], name: `Balance of ${room}`, classCode: 'EQC-BAL', areaCode: room } }), `unit ${BALANCE[room]}`);
  for (const u of Object.values(UNITS)) ok(await st.call(p.defineEquipment, { body: { code: u.code, name: u.name, classCode: u.classCode, areaCode: u.room } }), `unit ${u.code}`);

  // The tooling set of the product (the MBR's approved specification) and the press discharging each side separately.
  ok(
    await st.call(p.defineToolingSet, {
      body: { code: 'TS-GBT01-01', product: GBT01_PRODUCT.productCode, type: 'B', shape: 'Round 10 mm biconvex', upperEmbossing: 'X250', lowerEmbossing: 'PLAIN', score: 'NONE', tips: 1, upperPunches: 45, lowerPunches: 45, dies: 45, strokeLimit: '5000000' },
    }),
    'the tooling set',
  );
  await asPersona(w.server, st, 'steward', (c) => c.query('select plant.configure_press_discharge($1, true)', [UNITS.PRESS.code]), { reasonCode: 'PRESS_SET_UP', reasonText: 'Each side of PRESS-01 discharges into its own containers' });

  const tech = w.b['technician1'] as TestBrowser;
  const all = [...ROOMS.map((r) => BALANCE[r]), ...Object.values(UNITS).map((u) => u.code)];
  for (const code of all) ok(await st.call(p.equipmentEvent, { params: { code }, body: { event: 'EVENT', kind: 'QUALIFIED', detail: 'IQ/OQ/PQ approved', reference: `QUAL-${code}` } }), `the qualification of ${code}`);
  for (const room of ROOMS) {
    await asPersona(w.server, tech, 'technician1', (c) => c.query("select plant.record_calibration($1, clock_timestamp() + interval '1 year', 'PASS', 'PASS', $2)", [BALANCE[room], `CAL-${BALANCE[room]}`]));
  }
  for (const u of Object.values(UNITS)) await clean(w, 'EQUIPMENT', u.code);
  for (const room of ROOMS) await clean(w, 'AREA', room);
  const boot = w.seed.bootstrap;

  // Each balance in the device registry as an instrument of its room (keyed by hand: no gateway serves them), by the
  // system administrator (DEVICE.MANAGE).
  const admin = await passwordActor(w.server.db, boot.admin, boot.admin.fingerprint, { reasonCode: 'DEVICE_REGISTRATION', reasonText: 'Balances of the GB-T-01 rooms', correlationId: randomUUID() });
  for (const room of ROOMS) {
    await identity.withGuardedCommand(w.server.db.app, { ...admin, correlationId: randomUUID() }, (c) =>
      c.query("select iam.register_device($1, 'INSTRUMENT', 'SITE-1', $2, null, $3, $4)", [BALANCE[room], room, createHash('sha256').update(`${BALANCE[room]}:${randomUUID()}`).digest('hex'), `Balance of ${room} (not interfaced)`]),
    );
  }

  // The dispenser designation of operator1 (TB-01 is performed by the designated dispenser): requested by the system
  // administrator, approved by the process owner (the kernel's role grant).
  const reason = { reasonCode: 'DESIGNATION', reasonText: 'Dispenser designation of the GB-T-01 operator', correlationId: randomUUID() };
  const grantId = await withCommand(w.server.db.app, await passwordActor(w.server.db, boot.admin, boot.admin.fingerprint, reason), (c) =>
    identity.requestRoleGrant(c, { accountId: personaOf(w.seed, 'operator1').accountId, roleCode: 'DISPENSER', reason: 'Trained and designated dispenser (SOP-DISP-001)' }),
  );
  await withCommand(w.server.db.app, await passwordActor(w.server.db, boot.owner, boot.owner.fingerprint, { ...reason, correlationId: randomUUID() }), (c) =>
    identity.decideRoleGrant(c, grantId, true, 'Approved: training record on file'),
  );
}
