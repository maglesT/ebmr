/**
 * Test support for the plant module (sql/0400-0405): a cast of real, seeded identities, real e-signatures for the
 * verifiers, and helpers that build equipment, rooms and lines and drive them through the real machines. Codes get a
 * unique suffix so the test files of one database never collide.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { ActorContext } from '../../../kernel/src/db/command.ts';
import { challengeFor, run, signatureAuth, signWith } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import type { TestDatabase } from '../../../kernel/test/support/db.ts';
import * as plant from '../../src/plant/index.ts';

export interface PlantCast {
  steward: SeededActor;
  tech: SeededActor;
  tech2: SeededActor;
  operator: SeededActor;
  operator2: SeededActor;
  verifier: SeededActor;
  feed: SeededActor;
}

export async function seedPlantCast(db: TestDatabase): Promise<PlantCast> {
  return {
    steward: await seedActor(db, {
      roleCode: 'MASTER_DATA_STEWARD',
      legalName: 'Sunita Steward',
    }),
    tech: await seedActor(db, {
      roleCode: 'MAINTENANCE_TECHNICIAN',
      legalName: 'Tarun Technician',
    }),
    tech2: await seedActor(db, {
      roleCode: 'MAINTENANCE_TECHNICIAN',
      legalName: 'Tanvi Technician',
    }),
    operator: await seedActor(db, {
      roleCode: 'OPERATOR',
      legalName: 'Om Operator',
    }),
    operator2: await seedActor(db, {
      roleCode: 'OPERATOR',
      legalName: 'Oviya Operator',
    }),
    verifier: await seedActor(db, {
      roleCode: 'VERIFIER',
      legalName: 'Vikram Verifier',
    }),
    feed: await seedServiceActor(db, { name: 'BMS feed' }),
  };
}

export const tag = (): string => randomBytes(3).toString('hex').toUpperCase();

/** An instant `seconds` from the database's now, as ISO text (the database clock decides, never the test's). */
export async function dbIn(db: TestDatabase, seconds: number): Promise<string> {
  const { rows } = await db.app.query<{ t: string }>(
    'select to_char((clock_timestamp() + make_interval(secs => $1)) at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') as t',
    [seconds],
  );
  return rows[0]?.t ?? '';
}

export async function sleep(db: TestDatabase, seconds: number): Promise<void> {
  await db.admin.query('select pg_sleep($1)', [seconds]);
}

export const DAY = 86_400;

export class PlantWorld {
  constructor(
    readonly db: TestDatabase,
    readonly cast: PlantCast,
  ) {}

  run<T>(actor: SeededActor, work: (c: pg.PoolClient) => Promise<T>, extra: Partial<ActorContext> = {}): Promise<T> {
    return run(this.db, actor, work, extra);
  }

  async sign(signer: SeededActor, aggregateType: string, aggregateId: string, meaning: string, expectedState: string): Promise<string> {
    const ch = await challengeFor(this.db, signer, aggregateId, {
      meaning,
      aggregateType,
    });
    const ev = await signatureAuth(this.db, signer, signer, ch.challengeId);
    return (await signWith(this.db, signer, ch.challengeId, ev, { expectedState })).signatureId;
  }

  async product(opts: { highlyPotent?: boolean } = {}): Promise<string> {
    const code = `P-${tag()}`;
    await this.run(this.cast.steward, (c) =>
      plant.defineProduct(c, {
        code,
        name: `Product ${code}`,
        highlyPotent: opts.highlyPotent ?? false,
      }),
    );
    return code;
  }

  async equipmentClass(def: Omit<plant.EquipmentClassDefinition, 'code' | 'description'>): Promise<string> {
    const code = `CL-${tag()}`;
    await this.run(this.cast.steward, (c) =>
      plant.defineEquipmentClass(c, {
        code,
        description: `${def.kind} class ${code}`,
        ...def,
      }),
    );
    return code;
  }

  /** A qualified unit of a new class; calibrated (due in `calibratedForSeconds`) when the class needs it. */
  async equipment(
    def: Omit<plant.EquipmentClassDefinition, 'code' | 'description'>,
    opts: {
      qualified?: boolean;
      calibratedForSeconds?: number | null | undefined;
    } = {},
  ): Promise<{ id: string; code: string; classCode: string }> {
    const classCode = await this.equipmentClass(def);
    const code = `EQ-${tag()}`;
    const id = await this.run(this.cast.steward, (c) => plant.defineEquipment(c, { code, name: `Unit ${code}`, classCode }));
    if (opts.qualified ?? true) await this.run(this.cast.steward, (c) => plant.recordEquipmentEvent(c, code, 'QUALIFIED', 'IQ/OQ/PQ approved', `QUAL-${code}`));
    const needsCalibration = def.kind === 'INSTRUMENT' || def.calibrationRequired === true;
    const forSeconds = opts.calibratedForSeconds === undefined ? 180 * DAY : opts.calibratedForSeconds;
    if (needsCalibration && forSeconds !== null) await this.calibrate(code, forSeconds);
    return { id, code, classCode };
  }

  /** A PROCESS unit (press, blender) with the given holds. */
  press(
    opts: {
      cleanHold?: string;
      dirtyHold?: string;
      calibrationRequired?: boolean;
      calibratedForSeconds?: number | null;
    } = {},
  ) {
    return this.equipment(
      {
        kind: 'PROCESS',
        cleanHold: opts.cleanHold ?? '72 hours',
        dirtyHold: opts.dirtyHold ?? '48 hours',
        calibrationRequired: opts.calibrationRequired ?? false,
      },
      { calibratedForSeconds: opts.calibratedForSeconds },
    );
  }

  async calibrate(code: string, forSeconds: number, asFound: 'PASS' | 'FAIL' = 'PASS', asLeft: 'PASS' | 'FAIL' = 'PASS'): Promise<string> {
    const due = await dbIn(this.db, forSeconds);
    return this.run(this.cast.tech, (c) => plant.recordCalibration(c, code, due, asFound, asLeft, `CAL-${tag()}`));
  }

  /** Manual cleaning: started and performed by tech, verified and signed by tech2 (or the given verifier). */
  async clean(target: 'EQUIPMENT' | 'AREA', code: string, level: plant.CleaningLevel, verifier: SeededActor = this.cast.tech2): Promise<string> {
    const id = await this.run(this.cast.tech, (c) => plant.startCleaning(c, target, code, level));
    await this.run(this.cast.tech, (c) => plant.completeCleaning(c, id));
    const sig = await this.sign(verifier, 'plant_cleaning', id, 'LOGBOOK_DOUBLE_CHECKED', 'COMPLETED');
    await this.run(verifier, (c) => plant.verifyCleaning(c, id, sig));
    return id;
  }

  async startUse(code: string, batch: string, product: string, plannedInSeconds = 8 * 3600): Promise<string> {
    const end = await dbIn(this.db, plannedInSeconds);
    return this.run(this.cast.operator, (c) => plant.startEquipmentUse(c, code, batch, product, end));
  }

  async room(opts: Partial<Omit<plant.AreaDefinition, 'code' | 'name'>> = {}): Promise<{ id: string; code: string }> {
    const code = `${opts.kind === 'LINE' ? 'LN' : 'RM'}-${tag()}`;
    const id = await this.run(this.cast.steward, (c) =>
      plant.defineArea(c, {
        code,
        name: `Area ${code}`,
        kind: 'ROOM',
        ...opts,
      }),
    );
    return { id, code };
  }

  /** Clearance performed by operator, verified and signed by the verifier. */
  async clear(
    areaCode: string,
    type: plant.ClearanceType,
    next: {
      batch: string;
      product: string;
      order?: string;
      artworkSet?: string;
    },
    result: 'PASSED' | 'FAILED' = 'PASSED',
  ): Promise<string> {
    const id = await this.run(this.cast.operator, (c) => plant.recordClearance(c, areaCode, type, next));
    const sig = await this.sign(this.cast.verifier, 'plant_clearance', id, 'VERIFIED', 'PERFORMED');
    await this.run(this.cast.verifier, (c) => plant.verifyClearance(c, id, result, sig));
    return id;
  }

  async state(aggregate: 'equipment' | 'area', id: string): Promise<string | undefined> {
    const s = aggregate === 'equipment' ? await plant.equipmentState(this.db.app, id) : await plant.areaState(this.db.app, id);
    return s?.state;
  }
}
