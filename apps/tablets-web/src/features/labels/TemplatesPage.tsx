/**
 * Label templates (Phase 6 slice 6c; IN-31, D-P6c-2): the template designer and the approval. A template holds layout
 * and bindings to record fields only (no value is typed on a template); a second person approves it. Why a draft cannot
 * be approved (an India particular missing, the manufacturing date among them) is the database's words. One version
 * opens in detail (labels.template; slice 7g-5): its size and where each record field is placed, as the database holds
 * them now.
 */
import { useState } from 'react';
import { LABEL_BINDINGS, routes, type LabelTemplateView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { LABEL_READS, words } from './reads.ts';

type Binding = (typeof LABEL_BINDINGS)[number];
const MM = /^(0|[1-9][0-9]{0,3})(\.[0-9])?$/;

export function TemplatesPage() {
  const q = useApiQuery(routes.labels.templates, { query: {} });
  return (
    <>
      <h1>Label templates</h1>
      <p>
        A label template places record fields on the label. Every value comes from the batch record when the label is printed; no value is typed on a
        template. A template for India must place every India particular, the manufacturing date among them, before it can be approved.
      </p>
      <Designer />
      <Section title="Templates" testId="label-templates">
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        {q.data && q.data.templates.length === 0 ? <p>No template yet.</p> : null}
        <ul>
          {q.data?.templates.map((t) => <TemplateRow key={t.templateId} t={t} />)}
        </ul>
      </Section>
    </>
  );
}

function TemplateRow({ t }: { t: LabelTemplateView }) {
  const approver = useOffered('QA');
  const approve = useCommand(routes.labels.approveTemplate, LABEL_READS);
  return (
    <li data-testid={`label-template-${t.ref}`} data-status={t.status}>
      <strong>{t.ref}</strong> {words(t.scope)} for {t.markets.join(', ')}: {t.fields.map(words).join(', ')}{' '}
      <StatusChip tone={t.status === 'APPROVED' ? 'ok' : t.status === 'DRAFT' ? 'warning' : 'neutral'} label={words(t.status)} /> designed by {t.createdBy}
      {t.approvedBy ? `, approved by ${t.approvedBy}` : ''}
      {t.approvalProblem ? (
        <p data-testid={`label-template-problem-${t.ref}`}>Cannot be approved: {t.approvalProblem}</p>
      ) : null}
      <TemplateDetail templateId={t.templateId} ref_={t.ref} />
      {approver && t.status === 'DRAFT' ? (
        <>
          <ActButton label={`Approve ${t.ref}`} onPress={() => approve.run({ params: { templateId: t.templateId }, body: {} })} disabled={approve.busy || t.approvalProblem !== null} />
          <ActResult error={approve.error} done={approve.done} label="The template is approved." />
        </>
      ) : null}
    </li>
  );
}

/** One template version in detail, read when opened (labels.template). */
function TemplateDetail({ templateId, ref_ }: { templateId: string; ref_: string }) {
  const [open, setOpen] = useState(false);
  const q = useApiQuery(routes.labels.template, { params: { templateId } }, { enabled: open });
  return (
    <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} data-testid={`label-template-detail-${ref_}`}>
      <summary style={{ minHeight: '2.75rem', paddingBlock: '0.65rem', cursor: 'pointer', boxSizing: 'border-box' }}>{`Layout of ${ref_}`}</summary>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data ? (
        <>
          <p>
            {q.data.layout.width} mm by {q.data.layout.height} mm, version {q.data.version} ({words(q.data.status)}).
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Record field</th>
                <th scope="col">x (mm)</th>
                <th scope="col">y (mm)</th>
              </tr>
            </thead>
            <tbody>
              {q.data.layout.elements.map((e, i) => (
                <tr key={`${e.field}-${i.toString()}`}>
                  <th scope="row">{words(e.field)}</th>
                  <td>{e.x}</td>
                  <td>{e.y}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </details>
  );
}

interface Element {
  field: Binding | null;
  x: string;
  y: string;
}

function Designer() {
  const designer = useOffered('FORMULA_AUTHOR');
  const create = useCommand(routes.labels.createTemplate, LABEL_READS);
  const bindings = useApiQuery(routes.labels.bindings, {});
  const [code, setCode] = useState('');
  const [india, setIndia] = useState(true);
  const [markets, setMarkets] = useState('IN');
  const [width, setWidth] = useState('80');
  const [height, setHeight] = useState('50');
  const [elements, setElements] = useState<Element[]>([{ field: null, x: '2', y: '2' }]);
  if (!designer) return null;
  const marketList = markets.split(/[ ,]+/).map((m) => m.trim().toUpperCase()).filter((m) => m !== '');
  const missing = india ? (bindings.data?.bindings ?? []).filter((b) => b.indiaRequired && !elements.some((e) => e.field === b.code)).map((b) => b.code) : [];
  const ok = /^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(code) && marketList.length > 0 && marketList.every((m) => /^[A-Z]{2}$/.test(m)) && /^[1-9][0-9]{0,3}$/.test(width) && /^[1-9][0-9]{0,3}$/.test(height)
    && elements.length > 0 && elements.every((e) => e.field !== null && MM.test(e.x) && MM.test(e.y));
  const set = (i: number, patch: Partial<Element>) => setElements(elements.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <Section title="Design a template" testId="label-designer">
      <Field name="labelCode" label="Template code" value={code} onChange={(v) => setCode(v.toUpperCase())} />
      <floor.ChoiceGroup
        label="Scope"
        options={[{ value: 'INDIA_DOMESTIC', label: 'India domestic' }, { value: 'EXPORT', label: 'Export' }]}
        value={india ? 'INDIA_DOMESTIC' : 'EXPORT'}
        onChange={(v) => setIndia(v === 'INDIA_DOMESTIC')}
      />
      <Field name="labelMarkets" label="Markets (two-letter codes)" value={markets} onChange={setMarkets} />
      <Field name="labelWidth" label="Width (mm)" value={width} onChange={setWidth} />
      <Field name="labelHeight" label="Height (mm)" value={height} onChange={setHeight} />
      {elements.map((e, i) => (
        <fieldset key={i} data-testid={`label-element-${i.toString()}`}>
          <legend>Element {(i + 1).toString()}</legend>
          <floor.ChoiceGroup label={`Record field of element ${(i + 1).toString()}`} options={LABEL_BINDINGS.map((b) => ({ value: b, label: words(b) }))} value={e.field} onChange={(v) => set(i, { field: LABEL_BINDINGS.find((b) => b === v) ?? null })} />
          <Field name={`labelX${i.toString()}`} label={`x of element ${(i + 1).toString()} (mm)`} value={e.x} onChange={(v) => set(i, { x: v })} />
          <Field name={`labelY${i.toString()}`} label={`y of element ${(i + 1).toString()} (mm)`} value={e.y} onChange={(v) => set(i, { y: v })} />
        </fieldset>
      ))}
      <ActButton label="Add an element" primary={false} onPress={() => setElements([...elements, { field: null, x: '2', y: String(2 + elements.length * 5) }])} disabled={elements.length >= 40} />
      {missing.length > 0 ? <p data-testid="label-designer-missing">Not placed yet (an India label needs them): {missing.map(words).join(', ')}</p> : null}
      <ActButton
        label="Save the template version"
        onPress={() =>
          ok
            ? create.run({ body: { code, scope: india ? 'INDIA_DOMESTIC' : 'EXPORT', markets: marketList, layout: { width, height, elements: elements.map((e) => ({ field: e.field as Binding, x: e.x, y: e.y })) } } })
            : undefined
        }
        disabled={!ok || create.busy}
      />
      <ActResult error={create.error} done={create.done} label="The template version is saved as a draft." />
    </Section>
  );
}
