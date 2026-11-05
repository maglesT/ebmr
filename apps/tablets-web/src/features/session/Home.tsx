/**
 * Home: the tiles of this installation (plan section 12): master records and audit on GMP; packages, runs, cockpit and audit
 * on the sandbox. Decision D-P7R-18 (gap F1): the tiles whose screen the session's role cannot use are hidden
 * (app/tile-access.ts; display only, the server stays the authority); "Show all screens" lists them again.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { t } from '@ebmr/ui-kit';
import { cls } from '../../app/classes.ts';
import { useBoot } from '../../app/boot.tsx';
import { useFeatures } from '../../app/feature-context.ts';
import { tileOffered } from '../../app/tile-access.ts';
import { useScreensOff } from '../../app/disconnected.tsx';

export function Home() {
  const boot = useBoot();
  const features = useFeatures();
  const role = boot.session?.role ?? null;
  const [showAll, setShowAll] = useState(false);
  const installation = boot.meta?.installation ?? 'GMP';
  const off = useScreensOff();
  // Declutter D2: a screen that is not part of Batchwright here is not offered, not even under "Show all screens".
  const all = features.flatMap(([, f]) => f.homeTiles ?? []).filter((tile) => tile.installations.includes(installation) && !off(tile.to));
  const usable = all.filter((tile) => tileOffered(tile.id, installation, role));
  const hidden = all.length - usable.length;
  const tiles = showAll ? all : usable;
  return (
    <>
      <h1>{t('home.title')}</h1>
      <nav aria-label="Functions" className={cls('tiles')}>
        {tiles.map((tile) =>
          tile.available ? (
            <Link key={tile.id} to={tile.to} className={cls('tile')} data-available="true">
              <p className={cls('tileTitle')}>{tile.title}</p>
              <span>{tile.description}</span>
            </Link>
          ) : (
            <div key={tile.id} className={cls('tile')} data-available="false" aria-disabled="true">
              <p className={cls('tileTitle')}>{tile.title}</p>
              <span>{tile.description}</span>
              <p>
                <em>{t('home.notAvailable')}</em>
              </p>
            </div>
          ),
        )}
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
