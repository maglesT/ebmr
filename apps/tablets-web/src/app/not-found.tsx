/**
 * The page for an address the application does not have, instead of the router's bare "Not Found". A link copied
 * from a sentence often carries the sentence's full stop or comma: the page offers the address without it.
 */
import { useRouterState } from '@tanstack/react-router';
import { t } from '@ebmr/ui-kit';

/** The path without punctuation a sentence may have added at its end, or null when there is none to take off. */
export function withoutTrailingPunctuation(path: string): string | null {
  const trimmed = path.replace(/[.,;:!?)\]'"»”’]+$/u, '');
  return trimmed !== path && trimmed !== '' ? trimmed : null;
}

export function NotFoundPage() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.searchStr });
  const hash = useRouterState({ select: (s) => s.location.hash });
  const trimmed = withoutTrailingPunctuation(path);
  // The offer keeps the address's search and fragment (/packages.?package=<hash> offers /packages?package=<hash>; F65).
  const suggestion = trimmed === null ? null : `${trimmed}${search}${hash ? `#${hash.replace(/^#/, '')}` : ''}`;
  return (
    <section aria-labelledby="not-found-title" data-testid="not-found">
      <h1 id="not-found-title">{t('app.notFound.title')}</h1>
      <p>{t('app.notFound.text', { path })}</p>
      {suggestion ? (
        <p>
          <a href={suggestion}>{t('app.notFound.withoutPunctuation', { path: suggestion })}</a>
        </p>
      ) : null}
      <p>
        <a href="/">{t('app.notFound.home')}</a>
      </p>
    </section>
  );
}
