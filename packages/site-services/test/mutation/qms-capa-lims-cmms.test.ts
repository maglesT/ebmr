/**
 * Kill tests of the qms-capa-lims-cmms mutation group, site services part (site services 0925 to 0927; decision 0019,
 * Phase 6 exit campaign part 1): each case proves a refusal, a limit or a binding the group's own tests left unchecked.
 * As the application role through real identities and the registered QMS and LIMS adapters.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { expectRefused } from '../../../kernel/test/identity/helpers.ts';
import { signerActor } from '../../../kernel/test/continuity/helpers.ts';
import { count, envelopeFor, nowUs, receive, registerAdapter, setMirrorMode, syncMirror, acknowledgeGaps, heldHead, type TestAdapter } from '../../../kernel/test/integrations/support.ts';
import { createTestDatabase, type TestDatabase } from '../helpers.ts';
import { QualityWorld, seedQualityCast, unique } from '../quality/support.ts';

let db: TestDatabase;
let w: QualityWorld;
let qms: TestAdapter;
let lims: TestAdapter;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new QualityWorld(db, await seedQualityCast(db));
  qms = await registerAdapter(db, 'QMS');
  lims = await registerAdapter(db, 'LIMS');
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const plusDays = async (n: number): Promise<string> => (await db.admin.query<{ d: string }>('select (site.site_today() + $1::integer)::text as d', [n])).rows[0]!.d;

interface Raised {
  capaId: string;
  ref: string;
  checkId: string;
}

async function capaBody(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    title: 'Recalibrate the moisture analyser weekly', sourceKind: 'COMPLAINT', sourceRef: unique('CMP-'), ownerPersonId: w.cast.qa3.personId,
    dueOn: await plusDays(60), needsMasterChange: false, effectivenessCheck: { criteria: 'No LOD result outside the limit in the next 10 batches', periodDays: 90 }, ...over,
  };
}
const raiseRaw = (body: unknown, by = w.cast.qa) => w.sql<Raised>(by, 'select site.raise_capa($1::jsonb) as r', [body === null ? null : JSON.stringify(body)]);
const raiseCapa = async (over: Record<string, unknown> = {}, by = w.cast.qa): Promise<Raised> => raiseRaw(await capaBody(over), by);
const view = (capaId: string) => w.sql<Record<string, unknown>>(w.cast.qa, 'select site.capa_view($1) as r', [capaId]);
const content = (capaId: string) => w.sql<{ content_version: number; content: Record<string, unknown> }>(w.cast.qa, 'select site.capa_content($1) as r', [capaId]);
const implemented = (capaId: string, note = 'Weekly calibration added to SOP-QC-014', by = w.cast.qa) =>
  w.run(by, (x) => x.query('select site.record_capa_implemented($1, $2)', [capaId, note]));
const effectiveness = (checkId: string, effective: boolean | null, evidence: string | null) =>
  w.run(w.cast.qa, (x) => x.query('select site.record_capa_effectiveness($1, $2, $3)', [checkId, effective, evidence]));
const schedule = (capaId: string, criteria: string | null, days: number | null) =>
  w.sql<string>(w.cast.qa, 'select site.schedule_capa_effectiveness_check($1, $2, $3) as r', [capaId, criteria, days]);
const cancel = (capaId: string, reason: string, by = w.cast.qa2) => w.run(by, (x) => x.query('select site.cancel_capa($1, $2)', [capaId, reason]));
const linkDeviation = (capaId: string, deviationId: string) => w.run(w.cast.qa, (x) => x.query('select site.link_capa_deviation($1, $2)', [capaId, deviationId]));
const linkVersion = (capaId: string, versionId: string) => w.run(w.cast.qa, (x) => x.query('select site.link_capa_master_version($1, $2)', [capaId, versionId]));
const deviation = () => w.sql<{ deviationId: string; ref: string }>(w.cast.operator, 'select site.raise_deviation($1::jsonb) as r', [
  JSON.stringify({ kind: 'DEVIATION', title: 'LOD above limit', classification: 'MAJOR', riskRationale: 'Moisture may affect dissolution of the batch' }),
]);
const facts = (versionId: string) => db.admin.query<{ f: Record<string, unknown> }>('select site.capa_master_version_facts($1) as f', [versionId]).then((r) => r.rows[0]!.f);

/** An MBR version in a given state and effective date (fixture rows; recipe-core decides what effective means). */
async function masterVersion(state: string, effectiveFrom: string | null, code = unique('CAPA-FAM-')): Promise<string> {
  const familyId = randomUUID();
  const versionId = randomUUID();
  const who = randomUUID();
  await w.fixture(
    `with f as (insert into recipe.mbr_family (id, code, title, edition, record_kind, product_code, product_name, strength, dosage_form, batch_sizes,
                                               created_by_person, created_by_account)
                values ($1, $3, 'CAPA family', 'tablets', 'PROCESSING', $3, 'Paracetamol tablets', '500 mg', 'tablet',
                        '[{"id": "BS-1", "quantity": {"value": "100", "unit": "kg"}}]', $4, $4) returning id),
          v as (insert into recipe.mbr_version (id, family_id, version_number, author_person, author_account, effective_from)
                select $2, f.id, 1, $4, $4, $6::timestamptz from f returning id)
     insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version)
     select 'mbr_version', v.id, 'mbr_version', 1, $5, 1 from v`,
    [familyId, versionId, code, who, state, effectiveFrom],
  );
  return versionId;
}

describe('the CAPA register commands (IN-01 (d), PR-51; site services 0925)', () => {
  beforeAll(async () => {
    await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
  });

  it('[IN-01][PR-51] raise_capa refuses each missing or malformed part with its own message, and takes the limits inclusively', async () => {
    await expectRefused(raiseRaw([]), 'EBMR-CAPA-004', /the CAPA details are required/);
    await expectRefused(raiseRaw(null), 'EBMR-CAPA-004', /the CAPA details are required/);
    await expectRefused(raiseCapa({ title: ' ' }), 'EBMR-CAPA-004', /a CAPA has a title/);
    const dev = await deviation();
    await expectRefused(raiseCapa({ sourceKind: 'DEVIATION', sourceRef: undefined, deviationId: randomUUID() }), 'EBMR-CAPA-005', /is not a record of site SITE-1/);
    await expectRefused(raiseCapa({ sourceKind: 'OOS', sourceRef: undefined, deviationId: dev.deviationId }), 'EBMR-CAPA-005', /is a DEVIATION record, not a OOS/);
    await expectRefused(raiseCapa({ deviationId: dev.deviationId }), 'EBMR-CAPA-004', /only a DEVIATION or OOS source names a deviation record/);
    await expectRefused(raiseCapa({ sourceRef: '' }), 'EBMR-CAPA-004', /names its source's reference/);
    await expectRefused(raiseCapa({ sourceRef: 'R'.repeat(129) }), 'EBMR-CAPA-004', /names its source's reference/);
    expect((await raiseCapa({ sourceRef: 'R'.repeat(128) })).ref).toMatch(/CAPA-SITE-1-/);
    // The owner is an active natural person: a malformed id, an unknown person and a service identity are refused.
    await expectRefused(raiseCapa({ ownerPersonId: 'not-a-uuid' }), 'EBMR-CAPA-004', /has an owner/);
    await expectRefused(raiseCapa({ ownerPersonId: randomUUID() }), 'EBMR-CAPA-004', /has an owner/);
    await expectRefused(raiseCapa({ ownerPersonId: qms.actor.personId }), 'EBMR-CAPA-004', /has an owner/);
    await expectRefused(raiseCapa({ dueOn: '2030/01/01' }), 'EBMR-CAPA-004', /has a due date \(YYYY-MM-DD\)/);
    await expectRefused(raiseCapa({ dueOn: '2030-02-30' }), 'EBMR-CAPA-004', /2030-02-30 is not a date/);
    expect((await raiseCapa({ dueOn: await plusDays(0) })).capaId).toMatch(/^[0-9a-f-]{36}$/);
    await expectRefused(raiseCapa({ needsMasterChange: 'yes' }), 'EBMR-CAPA-004', /needsMasterChange/);
    await expectRefused(raiseCapa({ effectivenessCheck: { periodDays: 90 } }), 'EBMR-CAPA-004', /schedules an effectiveness check/);
    await expectRefused(raiseCapa({ effectivenessCheck: { criteria: 'x', periodDays: 1096 } }), 'EBMR-CAPA-004', /schedules an effectiveness check/);
    expect((await raiseCapa({ effectivenessCheck: { criteria: 'x', periodDays: 1095 } })).capaId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[IN-01][PR-51] links, implementation, checks and results: each command refuses the wrong state and the missing part', async () => {
    // Unknown CAPA (lock_capa).
    await expectRefused(implemented(randomUUID()), 'EBMR-CAPA-003', /unknown CAPA/);
    const c = await raiseCapa();
    // A deviation is linked to an OPEN CAPA, exactly the one named; an unknown deviation is refused.
    const d1 = await deviation();
    await deviation();
    await linkDeviation(c.capaId, d1.deviationId);
    expect((await db.admin.query('select deviation_id::text as d from site.capa_deviation where capa_id = $1', [c.capaId])).rows).toEqual([{ d: d1.deviationId }]);
    await expectRefused(linkDeviation(c.capaId, randomUUID()), 'EBMR-CAPA-005', /is not a record of site SITE-1/);
    // A master version is linked only to a CAPA that needs a master change.
    await expectRefused(linkVersion(c.capaId, await masterVersion('APPROVED', '2020-01-01T00:00:00Z')), 'EBMR-CAPA-007', /needs no master change/);
    // Effectiveness: not before implementation; implementation once, with a note.
    await expectRefused(effectiveness(randomUUID(), true, 'x'), 'EBMR-CAPA-009', /unknown effectiveness check/);
    await expectRefused(effectiveness(c.checkId, true, 'Ten batches fine'), 'EBMR-CAPA-009', /effectiveness is checked after the actions are implemented/);
    await expectRefused(implemented(c.capaId, ' '), 'EBMR-CAPA-008', /the implementation states what was done/);
    // A further check: criteria and 1 to 1095 days.
    await expectRefused(schedule(c.capaId, ' ', 30), 'EBMR-CAPA-004', /effectiveness check states/);
    await expectRefused(schedule(c.capaId, 'Audit trail review', null), 'EBMR-CAPA-004', /effectiveness check states/);
    await expectRefused(schedule(c.capaId, 'Audit trail review', 0), 'EBMR-CAPA-004', /effectiveness check states/);
    await expectRefused(schedule(c.capaId, 'Audit trail review', 1096), 'EBMR-CAPA-004', /effectiveness check states/);
    const k1 = await schedule(c.capaId, 'Audit trail review', 1);
    const k2 = await schedule(c.capaId, 'Second audit trail review', 1095);
    expect(await count(db, 'select count(*) as n from site.capa_effectiveness_check where capa_id = $1', [c.capaId])).toBe(3);
    await implemented(c.capaId);
    await expectRefused(implemented(c.capaId), 'EBMR-CAPA-008', /only an OPEN CAPA is recorded as implemented/);
    await expectRefused(effectiveness(k1, null, 'Ten batches fine'), 'EBMR-CAPA-009', /states effective or not/);
    await expectRefused(effectiveness(k1, true, ' '), 'EBMR-CAPA-009', /states effective or not/);
    await effectiveness(k1, true, 'Ten batches fine');
    await expectRefused(effectiveness(k1, true, 'Again'), 'EBMR-CAPA-009', /already has its result/);
    await effectiveness(k2, true, 'Fine');
  });

  it('[PR-51][DI-22] a CAPA is cancelled by QA other than its initiator with a reason; nothing is linked or scheduled after', async () => {
    const c = await raiseCapa();
    const other = await raiseCapa();
    await expectRefused(cancel(c.capaId, 'duplicate of another CAPA', w.cast.qa), 'EBMR-CAPA-012', /QA other than the initiator cancels it/);
    await expectRefused(cancel(c.capaId, ' '), 'EBMR-CAPA-013', /states the person's own reason/);
    await cancel(c.capaId, 'duplicate of another CAPA');
    expect((await view(c.capaId))['state']).toBe('CANCELLED');
    // Another CAPA's cancellation leaves this one OPEN.
    expect((await view(other.capaId))['state']).toBe('OPEN');
    await expectRefused(cancel(c.capaId, 'again'), 'EBMR-CAPA-013', /is CANCELLED; it cannot be cancelled/);
    await expectRefused(linkDeviation(c.capaId, (await deviation()).deviationId), 'EBMR-CAPA-006', /is CANCELLED; nothing is linked to it/);
    await expectRefused(schedule(c.capaId, 'Audit trail review', 30), 'EBMR-CAPA-006', /no check is scheduled for it/);
    const m = await raiseCapa({ needsMasterChange: true });
    await cancel(m.capaId, 'raised in error');
    await expectRefused(linkVersion(m.capaId, await masterVersion('APPROVED', '2020-01-01T00:00:00Z')), 'EBMR-CAPA-006', /is CANCELLED; nothing is linked to it/);
  });

  it('[PR-51][DI-17] CAPA_CLOSED binds: a signature made stale by a later link, and another person\'s signature, do not close it', async () => {
    const c = await raiseCapa();
    await implemented(c.capaId);
    await effectiveness(c.checkId, true, 'Ten batches fine');
    const sig = await w.sign(w.cast.qa2, { type: 'capa', id: c.capaId }, 'CAPA_CLOSED', 'IMPLEMENTED');
    // Another QA person presents qa2's signature: refused.
    await expect(w.run(w.cast.qa3, (x) => x.query('select site.close_capa($1, $2)', [c.capaId, sig]))).rejects.toThrow(/EBMR-(CAPA-011|ESIG-\d{3})/);
    // The content changes after signing (a deviation linked): the signature no longer closes it.
    await linkDeviation(c.capaId, (await deviation()).deviationId);
    await expect(w.run(w.cast.qa2, (x) => x.query('select site.close_capa($1, $2)', [c.capaId, sig]))).rejects.toThrow(/EBMR-(CAPA-011|ESIG-\d{3})/);
    expect((await view(c.capaId))['state']).toBe('IMPLEMENTED');
  });

  it('[DI-17][PR-51] the signed content of a CAPA counts its own rows only and shows its own QMS history only', async () => {
    const a = await raiseCapa();
    const before = await content(a.capaId);
    expect(before.content_version).toBe(2);
    // Another CAPA gains a deviation, a master version, a check result and events.
    const b = await raiseCapa({ needsMasterChange: true });
    await linkDeviation(b.capaId, (await deviation()).deviationId);
    await linkVersion(b.capaId, await masterVersion('APPROVED', '2020-01-01T00:00:00Z'));
    await implemented(b.capaId);
    await effectiveness(b.checkId, true, 'Ten batches fine');
    expect((await content(b.capaId)).content_version).toBe(6);
    expect((await content(a.capaId)).content_version).toBe(2);
    // A QMS CAPA's history is not the stand-in CAPA's.
    await setMirrorMode(db, 'QMS_STATUS', 'MIRROR');
    try {
      await receive(db, qms, 'site.receive_qms_capa', envelopeFor(qms, 'qms.capa', {
        capaRef: unique('QC-'), title: 'QMS CAPA', status: 'OPEN', needsMasterChange: false, effectivenessDueDate: null, versionToken: 'v1',
      }));
    } finally {
      await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
    }
    expect((await content(a.capaId)).content['qmsHistory']).toEqual([]);
    expect((await view(a.capaId))['qmsHistory']).toEqual([]);
  });

  it('[PR-51] a QMS-origin CAPA is not changed by the stand-in commands even when the site runs the stand-in', async () => {
    await setMirrorMode(db, 'QMS_STATUS', 'MIRROR');
    let capaId: string;
    try {
      const r = await receive(db, qms, 'site.receive_qms_capa', envelopeFor(qms, 'qms.capa', {
        capaRef: unique('QC-'), title: 'QMS CAPA', status: 'OPEN', needsMasterChange: false, effectivenessDueDate: null, versionToken: 'v1',
      }));
      capaId = String(r['capaId']);
    } finally {
      await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
    }
    await expectRefused(implemented(capaId), 'EBMR-CAPA-002', /is a mirror of the QMS/);
  });
});

describe('the CAPA master-version resolver (PR-51; site services 0925, recipe-core 0952)', () => {
  /** Owner-level code (the resolver is registered by a migration), with an actor context for the audit trail. */
  const owner = (sql: string, params: unknown[] = []) => withCommand(db.admin, { ...w.cast.qa, correlationId: randomUUID(), reasonCode: 'TEST', reasonText: 'mutation kill test of the resolver registration' }, (c) => c.query(sql, params));
  const register = (fn: string) => owner('select site.register_capa_master_resolver($1::regprocedure)', [fn]);
  const RESOLVER = 'recipe.capa_master_version_facts(uuid)';

  it('[PR-51] only a (uuid) returns jsonb function is registered; no resolver, or one with no answer, fails closed', async () => {
    try {
      await expectRefused(register('site.site_today()'), 'EBMR-CAPA-001', /must have the signature \(uuid\) returns jsonb/);
      await expectRefused(register('site.capa_state(uuid)'), 'EBMR-CAPA-001', /must have the signature \(uuid\) returns jsonb/);
      await register(RESOLVER);
      expect((await db.admin.query('select function_name from site.capa_master_resolver')).rows).toEqual([{ function_name: RESOLVER }]);
      // The resolver's own answers: an unknown version does not exist; the label is the version's family code.
      expect(await facts(randomUUID())).toMatchObject({ exists: false, effective: false });
      const code = unique('FAM-');
      const v = await masterVersion('APPROVED', '2020-01-01T00:00:00Z', code);
      expect(await facts(v)).toEqual({ exists: true, effective: true, label: `${code} v1`, problem: null });
      // No resolver: nothing exists and nothing is effective.
      await owner('delete from site.capa_master_resolver');
      expect(await facts(v)).toMatchObject({ exists: false, effective: false, problem: expect.stringMatching(/no master-version resolver is registered/) });
      // A resolver that answers nothing: the same.
      await db.admin.query("create or replace function public.mut_null_facts(uuid) returns jsonb language sql as 'select null::jsonb'");
      await register('public.mut_null_facts(uuid)');
      expect(await facts(v)).toMatchObject({ exists: false, effective: false, problem: 'the resolver gave no answer' });
      // A resolver whose answer leaves out exists and effective: not linked, and never effective at close or on screen.
      await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
      const c = await raiseCapa({ needsMasterChange: true });
      await db.admin.query(`create or replace function public.mut_partial_facts(uuid) returns jsonb language sql as $$select '{"label": "X v1"}'::jsonb$$`);
      await register('public.mut_partial_facts(uuid)');
      await expectRefused(linkVersion(c.capaId, v), 'EBMR-CAPA-007', /is no master version/);
      await db.admin.query(`create or replace function public.mut_partial_facts(uuid) returns jsonb language sql as $$select '{"exists": true, "label": "X v1"}'::jsonb$$`);
      await linkVersion(c.capaId, v);
      await implemented(c.capaId);
      await effectiveness(c.checkId, true, 'Ten batches fine');
      expect((await db.app.query<{ p: string | null }>('select site.capa_close_problem($1) as p', [c.capaId])).rows[0]!.p).toMatch(/master version X v1 is not effective yet/);
      expect((await view(c.capaId))['masterVersions']).toEqual([expect.objectContaining({ versionId: v, effective: false })]);
    } finally {
      await register(RESOLVER);
    }
  });
});

describe('the QMS adapter\'s receiving commands (DI-31; site services 0925)', () => {
  beforeAll(async () => {
    await setMirrorMode(db, 'QMS_STATUS', 'MIRROR');
  });
  afterAll(async () => {
    await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
  });
  const capaMsg = (over: Record<string, unknown> = {}) => ({
    capaRef: unique('QC-'), title: 'QMS CAPA on tablet hardness', status: 'OPEN', needsMasterChange: true, effectivenessDueDate: '2027-03-01', versionToken: 'v1', ...over,
  });
  const sendCapa = (payload: unknown, type = 'qms.capa', o = {}) => receive(db, qms, 'site.receive_qms_capa', envelopeFor(qms, type, payload, o));

  it('[DI-31] payload shapes: a message of another type, a code that is not text, a bad title, a bad date are each refused', async () => {
    await expectRefused(sendCapa(capaMsg(), 'qms.deviation_status'), 'EBMR-QMS-001', /receives qms.capa messages, not qms.deviation_status/);
    await expectRefused(sendCapa(capaMsg({ capaRef: 12345 })), 'EBMR-QMS-003', /capaRef is a code of 1 to 64 printable characters/);
    await expectRefused(sendCapa(capaMsg({ title: 7 })), 'EBMR-QMS-003', /title is a text of 1 to 500 characters/);
    await expectRefused(sendCapa(capaMsg({ title: ' ' })), 'EBMR-QMS-003', /title is a text of 1 to 500 characters/);
    await expectRefused(sendCapa(capaMsg({ title: 'T'.repeat(501) })), 'EBMR-QMS-003', /title is a text of 1 to 500 characters/);
    expect(await sendCapa(capaMsg({ title: 'T'.repeat(500) }))).toMatchObject({ outcome: 'ACCEPTED' });
    await expectRefused(sendCapa(capaMsg({ effectivenessDueDate: '2027-3-1' })), 'EBMR-QMS-003', /effectivenessDueDate is a date YYYY-MM-DD or null/);
    await expectRefused(sendCapa(capaMsg({ effectivenessDueDate: '2027-02-30' })), 'EBMR-QMS-003', /effectivenessDueDate is a date YYYY-MM-DD or null/);
    // The first problem found is the one named.
    await expectRefused(sendCapa(capaMsg({ status: 'DONE', effectivenessDueDate: 'soon' })), 'EBMR-QMS-003', /status is OPEN, IMPLEMENTED/);
    expect(await sendCapa(capaMsg({ effectivenessDueDate: null }))).toMatchObject({ outcome: 'ACCEPTED' });
    // The payload check itself.
    const problem = (p: unknown) => db.admin.query<{ p: string | null }>("select site.qms_payload_problem($1::jsonb, array['a'], array['a']) as p", [p === null ? null : JSON.stringify(p)]).then((r) => r.rows[0]!.p);
    expect(await problem([])).toBe('the payload is not an object');
    expect(await problem(null)).toBe('the payload is not an object');
    expect(await problem({ a: 5 })).toBe('a is a code of 1 to 64 printable characters');
    expect(await problem({ a: 'A-1' })).toBeNull();
  });

  it('[DI-31] change control: a known status is recorded, another is refused', async () => {
    const send = (status: string) => receive(db, qms, 'site.receive_qms_change_control', envelopeFor(qms, 'qms.change_control', { changeRef: unique('CC-'), status, versionToken: 'v1' }));
    expect(await send('APPROVED')).toMatchObject({ outcome: 'ACCEPTED', applied: 'RECORDED' });
    await expectRefused(send('PENDING'), 'EBMR-QMS-003', /malformed qms.change_control payload: status is OPEN, APPROVED/);
  });

  it('[DI-31] deviation status: the lot list is checked, and a state as new as the one held is stale', async () => {
    const lot = await w.lot();
    const send = (over: Record<string, unknown>, o = {}) => receive(db, qms, 'site.receive_qms_deviation_status',
      envelopeFor(qms, 'qms.deviation_status', { deviationRef: unique('QD-'), status: 'OPEN', lotNumbers: [lot.lotCode], versionToken: 'v1', ...over }, o));
    await expectRefused(send({ lotNumbers: lot.lotCode }), 'EBMR-QMS-003', /lotNumbers is a list of at most 200 lot codes/);
    await expectRefused(send({ lotNumbers: [5] }), 'EBMR-QMS-003', /lotNumbers is a list/);
    await expectRefused(send({ lotNumbers: [''] }), 'EBMR-QMS-003', /lotNumbers is a list/);
    await expectRefused(send({ lotNumbers: Array.from({ length: 201 }, (_, i) => `NO-LOT-${i.toString()}`) }), 'EBMR-QMS-003', /lotNumbers is a list/);
    // 200 codes are a list of the right size: refused for the unknown lot, not for the size.
    await expectRefused(send({ lotNumbers: Array.from({ length: 200 }, (_, i) => `NO-LOT-${i.toString()}`) }), 'EBMR-QMS-005');
    const ref = unique('QD-');
    const ts = nowUs();
    await send({ deviationRef: ref }, { sourceTimestamp: ts });
    await expectRefused(send({ deviationRef: ref, status: 'CLOSED', versionToken: 'v2' }, { sourceTimestamp: ts }), 'EBMR-QMS-004');
  });
});

describe('the QMS status fetched at release (DI-31; site services 0927)', () => {
  let ap: typeof w.cast.qa;
  beforeAll(async () => {
    ap = await signerActor(db, 'AUTHORISED_PERSON');
  });
  const fetch = (lotId: string, answer: unknown) => w.run(ap, (c) => c.query('select site.record_qms_release_fetch($1, $2::jsonb)', [lotId, JSON.stringify(answer)]));

  it('[DI-31] the live answer is refused for an unknown lot, in STAND_IN, and when any element is malformed', async () => {
    const lot = await w.lot();
    await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
    await expectRefused(fetch(lot.lotId, []), 'EBMR-QMS-010', /this site runs no QMS/);
    await setMirrorMode(db, 'QMS_STATUS', 'MIRROR');
    try {
      await acknowledgeGaps(db, qms.code);
      await syncMirror(db, qms, 'QMS_STATUS', await heldHead(db, qms.code));
      await expectRefused(fetch(randomUUID(), []), 'EBMR-QMS-010', /unknown lot/);
      const ok = { deviationRef: 'QD-1', status: 'OPEN', versionToken: 'v1' };
      for (const bad of [
        {},
        [5],
        [{ ...ok, extra: 'x' }],
        [{ ...ok, deviationRef: '' }],
        [{ ...ok, versionToken: '' }],
        [{ ...ok, status: 'DONE' }],
      ]) {
        await expectRefused(fetch(lot.lotId, bad), 'EBMR-QMS-012');
      }
      // Well formed but not what the mirror holds: compared, not malformed.
      await expectRefused(fetch(lot.lotId, [ok]), 'EBMR-QMS-011');
    } finally {
      await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
    }
  });
});

describe('LIMS results through the adapter (DI-31; site services 0926)', () => {
  let lot: { lotId: string; lotCode: string };
  beforeAll(async () => {
    lot = await w.lot();
  });
  const result = (over: Record<string, unknown> = {}) => ({
    sampleId: unique('S-'), lotNumber: lot.lotCode, testCode: 'ASSAY', specificationRef: 'SPEC-PARA-01', result: { value: '99.20', unit: '%' },
    conformance: 'CONFORMS', state: 'APPROVED', recordedAt: nowUs(), ...over,
  });
  const send = (payload: unknown, o = {}, type = 'lims.sample_result') => receive(db, lims, 'site.receive_lims_sample_result', envelopeFor(lims, type, payload, o));

  it('[DI-31] each malformed part of a result is refused with LIMS-101, and a text result is accepted', async () => {
    await expectRefused(send(result(), {}, 'lims.sample_status'), 'EBMR-LIMS-101', /receives lims.sample_result messages, not lims.sample_status/);
    // A payload that is not an object never reaches the command: the envelope is refused first (kernel 1180).
    await expectRefused(send([result()]), 'EBMR-INT-001', /payload must be a JSON object/);
    await expectRefused(send(result({ sampleId: 12345 })), 'EBMR-LIMS-101', /sampleId is a code of 1 to 64 printable characters/);
    await expectRefused(send(result({ testCode: '' })), 'EBMR-LIMS-101', /testCode is a code/);
    await expectRefused(send(result({ conformance: 'MAYBE' })), 'EBMR-LIMS-101', /conformance, state and recordedAt/);
    await expectRefused(send(result({ state: 'SIGNED' })), 'EBMR-LIMS-101', /conformance, state and recordedAt/);
    await expectRefused(send(result({ recordedAt: '2026-10-01' })), 'EBMR-LIMS-101', /conformance, state and recordedAt/);
    await expectRefused(send(result({ result: { text: 'Complies', unit: '%' } })), 'EBMR-LIMS-101', /result is \{value as decimal text, unit\} or \{text\}/);
    await expectRefused(send(result({ result: { text: 5 } })), 'EBMR-LIMS-101', /result is/);
    await expectRefused(send(result({ result: { value: 99.2, unit: '%' } })), 'EBMR-LIMS-101', /result is/);
    await expectRefused(send(result({ result: '99.2 %' })), 'EBMR-LIMS-101', /result is/);
    const sample = unique('S-');
    expect(await send(result({ sampleId: sample, testCode: 'APPEARANCE', result: { text: 'White round tablets' } }))).toMatchObject({ outcome: 'ACCEPTED', applied: 'RECORDED' });
    expect((await db.admin.query('select result_text, raw_value from site.lims_sample_result where sample_id = $1', [sample])).rows).toEqual([{ result_text: 'White round tablets', raw_value: null }]);
  });

  it('[DI-31] staleness is per sample and test: a state as new as the one held is refused; another test of the sample is not', async () => {
    const sample = unique('S-');
    const ts = nowUs();
    await send(result({ sampleId: sample, state: 'ENTERED' }), { sourceTimestamp: ts });
    await expectRefused(send(result({ sampleId: sample, state: 'REVIEWED' }), { sourceTimestamp: ts }), 'EBMR-LIMS-104');
    // An older timestamp for another test of the same sample, and for the same test of another sample: both applied.
    const older = (BigInt(ts) - 1_000_000n).toString();
    expect(await send(result({ sampleId: sample, testCode: 'WATER', result: { value: '0.2', unit: '%' } }), { sourceTimestamp: older })).toMatchObject({ applied: 'RECORDED' });
    expect(await send(result({ sampleId: unique('S-') }), { sourceTimestamp: older })).toMatchObject({ applied: 'RECORDED' });
  });
});
