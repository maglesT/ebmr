/**
 * Labelling specimens (Phase 7 slice 7g-2, decision 0025; tablets 1479; DI-35): the labelling and printed packaging
 * specimens the master-data steward recorded as SPECIMEN reference documents, each with its state; a QA MBR approver who
 * did not record it approves it through the signing ceremony (SPECIMEN_ACT APPROVE, meaning SPECIMEN_APPROVED). The
 * database refuses the person who recorded it and a second approval, in its own words.
 */
import { routes, type LabellingSpecimenView } from '@ebmr/api-contract';
import { StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { MASTER_RECORD_READS, stateTone, words } from './reads.ts';

export function SpecimensPage() {
  const q = useApiQuery(routes.designer.specimens, {});
  return (
    <>
      <h1>Labelling specimens</h1>
      <p>
        Every printed component of a master record cites the specimen of its label or printed packaging. A specimen is recorded with the hash of its artwork; QA approves it,
        and never the person who recorded it.
      </p>
      <Section title="Specimens" testId="specimens">
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        {q.data && q.data.specimens.length === 0 ? <p>No specimen is recorded.</p> : null}
        <ul>
          {q.data?.specimens.map((s) => <Specimen key={s.documentId} s={s} />)}
        </ul>
      </Section>
    </>
  );
}

function Specimen({ s }: { s: LabellingSpecimenView }) {
  const signed = useSignedAct(MASTER_RECORD_READS);
  return (
    <li data-testid={`specimen-${s.code}-${s.version}`} data-state={s.state}>
      <strong>
        {s.code} version {s.version}
      </strong>{' '}
      {s.title} <StatusChip tone={stateTone(s.state)} label={words(s.state)} />
      <br />
      Effective from {s.effectiveFrom}; hash {s.hash.slice(0, 12)}…; recorded by {s.recordedBy.legalName} {s.recordedAt.text}
      {s.approvedBy ? `; approved by ${s.approvedBy.legalName} ${s.approvedAt?.text ?? ''}` : ''}
      {s.state === 'RECORDED' ? (
        <>
          <ActButton
            label={`Approve specimen ${s.code} version ${s.version}`}
            onPress={() => signed.sign({ kind: 'SPECIMEN_ACT', act: 'APPROVE', documentId: s.documentId }, `Approve labelling specimen ${s.code} version ${s.version}: ${s.title}`)}
            disabled={signed.busy}
          />
          <ActResult error={signed.error} outcome={signed.outcome} />
        </>
      ) : null}
    </li>
  );
}
