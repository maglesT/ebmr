/**
 * The first-run set-up, its next step (Phase 7 slice 7g, work package 2; decision 0025; kernel 1220; L-41, DI-31): once
 * the system administrator has signed in, this installation's identity is set from the installation key the server holds
 * (its code and Ed25519 public key; the private key never leaves the server or its key store), with the site and the
 * edition. The database keeps it (SYSTEM.CONFIGURE): the code, site and edition never change afterwards, only the key, and
 * a lot-transfer package or a federation answer is sealed and checked under it. On a sandbox there is no such identity.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { Banner, Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { isSandbox } from '../../app/installation.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { IDENTITY_READS } from './reads.ts';

const SITE = /^[A-Z0-9][A-Z0-9-]{0,15}$/;

export function InstallationIdentityPage() {
  const meta = useApiQuery(routes.meta.get, {}, { staleTime: 60_000 }).data;
  if (meta && isSandbox(meta.installation)) {
    return (
      <>
        <h1>This installation&apos;s identity</h1>
        <p>A sandbox installation exchanges nothing with other installations, so it has no installation identity.</p>
      </>
    );
  }
  return <Identity siteCode={meta?.site.code ?? ''} />;
}

function Identity({ siteCode }: { siteCode: string }) {
  const q = useApiQuery(routes.transfers.peers);
  const set = useCommand(routes.transfers.setInstallationIdentity, IDENTITY_READS);
  const [site, setSite] = useState(siteCode);
  const [reason, setReason] = useState('');
  const me = q.data?.installation ?? null;
  return (
    <>
      <h1>This installation&apos;s identity</h1>
      <p>
        The first-run set-up&apos;s next step, by the system administrator after the first sign-in: the installation code and public key come from the installation key this server holds.
        The code, the site and the edition never change afterwards; a new key may be set later.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <Section title="Now" testId="installation-identity">
        {me ? (
          <p>
            {me.installationCode} (site {me.siteCode}, {me.edition === 'TABLETS' ? 'Tablets' : 'Injectables'}), key <code>{me.keyFingerprint.slice(0, 16)}…</code> version{' '}
            {me.keyVersion.toString()} {me.serverHoldsKey ? <StatusChip tone="ok" label="Server holds the key" /> : <StatusChip tone="error" label="Server holds another key or none" />}
          </p>
        ) : (
          <Banner tone="warning" title="This installation has no identity yet." />
        )}
      </Section>
      <Section title={me ? 'Set the key this server holds' : 'Set the identity'} testId="installation-identity-set">
        <Field name="identity-site" label="Site code" value={site} onChange={(v) => setSite(v.toUpperCase())} />
        <Field name="identity-reason" label="Reason (recorded)" value={reason} onChange={setReason} />
        <ActButton
          label="Set this installation's identity"
          disabled={!SITE.test(site.trim()) || reason.trim().length < 3 || set.busy}
          onPress={() => set.run({ body: { siteCode: site.trim(), reason: reason.trim() } })}
        />
        <ActResult error={set.error} done={set.done} label="The identity is set." />
      </Section>
      <p>
        Trusted peer installations are proposed and approved on the <Link to="/transfers">transfers</Link> page.
      </p>
    </>
  );
}
