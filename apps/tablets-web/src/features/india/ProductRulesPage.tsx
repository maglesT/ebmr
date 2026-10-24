/**
 * Shelf-life bases and hazard classes (slice 7g-5, decision 0025; PR-43, IN-27; routes india.shelfLifeBases,
 * recordShelfLifeBasis, hazards, recordHazard; signed act INDIA_ACT HAZARD_APPROVE and DEDICATION_APPROVE):
 *  - the stability basis behind each shelf life of a product and strength; a changed shelf life takes effect on a batch
 *    only with a basis recorded (head of QC or QA, SHELF_LIFE.RECORD);
 *  - a product's hazard class from its risk assessment, and a room or line dedicated to a class with its breathing-air
 *    arrangement (QA); a second QA person approves each record under their own signature, never its recorder. A
 *    recorded upgrade or withdrawal restricts at once; only an approved record lifts a restriction.
 * Every rule and state is the database's; a refusal is shown in its words.
 */
import { useState } from 'react';
import { routes, type DedicationClass, type HazardClass, type HazardView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { INDIA_READS, words } from './reads.ts';

const PRODUCT = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
const AREA = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;
const CLASSES: readonly HazardClass[] = ['NONE', 'SEX_HORMONE', 'STEROID', 'CYTOTOXIC'];

export function ProductRulesPage() {
  return (
    <>
      <h1>Shelf-life bases and hazard classes</h1>
      <ShelfLifeBases />
      <Hazards />
    </>
  );
}

function ShelfLifeBases() {
  const q = useApiQuery(routes.india.shelfLifeBases);
  const record = useCommand(routes.india.recordShelfLifeBasis, INDIA_READS);
  const qc = useOffered('QC');
  const qa = useOffered('QA');
  const mayRecord = qc || qa;
  const [product, setProduct] = useState('');
  const [strength, setStrength] = useState('');
  const [months, setMonths] = useState('');
  const [reference, setReference] = useState('');
  const [tentative, setTentative] = useState('NO');
  const m = /^[1-9][0-9]{0,2}$/.test(months.trim()) ? Number(months.trim()) : null;
  const ok = PRODUCT.test(product.trim()) && strength.trim() !== '' && m !== null && m <= 120 && reference.trim() !== '';
  return (
    <Section title="Shelf-life bases" testId="shelf-life-bases">
      <p>The stability data behind each shelf life. A batch takes a changed shelf life only once its basis is recorded; a tentative basis is marked as such on the record.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.bases.length === 0 ? <p>No basis is recorded.</p> : null}
      <ul>
        {q.data?.bases.map((b) => (
          <li key={b.basisId} data-testid={`shelf-life-${b.productCode}-${b.strength}`}>
            <strong>
              {b.productCode} {b.strength}
            </strong>
            : {b.shelfLifeMonths} months on {b.stabilityReference} {b.tentative ? <StatusChip tone="warning" label="Tentative" /> : null} · recorded by {b.recordedBy.legalName} on {b.recordedAt.text}
          </li>
        ))}
      </ul>
      {mayRecord ? (
        <>
          <h3>Record a basis</h3>
          <Field name="slProduct" label="Product code" value={product} onChange={setProduct} />
          <Field name="slStrength" label="Strength" value={strength} onChange={setStrength} />
          <Field name="slMonths" label="Shelf life (months, 1 to 120)" value={months} onChange={setMonths} />
          <Field name="slReference" label="Stability study reference" value={reference} onChange={setReference} />
          <floor.ChoiceGroup
            label="Basis"
            options={[
              { value: 'NO', label: 'Real-time data' },
              { value: 'YES', label: 'Tentative (accelerated data)' },
            ]}
            value={tentative}
            onChange={setTentative}
          />
          <ActButton
            label="Record the basis"
            disabled={!ok || record.busy}
            onPress={() =>
              ok && m !== null
                ? record.run({ body: { productCode: product.trim(), strength: strength.trim(), shelfLifeMonths: m, stabilityReference: reference.trim(), tentative: tentative === 'YES' } })
                : null
            }
          />
          <ActResult error={record.error} done={record.done} label="The basis is recorded." />
        </>
      ) : null}
    </Section>
  );
}

function Hazards() {
  const q = useApiQuery(routes.india.hazards);
  const qa = useOffered('QA');
  return (
    <Section title="Hazard classes and dedicated areas" testId="hazards">
      <p>
        A product of a hazardous class (sex hormones, steroids, cytotoxics) is made only in a room or line dedicated to its class. A record takes effect when a second QA person approves it;
        a recorded upgrade or withdrawal restricts at once.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data ? <HazardLists v={q.data} qa={qa} /> : null}
      {qa ? <RecordProductHazard /> : null}
      {qa ? <RecordAreaDedication /> : null}
    </Section>
  );
}

function stateTone(state: string): 'ok' | 'pending' | 'neutral' {
  return state === 'APPROVED' ? 'ok' : state === 'RECORDED' ? 'pending' : 'neutral';
}

function HazardLists({ v, qa }: { v: HazardView; qa: boolean }) {
  const signed = useSignedAct(INDIA_READS);
  return (
    <>
      <h3>Products</h3>
      {v.products.length === 0 ? <p>No product is classified.</p> : null}
      <ul>
        {v.products.map((p) => (
          <li key={p.recordId} data-testid={`hazard-product-${p.productCode}`} data-state={p.state}>
            <strong>{p.productCode}</strong>: {words(p.hazardClass)} (risk assessment {p.riskAssessmentRef}), recorded {p.recordedAt.text} <StatusChip tone={stateTone(p.state)} label={words(p.state)} />
            {qa && p.state === 'RECORDED' ? (
              <ActButton
                label={`Approve the hazard class of ${p.productCode}`}
                disabled={signed.busy}
                onPress={() => signed.sign({ kind: 'INDIA_ACT', act: 'HAZARD_APPROVE', subjectId: p.recordId }, `Approve ${words(p.hazardClass)} for ${p.productCode}`)}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <h3>Rooms and lines</h3>
      {v.areas.length === 0 ? <p>No room or line is dedicated.</p> : null}
      <ul>
        {v.areas.map((a) => (
          <li key={a.recordId} data-testid={`hazard-area-${a.areaCode}-${a.hazardClass}`} data-state={a.state}>
            <strong>{a.areaCode}</strong>: {a.dedicated ? 'dedicated to' : 'no longer dedicated to'} {words(a.hazardClass)}, breathing air {words(a.breathingAir)}: {a.justification}, recorded {a.recordedAt.text}{' '}
            <StatusChip tone={stateTone(a.state)} label={words(a.state)} />
            {qa && a.state === 'RECORDED' ? (
              <ActButton
                label={`Approve the dedication of ${a.areaCode}`}
                disabled={signed.busy}
                onPress={() => signed.sign({ kind: 'INDIA_ACT', act: 'DEDICATION_APPROVE', subjectId: a.recordId }, `Approve ${a.areaCode} ${a.dedicated ? 'dedicated to' : 'released from'} ${words(a.hazardClass)}`)}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <ActResult error={signed.error} outcome={signed.outcome} />
    </>
  );
}

function RecordProductHazard() {
  const record = useCommand(routes.india.recordHazard, INDIA_READS);
  const [product, setProduct] = useState('');
  const [cls, setCls] = useState<HazardClass>('NONE');
  const [ref, setRef] = useState('');
  const ok = PRODUCT.test(product.trim()) && ref.trim() !== '';
  return (
    <>
      <h3>Classify a product</h3>
      <Field name="hzProduct" label="Product code" value={product} onChange={setProduct} />
      <floor.ChoiceGroup label="Hazard class" options={CLASSES.map((c) => ({ value: c, label: words(c) }))} value={cls} onChange={(v) => setCls(CLASSES.find((c) => c === v) ?? 'NONE')} />
      <Field name="hzRisk" label="Risk assessment reference" value={ref} onChange={setRef} />
      <ActButton
        label="Record the classification"
        disabled={!ok || record.busy}
        onPress={() => (ok ? record.run({ body: { product: { productCode: product.trim(), hazardClass: cls, riskAssessmentRef: ref.trim() } } }) : null)}
      />
      <ActResult error={record.error} done={record.done} label="Recorded: a second QA person approves it." />
    </>
  );
}

function RecordAreaDedication() {
  const record = useCommand(routes.india.recordHazard, INDIA_READS);
  // Slice 7n (R7): a room or line may also be dedicated to beta-lactam products (recipe-core 1655, PR-27).
  const classes: readonly DedicationClass[] = ['SEX_HORMONE', 'STEROID', 'CYTOTOXIC', 'BETA_LACTAM'];
  const [area, setArea] = useState('');
  const [cls, setCls] = useState<DedicationClass>('STEROID');
  const [dedicated, setDedicated] = useState('YES');
  const [air, setAir] = useState<'NOT_USED' | 'BACKED_UP'>('NOT_USED');
  const [why, setWhy] = useState('');
  const ok = AREA.test(area.trim()) && why.trim() !== '';
  return (
    <>
      <h3>Dedicate a room or line</h3>
      <Field name="hzArea" label="Room or line code" value={area} onChange={setArea} />
      <floor.ChoiceGroup label="Class of the room or line" options={classes.map((c) => ({ value: c, label: words(c) }))} value={cls} onChange={(v) => setCls(classes.find((c) => c === v) ?? 'STEROID')} />
      <floor.ChoiceGroup
        label="Dedication"
        options={[
          { value: 'YES', label: 'Dedicated to the class' },
          { value: 'NO', label: 'No longer dedicated' },
        ]}
        value={dedicated}
        onChange={setDedicated}
      />
      <floor.ChoiceGroup
        label="Breathing air"
        options={[
          { value: 'NOT_USED', label: 'Not used' },
          { value: 'BACKED_UP', label: 'Used, with a backup supply' },
        ]}
        value={air}
        onChange={(v) => setAir(v === 'BACKED_UP' ? 'BACKED_UP' : 'NOT_USED')}
      />
      <Field name="hzJustification" label="Justification" value={why} onChange={setWhy} />
      <ActButton
        label="Record the dedication"
        disabled={!ok || record.busy}
        onPress={() => (ok ? record.run({ body: { area: { areaCode: area.trim(), hazardClass: cls, dedicated: dedicated === 'YES', breathingAir: air, justification: why.trim() } } }) : null)}
      />
      <ActResult error={record.error} done={record.done} label="Recorded: a second QA person approves it." />
    </>
  );
}
