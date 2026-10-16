/**
 * Rooms and lines (PR-15, PR-25, PR-27; DI-32, DI-49): each with its cleaning state, clean-hold time, controlled-area
 * flag and open spills; per room its latest temperature and humidity from the EMS (raw value, status, received time) and
 * its open alarms, and the record of a spill (the room is then CLEANING_REQUIRED until a verified cleaning).
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type RoomStateView } from '@ebmr/api-contract';
import { Button, Dialog, Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { ROOM_READS, words } from './reads.ts';
import { cleaningTone } from './StatusBoardPage.tsx';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A clean-hold time in seconds as hours (whole-number text from the server; display only). */
const hold = (s: string | null): string => (s === null ? 'none' : BigInt(s) % 3600n === 0n ? `${(BigInt(s) / 3600n).toString()} h` : `${s} s`);

export function RoomsPage() {
  const q = useApiQuery(routes.plantRules.rooms, {});
  const [room, setRoom] = useState<string | null>(null);
  return (
    <>
      <h1>Rooms and lines</h1>
      <Section title="Rooms and lines" testId="rooms">
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        <table>
          <thead>
            <tr>
              <th scope="col">Room or line</th>
              <th scope="col">Cleaning</th>
              <th scope="col">Clean hold</th>
              <th scope="col">Controlled area</th>
              <th scope="col">Open spills</th>
            </tr>
          </thead>
          <tbody>{q.data?.rooms.map((r) => <Row key={r.code} r={r} onOpen={() => setRoom(r.code)} />)}</tbody>
        </table>
      </Section>
      {room ? <RoomConditions code={room} /> : null}
    </>
  );
}

function Row({ r, onOpen }: { r: RoomStateView; onOpen: () => void }) {
  return (
    <tr data-testid={`room-${r.code}`} data-cleaning={r.cleaningState}>
      <th scope="row">
        <Button onPress={onOpen}>{`${r.code} ${r.name}`}</Button> ({words(r.kind)})
      </th>
      <td>
        <StatusChip tone={cleaningTone(r.cleaningState)} label={words(r.cleaningState)} />
        {r.lastCleanedAt ? ` last cleaned ${r.lastCleanedAt.text}` : ''}
      </td>
      <td>{hold(r.cleanHoldSeconds)}</td>
      <td>{r.authorisationRequired ? 'Yes: area authorisation needed' : 'No'}</td>
      <td>{r.openSpills > 0 ? <StatusChip tone="error" label={`${r.openSpills.toString()} open`} /> : 'None'}</td>
    </tr>
  );
}

function RoomConditions({ code }: { code: string }) {
  const q = useApiQuery(routes.plantRules.roomConditions, { params: { code } });
  const [spill, setSpill] = useState(false);
  const v = q.data;
  return (
    <Section title={`Conditions of ${code}`} testId="room-conditions">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v ? (
        <>
          <p>
            {v.name}: {v.cleaningState ? <StatusChip tone={cleaningTone(v.cleaningState)} label={words(v.cleaningState)} /> : 'no cleaning state'}. As read at {v.readAt.text}.
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Measurement</th>
                <th scope="col">Value</th>
                <th scope="col">Raw</th>
                <th scope="col">Status</th>
                <th scope="col">Received</th>
              </tr>
            </thead>
            <tbody>
              {v.tags.map((t) => (
                <tr key={t.tag} data-testid={`room-tag-${t.tag}`}>
                  <th scope="row">{t.tag}</th>
                  <td>{t.sample ? `${t.sample.value ?? 'no value'} ${t.unit}` : 'No sample'}</td>
                  <td>{t.sample?.raw ?? ''}</td>
                  <td>{t.sample ? `${t.sample.quality} (${t.sample.status})` : ''}</td>
                  <td>{t.receivedAt?.text ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Open alarms</h3>
          {v.openAlarms.length === 0 ? <p>None.</p> : null}
          <ul>
            {v.openAlarms.map((a) => (
              <li key={a.alarmId} data-testid={`room-alarm-${a.alarmId}`}>
                {a.source} {a.alarmCode}: {a.message} at {a.raisedAtSource.text} {a.gmpCritical ? <StatusChip tone="error" label="GMP-critical" /> : null}
              </li>
            ))}
          </ul>
          {v.openAlarms.length > 0 ? <Link to="/alarms">Acknowledge on the alarm list</Link> : null}
        </>
      ) : null}
      <p>
        <Button onPress={() => setSpill(true)}>Record a spill</Button>
      </p>
      {spill ? <SpillDialog code={code} onClose={() => setSpill(false)} /> : null}
    </Section>
  );
}

function SpillDialog({ code, onClose }: { code: string; onClose: () => void }) {
  const record = useCommand(routes.plantRules.recordSpill, ROOM_READS, 'the record of the spill');
  const [description, setDescription] = useState('');
  const [material, setMaterial] = useState('');
  const [batchId, setBatchId] = useState('');
  const ok = description.trim() !== '' && (batchId.trim() === '' || UUID.test(batchId.trim()));
  return (
    <Dialog title={`Record a spill in ${code}`} isOpen onOpenChange={(o) => (o ? undefined : onClose())}>
      <div data-testid="spill-dialog">
        <p>The room needs cleaning (and its verification) before it is used again.</p>
        <Field name="spillDescription" label="What was spilled and where" value={description} onChange={setDescription} isRequired />
        <Field name="spillMaterial" label="Material (optional)" value={material} onChange={setMaterial} />
        <Field name="spillBatch" label="Batch (id, optional)" value={batchId} onChange={setBatchId} />
        <ActButton
          label="Record the spill"
          disabled={!ok || record.busy}
          onPress={async () => {
            if (!ok) return;
            const r = await record.run({
              params: { code },
              body: {
                description: description.trim(),
                ...(material.trim() !== '' ? { material: material.trim() } : {}),
                ...(batchId.trim() !== '' ? { batchId: batchId.trim() } : {}),
              },
            });
            if (r) onClose();
          }}
        />
        <Button onPress={onClose} isDisabled={record.busy}>
          Cancel
        </Button>
        <ActResult error={record.error} done={null} />
      </div>
    </Dialog>
  );
}
