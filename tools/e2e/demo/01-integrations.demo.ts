/**
 * Phase 6 exit demo, item 1 (DI-31, DI-20): the ERP, QMS, LMS and CMMS exchange data with the sandbox installation under
 * injected faults, then a stale LMS mirror refuses a step signature at the kiosk.
 *
 * Every system is its simulator process and every adapter is the one the sandbox server started itself (its service-keys
 * file, MIRROR mode; demo/global-setup.ts); the demo only publishes on the simulators, switches their faults
 * (POST /api/fault) and reads what landed. Per system: a clean message, then MALFORMED, DUPLICATE, OUT_OF_ORDER and
 * LINK_CUT in turn, each switched off again; at the end the source's count of distinct messages equals what the eBMR
 * accepted plus what it refused, every refusal has an alarm, and no message of a cut page landed until the link was back.
 *
 * The stale mirror: the product's performers need the product training the LMS sends (a requirement on
 * STEP.SIGN_PERFORMED); the LMS sends the operator's training through its adapter; the LMS mirror's bound is set to its
 * minimum, 60 s (a change-controlled setting); the LMS then stops confirming that its feed is complete (STALE_MIRROR), so
 * the adapter records no synchronisation, and once the bound has passed the operator's "Sign as performed" is refused
 * through the ceremony with the stale source named. When the LMS confirms again the adapter synchronises and the same
 * signature is accepted.
 */
import { withCommand } from '@ebmr/kernel';
import type { DatabaseHandle } from '@ebmr/test-kit';
import { expect, pin, signIn, test } from '../fixtures/index.ts';
import { issueTestBatch, open, recordClearanceEntries, startWithTap, tapBadge } from '../fixtures/floor.ts';
import { exportDcMiniPackage, packageTag } from '../fixtures/test-package.ts';
import { administration, because, endSessions, ensureChangeRecord, grantedPerson, letters, nowUs, sessionOf, withDb } from '../specs/phase6/support.ts';
import { demoState, fault, one, sim, until } from './demo-support.ts';

type System = 'ERP' | 'QMS' | 'LMS' | 'CMMS';

interface Counts {
  accepted: number;
  refused: number;
  dedup: number;
  alarms: Record<string, number>;
}

async function counts(db: DatabaseHandle, code: string): Promise<Counts> {
  return {
    accepted: await one<number>(db, 'select count(*)::int as r from platform.inbound_message where adapter_code = $1', [code]),
    refused: await one<number>(db, "select count(distinct idempotency_key)::int as r from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED'", [code]),
    dedup: await one<number>(db, "select count(*)::int as r from platform.inbound_exception where adapter_code = $1 and kind = 'DEDUPLICATED'", [code]),
    alarms: await one<Record<string, number>>(db, "select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb) as r from (select kind, count(*)::int as n from platform.integration_alarm where adapter_code = $1 group by kind) x", [code]),
  };
}

const alarmsOf = (c: Counts, kind: string): number => c.alarms[kind] ?? 0;

test('[DI-31][DI-20] the ERP, QMS, LMS and CMMS exchange data under injected faults (malformed, duplicate, out of order, link cut): each refused or de-duplicated with an alarm, no partial value, the count reconciles @demo', async ({ e2e, persona, evidence }) => {
  test.setTimeout(900_000);
  const d = demoState();
  const tag = letters(5).toUpperCase();
  // What each system publishes: the n-th message of the run, every one a distinct record.
  const arranged = await withDb(e2e, 'SANDBOX', async (db, seed) => {
    const adm = await administration(db, seed);
    const coordinator = await sessionOf(db, seed, await grantedPerson(db, seed, adm, 'TRAINING_COORDINATOR', 'Tara Coordinator'));
    const person = persona('SANDBOX', 'operator2');
    const personNumber = `TEST-EMP-${tag}`;
    await withCommand(db.admin, because(adm.admin, 'Employee number from the HR record (LMS key)', 'HR_RECORD'), (c) => c.query('update iam.person set employee_ref = $1 where id = $2', [personNumber, person.personId]));
    await withCommand(db.app, because(coordinator, 'Demo: SOPs the LMS trains on'), async (c) => {
      for (let i = 0; i < 12; i++) await c.query("select iam.create_qualification_type($1, 'Demo SOP', 'A site SOP held in the LMS (demo)')", [`TEST-SOP-${tag}-${String(i)}`]);
    });
    const equipment = await one<string>(db, "select code as r from plant.equipment order by code limit 1");
    await endSessions(db, adm.admin, adm.owner, coordinator);
    return { personNumber, equipment };
  });
  let n = 0;
  const publish: Record<System, () => Promise<number>> = {
    ERP: async () => (await sim(d.sims.ERP, 'POST', '/erp/v1/materials', { materialCode: `TEST-MAT-${tag}-${String(++n)}`, name: 'TEST demo excipient', baseUnit: 'kg', materialKind: 'EXCIPIENT' })).status,
    QMS: async () => (await sim(d.sims.QMS, 'POST', '/qms/v1/capas', { capaRef: `TEST-CAPA-${tag}-${String(++n)}`, title: 'TEST demo CAPA', status: 'OPEN', needsMasterChange: false, effectivenessDueDate: null })).status,
    LMS: async () => (await sim(d.sims.LMS, 'POST', '/lms/v1/qualifications', { personNumber: arranged.personNumber, qualificationCode: `TEST-SOP-${tag}-${String(++n % 12)}`, status: 'QUALIFIED', validFrom: (BigInt(nowUs()) - 86_400_000_000n).toString(), validTo: null })).status,
    CMMS: async () => (await sim(d.sims.CMMS, 'POST', '/cmms/v1/work-orders', { equipmentCode: arranged.equipment, workOrder: `TEST-WO-${tag}-${String(++n)}`, kind: 'PREVENTIVE', status: 'OPEN', dueOn: '2099-12-31' })).status,
  };
  const origin: Record<System, string> = { ERP: d.sims.ERP, QMS: d.sims.QMS, LMS: d.sims.LMS, CMMS: d.sims.CMMS };
  const db = (await import('@ebmr/test-kit')).openDatabase(e2e.state.databases.SANDBOX, 'SANDBOX');
  try {
    for (const s of ['ERP', 'QMS', 'LMS', 'CMMS'] as const) {
      const code = d.adapters[s];
      // The worker keeps n unique per system: the LMS cycles over 12 SOPs, each sent once per run below.
      await evidence.step(`${s}: a clean message reaches the eBMR through the adapter the server started`, 'Accepted (one inbound message more)', async () => {
        const before = await counts(db, code);
        expect(await publish[s]()).toBe(201);
        const after = await until(`${s} clean`, () => counts(db, code), (c) => c.accepted === before.accepted + 1, 60_000);
        return { adapter: code, acceptedBefore: before.accepted, acceptedAfter: after.accepted };
      });

      await evidence.step(`${s}: MALFORMED (the payload carries a field outside the contract)`, 'Refused as MALFORMED with an integration alarm; nothing of it lands', async () => {
        const before = await counts(db, code);
        await fault(origin[s], 'MALFORMED', true);
        expect(await publish[s]()).toBe(201);
        const after = await until(`${s} malformed`, () => counts(db, code), (c) => c.refused === before.refused + 1, 60_000);
        await fault(origin[s], 'MALFORMED', false);
        const row = await one<{ alarm: string | null; detail: string | null }>(db, 
          `select jsonb_build_object('alarm', x.alarm_id::text, 'detail', left(x.detail, 200)) as r from platform.inbound_exception x
            where x.adapter_code = $1 and x.kind = 'REFUSED' and x.error_class = 'MALFORMED' order by x.recorded_at desc limit 1`, [code]);
        expect(row.alarm).not.toBeNull();
        expect(after.accepted).toBe(before.accepted);
        return { errorClass: 'MALFORMED', refusal: row.detail, alarmId: row.alarm, malformedAlarms: alarmsOf(after, 'MALFORMED'), acceptedUnchanged: after.accepted === before.accepted };
      });

      await evidence.step(`${s}: DUPLICATE (every page delivers the last message again, same key and hash)`, 'The resend is de-duplicated (recorded, not applied twice); the new message is accepted once', async () => {
        const before = await counts(db, code);
        await fault(origin[s], 'DUPLICATE', true);
        expect(await publish[s]()).toBe(201);
        const after = await until(`${s} duplicate`, () => counts(db, code), (c) => c.accepted === before.accepted + 1 && c.dedup > before.dedup, 60_000);
        await fault(origin[s], 'DUPLICATE', false);
        return { deduplicatedBefore: before.dedup, deduplicatedAfter: after.dedup, acceptedNew: after.accepted - before.accepted, duplicateAlarms: alarmsOf(after, 'DUPLICATE') };
      });

      await evidence.step(`${s}: OUT_OF_ORDER (a page arrives in reverse order)`, 'An OUT_OF_ORDER integration alarm; each message accepted once, none lost', async () => {
        const before = await counts(db, code);
        await fault(origin[s], 'OUT_OF_ORDER', true);
        let sent = 0;
        let after = before;
        for (let attempt = 0; attempt < 4 && alarmsOf(after, 'OUT_OF_ORDER') === alarmsOf(before, 'OUT_OF_ORDER'); attempt++) {
          // Two messages back to back, so one page holds both (the worker pulls every 5 s).
          const [a, b] = await Promise.all([publish[s](), publish[s]()]);
          expect([a, b]).toEqual([201, 201]);
          sent += 2;
          after = await until(`${s} out of order`, () => counts(db, code), (c) => c.accepted + (c.refused - before.refused) >= before.accepted + sent, 60_000);
        }
        await fault(origin[s], 'OUT_OF_ORDER', false);
        expect(alarmsOf(after, 'OUT_OF_ORDER')).toBeGreaterThan(alarmsOf(before, 'OUT_OF_ORDER'));
        const alarm = await one<string>(db, "select id::text as r from platform.integration_alarm where adapter_code = $1 and kind = 'OUT_OF_ORDER' order by raised_at desc limit 1", [code]).catch(() => null);
        return { published: sent, accepted: after.accepted - before.accepted, refused: after.refused - before.refused, outOfOrderAlarms: alarmsOf(after, 'OUT_OF_ORDER'), alarmId: alarm };
      });

      await evidence.step(`${s}: LINK_CUT (the answer is cut off mid-transfer)`, 'Nothing of the cut page lands while the link is cut (a TRANSPORT failure, retried); once the link is back the message is accepted whole', async () => {
        const before = await counts(db, code);
        await fault(origin[s], 'LINK_CUT', true);
        expect(await publish[s]()).toBe(201);
        // Three of the worker's 5 s cycles with the link cut.
        await new Promise((r) => setTimeout(r, 16_000));
        const during = await counts(db, code);
        expect(during.accepted).toBe(before.accepted);
        await fault(origin[s], 'LINK_CUT', false);
        const after = await until(`${s} link back`, () => counts(db, code), (c) => c.accepted === before.accepted + 1, 60_000);
        // The database checks the payload against its hash on receipt (DI-31): what landed is the whole message.
        const last = await one<{ hash: string; record: string }>(db, "select jsonb_build_object('hash', payload_hash, 'record', source_record_id) as r from platform.inbound_message where adapter_code = $1 order by received_at desc, sequence_no desc limit 1", [code]);
        return { acceptedWhileCut: during.accepted - before.accepted, acceptedAfterLinkBack: after.accepted - before.accepted, transportAlarms: alarmsOf(after, 'TRANSPORT'), sourceRecord: last.record, payloadHash: last.hash };
      });

      await evidence.step(`${s}: reconciliation of the run (no silent loss)`, 'Distinct messages the source published = accepted + refused; every refusal has an alarm', async () => {
        const head = Number((await sim<{ head: string }>(origin[s], 'GET', '/api/state')).body.head);
        const c = await counts(db, code);
        const noAlarm = await one<number>(db, "select count(*)::int as r from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED' and alarm_id is null", [code]);
        expect(c.accepted + c.refused).toBe(head);
        expect(noAlarm).toBe(0);
        return { publishedBySource: head, accepted: c.accepted, refused: c.refused, deduplicated: c.dedup, refusalsWithoutAlarm: noAlarm, alarms: JSON.stringify(c.alarms) };
      });
    }

    await evidence.step('The four adapters after the faults (the integration health page is a GMP screen; the sandbox runs these adapters here, see the record)', 'Every adapter received and alarmed as above; the alarms are open for the system owners', async () => {
      const out: Record<string, string> = {};
      for (const s of ['ERP', 'QMS', 'LMS', 'CMMS'] as const) {
        const c = await counts(db, d.adapters[s]);
        out[s] = `adapter ${d.adapters[s]}: accepted ${String(c.accepted)}, refused ${String(c.refused)}, de-duplicated ${String(c.dedup)}, alarms ${JSON.stringify(c.alarms)}`;
        expect(c.accepted).toBeGreaterThan(0);
      }
      return out;
    });
  } finally {
    for (const s of ['ERP', 'QMS', 'LMS', 'CMMS'] as const) for (const f of ['MALFORMED', 'DUPLICATE', 'OUT_OF_ORDER', 'LINK_CUT']) await fault(origin[s], f, false).catch(() => undefined);
    await db.close();
  }
});

const LMS = 'LMS_QUALIFICATION';

/** The LMS mirror's bound (integration.mirror_max_age_s.lms_qualification), a change-controlled setting of the process owner. */
async function lmsBound(db: DatabaseHandle, seed: Parameters<typeof administration>[1], seconds: string): Promise<void> {
  const adm = await administration(db, seed);
  const changeRecord = await ensureChangeRecord(db);
  await withCommand(db.app, { ...because(adm.owner, `Demo: the LMS mirror's bound ${seconds} s`), changeRecord }, (c) => c.query('select platform.set_setting($1, $2)', ['integration.mirror_max_age_s.lms_qualification', seconds]));
  await endSessions(db, adm.admin, adm.owner);
}

test('[DI-31] a stale LMS mirror (the LMS stops confirming its feed; bound 60 s) refuses the operator\'s step signature at the kiosk, naming the stale qualification source; once the adapter synchronises again the same signature is accepted @demo', async ({ officePage, kioskPage, persona, e2e, evidence }, testInfo) => {
  test.setTimeout(600_000);
  const d = demoState();
  const author = await officePage('GMP', 'PC-DESIGN-01');
  await signIn.office(author, persona('GMP', 'author'));
  const pkg = await exportDcMiniPackage(author, e2e.state, packageTag(testInfo.parallelIndex + 1));
  await author.context().close();
  const office = await officePage('SANDBOX', 'TEST-PC-01');
  await signIn.office(office, persona('SANDBOX', 'issuer'));
  const base = e2e.url('SANDBOX');
  const runId = await issueTestBatch(office, base, pkg.packageHash);
  await office.context().close();

  const operator = persona('SANDBOX', 'operator1');
  const tag = letters(6).toUpperCase();
  const qual = `TEST-SOP-${tag}`;
  const personNumber = `TEST-EMP-${tag}`;
  // As the 6j-b stale-mirror flow: every other performer is trained INTERNAL in the same command, only this operator's
  // training comes from the LMS.
  const setup = await withDb(e2e, 'SANDBOX', async (db, seed) => {
    const adm = await administration(db, seed);
    const coordinator = await sessionOf(db, seed, await grantedPerson(db, seed, adm, 'TRAINING_COORDINATOR', 'Tara Coordinator'));
    await withCommand(db.admin, because(adm.admin, 'Employee number from the HR record (LMS key)', 'HR_RECORD'), (c) => c.query('update iam.person set employee_ref = $1 where id = $2', [personNumber, operator.personId]));
    await endSessions(db, adm.admin, adm.owner);
    const others = (await db.admin.query<{ person_id: string }>(
      "select distinct person_id from iam.role_grant where role_code in ('OPERATOR', 'DISPENSER') and status = 'APPROVED' and revoked_at is null and person_id <> $1", [operator.personId])).rows.map((r) => r.person_id);
    const requirementId = await withCommand(db.app, because(coordinator, 'product training of the demo product'), async (c) => {
      await c.query("select iam.create_qualification_type($1, 'Demo product training', 'Product SOP of the demo product, held in the LMS')", [qual]);
      for (const p of others) await c.query("select iam.record_qualification($1, $2, now() - interval '1 day', null)", [p, qual]);
      return (await c.query<{ id: string }>("select iam.add_qualification_requirement($1, null, 'STEP.SIGN_PERFORMED', $2::jsonb, 'Performers of the product are trained on its SOP (LMS)') as id", [qual, JSON.stringify({ product: pkg.productCode })])).rows[0]?.id ?? '';
    });
    return { coordinator, requirementId };
  });

  try {
    const sent = await withDb(e2e, 'SANDBOX', async (db, seed) => {
      expect((await sim(d.sims.LMS, 'POST', '/lms/v1/qualifications', { personNumber, qualificationCode: qual, status: 'QUALIFIED', validFrom: (BigInt(nowUs()) - 86_400_000_000n).toString(), validTo: null })).status).toBe(201);
      const landed = await until('the operator\'s LMS training', () => one<number>(db, "select count(*)::int as r from iam.person_qualification where person_id = $1 and qualification_code = $2 and source_code = 'LMS' and withdrawn_at is null", [operator.personId, qual]), (v) => v === 1, 60_000);
      await lmsBound(db, seed, '60');
      await fault(d.sims.LMS, 'STALE_MIRROR', true);
      const f = await until('the LMS mirror stale', () => one<{ stale: boolean; age: unknown }>(db, "select jsonb_build_object('stale', (platform.mirror_freshness('LMS_QUALIFICATION') ->> 'stale')::boolean, 'age', platform.mirror_freshness('LMS_QUALIFICATION') -> 'ageSeconds') as r"), (v) => v.stale, 150_000);
      return { landed, freshness: JSON.stringify(f) };
    });

    const page = await kioskPage('TEST-KIOSK-DISP-1');
    await signIn.kiosk(page, operator);
    await open(page, base, `/runs/${runId}/steps/${encodeURIComponent('p-disp-clear@')}`);
    const dialog = page.getByRole('dialog');
    await evidence.step('The LMS stops confirming its feed; after the 60 s bound the operator signs the booth clearance as performed', 'The ceremony refuses the signature and names the stale qualification source; nothing is signed', async () => {
      await startWithTap(page, operator);
      await recordClearanceEntries(page, operator);
      await page.getByTestId('primary-action').click();
      await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
      await tapBadge(page, operator);
      await pin.enter(page, operator.pin ?? '');
      await expect(dialog.getByRole('alert')).toContainText(`STALE_QUALIFICATION_SOURCE:${qual}`);
      await expect(dialog.getByText('Signed.', { exact: true })).toHaveCount(0);
      const text = (await dialog.getByRole('alert').innerText()).replace(/\s+/g, ' ');
      return { trainingLandedFromLms: sent.landed, mirror: sent.freshness, refusal: text.slice(0, 300) };
    }, page);
    await dialog.getByRole('button', { name: /^(Close|Cancel)$/ }).first().click();
    await expect(page.locator('[data-testid^="signature-"]')).toHaveCount(0);

    await withDb(e2e, 'SANDBOX', async (db) => {
      await fault(d.sims.LMS, 'STALE_MIRROR', false);
      await until('the LMS mirror fresh', () => one<boolean>(db, "select (platform.mirror_freshness('LMS_QUALIFICATION') ->> 'stale')::boolean as r"), (v) => !v, 60_000);
    });
    await evidence.step('The LMS confirms its feed again; the adapter synchronises within a cycle; the operator signs the same step', 'The signature is accepted and recorded', async () => {
      await open(page, base, `/runs/${runId}/steps/${encodeURIComponent('p-disp-clear@')}`);
      await page.getByTestId('primary-action').click();
      await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
      await tapBadge(page, operator);
      await pin.enter(page, operator.pin ?? '');
      await expect(dialog.getByText('Signed.', { exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(page.locator('[data-testid^="signature-"]').first()).toBeVisible();
      return { signatures: await page.locator('[data-testid^="signature-"]').count() };
    }, page);
  } finally {
    await fault(d.sims.LMS, 'STALE_MIRROR', false).catch(() => undefined);
    await withDb(e2e, 'SANDBOX', async (db, seed) => {
      await withCommand(db.app, because(setup.coordinator, 'end of the demo product training requirement'), (c) => c.query('select iam.end_qualification_requirement($1)', [setup.requirementId]));
      await lmsBound(db, seed, '3600');
      await endSessions(db, setup.coordinator);
    });
  }
});

export { LMS };
