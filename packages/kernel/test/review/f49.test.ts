/**
 * Review reproducer F49: "validated" time sources are not verified; one SYSTEM_ADMINISTRATOR can
 * swap the references and neutralise drift monitoring (kernel 0520 platform.register_time_source /
 * platform.set_time_source_active; controls DI-27, DI-24, DI-18).
 *
 * Outline 5.6 / R-33 make a time source a validated configuration item. In 0520,
 * time_source.validated_by is a bare uuid (no reference to a person, an e-signature or a
 * validation record) and validation_ref is free text; PLATFORM.TIME_SOURCE_MANAGE is held by
 * SYSTEM_ADMINISTRATOR alone (0700) with no QA approval, signature or second person.
 *
 * The test uses the real authorization catalogue (no stub hooks) and real seeded identities, and
 * asserts the safe behaviour:
 *   (1) a source whose validated_by names nothing (gen_random_uuid()) and whose validation_ref is
 *       'n/a' is refused;
 *   (2) end to end: after one administrator, acting alone, registers a server of their choosing
 *       and deactivates the NPL / NIC references, a database node whose clock is 30 s off must
 *       still raise a time-fault alarm with a data-integrity incident (DI-27). Whatever the fix
 *       (refusing the unvalidated source, refusing the deactivations, or both), the monitor must
 *       not measure the node only against the administrator's server and call it healthy.
 * Positive controls show that the administrator holds the permission and that the same 30 s
 * offset raises DRIFT_EXCEEDED with an incident while the traceable references are active.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';
import { seedActor, seedAdministration, withReason, type SeededActor } from '../identity/seed.ts';

let db: TestDatabase;
let admin: SeededActor;
let system: ActorContext;
let npl = '';
let nic = '';

interface Summary {
  check_id: string;
  active_sources: number;
  reachable_sources: number;
  sources_over_threshold: number;
  raised: { kind: string; alarm_id: string }[];
}

async function adminRows<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.admin.query<T>(text, params)).rows;
}

const again = <T extends ActorContext>(ctx: T): T => ({ ...ctx, correlationId: randomUUID() });

async function attempt<T>(work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Registers a time source through the product path as the given actor. */
function register(ctx: ActorContext, name: string, endpoint: string, reference: string, validatedBy: string | null, validationRef: string) {
  return withCommand(db.app, again(ctx), async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `select platform.register_time_source($1, 'NTP', $2, $3, coalesce($4::uuid, gen_random_uuid()), $5) as id`,
      [name, endpoint, reference, validatedBy, validationRef],
    );
    return rows[0]?.id ?? '';
  });
}

function setActive(ctx: ActorContext, sourceId: string, active: boolean) {
  return withCommand(db.app, withReason(ctx, 'CHANGE_CONTROL', 'CC-TS-0049 retire time reference'), (c) =>
    c.query('select platform.set_time_source_active($1, $2)', [sourceId, active]),
  );
}

/**
 * Test set-up only: a traceable reference that went through the site's validation. Inserted by the
 * superuser with triggers off, so the set-up does not depend on how a fix records validation evidence.
 */
async function validatedSource(name: string, endpoint: string, reference: string, validatorPersonId: string): Promise<string> {
  const client = await db.admin.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    const { rows } = await client.query<{ id: string }>(
      `insert into platform.time_source (name, kind, endpoint, reference, validated_by, validation_ref, registered_by)
       values ($1, 'NTP', $2, $3, $4::uuid, 'VAL-TS-2026-001', $5) returning id`,
      [name, endpoint, reference, validatorPersonId, validatorPersonId],
    );
    await client.query('commit');
    return rows[0]?.id ?? '';
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function activeSources(): Promise<{ id: string; name: string }[]> {
  return adminRows<{ id: string; name: string }>('select id::text, name from platform.time_source where active order by name');
}

/**
 * The monitor's readings for a node whose clock is `skew` seconds ahead of UTC: the traceable
 * references show the skew; any other source follows the database host's clock and shows 0.
 */
async function monitorCheck(node: string, skew: string): Promise<Summary> {
  const samples = (await activeSources()).map((s) => ({
    source_id: s.id,
    reachable: true,
    offset_s: s.id === npl || s.id === nic ? skew : '0.000000',
    uncertainty_s: '0.000500',
  }));
  return withCommand(db.app, again(system), async (c) => {
    const { rows } = await c.query<{ summary: Summary }>('select platform.record_drift_check($1, $2::jsonb) as summary', [node, JSON.stringify(samples)]);
    return rows[0]?.summary as Summary;
  });
}

async function incidentAlarms(node: string): Promise<{ kind: string; severity: string }[]> {
  return adminRows<{ kind: string; severity: string }>(
    `select a.kind, a.severity from platform.alarm a
      where a.subject = $1 and a.incident_requested
        and not exists (select 1 from platform.alarm_clearance c where c.alarm_id = a.id)
      order by a.recorded_at`,
    [node],
  );
}

async function incidentRequests(node: string): Promise<number> {
  const [r] = await adminRows<{ n: string }>(
    "select count(*)::text as n from platform.outbox where topic = 'incident.requested' and payload ->> 'node' = $1",
    [node],
  );
  return Number(r?.n ?? '0');
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAdministration(db);
  admin = await seedActor(db, { roleCode: 'SYSTEM_ADMINISTRATOR', acknowledgeEsig: false });
  const csv = await seedActor(db, { roleCode: 'CSV_DI_LEAD', acknowledgeEsig: false });
  npl = await validatedSource('NPL India NTP', 'time.nplindia.example', 'NPL India, traceable to UTC(NPLI)', csv.personId);
  nic = await validatedSource('NIC NTP', 'samay.nic.example', 'NIC time service, traceable to NPL India', csv.personId);
  system = await seededTestActor(db, { source: 'SYSTEM', legalName: 'Time monitor' });
});
afterAll(async () => {
  await db.drop();
});

describe('F49 validated time sources', () => {
  it('[DI-27][DI-18] a time source whose validated_by names no person, signature or validation record is refused', async () => {
    // Control: the system administrator holds platform.time_source.manage (the gate passes and the
    // function reaches its own lookup), so a refusal below is not a permission refusal.
    const unknown = await attempt(() => setActive(admin, randomUUID(), false));
    expect(unknown.ok ? 'accepted' : unknown.error).toMatch(/EBMR-PLAT-030/);
    // Control: a role without the permission is refused.
    const operator = await seedActor(db, { roleCode: 'OPERATOR', acknowledgeEsig: false });
    const op = await attempt(() => register(operator, `Op ${randomBytes(3).toString('hex')}`, '10.0.0.8', 'anything', null, 'n/a'));
    expect(op.ok ? 'accepted' : op.error).toMatch(/EBMR-PLAT-006/);

    const validator = randomUUID();
    const name = `Local ${randomBytes(3).toString('hex')}`;
    const outcome = await attempt(() => register(admin, name, '10.0.0.9', 'anything', validator, 'n/a'));
    // The claimed validator is nobody: no person, no e-signature.
    const [evidence] = await adminRows<{ person: boolean; signature: boolean }>(
      'select exists (select 1 from iam.person where id = $1) as person, exists (select 1 from esig.signature where id = $1) as signature',
      [validator],
    );
    expect(evidence).toEqual({ person: false, signature: false });
    const stored = await adminRows<{ id: string; validated_by: string; validation_ref: string; active: boolean }>(
      'select id::text, validated_by::text, validation_ref, active from platform.time_source where name = $1',
      [name],
    );
    if (stored.length > 0) {
      // Test clean-up only (superuser, triggers off): keep the next test to the finding's exact scenario.
      const client = await db.admin.connect();
      try {
        await client.query('begin');
        await client.query('set local session_replication_role = replica');
        await client.query('update platform.time_source set active = false where name = $1', [name]);
        await client.query('commit');
      } finally {
        client.release();
      }
    }
    expect(
      outcome.ok
        ? `registered as ${JSON.stringify(stored)} by one SYSTEM_ADMINISTRATOR with validated_by ${validator} (no person, no signature) and validation_ref 'n/a'`
        : 'refused',
    ).toBe('refused');
    expect(stored).toEqual([]);
  });

  it('[DI-27][DI-24] one administrator alone cannot swap the references so that a node 30 s off raises no time-fault incident', async () => {
    // Positive control: with the traceable references active, a 30 s offset raises DRIFT_EXCEEDED with an incident.
    const control = await monitorCheck('db-f49-control', '30.000000');
    expect(control.raised.map((a) => a.kind)).toEqual(['DRIFT_EXCEEDED']);
    expect(await incidentAlarms('db-f49-control')).toEqual([{ kind: 'DRIFT_EXCEEDED', severity: 'MAJOR' }]);

    // The attack of the finding, by one SYSTEM_ADMINISTRATOR with a reason on each change.
    const rogueName = `Local ${randomBytes(3).toString('hex')}`;
    const steps = {
      registerUnvalidated: await attempt(() => register(admin, rogueName, '10.0.0.9', 'anything', null, 'n/a')),
      deactivateNpl: await attempt(() => setActive(admin, npl, false)),
      deactivateNic: await attempt(() => setActive(admin, nic, false)),
    };
    const accepted = Object.entries(steps)
      .filter(([, r]) => r.ok)
      .map(([k]) => k);
    const active = (await activeSources()).map((s) => s.name);

    // The database node's clock is now 30 s ahead of UTC; the administrator's server follows it.
    const node = 'db-f49-attacked';
    const result = await monitorCheck(node, '30.000000');
    const incidents = await incidentAlarms(node);
    expect(
      incidents.length > 0
        ? 'time-fault incident raised'
        : `no time-fault incident: steps accepted ${JSON.stringify(accepted)}, active sources ${JSON.stringify(active)}, ` +
            `raised ${JSON.stringify(result.raised.map((a) => a.kind))} (sources over threshold ${result.sources_over_threshold})`,
    ).toBe('time-fault incident raised');
    expect(await incidentRequests(node)).toBeGreaterThan(0);
  });
});
