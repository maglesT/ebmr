import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { dcMini, importAndIssue, RunDriver, startExecServer, valueOf, writePackage, type ExecServer } from './support.ts';

let server: ExecServer;
beforeAll(async () => { server = await startExecServer(); vi.useFakeTimers({ toFake: ['performance'] }); }, 120_000);
afterAll(async () => { vi.useRealTimers(); await server?.close(); });

it('dump', async () => {
  const issuer = await server.asPersona('issuer');
  const runId = await importAndIssue(server, issuer, writePackage(server, dcMini()));
  const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1'), verifier1: await server.asPersona('verifier1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  for (const k of ['p-disp-clear@', 'p-disp-bal@', 'p-disp-sop@', 'p-disp-calc@']) {
    await d.ok('operator1', { type: 'START_STEP', stepKey: k });
    if (k === 'p-disp-clear@') {
      await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: k, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
      await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: k, entry: { kind: 'PREVIOUS_BATCH', product: 'X', batchNumber: 'TEST-B26-9999' } });
    }
    if (k === 'p-disp-bal@') await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: k, entry: { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'L', answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' as const })) } });
    if (k === 'p-disp-sop@') await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: k, entry: { kind: 'ACKNOWLEDGE', mode: 'READ' } });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: k });
    if (k === 'p-disp-clear@') await d.signed('verifier1', { type: 'VERIFY', stepKey: k, meaning: 'VERIFIED' });
  }
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-pcm@' });
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-pcm@', entry: { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', manual: { gross: '26.250', tare: '1.250', unit: 'kg' } } });
  const view = await d.stepView('operator1', 'p-disp-pcm@');
  const b = d.browser('operator1');
  const content = valueOf(await b.call(routes.esig.content, { query: { aggregateType: 'batch_step', aggregateId: `${runId}:p-disp-clear@`, intent: 'LINE_CLEARANCE_VERIFIED' } }));
  const run = await d.runView('operator1');
  const tl = valueOf(await b.call(routes.execution.timeline, { params: { runId } }));
  const wq = valueOf(await b.call(routes.execution.workQueue));
  writeFileSync('/tmp/claude-0/-home-user/0f393df3-64ef-5de6-9328-48ce9ce2b1a5/scratchpad/views.json', JSON.stringify({ view, content, run, tl, wq }, null, 1));
}, 300_000);
