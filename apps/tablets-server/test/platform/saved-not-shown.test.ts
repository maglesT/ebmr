/**
 * Owner observation O-T13-1 (Phase 7 slice 7b-1; message accuracy, no control): a route that commits its command and then
 * reads its answer outside it said "Nothing was saved" when only the read failed. The route binder now answers
 * SAVED_NOT_SHOWN ("Saved; the result could not be shown"), naming the command by its idempotency key, when the request's
 * latest command committed (platform/db/commands.ts command scope, platform/http/bind.ts savedNotShown).
 */
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personaIn, refusalOf, tapFor, valueOf } from '../esig/support.ts';
import { adapterActor, adapterIdentity } from '../integrations/erp-wms/support.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { laterReads } from './later-read-scan.ts';

/** Every route whose handler commits with withIdempotentActorCommand and then reads its answer (the scan below). */
const LATER_READ_ROUTES = [
  'features/alarms/index.ts#acknowledge',
  'features/analytics/index.ts#dispose',
  'features/analytics/index.ts#setMethodVersion',
  'features/analytics/index.ts#setReferenceSet',
  'features/archive/index.ts#assembleExport',
  'features/archive/index.ts#formEvent',
  'features/archive/index.ts#issuePack',
  'features/archive/index.ts#syncRetention',
  'features/config-change/index.ts#closeChangeRecord',
  'features/config-change/index.ts#raiseChangeRecord',
  'features/config-change/index.ts#setRbeRule',
  'features/config-change/index.ts#setSetting',
  'features/designer/index.ts#createFamily',
  'features/designer/index.ts#justify',
  'features/designer/index.ts#saveContent',
  'features/designer/index.ts#startVerification',
  'features/designer/index.ts#testPackage',
  'features/esig/index.ts#createChallenge',
  'features/execution/index.ts#importPackage',
  'features/execution/index.ts#issue',
  'features/execution/index.ts#issueSscc',
  'features/execution/index.ts#proposeAct',
  'features/genealogy/index.ts#refreshFederation',
  'features/genealogy/index.ts#run',
  'features/governance/index.ts#grantAccess',
  'features/governance/index.ts#requestGrant',
  'features/governance/index.ts#revokeAccess',
  'features/governance/index.ts#revokeGrant',
  'features/india/index.ts#recordExportPermission',
  'features/india/index.ts#recordHazard',
  'features/india/index.ts#recordLicence',
  'features/india/index.ts#recordShelfLifeBasis',
  'features/india/index.ts#suspendExportPermission',
  'features/india/index.ts#suspendLicence',
  'features/integrations/index.ts#acknowledgeAlarm',
  'features/master-data/index.ts#addFormulaVersion',
  'features/master-data/index.ts#createFormula',
  'features/notifications/index.ts#acknowledge',
  'features/plant-rules/index.ts#classifyBetaLactam',
  'features/plant-rules/index.ts#recordAreaAuthorisation',
  'features/plant-rules/index.ts#recordReagentLot',
  'features/plant-rules/index.ts#recordSpill',
  'features/plant-rules/index.ts#setFacilityRule',
  'features/plant-rules/index.ts#setRoomRule',
  'features/plant-rules/index.ts#withdrawAreaAuthorisation',
  'features/plant-rules/index.ts#withdrawReagentLot',
  'features/pqr/index.ts#run',
  'features/qp-package/index.ts#assemble',
  'features/qp-package/index.ts#grantAccess',
  'features/qp-package/index.ts#revokeAccess',
  'features/quality/index.ts#cancelDeviation',
  'features/quality/index.ts#linkDeviation',
  'features/quality/index.ts#raiseDeviation',
  'features/quality/index.ts#receiveLot',
  'features/quality/index.ts#recordFinding',
  'features/quality/index.ts#recordLotResult',
  'features/quality/index.ts#registerEvidenceDocument',
  'features/quality/index.ts#startInvestigation',
  'features/quality/lims.ts#assessReturn',
  'features/quality/lims.ts#dispose',
  'features/quality/lims.ts#draft',
  'features/quality/lims.ts#postFinishedLot',
  'features/quality/lims.ts#proposeLotDecision',
  'features/quality/lims.ts#pull',
  'features/quality/lims.ts#receiveReturn',
  'features/quality/lims.ts#recoverReturn',
  'features/records/index.ts#appendAmendmentEntry',
  'features/records/index.ts#closeBulk',
  'features/records/index.ts#setBrightStockHold',
  'features/release/index.ts#acknowledge',
  'features/release/index.ts#qpMessage',
  'features/review/index.ts#openItem',
  'features/review/index.ts#recordAbortChecklist',
  'features/review/index.ts#recordTranslation',
  'features/review/index.ts#register',
  'features/review/index.ts#respond',
  'features/review/index.ts#verifyTranslation',
  'features/serialisation/index.ts#rejectPool',
  'features/training/index.ts#completeStep',
  'features/training/index.ts#start',
  'features/transfers/index.ts#acknowledgeAlarm',
  'features/transfers/index.ts#import',
  'features/transfers/index.ts#prepare',
  'features/transfers/index.ts#proposePeer',
];

describe('a committed command whose answer could not be read (O-T13-1)', () => {
  it('[meta] O-T13-1: every route built on withIdempotentActorCommand with a later read is listed, bound through bindRoutes, and runs no command the scope does not see after it', () => {
    const found = laterReads(fileURLToPath(new URL('../../src', import.meta.url)));
    expect(found.map((r) => r.route)).toEqual(LATER_READ_ROUTES);
    expect(found.filter((r) => !r.bound)).toEqual([]);
    expect(found.filter((r) => r.untracked.length > 0)).toEqual([]);
  });

  describe('through a route', () => {
    let gmp: TestServer;
    let alarmId = '';
    beforeAll(async () => {
      gmp = await startServer('GMP');
      const erp = await adapterIdentity(gmp, 'ERP');
      const actor = await adapterActor(gmp, erp);
      const payload = { garbled: true };
      const envelope = {
        sourceSystem: 'ERP_WMS', messageType: 'erp.material_master', sourceRecordId: 'MM-1', sourceTimestamp: '1800000000000000', sequenceNo: '1',
        idempotencyKey: `k-${randomUUID()}`, schemaVersion: '1', payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), payload,
      };
      const refused = await withCommand(gmp.db.app, { ...actor, correlationId: randomUUID() }, async (c) =>
        (await c.query<{ id: string }>("select platform.record_inbound_refusal($1::jsonb, 'MALFORMED', 'EBMR-ERP-001 malformed erp.material_master payload') as id", [JSON.stringify(envelope)])).rows[0]?.id ?? '');
      alarmId = (await gmp.db.app.query<{ a: string }>('select alarm_id::text as a from platform.inbound_exception where id = $1', [refused])).rows[0]?.a ?? '';
    }, 300_000);
    afterAll(async () => {
      await gmp?.close();
    });

    it('[meta] O-T13-1: when only the read after the commit fails, the answer says it was saved and names the command; the resend shows the result', async () => {
      const kiosk = await gmp.asPersona('operator1');
      const path = `/api/integrations/alarms/${alarmId}/acknowledge`;
      const body = { note: 'Malformed master record: ERP team resends it' };
      const idempotencyKey = randomUUID();
      const pool = gmp.db.app;
      const query = pool.query.bind(pool);
      let broken = 0;
      // The alarm read after the command fails once (the command runs on its own connection, not through pool.query).
      pool.query = ((text: unknown, ...rest: unknown[]) => {
        if (broken === 0 && typeof text === 'string' && text.includes('from platform.integration_alarm x join iam.integration_adapter')) {
          broken += 1;
          return Promise.reject(new Error('connection terminated unexpectedly'));
        }
        return (query as (...a: unknown[]) => unknown)(text, ...rest);
      }) as typeof pool.query;
      let answer;
      try {
        answer = await kiosk.call(routes.integrations.acknowledgeAlarm, { params: { alarmId }, body, idempotencyKey, attribution: await tapFor(kiosk, personaIn(gmp, 'operator1'), 'POST', path, body) });
      } finally {
        pool.query = query;
      }
      expect(broken).toBe(1);
      const r = refusalOf(answer);
      expect(r).toMatchObject({ status: 500, code: 'SAVED_NOT_SHOWN', kind: 'STALE' });
      expect(JSON.stringify(r)).toContain('Saved; the result could not be shown');
      expect(JSON.stringify(r)).not.toContain('Nothing was saved');
      expect(JSON.stringify(r)).toContain(idempotencyKey);
      // It was saved: the acknowledgment is in the database, once.
      expect((await gmp.db.app.query<{ n: string }>('select count(*)::text as n from platform.integration_alarm_ack where alarm_id = $1', [alarmId])).rows[0]?.n).toBe('1');
      // The same request again (same key) is answered from the stored result, now with the alarm view.
      const again = valueOf(await kiosk.call(routes.integrations.acknowledgeAlarm, { params: { alarmId }, body, idempotencyKey, attribution: await tapFor(kiosk, personaIn(gmp, 'operator1'), 'POST', path, body) }));
      expect(again).toMatchObject({ alarmId, acknowledgement: { note: body.note } });
    });

    it('[meta] O-T13-1: a failure of the command itself still says nothing was saved', async () => {
      const kiosk = await gmp.asPersona('operator1');
      const path = `/api/integrations/alarms/${alarmId}/acknowledge`;
      const body = { note: 'a second acknowledgment' };
      const r = refusalOf(await kiosk.call(routes.integrations.acknowledgeAlarm, { params: { alarmId }, body, attribution: await tapFor(kiosk, personaIn(gmp, 'operator1'), 'POST', path, body) }));
      expect(r?.status).toBe(409);
      expect(r?.code).not.toBe('SAVED_NOT_SHOWN');
    });
  });
});
