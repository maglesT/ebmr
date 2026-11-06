/**
 * API plan A3 (C3, AS-17): the certificate of analysis of a released API lot, reached from the lot's release page. A
 * plain form-style document, top to bottom (label, value, unit, limits), the quality unit's signature at the bottom, so
 * it can move onto the shared form layout later. Every rule is the database's (substance 5002): the page shows what the
 * CoA says now, prepares it as a true copy, and has it signed COA_APPROVED through the usual ceremony (COA_ACT).
 */
import { routes, type CoaDocumentView, type CoaRecordView } from '@ebmr/api-contract';
import { Banner, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useRouteParams } from '../floor/params.ts';

const COA_READS: readonly string[] = [routes.release.coa.id];

const dateOf = (utc: string | null): string => (utc ? utc.slice(0, 10) : 'none');

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function CoaDocument({ d }: { d: CoaDocumentView }) {
  return (
    <>
      <dl>
        <Row label="Manufacturer" value={d.manufacturer.name ?? 'not on record'} />
        <Row label="Address" value={d.manufacturer.address ?? 'not on record'} />
        <Row label="Telephone" value={d.manufacturer.telephone ?? 'not on record'} />
        <Row label="Product" value={d.product.name} />
        <Row label="Grade" value={d.product.grade ?? 'none'} />
        <Row label="Lot" value={d.lot.lotCode} />
        <Row label="Batch" value={d.lot.batchNumber} />
        <Row label="Release date" value={dateOf(d.releasedAt)} />
        <Row label="Retest date" value={dateOf(d.retestAt)} />
        <Row label="Expiry date" value={dateOf(d.expiresAt)} />
      </dl>
      <dl data-testid="coa-tests">
        {d.tests.map((t) => (
          <Row
            key={t.testCode}
            label={`${t.testCode} (${t.methodReference})`}
            value={`${t.result} ${t.unit} · limits ${t.lowerLimit ?? '–'} to ${t.upperLimit ?? '–'} ${t.unit}`}
          />
        ))}
      </dl>
    </>
  );
}

function Signature({ c }: { c: CoaRecordView }) {
  return (
    <dl data-testid="coa-signature">
      <Row label="State" value={c.state === 'SIGNED' ? 'Signed' : 'Prepared, not signed'} />
      <Row label="Signed by" value={c.signedBy ? c.signedBy.legalName : 'none yet'} />
      <Row label="Signed at" value={c.signedAt === null ? 'none yet' : typeof c.signedAt === 'string' ? c.signedAt : c.signedAt.text} />
      <Row label="Document SHA-256" value={c.documentSha256} />
    </dl>
  );
}

export function CoaPage() {
  const lotId = useRouteParams()['lotId'] ?? '';
  const q = useApiQuery(routes.release.coa, { params: { lotId } });
  const prepare = useCommand(routes.release.prepareCoa, COA_READS);
  const signed = useSignedAct(COA_READS);
  const v = q.data;
  const latest = v?.coas[0];
  return (
    <>
      <h1>Certificate of analysis</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v ? (
        <>
          {v.problems.length > 0 ? (
            <Banner tone="warning" title="No CoA can be issued now">
              <ul>{v.problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </Banner>
          ) : null}
          {v.gaps.map((g) => <p key={g}>Not on record: {g}</p>)}
          {latest ? (
            <Section title={`CoA of lot ${latest.document.lot.lotCode}`} testId="coa-latest">
              {latest.intact ? null : <Banner tone="error"title="The stored CoA no longer matches its SHA-256." />}
              <StatusChip tone={latest.state === 'SIGNED' ? 'ok' : 'pending'} label={latest.state === 'SIGNED' ? 'Signed' : 'Prepared'} />
              <CoaDocument d={latest.document} />
              <Signature c={latest} />
              {latest.state === 'PREPARED' ? (
                <ActButton label="Sign the CoA" onPress={() => signed.sign({ kind: 'COA_ACT', act: 'COA_SIGN', subjectId: latest.coaId }, `Certificate of analysis of lot ${latest.document.lot.lotCode}`)} disabled={signed.busy} />
              ) : (
                <ActButton primary={false} label="Print" onPress={() => window.print()} />
              )}
              <ActResult error={signed.error} outcome={signed.outcome} />
            </Section>
          ) : v.current ? (
            <Section title={`CoA of lot ${v.current.lot.lotCode} (not prepared)`} testId="coa-current">
              <CoaDocument d={v.current} />
            </Section>
          ) : null}
          {v.problems.length === 0 ? (
            <>
              <ActButton primary={latest?.state !== 'PREPARED'} label="Prepare the CoA from the records" onPress={() => prepare.run({ params: { lotId }, body: {} })} disabled={prepare.busy} />
              <ActResult error={prepare.error} done={prepare.done} label="Prepared." />
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}
