/**
 * The designer's contract examples (packages/api-contract/fixtures) are the server's own answers (review F55; DI-04,
 * DI-05). They serve the web's fixture mode and the web tests, so they must be answers the server can give: a version
 * whose content is the MBR the designer opens and whose hash is that content's, evidence and reports that agree for
 * the same content, finding keys in the form justifications name, the simulation's own outcomes. Before, they were
 * written by hand to pass only the loose schemas.
 *
 * This test drives the real designer over HTTP the way the designer E2E spec does (the dc-mini template; the excipient
 * tolerance removed in revision 2 and its warning justified; validation, simulation, start of verification) and
 * compares every answer with its example, after the values that differ from one database to the next are made
 * stable (test/support/examples.ts): ids (the author keeps the id of the session example; others get fixed example
 * ids, in order) and instants (in order, one minute apart from 28-SEP-2026 13:00:03 in the site zone). Run it with
 * EBMR_WRITE_EXAMPLES=1 to write the examples again after a deliberate change of the server's answers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type VersionView } from '@ebmr/api-contract';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { EXAMPLE_PERSONS, matchesExample, Stabiliser, type Json } from '../support/examples.ts';
import { createFamily, edited, findPhase, justifyBody, removeNode, saveContent, startDesignerServer, valueOf } from './support.ts';

const VERSION_ID = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';
const FAMILY_ID = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f7a';
/** 28-SEP-2026 13:00:03 IST, the first instant of the designer examples. */
const BASE_US = 1790580603000000n;

let server: TestServer;
let author: TestBrowser;

beforeAll(async () => {
  server = await startDesignerServer();
  author = await server.asPersona('author');
});
afterAll(async () => {
  await server?.close();
});

describe('the designer examples are the server\'s answers (review F55)', () => {
  it('[DI-04][DI-05][PR-03] templates, palette, a version with a justified warning, its validation and simulation, an edit with an error, and the version in verification with its evidence', async () => {
    const templates = valueOf(await author.call(routes.designer.templates));
    const palette = valueOf(await author.call(routes.designer.palette));
    const v1 = await createFamily(author);
    // Revision 2: no dispensing tolerance for the excipients (warning G07-TOLERANCE-MISSING), then justified.
    const v2 = valueOf(await saveContent(author, v1, edited(v1, (c) => (findPhase(c, 'p-disp-exc').config = {})), 'Excipient tolerance checked at the dispensing reconciliation.'));
    const key = 'G07-TOLERANCE-MISSING@p-disp-exc';
    valueOf(await author.call(routes.designer.justify, { params: { versionId: v2.versionId }, body: justifyBody(v2, key, 'Excipients are checked against the formula at the dispensing reconciliation (SOP-DISP-001).') }));
    const version = valueOf(await author.call(routes.designer.version, { params: { versionId: v2.versionId } }));
    const validation = valueOf(await author.call(routes.designer.validate, { body: { versionId: version.versionId, content: version.content } }));
    // An unsaved edit: the blending stage without its clearance step (GMP-STAGE-CLEARANCE).
    const withoutClearance = edited(version, (c) => {
      if (!removeNode(c, 'p-blend-clear')) throw new Error('the template changed');
    });
    const findings = valueOf(await author.call(routes.designer.validate, { body: { versionId: version.versionId, content: withoutClearance as unknown as VersionView['content'] } }));
    const simulation = valueOf(await author.call(routes.designer.simulate, { params: { versionId: version.versionId }, body: {} }));
    valueOf(await author.call(routes.designer.startVerification, { params: { versionId: version.versionId }, body: { baseRevision: version.revision } }));
    const inVerification = valueOf(await author.call(routes.designer.version, { params: { versionId: version.versionId } }));
    const families = valueOf(await author.call(routes.designer.families));

    // What the examples show, checked on the server's answers themselves.
    expect(version.state).toBe('DRAFT');
    expect(version.justifications.map((j) => j.findingKey)).toEqual([key]);
    expect(validation.contentHash).toBe(version.contentHash);
    expect(validation.gate).toEqual({ passed: true, errors: 0, warnings: 1, unjustifiedWarnings: 0 });
    expect(findings.gate.passed).toBe(false);
    expect(findings.findings.map((f) => f.key)).toContain('GMP-STAGE-CLEARANCE@S-BLEND');
    expect(simulation.passed).toBe(true);
    expect(inVerification.state).toBe('IN_VERIFICATION');
    expect(inVerification.evidence.filter((e) => e.valid).map((e) => e.kind)).toEqual(['VALIDATOR']);

    const zone = /\(([^)]+)\)$/.exec(version.savedAt.text)?.[1] ?? 'Asia/Kolkata';
    const s = new Stabiliser(zone, BASE_US, { [version.versionId]: VERSION_ID, [version.familyId]: FAMILY_ID });
    const answers = { templates, palette, version, validation, findings, simulation, inVerification, families: { families: families.families.filter((f) => f.familyId === version.familyId) } };
    s.learn(answers);
    const stable = s.apply(answers) as Record<keyof typeof answers, Json>;
    matchesExample('templates.json', stable.templates);
    matchesExample('palette.json', stable.palette);
    matchesExample('version.json', stable.version);
    matchesExample('validation-report.json', stable.validation);
    matchesExample('validation-report-findings.json', stable.findings);
    matchesExample('simulation-report.json', stable.simulation);
    matchesExample('version-in-verification.json', stable.inVerification);
    matchesExample('families.json', stable.families);
  });
});

describe('the stabiliser keeps what the examples link (ids and the order of instants)', () => {
  it('[DI-04] one id gets one stable id everywhere, a known person keeps the example id, instants keep their order', () => {
    const s = new Stabiliser('Asia/Kolkata', BASE_US, { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': VERSION_ID, 'pkg-hash-0123': 'pkg-example' });
    const answer = {
      a: { personId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', loginName: 'asha.rao' },
      chain: 'mbr_version:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      file: 'pkg-hash-0123.json',
      other: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
      t2: { us: '1900000000000000', text: 'x' },
      t1: { us: '1800000000000000', text: 'y' },
    };
    s.learn(answer);
    expect(s.apply(answer)).toEqual({
      a: { personId: EXAMPLE_PERSONS['asha.rao'], loginName: 'asha.rao' },
      chain: `mbr_version:${VERSION_ID}`,
      file: 'pkg-example.json',
      other: ['e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002'],
      t2: { us: '1790580663000000', text: '28-SEP-2026 13:01:03 +05:30 (Asia/Kolkata)' },
      t1: { us: '1790580603000000', text: '28-SEP-2026 13:00:03 +05:30 (Asia/Kolkata)' },
    });
  });
});
