/**
 * Phase 6 exit demo, item 2 (DI-49, DI-31, INV-40): a press excursion over OPC UA acknowledged with a comment in the
 * batch's alarm log.
 *
 * The OPC UA press simulator serves PRESS-01 (SignAndEncrypt); the GMP site gateway (its own process) holds the press's
 * enrolled endpoint and serves its OPC UA feed; the GMP server's OPCUA adapter (started by the server from its
 * service-keys file) pulls the feed. The press's Alarms-and-Conditions REJECT_BURST is switched on at the simulator
 * (its fault) and off again: the occurrence reaches the eBMR through the gateway with its source times and binds to the
 * batch using the press. Path used (D-P6j-b-3): the OPC UA alarm feed, not a tag-limit excursion over the gateway's
 * process uplink (the GMP installation has no gateway uplink listener; the demo records this).
 *
 * Arranged as the server tests arrange it (support.ts fixture: superuser, triggers off): the press is in use for the
 * DEMO-ONLY review batch of the set-up (an open equipment use on PRESS-01 after its verified cleaning), so the alarm binds
 * to that batch. The acknowledgment is the real kiosk screen (operator's badge tap), and the head of QC reads it in the
 * batch's alarm log on the review screen.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, signIn, test } from '../fixtures/index.ts';
import { tapBadge } from '../fixtures/floor.ts';
import { gmpKiosk } from '../fixtures/slice6.ts';
import { fixture, openTile, withDb } from '../specs/phase6/support.ts';
import { demoState, fault, one, until } from './demo-support.ts';

test('[DI-49][DI-31][INV-40] a press excursion over OPC UA (the press\'s REJECT_BURST through the site gateway) binds to the batch using the press and is acknowledged at the kiosk with the action taken and a comment, shown in the batch\'s alarm log @demo', async ({ browser, e2e, officePage, persona, evidence }) => {
  test.setTimeout(600_000);
  const d = demoState();
  const { batchId, batchNumber } = JSON.parse(readFileSync(join(e2e.state.keysDir, 'gmp-review-batch.json'), 'utf8')) as { batchId: string; batchNumber: string };

  const raised = await withDb(e2e, 'GMP', async (db, seed) => {
    await fixture(db, seed, 'the press in use for the review batch (demo)', async (c) => {
      await c.query(
        `insert into plant.equipment_use (equipment_id, batch_id, batch_ref, product_code, planned_end, cleaning_id, started_by)
         select e.id, $1, $2, (select o.product_code from plant.area_occupancy o where o.batch_id = $1 limit 1), clock_timestamp() + interval '8 hours',
                (select v.cleaning_id from plant.cleaning_verification v join plant.cleaning cl on cl.id = v.cleaning_id where cl.equipment_id = e.id limit 1),
                (select person_id from iam.account where login_name is not null limit 1)
           from plant.equipment e where e.code = $3`,
        [batchId, batchNumber, d.opcua.press]);
    });
    const aid = await one<string>(db, 'select id::text as r from iam.integration_adapter where code = $1', [d.opcua.adapterCode]);
    const session = await until('the OPC UA endpoint session', () => one<string | null>(db, 
      `select concat_ws(' ', s.endpoint_code, s.security_mode, s.security_policy, s.reported_location, array_to_string(s.equipment_codes, ','),
              case when s.certificate_thumbprint = d.key_fingerprint then 'enrolled-certificate' else 'other-certificate' end) as r
         from plant.opcua_endpoint_session s join iam.device d on d.id = s.device_id where s.adapter_id = $1 and s.verdict = 'VALID' limit 1`, [aid]), (v) => v !== null, 120_000);
    const burst = (): Promise<{ id: string; cleared: boolean } | null> => one<{ id: string; cleared: boolean } | null>(db, 
      `select jsonb_build_object('id', a.id::text, 'cleared', a.cleared_source_us is not null) as r from plant.alarm_status a join plant.equipment e on e.id = a.equipment_id
        where a.source = 'OPCUA' and a.alarm_code = 'REJECT_BURST' and e.code = $1 order by a.raised_source_us desc limit 1`, [d.opcua.press]);
    await fault(d.opcua.simConsole, 'REJECT_BURST', true);
    const a = await until('the reject-burst occurrence', burst, (v) => v !== null, 120_000);
    await fault(d.opcua.simConsole, 'REJECT_BURST', false);
    await until('the reject burst cleared', burst, (v) => v?.cleared === true, 120_000);
    const alarmId = a?.id ?? '';
    const facts = await one<Record<string, string | boolean | null>>(db, 
      `select jsonb_build_object('alarmCode', a.alarm_code, 'severity', a.severity::text, 'gmpCritical', a.gmp_critical, 'raisedSourceUs', a.raised_source_us::text,
              'clearedSourceUs', a.cleared_source_us::text, 'boundToBatch', exists (select 1 from plant.alarm_batch b where b.alarm_id = a.id and b.batch_id = $2)) as r
         from plant.alarm_status a where a.id = $1`, [alarmId, batchId]);
    return { alarmId, session, facts };
  });
  expect(raised.facts['boundToBatch']).toBe(true);

  const operator = persona('GMP', 'operator1');
  const action = 'Checked the reject bin and the press discharge; the rejects were set aside and the run continued';
  const comment = 'Reject burst of the press during compression; no tablet out of limits reached the containers';
  const kiosk = await gmpKiosk(browser, e2e, 'KIOSK-COMP-1');
  await signIn.kiosk(kiosk, operator);
  await evidence.step('The press raises REJECT_BURST over OPC UA (through the GMP site gateway); the operator opens the plant alarms at the compression kiosk', 'The OPC UA alarm of PRESS-01 is listed, cleared at source, bound to the batch using the press', async () => {
    await openTile(kiosk, 'Plant alarms');
    const row = kiosk.getByTestId(`alarm-${raised.alarmId}`);
    await expect(row).toContainText('REJECT_BURST');
    await expect(row).toContainText(batchNumber);
    return { alarmId: raised.alarmId, endpointSession: raised.session, ...raised.facts };
  }, kiosk);

  await evidence.step('Acknowledge it with the action taken, a comment and the operator\'s badge tap', 'The alarm is acknowledged and leaves the open list', async () => {
    const row = kiosk.getByTestId(`alarm-${raised.alarmId}`);
    await row.getByRole('button', { name: 'Acknowledge', exact: true }).click();
    const dialog = kiosk.getByRole('dialog', { name: 'Acknowledge REJECT_BURST' });
    await dialog.getByRole('textbox', { name: /^Action taken/ }).fill(action);
    await dialog.getByRole('textbox', { name: /^Comment/ }).fill(comment);
    await dialog.getByRole('button', { name: 'Acknowledge the alarm' }).click();
    await tapBadge(kiosk, operator);
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(0);
  }, kiosk);
  await kiosk.context().close();

  const qa = await officePage('GMP', 'PC-QA-01');
  await signIn.office(qa, persona('GMP', 'qcApprover'));
  await evidence.step('The head of QC opens the review of the batch', 'The batch\'s alarm log lists the OPC UA alarm with the acknowledgment: who, the action taken and the comment', async () => {
    await openTile(qa, 'Batch record review');
    await qa.getByTestId(`review-batch-${batchNumber}`).getByRole('link', { name: batchNumber }).click();
    const log = qa.getByTestId('batch-alarm-log');
    const row = log.getByTestId(`batch-alarm-${raised.alarmId}`);
    await row.scrollIntoViewIfNeeded();
    await expect(row).toContainText('REJECT_BURST');
    await expect(row.getByTestId(`ack-${raised.alarmId}`)).toContainText(`${operator.legalName}: ${action}. Comment: ${comment}`);
    const ack = await withDb(e2e, 'GMP', (db) => one<Record<string, string>>(db, 
      "select jsonb_build_object('acknowledgedAt', k.acked_at::text, 'acknowledgedBy', p.legal_name) as r from plant.alarm_ack k join iam.person p on p.id = k.person_id where k.alarm_id = $1", [raised.alarmId]).catch(() => ({})));
    return { batch: batchNumber, ...ack };
  }, qa);
});
