/**
 * Signature manifestation (module C1; DI-36): the printed name, user ID, role, meaning, and date and time with the
 * UTC offset and site zone, shown as the preview before signing (the time is applied by the server at signing) and
 * as the stored manifestation after. A signature that is no longer valid is shown as such, never as valid.
 */
import type { ChallengeView, ManifestationView } from '@ebmr/api-contract';
import { icls } from './classes.ts';

export function ManifestationPreview({ preview }: { preview: ChallengeView['manifestation'] }) {
  return (
    <section className={icls('preview')} aria-label="Your signature will show">
      <dl className={icls('facts')}>
        <div className={icls('factRow')}>
          <dt>Name</dt>
          <dd>{preview.legalName}</dd>
        </div>
        <div className={icls('factRow')}>
          <dt>User ID</dt>
          <dd>{preview.loginName}</dd>
        </div>
        <div className={icls('factRow')}>
          <dt>Role</dt>
          <dd>{preview.role}</dd>
        </div>
        <div className={icls('factRow')}>
          <dt>Meaning</dt>
          <dd>{`${preview.meaningText} (${preview.meaning})`}</dd>
        </div>
        <div className={icls('factRow')}>
          <dt>Date and time</dt>
          <dd>{`Set by the server clock when you sign, with offset, in ${preview.zone}`}</dd>
        </div>
      </dl>
    </section>
  );
}

/** One line for lists: "Asha Rao (asha.rao), MBR_AUTHOR - Prepared by - 28-SEP-2026 14:05:03 +05:30 (Asia/Kolkata)". */
export function manifestationLine(m: ManifestationView): string {
  return `${m.signer.legalName} (${m.signer.loginName}), ${m.signer.role} - ${m.meaningText} - ${m.signedAt.text}${m.valid ? '' : ' - NOT VALID: this element is unsigned; signing again is required'}`;
}

export function ManifestationCard({ manifestation: m }: { manifestation: ManifestationView }) {
  return (
    <section className={icls('manifestation')} data-valid={m.valid ? 'true' : 'false'} aria-label="Signature">
      <dl className={icls('facts')}>
        <div className={icls('factRow')}>
          <dt>Signed by</dt>
          <dd>{m.signer.legalName}</dd>
        </div>
        <div className={icls('factRow')}>
          <dt>User ID</dt>
          <dd>{m.signer.loginName}</dd>
        </div>
        <div className={icls('factRow')}>
          <dt>Role</dt>
          <dd>{m.signer.role}</dd>
        </div>
        <div className={icls('factRow')}>
          <dt>Meaning</dt>
          <dd>{`${m.meaningText} (${m.meaning})`}</dd>
        </div>
        <div className={icls('factRow')}>
          <dt>Date and time</dt>
          <dd>{m.signedAt.text}</dd>
        </div>
        <div className={icls('factRow')}>
          <dt>Status</dt>
          <dd>{m.valid ? 'Valid' : 'Not valid: this element is unsigned; signing again is required'}</dd>
        </div>
      </dl>
    </section>
  );
}
