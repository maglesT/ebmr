/**
 * R13 (owner, 25 October 2026: "I want to adjust the potency percentage"): one guided page for QC to change a lot's
 * potency. The potency is never typed: it comes from the lot's approved ASSAY (and WATER, LOD or solvent) results, which
 * QC records and the head of QC approves on the lot page; here QC chooses them, gives the reason and saves. The lot's
 * history keeps every earlier potency with who changed it, when and why; a batch that has already calculated shows
 * "Potency changed since the calculation" and its recalculation is an exception for QA (PR-19, DI-33, DI-22).
 */
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { useApiQuery } from '../../api/hooks.ts';
import { Section } from '../../app/acts.tsx';
import { GmpAssayForm } from '../../app/lot-quality.tsx';
import { LotPotencyBody } from '../../app/potency.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { useRouteParams } from '../floor/params.ts';

export function UpdatePotencyPage() {
  const lotId = useRouteParams()['lotId'] ?? '';
  const lots = useApiQuery(routes.quality.lots);
  const lot = lots.data?.lots.find((l) => l.lotId === lotId) ?? null;
  const results = useApiQuery(routes.quality.lotResults, { params: { lotId } });
  const quality = useApiQuery(routes.execution.lotQuality, { params: { code: lot?.lotCode ?? '' } }, { enabled: lot !== null });
  const qc = useOffered('QC');
  const code = lot?.lotCode ?? lotId;
  const current = quality.data?.assay ?? null;
  return (
    <>
      <h1>Update the potency of lot {code}</h1>
      <p>
        <Link to="/quality/lots/$lotId" params={{ lotId }}>
          Back to the lot
        </Link>
      </p>
      {lots.error ? <RefusalMessage error={lots.error.error} /> : null}
      {lots.isPending ? <p>Loading…</p> : null}
      <Section title="Current potency" testId="potency-now">
        {quality.error ? <RefusalMessage error={quality.error.error} /> : null}
        {quality.data ? <LotPotencyBody v={quality.data} /> : <p>Loading…</p>}
      </Section>
      <Section title="How the potency changes" testId="potency-how">
        <ol>
          <li>QC records the new ASSAY result of the lot (and WATER, LOD or residual solvents when the basis needs them) on the lot page, under Test results.</li>
          <li>The head of QC approves each result with a signature. Only approved, passing results in % can be chosen.</li>
          <li>Here, choose the approved results, give the reason for the change and save. The values are copied from the results; nobody types a potency.</li>
          <li>Batches that have not dispensed yet take the new potency when they calculate. A batch that has already calculated shows that the potency changed and must recalculate; the recalculation is an exception for QA.</li>
        </ol>
      </Section>
      {!qc ? <p>Only QC can change a lot's potency.</p> : null}
      {qc && lot && quality.data ? (
        <Section title="Choose the approved results" testId="potency-update">
          <GmpAssayForm
            lotCode={lot.lotCode}
            results={results.data?.results ?? []}
            initialBasis={current ? current.basis : null}
            title={`New potency of lot ${lot.lotCode}`}
            saveLabel="Save the new potency"
            reasonRequired={current !== null}
          />
        </Section>
      ) : null}
    </>
  );
}
