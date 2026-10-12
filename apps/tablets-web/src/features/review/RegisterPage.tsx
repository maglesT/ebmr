/**
 * The exception register of a batch record in review (Phase 4 slice 1; PR-52, DI-26, outline 7.3). Showing the register
 * is recorded by the server (review.register: grouped acceptance needs a showing of the full list after the last item);
 * opening an item's detail is recorded too (review.openItem: a critical item is dispositioned only after its detail was
 * opened). The reviewer moves through the items that still need QA with the keyboard (N: next, P: previous), each
 * opening its detail.
 *
 * Dispositions are signed acts (REVIEW_ACT DISPOSE_ITEM): Accept, Query (production answers) or Escalate to a
 * deviation, one item at a time; non-critical items may also be accepted together with one justification. Critical
 * items are never offered for grouped acceptance. The aggregate a disposition signs is the database's
 * (recipe.review_items_aggregate_id through esig.describe); every refusal is shown in the server's words.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type CallError, type ItemDetailView, type RegisterView, type ReviewItemView } from '@ebmr/api-contract';
import { Banner, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { api } from '../../api/client.ts';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { useRouteParams } from '../floor/params.ts';
import { REVIEW_READS, words } from './reads.ts';

/** Items that still need QA: open, or answered by production. */
export const needsQa = (i: ReviewItemView): boolean => i.reviewStatus === 'OPEN' || i.reviewStatus === 'RESPONDED';

/** The next (or previous) item that still needs QA after `current`, wrapping round; null when none does. */
export function nextItem(items: readonly ReviewItemView[], current: string | null, step: 1 | -1): string | null {
  const due = items.filter(needsQa);
  if (due.length === 0) return null;
  const n = items.length;
  const at = items.findIndex((i) => i.exceptionId === current);
  const start = at >= 0 ? at : step === 1 ? -1 : n;
  for (let k = 1; k <= n; k += 1) {
    const i = items[(((start + step * k) % n) + n) % n];
    if (i && needsQa(i)) return i.exceptionId;
  }
  return null;
}

const statusTone = (s: ReviewItemView['reviewStatus']) => (s === 'ACCEPTED' ? 'ok' : s === 'ESCALATED' ? 'error' : s === 'QUERIED' ? 'pending' : 'warning');

export function RegisterPage() {
  const batchId = useRouteParams()['batchId'] ?? '';
  const batch = useApiQuery(routes.review.batch, { params: { batchId } });
  const [register, setRegister] = useState<RegisterView | null>(null);
  const [error, setError] = useState<CallError | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // The showing is the person's own recorded act; it is repeated after every disposition (the server's list is shown).
  const show = useCallback(async () => {
    const r = await api.call(routes.review.register, { params: { batchId }, body: {} });
    if (r.ok) {
      setRegister(r.value);
      setError(null);
    } else setError(r.error);
  }, [batchId]);
  useEffect(() => {
    void show();
  }, [show]);

  const items = register?.items ?? [];
  const move = useCallback((step: 1 | -1) => setSelected((cur) => nextItem(items, cur, step) ?? cur), [items]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key === 'n' || e.key === 'N' || e.key === 'j') {
        e.preventDefault();
        move(1);
      } else if (e.key === 'p' || e.key === 'P' || e.key === 'k') {
        e.preventDefault();
        move(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move]);

  const number = batch.data?.batchNumber ?? batchId;
  const current = items.find((i) => i.exceptionId === selected) ?? null;
  return (
    <>
      <h1>Exception register of batch {number}</h1>
      <p>
        <Link to="/review/$batchId" params={{ batchId }}>
          Back to the review of the record
        </Link>
      </p>
      {error ? <RefusalMessage error={error} /> : null}
      {register ? (
        <p data-testid="register-summary">
          {register.noExceptions ? 'The record has no exception.' : `${items.length} items (${Object.entries(register.byCategory).map(([c, n]) => `${words(c)} ${n}`).join(', ')}); ${items.filter(needsQa).length} need QA.`} List shown to you {register.shownAt.text}.
        </p>
      ) : null}
      <p id="register-keys">Press N for the next item that needs QA and P for the previous one; each opens the item's detail.</p>
      <ActButton primary={false} label="Next item (N)" onPress={() => move(1)} disabled={items.filter(needsQa).length === 0} />
      <ol aria-label="Exception register" aria-describedby="register-keys" data-testid="register-items">
        {items.map((i) => (
          <li key={i.exceptionId} data-testid={`item-${i.exceptionId}`} aria-current={i.exceptionId === selected ? 'true' : undefined}>
            <button type="button" onClick={() => setSelected(i.exceptionId)} aria-pressed={i.exceptionId === selected}>
              {i.exceptionId}
            </button>{' '}
            {i.title} ({words(i.type)}, {i.severity}
            {i.stepKey ? `, step ${i.stepKey}` : ''}) {i.critical ? <StatusChip tone="error" label="Critical" /> : null} <StatusChip tone={statusTone(i.reviewStatus)} label={words(i.reviewStatus)} />
            {i.engineDisposition ? ` · on the floor: ${words(i.engineDisposition.outcome)} by ${i.engineDisposition.by.legalName}` : ''}
            {i.deviationRef ? ` · deviation ${i.deviationRef}` : ''}
            {i.pausedStep ? ' · reviewed on its own (paused step)' : ''}
          </li>
        ))}
      </ol>
      {current ? <ItemDetail key={current.exceptionId} batchId={batchId} batchNumber={number} item={current} onChanged={show} /> : null}
      <GroupedAcceptance batchId={batchId} batchNumber={number} items={items} onChanged={show} />
    </>
  );
}

function ItemDetail({ batchId, batchNumber, item, onChanged }: { batchId: string; batchNumber: string; item: ReviewItemView; onChanged: () => Promise<void> }) {
  const [detail, setDetail] = useState<ItemDetailView | null>(null);
  const [error, setError] = useState<CallError | null>(null);
  const opened = useCallback(async () => {
    const r = await api.call(routes.review.openItem, { params: { batchId, exceptionId: item.exceptionId }, body: {} });
    if (r.ok) setDetail(r.value);
    else setError(r.error);
  }, [batchId, item.exceptionId]);
  useEffect(() => {
    // The opening is recorded by the server (a critical item is dispositioned only after it).
    // Once per item shown; the register is shown again after the opening (its detail-opened mark is the server's).
    void opened().then(onChanged);
  }, [opened, onChanged]);
  return (
    <Section title={`Item ${item.exceptionId}: ${item.title}`} testId="item-detail">
      {error ? <RefusalMessage error={error} /> : null}
      {detail ? (
        <>
          <p>
            Raised {detail.item.raisedAt.text}; detail opened {detail.openedAt.text}.
          </p>
          <dl data-testid="raised-record">
            {Object.entries(detail.raisedRecord).map(([k, v]) => (
              <div key={k}>
                <dt>{words(k)}</dt>
                <dd>{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
          {detail.acts.length > 0 ? (
            <ul aria-label="What was done on the item">
              {detail.acts.map((a, n) => (
                <li key={n}>
                  {words(a.act)} by {a.by.legalName}, {a.at.text}
                  {a.note ? `: ${a.note}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      <Respond batchId={batchId} item={item} onChanged={onChanged} />
      <Disposition batchId={batchId} batchNumber={batchNumber} item={item} onChanged={onChanged} />
    </Section>
  );
}

function Respond({ batchId, item, onChanged }: { batchId: string; item: ReviewItemView; onChanged: () => Promise<void> }) {
  const production = useOffered('PRODUCTION_HEAD');
  const [text, setText] = useState('');
  const respond = useCommand(routes.review.respond, REVIEW_READS);
  if (!production || item.reviewStatus !== 'QUERIED') return null;
  return (
    <div data-testid="respond">
      <Field name="response" label="Production's answer to the query" value={text} onChange={setText} />
      <ActButton
        label="Send the answer"
        onPress={async () => {
          if (await respond.run({ params: { batchId, exceptionId: item.exceptionId }, body: { text: text.trim() } })) await onChanged();
        }}
        disabled={text.trim() === '' || respond.busy}
      />
      <ActResult error={respond.error} done={respond.done} label="Answer sent." />
    </div>
  );
}

const DISPOSITIONS = [
  { value: 'ACCEPT', label: 'Accept' },
  { value: 'QUERY', label: 'Query (production answers)' },
  { value: 'ESCALATE', label: 'Escalate to a deviation' },
] as const;
type Disp = (typeof DISPOSITIONS)[number]['value'];

function Disposition({ batchId, batchNumber, item, onChanged }: { batchId: string; batchNumber: string; item: ReviewItemView; onChanged: () => Promise<void> }) {
  const qa = useOffered('QA');
  const [disposition, setDisposition] = useState<Disp | null>(null);
  const [justification, setJustification] = useState('');
  const [deviationRef, setDeviationRef] = useState(item.deviationRef ?? '');
  const signed = useSignedAct(REVIEW_READS);
  if (!qa || !needsQa(item)) return null;
  const j = justification.trim();
  const ready = disposition !== null && j !== '' && (disposition !== 'ESCALATE' || deviationRef.trim() !== '');
  const label = disposition === 'QUERY' ? 'Query to production' : disposition === 'ESCALATE' ? 'Reason for the escalation' : 'Justification';
  const sign = async () => {
    if (!disposition) return;
    const o = await signed.sign(
      { kind: 'REVIEW_ACT', act: 'DISPOSE_ITEM', batchId, input: { items: [item.exceptionId], disposition, justification: j, ...(disposition === 'ESCALATE' ? { deviationRef: deviationRef.trim() } : {}) } },
      `${DISPOSITIONS.find((d) => d.value === disposition)?.label ?? disposition} item ${item.exceptionId} of batch ${batchNumber}: ${j}`,
    );
    if (o !== 'CANCELLED') await onChanged();
  };
  return (
    <div data-testid="item-disposition">
      {item.critical && !item.detailOpened ? <Banner tone="info" title="A critical item is dispositioned on its own, once its detail has been opened." /> : null}
      <floor.ChoiceGroup label="Disposition" options={DISPOSITIONS.map((d) => ({ value: d.value, label: d.label }))} value={disposition} onChange={(v) => setDisposition(DISPOSITIONS.find((d) => d.value === v)?.value ?? null)} />
      <Field name="justification" label={label} value={justification} onChange={setJustification} />
      {disposition === 'ESCALATE' ? <Field name="deviationRef" label="Deviation record" value={deviationRef} onChange={setDeviationRef} description="The deviation-lite record linked to the batch" /> : null}
      <ActButton label={`Sign the disposition of ${item.exceptionId}`} onPress={sign} disabled={!ready || signed.busy} />
      <ActResult error={signed.error} outcome={signed.outcome} />
    </div>
  );
}

function GroupedAcceptance({ batchId, batchNumber, items, onChanged }: { batchId: string; batchNumber: string; items: readonly ReviewItemView[]; onChanged: () => Promise<void> }) {
  const qa = useOffered('QA');
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [justification, setJustification] = useState('');
  const signed = useSignedAct(REVIEW_READS);
  // Critical items and items of a paused step are never accepted in a group (PR-52, PR-07).
  const eligible = items.filter((i) => !i.critical && !i.pausedStep && needsQa(i));
  if (!qa || eligible.length < 2) return null;
  const picked = eligible.filter((i) => chosen.includes(i.exceptionId)).map((i) => i.exceptionId);
  const j = justification.trim();
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const sign = async () => {
    const o = await signed.sign(
      { kind: 'REVIEW_ACT', act: 'DISPOSE_ITEM', batchId, input: { items: picked, disposition: 'ACCEPT', justification: j } },
      `Accept ${picked.length} non-critical items of batch ${batchNumber} together (${picked.join(', ')}): ${j}`,
    );
    if (o !== 'CANCELLED') {
      setChosen([]);
      await onChanged();
    }
  };
  return (
    <Section title="Accept non-critical items together" testId="grouped-acceptance">
      <p>One justification for every item chosen; critical items are dispositioned one by one.</p>
      <fieldset>
        <legend>Items to accept</legend>
        {eligible.map((i) => (
          <label key={i.exceptionId} style={{ display: 'block' }}>
            <input type="checkbox" checked={chosen.includes(i.exceptionId)} onChange={() => toggle(i.exceptionId)} /> {i.exceptionId} {i.title}
            {i.group ? ` (group ${i.group})` : ''}
          </label>
        ))}
      </fieldset>
      <Field name="groupJustification" label="Justification for the group" value={justification} onChange={setJustification} />
      <ActButton label={`Accept the ${picked.length} items chosen`} onPress={sign} disabled={picked.length < 2 || j === '' || signed.busy} />
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}
