/**
 * Free text of a test run that no record can hold (review F30, F31; DI-37, DI-34): U+0000, which PostgreSQL text and
 * jsonb refuse, and a UTF-16 surrogate without its other half, which jsonb refuses and UTF-8 encoding silently turns
 * into U+FFFD. Before the fix every such text in a free-text field of an intent (an exception's description, a previous
 * product or batch number, a deviation number, a hold reason, a TEXT value, an id the engine's refusal repeats) reached
 * a jsonb bind and was answered 500 INTERNAL with no refused row; a hold reason with U+0000 was even accepted and stored
 * escaped; the e-signature preview hashed a disposition justification or hold-point comment holding it, and the
 * challenge then failed with 500.
 *
 * Now the contract (defineRoute: storableText) refuses such text in every route's params, query and body, at any depth,
 * as 400 INVALID_INPUT naming the field and never echoing the text; the preview refuses it in the decision it decodes
 * (parseIntent), and bytes that are not UTF-8 there too. A kiosk cannot even build its tap over such a body: canonical
 * JSON refuses the text (F31). These requests are sent without a tap: the contract refuses them before the tap is
 * asked for. Adversarial text that a record can hold still goes through every challenge and append with hashes that
 * agree in TypeScript and SQL.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes, type ClientIntent, type Result, type SignedIntent } from '@ebmr/api-contract';
import { engine, execution, type flow } from '@ebmr/recipe-core';
import { runContext } from '../../src/features/execution/runs.ts';
import { personaIn, tapFor } from '../esig/support.ts';
import { decisionPreviewIntent, previewDecision, signDecision } from './signed-content-support.ts';
import {
  dcMini,
  dcMiniVariant,
  importAndIssue,
  outcomeOf,
  rowsOf,
  RunDriver,
  startExecServer,
  violations,
  withEarlyHoldPoint,
  writePackage,
  type ExecServer,
} from './support.ts';

let server: ExecServer;
beforeAll(async () => {
  server = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await server?.close();
});

type Json = Record<string, unknown>;
const CLEAR = 'p-disp-clear@';

async function driver(content: flow.MbrContent = dcMini(), personas = ['operator1', 'verifier1', 'supervisor1', 'qa1']): Promise<RunDriver> {
  const issuer = await server.asPersona('issuer');
  const runId = await importAndIssue(server, issuer, writePackage(server, content));
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer };
  for (const p of personas) browsers[p] = await server.asPersona(p);
  const d = new RunDriver(server, runId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

/** An intent as the browser sends it, without a tap (the contract refuses it before any tap is asked for). */
async function untapped(d: RunDriver, persona: string, intent: unknown) {
  return d.browser(persona).call(routes.execution.command, { params: { runId: d.runId }, body: { expectedVersion: await d.version(persona), intent: intent as ClientIntent } });
}

/** The refusal of a call: status, code, kind and why. */
function refusalOf(r: Result<unknown>): { status: number; code: string; kind: string; why: string } {
  if (r.ok || r.error.kind !== 'REFUSAL') throw new Error(`expected a refusal, got ${r.ok ? 'ok' : r.error.kind}`);
  const { refusal } = r.error.envelope;
  return { status: r.error.status, code: refusal.code, kind: refusal.kind, why: refusal.why };
}

/** A clean INVALID_INPUT refusal that names `field` and what it holds, and never repeats the text sent. */
function expectNamed(r: Result<unknown>, field: string, holds: string, sent: string): void {
  const f = refusalOf(r);
  expect({ status: f.status, code: f.code, kind: f.kind }, field).toEqual({ status: 400, code: 'SCHEMA', kind: 'INVALID_INPUT' });
  expect(f.why, field).toContain(`${field} holds ${holds}, which no record can hold`);
  expect(f.why.includes(sent), `${field}: the refusal does not repeat the text`).toBe(false);
}

const b64 = (x: unknown): string => Buffer.from(JSON.stringify(x), 'utf8').toString('base64url');

describe('free text no record can hold, in a test run (review F30, F31)', () => {
  it('[DI-37][DI-34] a plain intent whose free text holds U+0000 or a lone surrogate is refused 400 INVALID_INPUT naming the field; nothing is recorded and the run stays where it was', async () => {
    const d = await driver();
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: undefined, description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
    const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId ?? '';
    expect(exception).not.toBe('');
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    const versionBefore = await d.version('operator1');
    const cases: { persona: string; intent: Json; field: string; holds: string; sent: string }[] = [
      { persona: 'operator1', intent: { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door\u0000 found open', severity: 'ALERT' }, field: '/intent/description', holds: 'U+0000', sent: 'Booth door' },
      { persona: 'operator1', intent: { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door \ud800 found open', severity: 'ALERT' }, field: '/intent/description', holds: 'an unpaired surrogate U+D800', sent: 'Booth door' },
      { persona: 'operator1', intent: { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT\u0000X', batchNumber: 'TEST-B26-9999' } }, field: '/intent/entry/product', holds: 'U+0000', sent: 'TEST-PRODUCT' },
      { persona: 'operator1', intent: { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-\udc00' } }, field: '/intent/entry/batchNumber', holds: 'an unpaired surrogate U+DC00', sent: 'TEST-B26-' },
      { persona: 'supervisor1', intent: { type: 'ATTACH_DEVIATION', exception, deviationRef: 'TEST-DEV-\u00000001' }, field: '/intent/deviationRef', holds: 'U+0000', sent: 'TEST-DEV-' },
      { persona: 'supervisor1', intent: { type: 'HOLD_BATCH', holdType: 'SUPERVISOR', reason: 'Line stop \ud83d' }, field: '/intent/reason', holds: 'an unpaired surrogate U+D83D', sent: 'Line stop' },
      // Accepted and stored escaped ({"$s": "Line stop%00 for checks"}) before the fix: now refused as every other free text.
      { persona: 'supervisor1', intent: { type: 'HOLD_BATCH', holdType: 'SUPERVISOR', reason: 'Line stop\u0000 for checks' }, field: '/intent/reason', holds: 'U+0000', sent: 'Line stop' },
      // Ids the engine's refusal would repeat (its refusal is stored as jsonb).
      { persona: 'supervisor1', intent: { type: 'ATTACH_DEVIATION', exception: 'E-\u00009', deviationRef: 'TEST-DEV-0001' }, field: '/intent/exception', holds: 'U+0000', sent: 'E-' },
      { persona: 'operator1', intent: { type: 'RAISE_EXCEPTION', stepKey: 'p-disp-clear\u0000@', description: 'Booth door found open', severity: 'ALERT' }, field: '/intent/stepKey', holds: 'U+0000', sent: 'p-disp-clear' },
    ];
    for (const c of cases) expectNamed(await untapped(d, c.persona, c.intent), c.field, c.holds, c.sent);
    // A kiosk could not have sent them with a tap: the tap's proof hashes the body, and canonical JSON refuses such text.
    const operator = d.browser('operator1');
    await expect(tapFor(operator, personaIn(server, 'operator1'), 'POST', `/api/test-runs/${d.runId}/commands`, { expectedVersion: versionBefore, intent: cases[0]?.intent })).rejects.toThrow(
      'text holding U+0000 has no canonical JSON form: no record can hold it',
    );
    expect((await rowsOf(server, d.runId)).length, 'no row, accepted or refused, was written').toBe(rowsBefore);
    expect(await d.version('operator1')).toBe(versionBefore);
    const { rows } = await server.db.admin.query<{ holds: unknown }>("select s.state -> 'holds' as holds from recipe.execution_state s where s.batch_id = $1", [d.runId]);
    expect(rows[0]?.holds).toEqual({});
    // The same intent with text a record can hold is taken.
    expect(outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found open', severity: 'ALERT' }))).toBe('ok');
  }, 300_000);

  it('[DI-17][DI-34] an attempt the person may not make, holding U+0000, is refused at the contract like any malformed request, before any authority is evaluated; the clean attempt is refused and logged as denied', async () => {
    const d = await driver();
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: undefined, description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
    const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId ?? '';
    const operatorId = (await d.runView('operator1')).header.identity?.personId ?? '';
    const denied = async (): Promise<number> => {
      const { rows } = await server.db.admin.query<{ n: string }>('select count(*)::text as n from iam.authority_evaluation where person_id = $1 and not allowed', [operatorId]);
      return Number(rows[0]?.n);
    };
    const n0 = await denied();
    expect(outcomeOf(await d.command('operator1', { type: 'ATTACH_DEVIATION', exception, deviationRef: 'TEST-DEV-0002' }))).toBe('422:EBMR-IAM-040');
    const n1 = await denied();
    expect(n1).toBe(n0 + 1);
    expectNamed(await untapped(d, 'operator1', { type: 'ATTACH_DEVIATION', exception, deviationRef: 'TEST-DEV-\u00000002' }), '/intent/deviationRef', 'U+0000', 'TEST-DEV-');
    // Like a deviation number over 128 characters: never 500, and nothing is evaluated for a request the contract refuses.
    expect(await denied()).toBe(n1);
  }, 300_000);

  it('[DI-37][PR-49] a disposition justification holding U+0000 or a lone surrogate: the preview refuses it naming the member, so the signer is never offered its hash; the challenge refuses it at the contract; nothing is proposed', async () => {
    const d = await driver();
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: undefined, description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
    const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId ?? '';
    const aggregate = { aggregateType: 'batch_exception', aggregateId: `${d.runId}:${exception}` };
    const qa = d.browser('qa1');
    const preview = (intent: string) => qa.call(routes.esig.content, { query: { ...aggregate, intent } });
    const proposals = async (): Promise<number> => Number((await server.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.execution_disposition_proposal where batch_id = $1', [d.runId])).rows[0]?.n);
    const before = await proposals();
    for (const [justification, holds] of [
      ['Reprinted\u0000 label checked', 'U+0000'],
      ['Reprinted label checked \udfff', 'an unpaired surrogate U+DFFF'],
    ] as const) {
      const r = refusalOf(await preview(`EXCEPTION_DISPOSITIONED|${b64({ outcome: 'NO_IMPACT', justification })}`));
      expect({ status: r.status, code: r.code, kind: r.kind }).toEqual({ status: 400, code: 'SCHEMA', kind: 'INVALID_INPUT' });
      expect(r.why).toBe(`The justification holds ${holds}, which no record can hold: enter the text again without it.`);
    }
    // Bytes that are not UTF-8 are refused, never read as U+FFFD: 'Reprinted ' then the lone byte 0xFF.
    const bytes = Buffer.concat([Buffer.from('{"outcome":"NO_IMPACT","justification":"Reprinted ', 'utf8'), Buffer.from([0xff]), Buffer.from('"}', 'utf8')]);
    expect(outcomeOf(await preview(`EXCEPTION_DISPOSITIONED|${bytes.toString('base64url')}`))).toBe('400:SCHEMA');
    // A challenge sent without a preview carries the justification in its action: the contract refuses it.
    const clean = await preview(`EXCEPTION_DISPOSITIONED|${b64({ outcome: 'NO_IMPACT', justification: 'Reprinted label checked' })}`);
    if (!clean.ok) throw new Error('the clean preview was refused');
    const intent: SignedIntent = { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: 'Reprinted\u0000 label checked' };
    const challenge = await qa.call(routes.esig.createChallenge, {
      body: { ...aggregate, contentVersion: clean.value.contentVersion, meaning: 'EXCEPTION_DISPOSITIONED', clientContentHash: clean.value.contentHash, action: { kind: 'ENGINE_COMMAND', runId: d.runId, expectedVersion: await d.version('qa1'), intent } },
    });
    expectNamed(challenge, '/action/intent/justification', 'U+0000', 'Reprinted');
    expect(await proposals()).toBe(before);
    // The same disposition with text a record can hold is signed.
    expect(outcomeOf((await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: 'Reprinted label checked' })).result)).toBe('ok');
  }, 300_000);

  it('[DI-37][PR-45] a hold-point comment holding U+0000: the preview and the challenge refuse it naming the member; nothing is proposed; a clean comment is signed', async () => {
    const d = await driver(withEarlyHoldPoint(), ['operator1', 'verifier1', 'qa1']);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
    const decisions = async (): Promise<number> => Number((await server.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.execution_decision_proposal where batch_id = $1', [d.runId])).rows[0]?.n);
    const before = await decisions();
    const bad = { type: 'DISPOSITION_HOLD_POINT' as const, stepKey: 'H-TEST@', disposition: 'APPROVED', comment: 'Booth released\u0000' };
    const p = refusalOf(await previewDecision(d, 'qa1', bad));
    expect({ status: p.status, code: p.code, kind: p.kind, why: p.why }).toEqual({ status: 400, code: 'SCHEMA', kind: 'INVALID_INPUT', why: 'The comment holds U+0000, which no record can hold: enter the text again without it.' });
    // Challenged with the clean preview's hash and the comment in its action: refused at the contract.
    const clean = { ...bad, comment: 'Booth released' };
    const content = await previewDecision(d, 'qa1', clean, decisionPreviewIntent(clean));
    if (!content.ok) throw new Error('the clean preview was refused');
    const challenge = await d.browser('qa1').call(routes.esig.createChallenge, {
      body: {
        aggregateType: 'batch_step',
        aggregateId: `${d.runId}:H-TEST@`,
        contentVersion: content.value.contentVersion,
        meaning: engine.holdPointMeaning('APPROVED'),
        clientContentHash: content.value.contentHash,
        action: { kind: 'ENGINE_COMMAND', runId: d.runId, expectedVersion: await d.version('qa1'), intent: bad },
      },
    });
    expectNamed(challenge, '/action/intent/comment', 'U+0000', 'Booth released');
    expect(await decisions()).toBe(before);
    expect(outcomeOf((await signDecision(d, 'qa1', clean)).result)).toBe('ok');
  }, 300_000);

  it('[DI-37] a TEXT value holding U+0000 or a lone surrogate is refused 400 naming /intent/value/value; adversarial text a record can hold is recorded and signed', async () => {
    const withTextRemark = (): flow.MbrContent =>
      dcMiniVariant((prep, content) => {
        (content['parameters'] as Json[]).push({ id: 'remark', name: 'Remark', valueType: 'TEXT', role: 'OBSERVATION', criticality: 'NON_CRITICAL', riskClass: 'LOW', capture: 'MANUAL' });
        const blend = (((((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[1] as Json)['body'] as Json)['children'] as Json[];
        const mix = ((blend[0] as Json)['body'] as Json)['children'] as Json[];
        const p = mix.find((x) => x['id'] === 'p-blend') as Json;
        return [{ ...p, id: 'p-early-remark', name: 'Record a remark', records: ['remark'], equipment: [] }, ...prep];
      });
    const d = await driver(withTextRemark(), ['operator1']);
    const KEY = 'p-early-remark@';
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    const remark = (value: string) => ({ type: 'RECORD_DATA', stepKey: KEY, item: 'remark', value: { kind: 'TEXT', value }, source: { mode: 'MANUAL' } });
    expectNamed(await untapped(d, 'operator1', remark('Looks fine\u0000')), '/intent/value/value', 'U+0000', 'Looks fine');
    expectNamed(await untapped(d, 'operator1', remark('Looks fine \ud800')), '/intent/value/value', 'an unpaired surrogate U+D800', 'Looks fine');
    expect(outcomeOf(await d.command('operator1', remark(ADV) as ClientIntent))).toBe('ok');
    expect(outcomeOf((await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: KEY })).result)).toBe('ok');
  }, 300_000);

  it('[DI-37][PR-49][PR-45] adversarial text a record can hold goes through every challenge and append: the hashes agree, stored contents re-hash in SQL and the replay is identical', async () => {
    const d = await driver(withEarlyHoldPoint(), ['operator1', 'verifier1', 'supervisor1', 'qa1']);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: `Prev ${ADV}`, batchNumber: 'TEST-B26-9999' } });
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: `Door ${ADV}`, severity: 'ALERT' });
    const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId ?? '';
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception, deviationRef: 'DEV-मि"\\\t\u0001 😀\u{10FFFF}é' });
    const outcomes = {
      performed: outcomeOf((await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR })).result),
      verified: outcomeOf((await d.sign('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' })).result),
      holdPoint: outcomeOf((await signDecision(d, 'qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-TEST@', disposition: 'APPROVED', comment: `OK ${ADV}` })).result),
      disposition: outcomeOf((await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'DEVIATION_RAISED', justification: `Why ${ADV}` })).result),
    };
    expect(outcomes).toEqual({ performed: 'ok', verified: 'ok', holdPoint: 'ok', disposition: 'ok' });
    const { rows } = await server.db.admin.query<{ n: string; bad: string }>(
      `select count(*)::text as n, count(*) filter (where recipe.canonical_hash(x.content) is distinct from x.content_hash)::text as bad
         from (select content, content_hash, batch_id from recipe.execution_step_content union all select content, content_hash, batch_id from recipe.execution_exception_content
               union all select content, content_hash, batch_id from recipe.execution_point_content union all select content, content_hash, batch_id from recipe.execution_stage_content) x
        where x.batch_id = $1`,
      [d.runId],
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(3);
    expect(rows[0]?.bad).toBe('0');
    const stored = await execution.loadState(server.db.admin, d.runId);
    expect(stored?.state.exceptions[exception]?.disposition?.justification).toBe(`Why ${ADV}`.trim());
    const report = await execution.replayExecution(server.db.admin, (await runContext(server.db.admin, d.runId)).def, d.runId);
    expect(report).toMatchObject({ identical: true, contentProblems: [], invariantViolations: [], firstDifference: null });
    expect(await violations(server)).toEqual([]);
  }, 300_000);
});

/** Adversarial text a record can hold: every plane, C0 and C1 controls, quotes, backslashes, U+2028, BOM, noncharacters, combining marks. */
const ADV = [
  'मिश्रण क्षेत्र',
  '"quoted" \'single\' back\\slash \\" \\\\u0000 literal',
  '\t\n\r\b\f \u0001\u0002\u001e\u001f\u007f\u0080\u0085\u009f',
  '   ​‍﻿￾￿�',
  '😀👩🏽‍🔬 \u{1F600}\u{10FFFF}\u{E0001}',
  'é é Å Å ﬁ',
  '</script><b>&amp;</b>',
].join(' | ');
