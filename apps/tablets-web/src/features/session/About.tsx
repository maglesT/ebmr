/**
 * The about page (/about; decision 0020, slice 7e): the product (Batchwright), its edition (Tablets), the version the
 * server reports (/api/meta `version`, the server package's version; D-P7-14 sets it for the release candidate), the
 * maker (Medhanta, with its logo), this installation and site, and the rule that the records made here carry the
 * manufacturer's identity, never the vendor's.
 */
import { brand, t } from '@ebmr/ui-kit';
import { EDITION } from '../../app/brand.tsx';
import { cls } from '../../app/classes.ts';
import { useBoot } from '../../app/boot.tsx';
import { installationLabel } from '../../app/installation.ts';

export function About() {
  const boot = useBoot();
  const meta = boot.meta;
  const rows: [string, string][] = [
    [t('about.product'), brand.PRODUCT.name],
    [t('about.edition'), brand.editionWord(EDITION)],
    [t('about.version'), meta?.version ?? '?'],
    [t('about.maker'), t('about.makerName')],
    [t('about.installation'), installationLabel(meta?.installation)],
    [t('about.site'), meta?.site.code ?? '?'],
  ];
  return (
    <>
      <h1>{t('about.title')}</h1>
      <brand.SignInBrand />
      <dl className={cls('about')} data-testid="about-facts">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p>{t('about.records')}</p>
    </>
  );
}
