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
export * from './analytics-namespaces.ts';
export * from './ns/analytics.ts';
export * from './ns/analytics-config.ts';
export * from './ns/analytics-spc.ts';
export * from './ns/analytics-mspc.ts';
export * from './ns/analytics-audit.ts';
export * from './ns/analytics-review.ts';
export * from './ns/analytics-profile.ts';
export * from './vocab/roles.ts';
export { MetaView } from './ns/meta.ts';
export { ChangeSecretRequest, DemoDeviceView, DeviceClass, DeviceNonceRequest, DeviceView, LoginMethod, LoginRequest, SessionView } from './ns/session.ts';
export { ChallengeView, DscConfigurationView, DscEnrolmentView, DscRequirementView, DscSubmission, ManifestationView, SignableContentView, SignableDescriptorView, SignatureComponent, SignatureCredentials, SignOutcomeView } from './ns/esig.ts';
export { AuditChainView, AuditEventView, ChainVerificationView } from './ns/audit.ts';
export {
  EvidenceView,
  FamilyView,
  FindingView,
  JustificationView,
  LabellingSpecimenView,
  MarketAuthorisationView,
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
  RunResultExportView,
  RunHeaderView,
  RunSummaryView,
  RunView,
  PlannedBatchView,
  PackagingBatchDataView,
  DetectorChallengeView,
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
export * from './ns/people.ts';
export * from './ns/device-registry.ts';
export * from './ns/access-governance.ts';
export * from './ns/market-config.ts';
export { CalibrationView, ChargeView, InstrumentCheckView, OccupancyView, PlantUseView, PressDischargeView, StepPlantView, ToolingInspectionView, ToolingIssueResultView, ToolingReturnView } from './ns/plant-floor.ts';
export { AdditionSourceView, BulkIssueView, ProposedActView, SsccRegisterView, SsccView } from './ns/batches.ts';
export { BatchNumberRuleView, BatchNumberView, PackagingBulkView, PackagingOrderView, PackagingParentView, PlanningOrderView } from './ns/planning.ts';
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
  ProductView,
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
  ReviewQueueOrdering,
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
  // Phase 4 slice 4 (4-0): market dispositions, certification intake, market changes.
  EuImporterView,
  ExportMarket,
  GrelItemId,
  LotMarketsView,
  MarketAddEvaluationView,
  MarketAddItemView,
  MarketAddOutcome,
  MarketChangeView,
  MarketDecisionView,
  MarketDispositionState,
  MarketDispositionView,
  MarketSubjectKind,
  QpAcknowledgementView,
  QpCertificationView,
  // Phase 4 slice 5a: after release.
  AfterReleaseAct,
  AfterReleaseDecisionView,
  AfterReleaseMarketView,
  DisposalRoute,
  DisposalView,
  LotAfterReleaseView,
  RecallTaskView,
  StockBlockView,
  SuspendedLotSummaryView,
  SuspensionCauseKind,
  SuspensionCauseView,
} from './ns/release.ts';
export { NotificationDepartment, NotificationView } from './ns/notifications.ts';
export {
  LotQpView,
  QpAccessView,
  QpPackageFileView,
  QpPackageView,
  QpReaderPackageView,
  QpSectionRole,
  QpSectionView,
  ShipmentCheckView,
  ShipmentMarket,
  ShipmentRequest,
  ShipmentView,
} from './ns/qp-shipping.ts';
export { ContainerHoldView, ContainerState, ContainerView } from './ns/containers.ts';
export {
  AmendmentEntryKind,
  AmendmentEntryView,
  AmendmentView,
  BrightStockHoldView,
  BulkContainerView,
  BulkOrderView,
  BulkQuantity,
  BulkReconciliationView,
  HoldHours,
  LockCause,
  LockedRecordKind,
  MarketImpactTaskView,
  RecordLockState,
  RecordLockSummaryView,
  RecordLockView,
} from './ns/records-lock.ts';
export {
  AllocationEntryView,
  AllocationUse,
  EndorsedProduct,
  ExportPermissionView,
  H2IssueView,
  HazardClass,
  HazardView,
  IndiaCheckView,
  IndiaLabelView,
  LicenceForm,
  LicenceKind,
  LicenceState,
  LicenceView,
  ShelfLifeBasisView,
} from './ns/india.ts';
export {
  PqrBatchView,
  PqrChangeView,
  PqrCppView,
  PqrCounts,
  PqrDeviationView,
  PqrExtractSummaryView,
  PqrExtractView,
  PqrLotView,
  PqrMarketRemovalView,
  PqrProductCode,
  PqrReconciliation,
  PqrSignOffView,
} from './ns/pqr.ts';
export { EditionReviewItem, FinishedLotView, MbrEditionReviewItem, LotDecisionProposalView, LotReleaseCheckView, Pharmacopoeia, SpecificationTestInput, SpecificationView } from './ns/specifications.ts';
export { ChemicalRecoveryInput, ChemicalRecoveryView, ReturnAssessmentInput, ReturnView, SampleView } from './ns/samples.ts';
export { ProcessReadingView, StepBindingsView } from './ns/device-readings.ts';
export {
  ArchiveBatchSummary,
  ArchiveBatchView,
  ContingencyFormState,
  ContingencyFormView,
  DisposalAnswerView,
  ExportFileView,
  ExportView,
  FormsView,
  RetentionView,
  TrueCopyPdfView,
  VerificationView,
} from './ns/archive.ts';
export {
  AdapterDetailView,
  AdapterHealthView,
  AdapterWorkerView,
  InboundErrorClass,
  InboundMessageView,
  InboundRefusalView,
  IntegrationAlarmKind,
  IntegrationAlarmView,
  IntegrationSourceSystem,
  MirrorDataClassName,
  MirrorFreshnessView,
  ReconciliationReportView,
} from './ns/integrations.ts';
export { AlarmLimitKind, AlarmSubjectKind, PlantAlarmSource, PlantAlarmView } from './ns/alarms.ts';
export { DeviceOriginalView, EquipmentEventView, NativeSampleView, SERIES_PAGE_MAX, SeriesChunkView, SeriesSubjectKind, SeriesTagView } from './ns/equipment-data.ts';
export { LineStationView, StatusBoardEntry } from './ns/equipment-data.ts';
export { AdjacencyView, AreaAuthorisationMatrixView, AreaAuthorisationRecordView, BetaLactamSubjectView, FacilityRuleSubjectView, PlantRuleProposalView, ReagentLotView, RoomCleaningState, RoomConditionsView, RoomStateView } from './ns/plant-rules.ts';
export { IncidentSeverity, IncidentSource, IncidentStatus, IncidentSummaryView, IncidentView } from './ns/incidents.ts';
export {
  ComplaintLookupView,
  DeviationImpactView,
  DistributionRecordView,
  GenealogyDirection,
  GenealogyEdgeKind,
  GenealogyEdgeView,
  GenealogyNodeKind,
  GenealogyNodeView,
  GenealogyTraceView,
  FederatedPartStatus,
  FederatedPartView,
  FederatedTraceView,
  RecurrenceView,
  SupplyChainView,
} from './ns/genealogy.ts';
export { MockRecallFederationView, MockRecallRemoteView, MockRecallSubjectKind, MockRecallSummaryView, MockRecallView } from './ns/recall.ts';
export {
  CoaLineView,
  InstallationAlarmView,
  InstallationCode,
  InstallationIdentityView,
  PeerInstallationState,
  PeerInstallationView,
  TransferImportView,
  TransferPackageFileView,
  TransferPackageView,
  TransferReceiptState,
  TransferReceiptSummaryView,
  TransferReceiptView,
  TransferRuleView,
} from './ns/transfers.ts';
export { CapaCheckStatus, CapaCheckView, CapaSourceKind, CapaState, CapaSummaryView, CapaView } from './ns/capa.ts';
export { ChangeRecordNumber, ChangeRecordState, ChangeRecordView, ConfigAreaCode, ConfigDifferenceView, ConfigItemView, IsoInstant, PlatformSettingView, RbeRuleView, RbeSeverity } from './ns/config.ts';
export {
  CodedData,
  CutLabelOption,
  LABEL_BINDINGS,
  LabelBinding,
  LabelForm,
  LabelLayout,
  LabelScope,
  LabelStoreView,
  LabelTemplateStatus,
  LabelTemplateView,
  MasterLabellingView,
  PackagingCompletionView,
  SpecimenPosition,
  StoreTransactionKind,
} from './ns/labels.ts';
export { BatchPoolsView, L3MirrorView, SerialLookupView, SerialStatus } from './ns/serialisation.ts';
export { ApprovedManufacturerState, ApprovedManufacturerView, DeliveryReceivedView, LotHandlingView, LotReceiptView, RECEIPT_ROUTE_IDS, SupplierBatchInput, VendorRouteView } from './ns/receipt.ts';
export {
  CheckpointState,
  CheckpointView,
  CONTROLLED_DRAFT_BANNER,
  ControlledBalanceView,
  ControlledProductView,
  ControlledRecordState,
  CustodyKind,
  CustodyState,
  CustodyView,
  RegisterExtractSummary,
  RegisterExtractView,
  RegisterRow,
} from './ns/controlled.ts';
export { ContractGiverAccessView, ContractGiverBatchView, ContractGiverRecordView, SupportAccountView, SupportGrantState, SupportGrantView } from './ns/support.ts';
export {
  AgeingBucket,
  AlarmTrendView,
  ChangeImpactItem,
  ChangeImpactKind,
  ChangeImpactView,
  DeviationAgeingView,
  ExceptionParetoView,
  HoldRisk,
  HoldTimeRiskView,
  OverdueReviewsView,
  PressOeeView,
  ReportCatalogView,
  ReportExportView,
  ReviewCycleTimeView,
  RightFirstTimeView,
  SiteDate,
  TrainingAttemptView,
  TrainingExerciseView,
  TrainingOverviewView,
  TrainingPersonaView,
} from './ns/dashboards.ts';
export {
  BackupFileView,
  BackupRunView,
  BackupView,
  BackupsView,
  DemoJobView,
  DemoView,
  SetupDoneView,
  SetupRequest,
  SetupStateView,
  SimulatorCode,
  SimulatorView,
  SimulatorsView,
  WorkerView,
  WorkersView,
  // Phase 7 slice 7g, work package 2.
  ContinuityAlarmView,
  DrillJobView,
  DrillsView,
  HardeningCheckView,
  HardeningRunView,
  RestoreDrillView,
  RestoreEventKind,
  RestoreEventView,
  RestoreMoveView,
  RestoreView,
  UpgradeDrillView,
} from './ns/operations.ts';
