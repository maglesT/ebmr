/**
 * Review-by-exception rules (Phase 6 slice 6f; DI-26, DI-09): the rule of each review category in force, and a new
 * version under an approved change record covering RBE rules. A mandatory category always stays on the review; a rule
 * raises the severity the review shows. The rule set of a past date is read the same way.
 */
import { useState } from 'react';
import { routes, type RbeRuleView } from '@ebmr/api-contract';
import { Field, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { CONFIG_READS, isoWithOffset, words } from './reads.ts';

const SEVERITIES = ['ALERT', 'ACTION', 'CRITICAL'] as const;

export function RbeRulesPage() {
  const [local, setLocal] = useState('');
  const at = isoWithOffset(local.trim());
  const q = useApiQuery(routes.config.rbeRules, { query: at !== null ? { at } : {} });
  return (
    <>
      <h1>Review-by-exception rules</h1>
      <p>
        Every exception of a batch is on its review. These rules set, per review category, the least severity the review shows. They change only under a
        change record approved by QA; enabling review by exception on a step of a master also needs a validation reference on the master&apos;s change record.
      </p>
      <Field name="rbeAt" label="Show the rules as of (YYYY-MM-DDTHH:MM; empty: now)" value={local} onChange={setLocal} />
      <Section title="Rules" testId="rbe-rules">
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        {q.data?.rules.map((r) => <Rule key={r.category} r={r} editable={at === null} />)}
      </Section>
    </>
  );
}

function Rule({ r, editable }: { r: RbeRuleView; editable: boolean }) {
  const qa = useOffered('QA');
  const set = useCommand(routes.config.setRbeRule, CONFIG_READS);
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>(r.minSeverity);
  const [rationale, setRationale] = useState('');
  const [cr, setCr] = useState('');
  const ok = rationale.trim() !== '' && cr.trim() !== '';
  return (
    <article data-testid={`rbe-rule-${r.category}`}>
      <h3>{words(r.category)}{r.mandatory ? ' (mandatory)' : ''}</h3>
      <p>
        Listed: {r.included ? 'yes' : 'no'}; least severity shown: {words(r.minSeverity)}
        {r.version !== null ? `; version ${r.version.toString()} from ${r.validFrom ?? ''}: ${r.rationale ?? ''}` : '; no rule yet (severity as raised)'}.
      </p>
      {editable && qa ? (
        <>
          <floor.ChoiceGroup label="Least severity" options={SEVERITIES.map((s) => ({ value: s, label: words(s) }))} value={severity} onChange={(v) => setSeverity(SEVERITIES.find((s) => s === v) ?? 'ALERT')} />
          <Field name={`rbeRationale-${r.category}`} label="Rationale" value={rationale} onChange={setRationale} />
          <Field name={`rbeCr-${r.category}`} label="Change-record number" value={cr} onChange={setCr} />
          <ActButton
            label="Save a new version"
            onPress={() => (ok ? set.run({ params: { category: r.category }, body: { included: true, minSeverity: severity, rationale: rationale.trim(), changeRecord: cr.trim() } }) : undefined)}
            disabled={!ok || set.busy}
          />
          <ActResult error={set.error} done={set.done} label="Saved under the change record." />
        </>
      ) : null}
    </article>
  );
}
