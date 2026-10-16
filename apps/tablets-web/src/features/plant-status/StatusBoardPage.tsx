/**
 * The equipment status board (PR-22): every PROCESS unit, room and line with its state, the batch on it, its cleaning
 * state and its open alarms, as the database holds them at the read time shown.
 */
import { Link } from '@tanstack/react-router';
import { routes, type StatusBoardEntry } from '@ebmr/api-contract';
import { Button, StatusChip, type StateTone } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { words } from './reads.ts';

export const cleaningTone = (s: string | null): StateTone => (s === 'CLEAN' ? 'ok' : s === null ? 'neutral' : s === 'OVERDUE' ? 'warning' : 'error');

export function StatusBoardPage() {
  const q = useApiQuery(routes.equipmentDisplays.statusBoard, {});
  return (
    <>
      <h1>Equipment status board</h1>
      <Section title="Units, rooms and lines" testId="status-board">
        <p data-testid="status-board-read-at">
          {q.data ? `As read at ${q.data.readAt.text}. ` : ''}
          <Button onPress={() => void q.refetch()} isDisabled={q.isFetching}>
            Refresh
          </Button>
        </p>
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        <table>
          <thead>
            <tr>
              <th scope="col">Unit, room or line</th>
              <th scope="col">State</th>
              <th scope="col">Batch</th>
              <th scope="col">Cleaning</th>
              <th scope="col">Open alarms</th>
            </tr>
          </thead>
          <tbody>{q.data?.entries.map((e) => <Row key={`${e.subjectKind}-${e.code}`} e={e} />)}</tbody>
        </table>
      </Section>
    </>
  );
}

function Row({ e }: { e: StatusBoardEntry }) {
  return (
    <tr data-testid={`board-${e.code}`}>
      <th scope="row">
        {e.subjectKind === 'AREA' ? (
          <Link to="/line-station/$code" params={{ code: e.code }}>
            {e.code}
          </Link>
        ) : (
          e.code
        )}{' '}
        {e.name} ({words(e.kind)}){e.classCode ? `, ${e.classCode}` : ''}
      </th>
      <td>
        {e.state ? words(e.state) : 'No state'}
        {e.stateSince ? ` since ${e.stateSince.text}` : ''}
      </td>
      <td>{e.batch ? `${e.batch.batchRef} (${e.batch.product})` : 'None'}</td>
      <td>
        {e.cleaningState ? <StatusChip tone={cleaningTone(e.cleaningState)} label={words(e.cleaningState)} /> : 'Not applicable'}
        {e.lastCleanedAt ? ` last cleaned ${e.lastCleanedAt.text}` : ''}
      </td>
      <td>
        {e.openAlarms > 0 ? (
          <Link to="/alarms">
            <StatusChip tone="error" label={`${e.openAlarms.toString()} open`} />
          </Link>
        ) : (
          'None'
        )}
      </td>
    </tr>
  );
}
