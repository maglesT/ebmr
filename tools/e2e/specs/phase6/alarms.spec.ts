/**
 * Phase 6 exit (slice 6j-b), a plant alarm acknowledged with a comment in the batch's alarm log (DI-49; INV-40):
 * the EMS reports a humidity excursion of room DISP-1 through its registered adapter (plant.receive_equipment_alarm, the
 * EMS adapter's command); the eBMR binds it to the batch occupying the room (the DEMO-ONLY review batch of the set-up) and,
 * as an unconfigured alarm code, treats it as GMP-critical. On the plant alarm list the operator at the DISP-1 kiosk
 * acknowledges it with the action taken; the button stays disabled until the comment a GMP-critical alarm needs is given,
 * and the shared kiosk asks for the operator's fresh badge tap. QA then reads the acknowledgment (person, action and
 * comment) in the batch's alarm log on the review screen. The adapter is arranged in the database (support.ts); no EMS
 * worker runs on the E2E stack. The spec acknowledges the alarm it raised, so the review gate of that batch is unchanged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { axe, cspViolations, expect, signIn, test } from '../../fixtures/index.ts';
import { tapBadge } from '../../fixtures/floor.ts';
import { gmpKiosk } from '../../fixtures/slice6.ts';
import { administration, endSessions, envelope, occupancyWindow, receive, registerAdapter, withDb } from './support.ts';

test('[DI-49][INV-40] an EMS room alarm bound to the batch in the room is acknowledged at the kiosk with the action taken and the comment a GMP-critical alarm needs, and shows so in the batch\'s alarm log @office', async ({ browser, e2e, officePage, persona, evidence }) => {
  const { batchId, batchNumber } = JSON.parse(readFileSync(join(e2e.state.keysDir, 'gmp-review-batch.json'), 'utf8')) as { batchId: string; batchNumber: string };
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const message = `Room humidity above 60 %RH (E2E ${tag})`;
  const raised = await withDb(e2e, 'GMP', async (db, seed) => {
    const adm = await administration(db, seed);
    const ems = await registerAdapter(db, seed, adm, 'EMS');
    await endSessions(db, adm.admin, adm.owner);
    // The excursion happened while the batch occupied DISP-1 (the set-up's occupancy, since ended); the EMS reports it with
    // its source time, which is what binds it to the batch.
    const w = await occupancyWindow(db, batchId, 'DISP-1');
    const payload = {
      subjectKind: 'AREA', subjectCode: 'DISP-1', occurrenceId: `EMS-E2E-${tag}`, transition: 'RAISED', alarmCode: 'RH_HIGH', severity: '500',
      tag: 'room.rh_pct', value: { value: '61.2', unit: '%RH' }, limit: { value: '60.0', unit: '%RH' }, limitKind: 'HIGH', message, occurredAt: ((w.fromUs + w.toUs) / 2n).toString(),
    };
    return receive(db, ems, 'plant.receive_equipment_alarm', envelope(ems, 'ems.alarm', payload));
  });
  expect(raised).toMatchObject({ outcome: 'ACCEPTED' });
  const alarmId = String(raised['alarmId']);

  const operator = persona('GMP', 'operator1');
  const kiosk = await gmpKiosk(browser, e2e, 'KIOSK-DISP-1');
  await signIn.kiosk(kiosk, operator);
  const action = 'Dehumidifier checked and restarted; RH back below 60 %RH within 5 min';
  const comment = 'Materials of the batch were in closed containers throughout the excursion';

  await evidence.step('The operator opens the plant alarms at the DISP-1 kiosk', 'The EMS alarm of DISP-1 is open, GMP-critical, with its reading against the limit and the batch it is bound to', async () => {
    await kiosk.goto(`${e2e.url('GMP')}/alarms`);
    await expect(kiosk.getByRole('heading', { name: 'Plant alarms', level: 1 })).toBeVisible();
    const row = kiosk.getByTestId(`alarm-${alarmId}`);
    await expect(row).toHaveAttribute('data-gmp-critical', 'true');
    await expect(row).toContainText(`EMS RH_HIGH: ${message}`);
    await expect(row).toContainText('61.2 %RH against High limit 60.0 %RH');
    await expect(row).toContainText('Not cleared');
    await expect(row).toContainText(batchNumber);
    return { gmpCritical: await row.getAttribute('data-gmp-critical') };
  }, kiosk);

  await evidence.step('Acknowledge it with the action taken, the comment and the operator\'s badge tap', 'Without the comment the act stays disabled; with it, the alarm is acknowledged by the operator and leaves the open list', async () => {
    const row = kiosk.getByTestId(`alarm-${alarmId}`);
    await row.getByRole('button', { name: 'Acknowledge', exact: true }).click();
    const dialog = kiosk.getByRole('dialog', { name: 'Acknowledge RH_HIGH' });
    await dialog.getByRole('textbox', { name: /^Action taken/ }).fill(action);
    const send = dialog.getByRole('button', { name: 'Acknowledge the alarm' });
    await expect(send).toBeDisabled();
    await dialog.getByRole('textbox', { name: /^Comment \(required: GMP-critical alarm\)/ }).fill(comment);
    await expect(send).toBeEnabled();
    await send.click();
    await tapBadge(kiosk, operator);
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(0);
  }, kiosk);
  expect(await cspViolations(kiosk)).toEqual([]);
  await kiosk.context().close();

  const qa = await officePage('GMP', 'PC-QA-01');
  await signIn.office(qa, persona('GMP', 'qaInvestigator'));
  await evidence.step('QA opens the review of the batch', 'The batch\'s alarm log lists the alarm with its source times and the acknowledgment: who, the action taken and the comment', async () => {
    await qa.goto(`${e2e.url('GMP')}/review/${batchId}`);
    const log = qa.getByTestId('batch-alarm-log');
    await expect(log.getByRole('heading', { name: 'Alarm log of the batch' })).toBeVisible();
    const row = log.getByTestId(`batch-alarm-${alarmId}`);
    await expect(row).toContainText(`EMS DISP-1 RH_HIGH: ${message}`);
    await expect(row.getByTestId(`ack-${alarmId}`)).toContainText(`${operator.legalName}: ${action}. Comment: ${comment}`);
    await axe.check(qa);
    return { acknowledgedBy: operator.legalName };
  }, qa);
  expect(await cspViolations(qa)).toEqual([]);
});
