/**
 * The packaging line completion evidence of a demo packaging order (Phase 6 slice 6c; tablets 1230; IN-16, PR-16,
 * PR-34), through the labels routes in each persona's own session (a kiosk request is badge-tapped): the START, MIDDLE
 * and END coding specimens of a coding G-21 step, showing the record's coding the server offers (expectedCoding), a
 * label specimen of each printed item, and, once the printing steps are performed, the post-use inspection of the line
 * verified by a second person. DEMO-ONLY seed code (the set-up CLI); every rule is the database's.
 */
import { routes } from '@ebmr/api-contract';
import { value, type DemoApp, type DemoBatch, type DemoBrowser } from './demo-app.ts';

const attr = async (app: DemoApp, b: DemoBrowser, path: string, body: Record<string, unknown>) => (b.kiosk ? { attribution: await app.tap(b, path, body) } : {});

/** The specimens of G-21 step `stepKey`, while it is in progress. */
export async function recordSpecimens(app: DemoApp, o: DemoBatch, by: DemoBrowser, stepKey: string, items: readonly string[]): Promise<void> {
  const view = value(await by.api.call(routes.labels.packaging, { params: { batchId: o.batchId } }), `the packaging completion of ${o.batchNumber}`);
  const step = view.steps.find((s) => s.stepKey === stepKey);
  if (!step) throw new Error(`${stepKey} is no printed-materials step of ${o.batchNumber}`);
  const base = `/api/labels/batches/${o.batchId}/steps/${encodeURIComponent(stepKey)}`;
  if (step.coding) {
    const coded = step.expectedCoding;
    if (!coded) throw new Error(`the record of ${o.batchNumber} gives no coding for ${stepKey} yet`);
    for (const position of ['START', 'MIDDLE', 'END'] as const) {
      const body = { position, coded };
      value(await by.api.call(routes.labels.recordCodingSpecimen, { params: { batchId: o.batchId, stepKey }, body, ...(await attr(app, by, `${base}/coding-specimens`, body)) }), `the ${position} coding specimen`);
    }
  }
  for (const item of items) {
    const body = { item, note: `Specimen of ${item} attached to the record` };
    value(await by.api.call(routes.labels.recordLabelSpecimen, { params: { batchId: o.batchId, stepKey }, body, ...(await attr(app, by, `${base}/label-specimens`, body)) }), `the label specimen of ${item}`);
  }
}

/** The post-use inspection of the line, passed, verified by `verifier`; after every printing step is performed. */
export async function recordPostUseInspection(app: DemoApp, o: DemoBatch, by: DemoBrowser, verifier: DemoBrowser): Promise<void> {
  const body = { checks: { noPrintedMaterial: true, noProduct: true, noDocuments: true, lineClean: true }, note: 'Line inspected after use: no printed material, product or documents of the order left' };
  const view = value(await by.api.call(routes.labels.recordPostUseInspection, { params: { batchId: o.batchId }, body, ...(await attr(app, by, `/api/labels/batches/${o.batchId}/post-use-inspections`, body)) }), 'the post-use inspection');
  const id = view.inspections.at(-1)?.inspectionId ?? '';
  value(await verifier.api.call(routes.labels.verifyPostUseInspection, { params: { inspectionId: id }, body: {}, ...(await attr(app, verifier, `/api/labels/post-use-inspections/${id}/verification`, {})) }), 'the verification of the post-use inspection');
}
