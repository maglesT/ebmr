/**
 * The full deviation record on screen (Phase 4 slice 2c, on slice 2a's contract ns/deviation.ts): QA's classification
 * and its reclassification (IN-02), the impact on each linked subject per market with whether QA's signed assessment
 * covers it, the finding, and the closure basis PENDING_CLOSURE needs (root-cause method, system factors, CAPA or the
 * reason for none, the regulatory-notification assessment, the other batches assessed); and the release checklist of a
 * subject (INV-46, PR-49). The screen sends what the person typed and chose; every rule (who may, in which state, what
 * blocks release) is the database's, and its words are shown.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { DeviationClosureBasisInput, routes, type DeviationDetailView } from '@ebmr/api-contract';
import { Banner, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { DefineForm } from '../../app/define-form.tsx';
import { useDisconnectedServer } from '../../app/boot.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { DEVIATION_READS } from './DeviationsPage.tsx';

const MARKETS = ['IN', 'US', 'EU'] as const;
const IMPACTS = ['NONE', 'POTENTIAL', 'CONFIRMED'] as const;

/** The detail of record `deviationId` with the forms its state offers. */
export function DeviationDetail({ deviationId }: { deviationId: string }) {
  const q = useApiQuery(routes.quality.deviationDetail, { params: { deviationId } });
  const qa = useOffered('QA');
  // Reclassifying and cancelling stay with the Deviations product when disconnected (api-contract disconnected.ts).
  const disconnected = useDisconnectedServer();
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const d = q.data;
  if (!d) return null;
  const investigating = d.state === 'UNDER_INVESTIGATION' || d.state === 'IMPACT_ASSESSED';
  return (
    <>
      <Section title="Classification" testId="deviation-classification">
        <p>Raised as {d.raisedClassification}.</p>
        {d.qaClassification ? (
          <p data-testid="qa-classification">
            QA classification {d.qaClassification.classification}: {d.qaClassification.riskRationale} · owner {d.qaClassification.ownerPersonId} · due {d.qaClassification.dueDate}
          </p>
        ) : (
          <p>Not classified by QA yet.</p>
        )}
        {qa && investigating && d.qaClassification && !disconnected ? <Reclassify d={d} /> : null}
      </Section>
      <Section title="Impact per market" testId="deviation-impacts">
        {d.links.length === 0 ? <p>Nothing is linked, so there is no impact to assess.</p> : null}
        <ul>
          {d.links.map((l) => (
            <li key={l.linkId} data-testid={`impact-${l.subjectRef}`}>
              {l.subjectKind} {l.batchNumber ?? l.subjectRef}:{' '}
              {l.impacts.length === 0
                ? 'no impact recorded yet'
                : l.impacts.map((i) => `${i.market} ${i.impact}${i.signed ? ' (signed)' : ' (not signed yet)'}: ${i.rationale}`).join('; ')}
            </li>
          ))}
        </ul>
        {d.links.length > 0 && !d.impactCurrent && investigating ? <p>QA's signed assessment does not cover the latest impacts yet.</p> : null}
        {investigating && d.links.length > 0 ? <ImpactForm d={d} /> : null}
      </Section>
      {d.finding ? (
        <Section title="Finding recorded" testId="deviation-finding">
          <p>
            {d.finding.assignableCause ? 'Assignable cause' : 'No assignable cause'} · {d.finding.rootCauseCategory}: {d.finding.cause}
          </p>
        </Section>
      ) : null}
      <Section title="Closure basis" testId="deviation-closure">
        {d.closureBasis ? <ClosureSummary c={d.closureBasis} /> : <p>No closure basis recorded yet.</p>}
        {investigating ? <ClosureBasisForm deviationId={d.deviationId} /> : null}
      </Section>
      {d.cancelReason ? <Banner tone="info" title="Cancelled.">{d.cancelReason}</Banner> : null}
    </>
  );
}

const DETAIL_READS = DEVIATION_READS;

function Reclassify({ d }: { d: DeviationDetailView }) {
  return (
    <DefineForm
      title="Reclassify"
      route={routes.quality.reclassifyDeviation}
      params={{ deviationId: d.deviationId }}
      refresh={DETAIL_READS}
      submitLabel="Reclassify"
      fields={[
        { name: 'classification', label: 'New classification', kind: 'choice', options: ['MINOR', 'MAJOR', 'CRITICAL'] },
        { name: 'riskRationale', label: 'Risk rationale of the reclassification', kind: 'text', description: 'At least 10 characters' },
        { name: 'ownerPersonId', label: 'Owner (person id)', kind: 'text' },
        { name: 'dueDate', label: 'Due date', kind: 'text', description: 'YYYY-MM-DD' },
      ]}
    />
  );
}

export function ImpactForm({ d }: { d: DeviationDetailView }) {
  const [linkId, setLinkId] = useState<string | null>(d.links.length === 1 ? (d.links[0]?.linkId ?? null) : null);
  const [market, setMarket] = useState<(typeof MARKETS)[number] | null>(null);
  const [impact, setImpact] = useState<(typeof IMPACTS)[number] | null>(null);
  const [rationale, setRationale] = useState('');
  const cmd = useCommand(routes.quality.recordDeviationImpact, DETAIL_READS);
  const go = async () => {
    if (!linkId || !market || !impact) return;
    const r = await cmd.run({ params: { deviationId: d.deviationId }, body: { linkId, market, impact, rationale: rationale.trim() } });
    if (r) setRationale('');
  };
  return (
    <div data-testid="impact-form">
      <h3>Record an impact</h3>
      {d.links.length > 1 ? (
        <floor.ChoiceGroup label="Linked subject" options={d.links.map((l) => ({ value: l.linkId, label: `${l.subjectKind} ${l.batchNumber ?? l.subjectRef}` }))} value={linkId} onChange={setLinkId} />
      ) : null}
      <floor.ChoiceGroup label="Market" options={MARKETS.map((m) => ({ value: m, label: m }))} value={market} onChange={(v) => setMarket(MARKETS.find((m) => m === v) ?? null)} />
      <floor.ChoiceGroup label="Impact" options={IMPACTS.map((m) => ({ value: m, label: m }))} value={impact} onChange={(v) => setImpact(IMPACTS.find((m) => m === v) ?? null)} />
      <Field name="impactRationale" label="Rationale of the impact" value={rationale} onChange={setRationale} description="At least 10 characters" />
      <ActButton label="Record the impact" onPress={go} disabled={!linkId || !market || !impact || rationale.trim().length < 10 || cmd.busy} />
      <ActResult error={cmd.error} done={cmd.done} label="Impact recorded." />
    </div>
  );
}

export function ClosureSummary({ c }: { c: NonNullable<DeviationDetailView['closureBasis']> }) {
  return (
    <ul data-testid="closure-summary">
      <li>Root-cause method: {c.rootCauseMethod ?? 'none named'}</li>
      {c.systemFactors ? <li>System factors: process — {c.systemFactors.process}; procedure — {c.systemFactors.procedure}; system — {c.systemFactors.system}</li> : null}
      <li>CAPA: {c.capaRefs.length > 0 ? c.capaRefs.join(', ') : `none (${c.noCapaReason ?? 'no reason given'})`}</li>
      <li>
        Regulatory notification {c.notificationRequired ? 'required' : 'not required'}: {c.notificationRationale}
        {c.authorityReference ? ` (${c.authorityReference})` : ''}
      </li>
      {c.otherBatches.map((b) => (
        <li key={`${b.subjectKind}:${b.ref}`}>
          Other {b.subjectKind.toLowerCase()} {b.ref}: {b.included ? 'included' : 'not included'} — {b.reason}
        </li>
      ))}
    </ul>
  );
}

interface OtherRow {
  subjectKind: 'BATCH' | 'PRODUCT' | 'LOT' | null;
  ref: string;
  included: 'YES' | 'NO' | null;
  reason: string;
}

const EMPTY_ROW: OtherRow = { subjectKind: null, ref: '', included: null, reason: '' };

/** The closure basis (DeviationClosureBasisInput): the body is checked against the contract before it is sent. */
export function ClosureBasisForm({ deviationId }: { deviationId: string }) {
  const [method, setMethod] = useState('');
  const [factors, setFactors] = useState({ process: '', procedure: '', system: '' });
  const [capa, setCapa] = useState('');
  const [noCapa, setNoCapa] = useState('');
  const [notify, setNotify] = useState<'YES' | 'NO' | null>(null);
  const [notifyWhy, setNotifyWhy] = useState('');
  const [authority, setAuthority] = useState('');
  const [rows, setRows] = useState<OtherRow[]>([EMPTY_ROW]);
  const cmd = useCommand(routes.quality.recordDeviationClosureBasis, DETAIL_READS);
  const anyFactor = factors.process.trim() !== '' || factors.procedure.trim() !== '' || factors.system.trim() !== '';
  const body: Record<string, unknown> = {
    ...(method.trim() ? { rootCauseMethod: method.trim() } : {}),
    ...(anyFactor ? { systemFactors: { process: factors.process.trim(), procedure: factors.procedure.trim(), system: factors.system.trim() } } : {}),
    capaRefs: capa.split(',').map((x) => x.trim()).filter((x) => x !== ''),
    ...(noCapa.trim() ? { noCapaReason: noCapa.trim() } : {}),
    ...(notify ? { notificationRequired: notify === 'YES' } : {}),
    notificationRationale: notifyWhy.trim(),
    ...(authority.trim() ? { authorityReference: authority.trim() } : {}),
    otherBatches: rows.map((r) => ({ subjectKind: r.subjectKind, ref: r.ref.trim(), included: r.included === null ? null : r.included === 'YES', reason: r.reason.trim() })),
  };
  const parsed = DeviationClosureBasisInput.safeParse(body);
  const problem = parsed.success ? null : parsed.error.issues.map((i) => `${i.path.join('.') || 'form'}: ${i.message}`).join('; ');
  const setRow = (i: number, patch: Partial<OtherRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const send = async () => {
    if (!parsed.success) return;
    await cmd.run({ params: { deviationId }, body: parsed.data });
  };
  return (
    <form aria-label="Record the closure basis" data-testid="closure-form" onSubmit={(e) => e.preventDefault()}>
      <h3>Record the closure basis</h3>
      <Field name="rootCauseMethod" label="Root-cause method" value={method} onChange={setMethod} description="e.g. five whys, fishbone (optional)" />
      <Field name="factorProcess" label="System factor: process" value={factors.process} onChange={(v) => setFactors((f) => ({ ...f, process: v }))} description="For a human error, all three factors (optional otherwise)" />
      <Field name="factorProcedure" label="System factor: procedure" value={factors.procedure} onChange={(v) => setFactors((f) => ({ ...f, procedure: v }))} />
      <Field name="factorSystem" label="System factor: system" value={factors.system} onChange={(v) => setFactors((f) => ({ ...f, system: v }))} />
      <Field name="capaRefs" label="CAPA references" value={capa} onChange={setCapa} description="Comma-separated, e.g. CAPA-26-014" />
      <Field name="noCapaReason" label="Reason for no CAPA" value={noCapa} onChange={setNoCapa} description="When no CAPA is named" />
      <floor.ChoiceGroup
        label="Regulatory notification required"
        options={[
          { value: 'YES', label: 'Yes' },
          { value: 'NO', label: 'No' },
        ]}
        value={notify}
        onChange={(v) => setNotify(v === 'YES' ? 'YES' : 'NO')}
      />
      <Field name="notificationRationale" label="Notification assessment" value={notifyWhy} onChange={setNotifyWhy} description="At least 10 characters" />
      <Field name="authorityReference" label="Authority reference" value={authority} onChange={setAuthority} description="When notified (optional)" />
      <fieldset>
        <legend>Other batches assessed</legend>
        {rows.map((r, i) => (
          <div key={i} data-testid={`other-batch-${String(i)}`}>
            <floor.ChoiceGroup
              label={`Other subject ${String(i + 1)}`}
              options={['BATCH', 'PRODUCT', 'LOT'].map((k) => ({ value: k, label: k }))}
              value={r.subjectKind}
              onChange={(v) => setRow(i, { subjectKind: v === 'BATCH' || v === 'PRODUCT' || v === 'LOT' ? v : null })}
            />
            <Field name={`otherRef${String(i)}`} label={`Reference ${String(i + 1)}`} value={r.ref} onChange={(v) => setRow(i, { ref: v })} />
            <floor.ChoiceGroup
              label={`Included in the deviation ${String(i + 1)}`}
              options={[
                { value: 'YES', label: 'Yes' },
                { value: 'NO', label: 'No' },
              ]}
              value={r.included}
              onChange={(v) => setRow(i, { included: v === 'YES' ? 'YES' : 'NO' })}
            />
            <Field name={`otherReason${String(i)}`} label={`Reason ${String(i + 1)}`} value={r.reason} onChange={(v) => setRow(i, { reason: v })} />
          </div>
        ))}
        <ActButton primary={false} label="Add another subject" onPress={() => setRows((rs) => [...rs, EMPTY_ROW])} />
      </fieldset>
      {problem ? <p role="alert">Not complete yet: {problem}</p> : null}
      <ActButton label="Record the closure basis" onPress={send} disabled={problem !== null || cmd.busy} />
      <ActResult error={cmd.error} done={cmd.done} label="Closure basis recorded." />
    </form>
  );
}

/** The deviations linked to a subject as the release checklist lists them, and why release is blocked (the server's words). */
export function DeviationReleaseChecklist({ subjectKind, subjectId }: { subjectKind: 'BATCH' | 'LOT' | 'CONTAINER'; subjectId: string }) {
  // Slice D4b: on a lot, its OOS record opens at the lot (LotOosRecord.tsx); no other record opens from here.
  const lotOos = (i: { kind: string; deviationId: string }) => subjectKind === 'LOT' && i.kind === 'OOS';
  const q = useApiQuery(routes.quality.deviationRelease, { query: { subjectKind, subjectId } });
  return (
    <Section title="Deviations and release" testId="deviation-release">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.items.length === 0 ? <p>No deviation is linked.</p> : null}
      <ul>
        {q.data?.items.map((i) => (
          <li key={i.deviationId} data-testid={`release-item-${i.ref}`}>
            {lotOos(i) ? (
              <Link to="/quality/lots/$lotId/oos/$deviationId" params={{ lotId: subjectId, deviationId: i.deviationId }}>
                {i.ref}
              </Link>
            ) : (
              i.ref
            )}{' '}
            {i.kind} <StatusChip tone={i.blocking ? 'error' : 'ok'} label={i.blocking ? 'blocks release' : 'does not block'} /> {i.state} · {i.classification}
            {i.reason ? ` · ${i.reason}` : ''}
          </li>
        ))}
      </ul>
      {q.data?.problem ? <Banner tone="warning" title="Release is blocked.">{q.data.problem}</Banner> : q.data ? <p>No linked deviation blocks release.</p> : null}
    </Section>
  );
}
