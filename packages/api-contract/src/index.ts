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
export { ChallengeView, ManifestationView, SignableContentView, SignatureComponent, SignatureCredentials, SignOutcomeView } from './ns/esig.ts';
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
