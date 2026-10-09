/**
 * The designer warns the author of an MBR whose weighings the database would refuse for a unit it cannot read, before
 * the MBR can enter verification (Phase 2 exit follow-up COMPOUND-UNIT; INV-25, PR-19, DI-30; validator rule
 * DATA-WEIGHED-UNITS; recipe-core sql/0323).
 *
 * The database decides from the MBR which quantity of its step a weighing counts into and does not read a compound unit
 * ("g/mL", "kg/1"): it refuses every output container of a G-22 step that records such a quantity before its first plain
 * mass quantity (EBMR-EXE-139). Before, the designer validated and approved such an MBR without a word, and its first
 * batch stopped at the first output container. Now the validation the designer shows lists a warning with its code at
 * that step, and the version stays a draft until the author changes the MBR or justifies the warning.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type VersionView } from '@ebmr/api-contract';
import type { flow } from '@ebmr/recipe-core/pure';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { createFamily, edited, findPhase, startDesignerServer, saveContent, valueOf } from './support.ts';

let server: TestServer;
let author: TestBrowser;

beforeAll(async () => {
  server = await startDesignerServer();
  author = await server.asPersona('author');
}, 180_000);
afterAll(async () => {
  await server?.close();
});

async function validate(content: unknown, versionId: string) {
  return valueOf(await author.call(routes.designer.validate, { body: { content: content as VersionView['content'], versionId } }));
}

/** The template's discharge step (G-22) also recording the blend's bulk density in g/mL, before or after its net. */
function withDensity(v: VersionView, where: 'before' | 'after'): flow.MbrContent {
  return edited(v, (c) => {
    const net = c.parameters.find((p) => p.id === 'blendNet');
    if (!net) throw new Error('template changed: no blendNet');
    c.parameters.push({ ...net, id: 'bulkDensity', name: 'Bulk density of the blend', unit: 'g/mL', role: 'OBSERVATION' });
    const out = findPhase(c, 'p-blend-out');
    out.records = where === 'before' ? ['bulkDensity', ...out.records] : [...out.records, 'bulkDensity'];
  });
}

describe('COMPOUND-UNIT: the designer warns before approval where the database would refuse every output container (INV-25, PR-19, DI-30)', () => {
  it('[INV-25][PR-19][DI-30] a G-22 step recording a quantity in a compound unit before its net is shown as a warning with its code at that step; the version does not enter verification unwarned; recorded after the net, nothing is shown', async () => {
    const v1 = await createFamily(author, { familyCode: 'PCM500-CU', batchSizes: [{ quantity: '60.000', unit: 'kg' }] });
    const v2 = valueOf(await saveContent(author, v1, withDensity(v1, 'before'), 'bulk density recorded at discharge'));
    const r2 = await validate(v2.content, v2.versionId);
    const shown = r2.findings.filter((f) => f.rule === 'DATA-WEIGHED-UNITS');
    expect(shown.map((f) => ({ key: f.key, severity: f.severity, controls: f.controls, section: f.section, nodeId: f.nodeId, justification: f.justification }))).toEqual([
      { key: 'DATA-WEIGHED-UNITS@p-blend-out', severity: 'WARNING', controls: ['INV-25', 'PR-19', 'DI-30'], section: '8', nodeId: 'p-blend-out', justification: null },
    ]);
    expect(shown[0]?.message).toBe(
      '"Discharge into output containers" (p-blend-out) registers output containers (G-22) and records "Bulk density of the blend" (bulkDensity) in g/mL before its first plain mass quantity. In this release the database cannot tell whether a compound unit (written with ".", "/" or parentheses) is a mass, so it refuses every output container of this step (EBMR-EXE-139), although the engine would count it. Record the produced quantity first, or write the unit plainly (kg, g, mg) (DATA-WEIGHED-UNITS; INV-25, PR-19, DI-30)',
    );
    expect(r2.findings.filter((f) => f.severity === 'ERROR')).toEqual([]);
    expect(r2.gate).toEqual(expect.objectContaining({ passed: false, errors: 0, unjustifiedWarnings: 1 }));
    const started = await author.call(routes.designer.startVerification, { params: { versionId: v2.versionId }, body: { baseRevision: v2.revision } });
    const after = valueOf(await author.call(routes.designer.version, { params: { versionId: v2.versionId } }));
    expect({ ok: started.ok, state: after.state }).toEqual({ ok: false, state: 'DRAFT' });

    // The author records the net first: no warning, the gate passes.
    const v3 = valueOf(await saveContent(author, v2, withDensity(v1, 'after'), 'bulk density recorded after the net'));
    const r3 = await validate(v3.content, v3.versionId);
    expect(r3.findings.filter((f) => f.rule === 'DATA-WEIGHED-UNITS')).toEqual([]);
    expect(r3.gate.passed).toBe(true);
  });
});
