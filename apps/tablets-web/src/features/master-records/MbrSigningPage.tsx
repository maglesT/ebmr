/**
 * The signatures of an MBR version and its market authorisations (Phase 7 slice 7g-2, decision 0025; ADR 0014):
 *  - the life cycle: Prepared (the author), Independently checked (a checker who is not the author), the regulatory
 *    confirmation of the registration references, and Quality-unit approved (QA, neither author nor checker), each through
 *    the signing ceremony (signable action MBR_TRANSITION on the revision shown);
 *  - per market: QA proposes the authorisation of the approved version for a market and scope; the regulatory signer
 *    confirms its registration (MBR_MARKET_ACT REGULATORY_CONFIRM); QA authorises it, which activates it with QA's own
 *    reason (MBR_MARKET_ACT AUTHORISE); QA may withdraw it.
 * Every act is offered to whoever opens the page: who may sign what, and that the checker differs from the author and the
 * approver from both, is the database's rule, and its refusal is shown in its own words.
 */
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { routes, type MarketAuthorisationView, type VersionView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { LIFECYCLE, MASTER_RECORD_READS, stateTone, words } from './reads.ts';

export function MbrSigningPage() {
  const params: { versionId?: string } = useParams({ strict: false });
  const versionId = params.versionId ?? '';
  const v = useApiQuery(routes.designer.version, { params: { versionId } });
  if (v.error) return <RefusalMessage error={v.error.error} />;
  if (!v.data) return <p>Loading…</p>;
  const version = v.data;
  return (
    <>
      <nav aria-label="Breadcrumb">
        <a href="/mbr">Master records</a> / <a href={`/mbr/versions/${version.versionId}`}>{version.familyCode} version {version.number}</a> / Signatures
      </nav>
      <h1>
        Signatures and market authorisations: MBR-{version.familyCode}-v{version.number}
      </h1>
      <p data-testid="mbr-signing-state">
        {version.product.name} {version.product.strength}, revision {version.revision}: <StatusChip tone={stateTone(version.state)} label={words(version.state)} />
      </p>
      <LifeCycle version={version} />
      <Markets version={version} />
    </>
  );
}

function LifeCycle({ version }: { version: VersionView }) {
  const sigs = useApiQuery(routes.esig.signatures, { query: { aggregateType: 'mbr_version', aggregateId: version.versionId } });
  const signed = useSignedAct(MASTER_RECORD_READS);
  return (
    <Section title="Life-cycle signatures" testId="mbr-lifecycle">
      <p>
        A version is prepared by its author, checked by a second person, its registration references confirmed by the regulatory-conformity signer, and approved by QA. The checker
        is never the author, and the approver is neither: the system refuses a signature that breaks this, and an approval before the check. Each signature is on revision{' '}
        {version.revision} as shown; a later change of the content asks for the signatures again.
      </p>
      {sigs.error ? <RefusalMessage error={sigs.error.error} /> : null}
      {sigs.data && sigs.data.signatures.length > 0 ? <floor.SignatureList label="Signatures on this version" signatures={sigs.data.signatures} /> : <p>No signature on this version yet.</p>}
      <ul>
        {LIFECYCLE.map((s) => {
          const done = sigs.data?.signatures.some((g) => g.meaning === s.meaning && g.valid) ?? false;
          return (
            <li key={s.transition} data-testid={`mbr-sign-${s.transition}`} data-signed={done ? 'yes' : 'no'}>
              <strong>{s.label}</strong> (meaning {s.meaning}; signed by {s.signer}
              {s.needs ? `; the version must be ${words(s.needs).toLowerCase()}` : ''}){done ? ': signed.' : ''}{' '}
              <ActButton
                label={s.label}
                primary={!done}
                onPress={() =>
                  signed.sign(
                    { kind: 'MBR_TRANSITION', versionId: version.versionId, transition: s.transition, baseRevision: version.revision },
                    `${s.label}: MBR-${version.familyCode}-v${version.number}, revision ${String(version.revision)}`,
                  )
                }
                disabled={signed.busy}
              />
            </li>
          );
        })}
      </ul>
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}

function Markets({ version }: { version: VersionView }) {
  const q = useApiQuery(routes.designer.marketAuthorisations, { params: { versionId: version.versionId } });
  return (
    <Section title="Market authorisations" testId="mbr-markets">
      <p>
        An approved version is used for a market only through an authorisation for that market and scope (site, line, batch size): QA proposes it, the regulatory-conformity
        signer confirms its registration, and QA, another person, authorises it, which makes it effective. Markets of this master: {version.markets.join(', ') || 'none'}.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.authorisations.length === 0 ? <p>No market authorisation is recorded for this version.</p> : null}
      <ul>
        {q.data?.authorisations.map((a) => <Authorisation key={a.authorisationId} a={a} />)}
      </ul>
      <Propose version={version} />
    </Section>
  );
}

function Authorisation({ a }: { a: MarketAuthorisationView }) {
  const signed = useSignedAct(MASTER_RECORD_READS);
  const withdraw = useCommand(routes.designer.withdrawMarketAuthorisation, MASTER_RECORD_READS);
  const [code, setCode] = useState('MARKET_AUTHORISED');
  const [text, setText] = useState('');
  const [wCode, setWCode] = useState('');
  const [wText, setWText] = useState('');
  const scope = a.cells.map((c) => `${c.site} ${c.line} ${c.batchSize}`).join('; ');
  return (
    <li data-testid={`market-${a.market}`} data-state={a.state}>
      <strong>{a.market}</strong> {words(a.kind)} at {scope} <StatusChip tone={stateTone(a.state)} label={words(a.state)} />
      <br />
      Regulatory basis: {a.regulatoryBasis}. Proposed by {a.proposedBy.legalName} {a.proposedAt.text}.
      {a.regulatoryConfirmedBy ? ` Registration confirmed by ${a.regulatoryConfirmedBy.by.legalName} ${a.regulatoryConfirmedBy.at.text}.` : ' Registration not confirmed yet.'}
      {a.qaAuthorisedBy ? ` Authorised by ${a.qaAuthorisedBy.by.legalName} ${a.qaAuthorisedBy.at.text}.` : ''}
      {a.activatedAt ? ` Effective from ${a.activatedAt.text}.` : ''}
      {a.withdrawal ? ` Withdrawn by ${a.withdrawal.by.legalName} ${a.withdrawal.at.text}: ${a.withdrawal.reason}` : ''}
      {a.state === 'PROPOSED' ? (
        <div>
          <ActButton
            primary={false}
            label={`Confirm the registration for ${a.market}`}
            onPress={() => signed.sign({ kind: 'MBR_MARKET_ACT', act: 'REGULATORY_CONFIRM', authorisationId: a.authorisationId }, `Confirm the registration for ${a.market}: ${a.regulatoryBasis}`)}
            disabled={signed.busy}
          />
          <Field name={`authCode-${a.authorisationId}`} label="Reason code (authorisation)" value={code} onChange={setCode} />
          <Field name={`authText-${a.authorisationId}`} label="Reason (authorisation)" value={text} onChange={setText} />
          <ActButton
            label={`Authorise for ${a.market}`}
            onPress={() =>
              code.trim() &&
              text.trim() &&
              signed.sign({ kind: 'MBR_MARKET_ACT', act: 'AUTHORISE', authorisationId: a.authorisationId, reason: { code: code.trim(), text: text.trim() } }, `Authorise for ${a.market} at ${scope}`)
            }
            disabled={signed.busy || !code.trim() || !text.trim()}
          />
          <ActResult error={signed.error} outcome={signed.outcome} />
        </div>
      ) : null}
      {a.state !== 'WITHDRAWN' ? (
        <div>
          <Field name={`withdrawCode-${a.authorisationId}`} label="Reason code (withdrawal)" value={wCode} onChange={setWCode} />
          <Field name={`withdrawText-${a.authorisationId}`} label="Reason (withdrawal)" value={wText} onChange={setWText} />
          <ActButton
            primary={false}
            label={`Withdraw the authorisation for ${a.market}`}
            onPress={() => wCode.trim() && wText.trim() && withdraw.run({ params: { authorisationId: a.authorisationId }, body: { reason: { code: wCode.trim(), text: wText.trim() } } })}
            disabled={withdraw.busy || !wCode.trim() || !wText.trim()}
          />
          <ActResult error={withdraw.error} done={withdraw.done} label="The authorisation is withdrawn." />
        </div>
      ) : null}
    </li>
  );
}

function Propose({ version }: { version: VersionView }) {
  const propose = useCommand(routes.designer.proposeMarketAuthorisation, MASTER_RECORD_READS);
  const [market, setMarket] = useState(version.markets[0] ?? '');
  const [site, setSite] = useState('');
  const [line, setLine] = useState('');
  const [size, setSize] = useState('');
  const [basis, setBasis] = useState('');
  const ok = /^[A-Z]{2}$/.test(market) && site.trim() !== '' && line.trim() !== '' && size.trim() !== '' && basis.trim() !== '';
  return (
    <div data-testid="mbr-propose-market">
      <h3>Propose an authorisation (QA)</h3>
      <floor.ChoiceGroup label="Market" options={version.markets.map((m) => ({ value: m, label: m }))} value={market} onChange={setMarket} />
      <Field name="maSite" label="Site" value={site} onChange={setSite} />
      <Field name="maLine" label="Line" value={line} onChange={setLine} />
      <Field name="maBatchSize" label="Batch size (its id in the master)" value={size} onChange={setSize} />
      <Field name="maBasis" label="Regulatory basis (the market's approval or notification, or why none is needed)" value={basis} onChange={setBasis} />
      <ActButton
        label="Propose the authorisation"
        onPress={() =>
          ok &&
          propose.run({ params: { versionId: version.versionId }, body: { market, kind: 'CURRENT', cells: [{ site: site.trim(), line: line.trim(), batchSize: size.trim() }], regulatoryBasis: basis.trim() } })
        }
        disabled={!ok || propose.busy}
      />
      <ActResult error={propose.error} done={propose.done} label="The authorisation is proposed; it takes effect once its registration is confirmed and QA authorises it." />
    </div>
  );
}
