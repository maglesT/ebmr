/**
 * Identity, lock and signature components (module C1): BadgePrompt, PinPad, DemoBadgeReader, IdentityBanner,
 * LockOverlay, SwitchUserDialog, SignatureDialog, the SignableContent renderers and the manifestation views.
 * Secrets (badge UIDs, PINs, passwords) live only in refs and uncontrolled inputs, and are handed over once.
 */
export { BadgePrompt, DemoBadgeReader, type BadgePromptProps, type DemoBadge } from './BadgePrompt.tsx';
export { IdentityBanner, type IdentityBannerProps } from './IdentityBanner.tsx';
export { KEEP_BADGE_MS, KeptBadge, LockOverlay, SwitchUserDialog, useKeptBadge, type LockOverlayProps, type SwitchUserDialogProps } from './LockOverlay.tsx';
export { ManifestationCard, ManifestationPreview, manifestationLine } from './Manifestation.tsx';
export { PinPad, type PinPadProps } from './PinPad.tsx';
export { humanize, scalarText, SignableContent } from './SignableContent.tsx';
export { RefusalNotice } from './RefusalNotice.tsx';
export { SignatureDialog, type SignatureDialogProps } from './SignatureDialog.tsx';
export { announceSessionChange, onSessionChange, SESSION_CHANGE_EVENT, type SessionChangeDetail, type SessionChangeReason } from '../machines/kiosk-lock.ts';
