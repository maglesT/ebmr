/**
 * Parts of the release cockpit shared by its tabs (Phase 4 slices 3 and 4): a G-REL checklist for one market with each
 * item's status, the database's reason and links to its evidence, and the "since review" items acknowledged one by one
 * at the epoch shown. Every status and the epoch are the server's; the browser computes none of them.
 */
import { Link } from '@tanstack/react-router';
import { routes, type GrelItemView, type GrelView } from '@ebmr/api-contract';
import { StatusChip } from '@ebmr/ui-kit';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { evidenceLink, itemTone, itemWord, RELEASE_READS, words } from './reads.ts';
import { DeviationRef } from '../quality/BatchDeviation.tsx';

type EvidenceItem = GrelItemView['evidence'][number];

export function EvidenceList({ evidence, label }: { evidence: readonly EvidenceItem[]; label: string }) {
  if (evidence.length === 0) return null;
  return (
    <ul aria-label={label}>
      {evidence.map((e) => {
        // G2: a deviation opens as the record of the page's batch (DeviationRef), never from a list across batches.
        const link = e.kind === 'DEVIATION' ? null : evidenceLink(e);
        return (
          <li key={`${e.kind}:${e.ref}`}>
            {words(e.kind)}:{' '}
            {e.kind === 'DEVIATION' ? (
              <DeviationRef deviationId={e.ref} label={e.label || e.ref} />
            ) : link ? (
              <Link to={link.to} params={link.params}>
                {e.label || e.ref}
              </Link>
            ) : (
              <span>{e.label || e.ref}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function Evidence({ item }: { item: GrelItemView }) {
  return <EvidenceList evidence={item.evidence} label={`Evidence of ${item.id}`} />;
}

function ItemRow({ item, testIdPrefix }: { item: GrelItemView; testIdPrefix: string }) {
  return (
    <li data-testid={`${testIdPrefix}${item.id}`} data-status={item.status}>
      <StatusChip tone={itemTone(item.status)} label={itemWord(item.status)} /> <strong>{item.id}</strong> {item.title}
      {item.sinceReview ? <StatusChip tone="warning" label="Changed since review" /> : null}
      {item.problem ? <p>{item.problem}</p> : null}
      <Evidence item={item} />
    </li>
  );
}

/** G-REL for one market as the server evaluated it now. */
export function GrelChecklist({ grel: g, title, testId, testIdPrefix = 'grel-item-' }: { grel: GrelView; title: string; testId: string; testIdPrefix?: string }) {
  return (
    <Section title={title} testId={testId}>
      <p>
        {g.ready ? 'No item is red.' : 'Some items are red: the lot cannot be decided for this market yet.'} Evaluated now, evidence epoch {g.epoch}.
      </p>
      <ul>
        {g.items.map((i) => (
          <ItemRow key={i.id} item={i} testIdPrefix={testIdPrefix} />
        ))}
      </ul>
    </Section>
  );
}

/** The items whose evidence changed after the QA review, acknowledged by this person one by one (release.acknowledge). */
export function SinceReview({ lotId, grel, testId = 'since-review' }: { lotId: string; grel: GrelView; testId?: string }) {
  const ack = useCommand(routes.release.acknowledge, RELEASE_READS);
  const items = grel.items.filter((i) => i.sinceReview);
  if (items.length === 0) return null;
  return (
    <Section title={`Changed since the QA review (market ${grel.market})`} testId={testId}>
      <p>The evidence of these items changed after the QA review of the record. Acknowledge each one after you have looked at it; a later change needs a new acknowledgement.</p>
      <ul>
        {items.map((i) => (
          <li key={i.id} data-testid={`${testId}-${i.id}`}>
            <StatusChip tone={itemTone(i.status)} label={itemWord(i.status)} /> <strong>{i.id}</strong> {i.title} <Evidence item={i} />
            {i.acknowledged ? (
              <StatusChip tone="ok" label="Acknowledged by you" />
            ) : (
              <ActButton
                primary={false}
                label={`Acknowledge ${i.id}`}
                onPress={() => ack.run({ params: { lotId }, body: { market: grel.market, itemId: i.id, epoch: grel.epoch } })}
                disabled={ack.busy}
              />
            )}
          </li>
        ))}
      </ul>
      <ActResult error={ack.error} done={ack.done} label="Acknowledged." />
    </Section>
  );
}
