/**
 * The vendor-history routes of excipients (Phase 7 slice 7g, WP4; decision 0025; IN-24 (c)): each route proposed, enabled
 * by QA with its signed justification, or disabled with the reason. QA disables an enabled route with the reason; the
 * lots of the material then need the identity test again. Every right and rule is the database's.
 */
import { useState } from 'react';
import { routes, type VendorRouteView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';

const READS = [routes.quality.vendorRoutes.id];

export function VendorRoutesPage() {
  const q = useApiQuery(routes.quality.vendorRoutes);
  const qa = useOffered('QA');
  return (
    <>
      <h1>Vendor-history routes</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.routes.length === 0 ? <p>No vendor-history route.</p> : null}
      <ul>
        {q.data?.routes.map((r) => (
          <li key={r.routeId} data-testid={`vendor-route-${r.materialCode}`}>
            <RouteRow r={r} qa={qa} />
          </li>
        ))}
      </ul>
    </>
  );
}

function RouteRow({ r, qa }: { r: VendorRouteView; qa: boolean }) {
  const disable = useCommand(routes.quality.disableVendorRoute, READS, 'disabling a vendor-history route');
  const [reason, setReason] = useState('');
  const state = r.disabled ? `disabled by ${r.disabled.by.legalName}: ${r.disabled.reason}` : r.enabled ? `enabled by ${r.enabled.by.legalName}, ${r.enabled.at.text}` : 'proposed';
  return (
    <>
      <p>
        {r.materialCode} at {r.siteCode}: {r.justification} (statistics {r.statisticalReference}), proposed by {r.proposedBy.legalName}, {r.proposedAt.text}{' '}
        <StatusChip tone={r.disabled ? 'neutral' : r.enabled ? 'ok' : 'warning'} label={state} />
      </p>
      {qa && r.enabled && !r.disabled ? (
        <>
          <Field name={`disable-${r.routeId}`} label={`Reason to disable the route of ${r.materialCode}`} value={reason} onChange={setReason} />
          <ActButton
            label={`Disable the route of ${r.materialCode}`}
            disabled={reason.trim() === '' || disable.busy}
            onPress={() => disable.run({ params: { routeId: r.routeId }, body: { reason: reason.trim() } })}
          />
          <ActResult error={disable.error} done={disable.done} label="Route disabled." />
        </>
      ) : null}
    </>
  );
}
