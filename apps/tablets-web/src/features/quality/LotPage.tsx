/**
 * One material lot (Phase 3 slice 6, LIMS-lite): its test results with the verdicts the database computed, a result
 * recorded by QC, approved by QC with a signature (QUALITY_ACT LOT_RESULT_APPROVE), an OOS record raised and linked
 * for a failing result, the retest (QUALITY_ACT LOT_RETEST from approved RETEST results), and QA's release or
 * rejection (LOT_DECISION; a release names its route). What each act signs is the server's (esig.describe). Phase 4
 * slice 2c (LotExtras.tsx, DeviationDetail.tsx): the release check on the specification and samples, the status events
 * proposed then signed, the reserve and retention samples, and the linked deviations as the release checklist lists them.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type LotResultView, type LotSummaryView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { api } from '../../api/client.ts';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useRefresh, useSignedAct } from '../../app/acts.tsx';
import { DefineForm } from '../../app/define-form.tsx';
import { LotQualityForms } from '../../app/lot-quality.tsx';
import { LotPotency } from '../../app/potency.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { useRouteParams } from '../floor/params.ts';
import { DeviationReleaseChecklist } from './DeviationDetail.tsx';
import { DEVIATION_READS } from './DeviationsPage.tsx';
import { LotEvents, LotReleaseCheck, LotSamples } from './LotExtras.tsx';
import { LotHandling } from './LotHandling.tsx';
import { LotProfiles } from './LotProfiles.tsx';
import { LOT_READS } from './LotsPage.tsx';

type CallErr = Parameters<typeof RefusalMessage>[0]['error'];

export function LotPage() {
  const lotId = useRouteParams()['lotId'] ?? '';
  const lots = useApiQuery(routes.quality.lots);
  const results = useApiQuery(routes.quality.lotResults, { params: { lotId } });
  const lot = lots.data?.lots.find((l) => l.lotId === lotId) ?? null;
  const qc = useOffered('QC');
  const qa = useOffered('QA');
  return (
    <>
      <h1>Lot {lot ? `${lot.lotCode} ${lot.material.name}` : lotId}</h1>
      <p>
        <Link to="/quality/lots/$lotId/receipt" params={{ lotId }}>
          Receipt record, examination and issue check
        </Link>
      </p>
      {lot ? (
        <p data-testid="lot-status">
          <StatusChip tone={lot.status === 'RELEASED' ? 'ok' : lot.status === 'REJECTED' ? 'error' : 'warning'} label={lot.status} /> {lot.quantity} {lot.unit}
          {lot.expiry ? ` · expiry ${lot.expiry.text}` : ''}
          {lot.retest ? ` · retest ${lot.retest.text}` : ''}
        </p>
      ) : null}
      {lots.error ? <RefusalMessage error={lots.error.error} /> : null}
      <Section title="Test results" testId="lot-results">
        {results.error ? <RefusalMessage error={results.error.error} /> : null}
        {results.data && results.data.results.length === 0 ? <p>No result yet.</p> : null}
        <ul>
          {results.data?.results.map((r) => (
            <li key={r.resultId} data-testid={r.point ? `result-${r.testCode}-${r.point}-${r.purpose}` : `result-${r.testCode}-${r.purpose}`}>
              <ResultRow lotId={lotId} lotCode={lot?.lotCode ?? lotId} result={r} qc={qc} />
            </li>
          ))}
        </ul>
        {qc ? (
          <DefineForm
            title="Record a result"
            route={routes.quality.recordLotResult}
            params={{ lotId }}
            refresh={LOT_READS}
            submitLabel="Record the result"
            fields={[
              { name: 'testCode', label: 'Test code', kind: 'text' },
              { name: 'purpose', label: 'Purpose', kind: 'choice', options: ['RELEASE', 'RETEST'] },
              { name: 'value', label: 'Value', kind: 'decimal' },
            ]}
          />
        ) : null}
      </Section>
      {/* R13: the lot's potency for anyone who sees the lot; QC changes it on its own guided page. */}
      {lot ? <LotPotency lotCode={lot.lotCode} /> : null}
      {qc && lot ? (
        <p>
          <Link to="/quality/lots/$lotId/potency" params={{ lotId }} data-testid="update-potency">
            Update the potency of lot {lot.lotCode}
          </Link>
        </p>
      ) : null}
      {/* Slice 7o (R4, R8): the assay result TB-01 reads and a printed lot's artwork version G-21 checks. */}
      {qc && lot ? <LotQualityForms lotCode={lot.lotCode} results={results.data?.results ?? []} /> : null}
      {qc && lot ? (
        <Section title="Identity test" testId="lot-identity">
          <DefineForm
            title={`Record the identity test result of ${lot.lotCode}`}
            route={routes.quality.recordIdentityResult}
            params={{ lotId }}
            refresh={LOT_READS}
            submitLabel="Record the identity result"
            fields={[
              { name: 'result', label: 'Identity result', kind: 'choice', options: ['PASS', 'FAIL'] },
              { name: 'methodReference', label: 'Identity method', kind: 'text', description: 'e.g. the IR method of the specification' },
              { name: 'testReference', label: 'Test reference', kind: 'text', description: 'the analysis record' },
            ]}
          />
        </Section>
      ) : null}
      {/* Phase 7 slice 7p: each profile test as one release requirement, its points recorded one by one. */}
      <LotProfiles lotId={lotId} qc={qc} />
      {qc && lot ? <RetestForm lot={lot} results={results.data?.results ?? []} /> : null}
      {qa && lot ? <LotDecision lot={lot} /> : null}
      <LotReleaseCheck lotId={lotId} />
      {qa && lot ? <LotEvents lot={lot} /> : null}
      <LotSamples lotId={lotId} canPull={qc} canDispose={qa} />
      {/* Phase 7 slice 7g (WP4): destruction with its witness, reservations, stock-location exceptions. */}
      {lot ? <LotHandling lot={lot} /> : null}
      <DeviationReleaseChecklist subjectKind="LOT" subjectId={lotId} />
    </>
  );
}

function ResultRow({ lotId, lotCode, result: r, qc }: { lotId: string; lotCode: string; result: LotResultView; qc: boolean }) {
  const signed = useSignedAct(LOT_READS);
  const reread = useRefresh(DEVIATION_READS);
  const [oos, setOos] = useState<{ ref: string } | CallErr | null>(null);
  const raiseOos = async () => {
    const raised = await api.call(routes.quality.raiseDeviation, {
      body: { kind: 'OOS', title: `OOS ${r.testCode} on lot ${lotCode}`, classification: 'MAJOR', riskRationale: `Result ${r.value} ${r.unit} of ${r.testCode} is outside its limits.` },
    });
    if (!raised.ok) return setOos(raised.error);
    const linked = await api.call(routes.quality.linkDeviation, { params: { deviationId: raised.value.deviationId }, body: { subjectKind: 'LOT', subjectId: lotId } });
    // Phase 7 slice 7g (WP4; IN-20): an approved failing result names its OOS record (the database checks both).
    const named = linked.ok && r.state === 'APPROVED' ? await api.call(routes.quality.linkLotTestOos, { params: { resultId: r.resultId }, body: { deviationId: raised.value.deviationId } }) : null;
    await reread();
    setOos(!linked.ok ? linked.error : named && !named.ok ? named.error : { ref: raised.value.ref });
  };
  const limits = [r.lowerLimit ? `from ${r.lowerLimit}` : '', r.upperLimit ? `to ${r.upperLimit}` : ''].filter(Boolean).join(' ');
  // Slice 7p: a profile's result is named with its time point.
  const name = r.point ? `${r.testCode} at ${r.point}` : r.testCode;
  return (
    <>
      <p>
        {name} ({r.purpose}): {r.value} {r.unit} {limits ? `(${limits})` : ''} <StatusChip tone={r.verdict === 'PASS' ? 'ok' : 'error'} label={r.verdict} /> <StatusChip tone="neutral" label={r.state} />
      </p>
      {qc && r.state === 'RECORDED' ? (
        <ActButton label={`Approve ${name}`} onPress={() => signed.sign({ kind: 'QUALITY_ACT', act: 'LOT_RESULT_APPROVE', subjectId: r.resultId, input: {} }, `Approve result ${name} ${r.value} ${r.unit} (${r.verdict}) of lot ${lotCode}`)} disabled={signed.busy} />
      ) : null}
      {qc && r.verdict === 'FAIL' ? <ActButton primary={false} label={`Raise an OOS record for ${name}`} onPress={raiseOos} disabled={oos !== null && 'ref' in oos} /> : null}
      {oos && 'ref' in oos ? <p>OOS record {oos.ref} raised and linked to the lot.</p> : oos ? <RefusalMessage error={oos} /> : null}
      <ActResult error={signed.error} outcome={signed.outcome} />
    </>
  );
}

function RetestForm({ lot, results }: { lot: LotSummaryView; results: LotResultView[] }) {
  const approved = results.filter((r) => r.purpose === 'RETEST' && r.state === 'APPROVED');
  const [retestAt, setRetestAt] = useState('');
  const signed = useSignedAct(LOT_READS);
  return (
    <Section title="Retest" testId="retest">
      <p>The retest extends the retest date from the approved RETEST results ({approved.length}); the database checks the new date against the master's limit.</p>
      <Field name="retestAt" label="New retest date" value={retestAt} onChange={setRetestAt} description="ISO-8601 with offset, e.g. 2027-06-30T23:59:59+05:30" />
      <ActButton
        label="Sign the retest"
        onPress={() => signed.sign({ kind: 'QUALITY_ACT', act: 'LOT_RETEST', subjectId: lot.lotId, input: { retestAt: retestAt.trim(), results: approved.map((r) => r.resultId) } }, `Retest lot ${lot.lotCode}: new retest date ${retestAt.trim()}`)}
        disabled={approved.length === 0 || retestAt.trim() === '' || signed.busy}
      />
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}

function LotDecision({ lot }: { lot: LotSummaryView }) {
  const [decision, setDecision] = useState<'RELEASE' | 'REJECT' | null>(null);
  const [route, setRoute] = useState<'IDENTITY_TESTED' | 'VENDOR_HISTORY' | null>(null);
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const signed = useSignedAct(LOT_READS);
  // A rejection carries the person's own reason, both halves (DI-22).
  const reason = code.trim() && text.trim() ? { code: code.trim(), text: text.trim() } : null;
  const ready = (decision === 'REJECT' && reason !== null) || (decision === 'RELEASE' && route !== null);
  const sign = () => {
    if (decision === 'RELEASE' && route) return signed.sign({ kind: 'LOT_DECISION', lotId: lot.lotId, decision: 'RELEASE', route }, `Release lot ${lot.lotCode} (${lot.material.name}), route ${route}`);
    if (decision === 'REJECT' && reason) return signed.sign({ kind: 'LOT_DECISION', lotId: lot.lotId, decision: 'REJECT', reason }, `Reject lot ${lot.lotCode} (${lot.material.name}): ${reason.text}`);
    return undefined;
  };
  return (
    <Section title="QA decision on the lot" testId="lot-decision">
      <floor.ChoiceGroup
        label="Decision"
        options={[
          { value: 'RELEASE', label: 'Release' },
          { value: 'REJECT', label: 'Reject' },
        ]}
        value={decision}
        onChange={(v) => setDecision(v === 'RELEASE' ? 'RELEASE' : 'REJECT')}
      />
      {decision === 'RELEASE' ? (
        <floor.ChoiceGroup
          label="Release route"
          options={[
            { value: 'IDENTITY_TESTED', label: 'Identity tested' },
            { value: 'VENDOR_HISTORY', label: 'Vendor history' },
          ]}
          value={route}
          onChange={(v) => setRoute(v === 'VENDOR_HISTORY' ? 'VENDOR_HISTORY' : 'IDENTITY_TESTED')}
        />
      ) : null}
      {decision === 'REJECT' ? (
        <>
          <Field name="rejectCode" label="Reason code" value={code} onChange={setCode} />
          <Field name="rejectText" label="Reason for the rejection" value={text} onChange={setText} />
        </>
      ) : null}
      <ActButton label="Sign the decision" onPress={sign} disabled={!ready || signed.busy} />
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}
