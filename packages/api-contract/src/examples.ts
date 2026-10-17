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
import ig from '../fixtures/integrations.json' with { type: 'json' };
import al from '../fixtures/alarms.json' with { type: 'json' };
import pr from '../fixtures/plant-rules.json' with { type: 'json' };
import eqd from '../fixtures/equipment-data.json' with { type: 'json' };
import cp from '../fixtures/capa.json' with { type: 'json' };
import cfg from '../fixtures/config.json' with { type: 'json' };
import lb from '../fixtures/labels.json' with { type: 'json' };
import sr from '../fixtures/serialisation.json' with { type: 'json' };
import rc from '../fixtures/receipt.json' with { type: 'json' };
import ind from '../fixtures/india.json' with { type: 'json' };
import pq from '../fixtures/pqr.json' with { type: 'json' };
import gv from '../fixtures/governance.json' with { type: 'json' };
import cs from '../fixtures/controlled.json' with { type: 'json' };
import ar from '../fixtures/archive.json' with { type: 'json' };
import gn from '../fixtures/genealogy.json' with { type: 'json' };
import db6g from '../fixtures/dashboards.json' with { type: 'json' };
import ci6g from '../fixtures/change-impact.json' with { type: 'json' };
import tr6g from '../fixtures/training.json' with { type: 'json' };
import mr from '../fixtures/recall.json' with { type: 'json' };
import xf from '../fixtures/transfers.json' with { type: 'json' };
import fd from '../fixtures/federation.json' with { type: 'json' };
import ana from '../fixtures/analytics.json' with { type: 'json' };
import anaConfig from '../fixtures/analytics-config.json' with { type: 'json' };
import anaAudit from '../fixtures/analytics-audit.json' with { type: 'json' };
import anaMspc from '../fixtures/analytics-mspc.json' with { type: 'json' };
import anaProfile from '../fixtures/analytics-profile.json' with { type: 'json' };
import anaReview from '../fixtures/analytics-review.json' with { type: 'json' };
import anaSpc from '../fixtures/analytics-spc.json' with { type: 'json' };
import { ANALYTICS_NAMESPACES } from './analytics-namespaces.ts';
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
  // Phase 6 slice 6d: the chemical recovery of the returned goods (site services 0960).
  'samples-recover-return': { schema: r.samples.recoverReturn.response, data: { returnedLotId: lm.return.lotId, recoveredLotId: 'a3000000-0000-4000-8000-000000000001', recoveredLotCode: `${lm.return.lotCode}-CR` }, routeId: r.samples.recoverReturn.id },
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
  // Phase 6 slice 6a-0: the integrations namespace (health page, alarms; screens of 6a).
  'integrations-adapters': { schema: r.integrations.adapters.response, data: ig.adapters, routeId: r.integrations.adapters.id },
  'integrations-adapter': { schema: r.integrations.adapter.response, data: ig.adapter, routeId: r.integrations.adapter.id },
  'integrations-reconciliations': { schema: r.integrations.reconciliations.response, data: ig.reconciliations, routeId: r.integrations.reconciliations.id },
  'integrations-mirrors': { schema: r.integrations.mirrors.response, data: ig.mirrors, routeId: r.integrations.mirrors.id },
  'integrations-mirrors-stale': { schema: r.integrations.mirrors.response, data: ig.mirrorsStale },
  'integrations-alarms': { schema: r.integrations.alarms.response, data: ig.alarms, routeId: r.integrations.alarms.id },
  'integrations-acknowledge-alarm': { schema: r.integrations.acknowledgeAlarm.response, data: ig.alarmAcknowledged, routeId: r.integrations.acknowledgeAlarm.id },
  // Phase 6 slice 6b-0: the plant alarm log (DI-49) and native equipment data (DI-32); screens of 6b.
  'alarms-list': { schema: r.alarms.list.response, data: al.list, routeId: r.alarms.list.id },
  'alarms-batch-log': { schema: r.alarms.batchLog.response, data: al.batchLog, routeId: r.alarms.batchLog.id },
  'alarms-alarm': { schema: r.alarms.alarm.response, data: al.alarm, routeId: r.alarms.alarm.id },
  'alarms-acknowledge': { schema: r.alarms.acknowledge.response, data: al.acknowledged, routeId: r.alarms.acknowledge.id },
  'equipment-data-tags': { schema: r.equipmentData.tags.response, data: eqd.tags, routeId: r.equipmentData.tags.id },
  'equipment-data-series': { schema: r.equipmentData.series.response, data: eqd.series, routeId: r.equipmentData.series.id },
  'equipment-data-batch-series': { schema: r.equipmentData.batchSeries.response, data: eqd.batchSeries, routeId: r.equipmentData.batchSeries.id },
  'equipment-data-events': { schema: r.equipmentData.events.response, data: eqd.events, routeId: r.equipmentData.events.id },
  'equipment-data-originals': { schema: r.equipmentData.originals.response, data: eqd.originals, routeId: r.equipmentData.originals.id },
  // Phase 6 slice 6b (builder B): the status displays (PR-22, PR-35) and the plant rules (PR-15, PR-25, PR-27, PR-29).
  'equipment-displays-status-board': { schema: r.equipmentDisplays.statusBoard.response, data: pr.statusBoard, routeId: r.equipmentDisplays.statusBoard.id },
  'equipment-displays-line-station': { schema: r.equipmentDisplays.lineStation.response, data: pr.lineStation, routeId: r.equipmentDisplays.lineStation.id },
  'plant-rules-rooms': { schema: r.plantRules.rooms.response, data: pr.rooms, routeId: r.plantRules.rooms.id },
  'plant-rules-room-conditions': { schema: r.plantRules.roomConditions.response, data: pr.roomConditions, routeId: r.plantRules.roomConditions.id },
  'plant-rules-record-spill': { schema: r.plantRules.recordSpill.response, data: pr.room, routeId: r.plantRules.recordSpill.id },
  'plant-rules-set-room-rule': { schema: r.plantRules.setRoomRule.response, data: pr.room, routeId: r.plantRules.setRoomRule.id },
  'plant-rules-adjacencies': { schema: r.plantRules.adjacencies.response, data: pr.adjacencies, routeId: r.plantRules.adjacencies.id },
  'plant-rules-define-adjacency': { schema: r.plantRules.defineAdjacency.response, data: pr.version, routeId: r.plantRules.defineAdjacency.id },
  'plant-rules-set-facility-rule': { schema: r.plantRules.setFacilityRule.response, data: pr.proposal, routeId: r.plantRules.setFacilityRule.id },
  'plant-rules-classify-beta-lactam': { schema: r.plantRules.classifyBetaLactam.response, data: pr.proposal, routeId: r.plantRules.classifyBetaLactam.id },
  'plant-rules-create-area-authorisation': { schema: r.plantRules.createAreaAuthorisation.response, data: pr.areaAuthorisation, routeId: r.plantRules.createAreaAuthorisation.id },
  'plant-rules-area-authorisations': { schema: r.plantRules.areaAuthorisations.response, data: pr.areaAuthorisations, routeId: r.plantRules.areaAuthorisations.id },
  'plant-rules-record-area-authorisation': { schema: r.plantRules.recordAreaAuthorisation.response, data: pr.areaAuthorisationRecord, routeId: r.plantRules.recordAreaAuthorisation.id },
  'plant-rules-withdraw-area-authorisation': { schema: r.plantRules.withdrawAreaAuthorisation.response, data: pr.areaAuthorisationWithdrawn, routeId: r.plantRules.withdrawAreaAuthorisation.id },
  'plant-rules-reagent-lots': { schema: r.plantRules.reagentLots.response, data: pr.reagentLots, routeId: r.plantRules.reagentLots.id },
  'plant-rules-record-reagent-lot': { schema: r.plantRules.recordReagentLot.response, data: pr.reagentLot, routeId: r.plantRules.recordReagentLot.id },
  'plant-rules-withdraw-reagent-lot': { schema: r.plantRules.withdrawReagentLot.response, data: pr.reagentLot, routeId: r.plantRules.withdrawReagentLot.id },
  'plant-rules-record-reagent-use': { schema: r.plantRules.recordReagentUse.response, data: pr.reagentUse, routeId: r.plantRules.recordReagentUse.id },
  // Phase 6 slice 6a (builder B): the CAPA register and detail (IN-01 (d), PR-51).
  'capa-register': { schema: r.capa.register.response, data: cp.register, routeId: r.capa.register.id },
  'capa-detail': { schema: r.capa.detail.response, data: cp.detail, routeId: r.capa.detail.id },
  'capa-detail-closable': { schema: r.capa.detail.response, data: cp.detailClosable },
  'capa-detail-mirror': { schema: r.capa.detail.response, data: cp.mirror },
  'capa-raise': { schema: r.capa.raise.response, data: { ...cp.detail, state: 'OPEN', events: [] }, routeId: r.capa.raise.id },
  'capa-link-deviation': { schema: r.capa.linkDeviation.response, data: cp.detail, routeId: r.capa.linkDeviation.id },
  'capa-link-master-version': { schema: r.capa.linkMasterVersion.response, data: cp.detail, routeId: r.capa.linkMasterVersion.id },
  'capa-implement': { schema: r.capa.implement.response, data: cp.detail, routeId: r.capa.implement.id },
  'capa-schedule-check': { schema: r.capa.scheduleCheck.response, data: cp.detail, routeId: r.capa.scheduleCheck.id },
  'capa-record-effectiveness': { schema: r.capa.recordEffectiveness.response, data: cp.detailClosable, routeId: r.capa.recordEffectiveness.id },
  'capa-cancel': { schema: r.capa.cancel.response, data: { ...cp.detail, state: 'CANCELLED' }, routeId: r.capa.cancel.id },
  // Phase 6 slice 6f (builder A): configuration change control (DI-09) and RBE rules (DI-26).
  'config-areas': { schema: r.config.areas.response, data: { areas: cfg.areas }, routeId: r.config.areas.id },
  'config-change-records': { schema: r.config.changeRecords.response, data: { changeRecords: [cfg.open, cfg.approved] }, routeId: r.config.changeRecords.id },
  'config-raise-change-record': { schema: r.config.raiseChangeRecord.response, data: cfg.open, routeId: r.config.raiseChangeRecord.id },
  'config-close-change-record': { schema: r.config.closeChangeRecord.response, data: { ...cfg.approved, state: 'CLOSED', closedAt: cfg.approved.approvedAt }, routeId: r.config.closeChangeRecord.id },
  'config-as-of': { schema: r.config.asOf.response, data: cfg.asOf, routeId: r.config.asOf.id },
  'config-diff': { schema: r.config.diff.response, data: cfg.diff, routeId: r.config.diff.id },
  'config-settings': { schema: r.config.settings.response, data: { settings: [cfg.setting] }, routeId: r.config.settings.id },
  'config-set-setting': { schema: r.config.setSetting.response, data: { ...cfg.setting, value: 'MIRROR' }, routeId: r.config.setSetting.id },
  'config-rbe-rules': { schema: r.config.rbeRules.response, data: { rules: cfg.rules }, routeId: r.config.rbeRules.id },
  'config-set-rbe-rule': { schema: r.config.setRbeRule.response, data: cfg.rules[0], routeId: r.config.setRbeRule.id },
  // Phase 6 slice 6c: label templates, labelling declarations, the label store, the packaging order's completion evidence.
  'labels-bindings': { schema: r.labels.bindings.response, data: lb.bindings, routeId: r.labels.bindings.id },
  'labels-templates': { schema: r.labels.templates.response, data: lb.templates, routeId: r.labels.templates.id },
  'labels-template': { schema: r.labels.template.response, data: lb.template, routeId: r.labels.template.id },
  'labels-template-no-mfg': { schema: r.labels.template.response, data: lb.templateNoMfg },
  'labels-create-template': { schema: r.labels.createTemplate.response, data: lb.template, routeId: r.labels.createTemplate.id },
  'labels-approve-template': { schema: r.labels.approveTemplate.response, data: lb.templateApproved, routeId: r.labels.approveTemplate.id },
  'labels-master-labelling': { schema: r.labels.masterLabelling.response, data: lb.master, routeId: r.labels.masterLabelling.id },
  'labels-declare-labelling': { schema: r.labels.declareLabelling.response, data: lb.masterOk, routeId: r.labels.declareLabelling.id },
  'labels-store': { schema: r.labels.store.response, data: lb.store, routeId: r.labels.store.id },
  'labels-open-store-transaction': { schema: r.labels.openStoreTransaction.response, data: lb.store, routeId: r.labels.openStoreTransaction.id },
  'labels-packaging': { schema: r.labels.packaging.response, data: lb.packaging, routeId: r.labels.packaging.id },
  'labels-packaging-done': { schema: r.labels.packaging.response, data: lb.packagingDone },
  'labels-packaging-stopped': { schema: r.labels.packaging.response, data: lb.packagingStopped },
  'labels-record-coding-specimen': { schema: r.labels.recordCodingSpecimen.response, data: lb.packaging, routeId: r.labels.recordCodingSpecimen.id },
  'labels-record-label-specimen': { schema: r.labels.recordLabelSpecimen.response, data: lb.packaging, routeId: r.labels.recordLabelSpecimen.id },
  'labels-void-specimen': { schema: r.labels.voidSpecimen.response, data: lb.packaging, routeId: r.labels.voidSpecimen.id },
  'labels-record-post-use-inspection': { schema: r.labels.recordPostUseInspection.response, data: lb.packagingDone, routeId: r.labels.recordPostUseInspection.id },
  'labels-verify-post-use-inspection': { schema: r.labels.verifyPostUseInspection.response, data: lb.packagingDone, routeId: r.labels.verifyPostUseInspection.id },
  'labels-resolve-line-stop': { schema: r.labels.resolveLineStop.response, data: lb.packaging, routeId: r.labels.resolveLineStop.id },
  'labels-enable-waiver': { schema: r.labels.enableWaiver.response, data: lb.packagingDone, routeId: r.labels.enableWaiver.id },
  // Phase 6 slice 6c: serialisation L3/L4 (PR-42).
  'serialisation-serial': { schema: r.serialisation.serial.response, data: sr.lookup, routeId: r.serialisation.serial.id },
  'serialisation-batch-pools': { schema: r.serialisation.batchPools.response, data: sr.pools, routeId: r.serialisation.batchPools.id },
  'serialisation-batch-pools-stale': { schema: r.serialisation.batchPools.response, data: sr.poolsStale },
  'serialisation-reject-pool': { schema: r.serialisation.rejectPool.response, data: sr.poolsRejected, routeId: r.serialisation.rejectPool.id },
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
  // Phase 4 slice 6c: the PQR extract (IN-01, PR-58).
  'pqr-extracts': { schema: r.pqr.extracts.response, data: { extracts: [pq.summary] }, routeId: r.pqr.extracts.id },
  'pqr-extract': { schema: r.pqr.extract.response, data: pq.extract, routeId: r.pqr.extract.id },
  'pqr-extract-signed-off': { schema: r.pqr.extract.response, data: pq.signedOff },
  'pqr-run': { schema: r.pqr.run.response, data: pq.extract, routeId: r.pqr.run.id },
  'genealogy-trace': { schema: r.genealogy.trace.response, data: gn.trace, routeId: r.genealogy.trace.id },
  'genealogy-lookup': { schema: r.genealogy.lookup.response, data: gn.lookup, routeId: r.genealogy.lookup.id },
  'genealogy-supply-chain': { schema: r.genealogy.supplyChain.response, data: gn.supplyChain, routeId: r.genealogy.supplyChain.id },
  'genealogy-deviation-impact': { schema: r.genealogy.deviationImpact.response, data: gn.impact, routeId: r.genealogy.deviationImpact.id },
  'genealogy-recurrence': { schema: r.genealogy.recurrence.response, data: gn.recurrence, routeId: r.genealogy.recurrence.id },
  'genealogy-recurrence-quiet': { schema: r.genealogy.recurrence.response, data: gn.recurrenceQuiet },
  'recall-mock-recalls': { schema: r.recall.mockRecalls.response, data: { mockRecalls: [mr.summary] }, routeId: r.recall.mockRecalls.id },
  'recall-mock-recall': { schema: r.recall.mockRecall.response, data: mr.mockRecall, routeId: r.recall.mockRecall.id },
  'recall-mock-recall-signed-off': { schema: r.recall.mockRecall.response, data: mr.signedOff },
  'recall-run': { schema: r.recall.run.response, data: mr.mockRecall, routeId: r.recall.run.id },
  // Phase 6 slice 6i: inter-site transfer packages, peers, alarms, the site-to-site endpoint and the federated reads.
  'recall-mock-recall-federated': { schema: r.recall.mockRecall.response, data: mr.federated },
  'recall-refresh-federation': { schema: r.recall.refreshFederation.response, data: mr.federated, routeId: r.recall.refreshFederation.id },
  'genealogy-federated-trace': { schema: r.genealogy.federatedTrace.response, data: fd.federatedTrace, routeId: r.genealogy.federatedTrace.id },
  'genealogy-federated-trace-incomplete': { schema: r.genealogy.federatedTrace.response, data: fd.federatedTraceIncomplete },
  'federation-genealogy': { schema: r.federation.genealogy.response, data: fd.genealogyAnswer, routeId: r.federation.genealogy.id },
  'transfers-peers': { schema: r.transfers.peers.response, data: { installation: xf.installation, peers: xf.peers }, routeId: r.transfers.peers.id },
  'transfers-propose-peer': { schema: r.transfers.proposePeer.response, data: xf.peers[1], routeId: r.transfers.proposePeer.id },
  'transfers-packages': { schema: r.transfers.packages.response, data: { packages: [xf.package] }, routeId: r.transfers.packages.id },
  'transfers-prepare': { schema: r.transfers.prepare.response, data: xf.file, routeId: r.transfers.prepare.id },
  'transfers-package-file': { schema: r.transfers.packageFile.response, data: xf.file, routeId: r.transfers.packageFile.id },
  'transfers-receipts': { schema: r.transfers.receipts.response, data: { receipts: [xf.receiptSummary] }, routeId: r.transfers.receipts.id },
  'transfers-receipt': { schema: r.transfers.receipt.response, data: xf.receipt, routeId: r.transfers.receipt.id },
  'transfers-receipt-accepted': { schema: r.transfers.receipt.response, data: xf.receiptAccepted },
  'transfers-import': { schema: r.transfers.import.response, data: xf.importReceived, routeId: r.transfers.import.id },
  'transfers-import-refused': { schema: r.transfers.import.response, data: xf.importRefused },
  'transfers-alarms': { schema: r.transfers.alarms.response, data: { alarms: [xf.alarm] }, routeId: r.transfers.alarms.id },
  'transfers-acknowledge-alarm': { schema: r.transfers.acknowledgeAlarm.response, data: xf.alarmAcknowledged, routeId: r.transfers.acknowledgeAlarm.id },
  // Phase 4 slice 6b: retention, contingency packs, evidence export and the inspection workspace.
  'archive-batches': { schema: r.archive.batches.response, data: ar.batches, routeId: r.archive.batches.id },
  'archive-batch': { schema: r.archive.batch.response, data: ar.batch, routeId: r.archive.batch.id },
  'archive-sync-retention': { schema: r.archive.syncRetention.response, data: ar.retention, routeId: r.archive.syncRetention.id },
  'archive-request-disposal': { schema: r.archive.requestDisposal.response, data: ar.disposal, routeId: r.archive.requestDisposal.id },
  'archive-issue-pack': { schema: r.archive.issuePack.response, data: ar.forms, routeId: r.archive.issuePack.id },
  'archive-form-event': { schema: r.archive.formEvent.response, data: ar.forms, routeId: r.archive.formEvent.id },
  'archive-pdf': { schema: r.archive.pdf.response, data: ar.pdf, routeId: r.archive.pdf.id },
  'archive-assemble-export': { schema: r.archive.assembleExport.response, data: { ...ar.export, state: 'ASSEMBLED', certifiedBy: null, certifiedAt: null, reads: 0 }, routeId: r.archive.assembleExport.id },
  'archive-inspection': { schema: r.archive.inspection.response, data: { exports: [ar.export] }, routeId: r.archive.inspection.id },
  'archive-export-file': { schema: r.archive.exportFile.response, data: ar.file, routeId: r.archive.exportFile.id },
  'archive-verify': { schema: r.archive.verify.response, data: ar.verifyOk, routeId: r.archive.verify.id },
  'archive-verify-altered': { schema: r.archive.verify.response, data: ar.verifyBad },
  // Phase 6 slice 6a builder A: receipt with supplier batches, the receipt record and the approved-manufacturer register (PR-17).
  'quality-approved-manufacturers': { schema: r.quality.approvedManufacturers.response, data: { manufacturers: [rc.approved, rc.proposed, rc.withdrawn] }, routeId: r.quality.approvedManufacturers.id },
  'quality-propose-approved-manufacturer': { schema: r.quality.proposeApprovedManufacturer.response, data: rc.proposed, routeId: r.quality.proposeApprovedManufacturer.id },
  'quality-withdraw-manufacturer-approval': { schema: r.quality.withdrawManufacturerApproval.response, data: rc.withdrawn, routeId: r.quality.withdrawManufacturerApproval.id },
  'quality-receive-delivery': { schema: r.quality.receiveDelivery.response, data: rc.delivery, routeId: r.quality.receiveDelivery.id },
  'quality-lot-receipt': { schema: r.quality.lotReceipt.response, data: rc.receipt, routeId: r.quality.lotReceipt.id },
  'quality-lot-receipt-incomplete': { schema: r.quality.lotReceipt.response, data: rc.incomplete },
  'quality-lot-receipt-blocked': { schema: r.quality.lotReceipt.response, data: rc.blocked },
  'quality-record-lot-receipt': { schema: r.quality.recordLotReceipt.response, data: { ...rc.receipt, source: 'MANUAL', inboundMessageId: null, examination: null }, routeId: r.quality.recordLotReceipt.id },
  'quality-examine-lot-receipt': { schema: r.quality.examineLotReceipt.response, data: rc.receipt, routeId: r.quality.examineLotReceipt.id },
  'quality-correct-lot-receipt': { schema: r.quality.correctLotReceipt.response, data: rc.incomplete, routeId: r.quality.correctLotReceipt.id },
  // Phase 6 slice 6f (builder B): vendor support grants (DI-08), the contract giver's reviewer (IN-30), the India DSC (IN-10).
  'support-grants': { schema: r.support.grants.response, data: { grants: [gv.supportActive, gv.supportPending], accounts: [gv.supportAccount] }, routeId: r.support.grants.id },
  'support-request-grant': { schema: r.support.requestGrant.response, data: { ...gv.supportPending, approvals: [] }, routeId: r.support.requestGrant.id },
  'support-revoke-grant': { schema: r.support.revokeGrant.response, data: gv.supportRevoked, routeId: r.support.revokeGrant.id },
  'contract-giver-accesses': { schema: r.contractGiver.accesses.response, data: { accesses: [gv.cgAccess] }, routeId: r.contractGiver.accesses.id },
  'contract-giver-grant-access': { schema: r.contractGiver.grantAccess.response, data: { ...gv.cgAccess, reads: 0 }, routeId: r.contractGiver.grantAccess.id },
  'contract-giver-revoke-access': { schema: r.contractGiver.revokeAccess.response, data: { ...gv.cgAccess, live: false }, routeId: r.contractGiver.revokeAccess.id },
  'contract-giver-batches': { schema: r.contractGiver.batches.response, data: { batches: [gv.cgBatch] }, routeId: r.contractGiver.batches.id },
  'contract-giver-batch': { schema: r.contractGiver.batch.response, data: gv.cgRecord, routeId: r.contractGiver.batch.id },
  'esig-dsc-configuration': { schema: r.esig.dscConfiguration.response, data: gv.dsc, routeId: r.esig.dscConfiguration.id },
  'esig-set-dsc-mode': { schema: r.esig.setDscMode.response, data: gv.dsc, routeId: r.esig.setDscMode.id },
  'esig-register-dsc-anchor': { schema: r.esig.registerDscAnchor.response, data: gv.dsc, routeId: r.esig.registerDscAnchor.id },
  'esig-set-dsc-meaning': { schema: r.esig.setDscMeaning.response, data: gv.dsc, routeId: r.esig.setDscMeaning.id },
  'esig-dsc-enrolment': { schema: r.esig.dscEnrolment.response, data: gv.dscEnrolment, routeId: r.esig.dscEnrolment.id },
  'esig-enrol-dsc': { schema: r.esig.enrolDsc.response, data: gv.dscEnrolment, routeId: r.esig.enrolDsc.id },
  'esig-end-dsc-enrolment': { schema: r.esig.endDscEnrolment.response, data: { ...gv.dscEnrolment, enrolments: gv.dscEnrolment.enrolments.map((e) => ({ ...e, live: false })) }, routeId: r.esig.endDscEnrolment.id },
  // Phase 6 slice 6e: controlled-substance mode (IN-53, draft).
  'controlled-products': { schema: r.controlled.products.response, data: { banner: cs.banner, products: [cs.product, cs.productPending] }, routeId: r.controlled.products.id },
  'controlled-record-product': { schema: r.controlled.recordProduct.response, data: cs.productPending, routeId: r.controlled.recordProduct.id },
  'controlled-custody': { schema: r.controlled.custody.response, data: { banner: cs.banner, records: [cs.dispenseAwaiting, cs.dispenseConfirmed, cs.transfer, cs.destructionProposed] }, routeId: r.controlled.custody.id },
  'controlled-propose-custody': { schema: r.controlled.proposeCustody.response, data: cs.destructionProposed, routeId: r.controlled.proposeCustody.id },
  'controlled-balance': { schema: r.controlled.balance.response, data: cs.balance, routeId: r.controlled.balance.id },
  'controlled-record-checkpoint': { schema: r.controlled.recordCheckpoint.response, data: cs.checkpointExplained, routeId: r.controlled.recordCheckpoint.id },
  'controlled-register-extracts': { schema: r.controlled.registerExtracts.response, data: { banner: cs.banner, extracts: [cs.extractSummary] }, routeId: r.controlled.registerExtracts.id },
  'controlled-run-register': { schema: r.controlled.runRegister.response, data: cs.extract, routeId: r.controlled.runRegister.id },
  'controlled-register-extract': { schema: r.controlled.registerExtract.response, data: cs.extract, routeId: r.controlled.registerExtract.id },
  // Phase 6 slice 6g: dashboards, change impact, training mode.
  'dashboards-right-first-time': { schema: r.dashboards.rightFirstTime.response, data: db6g.rightFirstTime, routeId: r.dashboards.rightFirstTime.id },
  'dashboards-exception-pareto': { schema: r.dashboards.exceptionPareto.response, data: db6g.exceptionPareto, routeId: r.dashboards.exceptionPareto.id },
  'dashboards-review-cycle-time': { schema: r.dashboards.reviewCycleTime.response, data: db6g.reviewCycleTime, routeId: r.dashboards.reviewCycleTime.id },
  'dashboards-deviation-ageing': { schema: r.dashboards.deviationAgeing.response, data: db6g.deviationAgeing, routeId: r.dashboards.deviationAgeing.id },
  'dashboards-hold-time-risk': { schema: r.dashboards.holdTimeRisk.response, data: db6g.holdTimeRisk, routeId: r.dashboards.holdTimeRisk.id },
  'dashboards-overdue-reviews': { schema: r.dashboards.overdueReviews.response, data: db6g.overdueReviews, routeId: r.dashboards.overdueReviews.id },
  'dashboards-press-oee': { schema: r.dashboards.pressOee.response, data: db6g.pressOee, routeId: r.dashboards.pressOee.id },
  'dashboards-alarm-trend': { schema: r.dashboards.alarmTrend.response, data: db6g.alarmTrend, routeId: r.dashboards.alarmTrend.id },
  'dashboards-catalog': { schema: r.dashboards.catalog.response, data: db6g.catalog, routeId: r.dashboards.catalog.id },
  'dashboards-export': { schema: r.dashboards.export.response, data: db6g.export, routeId: r.dashboards.export.id },
  'change-impact-material': { schema: r.changeImpact.query.response, data: ci6g.material, routeId: r.changeImpact.query.id },
  'training-overview': { schema: r.training.overview.response, data: tr6g.overview, routeId: r.training.overview.id },
  'training-start': { schema: r.training.start.response, data: tr6g.attempt, routeId: r.training.start.id },
  'training-complete-step': { schema: r.training.completeStep.response, data: { ...tr6g.attempt, done: [1, 2], complete: true }, routeId: r.training.completeStep.id },
  // Phase 6A slice 6A-1: the analytics configuration writes (the analytics namespace's own examples are ANALYTICS_EXAMPLES).
  'analytics-config-method-version': { schema: r.analyticsConfig.setMethodVersion.response, data: anaConfig.methodVersion, routeId: r.analyticsConfig.setMethodVersion.id },
  'analytics-config-reference-set': { schema: r.analyticsConfig.setReferenceSet.response, data: anaConfig.referenceSet, routeId: r.analyticsConfig.setReferenceSet.id },
} as const satisfies Record<string, Example>;

const an = ANALYTICS_NAMESPACES;

/**
 * Phase 6A slice 6A-0: one example per analytics route (fixtures/analytics*.json). Kept apart from EXAMPLES until the
 * namespaces join the route table (D-6A-0-4); the analytics contract test checks each route has one and it parses.
 */
export const ANALYTICS_EXAMPLES = {
  'analytics-catalog': { schema: an.analytics.catalog.response, data: ana.catalog, routeId: an.analytics.catalog.id },
  'analytics-methods': { schema: an.analytics.methods.response, data: ana.methods, routeId: an.analytics.methods.id },
  'analytics-monitor': { schema: an.analytics.monitor.response, data: ana.monitor, routeId: an.analytics.monitor.id },
  'analytics-flags': { schema: an.analytics.flags.response, data: ana.flags, routeId: an.analytics.flags.id },
  'analytics-flag': { schema: an.analytics.flag.response, data: ana.flag, routeId: an.analytics.flag.id },
  'analytics-dispose': { schema: an.analytics.dispose.response, data: ana.dispose, routeId: an.analytics.dispose.id },
  'analytics-spc-chart': { schema: an.analyticsSpc.chart.response, data: anaSpc.chart, routeId: an.analyticsSpc.chart.id },
  'analytics-spc-capability': { schema: an.analyticsSpc.capability.response, data: anaSpc.capability, routeId: an.analyticsSpc.capability.id },
  'analytics-spc-rates': { schema: an.analyticsSpc.rates.response, data: anaSpc.rates, routeId: an.analyticsSpc.rates.id },
  'analytics-mspc-chart': { schema: an.analyticsMspc.chart.response, data: anaMspc.chart, routeId: an.analyticsMspc.chart.id },
  'analytics-mspc-batch': { schema: an.analyticsMspc.batch.response, data: anaMspc.batch, routeId: an.analyticsMspc.batch.id },
  'analytics-mspc-candidates': { schema: an.analyticsMspc.candidates.response, data: anaMspc.candidates, routeId: an.analyticsMspc.candidates.id },
  'analytics-audit-flags': { schema: an.analyticsAudit.flags.response, data: anaAudit.flags, routeId: an.analyticsAudit.flags.id },
  'analytics-audit-flag': { schema: an.analyticsAudit.flag.response, data: anaAudit.flag, routeId: an.analyticsAudit.flag.id },
  'analytics-audit-entries': { schema: an.analyticsAudit.entries.response, data: anaAudit.entries, routeId: an.analyticsAudit.entries.id },
  'analytics-review-priority': { schema: an.analyticsReview.priority.response, data: anaReview.priority, routeId: an.analyticsReview.priority.id },
  'analytics-review-unscored': { schema: an.analyticsReview.priority.response, data: anaReview.unscored, routeId: an.analyticsReview.priority.id },
  'analytics-profile-batch': { schema: an.analyticsProfile.batch.response, data: anaProfile.batch, routeId: an.analyticsProfile.batch.id },
  'analytics-profile-candidates': { schema: an.analyticsProfile.candidates.response, data: anaProfile.candidates, routeId: an.analyticsProfile.candidates.id },
} as const satisfies Record<string, Example>;

/** Phase 6 slice 6f (builder B): the support, contract-giver and DSC routes, each with an example above (contract test). */
export const GOVERNANCE_ROUTE_IDS: readonly string[] = [
  ...Object.values(r.support),
  ...Object.values(r.contractGiver),
  r.esig.dscConfiguration,
  r.esig.setDscMode,
  r.esig.registerDscAnchor,
  r.esig.setDscMeaning,
  r.esig.dscEnrolment,
  r.esig.enrolDsc,
  r.esig.endDscEnrolment,
].map((route) => route.id);

/** Phase 6 slice 6e: the controlled routes, each with an example above (checked by the controlled contract test). */
export const CONTROLLED_ROUTE_IDS: readonly string[] = Object.values(r.controlled).map((route) => route.id);

/** Phase 4 slice 6a: the india routes, each with an example above (checked by the india contract test). */
export const INDIA_ROUTE_IDS: readonly string[] = Object.values(r.india).map((route) => route.id);

/** Phase 4 slice 5b: the record-lock routes, each with an example above (checked by the contract test). */
export const RECORDS_LOCK_ROUTE_IDS: readonly string[] = Object.values(r.records).map((route) => route.id);

/** Phase 4 slice 6c: the PQR routes, each with an example above (checked by the contract test). */
export const PQR_ROUTE_IDS: readonly string[] = Object.values(r.pqr).map((route) => route.id);
/** Phase 6 slice 6g: the dashboards, change-impact and training routes, each with an example above (checked by the contract test). */
export const SLICE_6G_ROUTE_IDS: readonly string[] = [...Object.values(r.dashboards), ...Object.values(r.changeImpact), ...Object.values(r.training)].map((route) => route.id);
/** Phase 6 slice 6d: the genealogy and recall routes, each with an example above (checked by the contract test). */
export const GENEALOGY_ROUTE_IDS: readonly string[] = [...Object.values(r.genealogy), ...Object.values(r.recall)].map((route) => route.id);
/** Phase 6 slice 6i: the transfers and federation routes, each with an example above (checked by the contract test). */
export const TRANSFER_ROUTE_IDS: readonly string[] = [...Object.values(r.transfers), ...Object.values(r.federation)].map((route) => route.id);
/** Phase 4 slice 6b: the archive routes, each with an example above (checked by the contract test). */
export const ARCHIVE_ROUTE_IDS: readonly string[] = Object.values(r.archive).map((route) => route.id);

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
