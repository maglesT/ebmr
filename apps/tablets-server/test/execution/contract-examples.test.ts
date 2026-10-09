/**
 * More shared contract examples, from the sandbox server's own answers (lead TODO T7; DI-05: every view of a test run
 * carries TEST, NOT GMP and TEST- numbers): the issue form of a test package, the answer to a command, a lot, the
 * timeline of a run and its replay. The run is a test batch of the GMP version example (the dc-mini DRAFT, revision 2,
 * with its justified warning) exported as the designer exports it, under the ids the run and package examples use;
 * the operator starts the booth clearance, answers it, tries to start the next step too early (refused, and recorded
 * so), and signs the clearance as performed. Every answer is compared with its example after the values that differ
 * from one database to the next are made stable (test/support/examples.ts); EBMR_WRITE_EXAMPLES=1 writes them again.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { flow } from '@ebmr/recipe-core';
import { formatInstant } from '../../src/platform/ports.ts';
import { exampleJson, matchesExample, Stabiliser, EXAMPLE_PERSONS } from '../support/examples.ts';
import { RunDriver, startExecServer, valueOf, writePackage, type ExecServer } from './support.ts';

/** The ids the run and package examples use. */
const RUN_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
/** 28-SEP-2026 14:00:03 IST: the test run starts before the moments the run and step examples show. */
const BASE_US = 1790584203000000n;

let server: ExecServer;
beforeAll(async () => {
  server = await startExecServer();
  // The kiosk tap limiter counts on the monotonic clock: the test moves it 7 s per tap.
  vi.useFakeTimers({ toFake: ['performance'] });
}, 120_000);
afterAll(async () => {
  vi.useRealTimers();
  await server?.close();
});

interface VersionExample {
  versionId: string;
  familyId: string;
  familyCode: string;
  product: { code: string; name: string; strength: string };
  number: string;
  revision: number;
  state: string;
  content: unknown;
  justifications: { findingKey: string; text: string; by: { personId: string } }[];
}

describe('the sandbox examples are the server\'s answers (lead TODO T7)', () => {
  it('[DI-05][INV-18][PR-01] issue form, a command\'s answer, a lot, the timeline with a refused command, and the replay of a TEST- run', async () => {
    const version = exampleJson('version.json') as unknown as VersionExample;
    const parsed = flow.parseMbr(version.content);
    if (!parsed.ok) throw new Error('the version example does not parse');
    const packages = exampleJson('test-packages.json') as unknown as { packages: { packageId: string; exportedAt: { us: string } }[] };
    const examplePackage = packages.packages[0];
    if (!examplePackage) throw new Error('no package example');
    const pkg = writePackage(server, parsed.mbr, {
      family: { familyId: version.familyId, familyCode: version.familyCode, product: version.product },
      version: { versionId: version.versionId, number: version.number, revision: version.revision, state: version.state },
      justifications: version.justifications.map((j) => ({ key: j.findingKey, text: j.text, by: j.by.personId })),
      exporter: { personId: EXAMPLE_PERSONS['asha.rao'] ?? '', legalName: 'Asha Rao', loginName: 'asha.rao' },
      exportedAtUs: examplePackage.exportedAt.us,
    });

    const issuer = await server.asPersona('issuer');
    valueOf(await issuer.call(routes.execution.importPackage, { params: { packageId: pkg.packageHash }, body: {} }));
    const issueForm = valueOf(await issuer.call(routes.execution.issueForm, { params: { packageId: pkg.packageHash } }));
    const size = issueForm.batchSizes[0]?.id ?? '';
    const issued = valueOf(await issuer.call(routes.execution.issue, { body: { packageId: pkg.packageHash, batchSize: size, markets: ['IN'], variants: {}, inputs: { tabletsPerBatch: { kind: 'COUNT', value: '100000' } } } }));
    const runId = issued.header.runId;
    const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);

    const commandResult = d.command('operator1', { type: 'START_STEP', stepKey: 'p-disp-clear@' });
    const started = valueOf(await commandResult);
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-clear@', entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-clear@', entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } });
    // The next step cannot start before the clearance is done: refused, and the refusal is recorded (DI-34).
    const early = await d.command('operator1', { type: 'START_STEP', stepKey: 'p-disp-bal@' });
    expect(early.ok).toBe(false);
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-clear@' });
    const timeline = valueOf(await issuer.call(routes.execution.timeline, { params: { runId } }));
    const replay = valueOf(await issuer.call(routes.execution.verifyReplay, { params: { runId }, body: {} }));
    const lot = valueOf(await d.browser('operator1').call(routes.execution.lot, { params: { code: 'TEST-L26-0101' } }));

    // What the examples show, checked on the server's answers themselves.
    expect(issueForm.batchSizes.map((b) => [b.id, b.quantity, b.unit])).toEqual([
      ['BS-100K', '60.000', 'kg'],
      ['BS-50K', '30.000', 'kg'],
    ]);
    expect(issueForm.markets).toContainEqual({ code: 'IN', locked: true });
    expect(issued.header.batchNumber).toMatch(/^TEST-B\d{2}-\d{4}$/);
    expect(started).toMatchObject({ accepted: true, step: { step: { stepKey: 'p-disp-clear@', status: 'IN_PROGRESS' }, run: { watermark: { text: 'TEST, NOT GMP' } } } });
    expect(timeline.entries.map((e) => [e.kind, e.accepted])).toContainEqual(['COMMAND', false]);
    expect(timeline.entries[0]?.kind).toBe('ISSUE');
    expect(replay).toMatchObject({ identical: true, firstDifference: null, invariantViolations: [] });
    expect(lot.lotCode).toBe('TEST-L26-0101');

    const zone = /\(([^)]+)\)$/.exec(timeline.entries[0]?.at.text ?? '')?.[1] ?? 'Asia/Kolkata';
    // The demo lots expire 730 days and are due for retest 365 days after they were registered (seed.ts DEMO_LOTS):
    // the example keeps those spans from its own first instant. The texts are site time, as the server writes them.
    const SITE_TEXT = /^\d{2}-[A-Z]{3}-\d{4} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2} \(.+\)$/;
    expect(lot.expiry).toMatch(SITE_TEXT);
    expect(lot.retest).toMatch(SITE_TEXT);
    const DAY_US = 86_400_000_000n;
    const stableLot = { ...lot, expiry: formatInstant(BASE_US + 730n * DAY_US, zone).text, retest: formatInstant(BASE_US + 365n * DAY_US, zone).text };
    const s = new Stabiliser(zone, BASE_US, { [runId]: RUN_ID, [pkg.packageHash]: examplePackage.packageId });
    const answers = { issueForm, commandResult: started, timeline, replay, lot: stableLot };
    s.learn(answers);
    const stable = s.apply(answers) as Record<keyof typeof answers, Parameters<typeof matchesExample>[1]>;
    matchesExample('issue-form.json', stable.issueForm);
    matchesExample('command-result.json', stable.commandResult);
    matchesExample('timeline.json', stable.timeline);
    matchesExample('replay.json', stable.replay);
    matchesExample('lot.json', stable.lot);
  }, 300_000);
});
