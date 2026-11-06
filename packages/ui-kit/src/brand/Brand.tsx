/**
 * The brand marks (decision 0020): the edition lockup (the Batchwright icon, wordmark and edition badge), the maker's
 * mark ("by" and the Medhanta logo), the icon alone, and the two compositions the screens use: SignInBrand (the
 * sign-in page) and HeaderBrand (the application header). The images are the owner's files in docs/brand (copied into
 * ./assets; test/brand.test.tsx proves the copies equal the originals). Each image has a text alternative, so the
 * marks read as "Batchwright Tablets" and "by Medhanta" to a screen reader. None of these may appear on a GMP record.
 */
import type { ReactNode } from 'react';
import { t } from '../i18n/index.ts';
import { bcls } from './classes.ts';
import { PRODUCT, productTitle, type Edition, type LockupEdition } from './brand.ts';
import icon from './assets/batchwright-icon.svg';
import injectables from './assets/batchwright-injectables.svg';
import medhanta from './assets/medhanta-logo-278x148.png';
import tablets from './assets/batchwright-tablets.svg';

const LOCKUP: Readonly<Record<LockupEdition, string>> = { TABLETS: tablets, INJECTABLES: injectables };

/** The asset URLs (the web app's tests and the about page read them). */
export const BRAND_ASSETS = { icon, lockup: LOCKUP, medhantaLogo: medhanta } as const;

/** The edition lockup, named "Batchwright <Edition>". */
export function Lockup({ edition }: { edition: LockupEdition }) {
  return <img className={bcls('lockup')} src={LOCKUP[edition]} alt={productTitle(edition)} width={560} height={160} />;
}

/** "by" and the Medhanta logo (its text alternative "Medhanta"): the maker, next to the product's name. */
export function MakerMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`${bcls('maker')} ${small ? bcls('makerSmall') : ''}`.trim()} data-testid="maker-mark">
      <span>{t('app.by')}</span>
      <img className={bcls('makerLogo')} src={medhanta} alt={t('app.maker')} width={278} height={148} />
    </span>
  );
}

/** The Batchwright icon alone, decorative beside the product's name. */
export function ProductIcon() {
  return <img className={bcls('icon')} src={icon} alt="" aria-hidden="true" width={28} height={28} />;
}

/**
 * The sign-in page's brand block: the Batchwright icon and name, and the maker's mark. Declutter D3 (decision 0020 as
 * amended, 5 November 2026): the sign-in page, the browser title and the manifest say just "Batchwright"; the header
 * names the edition.
 */
export function SignInBrand() {
  return (
    <div className={bcls('signIn')} data-testid="sign-in-brand">
      <span className={bcls('signInName')}>
        <img className={bcls('signInIcon')} src={icon} alt="" aria-hidden="true" width={48} height={48} />
        <span role="img" aria-label={PRODUCT.name}>
          {PRODUCT.name}
        </span>
      </span>
      <MakerMark />
    </div>
  );
}

/**
 * The header's brand: the icon, the product's name and the maker's mark. `nameLink` wraps the name (the web app
 * passes a link to its about page; the kit knows no router).
 */
export function HeaderBrand({ edition, nameLink }: { edition: Edition; nameLink?: (name: ReactNode) => ReactNode }) {
  const name = <span className={bcls('headerName')}>{productTitle(edition)}</span>;
  return (
    <span className={bcls('header')} data-testid="header-brand">
      <ProductIcon />
      {nameLink ? nameLink(name) : name}
      <MakerMark small />
    </span>
  );
}
