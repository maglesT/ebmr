/**
 * The bulk issue of a packaging order (Phase 4 slice 2c; Phase 3 exit residual "no screen for the bulk issue"): the
 * order, the processing batch it packs and whether QA released it for packing (H-PACK), the bulk issued so far, and the
 * processing batch's bulk (its final output: the containers of its last stage, never rejects; tablets 1770) with the
 * database's reason a container cannot be issued now. The person picks the
 * usable containers and issues them (POST /api/batches/:batchId/bulk, their own act: on a shared terminal with a fresh
 * badge tap, FRESH_ON_SHARED through app/acts.tsx). The database checks everything again (recipe.issue_packaging_bulk:
 * the order issued or running, the release for packing, each container usable with its net quantity; all or nothing);
 * the screen computes nothing and shows the server's answer.
 */
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { routes, type PackagingBulkView } from '@ebmr/api-contract';
import { Banner, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { DefineForm } from '../../app/define-form.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { useRouteParams } from '../floor/params.ts';

const REFRESH = [routes.planning.packagingBulk.id, routes.planning.packagingOrders.id];

export function BulkIssuePage() {
  const batchId = useRouteParams()['batchId'] ?? '';
  const q = useApiQuery(routes.planning.packagingBulk, { params: { batchId } });
  const v = q.data;
  return (
    <>
      <h1>Bulk for packaging order {v?.batchNumber ?? ''}</h1>
      <p>
        <Link to="/planning/packaging">Packaging orders</Link> ·{' '}
        {/* R2: the order's line completion and its serial pools, from the order. */}
        <Link to="/labels/packaging/$batchId" params={{ batchId }} data-testid="packaging-completion-link">Line completion (coding, labels, inspection)</Link> ·{' '}
        <Link to="/serialisation/batches/$batchId" params={{ batchId }} data-testid="serial-pools-link">Serial pools</Link>
      </p>
      {q.isPending ? <p>Loading the packaging order…</p> : null}
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v ? <BulkIssue v={v} /> : null}
    </>
  );
}

function BulkIssue({ v }: { v: PackagingBulkView }) {
  const floorRole = useOffered('PRODUCTION_FLOOR');
  const planner = useOffered('PLANNING');
  const canIssue = floorRole || planner;
  const [chosen, setChosen] = useState<string[]>([]);
  const issue = useCommand(routes.batches.issueBulk, REFRESH, 'issuing bulk to the packaging order');
  const toggle = (label: string) => setChosen((c) => (c.includes(label) ? c.filter((x) => x !== label) : [...c, label]));
  const go = async () => {
    const r = await issue.run({ params: { batchId: v.batchId }, body: { labels: chosen } });
    if (r) setChosen([]);
  };
  const ready = v.orderProblem === null && v.parent !== null && v.parent.releaseForPackingProblem === null;
  return (
    <>
      <p data-testid="bulk-order">
        <StatusChip tone={v.status === 'PLANNED' ? 'neutral' : 'ok'} label={v.status} /> {v.familyCode} · pack type {v.packType ?? 'not named'} · {v.productCode} {v.strength} · line {v.line}
      </p>
      {v.orderProblem ? <Banner tone="warning" title="No bulk can be issued to this order now.">{v.orderProblem}</Banner> : null}
      {v.parent ? (
        <p data-testid="bulk-parent">
          Packs processing batch {v.parent.batchNumber}.{' '}
          {v.parent.releaseForPackingProblem ? null : 'QA released it for packing.'}
        </p>
      ) : (
        <Banner tone="error" title="This order names no processing batch." />
      )}
      {v.parent?.releaseForPackingProblem ? (
        <Banner tone="warning" title={`Batch ${v.parent.batchNumber} is not released for packing yet.`}>
          {v.parent.releaseForPackingProblem}
        </Banner>
      ) : null}
      <Section title="Bulk issued" testId="bulk-issued">
        {v.issued.length === 0 ? <p>No bulk issued yet.</p> : null}
        <ul aria-label="Bulk issued">
          {v.issued.map((i) => (
            <li key={i.containerId} data-testid={`issued-${i.label}`}>
              {i.label}: {floor.quantityText(i.quantity, i.unit)}, issued by {i.issuedBy.legalName}, {i.issuedAt.text}
            </li>
          ))}
        </ul>
      </Section>
      <Section title={`Bulk of batch ${v.parent?.batchNumber ?? ''}`} testId="bulk-containers">
        {v.containers.length === 0 ? <p>The processing batch has no bulk for packing (its last stage's containers) yet.</p> : null}
        <ul aria-label="Containers">
          {v.containers.map((c) => (
            <li key={c.containerId} data-testid={`bulk-container-${c.label}`}>
              {c.issueProblem === null && canIssue && ready ? (
                <label>
                  <input type="checkbox" checked={chosen.includes(c.label)} onChange={() => toggle(c.label)} /> {c.label}
                </label>
              ) : (
                <span>{c.label}</span>
              )}{' '}
              · {c.state} · {c.stage} · {c.netQuantity === null ? 'no net quantity' : `${c.netQuantity} ${c.unit}`}
              {c.issueProblem ? <span> · cannot be issued: {c.issueProblem}</span> : null}
            </li>
          ))}
        </ul>
        {canIssue && ready ? (
          <ActButton label={chosen.length === 1 ? 'Issue 1 container' : `Issue ${String(chosen.length)} containers`} onPress={go} disabled={issue.busy || chosen.length === 0} />
        ) : null}
        <ActResult error={issue.error} done={issue.done} label="Bulk issued." />
      </Section>
      {v.status === 'EXECUTION_COMPLETE' || v.finishedLot ? <FinishedLot batchId={v.batchId} posted={v.finishedLot} /> : null}
    </>
  );
}

/**
 * The finished lot of a completed packaging order, posted in quarantine (slice 2b's route; IN-05 (a), PR-45): it leaves
 * quarantine only through the release model. The quantity is the person's count; the database checks the order. Once
 * posted the lot is given back by its code with links to it and to its release (R10 #12), and the post is not offered
 * again (the database allows one finished lot per order).
 */
function FinishedLot({ batchId, posted }: { batchId: string; posted: PackagingBulkView['finishedLot'] }) {
  const stores = useOffered('STORES');
  const planner = useOffered('PLANNING');
  const [answer, setAnswer] = useState<{ lotId: string; lotCode: string } | null>(null);
  const lot = answer ?? posted;
  if (lot) {
    return (
      <Section title="Finished lot" testId="finished-lot">
        <p data-testid="finished-lot-posted">
          Finished lot{' '}
          <Link to="/quality/lots/$lotId" params={{ lotId: lot.lotId }}>
            {lot.lotCode}
          </Link>{' '}
          posted in quarantine ·{' '}
          <Link to="/release/$lotId" params={{ lotId: lot.lotId }}>
            Its release in the release cockpit
          </Link>
        </p>
      </Section>
    );
  }
  if (!stores && !planner) return null;
  return (
    <Section title="Finished lot" testId="finished-lot">
      <DefineForm
        title="Post the finished lot"
        route={routes.specifications.postFinishedLot}
        fixed={{ batchId }}
        refresh={[routes.quality.lots.id, routes.planning.packagingBulk.id, routes.release.queue.id]}
        submitLabel="Post the finished lot in quarantine"
        onDone={(r) => setAnswer({ lotId: r.lotId, lotCode: r.lotCode })}
        fields={[
          { name: 'quantity', label: 'Finished quantity', kind: 'decimal' },
          { name: 'unit', label: 'Unit', kind: 'text', description: 'e.g. units, packs' },
        ]}
      />
    </Section>
  );
}
