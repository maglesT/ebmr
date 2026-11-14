/**
 * Test support for the plant module (sql/0400-0405): a cast of real, seeded identities, real e-signatures for the
 * verifiers, and helpers that build equipment, rooms and lines and drive them through the real machines. Codes get a
 * unique suffix so the test files of one database never collide.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { ActorContext } from '../../../kernel/src/db/command.ts';
import { createHash, randomUUID } from 'node:crypto';
import { asTimeTraveller, challengeFor, run, signatureAuth, signWith } from '../../../kernel/test/esig/helpers.ts';
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

/** Test setup (superuser, triggers off for this statement): the batch's execution state as the engine leaves it at `status`. */
export async function finishBatch(db: TestDatabase, batchId: string, status: 'EXECUTION_COMPLETE' | 'ABORTED' | 'CANCELLED'): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(
      `insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status) values ($1, '{}', 1, repeat('0', 64), 1, repeat('0', 64), $2)
       on conflict (batch_id) do update set status = excluded.status`,
      [batchId, status],
    );
    await c.query('commit');
  } finally {
    c.release();
  }
}


export interface Batch {
  id: string;
  number: string;
  product: string;
}

export class PlantWorld {
  private readonly batches = new Map<string, Batch>();

  constructor(
    readonly db: TestDatabase,
    readonly cast: PlantCast,
  ) {}

  /**
   * The batch of `product` known in the test by `label` (created on first use). Batch records are arranged by the
   * superuser with triggers off, as test setup only (as the container tests do); nothing about batch issue is tested.
   */
  async batch(label: string, product: string): Promise<Batch> {
    const key = `${label}|${product}`;
    const known = this.batches.get(key);
    if (known) return known;
    const id = randomUUID();
    const number = `TEST-${label}-${tag()}`;
    const hash = createHash('sha256').update(id).digest('hex');
    await asTimeTraveller(
      this.db,
      `insert into recipe.test_package (package_hash, file_name, package, content, content_hash, family_id, family_code, product, version_id, version_number,
                                        revision, version_state, exporter, exported_at_us, source, imported_by_person, imported_by_account, correlation_id)
       values ($1, $1 || '.json', '{}', '{}', $1, gen_random_uuid(), 'FAM', $2::jsonb, gen_random_uuid(), '1', 1, 'APPROVED', '{}', 0, '{}',
               gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
      [hash, JSON.stringify({ code: product, name: `Product ${product}`, strength: '10 mg' })],
    );
    await asTimeTraveller(
      this.db,
      `insert into recipe.batch_execution (id, batch_number, package_hash, content_hash, installation, purpose, engine_version, registry_fingerprint, policy,
                                           policy_hash, issue_request, market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person,
                                           issued_by_account, correlation_id)
       values ($1, $2, $3, $3, 'SANDBOX', 'SANDBOX_TEST_RUN', '1', $3, '{}', $3, '{}', '{IN}', 'BS', 'SITE-1', 'Asia/Kolkata', 0, gen_random_uuid(),
               gen_random_uuid(), gen_random_uuid())`,
      [id, number, hash],
    );
    const b = { id, number, product };
    this.batches.set(key, b);
    return b;
  }

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
      cipValidationRef?: string;
    } = {},
  ) {
    return this.equipment(
      {
        kind: 'PROCESS',
        cleanHold: opts.cleanHold ?? '72 hours',
        dirtyHold: opts.dirtyHold ?? '48 hours',
        calibrationRequired: opts.calibrationRequired ?? false,
        ...(opts.cipValidationRef ? { cipValidationRef: opts.cipValidationRef } : {}),
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

  async startUse(code: string, label: string, product: string, plannedInSeconds = 8 * 3600): Promise<string> {
    const end = await dbIn(this.db, plannedInSeconds);
    const b = await this.batch(label, product);
    return this.run(this.cast.operator, (c) => plant.startEquipmentUse(c, code, b.id, end));
  }

  /** Records a clearance for the batch `label` of `product` (performer: operator). */
  async recordClearance(
    areaCode: string,
    type: plant.ClearanceType,
    next: { batch: string; product: string; order?: string; artworkSet?: string },
    result: 'PASSED' | 'FAILED' = 'PASSED',
  ): Promise<string> {
    const b = await this.batch(next.batch, next.product);
    return this.run(this.cast.operator, (c) =>
      plant.recordClearance(c, areaCode, type, {
        batchId: b.id,
        result,
        ...(next.order ? { order: next.order } : {}),
        ...(next.artworkSet ? { artworkSet: next.artworkSet } : {}),
      }),
    );
  }

  /** Starts the batch `label` of `product` in the room or line (operator). */
  async startIn(areaCode: string, s: { batch: string; product: string; stage?: string; order?: string; artworkSet?: string }): Promise<string> {
    const b = await this.batch(s.batch, s.product);
    return this.run(this.cast.operator, (c) =>
      plant.startAreaOccupancy(c, areaCode, {
        batchId: b.id,
        stage: s.stage ?? 'COMPRESSION',
        ...(s.order ? { order: s.order } : {}),
        ...(s.artworkSet ? { artworkSet: s.artworkSet } : {}),
      }),
    );
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
    const id = await this.recordClearance(areaCode, type, next, result);
    const sig = await this.sign(this.cast.verifier, 'plant_clearance', id, 'VERIFIED', 'PERFORMED');
    await this.run(this.cast.verifier, (c) => plant.verifyClearance(c, id, sig));
    return id;
  }

  async state(aggregate: 'equipment' | 'area', id: string): Promise<string | undefined> {
    const s = aggregate === 'equipment' ? await plant.equipmentState(this.db.app, id) : await plant.areaState(this.db.app, id);
    return s?.state;
  }
}
