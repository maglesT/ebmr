/**
 * Reprocessing (Phase 3 slice 6; IN-19, PR-47, DI-33): the quality unit authorises whole-batch reprocessing requests
 * and the reprocessing authorisations of steps or container uses, and reserves closed output containers as reusable
 * residue; each act is QA's signature (REPROCESSING_ACT) through the ceremony. The database checks the case, the
 * product, the age and the risk evaluation; a refusal is shown in its words.
 */
import { useState } from 'react';
import { routes, type ReprocessingAuthorisationView, type ReprocessingRequestView, type ResidueContainerView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';

const READS = [routes.quality.reprocessingRequests.id, routes.quality.reprocessingAuthorisations.id, routes.quality.residues.id];

export function ReprocessingPage() {
  const requests = useApiQuery(routes.quality.reprocessingRequests);
  const authorisations = useApiQuery(routes.quality.reprocessingAuthorisations, {});
  const residues = useApiQuery(routes.quality.residues, {});
  const qa = useOffered('QA');
  const planning = useOffered('PLANNING');
  return (
    <>
      <h1>Reprocessing</h1>
      <Section title="Whole-batch reprocessing requests" testId="reprocessing-requests">
        {planning ? <ProposeRequest /> : null}
        {requests.error ? <RefusalMessage error={requests.error.error} /> : null}
        <ul>
          {requests.data?.requests.map((r) => (
            <li key={r.requestId}>
              <RequestRow r={r} qa={qa} />
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Reprocessing authorisations" testId="reprocessing-authorisations">
        {qa ? (
          // Phase 7 slice 7g (WP4; PR-47, IN-19): the request of a step authorisation, which the quality unit then signs.
          <ProposeAuthorisation residues={residues.data?.containers ?? []} />
        ) : null}
        {authorisations.error ? <RefusalMessage error={authorisations.error.error} /> : null}
        <ul>
          {authorisations.data?.authorisations.map((a) => (
            <li key={a.authorisationId}>
              <AuthorisationRow a={a} qa={qa} labels={new Map((residues.data?.containers ?? []).map((c) => [c.containerId, c.label]))} />
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Residue containers" testId="residues">
        {residues.error ? <RefusalMessage error={residues.error.error} /> : null}
        <ul>
          {residues.data?.containers.map((c) => (
            <li key={c.containerId}>
              <ResidueRow c={c} qa={qa} />
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

/**
 * Phase 7 slice 7g (WP4; PR-47, IN-19): the request of a step authorisation, which the quality unit then signs. Slice 7m
 * (R1, TB-08): the batch is picked from the site's batches, the step from that batch's reprocessing and recovery steps
 * (TB-08, G-24) and the source from the reserved residue containers, never an identifier typed; the database decides.
 */
function ProposeAuthorisation({ residues }: { residues: readonly ResidueContainerView[] }) {
  const propose = useCommand(routes.quality.proposeReprocessingAuthorisation, READS, 'a reprocessing authorisation request');
  const batches = useApiQuery(routes.batches.list, { query: {} });
  const [batchId, setBatchId] = useState<string | null>(null);
  const run = useApiQuery(routes.batches.batch, { params: { batchId: batchId ?? '' } }, { enabled: batchId !== null });
  const [step, setStep] = useState<string | null>(null);
  const [containerId, setContainerId] = useState<string | null>(null);
  const [investigationRef, setInvestigationRef] = useState('');
  const [riskEvaluationRef, setRiskEvaluationRef] = useState('');
  const open = (batches.data?.batches ?? []).filter((b) => ['ISSUED', 'IN_PROGRESS'].includes(b.status));
  const steps = (run.data?.stages ?? []).flatMap((st) => st.steps).filter((x) => x.block !== null && /^(TB-08|G-24)@/.test(x.block));
  const chosen = open.find((b) => b.runId === batchId);
  const sources = residues.filter((c) => c.reservedAt !== null && c.batchId !== batchId && (!chosen || c.product === chosen.product.code));
  const body = { batchId: batchId ?? '', step: step ?? '', ...(containerId ? { containerId } : {}), investigationRef: investigationRef.trim(), riskEvaluationRef: riskEvaluationRef.trim() };
  const ok = routes.quality.proposeReprocessingAuthorisation.body?.safeParse(body).success ?? false;
  return (
    <form aria-label="Ask for the authorisation of a reprocessing or recovery step" data-testid="propose-reprocessing-authorisation" onSubmit={(e) => e.preventDefault()}>
      <h3>Ask for the authorisation of a reprocessing or recovery step</h3>
      <floor.ChoiceGroup label="Batch" options={open.map((b) => ({ value: b.runId, label: `${b.batchNumber} (${b.product.code}, ${b.statusText})` }))} value={batchId} onChange={(v) => { setBatchId(v); setStep(null); setContainerId(null); }} />
      {batchId !== null && steps.length === 0 ? <p>The batch has no reprocessing or recovery step.</p> : null}
      {steps.length > 0 ? <floor.ChoiceGroup label="Step" options={steps.map((x) => ({ value: x.stepId, label: `${x.number} ${x.title}` }))} value={step} onChange={setStep} /> : null}
      {batchId !== null ? (
        <floor.ChoiceGroup
          label="Source container (reserved residue of an earlier batch of the product; when the step adds material)"
          options={sources.map((c) => ({ value: c.containerId, label: `${c.label} (${c.batchNumber}, ${c.stage}, ${c.remaining} ${c.unit})` }))}
          value={containerId}
          onChange={setContainerId}
        />
      ) : null}
      <Field name="investigationRef" label="Investigation" value={investigationRef} onChange={setInvestigationRef} />
      <Field name="riskEvaluationRef" label="Risk evaluation" value={riskEvaluationRef} onChange={setRiskEvaluationRef} />
      <ActButton
        label="Ask for the authorisation"
        disabled={!ok || propose.busy}
        onPress={async () => {
          if (await propose.run({ body })) {
            setInvestigationRef('');
            setRiskEvaluationRef('');
          }
        }}
      />
      <ActResult error={propose.error} done={propose.done} label="Requested: the quality unit authorises it." />
    </form>
  );
}

/**
 * Phase 7 slice 7g (WP4; PR-47, IN-18, IN-19): the planner asks for a whole-batch reprocessing on a REPROCESSING master,
 * naming its parent batches, the investigation and the stored risk evaluation; the quality unit then authorises it.
 */
function ProposeRequest() {
  const propose = useCommand(routes.quality.proposeReprocessingRequest, READS, 'a whole-batch reprocessing request');
  const [familyId, setFamilyId] = useState('');
  const [site, setSite] = useState('');
  const [parents, setParents] = useState('');
  const [investigationRef, setInvestigationRef] = useState('');
  const [riskEvaluationId, setRiskEvaluationId] = useState('');
  const parentBatchIds = [...new Set(parents.split(/[\s,]+/).map((x) => x.trim()).filter((x) => x !== ''))];
  const body = { familyId: familyId.trim(), site: site.trim(), parentBatchIds, investigationRef: investigationRef.trim(), riskEvaluationId: riskEvaluationId.trim() };
  const ok = routes.quality.proposeReprocessingRequest.body?.safeParse(body).success ?? false;
  return (
    <form aria-label="Ask for a whole-batch reprocessing" data-testid="propose-reprocessing-request" onSubmit={(e) => e.preventDefault()}>
      <h3>Ask for a whole-batch reprocessing</h3>
      <Field name="familyId" label="REPROCESSING master (family id)" value={familyId} onChange={setFamilyId} />
      <Field name="site" label="Site" value={site} onChange={setSite} />
      <Field name="parents" label="Parent batches (ids, separated by commas)" value={parents} onChange={setParents} />
      <Field name="investigationRef" label="Concluded investigation" value={investigationRef} onChange={setInvestigationRef} />
      <Field name="riskEvaluationId" label="Stored risk evaluation (document id)" value={riskEvaluationId} onChange={setRiskEvaluationId} />
      <ActButton
        label="Ask for the reprocessing"
        disabled={!ok || propose.busy}
        onPress={async () => {
          if (await propose.run({ body })) {
            setParents('');
            setInvestigationRef('');
          }
        }}
      />
      <ActResult error={propose.error} done={propose.done} label="Requested: the quality unit authorises it." />
    </form>
  );
}

function RequestRow({ r, qa }: { r: ReprocessingRequestView; qa: boolean }) {
  const signed = useSignedAct(READS);
  const parents = r.parents.map((p) => p.batchNumber).join(', ');
  return (
    <>
      <p>
        {r.familyCode ?? r.familyId} from {parents} · investigation {r.investigationRef} · proposed by {r.proposedBy.legalName}, {r.proposedAt.text}{' '}
        <StatusChip tone={r.authorisedBy ? 'ok' : 'warning'} label={r.authorisedBy ? `authorised by ${r.authorisedBy.legalName}` : 'not authorised'} />
      </p>
      {qa && !r.authorisedBy ? (
        <ActButton label={`Authorise the reprocessing of ${parents}`} onPress={() => signed.sign({ kind: 'REPROCESSING_ACT', act: 'AUTHORISE_REQUEST', subjectId: r.requestId, input: {} }, `Authorise whole-batch reprocessing of ${parents} (${r.investigationRef})`)} disabled={signed.busy} />
      ) : null}
      <ActResult error={signed.error} outcome={signed.outcome} />
    </>
  );
}

function AuthorisationRow({ a, qa, labels }: { a: ReprocessingAuthorisationView; qa: boolean; labels: ReadonlyMap<string, string> }) {
  const signed = useSignedAct(READS);
  return (
    <>
      <p>
        {a.batchNumber} step {a.stepId} · {a.caseCode} ({a.scope}
        {a.containerId ? `, container ${labels.get(a.containerId) ?? a.containerId}` : ''}) · investigation {a.investigationRef}, risk {a.riskEvaluationRef}{' '}
        <StatusChip tone={a.authorisedBy ? 'ok' : 'warning'} label={a.authorisedBy ? `authorised by ${a.authorisedBy.legalName}` : 'not authorised'} />
      </p>
      {qa && !a.authorisedBy ? (
        <ActButton label={`Authorise ${a.caseCode} at ${a.batchNumber} ${a.stepId}`} onPress={() => signed.sign({ kind: 'REPROCESSING_ACT', act: 'AUTHORISE_ADDITION', subjectId: a.authorisationId, input: {} }, `Authorise ${a.caseCode} at ${a.batchNumber} step ${a.stepId}`)} disabled={signed.busy} />
      ) : null}
      <ActResult error={signed.error} outcome={signed.outcome} />
    </>
  );
}

function ResidueRow({ c, qa }: { c: ResidueContainerView; qa: boolean }) {
  const signed = useSignedAct(READS);
  return (
    <>
      <p>
        {c.label} · {c.batchNumber} {c.product} {c.strength} {c.stage} · {c.remaining} of {c.net} {c.unit} · closed {c.closedAt.text}{' '}
        <StatusChip tone={c.reservedAt ? 'ok' : 'neutral'} label={c.reservedAt ? `reserved ${c.reservedAt.text}` : c.state} />
      </p>
      {qa && !c.reservedAt ? (
        <ActButton label={`Reserve ${c.label} as residue`} onPress={() => signed.sign({ kind: 'REPROCESSING_ACT', act: 'RESERVE_RESIDUE', subjectId: c.containerId, input: {} }, `Reserve ${c.label} (${c.remaining} ${c.unit}) as reusable residue`)} disabled={signed.busy} />
      ) : null}
      <ActResult error={signed.error} outcome={signed.outcome} />
    </>
  );
}
