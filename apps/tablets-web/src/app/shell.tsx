/**
 * The shell (plan sections 5 and 12): the TEST, NOT GMP band and watermark on every sandbox screen, the basic
 * identity banner (C1 replaces it with the full IdentityBanner), density by terminal class.
 */
import { Outlet } from '@tanstack/react-router';
import { Button, Layout, StatusChip, t, WatermarkBand, WatermarkOverlay } from '@ebmr/ui-kit';
import { cls } from './classes.ts';
import { useBoot } from './boot.tsx';

export function IdentityBanner() {
  const boot = useBoot();
  const s = boot.session;
  return (
    <div className={cls('banner')}>
      <div className={cls('identity')}>
        <span className={cls('product')}>{t('app.name')}</span>
        <StatusChip tone={boot.meta?.installation === 'SANDBOX' ? 'test' : 'info'} label={boot.meta?.installation === 'SANDBOX' ? t('installation.sandbox') : t('installation.gmp')} />
        {s ? (
          <span className={cls('who')} data-testid="identity">
            {t('session.signedInAs', { name: s.person.legalName, login: s.person.loginName, role: s.role ?? '' })}
          </span>
        ) : null}
        {s ? (
          <span className={cls('muted')}>
            {s.device.deviceCode}
            {s.device.roomCode ? ` · room ${s.device.roomCode}` : ''}
          </span>
        ) : null}
      </div>
      {s ? <Button onPress={() => void boot.signOut()}>{t('session.signOut')}</Button> : null}
    </div>
  );
}

/** The frame every screen sits in, signed in or not. */
export function Frame({ children, withBanner }: { children: React.ReactNode; withBanner: boolean }) {
  const boot = useBoot();
  const watermark = boot.meta?.watermark ?? null;
  return (
    <>
      {watermark ? <WatermarkOverlay text={watermark.text} /> : null}
      <Layout top={watermark ? <WatermarkBand text={watermark.text} notice={watermark.notice} /> : undefined} header={withBanner ? <IdentityBanner /> : undefined}>
        {children}
      </Layout>
    </>
  );
}

/** Root route component: the signed-in shell around the current route. */
export function ShellOutlet() {
  return (
    <Frame withBanner>
      <Outlet />
    </Frame>
  );
}
