/**
 * The bulk issue of a packaging order (Phase 4 slice 2c; Phase 3 exit residual "no screen for the bulk issue"): the
 * order, the processing batch it packs and whether QA released it for packing (H-PACK), the bulk issued so far, and every
 * output container of the processing batch with the database's reason it cannot be issued now. The person picks the
 * usable containers and issues them (POST /api/batches/:batchId/bulk, their own act: on a shared terminal with a fresh
 * badge tap, FRESH_ON_SHARED through app/acts.tsx). The database checks everything again (recipe.issue_packaging_bulk:
 * the order issued or running, the release for packing, each container usable with its net quantity; all or nothing);
 * the screen computes nothing and shows the server's answer.
 */
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { routes, type PackagingBulkView } from '@ebmr/api-contract';
import { Banner, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
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
        <Link to="/planning/packaging">Packaging orders</Link>
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
              {i.label}: {i.quantity} {i.unit}, issued by {i.issuedBy.legalName}, {i.issuedAt.text}
            </li>
          ))}
        </ul>
      </Section>
      <Section title={`Containers of batch ${v.parent?.batchNumber ?? ''}`} testId="bulk-containers">
        {v.containers.length === 0 ? <p>The processing batch has no output container.</p> : null}
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
    </>
  );
}
