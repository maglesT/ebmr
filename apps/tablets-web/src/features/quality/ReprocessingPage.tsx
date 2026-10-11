/**
 * Reprocessing (Phase 3 slice 6; IN-19, PR-47, DI-33): the quality unit authorises whole-batch reprocessing requests
 * and the reprocessing authorisations of steps or container uses, and reserves closed output containers as reusable
 * residue; each act is QA's signature (REPROCESSING_ACT) through the ceremony. The database checks the case, the
 * product, the age and the risk evaluation; a refusal is shown in its words.
 */
import { routes, type ReprocessingAuthorisationView, type ReprocessingRequestView, type ResidueContainerView } from '@ebmr/api-contract';
import { StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';

const READS = [routes.quality.reprocessingRequests.id, routes.quality.reprocessingAuthorisations.id, routes.quality.residues.id];

export function ReprocessingPage() {
  const requests = useApiQuery(routes.quality.reprocessingRequests);
  const authorisations = useApiQuery(routes.quality.reprocessingAuthorisations, {});
  const residues = useApiQuery(routes.quality.residues, {});
  const qa = useOffered('QA');
  return (
    <>
      <h1>Reprocessing</h1>
      <Section title="Whole-batch reprocessing requests" testId="reprocessing-requests">
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
        {authorisations.error ? <RefusalMessage error={authorisations.error.error} /> : null}
        <ul>
          {authorisations.data?.authorisations.map((a) => (
            <li key={a.authorisationId}>
              <AuthorisationRow a={a} qa={qa} />
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

function AuthorisationRow({ a, qa }: { a: ReprocessingAuthorisationView; qa: boolean }) {
  const signed = useSignedAct(READS);
  return (
    <>
      <p>
        {a.batchNumber} step {a.stepId} · {a.caseCode} ({a.scope}
        {a.containerId ? `, container ${a.containerId}` : ''}) · investigation {a.investigationRef}, risk {a.riskEvaluationRef}{' '}
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
