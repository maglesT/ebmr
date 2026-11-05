/**
 * Home (declutter D3): the four work cards (work.tsx) and one plain link, "All screens", to the list of this
 * installation's screens (plan section 12: master records and audit on GMP; packages, runs, cockpit and audit on the
 * sandbox). Decision D-P7R-18 (gap F1): the screens the session's role cannot use are left out of the list
 * (app/tile-access.ts; display only, the server stays the authority); "Show all screens" lists them again. Declutter D2:
 * a screen that is not part of Batchwright here (meta.disconnected) is never offered, not even under "Show all screens".
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { t } from '@ebmr/ui-kit';
import { cls } from '../../app/classes.ts';
import { useBoot } from '../../app/boot.tsx';
import { useFeatures } from '../../app/feature-context.ts';
import { tileOffered } from '../../app/tile-access.ts';
import { useScreensOff } from '../../app/disconnected.tsx';
import { WorkCards } from './work.tsx';

export function Home() {
  return (
    <>
      <h1>{t('home.title')}</h1>
      <WorkCards />
      <p>
        <Link to="/screens" className={cls('allScreens')} data-testid="home-all-screens">
          All screens
        </Link>
      </p>
    </>
  );
}

/** "All screens": a plain list of the screens offered here, by title. */
export function ScreensPage() {
  const boot = useBoot();
  const features = useFeatures();
  const role = boot.session?.role ?? null;
  const [showAll, setShowAll] = useState(false);
  const installation = boot.meta?.installation ?? 'GMP';
  const off = useScreensOff();
  const all = features.flatMap(([, f]) => f.homeTiles ?? []).filter((tile) => tile.installations.includes(installation) && !off(tile.to));
  const usable = all.filter((tile) => tileOffered(tile.id, installation, role));
  const hidden = all.length - usable.length;
  const tiles = showAll ? all : usable;
  return (
    <>
      <h1>All screens</h1>
      <nav aria-label="Functions">
        <ul className={cls('screenList')}>
          {tiles.map((tile) => (
            <li key={tile.id} data-available={tile.available ? 'true' : 'false'}>
              {tile.available ? (
                <Link to={tile.to}>{tile.title}</Link>
              ) : (
                <span aria-disabled="true">
                  {tile.title} <em>{t('home.notAvailable')}</em>
                </span>
              )}
            </li>
          ))}
        </ul>
      </nav>
      {hidden > 0 ? (
        <p>
          <button type="button" className={cls('showAll')} onClick={() => setShowAll((v) => !v)} data-testid="home-show-all">
            {showAll ? `Show only the screens your role uses` : `Show all screens (${String(hidden)} more that your role ${role ?? ''} cannot use)`}
          </button>
        </p>
      ) : null}
    </>
  );
}
