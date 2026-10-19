/**
 * Rooms and lines (PR-15, PR-25, PR-27; DI-32, DI-49): each with its cleaning state, clean-hold time, controlled-area
 * flag and open spills; per room its latest temperature and humidity from the EMS (raw value, status, received time) and
 * its open alarms, and the record of a spill (the room is then CLEANING_REQUIRED until a verified cleaning).
 * Slice 7g-5: a new version of a room's rules (controlled area, clean-hold time; plantRules.setRoomRule) and the
 * adjacency and segregation of rooms and lines (plantRules.adjacencies, defineAdjacency; PR-35), by the master-data
 * steward (MASTERDATA.CHANGE), each with its reason.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type RoomStateView } from '@ebmr/api-contract';
import { Button, Dialog, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { useOffered } from '../../app/roles.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { PLANT_CODE, ROOM_READS, words } from './reads.ts';
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
      {room ? <RoomConditions code={room} rule={q.data?.rooms.find((r) => r.code === room) ?? null} /> : null}
      <Adjacencies />
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

function RoomConditions({ code, rule }: { code: string; rule: RoomStateView | null }) {
  const q = useApiQuery(routes.plantRules.roomConditions, { params: { code } });
  const steward = useOffered('PLANT_MASTER');
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
      {steward && rule ? <RoomRule key={`${code}-${rule.ruleVersion ?? ''}`} r={rule} /> : null}
    </Section>
  );
}

const WHOLE = /^(0|[1-9][0-9]{0,17})$/;

/** A new version of the room's rules (plantRules.setRoomRule; MASTERDATA.CHANGE): controlled area and clean-hold time. */
function RoomRule({ r }: { r: RoomStateView }) {
  const set = useCommand(routes.plantRules.setRoomRule, ROOM_READS, 'the room rule');
  const [controlled, setControlled] = useState(r.authorisationRequired ? 'YES' : 'NO');
  const [seconds, setSeconds] = useState(r.cleanHoldSeconds ?? '');
  const [reason, setReason] = useState('');
  const h = seconds.trim();
  const ok = (h === '' || WHOLE.test(h)) && reason.trim() !== '';
  return (
    <div data-testid="room-rule">
      <h3>{`Rules of ${r.code}`}{r.ruleVersion ? ` (version ${r.ruleVersion})` : ''}</h3>
      <floor.ChoiceGroup
        label="Controlled area (work needs an area authorisation)"
        options={[
          { value: 'YES', label: 'Controlled' },
          { value: 'NO', label: 'Not controlled' },
        ]}
        value={controlled}
        onChange={setControlled}
      />
      <Field name="ruleHoldSeconds" label="Clean-hold time in seconds (e.g. 259200 for 72 h; blank: none)" value={seconds} onChange={setSeconds} />
      <Field name="ruleReason" label="Reason for the change" value={reason} onChange={setReason} />
      <ActButton
        label={`Save the rules of ${r.code}`}
        disabled={!ok || set.busy}
        onPress={() =>
          ok ? set.run({ params: { code: r.code }, body: { authorisationRequired: controlled === 'YES', cleanHoldSeconds: h === '' ? null : h, reason: reason.trim() } }) : null
        }
      />
      <ActResult error={set.error} done={set.done} label="A new version of the rules is in force." />
    </div>
  );
}

/** The adjacency and segregation of each pair of rooms or lines (PR-35), and a new version of one pair. */
function Adjacencies() {
  const q = useApiQuery(routes.plantRules.adjacencies);
  const steward = useOffered('PLANT_MASTER');
  const define = useCommand(routes.plantRules.defineAdjacency, [routes.plantRules.adjacencies.id], 'the adjacency');
  const [one, setOne] = useState('');
  const [two, setTwo] = useState('');
  const [adjacent, setAdjacent] = useState('YES');
  const [segregated, setSegregated] = useState('NO');
  const [why, setWhy] = useState('');
  const a = one.trim().toUpperCase();
  const b = two.trim().toUpperCase();
  const ok = PLANT_CODE.test(a) && PLANT_CODE.test(b) && a !== b && (segregated === 'NO' || why.trim() !== '');
  return (
    <Section title="Adjacency and segregation" testId="adjacencies">
      <p>Lines and rooms next to each other run only products that may share the space, unless they are segregated with a justification.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.adjacencies.length === 0 ? <p>No adjacency is recorded.</p> : null}
      <ul>
        {q.data?.adjacencies.map((x) => (
          <li key={`${x.one}-${x.two}`} data-testid={`adjacency-${x.one}-${x.two}`}>
            {x.one} and {x.two}: {x.adjacent ? 'adjacent' : 'not adjacent'}, {x.segregated ? `segregated (${x.justification ?? ''})` : 'not segregated'} · version {x.version}, {x.recordedAt.text}
          </li>
        ))}
      </ul>
      {steward ? (
        <>
          <h3>Record a pair</h3>
          <Field name="adjOne" label="First room or line" value={one} onChange={setOne} />
          <Field name="adjTwo" label="Second room or line" value={two} onChange={setTwo} />
          <floor.ChoiceGroup label="Adjacent" options={[{ value: 'YES', label: 'Adjacent' }, { value: 'NO', label: 'Not adjacent' }]} value={adjacent} onChange={setAdjacent} />
          <floor.ChoiceGroup label="Segregated" options={[{ value: 'YES', label: 'Segregated' }, { value: 'NO', label: 'Not segregated' }]} value={segregated} onChange={setSegregated} />
          <Field name="adjJustification" label="Justification of the segregation" value={why} onChange={setWhy} />
          <ActButton
            label="Record the adjacency"
            disabled={!ok || define.busy}
            onPress={() => (ok ? define.run({ body: { one: a, two: b, adjacent: adjacent === 'YES', segregated: segregated === 'YES', ...(why.trim() ? { justification: why.trim() } : {}) } }) : null)}
          />
          <ActResult error={define.error} done={define.done} label="Recorded." />
        </>
      ) : null}
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
