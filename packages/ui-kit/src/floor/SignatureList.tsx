/**
 * SignatureList (module C4): the signatures on a step or stage as the server holds them (DI-36 manifestation:
 * meaning, legal name, user ID, role, date and time with offset and zone), with their validity (INV-09).
 */
import type { ManifestationView } from '@ebmr/api-contract';
import { fcls } from './classes.ts';
import { roleTitle } from './format.ts';
import { ft } from './messages.ts';

export interface SignatureListProps {
  label: string;
  signatures: readonly ManifestationView[];
}

export function SignatureList({ label, signatures }: SignatureListProps) {
  if (signatures.length === 0) return null;
  return (
    <ul className={fcls('signatures')} aria-label={label}>
      {signatures.map((s) => (
        <li key={s.signatureId} className={fcls('signature')} data-valid={String(s.valid)} data-testid={`signature-${s.meaning}`}>
          {ft('signature.line', { meaning: s.meaningText, name: s.signer.legalName, login: s.signer.loginName, role: roleTitle(s.signer.role), at: s.signedAt.text })}
          {s.valid ? null : <strong> ({ft('signature.invalid')})</strong>}
        </li>
      ))}
    </ul>
  );
}
