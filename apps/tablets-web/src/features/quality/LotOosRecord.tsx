/**
 * Declutter slice D4b (docs/build-plan/declutter/plan.md, D4-R5): one lot's OOS record, opened from its lot page only.
 * Full deviation records belong to the Deviations product (their screens are off); what stays is what invalidating a
 * result for a laboratory error and reprocessing need: a QA-concluded OOS record (site-services 0859). So this page
 * shows the investigation, the finding, the impact on the lot and the closure basis the database requires before QA
 * concludes (site.conclude_deviation), and QA's signed impact assessment and conclusion. No list, no classification
 * change, no cancel, no closure. A record that is not an OOS record linked to this lot is not shown. Every rule is the
 * database's; its words are shown.
 */
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { useRouteParams } from '../floor/params.ts';
import { ClosureBasisForm, ClosureSummary, ImpactForm } from './DeviationDetail.tsx';
import { FindingForm, SignedActs, StartInvestigation } from './DeviationPage.tsx';

export function LotOosRecordPage() {
  const p = useRouteParams();
  const lotId = p['lotId'] ?? '';
  const deviationId = p['deviationId'] ?? '';
  const q = useApiQuery(routes.quality.deviationDetail, { params: { deviationId } });
  const qa = useOffered('QA');
  if (q.isPending) return <p>Loading the record…</p>;
  if (!q.data) return q.error ? <RefusalMessage error={q.error.error} /> : null;
  const d = q.data;
  const back = (
    <p>
      <Link to="/quality/lots/$lotId" params={{ lotId }}>
        Back to the lot
      </Link>
    </p>
  );
  if (d.kind !== 'OOS' || !d.links.some((l) => l.subjectKind === 'LOT' && l.subjectId === lotId)) {
    return (
      <>
        <p data-testid="lot-oos-not-this-lot">This is not an OOS record of this lot.</p>
        {back}
      </>
    );
  }
  const investigating = d.state === 'UNDER_INVESTIGATION' || d.state === 'IMPACT_ASSESSED';
  return (
    <>
      <h1>
        {d.ref} {d.title}
      </h1>
      <p data-testid="deviation-state">
        <StatusChip tone={d.state === 'CLOSED' || d.state === 'CANCELLED' ? 'neutral' : 'warning'} label={d.state} /> OOS · {d.qaClassification?.classification ?? d.raisedClassification}
      </p>
      {back}
      {d.state === 'OPEN' ? <StartInvestigation deviationId={d.deviationId} /> : null}
      {d.finding ? (
        <Section title="Finding recorded" testId="deviation-finding">
          <p>
            {d.finding.assignableCause ? 'Assignable cause' : 'No assignable cause'} · {d.finding.rootCauseCategory}: {d.finding.cause}
          </p>
        </Section>
      ) : null}
      {investigating ? <FindingForm deviationId={d.deviationId} /> : null}
      <Section title="Impact on the lot" testId="deviation-impacts">
        <ul>
          {d.links.map((l) => (
            <li key={l.linkId} data-testid={`impact-${l.subjectRef}`}>
              {l.subjectKind} {l.batchNumber ?? l.subjectRef}:{' '}
              {l.impacts.length === 0 ? 'no impact recorded yet' : l.impacts.map((i) => `${i.market} ${i.impact}${i.signed ? ' (signed)' : ' (not signed yet)'}: ${i.rationale}`).join('; ')}
            </li>
          ))}
        </ul>
        {investigating ? <ImpactForm d={d} /> : null}
      </Section>
      <Section title="Closure basis" testId="deviation-closure">
        {d.closureBasis ? <ClosureSummary c={d.closureBasis} /> : <p>No closure basis recorded yet.</p>}
        {investigating ? <ClosureBasisForm deviationId={d.deviationId} /> : null}
      </Section>
      {qa && investigating ? <SignedActs d={d} close={false} /> : null}
    </>
  );
}
