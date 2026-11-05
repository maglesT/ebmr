/**
 * The product's brand in this app (decision 0020): Batchwright Tablets, by Medhanta; "Batchwright Capsules" or "Batchwright Injectables" in
 * the header while a master or batch with a capsule or injectable dosage form is on screen (decision 0020 amended,
 * Capsules edition C2, injectables plan I-1c). The header shows the icon, the
 * name and the maker's mark; inside the router the name links to the about page (/about, feature session). The header
 * is also drawn outside the router (the role choice), where the name is plain text: InRouter says which.
 */
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { Link } from '@tanstack/react-router';
import { flow } from '@ebmr/recipe-core/pure';
import { brand, t } from '@ebmr/ui-kit';

export const EDITION: brand.LockupEdition = 'TABLETS';

/**
 * The capsule and injectable screens on show: each master or batch screen with a capsule or an injectable dosage form
 * counts itself in while it is mounted (useScreenDosageForm). Display only; no record depends on it.
 */
const screens: Record<'CAPSULES' | 'INJECTABLES', number> = { CAPSULES: 0, INJECTABLES: 0 };
const listeners = new Set<() => void>();
const changed = (edition: 'CAPSULES' | 'INJECTABLES', by: number): void => {
  screens[edition] += by;
  for (const l of listeners) l();
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * A master or batch screen names its product's dosage form: a capsule form turns the header to Batchwright Capsules,
 * an injectable form (injectables plan I-1c) to Batchwright Injectables.
 */
export function useScreenDosageForm(dosageForm: string | null | undefined): void {
  const edition = flow.isCapsuleForm(dosageForm) ? 'CAPSULES' : flow.isInjectableForm(dosageForm) ? 'INJECTABLES' : null;
  useEffect(() => {
    if (!edition) return;
    changed(edition, 1);
    return () => changed(edition, -1);
  }, [edition]);
}

const headerNow = (): brand.Edition => (screens.CAPSULES > 0 ? 'CAPSULES' : screens.INJECTABLES > 0 ? 'INJECTABLES' : EDITION);

/** The header's edition now: Capsules or Injectables while such a master or batch is on screen, else the app's own. */
export function useHeaderEdition(): brand.Edition {
  return useSyncExternalStore(subscribe, headerNow, () => EDITION);
}

/** True under the router's root route (ShellOutlet), where a Link can be drawn. */
export const InRouter = createContext(false);

export function AppHeaderBrand() {
  const inRouter = useContext(InRouter);
  const edition = useHeaderEdition();
  return (
    <brand.HeaderBrand
      edition={edition}
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

/**
 * R2 (hosted-demo trials): the way back to the home screen from any screen of the router (a presenter had none but the
 * browser's back button). Outside the router (the role choice) there is nothing to go back to: nothing is drawn.
 */
export function HomeLink() {
  const inRouter = useContext(InRouter);
  if (!inRouter) return null;
  return (
    <Link to="/" data-testid="home-link">
      Home
    </Link>
  );
}
