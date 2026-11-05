/**
 * The product's brand in this app (decision 0020): Batchwright Tablets, by Medhanta; "Batchwright Capsules" in the
 * header while a master or batch with a capsule dosage form is on screen (decision 0020 amended, Capsules edition C2). The header shows the icon, the
 * name and the maker's mark; inside the router the name links to the about page (/about, feature session). The header
 * is also drawn outside the router (the role choice), where the name is plain text: InRouter says which.
 */
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { Link } from '@tanstack/react-router';
import { flow } from '@ebmr/recipe-core/pure';
import { brand, t } from '@ebmr/ui-kit';

export const EDITION: brand.LockupEdition = 'TABLETS';

/**
 * The capsule screens on show: each master or batch screen with a capsule dosage form counts itself in while it is
 * mounted (useScreenDosageForm). Display only; no record depends on it.
 */
let capsuleScreens = 0;
const listeners = new Set<() => void>();
const changed = (by: number): void => {
  capsuleScreens += by;
  for (const l of listeners) l();
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** A master or batch screen names its product's dosage form: a capsule form turns the header to Batchwright Capsules. */
export function useScreenDosageForm(dosageForm: string | null | undefined): void {
  const capsule = flow.isCapsuleForm(dosageForm);
  useEffect(() => {
    if (!capsule) return;
    changed(1);
    return () => changed(-1);
  }, [capsule]);
}

/** The header's edition now: Capsules while a capsule master or batch is on screen, else the app's own. */
export function useHeaderEdition(): brand.Edition {
  const n = useSyncExternalStore(subscribe, () => capsuleScreens, () => 0);
  return n > 0 ? 'CAPSULES' : EDITION;
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
