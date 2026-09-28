/**
 * The application: providers (TanStack Query, boot state, the port contexts of C1 and C5) and the gate from
 * start-up to sign-in to the router. Cached reads are dropped when the signed-in person or role changes.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { Banner, t } from '@ebmr/ui-kit';
import { KioskLogin, NotEnrolled, OfficeLogin, RoleChoice, DemoPicker } from '../features/session/index.tsx';
import { BootProvider, useBoot } from './boot.tsx';
import { FeaturesContext } from './feature-context.ts';
import { WEB_FEATURES } from './features.ts';
import { createAppRouter } from './router.tsx';
import { SessionScopedReads } from './session-reads.tsx';
import { Frame } from './shell.tsx';
import { cls } from './classes.ts';

/** Wraps the app in every feature's Provider (port implementations), in list order. */
function FeatureProviders({ children }: { children: ReactNode }) {
  return WEB_FEATURES.reduceRight<ReactNode>((acc, [name, f]) => (f.Provider ? <f.Provider key={name}>{acc}</f.Provider> : acc), children);
}

function Gate() {
  const boot = useBoot();
  const [router] = useState(createAppRouter);
  switch (boot.phase) {
    case 'loading':
      return <p className={cls('center')}>{t('app.loading')}</p>;
    case 'failed':
      return (
        <div className={cls('center')}>
          <Banner tone="error" title="The application could not start.">
            <p>{boot.problem}</p>
          </Banner>
        </div>
      );
    case 'mismatch':
      return (
        <div className={cls('center')}>
          <Banner tone="error" title={t('app.installationMismatch')} />
        </div>
      );
    case 'no-device':
      return <Frame withBanner={false}>{boot.meta?.demo ? <DemoPicker /> : <NotEnrolled problem={null} />}</Frame>;
    case 'device-refused':
      return <Frame withBanner={false}>{boot.meta?.demo ? <><NotEnrolled problem={boot.problem} /><DemoPicker /></> : <NotEnrolled problem={boot.problem} />}</Frame>;
    case 'signed-out':
      return <Frame withBanner={false}>{boot.device?.density === 'FLOOR' ? <KioskLogin /> : <OfficeLogin />}</Frame>;
    case 'ready':
      if (boot.session?.roleChoiceRequired) return <Frame withBanner>{<RoleChoice />}</Frame>;
      return <RouterProvider router={router} />;
  }
}

export function App() {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }));
  return (
    <QueryClientProvider client={queryClient}>
      <FeaturesContext.Provider value={WEB_FEATURES}>
      <BootProvider>
        <SessionScopedReads />
        <FeatureProviders>
          <Gate />
        </FeatureProviders>
      </BootProvider>
      </FeaturesContext.Provider>
    </QueryClientProvider>
  );
}
