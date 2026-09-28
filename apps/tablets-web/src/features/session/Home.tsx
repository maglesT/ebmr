/** Home: the tiles of this installation (plan section 12): master records and audit on GMP; packages, runs, cockpit and audit on the sandbox. */
import { Link } from '@tanstack/react-router';
import { t } from '@ebmr/ui-kit';
import { cls } from '../../app/classes.ts';
import { useBoot } from '../../app/boot.tsx';
import { useFeatures } from '../../app/feature-context.ts';

export function Home() {
  const boot = useBoot();
  const features = useFeatures();
  const installation = boot.meta?.installation ?? 'GMP';
  const tiles = features.flatMap(([, f]) => f.homeTiles ?? []).filter((tile) => tile.installations.includes(installation));
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
    </>
  );
}
