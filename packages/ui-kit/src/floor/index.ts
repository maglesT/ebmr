/**
 * Floor kit (module C4): glove-first components for the shop-floor step screen, plus the pendingEntry machine
 * (re-exported here so the web app reaches it through the `floor` namespace; machines/index.ts is shared with
 * C1). SeriesGrid (the IPC grid) arrives in A2.
 */
export const READY = true as const;

export { FLOOR_EN, ft, type FloorMessageKey } from './messages.ts';
export { clockText, enumText, personLine, roleTitle, severityTone, stepTone } from './format.ts';
export { Keypad, type KeypadProps } from './Keypad.tsx';
export { NumericEntry, type NumericEntryProps, type NumericTarget } from './NumericEntry.tsx';
export { LimitDisplay, boundsText, type LimitDisplayProps, type LimitViewData } from './LimitDisplay.tsx';
export { ChecklistEntry, checklistComplete, type ChecklistAnswer, type ChecklistEntryProps, type ChecklistItem } from './ChecklistEntry.tsx';
export { normaliseCode, ScanField, type ScanFieldProps } from './ScanField.tsx';
export { ChoiceGroup, type ChoiceGroupProps, type ChoiceOption } from './ChoiceGroup.tsx';
export { StepHeader, type StepHeaderProps } from './StepHeader.tsx';
export { TimerChip, type TimerChipProps, type TimerData } from './TimerChip.tsx';
export { PrimaryActionBar, type BarAction, type PrimaryActionBarProps } from './PrimaryActionBar.tsx';
export { RefusalPanel, type RefusalPanelProps } from './RefusalPanel.tsx';
export { StaleMirrorNotice, staleMirrorOf, type StaleMirror } from './StaleMirror.tsx';
export { ExceptionBanner, type ExceptionBannerProps } from './ExceptionBanner.tsx';
export { StatusOutline, type OutlineStage, type StatusOutlineProps } from './StatusOutline.tsx';
export { AttemptList, valueText, type AttemptData, type AttemptListProps } from './AttemptList.tsx';
export { SignatureList, type SignatureListProps } from './SignatureList.tsx';
export { NotSavedDialog, type NotSavedDialogProps } from './NotSavedDialog.tsx';
export { TwoPersonNotice } from './TwoPersonNotice.tsx';
export {
  pendingEntryMachine,
  UNSETTLED_STATES,
  type DiscardReason,
  type PendingEntryContext,
  type PendingEntryEvent,
  type PendingEntryInput,
  type PendingEntryMachine,
  type PendingEntryState,
  type PendingPayload,
} from '../machines/pending-entry.ts';
