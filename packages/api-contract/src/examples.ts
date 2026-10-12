/**
 * Example fixtures for every view (Phase 2 apps plan section 4, "Views"): validated by a test and used by C4
 * (through the web app's createFixtureFetch) before the sandbox server exists. Subpath
 * `@ebmr/api-contract/examples`, so the production bundle never carries them unless a fixture mode imports it.
 *
 * The JSON files live in ../fixtures; one StepScreenView per block of the dc-mini template. The designer examples are
 * the server's answers (review F55); the step and run examples are written for the screens and checked against the
 * template's limits and their own moment (asOf) by apps/tablets-web/test/api/contract-examples.test.ts.
 */
import type { z } from 'zod';
import audit from '../fixtures/audit-events.json' with { type: 'json' };
import challenge from '../fixtures/challenge.json' with { type: 'json' };
import commandResult from '../fixtures/command-result.json' with { type: 'json' };
import manifestation from '../fixtures/manifestation.json' with { type: 'json' };
import metaGmp from '../fixtures/meta-gmp.json' with { type: 'json' };
import metaSandbox from '../fixtures/meta-sandbox.json' with { type: 'json' };
import reading from '../fixtures/reading.json' with { type: 'json' };
import replay from '../fixtures/replay.json' with { type: 'json' };
import run from '../fixtures/run.json' with { type: 'json' };
import runs from '../fixtures/runs.json' with { type: 'json' };
import sessionKiosk from '../fixtures/session-kiosk.json' with { type: 'json' };
import sessionOffice from '../fixtures/session-office.json' with { type: 'json' };
import simulation from '../fixtures/simulation-report.json' with { type: 'json' };
import g03 from '../fixtures/step-g03-acknowledge.json' with { type: 'json' };
import g04 from '../fixtures/step-g04-parameters.json' with { type: 'json' };
import g07 from '../fixtures/step-g07-weighing.json' with { type: 'json' };
import g08 from '../fixtures/step-g08-charge.json' with { type: 'json' };
import g09 from '../fixtures/step-g09-equipment-status.json' with { type: 'json' };
import g10 from '../fixtures/step-g10-clearance.json' with { type: 'json' };
import g17 from '../fixtures/step-g17-hold-point.json' with { type: 'json' };
import g20 from '../fixtures/step-g20-yield.json' with { type: 'json' };
import g22 from '../fixtures/step-g22-output.json' with { type: 'json' };
import testPackages from '../fixtures/test-packages.json' with { type: 'json' };
import timeline from '../fixtures/timeline.json' with { type: 'json' };
import families from '../fixtures/families.json' with { type: 'json' };
import issueForm from '../fixtures/issue-form.json' with { type: 'json' };
import lot from '../fixtures/lot.json' with { type: 'json' };
import palette from '../fixtures/palette.json' with { type: 'json' };
import templates from '../fixtures/templates.json' with { type: 'json' };
import validationFindings from '../fixtures/validation-report-findings.json' with { type: 'json' };
import validation from '../fixtures/validation-report.json' with { type: 'json' };
import versionInVerification from '../fixtures/version-in-verification.json' with { type: 'json' };
import version from '../fixtures/version.json' with { type: 'json' };
import workQueue from '../fixtures/work-queue.json' with { type: 'json' };
import gmpBatch from '../fixtures/gmp-batch.json' with { type: 'json' };
import s6 from '../fixtures/slice-6.json' with { type: 'json' };
import rv from '../fixtures/review.json' with { type: 'json' };
import cn from '../fixtures/containers.json' with { type: 'json' };
import pk from '../fixtures/packaging.json' with { type: 'json' };
import dv from '../fixtures/deviation.json' with { type: 'json' };
import lm from '../fixtures/lims.json' with { type: 'json' };
import rl from '../fixtures/release.json' with { type: 'json' };
import qs from '../fixtures/qp-shipping.json' with { type: 'json' };
import nt from '../fixtures/notifications.json' with { type: 'json' };
import rk from '../fixtures/records-lock.json' with { type: 'json' };
import ind from '../fixtures/india.json' with { type: 'json' };
import { ReadingView } from './ns/devices.ts';
import { ChallengeView, ManifestationView } from './ns/esig.ts';
import { routes } from './routes.ts';

export interface Example {
  /** The schema the example must parse with. */
  schema: z.ZodType;
  data: unknown;
  /** The route whose response it is, when it is one (for fixture fetches). */
  routeId?: string;
}

const r = routes;

export const EXAMPLES = {
  'meta-gmp': { schema: r.meta.get.response, data: metaGmp, routeId: r.meta.get.id },
  'meta-sandbox': { schema: r.meta.get.response, data: metaSandbox, routeId: r.meta.get.id },
  'session-kiosk': { schema: r.session.get.response, data: sessionKiosk, routeId: r.session.get.id },
  'session-office': { schema: r.session.get.response, data: sessionOffice, routeId: r.session.get.id },
  'step-g03-acknowledge': { schema: r.execution.step.response, data: g03, routeId: r.execution.step.id },
  'step-g04-parameters': { schema: r.execution.step.response, data: g04, routeId: r.execution.step.id },
  'step-g07-weighing': { schema: r.execution.step.response, data: g07, routeId: r.execution.step.id },
  'step-g08-charge': { schema: r.execution.step.response, data: g08, routeId: r.execution.step.id },
  'step-g09-equipment-status': { schema: r.execution.step.response, data: g09, routeId: r.execution.step.id },
  'step-g10-clearance': { schema: r.execution.step.response, data: g10, routeId: r.execution.step.id },
  'step-g17-hold-point': { schema: r.execution.step.response, data: g17, routeId: r.execution.step.id },
  'step-g20-yield': { schema: r.execution.step.response, data: g20, routeId: r.execution.step.id },
  'step-g22-output': { schema: r.execution.step.response, data: g22, routeId: r.execution.step.id },
  run: { schema: r.execution.run.response, data: run, routeId: r.execution.run.id },
  runs: { schema: r.execution.runs.response, data: runs, routeId: r.execution.runs.id },
  'work-queue': { schema: r.execution.workQueue.response, data: workQueue, routeId: r.execution.workQueue.id },
  'test-packages': { schema: r.execution.testPackages.response, data: testPackages, routeId: r.execution.testPackages.id },
  // The sandbox server's own answers for a test batch of the version example (lead TODO T7), compared with the
  // server by apps/tablets-server/test/execution/contract-examples.test.ts.
  'issue-form': { schema: r.execution.issueForm.response, data: issueForm, routeId: r.execution.issueForm.id },
  'command-result': { schema: r.execution.command.response, data: commandResult, routeId: r.execution.command.id },
  timeline: { schema: r.execution.timeline.response, data: timeline, routeId: r.execution.timeline.id },
  replay: { schema: r.execution.verifyReplay.response, data: replay, routeId: r.execution.verifyReplay.id },
  lot: { schema: r.execution.lot.response, data: lot, routeId: r.execution.lot.id },
  challenge: { schema: ChallengeView, data: challenge, routeId: r.esig.createChallenge.id },
  manifestation: { schema: ManifestationView, data: manifestation },
  reading: { schema: ReadingView, data: reading, routeId: r.devices.capture.id },
  // The designer examples are the server's own answers for the dc-mini template, made stable (ids, instants) and
  // compared with the server by apps/tablets-server/test/designer/contract-examples.test.ts (review F55).
  templates: { schema: r.designer.templates.response, data: templates, routeId: r.designer.templates.id },
  families: { schema: r.designer.families.response, data: families, routeId: r.designer.families.id },
  palette: { schema: r.designer.palette.response, data: palette, routeId: r.designer.palette.id },
  version: { schema: r.designer.version.response, data: version, routeId: r.designer.version.id },
  'version-in-verification': { schema: r.designer.version.response, data: versionInVerification, routeId: r.designer.version.id },
  'validation-report': { schema: r.designer.validate.response, data: validation, routeId: r.designer.validate.id },
  'validation-report-findings': { schema: r.designer.validate.response, data: validationFindings, routeId: r.designer.validate.id },
  'simulation-report': { schema: r.designer.simulate.response, data: simulation, routeId: r.designer.simulate.id },
  'audit-events': { schema: r.audit.events.response, data: audit, routeId: r.audit.events.id },
  // Phase 3 slice 6 (6a-0): one example per new route, written for the screens (6b) before the handlers exist. The GMP
  // batch examples are the sandbox run examples without the TEST watermark and identifiers (gmp-batch.json).
  'batches-list': { schema: r.batches.list.response, data: gmpBatch.list, routeId: r.batches.list.id },
  'batches-batch': { schema: r.batches.batch.response, data: gmpBatch.batch, routeId: r.batches.batch.id },
  'batches-step': { schema: r.batches.step.response, data: gmpBatch.step, routeId: r.batches.step.id },
  // A TB-08 step: the BLOCK_ENTRY form of its ADDITION with the block's own schema (source and authorisedBy server-filled).
  'batches-step-tb08': { schema: r.batches.step.response, data: gmpBatch.stepTb08, routeId: r.batches.step.id },
  'batches-work-queue': { schema: r.batches.workQueue.response, data: gmpBatch.workQueue, routeId: r.batches.workQueue.id },
  'batches-timeline': { schema: r.batches.timeline.response, data: gmpBatch.timeline, routeId: r.batches.timeline.id },
  'batches-command': { schema: r.batches.command.response, data: gmpBatch.commandResult, routeId: r.batches.command.id },
  'batches-verify-replay': { schema: r.batches.verifyReplay.response, data: { ...replay, runId: gmpBatch.batch.header.runId }, routeId: r.batches.verifyReplay.id },
  'batches-propose-act': { schema: r.batches.proposeAct.response, data: s6.proposedAct, routeId: r.batches.proposeAct.id },
  'batches-sscc': { schema: r.batches.sscc.response, data: s6.sscc, routeId: r.batches.sscc.id },
  'batches-issue-sscc': { schema: r.batches.issueSscc.response, data: s6.sscc.ssccs[1], routeId: r.batches.issueSscc.id },
  'batches-addition-sources': { schema: r.batches.additionSources.response, data: s6.additionSources, routeId: r.batches.additionSources.id },
  'planning-orders': { schema: r.planning.orders.response, data: s6.planning, routeId: r.planning.orders.id },
  'master-data-formulas': { schema: r.masterData.formulas.response, data: { formulas: [s6.formulaSummary] }, routeId: r.masterData.formulas.id },
  'master-data-create-formula': { schema: r.masterData.createFormula.response, data: s6.formulaSummary, routeId: r.masterData.createFormula.id },
  'master-data-formula': {
    schema: r.masterData.formula.response,
    data: { formula: s6.formulaSummary, versions: [s6.formulaVersion], compositionReadable: true },
    routeId: r.masterData.formula.id,
  },
  'master-data-formula-no-read': {
    schema: r.masterData.formula.response,
    data: { formula: s6.formulaSummary, versions: [{ ...s6.formulaVersion, lines: null }], compositionReadable: false },
    routeId: r.masterData.formula.id,
  },
  'master-data-add-formula-version': {
    schema: r.masterData.addFormulaVersion.response,
    data: { ...s6.formulaVersion, versionId: 'f2a3b4c5-d6e7-4f8a-8b9c-0d1e2f3a4b5d', versionNumber: 2, state: 'DRAFT', changeReason: 'Coating level changed', approvedBy: null, approvedAt: null, signable: { aggregateType: 'formula_version', aggregateId: 'f2a3b4c5-d6e7-4f8a-8b9c-0d1e2f3a4b5d' } },
    routeId: r.masterData.addFormulaVersion.id,
  },
  'designer-formula-choice': {
    schema: r.designer.formulaChoice.response,
    data: { formulaId: s6.formulaSummary.formulaId, versionId: s6.formulaVersion.versionId, versionNumber: 1, productCode: 'GBT01', strength: '500 mg', batchSizeUnits: '200000', bom: s6.formulaVersion.lines },
    routeId: r.designer.formulaChoice.id,
  },
  'plant-areas': { schema: r.plant.areas.response, data: { areas: s6.plant.areas }, routeId: r.plant.areas.id },
  'plant-define-area': { schema: r.plant.defineArea.response, data: s6.plant.areas[0], routeId: r.plant.defineArea.id },
  'plant-equipment-classes': { schema: r.plant.equipmentClasses.response, data: { classes: s6.plant.classes }, routeId: r.plant.equipmentClasses.id },
  'plant-define-equipment-class': { schema: r.plant.defineEquipmentClass.response, data: s6.plant.classes[0], routeId: r.plant.defineEquipmentClass.id },
  'plant-equipment': { schema: r.plant.equipment.response, data: { equipment: s6.plant.equipment }, routeId: r.plant.equipment.id },
  'plant-define-equipment': { schema: r.plant.defineEquipment.response, data: s6.plant.equipment[0], routeId: r.plant.defineEquipment.id },
  'plant-tooling-sets': { schema: r.plant.toolingSets.response, data: { toolingSets: s6.plant.toolingSets }, routeId: r.plant.toolingSets.id },
  'plant-define-tooling-set': { schema: r.plant.defineToolingSet.response, data: s6.plant.toolingSets[0], routeId: r.plant.defineToolingSet.id },
  'plant-detectors': { schema: r.plant.detectors.response, data: { detectors: s6.plant.detectors }, routeId: r.plant.detectors.id },
  'plant-define-detector': { schema: r.plant.defineDetector.response, data: s6.plant.detectors[0], routeId: r.plant.defineDetector.id },
  'plant-test-pieces': { schema: r.plant.testPieces.response, data: { testPieces: s6.plant.testPieces }, routeId: r.plant.testPieces.id },
  'plant-define-test-piece': { schema: r.plant.defineTestPiece.response, data: s6.plant.testPieces[0], routeId: r.plant.defineTestPiece.id },
  'plant-utilities': { schema: r.plant.utilities.response, data: { utilities: s6.plant.utilities }, routeId: r.plant.utilities.id },
  'plant-define-utility': { schema: r.plant.defineUtility.response, data: s6.plant.utilities[0], routeId: r.plant.defineUtility.id },
  'plant-start-cleaning': { schema: r.plant.startCleaning.response, data: { ...s6.plant.cleaning, state: 'IN_PROGRESS' }, routeId: r.plant.startCleaning.id },
  'plant-complete-cleaning': { schema: r.plant.completeCleaning.response, data: s6.plant.cleaning, routeId: r.plant.completeCleaning.id },
  'plant-record-clearance': { schema: r.plant.recordClearance.response, data: s6.plant.clearance, routeId: r.plant.recordClearance.id },
  'plant-equipment-event': { schema: r.plant.equipmentEvent.response, data: s6.plant.equipmentEvent, routeId: r.plant.equipmentEvent.id },
  'plant-pending-verifications': { schema: r.plant.pendingVerifications.response, data: s6.plant.pending, routeId: r.plant.pendingVerifications.id },
  'quality-deviations': { schema: r.quality.deviations.response, data: s6.quality.deviations, routeId: r.quality.deviations.id },
  'quality-evidence-document': { schema: r.quality.registerEvidenceDocument.response, data: s6.quality.evidenceDocument, routeId: r.quality.registerEvidenceDocument.id },
  'quality-extra-testing': { schema: r.quality.extraTesting.response, data: s6.quality.extraTesting, routeId: r.quality.extraTesting.id },
  'quality-erp-orders': { schema: r.quality.erpOrders.response, data: s6.quality.erpOrders, routeId: r.quality.erpOrders.id },
  'quality-erp-products': { schema: r.quality.erpProducts.response, data: s6.quality.erpProducts, routeId: r.quality.erpProducts.id },
  'quality-erp-materials': { schema: r.quality.erpMaterials.response, data: s6.quality.erpMaterials, routeId: r.quality.erpMaterials.id },
  'batches-issue-bulk': {
    schema: r.batches.issueBulk.response,
    data: {
      batchId: '5d2c0b7e-8f1a-4c3d-9e4f-0a1b2c3d4e5f', parentBatchId: '6e3d1c8f-9a2b-4d4e-8f5a-1b2c3d4e5f60',
      containers: [{ label: 'OC-G2600001-1001', containerId: '7f4e2d9a-0b3c-4e5f-9a6b-2c3d4e5f6071', quantity: '25.500', unit: 'kg' }],
    },
    routeId: r.batches.issueBulk.id,
  },
  'quality-erp-pending': {
    schema: r.quality.erpPending.response,
    data: {
      pending: [
        {
          masterKind: 'PRODUCT', key: 'PCM500|500 mg', versionId: '0b5c1d2e-3f40-4a51-8b62-7c83d94ea5f6', erpReference: 'SAP-MM-FG-PCM500/2', receivedAt: { us: '1790000000000000', text: '21-SEP-2026 19:43:20 +05:30 (Asia/Kolkata)' },
          values: { productName: 'Paracetamol tablets IP 500 mg', reprocessingPermitted: true, betaLactam: false, shelfLifeMonths: 36 },
          inEffect: { productName: 'Paracetamol tablets IP 500 mg', reprocessingPermitted: false, betaLactam: false, shelfLifeMonths: 36 },
        },
      ],
    },
    routeId: r.quality.erpPending.id,
  },
  'quality-lots': { schema: r.quality.lots.response, data: s6.quality.lots, routeId: r.quality.lots.id },
  'esig-describe': { schema: r.esig.describe.response, data: s6.describe, routeId: r.esig.describe.id },
  'quality-reprocessing-requests': { schema: r.quality.reprocessingRequests.response, data: s6.reprocessing.requests, routeId: r.quality.reprocessingRequests.id },
  'quality-reprocessing-authorisations': { schema: r.quality.reprocessingAuthorisations.response, data: s6.reprocessing.authorisations, routeId: r.quality.reprocessingAuthorisations.id },
  'quality-residues': { schema: r.quality.residues.response, data: s6.reprocessing.residues, routeId: r.quality.residues.id },
  'quality-receive-lot': { schema: r.quality.receiveLot.response, data: s6.quality.lots.lots[0], routeId: r.quality.receiveLot.id },
  // Phase 4 slice 1 (1-0): the review routes, for the screens (1c) before the server (1a).
  'review-queue': { schema: r.review.queue.response, data: rv.queue, routeId: r.review.queue.id },
  'review-batch': { schema: r.review.batch.response, data: rv.batch, routeId: r.review.batch.id },
  'review-register': { schema: r.review.register.response, data: rv.register, routeId: r.review.register.id },
  'review-open-item': { schema: r.review.openItem.response, data: rv.itemDetail, routeId: r.review.openItem.id },
  'review-respond': { schema: r.review.respond.response, data: { ...rv.item, reviewStatus: 'RESPONDED' }, routeId: r.review.respond.id },
  'review-audit-trail': { schema: r.review.auditTrail.response, data: rv.auditTrail, routeId: r.review.auditTrail.id },
  'review-record-abort-checklist': {
    schema: r.review.recordAbortChecklist.response,
    data: {
      ...rv.batch,
      executionStatus: 'ABORTED',
      reviewState: 'ABORTED',
      acts: [],
      abortChecklist: {
        materialsAccounted: 'All dispensed material is in the reconciliation of stage 1.',
        outputsDispositioned: 'Both granule containers are HELD for QA.',
        equipmentDirty: 'FBD-01 and RMG-02 set to dirty.',
        genealogyClosed: 'No output was charged anywhere.',
        contingencyReconciled: 'No contingency form was issued.',
        recordedBy: rv.batch.acts[0]?.by,
        recordedAt: rv.batch.acts[0]?.at,
      },
    },
    routeId: r.review.recordAbortChecklist.id,
  },
  'review-record-translation': { schema: r.review.recordTranslation.response, data: rv.batch, routeId: r.review.recordTranslation.id },
  'review-verify-translation': { schema: r.review.verifyTranslation.response, data: rv.batch, routeId: r.review.verifyTranslation.id },
  // Phase 4 slice 1b: the container routes and the process readings of the device-to-entry path, for the screens (1c).
  'containers-list': { schema: r.containers.list.response, data: { containers: [cn.closedTyped, cn.held] }, routeId: r.containers.list.id },
  'containers-open': { schema: r.containers.open.response, data: { ...cn.closedTyped, state: 'OPEN', version: 1, netQuantity: null, closeBasis: null, closedBy: null, closedAt: null, usableProblem: 'container OC-B26-0001-0003 is still open' }, routeId: r.containers.open.id },
  'containers-close': { schema: r.containers.close.response, data: cn.closedTyped, routeId: r.containers.close.id },
  'containers-sort': { schema: r.containers.sort.response, data: { ...cn.held, state: 'SORTED', version: 4, usableProblem: 'container OC-B26-0001-0004 is SORTED: held containers are never merged, charged or packed until QA releases them' }, routeId: r.containers.sort.id },
  'containers-reject': { schema: r.containers.reject.response, data: { ...cn.held, state: 'REJECTED', version: 4, usableProblem: 'container OC-B26-0001-0004 is REJECTED', releaseProblem: null }, routeId: r.containers.reject.id },
  'devices-process-readings': { schema: r.devices.processReadings.response, data: cn.processReadings, routeId: r.devices.processReadings.id },
  // Phase 4 slice 2c: packaging orders, planned from an issued processing batch, and their bulk issue.
  'planning-packaging-orders': { schema: r.planning.packagingOrders.response, data: pk.orders, routeId: r.planning.packagingOrders.id },
  'planning-plan-packaging-order': { schema: r.planning.planPackagingOrder.response, data: pk.planned, routeId: r.planning.planPackagingOrder.id },
  'planning-packaging-bulk': { schema: r.planning.packagingBulk.response, data: pk.bulk, routeId: r.planning.packagingBulk.id },
  'deviation-detail': { schema: r.quality.deviationDetail.response, data: dv.detail, routeId: r.quality.deviationDetail.id },
  'deviation-reclassify': { schema: r.quality.reclassifyDeviation.response, data: dv.detail, routeId: r.quality.reclassifyDeviation.id },
  'deviation-impact': { schema: r.quality.recordDeviationImpact.response, data: { ...dv.detail, state: 'UNDER_INVESTIGATION', impactCurrent: false }, routeId: r.quality.recordDeviationImpact.id },
  'deviation-closure-basis': { schema: r.quality.recordDeviationClosureBasis.response, data: { ...dv.detail, closureBasis: dv.closureBasis }, routeId: r.quality.recordDeviationClosureBasis.id },
  'deviation-release': { schema: r.quality.deviationRelease.response, data: dv.release, routeId: r.quality.deviationRelease.id },
  // Phase 4 slice 2b: specifications, lot decisions, finished lots, samples and returned goods, for the screens (2c).
  'specifications-list': { schema: r.specifications.list.response, data: { specifications: [lm.specification] }, routeId: r.specifications.list.id },
  'specifications-draft': { schema: r.specifications.draft.response, data: { ...lm.specification, state: 'DRAFT', approvedBy: null, approvedAt: null }, routeId: r.specifications.draft.id },
  'specifications-mark-edition': { schema: r.specifications.markEdition.response, data: { editionId: '4e0b2f1a-3c5d-4e6f-9a7b-9c0d1e2f3a41' }, routeId: r.specifications.markEdition.id },
  'specifications-edition-review': { schema: r.specifications.editionReview.response, data: lm.editionReview, routeId: r.specifications.editionReview.id },
  'specifications-lot-release-check': { schema: r.specifications.lotReleaseCheck.response, data: lm.releaseCheck, routeId: r.specifications.lotReleaseCheck.id },
  'specifications-propose-lot-decision': { schema: r.specifications.proposeLotDecision.response, data: lm.proposal, routeId: r.specifications.proposeLotDecision.id },
  'specifications-post-finished-lot': { schema: r.specifications.postFinishedLot.response, data: lm.finishedLot, routeId: r.specifications.postFinishedLot.id },
  'samples-list': { schema: r.samples.list.response, data: { samples: [lm.sample] }, routeId: r.samples.list.id },
  'samples-pull': { schema: r.samples.pull.response, data: lm.sample, routeId: r.samples.pull.id },
  'samples-dispose': {
    schema: r.samples.dispose.response,
    data: { ...lm.sample, disposedBy: { ...lm.sample.pulledBy, role: 'DISPOSER' }, disposedAt: lm.sample.retainUntil, disposalReason: 'Retention period over' },
    routeId: r.samples.dispose.id,
  },
  'samples-returns': { schema: r.samples.returns.response, data: { returns: [lm.return] }, routeId: r.samples.returns.id },
  'samples-receive-return': { schema: r.samples.receiveReturn.response, data: { ...lm.return, assessment: null }, routeId: r.samples.receiveReturn.id },
  'samples-assess-return': { schema: r.samples.assessReturn.response, data: { ...lm.return, assessment: { ...lm.return.assessment, signed: false } }, routeId: r.samples.assessReturn.id },
  // Phase 4 slice 3 (3-0): the release routes, for the cockpit (3c) before the server (3a).
  'release-queue': { schema: r.release.queue.response, data: rl.queue, routeId: r.release.queue.id },
  'release-lot': { schema: r.release.lot.response, data: rl.lot, routeId: r.release.lot.id },
  'release-lot-released': { schema: r.release.lot.response, data: rl.released },
  'release-grel': { schema: r.release.grel.response, data: rl.grel, routeId: r.release.grel.id },
  'release-acknowledge': { schema: r.release.acknowledge.response, data: rl.grel, routeId: r.release.acknowledge.id },
  // Phase 4 slice 4 (4-0): market dispositions, market add, certification intake, importers (screens of 4c).
  'release-markets': { schema: r.release.markets.response, data: rl.markets, routeId: r.release.markets.id },
  'release-market-add': { schema: r.release.marketAdd.response, data: rl.marketAdd, routeId: r.release.marketAdd.id },
  'release-batch-market-add': { schema: r.release.batchMarketAdd.response, data: { ...rl.marketAdd, subjectKind: 'BATCH' }, routeId: r.release.batchMarketAdd.id },
  'release-qp-message': { schema: r.release.qpMessage.response, data: rl.qpAck, routeId: r.release.qpMessage.id },
  'release-importers': { schema: r.release.importers.response, data: rl.importers, routeId: r.release.importers.id },
  // Phase 4 slice 5a: after release (suspension, recall, rejection after release and disposal).
  'release-suspended': { schema: r.release.suspended.response, data: rl.suspended, routeId: r.release.suspended.id },
  'release-after-release': { schema: r.release.afterRelease.response, data: rl.afterRelease, routeId: r.release.afterRelease.id },
  'release-after-release-disposed': { schema: r.release.afterRelease.response, data: rl.afterReleaseDisposed },
  // Phase 4 slice 3c: the notification centre (IN-39 clause 2).
  'notifications-list': { schema: r.notifications.list.response, data: nt.list, routeId: r.notifications.list.id },
  'notifications-acknowledge': { schema: r.notifications.acknowledge.response, data: nt.list.notifications[0], routeId: r.notifications.acknowledge.id },
  // Phase 4 slice 4b: the EU QP batch package, the QP's read-only access and the ERP shipping interlock.
  'qp-package-lot': { schema: r.qpPackage.lot.response, data: qs.lot, routeId: r.qpPackage.lot.id },
  'qp-package-assemble': { schema: r.qpPackage.assemble.response, data: { ...qs.package, state: 'ASSEMBLED', issuedBy: null, issuedAt: null, signatureId: null }, routeId: r.qpPackage.assemble.id },
  'qp-package-grant-access': { schema: r.qpPackage.grantAccess.response, data: { ...qs.access, reads: 0 }, routeId: r.qpPackage.grantAccess.id },
  'qp-package-revoke-access': { schema: r.qpPackage.revokeAccess.response, data: { ...qs.access, state: 'REVOKED' }, routeId: r.qpPackage.revokeAccess.id },
  'qp-reader-packages': { schema: r.qpPackage.readerPackages.response, data: qs.reader, routeId: r.qpPackage.readerPackages.id },
  'qp-reader-file': { schema: r.qpPackage.readerFile.response, data: qs.file, routeId: r.qpPackage.readerFile.id },
  'erp-shipping-check': { schema: r.erpShipping.check.response, data: qs.checkAllowed, routeId: r.erpShipping.check.id },
  'erp-shipping-check-refused': { schema: r.erpShipping.check.response, data: qs.checkRefused },
  'erp-shipping-record': { schema: r.erpShipping.record.response, data: qs.shipment, routeId: r.erpShipping.record.id },
  'erp-shipping-lot': { schema: r.erpShipping.lot.response, data: qs.shipments, routeId: r.erpShipping.lot.id },
  // Phase 4 slice 5b: record locking and amendment, the bulk reconciliation and the bright-stock maximum hold (screens of 5c).
  'records-locks': { schema: r.records.locks.response, data: rk.locks, routeId: r.records.locks.id },
  'records-lock': { schema: r.records.lock.response, data: rk.lock, routeId: r.records.lock.id },
  'records-lock-closed': { schema: r.records.lock.response, data: { ...rk.lock, state: 'LOCKED', amendments: [rk.amendmentClosed], openAmendmentNumber: null } },
  'records-bulk': { schema: r.records.bulk.response, data: rk.bulk, routeId: r.records.bulk.id },
  'records-close-bulk': { schema: r.records.closeBulk.response, data: rk.bulkClosed, routeId: r.records.closeBulk.id },
  'records-append-amendment-entry': { schema: r.records.appendAmendmentEntry.response, data: rk.amendment, routeId: r.records.appendAmendmentEntry.id },
  'records-bright-stock-holds': { schema: r.records.brightStockHolds.response, data: { holds: [rk.hold] }, routeId: r.records.brightStockHolds.id },
  'records-set-bright-stock-hold': { schema: r.records.setBrightStockHold.response, data: rk.hold, routeId: r.records.setBrightStockHold.id },
  // Phase 4 slice 6a: licences, export permissions, the issue check, the allocation register, label particulars and H2.
  'india-licences': { schema: r.india.licences.response, data: { licences: [ind.licence, ind.loanLicence] }, routeId: r.india.licences.id },
  'india-record-licence': { schema: r.india.recordLicence.response, data: ind.loanLicence, routeId: r.india.recordLicence.id },
  'india-suspend-licence': {
    schema: r.india.suspendLicence.response,
    data: { ...ind.licence, state: 'SUSPENDED', current: false, suspension: { reason: 'Suspended by order of the licensing authority', suspendedBy: ind.licence.approvedBy, suspendedAt: ind.licence.approvedAt } },
    routeId: r.india.suspendLicence.id,
  },
  'india-export-permissions': { schema: r.india.exportPermissions.response, data: { permissions: [ind.permission] }, routeId: r.india.exportPermissions.id },
  'india-record-export-permission': {
    schema: r.india.recordExportPermission.response,
    data: { ...ind.permission, state: 'DRAFT', current: false, approvedBy: null, approvedAt: null },
    routeId: r.india.recordExportPermission.id,
  },
  'india-suspend-export-permission': {
    schema: r.india.suspendExportPermission.response,
    data: { ...ind.permission, state: 'SUSPENDED', current: false, suspension: { reason: 'Withdrawn by the authority', suspendedBy: ind.permission.approvedBy, suspendedAt: ind.permission.approvedAt } },
    routeId: r.india.suspendExportPermission.id,
  },
  'india-check': { schema: r.india.check.response, data: ind.check, routeId: r.india.check.id },
  'india-allocation-register': { schema: r.india.allocationRegister.response, data: { siteCode: 'SITE-1', entries: [ind.entry, ind.voided] }, routeId: r.india.allocationRegister.id },
  'india-label': { schema: r.india.label.response, data: ind.label, routeId: r.india.label.id },
  'india-label-problem': { schema: r.india.label.response, data: ind.labelProblem },
  'india-issue-h2': { schema: r.india.issueH2.response, data: ind.h2, routeId: r.india.issueH2.id },
  'india-verify-h2': { schema: r.india.verifyH2.response, data: { batchId: ind.h2.batchId, problem: null }, routeId: r.india.verifyH2.id },
  'india-shelf-life-bases': { schema: r.india.shelfLifeBases.response, data: { bases: [ind.basis] }, routeId: r.india.shelfLifeBases.id },
  'india-record-shelf-life-basis': { schema: r.india.recordShelfLifeBasis.response, data: ind.basis, routeId: r.india.recordShelfLifeBasis.id },
  'india-hazards': { schema: r.india.hazards.response, data: ind.hazards, routeId: r.india.hazards.id },
  'india-record-hazard': { schema: r.india.recordHazard.response, data: ind.hazards, routeId: r.india.recordHazard.id },
} as const satisfies Record<string, Example>;

/** Phase 4 slice 6a: the india routes, each with an example above (checked by the india contract test). */
export const INDIA_ROUTE_IDS: readonly string[] = Object.values(r.india).map((route) => route.id);

/** Phase 4 slice 5b: the record-lock routes, each with an example above (checked by the contract test). */
export const RECORDS_LOCK_ROUTE_IDS: readonly string[] = Object.values(r.records).map((route) => route.id);

/** Phase 4 slice 4b: the QP package and ERP shipping routes, each with an example above (checked by the contract test). */
export const QP_SHIPPING_ROUTE_IDS: readonly string[] = [...Object.values(r.qpPackage), ...Object.values(r.erpShipping)].map((route) => route.id);

/** Phase 4 slice 3: the release routes, each with an example above (checked by the contract test). */
export const RELEASE_ROUTE_IDS: readonly string[] = Object.values(r.release).map((route) => route.id);

/** Phase 4 slice 2b: the specifications and samples routes, each with an example above (checked by the contract test). */
export const LIMS_ROUTE_IDS: readonly string[] = [...Object.values(r.specifications), ...Object.values(r.samples)].map((route) => route.id);

/** Phase 3 slice 6: the routes added by slice 6a-0, each with at least one example above (checked by the contract test). */
export const SLICE_6_ROUTE_IDS: readonly string[] = [
  ...Object.values(r.batches),
  ...Object.values(r.planning),
  ...Object.values(r.masterData),
  ...Object.values(r.plant),
  r.designer.formulaChoice,
  r.quality.deviations,
  r.quality.registerEvidenceDocument,
  r.quality.extraTesting,
  r.quality.erpOrders,
  r.quality.erpProducts,
  r.quality.erpMaterials,
  r.quality.lots,
  r.quality.receiveLot,
  r.quality.reprocessingRequests,
  r.quality.reprocessingAuthorisations,
  r.quality.residues,
].map((route) => route.id);

/** Phase 4 slice 1: the review routes, each with at least one example above (checked by the contract test). */
export const REVIEW_ROUTE_IDS: readonly string[] = Object.values(r.review).map((route) => route.id);

/** Phase 4 slice 1b: the container routes and the process-readings route, each with an example above (contract test). */
export const CONTAINER_ROUTE_IDS: readonly string[] = [...Object.values(r.containers), r.devices.processReadings].map((route) => route.id);

/** Phase 4 slice 2a: the full deviation stand-in's routes, each with an example above (contract test). */
export const DEVIATION_ROUTE_IDS: readonly string[] = [r.quality.deviationDetail, r.quality.reclassifyDeviation, r.quality.recordDeviationImpact, r.quality.recordDeviationClosureBasis, r.quality.deviationRelease].map((route) => route.id);

export type ExampleName = keyof typeof EXAMPLES;

/** The step screen examples by block, in template order. */
export const STEP_EXAMPLES_BY_BLOCK: Readonly<Record<string, ExampleName>> = {
  'G-10@1': 'step-g10-clearance',
  'G-09@1': 'step-g09-equipment-status',
  'G-03@1': 'step-g03-acknowledge',
  'G-07@1': 'step-g07-weighing',
  'G-20@1': 'step-g20-yield',
  'G-08@1': 'step-g08-charge',
  'G-04@1': 'step-g04-parameters',
  'G-17@1': 'step-g17-hold-point',
  'G-22@1': 'step-g22-output',
};

/** An example parsed with its schema (typed as the schema's output). */
export function example<N extends ExampleName>(name: N): z.output<(typeof EXAMPLES)[N]['schema']> {
  const e = EXAMPLES[name];
  return e.schema.parse(e.data) as z.output<(typeof EXAMPLES)[N]['schema']>;
}
