/**
 * DEMO-ONLY: sign a kernel stub entry (aggregate esig_stub) through the real ceremony, so the owner demo and the
 * E2E ceremony spec run before the execution screens land. The page works only on a demo installation (the
 * server registers the ESIG_STUB signable there only); elsewhere it says so and offers nothing.
 *   /esig/demo?stub=<entry id>&meaning=PERFORMED
 */
import { getRouteApi, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { routes, type ManifestationView } from '@ebmr/api-contract';
import { Banner, Button, identity } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { useBoot } from '../../app/boot.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useSignatureCeremony, type SignOutcome } from '../../app/ports.tsx';
import { auditLink } from '../audit/links.ts';

const route = getRouteApi('/esig/demo');

/** The search of /esig/demo: the stub entry and the meaning to sign. */
export function demoSearch(raw: unknown): { stub: string; meaning: string } {
  const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { stub: typeof r['stub'] === 'string' ? r['stub'] : '', meaning: typeof r['meaning'] === 'string' && r['meaning'] !== '' ? r['meaning'] : 'PERFORMED' };
}

function Signatures({ stub }: { stub: string }) {
  const q = useApiQuery(routes.esig.signatures, { query: { aggregateType: 'esig_stub', aggregateId: stub } });
  if (q.isPending) return <p>Loading the signatures…</p>;
  if (q.isError) return <RefusalMessage error={q.error.error} />;
  const list: ManifestationView[] = q.data.signatures;
  if (list.length === 0) return <p>No signatures yet.</p>;
  return (
    <ul aria-label="Signatures of this entry">
      {list.map((m) => (
        <li key={m.signatureId}>{identity.manifestationLine(m)}</li>
      ))}
    </ul>
  );
}

export function EsigDemo() {
  const search: unknown = route.useSearch();
  const { stub, meaning } = demoSearch(search);
  return <EsigDemoPage stub={stub} meaning={meaning} />;
}

/** The page itself (DEMO-ONLY): offers nothing unless the installation is a demo installation. */
export function EsigDemoPage({ stub, meaning }: { stub: string; meaning: string }) {
  const boot = useBoot();
  const ceremony = useSignatureCeremony();
  const [outcome, setOutcome] = useState<SignOutcome | null>(null);
  const [generation, setGeneration] = useState(0);
  if (!boot.meta?.demo) {
    return <Banner tone="info" title="This page exists on demo installations only." />;
  }
  if (!stub) return <Banner tone="info" title="Name the entry to sign: /esig/demo?stub=<entry id>&meaning=PERFORMED" />;
  const sign = async () => {
    setOutcome(null);
    const o = await ceremony.sign({ aggregateType: 'esig_stub', aggregateId: stub, meaning, action: { kind: 'ESIG_STUB', stubId: stub }, title: `Sign entry as ${meaning}` });
    setOutcome(o);
    setGeneration((g) => g + 1);
  };
  return (
    <section aria-labelledby="esig-demo-title">
      <h1 id="esig-demo-title">Signature check (DEMO-ONLY)</h1>
      <p>{`Entry ${stub}: sign it as ${meaning} through the real signing ceremony.`}</p>
      <Button variant="primary" onPress={() => void sign()}>
        {`Sign as ${meaning}`}
      </Button>
      {outcome?.status === 'SIGNED' ? <Banner tone="ok" title={`Signed: ${identity.manifestationLine(outcome.manifestation)}`} /> : null}
      {outcome?.status === 'REFUSED' ? <RefusalMessage error={{ kind: 'REFUSAL', status: 422, envelope: outcome.refusal }} /> : null}
      {outcome?.status === 'NOT_CONFIRMED' ? <Banner tone="warning" title="The signature was not confirmed." /> : null}
      {outcome?.status === 'CANCELLED' ? <Banner tone="info" title="Signing cancelled. Nothing was signed." /> : null}
      <h2>Signatures</h2>
      <Signatures key={generation} stub={stub} />
      <p>
        <Link {...auditLink({ chain: `esig_stub:${stub}` })}>Audit trail of this entry</Link>
      </p>
    </section>
  );
}
