/**
 * The labelling declaration of a packaging master version (slice 7g WP3, decision 0025; PR-36, IN-31): each printed
 * item of a step with its form and its approved label template, and for a cut label the 211.122(g) option (paraphrased:
 * dedicated lines, a 100 % electronic or a verified 100 % visual examination, or a technique that physically prevents
 * mislabelling). The page shows why the master would fail approval on its labelling; the database decides.
 */
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { Field, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { words } from './reads.ts';

const FORMS = ['CUT_LABEL', 'ROLL_LABEL', 'CARTON', 'LEAFLET', 'FOIL', 'OTHER'] as const;
const OPTIONS = ['DEDICATED_LINES', 'ELECTRONIC_100', 'VISUAL_100_VERIFIED', 'PHYSICAL_PREVENTION'] as const;
type Form = (typeof FORMS)[number];
type CutOption = (typeof OPTIONS)[number];

export function LabellingPage() {
  const params: { versionId?: string } = useParams({ strict: false });
  const versionId = params.versionId ?? '';
  const q = useApiQuery(routes.labels.masterLabelling, { params: { versionId } });
  const templates = useApiQuery(routes.labels.templates, {});
  const declare = useCommand(routes.labels.declareLabelling, [routes.labels.masterLabelling.id]);
  const [step, setStep] = useState('');
  const [item, setItem] = useState('');
  const [form, setForm] = useState<Form>('CARTON');
  const [templateId, setTemplateId] = useState('');
  const [option, setOption] = useState<CutOption | ''>('');
  if (q.error) return <RefusalMessage error={q.error.error} />;
  if (!q.data) return <p>Loading…</p>;
  const m = q.data;
  const ok = step.trim() !== '' && /^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(item.trim()) && (form !== 'CUT_LABEL' || option !== '');
  return (
    <>
      <h1>Labelling of the master</h1>
      <p data-testid="labelling-state">
        Version state: {words(m.state)}. {m.approvalProblem ? `It would fail approval: ${m.approvalProblem}` : 'Its labelling would pass approval.'}
      </p>
      <Section title="Printed items" testId="labelling-items">
        {m.items.length === 0 ? <p>No printed item is declared.</p> : null}
        <ul>
          {m.items.map((i) => (
            <li key={`${i.step}/${i.item}`} data-testid={`labelling-item-${i.item}`}>
              {i.step}: {i.item}, {words(i.form)}
              {i.templateRef ? `, template ${i.templateRef}` : ', no template'}
              {i.option211122g ? `, cut-label control ${words(i.option211122g)}` : ''}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Declare a printed item (draft masters)" testId="labelling-declare">
        <Field name="labellingStep" label="Step" value={step} onChange={setStep} />
        <Field name="labellingItem" label="Item code" value={item} onChange={setItem} />
        <floor.ChoiceGroup label="Form" options={FORMS.map((f) => ({ value: f, label: words(f) }))} value={form} onChange={(x) => setForm(x as Form)} />
        {templates.data && templates.data.templates.length > 0 ? (
          <floor.ChoiceGroup label="Label template" options={templates.data.templates.map((t) => ({ value: t.templateId, label: t.ref }))} value={templateId} onChange={setTemplateId} />
        ) : null}
        {form === 'CUT_LABEL' ? <floor.ChoiceGroup label="Cut-label control" options={OPTIONS.map((o) => ({ value: o, label: words(o) }))} value={option} onChange={(x) => setOption(x as CutOption)} /> : null}
        <ActButton
          label="Declare the item"
          disabled={declare.busy || !ok}
          onPress={() =>
            ok &&
            declare.run({
              params: { versionId },
              body: { step: step.trim(), item: item.trim(), form, ...(templateId ? { templateId } : {}), ...(form === 'CUT_LABEL' && option !== '' ? { option211122g: option } : {}) },
            })
          }
        />
        <ActResult error={declare.error} done={declare.done} label="The printed item is declared." />
      </Section>
    </>
  );
}
