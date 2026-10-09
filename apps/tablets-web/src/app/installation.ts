/**
 * The words that name the installation a screen belongs to (DI-05): every screen chooses them here, from the
 * installation the server's meta reports, so the sign-in screens, the banners and the chips cannot say different
 * things (Phase 2 exit review F09: the kiosk sign-in said "Sandbox" on the GMP installation). Anything but a
 * SANDBOX answer is named GMP: a screen never claims to be a test sandbox it was not told it is.
 */
import type { InstallationKind } from '@ebmr/api-contract';
import { t } from '@ebmr/ui-kit';

export function isSandbox(installation: InstallationKind | null | undefined): boolean {
  return installation === 'SANDBOX';
}

export function installationLabel(installation: InstallationKind | null | undefined): string {
  return isSandbox(installation) ? t('installation.sandbox') : t('installation.gmp');
}
