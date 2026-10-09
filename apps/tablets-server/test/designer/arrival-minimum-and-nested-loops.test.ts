/**
 * What the designer refuses before approval since the SQL mutation defects D6 and D12 (Phase 2 exit; decisions D6.1 and
 * D12.1). Both masters passed the validation gate before, and their batches then went wrong where nobody could see it:
 *
 * D6 (TIME-MIN-AT-ARRIVAL; INV-20, PR-30): a minimum that ends at the start of an operation, a parallel section, an
 * alternative, a replicate section, a stage, a loop or a hold point. The run records such a start by itself when the
 * token arrives and neither refuses nor flags it, so the minimum was broken without a word, while the engine's own
 * INV-20 check counts it as a violation.
 *
 * D12 (FLOW-LOOPS; INV-19, DI-34, PR-08): a loop inside a loop on the same endpoint. The outer exit judges again the
 * reading the inner exit judged, raises a second limit breach for it when it is outside its limits, and the database
 * refuses that exit row, so the batch stops there.
 *
 * Now the validation the designer shows lists each as an error at its place in the document (the time constraint in
 * section 9, the inner loop in section 8 with the node to jump to), in plain words that say what to change, and the
 * version stays a draft until the author changes it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type VersionView } from '@ebmr/api-contract';
import type { flow } from '@ebmr/recipe-core/pure';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { createFamily, edited, parameter, saveContent, startDesignerServer, valueOf } from './support.ts';

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

describe('D12: the designer refuses two nested loops on one endpoint (FLOW-LOOPS; INV-19, DI-34, PR-08)', () => {
  /** The template's blend step repeated by loops until the blend's uniformity is reached: `outer` around L-BLEND, or L-BLEND alone. */
  const withLoops = (v: VersionView, outer: 'same endpoint' | 'none'): flow.MbrContent =>
    edited(v, (c) => {
      const time = parameter(c, 'blendTime');
      c.parameters.push({
        ...structuredClone(time),
        id: 'blendRsd',
        name: 'Blend uniformity (RSD)',
        unit: '%',
        role: 'PROCESS_ENDPOINT',
        target: '2',
        limits: { unit: '%', ranges: [{ tier: 'VALIDATED', low: { value: '0', inclusive: true }, high: { value: '5', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-01' } }] },
      });
      const mix = c.procedure.body;
      if (mix.kind !== 'sequence') throw new Error('SETUP: the template changed');
      const blending = mix.children.find((n) => n.id === 'S-BLEND');
      if (blending?.kind !== 'stage' || blending.body.kind !== 'sequence') throw new Error('SETUP: no blending stage');
      const op = blending.body.children.find((n) => n.id === 'O-BLEND-MIX');
      if (op?.kind !== 'operation' || op.body.kind !== 'sequence') throw new Error('SETUP: no blending operation');
      const at = op.body.children.findIndex((n) => n.id === 'p-blend');
      const blend = op.body.children[at];
      if (blend?.kind !== 'phase') throw new Error('SETUP: no blend step');
      blend.records = [...blend.records, 'blendRsd'];
      const exit = { condition: 'blendRsd <= 5 [%]', endpoint: 'blendRsd' };
      const inner: flow.FlowNode = { kind: 'loop', id: 'L-BLEND', name: 'Blend until uniform', maxIterations: 3, exit, body: blend };
      op.body.children[at] = outer === 'none' ? inner : { kind: 'loop', id: 'L-BLEND-AGAIN', name: 'Blend again after a pause', maxIterations: 2, exit, body: inner };
    });

  it('[INV-19][DI-34][PR-08] a loop inside a loop exiting on the same endpoint is shown as an error at the inner loop, in plain words; with one loop the error goes away', async () => {
    const v1 = await createFamily(author, { familyCode: 'PCM500-D12', batchSizes: [{ quantity: '40.000', unit: 'kg' }] });
    const v2 = valueOf(await saveContent(author, v1, withLoops(v1, 'same endpoint'), 'blend again after a pause'));
    const r2 = await validate(v2);
    const shown = r2.findings.filter((f) => f.rule === 'FLOW-LOOPS');
    expect(shown.map(where)).toEqual([{ key: 'FLOW-LOOPS@L-BLEND', severity: 'ERROR', controls: ['DI-34', 'INV-19'], section: '8', nodeId: 'L-BLEND' }]);
    expect(shown[0]?.message).toBe(
      'Loop "Blend until uniform" (L-BLEND) lies inside loop "Blend again after a pause" (L-BLEND-AGAIN), and both exit on "Blend uniformity (RSD)" (blendRsd). The inner loop\'s exit judges the last reading of "Blend uniformity (RSD)" (blendRsd) against its limits; the outer loop\'s exit would judge that same reading again, and raise a second limit breach for it when it is outside them, which the database refuses, so the batch would stop at the outer loop\'s exit. Give the outer loop an endpoint of its own, recorded inside it, or keep only one of the two loops (FLOW-LOOPS; DI-34, INV-19)',
    );
    expect(r2.gate.passed).toBe(false);
    await staysDraft(v2);

    const v3 = valueOf(await saveContent(author, v2, withLoops(v1, 'none'), 'one loop'));
    const r3 = await validate(v3);
    expect(r3.findings.filter((f) => f.rule === 'FLOW-LOOPS')).toEqual([]);
    expect(r3.findings.filter((f) => f.severity === 'ERROR')).toEqual([]);
    expect(r3.gate.passed).toBe(true);
    expect(r2.findings.filter((f) => f.severity === 'ERROR').map((f) => f.key)).toEqual(['FLOW-LOOPS@L-BLEND']);
  });
});
