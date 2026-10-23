/**
 * The sandbox's DEMO-ONLY plant (Phase 7 slice 7o; requirements R4 and R8; decision D-7o-1): the rooms, lines, equipment
 * classes, process units and calibrated instruments a full processing master (dispensing, wet granulation, blending,
 * compression with its in-process tests, coating, inspection) and a blister packaging master need, each unit qualified,
 * each instrument calibrated and in the device registry, every process unit and room cleaned and verified. A master a
 * company builds on screen for its own product is then test-run on the sandbox's kiosks (TEST-KIOSK-* of each room,
 * test-kit personas) before its approval, as the SANDBOX_RUN evidence asks (recipe.evidence_status; nothing is relaxed).
 *
 * The plant mirrors the GMP demo plant (release-path.ts, demo-routes.ts) by room and class code, so a master's rooms and
 * equipment classes are the same on both installations; the units carry TEST- codes (the sandbox's balances TEST-BAL-01
 * and TEST-BAL-02 are its gateway-connected scales of DISP-1 and BLEND-1). A tooling set belongs to one product: the
 * company's steward defines it on screen for its own product (plant master data), on each installation.
 *
 * Reusable: `definePlant` sets up any such plan through the real routes of the steward and the technicians, on either
 * installation; it is idempotent (a set-up run again on the same database skips what exists).
 */
import { createHash, randomUUID } from 'node:crypto';
import { routes } from '@ebmr/api-contract';
import { identity } from '@ebmr/kernel';
import { passwordActor, type DatabaseHandle, type SiteSeed } from '@ebmr/test-kit';
import { DemoApp } from './demo-app.ts';

type Json = Record<string, unknown>;

export interface PlantPlan {
  areas: readonly (readonly [string, 'ROOM' | 'LINE'])[];
  classes: readonly (readonly [string, 'INSTRUMENT' | 'PROCESS', Json])[];
  /** code, name, class, area. */
  units: readonly (readonly [string, string, string, string])[];
}

const INSTRUMENT = (description: string): Json => ({ description, calibrationRequired: true, checkRegime: 'PER_USE' });
const PROCESS = (description: string): Json => ({ description, cleanHold: '72 hours', dirtyHold: '48 hours' });

/** The sandbox plant: the GMP demo plant's rooms and classes, units with TEST- codes. */
export const SANDBOX_PLANT: PlantPlan = {
  areas: [['DISP-1', 'ROOM'], ['BLEND-1', 'ROOM'], ['GRAN-1', 'ROOM'], ['COMP-1', 'ROOM'], ['COAT-1', 'ROOM'], ['INSP-1', 'ROOM'], ['PL-2', 'LINE']],
  classes: [
    ['EQC-BAL', 'INSTRUMENT', INSTRUMENT('Balance, platform, calibrated')],
    ['EQC-HT', 'INSTRUMENT', INSTRUMENT('Tablet hardness and thickness tester')],
    ['EQC-FRB', 'INSTRUMENT', INSTRUMENT('Friability tester')],
    ['EQC-DT', 'INSTRUMENT', INSTRUMENT('Disintegration tester')],
    ['EQC-BLENDER', 'PROCESS', PROCESS('Octagonal blender 400 L')],
    ['EQC-PRESS-GBT', 'PROCESS', PROCESS('Double-rotary press, 45 stations')],
    ['EQC-RMG', 'PROCESS', PROCESS('Rapid mixer granulator 600 L')],
    ['EQC-FBD', 'PROCESS', PROCESS('Fluid-bed dryer 120 kg with filter bags')],
    ['EQC-MILL', 'PROCESS', PROCESS('Co-mill with screens')],
    ['EQC-COATER', 'PROCESS', PROCESS('Perforated coating pan 150 kg')],
    ['EQC-COLDFORM', 'PROCESS', PROCESS('Cold-form (alu-alu) blister machine')],
    ['EQC-CARTONER', 'PROCESS', PROCESS('Cartoner with checkweigher')],
  ],
  units: [
    ['TEST-BAL-01', 'Balance 60 kg of DISP-1 (gateway scale)', 'EQC-BAL', 'DISP-1'],
    ['TEST-BAL-02', 'Balance 300 kg of BLEND-1 (gateway scale)', 'EQC-BAL', 'BLEND-1'],
    ['TEST-BAL-GRAN-01', 'Balance of GRAN-1', 'EQC-BAL', 'GRAN-1'],
    ['TEST-BAL-COMP-01', 'Balance of COMP-1', 'EQC-BAL', 'COMP-1'],
    ['TEST-BAL-COAT-01', 'Balance of COAT-1', 'EQC-BAL', 'COAT-1'],
    ['TEST-BAL-INSP-01', 'Balance of INSP-1', 'EQC-BAL', 'INSP-1'],
    ['TEST-BAL-PL-02', 'Balance of PL-2', 'EQC-BAL', 'PL-2'],
    ['TEST-HT-01', 'Tablet hardness and thickness tester', 'EQC-HT', 'COMP-1'],
    ['TEST-FRB-01', 'Friability tester', 'EQC-FRB', 'COMP-1'],
    ['TEST-DT-01', 'Disintegration tester', 'EQC-DT', 'COAT-1'],
    ['TEST-BLD-01', 'Octagonal blender 400 L', 'EQC-BLENDER', 'BLEND-1'],
    ['TEST-PRESS-01', 'Double-rotary press, 45 stations', 'EQC-PRESS-GBT', 'COMP-1'],
    ['TEST-RMG-01', 'Rapid mixer granulator 600 L', 'EQC-RMG', 'GRAN-1'],
    ['TEST-FBD-01', 'Fluid-bed dryer 120 kg with filter bags', 'EQC-FBD', 'GRAN-1'],
    ['TEST-MILL-01', 'Co-mill with screens', 'EQC-MILL', 'GRAN-1'],
    ['TEST-COATER-01', 'Perforated coating pan 150 kg', 'EQC-COATER', 'COAT-1'],
    ['TEST-CFORM-01', 'Cold-form (alu-alu) blister machine', 'EQC-COLDFORM', 'PL-2'],
    ['TEST-CTN-01', 'Cartoner with checkweigher', 'EQC-CARTONER', 'PL-2'],
  ],
};

export interface PlantContext {
  app: DemoApp;
  db: DatabaseHandle;
  seed: SiteSeed;
  log: (message: string) => void;
}

/** Defines, qualifies, calibrates, registers and cleans the plan's plant (idempotent). */
export async function definePlant(ctx: PlantContext, plan: PlantPlan): Promise<void> {
  const { app, db, seed } = ctx;
  const exists = async (sql: string, params: unknown[]): Promise<boolean> => ((await db.admin.query(sql, params)).rowCount ?? 0) > 0;
  const steward = await app.browser('steward');
  const p = routes.plant;
  const call = async (route: Parameters<typeof steward.api.call>[0], args: Json, what: string): Promise<unknown> => {
    const r = await steward.api.call(route as never, args as never);
    if (!r.ok) throw new Error(`${what} was refused: ${JSON.stringify(r.error.kind === 'REFUSAL' ? r.error.envelope.refusal : r.error)}`);
    return r.value;
  };
  for (const [code, kind] of plan.areas) {
    if (!(await exists('select 1 from plant.area where code = $1', [code]))) await call(p.defineArea, { body: { code, kind, name: `${kind === 'LINE' ? 'Line' : 'Room'} ${code}` } }, `area ${code}`);
  }
  for (const [code, kind, rest] of plan.classes) {
    if (!(await exists('select 1 from plant.equipment_class where code = $1', [code]))) await call(p.defineEquipmentClass, { body: { code, kind, ...rest } }, `class ${code}`);
  }
  const tech = await app.browser('technician1');
  const boot = seed.bootstrap;
  const site = (await db.admin.query<{ s: string }>("select site_code as s from iam.device where site_code is not null order by registered_at limit 1")).rows[0]?.s ?? 'SITE-1';
  const admin = await passwordActor(db, boot.admin, boot.admin.fingerprint, { reasonCode: 'DEVICE_REGISTRATION', reasonText: 'Instruments of the DEMO-ONLY plant', correlationId: randomUUID() });
  const instrumentClasses = new Set(plan.classes.filter(([, k]) => k === 'INSTRUMENT').map(([c]) => c));
  for (const [code, name, classCode, area] of plan.units) {
    if (await exists('select 1 from plant.equipment where code = $1', [code])) continue;
    await call(p.defineEquipment, { body: { code, name, classCode, areaCode: area } }, `unit ${code}`);
    await call(p.equipmentEvent, { params: { code }, body: { event: 'EVENT', kind: 'QUALIFIED', detail: 'IQ/OQ/PQ approved (DEMO-ONLY)', reference: `QUAL-${code}` } }, `the qualification of ${code}`);
    if (instrumentClasses.has(classCode)) {
      await app.dbAs(tech, "select plant.record_calibration($1, clock_timestamp() + interval '1 year', 'PASS', 'PASS', $2) as r", [code, `CAL-${code}`]);
      if (!(await exists('select 1 from iam.device where code = $1', [code]))) {
        await identity.withGuardedCommand(db.app, { ...admin, correlationId: randomUUID() }, (c) =>
          c.query("select iam.register_device($1, 'INSTRUMENT', $2, $3, null, $4, $5)", [code, site, area, createHash('sha256').update(`${code}:${randomUUID()}`).digest('hex'), `${name} (not interfaced)`]),
        );
      }
    }
  }
  // A clean plant to start from: every process unit and every area cleaned and verified by a second technician.
  const process = new Set(plan.classes.filter(([, k]) => k === 'PROCESS').map(([c]) => c));
  for (const [code, , classCode] of plan.units) if (process.has(classCode)) await clean(app, 'EQUIPMENT', code);
  for (const [code] of plan.areas) await clean(app, 'AREA', code);
}

async function clean(app: DemoApp, target: 'EQUIPMENT' | 'AREA', code: string): Promise<void> {
  const t1 = await app.browser('technician1');
  const t2 = await app.browser('technician2');
  const started = await t1.api.call(routes.plant.startCleaning, { body: { target, code, level: 'MAJOR', method: 'MANUAL' } });
  if (!started.ok) {
    // Already clean and verified on a set-up run again: a cleaning is started only when the unit or area needs one.
    if (started.error.kind === 'REFUSAL' && /CLEAN|already/i.test(JSON.stringify(started.error.envelope.refusal))) return;
    throw new Error(`the cleaning of ${code} was refused: ${JSON.stringify(started.error)}`);
  }
  const id = (started.value as { cleaningId: string }).cleaningId;
  await app.call(t1, routes.plant.completeCleaning, { params: { id }, body: {} }, `the completion of the cleaning of ${code}`);
  await app.sign(t2, { kind: 'PLANT_VERIFY', act: 'CLEANING', id }, `the verification of the cleaning of ${code}`);
}

/** The sandbox set-up's hook (--sandbox-plant): the DEMO-ONLY plant on the sandbox. */
export async function seedSandboxPlant(opts: { database: string; keysDir: string; exchangeDir: string; seed: SiteSeed; db: DatabaseHandle; log: (m: string) => void }): Promise<void> {
  opts.log('sandbox plant: rooms, lines, units and instruments of a full processing and blister packaging master, cleaned and verified');
  const app = await DemoApp.open({ ...opts, installation: 'SANDBOX' });
  try {
    await definePlant({ app, db: opts.db, seed: opts.seed, log: opts.log }, SANDBOX_PLANT);
  } finally {
    await app.close();
  }
}
