/**
 * Area authorisations in the qualification matrix (PR-15; D-P6b-5): every controlled room or line (and every room with
 * an authorisation type) with each person's record: valid from and to, who recorded it, whether it counts now, and its
 * withdrawal. The training coordinator defines the area's authorisation, records a person (never themselves; the
 * database refuses it) and withdraws a record with the reason. What counts is the database's (iam.person_area_authorised,
 * the function the step guard reads).
 */
import { useState } from 'react';
import { routes, type AreaAuthorisationMatrixView, type AreaAuthorisationRecordView } from '@ebmr/api-contract';
import { Button, Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';

const READS: readonly string[] = [routes.plantRules.areaAuthorisations.id, routes.plantRules.rooms.id];

type Area = AreaAuthorisationMatrixView['areas'][number];

export function AreaAuthorisationsPage() {
  const q = useApiQuery(routes.plantRules.areaAuthorisations, {});
  return (
    <>
      <h1>Area authorisations</h1>
      <p>
        The qualification matrix of the controlled areas: only a person with a current authorisation may start or sign a step there. An
        authorisation is recorded by the training coordinator, valid from the moment it is recorded, and withdrawn with a reason.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data ? <p data-testid="area-auth-read-at">As read at {q.data.readAt.text}.</p> : null}
      {q.data && q.data.areas.length === 0 ? <p>No controlled area.</p> : null}
      {q.data?.areas.map((a) => <AreaSection key={a.code} a={a} />)}
    </>
  );
}

function AreaSection({ a }: { a: Area }) {
  const define = useCommand(routes.plantRules.createAreaAuthorisation, READS, 'the area authorisation');
  const record = useCommand(routes.plantRules.recordAreaAuthorisation, READS, 'the area authorisation of the person');
  const [login, setLogin] = useState('');
  const [validTo, setValidTo] = useState('');
  const to = validTo.trim();
  const toOk = to === '' || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/.test(to);
  return (
    <Section title={`${a.code}: ${a.name}`} testId={`area-auth-${a.code}`}>
      <p>
        {a.authorisationRequired ? <StatusChip tone="warning" label="Controlled area" /> : <StatusChip tone="neutral" label="Not controlled now" />} Authorisation{' '}
        {a.qualificationCode}
      </p>
      {a.typeDefined ? null : (
        <p>
          The authorisation of this area is not defined yet.{' '}
          <ActButton label="Define the authorisation" disabled={define.busy} onPress={() => define.run({ body: { area: a.code, name: a.name } })} />
          <ActResult error={define.error} done={null} />
        </p>
      )}
      {a.records.length === 0 ? <p>Nobody is recorded.</p> : null}
      {a.records.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Valid from</th>
              <th scope="col">Valid to</th>
              <th scope="col">Recorded by</th>
              <th scope="col">Now</th>
              <th scope="col">Withdrawal</th>
            </tr>
          </thead>
          <tbody>
            {a.records.map((r) => (
              <RecordRow key={r.recordId} r={r} />
            ))}
          </tbody>
        </table>
      ) : null}
      {a.typeDefined ? (
        <div data-testid={`area-auth-record-${a.code}`}>
          <h3>Record a person</h3>
          <Field name={`areaAuthLogin-${a.code}`} label="User id of the person" value={login} onChange={setLogin} isRequired />
          <Field name={`areaAuthTo-${a.code}`} label="Valid to (optional, e.g. 2027-10-13T18:00:00+05:30)" value={validTo} onChange={setValidTo} />
          <ActButton
            label="Record the authorisation"
            disabled={login.trim() === '' || !toOk || record.busy}
            onPress={async () => {
              const r = await record.run({ params: { code: a.code }, body: { loginName: login.trim(), ...(to !== '' ? { validTo: to } : {}) } });
              if (r) {
                setLogin('');
                setValidTo('');
              }
            }}
          />
          <ActResult error={record.error} done={null} />
        </div>
      ) : null}
    </Section>
  );
}

function RecordRow({ r }: { r: AreaAuthorisationRecordView }) {
  const withdraw = useCommand(routes.plantRules.withdrawAreaAuthorisation, READS, 'the withdrawal');
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState('');
  return (
    <tr data-testid={`area-auth-row-${r.recordId}`} data-current={String(r.current)}>
      <th scope="row">
        {r.person.legalName} ({r.person.loginName})
      </th>
      <td>{r.validFrom.text}</td>
      <td>{r.validTo ? r.validTo.text : 'Open-ended'}</td>
      <td>
        {r.recordedBy.legalName} at {r.recordedAt.text} ({r.source === 'INTERNAL' ? 'recorded here' : `from ${r.source}`})
      </td>
      <td>{r.current ? <StatusChip tone="ok" label="Authorised" /> : <StatusChip tone="error" label="Not authorised" />}</td>
      <td>
        {r.withdrawnAt ? (
          `Withdrawn at ${r.withdrawnAt.text}: ${r.withdrawalReason ?? ''}`
        ) : open ? (
          <>
            <Field name={`areaAuthWhy-${r.recordId}`} label="Reason for the withdrawal" value={why} onChange={setWhy} isRequired />
            <ActButton
              label="Withdraw"
              disabled={why.trim() === '' || withdraw.busy}
              onPress={async () => {
                if (await withdraw.run({ params: { recordId: r.recordId }, body: { reason: why.trim() } })) setOpen(false);
              }}
            />
            <Button onPress={() => setOpen(false)} isDisabled={withdraw.busy}>
              Cancel
            </Button>
            <ActResult error={withdraw.error} done={null} />
          </>
        ) : (
          <Button onPress={() => setOpen(true)}>Withdraw…</Button>
        )}
      </td>
    </tr>
  );
}
