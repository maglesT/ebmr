/**
 * What the designer refuses before approval since the SQL mutation defect D6 (Phase 2 exit; decision D6.1). The master
 * passed the validation gate before, and its batches then went wrong where nobody could see it:
 *
 * D6 (TIME-MIN-AT-ARRIVAL; INV-20, PR-30): a minimum that ends at the start of an operation, a parallel section, an
 * alternative, a replicate section, a stage, a loop or a hold point. The run records such a start by itself when the
 * token arrives and neither refuses nor flags it, so the minimum was broken without a word, while the engine's own
 * INV-20 check counts it as a violation.
 *
 * Now the validation the designer shows lists it as an error at the time constraint in section 9, in plain words that
 * say what to change, and the version stays a draft until the author changes it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type VersionView } from '@ebmr/api-contract';
import type { flow } from '@ebmr/recipe-core/pure';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { createFamily, edited, saveContent, startDesignerServer, valueOf } from './support.ts';

let server: TestServer;
let author: TestBrowser;

beforeAll(async () => {
  server = await startDesignerServer();
  author = await server.asPersona('author');
}, 180_000);
afterAll(async () => {
  await server?.close();
});

async function validate(v: VersionView) {
  return valueOf(await author.call(routes.designer.validate, { body: { content: v.content, versionId: v.versionId } }));
}

/** Enter verification is refused and the version stays a draft. */
async function staysDraft(v: VersionView): Promise<void> {
  const started = await author.call(routes.designer.startVerification, { params: { versionId: v.versionId }, body: { baseRevision: v.revision } });
  const after = valueOf(await author.call(routes.designer.version, { params: { versionId: v.versionId } }));
  expect({ ok: started.ok, state: after.state }).toEqual({ ok: false, state: 'DRAFT' });
}

const where = (f: { key: string; severity: string; controls: string[]; section: string; nodeId: string | null }) => ({
  key: f.key,
  severity: f.severity,
  controls: f.controls,
  section: f.section,
  nodeId: f.nodeId,
});

describe('D6: the designer refuses a minimum that ends where the token arrives (TIME-MIN-AT-ARRIVAL; INV-20, PR-30)', () => {
  /** The template with a rest of at least 30 min between the blend and the release-and-discharge operation, ending at `to`. */
  const withRest = (v: VersionView, to: flow.NodeEvent): flow.MbrContent =>
    edited(v, (c) => {
      c.timeConstraints.push({
        id: 'TC-BLEND-REST',
        name: 'Blend rests before discharge',
        kind: 'TIMER',
        from: { node: 'p-blend', event: 'END' },
        to,
        min: { value: '30', unit: 'min' },
        source: { kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-01' },
        breach: 'EXCEPTION',
        pauses: 'INCLUDED',
      });
    });

  it('[INV-20][PR-30] a minimum ending at the start of an operation is shown as an error in the time constraints, naming the release of the hold point inside as where to end it; ended there, the gate passes', async () => {
    const v1 = await createFamily(author, { familyCode: 'PCM500-D6', batchSizes: [{ quantity: '50.000', unit: 'kg' }] });
    const v2 = valueOf(await saveContent(author, v1, withRest(v1, { node: 'O-BLEND-OUT', event: 'START' }), 'blend rest before discharge'));
    const r2 = await validate(v2);
    const shown = r2.findings.filter((f) => f.rule === 'TIME-MIN-AT-ARRIVAL');
    expect(shown.map(where)).toEqual([{ key: 'TIME-MIN-AT-ARRIVAL@TC-BLEND-REST', severity: 'ERROR', controls: ['INV-20', 'PR-30'], section: '9', nodeId: null }]);
    expect(shown[0]?.message).toBe(
      'Time constraint "Blend rests before discharge" (TC-BLEND-REST) has a minimum of 30 min that ends at the start of operation "Release and discharge of the blend" (O-BLEND-OUT). The run starts it by itself as soon as what comes before it is done, so nothing holds that start back until the minimum has passed, and the run would break the minimum without a refusal or an exception. End the minimum at the first step inside instead, where a person acts and the run holds the act back until the minimum has passed: the release of hold point "QA release of the blend for discharge" (H-BLEND) (its end) (TIME-MIN-AT-ARRIVAL; INV-20, PR-30)',
    );
    expect(r2.gate).toEqual(expect.objectContaining({ passed: false, errors: 1 }));
    await staysDraft(v2);

    // The author ends the minimum at the hold point's release: nothing is shown, the gate passes.
    const v3 = valueOf(await saveContent(author, v2, withRest(v1, { node: 'H-BLEND', event: 'END' }), 'rest ends at the QA release'));
    const r3 = await validate(v3);
    expect(r3.findings.filter((f) => f.severity === 'ERROR')).toEqual([]);
    expect(r3.gate.passed).toBe(true);
  });
});
