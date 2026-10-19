/**
 * Plant configuration (slice 7g WP3; MASTERDATA.CHANGE): alarm codes with whether they are GMP-critical and need a
 * deviation (DI-49), equipment campaigns on one unit or room with their limits and cleaning validation (IN-26), the
 * maximum age of a utility feed's reading, and the line isolations of the blister register (IN-38). The database decides
 * every rule; its refusal is shown in its own words.
 */
import { useState } from 'react';
import { routes, type PlantConfigView } from '@ebmr/api-contract';
import { Field, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { PLANT_READS } from './reads.ts';

const yesNo = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];

export function PlantConfigPage() {
  const q = useApiQuery(routes.marketConfig.plantConfig, {});
  return (
    <>
      <h1>Plant configuration</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data ? (
        <>
          <AlarmCodes cfg={q.data} />
          <Campaigns cfg={q.data} />
          <FeedAges cfg={q.data} />
          <LineIsolations cfg={q.data} />
        </>
      ) : null}
    </>
  );
}

function AlarmCodes({ cfg }: { cfg: PlantConfigView }) {
  const define = useCommand(routes.marketConfig.defineAlarmCode, PLANT_READS);
  const [source, setSource] = useState<'EBMR' | 'OPCUA' | 'EMS'>('OPCUA');
  const [code, setCode] = useState('');
  const [critical, setCritical] = useState('yes');
  const [deviation, setDeviation] = useState('no');
  const [description, setDescription] = useState('');
  const ok = /^[A-Z][A-Z0-9_.-]{0,63}$/.test(code.trim()) && description.trim() !== '';
  return (
    <Section title="Alarm codes" testId="alarm-codes">
      <p>An alarm that needs a deviation is GMP-critical. Each change is a new version of the code.</p>
      <ul>
        {cfg.alarmCodes.map((a) => (
          <li key={`${a.source}-${a.code}-${String(a.version)}`}>
            {a.source} {a.code} v{a.version}: {a.description}
            {a.gmpCritical ? ' (GMP-critical' : ' (not GMP-critical'}
            {a.deviationRequired ? ', deviation required)' : ')'}, by {a.recordedBy.legalName} {a.recordedAt.text}
          </li>
        ))}
      </ul>
      <floor.ChoiceGroup label="Source" options={['EBMR', 'OPCUA', 'EMS'].map((s) => ({ value: s, label: s }))} value={source} onChange={(x) => setSource(x as 'EBMR' | 'OPCUA' | 'EMS')} />
      <Field name="alarmCode" label="Alarm code" value={code} onChange={setCode} />
      <floor.ChoiceGroup label="GMP-critical" options={yesNo} value={critical} onChange={setCritical} />
      <floor.ChoiceGroup label="Deviation required" options={yesNo} value={deviation} onChange={setDeviation} />
      <Field name="alarmDescription" label="Description" value={description} onChange={setDescription} />
      <ActButton
        label="Save the alarm code"
        disabled={define.busy || !ok}
        onPress={() => ok && define.run({ body: { source, code: code.trim(), gmpCritical: critical === 'yes', deviationRequired: deviation === 'yes', description: description.trim() } })}
      />
      <ActResult error={define.error} done={define.done} label="The alarm code is saved." />
    </Section>
  );
}

function Campaigns({ cfg }: { cfg: PlantConfigView }) {
  const open = useCommand(routes.marketConfig.openCampaign, PLANT_READS);
  const close = useCommand(routes.marketConfig.closeCampaign, PLANT_READS);
  const [where, setWhere] = useState<'equipment' | 'room'>('equipment');
  const [unit, setUnit] = useState('');
  const [product, setProduct] = useState('');
  const [maxBatches, setMaxBatches] = useState('');
  const [maxDays, setMaxDays] = useState('');
  const [validationRef, setValidationRef] = useState('');
  const [closeReason, setCloseReason] = useState('');
  const whole = (s: string) => /^[1-9][0-9]{0,5}$/.test(s.trim());
  const ok = unit.trim() !== '' && product.trim() !== '' && whole(maxBatches) && whole(maxDays) && validationRef.trim() !== '';
  return (
    <Section title="Equipment campaigns" testId="campaigns">
      <p>One open campaign per process unit or room, for one product, within its batch and day limits and the validated cleaning interval it cites.</p>
      <ul>
        {cfg.campaigns.map((c) => (
          <li key={c.campaignId} data-testid={`campaign-${c.equipmentCode ?? c.areaCode ?? ''}`}>
            {c.equipmentCode ?? c.areaCode} for {c.product}: at most {c.maxBatches} batches or {c.maxDays} days, under {c.validationRef}; opened by {c.openedBy.legalName} {c.openedAt.text}
            {c.closedAt ? `; closed ${c.closedAt.text}: ${c.closeReason ?? ''}` : ''}
            {c.closedAt ? null : (
              <ActButton
                primary={false}
                label={`Close the campaign on ${c.equipmentCode ?? c.areaCode ?? ''}`}
                disabled={close.busy || closeReason.trim() === ''}
                onPress={() => closeReason.trim() && close.run({ params: { campaignId: c.campaignId }, body: { reason: closeReason.trim() } })}
              />
            )}
          </li>
        ))}
      </ul>
      <Field name="campaignCloseReason" label="Reason for closing a campaign" value={closeReason} onChange={setCloseReason} />
      <ActResult error={close.error} done={close.done} label="The campaign is closed." />
      <floor.ChoiceGroup label="Campaign on" options={[{ value: 'equipment', label: 'A process unit' }, { value: 'room', label: 'A room' }]} value={where} onChange={(x) => setWhere(x as 'equipment' | 'room')} />
      <Field name="campaignUnit" label={where === 'equipment' ? 'Equipment code' : 'Room code'} value={unit} onChange={setUnit} />
      <Field name="campaignProduct" label="Product" value={product} onChange={setProduct} />
      <Field name="campaignMaxBatches" label="Maximum batches" value={maxBatches} onChange={setMaxBatches} />
      <Field name="campaignMaxDays" label="Maximum days" value={maxDays} onChange={setMaxDays} />
      <Field name="campaignValidation" label="Cleaning validation reference" value={validationRef} onChange={setValidationRef} />
      <ActButton
        label="Open the campaign"
        disabled={open.busy || !ok}
        onPress={() =>
          ok &&
          open.run({
            body: { ...(where === 'equipment' ? { equipmentCode: unit.trim() } : { areaCode: unit.trim() }), product: product.trim(), maxBatches: maxBatches.trim(), maxDays: maxDays.trim(), validationRef: validationRef.trim() },
          })
        }
      />
      <ActResult error={open.error} done={open.done} label="The campaign is open." />
    </Section>
  );
}

function FeedAges({ cfg }: { cfg: PlantConfigView }) {
  const set = useCommand(routes.marketConfig.setUtilityFeedAge, PLANT_READS);
  const [classCode, setClassCode] = useState('');
  const [minutes, setMinutes] = useState('');
  const ok = classCode !== '' && /^[1-9][0-9]{0,3}$/.test(minutes.trim());
  return (
    <Section title="Utility feed ages" testId="feed-ages">
      <p>A utility reading older than its class&apos;s maximum age is not used. The maximum is at most a day.</p>
      <ul>
        {cfg.feedAges.map((f) => (
          <li key={f.classCode}>
            {f.classCode}: {f.maxAgeMinutes} minutes, set by {f.recordedBy.legalName} {f.recordedAt.text}
          </li>
        ))}
      </ul>
      <floor.ChoiceGroup label="Utility class" options={cfg.utilityClasses.map((c) => ({ value: c, label: c }))} value={classCode} onChange={setClassCode} />
      <Field name="feedAgeMinutes" label="Maximum age (minutes)" value={minutes} onChange={setMinutes} />
      <ActButton label="Set the maximum age" disabled={set.busy || !ok} onPress={() => ok && set.run({ body: { classCode, maxAgeMinutes: minutes.trim() } })} />
      <ActResult error={set.error} done={set.done} label="The maximum age is set." />
    </Section>
  );
}

function LineIsolations({ cfg }: { cfg: PlantConfigView }) {
  const record = useCommand(routes.marketConfig.recordLineIsolation, PLANT_READS);
  const [area, setArea] = useState('');
  const [isolated, setIsolated] = useState('yes');
  const [reference, setReference] = useState('');
  const ok = area !== '' && /^[!-~][ -~]{0,127}$/.test(reference);
  return (
    <Section title="Line isolations (blister register)" testId="line-isolations">
      <p>Whether a packaging line is physically isolated from the others, citing the qualification it rests on.</p>
      <ul>
        {cfg.lineIsolations.map((i) => (
          <li key={i.isolationId}>
            {i.area}: {i.isolated ? 'isolated' : 'not isolated'} ({i.reference}), by {i.recordedBy.legalName} {i.recordedAt.text}
          </li>
        ))}
      </ul>
      <floor.ChoiceGroup label="Line" options={cfg.lines.map((l) => ({ value: l, label: l }))} value={area} onChange={setArea} />
      <floor.ChoiceGroup label="Isolated" options={yesNo} value={isolated} onChange={setIsolated} />
      <Field name="isolationReference" label="Qualification reference" value={reference} onChange={setReference} />
      <ActButton label="Record the line isolation" disabled={record.busy || !ok} onPress={() => ok && record.run({ body: { area, isolated: isolated === 'yes', reference } })} />
      <ActResult error={record.error} done={record.done} label="The line isolation is recorded." />
    </Section>
  );
}
