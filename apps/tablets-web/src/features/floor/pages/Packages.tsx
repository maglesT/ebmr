/**
 * Test-run packages (module C4; plan section 12, screen 11): the exchange inbox with each package's hash, GMP
 * origin and state; import (the server recomputes the hashes, requires a GMP stamp and checks the record can
 * run); and the way to issue a TEST- batch from an imported package. Why a package cannot be imported is the
 * server's answer (`problem`).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type TestPackageView } from '@ebmr/api-contract';
import { Banner, Button, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../../api/hooks.ts';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { wcls } from '../classes.ts';
import { useRouteSearch } from '../params.ts';
import { useLeaveGuard } from '../unsettled.ts';
import { EntryStatus } from '../components/EntryStatus.tsx';
import { st } from '../text.ts';
import { usePendingCall } from '../usePendingCall.ts';

function PackageItem({ p, highlighted }: { p: TestPackageView; highlighted: boolean }) {
  const qc = useQueryClient();
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: 'center' });
  }, [highlighted]);
  const importCall = usePendingCall(routes.execution.importPackage, { packageId: p.packageId }, {
    reason: st('tap.reason.import'),
    onSaved: () => qc.invalidateQueries({ queryKey: [routes.execution.testPackages.id] }),
    onStale: async () => {
      await qc.invalidateQueries({ queryKey: [routes.execution.testPackages.id] });
      return ['The package list was reloaded.'];
    },
  });
  const unsettled = importCall.busy || importCall.state === 'notSaved';
  return (
    <li ref={ref} className={wcls('item')} data-testid={`package-${p.packageId}`} data-highlight={String(highlighted)} {...(highlighted ? { 'aria-current': 'true' as const } : {})}>
      <h2 className={wcls('itemTitle')}>
        <span>{st('packages.version', { product: p.product.name, family: p.familyCode, version: p.versionNumber, revision: p.revision })}</span>
        <StatusChip tone="neutral" label={p.state} />
        {p.imported ? <StatusChip tone="ok" label={st('packages.imported', { at: p.importedAt?.text ?? '' })} /> : null}
      </h2>
      <dl className={wcls('facts')}>
        <dt>{st('packages.packageHash')}</dt>
        <dd className={wcls('hash')}>{p.packageHash}</dd>
        <dt>{st('packages.contentHash')}</dt>
        <dd className={wcls('hash')}>{p.contentHash}</dd>
        <dt>{st('packages.originLabel')}</dt>
        <dd>{st('packages.origin', { installation: p.sourceInstallation, exporter: p.exporter, at: p.exportedAt.text })}</dd>
        <dt>{st('packages.file')}</dt>
        <dd className={wcls('hash')}>{p.fileName}</dd>
      </dl>
      {p.sourceInstallation !== 'GMP' ? <p role="alert">{st('packages.notGmp')}</p> : null}
      {p.problem ? <p role="alert">{p.problem}</p> : null}
      <div className={wcls('row')}>
        {p.imported ? (
          <Link to="/packages/$packageId/issue" params={{ packageId: p.packageId }} className={`${wcls('link')} ${wcls('linkPrimary')}`}>
            {st('packages.issue')}
          </Link>
        ) : (
          <Button variant="primary" onPress={() => importCall.submit({}, `Import ${p.fileName}`)} isDisabled={p.problem !== null || unsettled}>
            {st('packages.import')}
          </Button>
        )}
      </div>
      <EntryStatus call={importCall} />
    </li>
  );
}

/**
 * The inbox. `?package=<packageHash>` (the link the GMP designer shows after an export, at /test-packages or
 * /packages) highlights that package.
 */
export function PackagesPage() {
  const packages = useApiQuery(routes.execution.testPackages);
  const wanted = useRouteSearch()['package'] ?? null;
  const held = useLeaveGuard();
  return (
    <>
      <h1>{st('packages.title')}</h1>
      {held ? <Banner tone="warning" title={st('leave.held')} /> : null}
      {packages.isPending ? <p>{st('loading')}</p> : null}
      {packages.error ? <RefusalMessage error={packages.error.error} /> : null}
      {packages.data && packages.data.packages.length === 0 ? <p>{st('packages.empty')}</p> : null}
      <ul className={wcls('list')} aria-label={st('packages.title')}>
        {packages.data?.packages.map((p) => (
          <PackageItem key={p.packageId} p={p} highlighted={wanted !== null && (p.packageHash === wanted || p.packageId === wanted)} />
        ))}
      </ul>
    </>
  );
}
