/**
 * Issue a test batch (module C4; plan section 12, screen 12): approved batch sizes only (PR-01), markets (those
 * set by the MBR are fixed), variants, and the header inputs with their sources (e.g. tabletsPerBatch, a whole
 * number sent as text). The server allocates the TEST- batch number and pins engine, registry and policy.
 * Nothing is pre-selected except the markets the MBR fixes.
 */
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { routes, type DataValueWire } from '@ebmr/api-contract';
import { Banner, Button, DecimalField, decimalProblem, Field, floor } from '@ebmr/ui-kit';
import { Checkbox } from 'react-aria-components';
import { useApiQuery } from '../../../api/hooks.ts';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { wcls } from '../classes.ts';
import { useRouteParams } from '../params.ts';
import { EntryStatus } from '../components/EntryStatus.tsx';
import { st } from '../text.ts';
import { useLeaveGuard } from '../unsettled.ts';
import { usePendingCall } from '../usePendingCall.ts';

type IssueForm = NonNullable<ReturnType<typeof useApiQuery<typeof routes.execution.issueForm>>['data']>;
type Input = IssueForm['inputs'][number];

const INTEGER = /^(0|[1-9][0-9]*)$/;

/** The value of one header input as it travels, or null while incomplete (decimals and counts stay text). */
export function inputValue(input: Input, text: string): DataValueWire | null {
  const v = text.trim();
  if (v === '') return null;
  switch (input.valueType) {
    case 'DECIMAL':
      return input.unit && decimalProblem(v) === null ? { kind: 'DECIMAL', value: v, unit: input.unit } : null;
    case 'COUNT':
      return INTEGER.test(v) ? { kind: 'COUNT', value: v } : null;
    case 'BOOLEAN':
      return v === 'YES' || v === 'NO' ? { kind: 'BOOLEAN', value: v === 'YES' } : null;
    case 'CATEGORY':
      return { kind: 'CATEGORY', value: v };
    default:
      return { kind: 'TEXT', value: v };
  }
}

function IssueFormBody({ packageId, form }: { packageId: string; form: IssueForm }) {
  const navigate = useNavigate();
  const [size, setSize] = useState<string | null>(null);
  const [markets, setMarkets] = useState<string[]>(() => form.markets.filter((m) => m.locked).map((m) => m.code));
  const [variants, setVariants] = useState<Record<string, string>>({});
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const issue = usePendingCall(routes.execution.issue, {}, {
    reason: st('tap.reason.issue'),
    onSaved: (run) => navigate({ to: '/runs/$runId', params: { runId: run.header.runId } }),
  });
  const values: Record<string, DataValueWire> = {};
  let complete = size !== null && markets.length > 0 && form.variants.every((v) => variants[v.id]);
  for (const i of form.inputs) {
    const v = inputValue(i, inputs[i.id] ?? '');
    if (v) values[i.id] = v;
    else if (i.required) complete = false;
  }
  const unsettled = issue.busy || issue.state === 'notSaved';
  const submit = () => {
    if (!complete || size === null) return;
    const chosen = form.batchSizes.find((b) => b.id === size);
    issue.submit({ packageId, batchSize: size, markets, variants, inputs: values }, `Issue a test batch of ${form.product.name}, ${chosen?.label ?? size}`);
  };
  return (
    <>
      <p className={wcls('muted')}>{st('issue.allocated')}</p>
      <floor.ChoiceGroup label={st('issue.size')} options={form.batchSizes.map((b) => ({ value: b.id, label: `${b.label} (${b.quantity} ${b.unit})` }))} value={size} onChange={setSize} isDisabled={unsettled} />
      <fieldset className={wcls('section')}>
        <legend>{st('issue.markets')}</legend>
        <div className={wcls('row')}>
          {form.markets.map((m) => (
            <Checkbox
              key={m.code}
              isSelected={markets.includes(m.code)}
              isDisabled={m.locked || unsettled}
              onChange={(on) => setMarkets((cur) => (on ? [...cur, m.code] : cur.filter((c) => c !== m.code)))}
              className={wcls('link')}
            >
              {m.locked ? st('issue.lockedMarket', { code: m.code }) : m.code} {markets.includes(m.code) ? '✓' : ''}
            </Checkbox>
          ))}
        </div>
      </fieldset>
      {form.variants.map((v) => (
        <floor.ChoiceGroup
          key={v.id}
          label={st('issue.variant', { name: v.name })}
          options={v.options.map((o) => ({ value: o, label: o }))}
          value={variants[v.id] ?? null}
          onChange={(o) => setVariants((cur) => ({ ...cur, [v.id]: o }))}
          isDisabled={unsettled}
        />
      ))}
      {form.inputs.length > 0 ? <h2 className={wcls('sectionTitle')}>{st('issue.inputs')}</h2> : null}
      {form.inputs.map((i) =>
        i.valueType === 'DECIMAL' || i.valueType === 'COUNT' ? (
          <DecimalField
            key={i.id}
            name={i.id}
            label={i.name}
            unit={i.unit ?? ''}
            value={inputs[i.id] ?? ''}
            onChange={(v) => setInputs((cur) => ({ ...cur, [i.id]: v }))}
            {...(i.valueType === 'COUNT' ? { maxDecimals: 0 } : {})}
            description={st('issue.source', { source: i.source })}
            isDisabled={unsettled}
          />
        ) : i.valueType === 'BOOLEAN' ? (
          <floor.ChoiceGroup
            key={i.id}
            label={i.name}
            options={[
              { value: 'YES', label: floor.ft('checklist.answer.YES') },
              { value: 'NO', label: floor.ft('checklist.answer.NO') },
            ]}
            value={inputs[i.id] ?? null}
            onChange={(v) => setInputs((cur) => ({ ...cur, [i.id]: v }))}
            description={st('issue.source', { source: i.source })}
            isDisabled={unsettled}
          />
        ) : (
          <Field
            key={i.id}
            name={i.id}
            label={i.name}
            value={inputs[i.id] ?? ''}
            onChange={(v) => setInputs((cur) => ({ ...cur, [i.id]: v }))}
            description={st('issue.source', { source: i.source })}
            isDisabled={unsettled}
            autoComplete="off"
          />
        ),
      )}
      {!complete ? <p className={wcls('muted')}>{st('issue.incomplete')}</p> : null}
      <Button variant="primary" className={wcls('saveButton')} onPress={submit} isDisabled={!complete || unsettled}>
        {st('issue.submit')}
      </Button>
      <EntryStatus call={issue} />
    </>
  );
}

export function IssueFormPage() {
  const params = useRouteParams();
  const packageId = params['packageId'] ?? '';
  const form = useApiQuery(routes.execution.issueForm, { params: { packageId } });
  const held = useLeaveGuard();
  return (
    <>
      <h1>{st('issue.title')}</h1>
      {held ? <Banner tone="warning" title={st('leave.held')} /> : null}
      {form.isPending ? <p>{st('loading')}</p> : null}
      {form.error ? <RefusalMessage error={form.error.error} /> : null}
      {form.data ? (
        <>
          <p>
            <strong>{form.data.product.name}</strong>
          </p>
          <IssueFormBody packageId={packageId} form={form.data} />
        </>
      ) : null}
    </>
  );
}
