/**
 * @ebmr/api-contract: the typed HTTP contract of the Tablets edition (Phase 2 apps plan section 4).
 * Browser-safe: zod, expr and type-only imports from @ebmr/recipe-core/pure.
 *
 * Frozen by the lead at A0 (2026-09-28). From then on only the lead changes it, and only additively.
 */
export const PACKAGE = { name: '@ebmr/api-contract', version: '0.1.0' } as const;
export const CONTRACT_VERSION = '1.0.0';

export * from './common.ts';
export * from './route.ts';
export * from './client.ts';
export * from './intents.ts';
export * from './signable.ts';
export * from './routes.ts';
export * from './vocab/roles.ts';
export { MetaView } from './ns/meta.ts';
export { ChangeSecretRequest, DemoDeviceView, DeviceClass, DeviceNonceRequest, DeviceView, LoginMethod, LoginRequest, SessionView } from './ns/session.ts';
export { ChallengeView, ManifestationView, SignableContentView, SignableDescriptorView, SignatureComponent, SignatureCredentials, SignOutcomeView } from './ns/esig.ts';
export { AuditChainView, AuditEventView, ChainVerificationView } from './ns/audit.ts';
export {
  EvidenceView,
  FamilyView,
  FindingView,
  JustificationView,
  MbrContentWire,
  PaletteBlock,
  ProductRef,
  ReferenceDocumentView,
  SimulationReportView,
  TemplateView,
  ValidationReportView,
  VersionSummary,
  VersionView,
} from './ns/designer.ts';
export {
  ActionName,
  ActionView,
  AttemptView,
  BatchStatus,
  CommandResultView,
  EntryFormView,
  EntryView,
  ExceptionView,
  FieldView,
  HoldView,
  IssueFormView,
  LimitTierWire,
  LimitView,
  LotView,
  ReplayReportView,
  RunHeaderView,
  RunSummaryView,
  RunView,
  PlannedBatchView,
  StageView,
  StepScreenView,
  StepStatus,
  StepSummaryView,
  TestPackageView,
  TimelineEntryView,
  TimerView,
  WorkQueueItem,
} from './ns/execution.ts';
export { LiveReadingEvent, ReadingView, ScaleStatusView } from './ns/devices.ts';
export {
  DeviationView,
  ErpCatalogue,
  ErpImportView,
  ErpOrderView,
  ErpPendingView,
  EvidenceDocumentView,
  ExtraTestingView,
  LotResultView,
  LotSummaryView,
  ReprocessingAuthorisationView,
  ReprocessingRequestView,
  ResidueContainerView,
} from './ns/quality.ts';
export { DeviationClassificationInput, DeviationClosureBasisInput, DeviationDetailView, DeviationReleaseItem, DeviationState } from './ns/deviation.ts';
export * from './tablet-entries.ts';
export { AdditionSourceView, BulkIssueView, ProposedActView, SsccRegisterView, SsccView } from './ns/batches.ts';
export { PackagingBulkView, PackagingOrderView, PackagingParentView, PlanningOrderView } from './ns/planning.ts';
export {
  FormulaChoiceView,
  FormulaLineInput,
  FormulaLineRole,
  FormulaLineView,
  FormulaSummaryView,
  FormulaVersionView,
  FormulaView,
} from './ns/master-data.ts';
export {
  AreaView,
  CleaningView,
  ClearanceView,
  DetectorView,
  EquipmentClassView,
  EquipmentView,
  PendingVerificationView,
  TestPieceView,
  ToolingSetView,
} from './ns/plant.ts';
export {
  AbortChecklistInput,
  AuditTrailReportView,
  BatchReviewView,
  ItemDetailView,
  RecordKind,
  RegisterView,
  ReviewItemView,
  ReviewState,
  ReviewSummaryView,
} from './ns/review.ts';
export {
  GrelEpoch,
  GrelEvidence,
  GrelItemView,
  GrelView,
  LotReleaseSummaryView,
  LotReleaseView,
  ManufacturerReleaseState,
  ReleaseDecisionView,
  ReleaseGate,
  ReleaseMarket,
} from './ns/release.ts';
export { NotificationDepartment, NotificationView } from './ns/notifications.ts';
export { ContainerHoldView, ContainerState, ContainerView } from './ns/containers.ts';
export { EditionReviewItem, FinishedLotView, LotDecisionProposalView, LotReleaseCheckView, Pharmacopoeia, SpecificationTestInput, SpecificationView } from './ns/specifications.ts';
export { ReturnAssessmentInput, ReturnView, SampleView } from './ns/samples.ts';
export { ProcessReadingView } from './ns/device-readings.ts';
