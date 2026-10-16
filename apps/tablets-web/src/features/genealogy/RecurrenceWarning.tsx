/**
 * The recurrence warning of the certification screen (PR-49; recipe-core 1012, genealogy.recurrence): for each deviation
 * of the lot, how many deviations of the same product with the same root-cause category were raised in the window, and
 * a warning from the threshold on (the third). The count, the window and the threshold are the database's; the screen
 * only shows them. Nothing is shown while no deviation recurs.
 */
import { routes } from '@ebmr/api-contract';
import { Banner } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { words } from './reads.ts';

export function RecurrenceWarning({ lotId }: { lotId: string }) {
  const q = useApiQuery(routes.genealogy.recurrence, { params: { lotId } });
  const v = q.data;
  if (!v || !v.warning) return null;
  return (
    <Banner tone="warning" title={`Recurring deviation: the same root cause ${v.threshold.toString()} times or more in ${v.windowDays.toString()} days (PR-49)`}>
      <ul data-testid="recurrence-warning">
        {v.items
          .filter((i) => i.warning)
          .map((i) => (
            <li key={i.deviationId} data-testid={`recurrence-${i.ref}`} data-occurrences={i.occurrences.toString()}>
              {i.ref} {i.title}: {i.rootCauseCategory ? words(i.rootCauseCategory) : 'no root cause yet'} on {i.productCode}, occurrence {i.occurrences.toString()}
              {i.others.length > 0 ? ` (also ${i.others.map((o) => `${o.ref}, ${o.raisedAt.text}`).join('; ')})` : ''}
            </li>
          ))}
      </ul>
    </Banner>
  );
}
