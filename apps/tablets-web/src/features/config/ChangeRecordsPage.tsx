/**
 * Configuration change records (Phase 6 slice 6f; DI-09): raise one naming the configuration areas it may change, have
 * another person of QA approve it through the signature ceremony (CONFIG_CHANGE_ACT), close it when the change is done.
 * A configuration change names an approved, open record covering its area, or the database refuses it.
 */
import { useState } from 'react';
import { routes, type ChangeRecordView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { CONFIG_READS, words } from './reads.ts';

const NUMBER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const UNIT = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;

export function ChangeRecordsPage() {
  const q = useApiQuery(routes.config.changeRecords, { query: {} });
  return (
    <>
      <h1>Configuration change records</h1>
      <p>
        Every configuration change (site values, policies, adapter modes, freshness bounds, review-by-exception rules) is made under an approved change
        record that names its area. The change record is approved by QA with an electronic signature, never by the person who raised it.
      </p>
      <Raise />
      <Section title="Change records" testId="config-change-records">
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        {q.data && q.data.changeRecords.length === 0 ? <p>No change record.</p> : null}
        {q.data?.changeRecords.map((r) => <Record key={r.changeRecordId} r={r} />)}
      </Section>
    </>
  );
}

function Raise() {
  const areas = useApiQuery(routes.config.areas, {});
  const raise = useCommand(routes.config.raiseChangeRecord, CONFIG_READS);
  const [num, setNum] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  // ST-29: left empty unless the firm names the lines for which this change requires an APS (never pre-filled).
  const [aps, setAps] = useState('');
  const apsLines = aps.split(',').map((x) => x.trim()).filter((x) => x !== '');
  const ok = NUMBER.test(num.trim()) && title.trim() !== '' && description.trim() !== '' && chosen.length > 0 && apsLines.every((x) => UNIT.test(x));
  return (
    <Section title="Raise a change record" testId="config-raise">
      <Field name="crNumber" label="Change-record number (e.g. CR-2026-014)" value={num} onChange={setNum} />
      <Field name="crTitle" label="Title" value={title} onChange={setTitle} />
      <Field name="crDescription" label="What changes and why" value={description} onChange={setDescription} />
      <fieldset>
        <legend>Configuration areas it may change</legend>
        {areas.data?.areas.map((a) => (
          <label key={a.code} style={{ display: 'block' }}>
            <input
              type="checkbox"
              name={`area-${a.code}`}
              checked={chosen.includes(a.code)}
              onChange={(e) => setChosen((c) => (e.target.checked ? [...c, a.code] : c.filter((x) => x !== a.code)))}
            />{' '}
            {words(a.code)}: {a.description}
          </label>
        ))}
      </fieldset>
      <Field
        name="crApsLines"
        label="Lines for which this change requires an APS (equipment codes, comma-separated; QA's approval withdraws their qualification)"
        value={aps}
        onChange={setAps}
      />
      <ActButton
        label="Raise the change record"
        onPress={() =>
          ok
            ? raise.run({ body: { number: num.trim(), title: title.trim(), description: description.trim(), areas: chosen, ...(apsLines.length > 0 ? { apsLines } : {}) } })
            : undefined
        }
        disabled={!ok || raise.busy}
      />
      <ActResult error={raise.error} done={raise.done} label="The change record is raised; QA approves it next." />
    </Section>
  );
}

function Record({ r }: { r: ChangeRecordView }) {
  const qa = useOffered('QA');
  const signed = useSignedAct(CONFIG_READS);
  const close = useCommand(routes.config.closeChangeRecord, CONFIG_READS);
  const [note, setNote] = useState('');
  const tone = r.state === 'APPROVED' ? 'ok' : r.state === 'OPEN' ? 'warning' : 'neutral';
  return (
    <article data-testid={`change-record-${r.number}`} data-state={r.state}>
      <h3>
        {r.number} {r.title} <StatusChip tone={tone} label={words(r.state)} />
      </h3>
      <p>{r.description}</p>
      <p>
        Areas: {r.areas.map(words).join(', ')}.{r.apsLines.length > 0 ? ` APS required for: ${r.apsLines.join(', ')}.` : ''} Raised by {r.raisedBy.legalName} at {r.raisedAt.text}
        {r.approvedBy && r.approvedAt ? `; approved by ${r.approvedBy.legalName} at ${r.approvedAt.text}` : ''}
        {r.closedAt ? `; closed at ${r.closedAt.text}` : ''}.
      </p>
      {r.state === 'OPEN' && qa ? (
        <>
          <ActButton label="Approve (signature)" onPress={() => signed.sign({ kind: 'CONFIG_CHANGE_ACT', act: 'APPROVE', number: r.number }, `Approve change record ${r.number}`)} disabled={signed.busy} />
          <ActResult error={signed.error} outcome={signed.outcome} />
        </>
      ) : null}
      {r.state !== 'CLOSED' ? (
        <div>
          <Field name={`crClose-${r.number}`} label="Closing note" value={note} onChange={setNote} />
          <ActButton label="Close" primary={false} onPress={() => (note.trim() !== '' ? close.run({ params: { number: r.number }, body: { note: note.trim() } }) : undefined)} disabled={note.trim() === '' || close.busy} />
          <ActResult error={close.error} done={close.done} label="Closed." />
        </div>
      ) : null}
    </article>
  );
}
