/**
 * Site values of the market configuration (slice 7g WP3; IN-52, ST-01, DI-09): a site's own value for a rule key from a
 * date, set by the master-data steward under an approved change record covering area SITE_VALUE. The page first asks
 * what the value would decide (tighter, equal, a loosening, or refused). A loosening of a guidance value names its
 * justification (CCS) reference and needs QA's approval of exactly that loosening, signed first through the ceremony
 * (MARKET_LOOSENING) by someone other than the person setting it; a value looser than a binding floor is refused.
 */
import { useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { Field, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { isDate, MARKET_READS, words } from './reads.ts';

export function SiteValuesPage() {
  const q = useApiQuery(routes.marketConfig.siteValues, {});
  const set = useCommand(routes.marketConfig.setSiteValue, MARKET_READS);
  const approve = useSignedAct(MARKET_READS);
  const [site, setSite] = useState('');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [justificationRef, setJustificationRef] = useState('');
  const [changeRecord, setChangeRecord] = useState('');
  const [reason, setReason] = useState('');
  const filled = site !== '' && key.trim() !== '' && value.trim() !== '' && isDate(effectiveFrom);
  const input = { site, key: key.trim(), value: value.trim(), effectiveFrom: effectiveFrom.trim(), ...(justificationRef.trim() ? { justificationRef: justificationRef.trim() } : {}) };
  const preview = useApiQuery(routes.marketConfig.previewSiteValue, { query: input }, { enabled: filled });
  const ok = filled && changeRecord.trim() !== '' && reason.trim() !== '';
  return (
    <>
      <h1>Site values</h1>
      <p>A site may set its own value for a rule key within what the rule tables allow for its markets. It never goes below a binding floor.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <Section title="Values recorded" testId="site-values">
        {q.data && q.data.values.length === 0 ? <p>No site value is recorded.</p> : null}
        <ul>
          {q.data?.values.map((v) => (
            <li key={v.siteValueId} data-testid={`site-value-${v.key}`}>
              {v.site} {v.key} = {v.value} {v.unit} from {v.effectiveFrom} ({words(v.outcome).toLowerCase()}
              {v.justificationRef ? `, under ${v.justificationRef}` : ''}
              {v.qaApprover ? `, approved by ${v.qaApprover.legalName}` : ''}), recorded by {v.recordedBy.legalName} {v.recordedAt.text}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Set a site value" testId="site-value-set">
        <floor.ChoiceGroup label="Site" options={(q.data?.sites ?? []).map((s) => ({ value: s.code, label: `${s.code} (${s.markets.join(', ')})` }))} value={site} onChange={setSite} />
        <Field name="svKey" label="Rule key" value={key} onChange={setKey} />
        <Field name="svValue" label="Value" value={value} onChange={setValue} />
        <Field name="svFrom" label="Effective from (YYYY-MM-DD)" value={effectiveFrom} onChange={setEffectiveFrom} />
        <Field name="svJustification" label="Justification (CCS) reference, for a loosening" value={justificationRef} onChange={setJustificationRef} />
        {preview.error ? <RefusalMessage error={preview.error.error} /> : null}
        {preview.data ? (
          <p data-testid="site-value-preview" data-outcome={preview.data.outcome}>
            The rule tables give {preview.data.resolvedValue ?? 'no value'} ({preview.data.floorType ? words(preview.data.floorType).toLowerCase() : 'no floor'}); this value is{' '}
            {words(preview.data.outcome).toLowerCase()}
            {preview.data.message ? `: ${preview.data.message}` : '.'}
            {preview.data.outcome === 'LOOSENING' ? (preview.data.approvalSigned ? ' QA has approved this loosening.' : ' It needs a justification reference and QA\'s approval first.') : ''}
          </p>
        ) : null}
        {preview.data?.outcome === 'LOOSENING' && input.justificationRef ? (
          <div>
            <ActButton
              primary={false}
              label="Approve this loosening (QA)"
              disabled={approve.busy}
              onPress={() =>
                input.justificationRef &&
                approve.sign(
                  { kind: 'MARKET_LOOSENING', target: { subject: 'SITE_VALUE', site: input.site, key: input.key, value: input.value, effectiveFrom: input.effectiveFrom, justificationRef: input.justificationRef } },
                  `Approve the site value ${input.value} for ${input.key} at ${input.site}`,
                )
              }
            />
            <ActResult error={approve.error} outcome={approve.outcome} label="The loosening is approved." />
          </div>
        ) : null}
        <Field name="svChangeRecord" label="Change record (approved, area SITE_VALUE)" value={changeRecord} onChange={setChangeRecord} />
        <Field name="svReason" label="Reason" value={reason} onChange={setReason} />
        <ActButton label="Set the site value" disabled={set.busy || !ok} onPress={() => ok && set.run({ body: { ...input, changeRecord: changeRecord.trim(), reason: reason.trim() } })} />
        <ActResult error={set.error} done={set.done} label="The site value is recorded." />
      </Section>
    </>
  );
}
