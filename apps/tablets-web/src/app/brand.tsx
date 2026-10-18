/**
 * The product's brand in this app (decision 0020): Batchwright Tablets, by Medhanta. The header shows the icon, the
 * name and the maker's mark; inside the router the name links to the about page (/about, feature session). The header
 * is also drawn outside the router (the role choice), where the name is plain text: InRouter says which.
 */
import { createContext, useContext } from 'react';
import { Link } from '@tanstack/react-router';
import { brand, t } from '@ebmr/ui-kit';

export const EDITION: brand.Edition = 'TABLETS';

/** True under the router's root route (ShellOutlet), where a Link can be drawn. */
export const InRouter = createContext(false);

export function AppHeaderBrand() {
  const inRouter = useContext(InRouter);
  return (
    <brand.HeaderBrand
      edition={EDITION}
      {...(inRouter
        ? {
            nameLink: (name: React.ReactNode) => (
              <Link to="/about" title={t('about.link')}>
                {name}
              </Link>
            ),
          }
        : {})}
    />
  );
}
