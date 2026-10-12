/**
 * The India-domestic label particulars of a batch and its Schedule H2 payload (Phase 4 slice 6a; IN-31, PR-43, D-P4-14):
 * computed by the server from the record (never typed), the payload released for printing on the batch and a scanned
 * payload checked against it. The payload layout is a stub until its elements are confirmed (status U).
 */
import { useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { Banner, Field } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useRouteParams } from '../floor/params.ts';
import { INDIA_READS } from './reads.ts';

export function BatchLabelPage() {
  const batchId = useRouteParams()['batchId'] ?? '';
  const q = useApiQuery(routes.india.label, { params: { batchId } });
  const issue = useCommand(routes.india.issueH2, INDIA_READS);
  const [scanned, setScanned] = useState('');
  const [checked, setChecked] = useState<string | null | undefined>(undefined);
  const check = useCommand(routes.india.verifyH2, []);
  const p = q.data?.particulars ?? null;
  return (
    <>
      <h1>India-domestic label particulars</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data?.problem ? <Banner tone="warning" title={q.data.problem} /> : null}
      {p ? (
        <dl data-testid="india-label">
          <dt>Drug</dt>
          <dd>
            {p.drugName} {p.strength} ({p.dosageForm})
          </dd>
          <dt>Batch number</dt>
          <dd data-testid="label-batch">{p.batchNumber}</dd>
          <dt>Date of manufacture</dt>
          <dd data-testid="label-mfg">{p.manufactureLabel}</dd>
          <dt>Expiry date</dt>
          <dd data-testid="label-exp">
            {p.expiryLabel} ({p.shelfLifeMonths} months{p.tentativeShelfLife ? ', tentative shelf life' : ''})
          </dd>
          <dt>Manufactured by</dt>
          <dd>
            {p.manufacturer.name}, {p.manufacturer.address}; Mfg. Lic. No. {p.manufacturer.licenceNumber}
          </dd>
          {p.loanLicensee ? (
            <>
              <dt>Loan licensee</dt>
              <dd>
                {p.loanLicensee.name}, {p.loanLicensee.address}; Loan Lic. No. {p.loanLicensee.licenceNumber}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {q.data ? (
        <Section title={`Schedule H2 payload (layout ${q.data.h2.layoutVersion}, status ${q.data.h2.layoutStatus})`} testId="india-h2">
          {q.data.h2.payload ? <code data-testid="h2-payload">{q.data.h2.payload}</code> : <p>No payload can be given yet.</p>}
          <p>Released for printing {q.data.h2.issuedCount} time(s).</p>
          {q.data.h2.payload ? (
            <>
              <ActButton label="Release the payload for printing" onPress={() => issue.run({ params: { batchId }, body: {} })} disabled={issue.busy} />
              <ActResult error={issue.error} done={issue.done} label="The payload is released for printing." />
            </>
          ) : null}
          <Field name="scannedPayload" label="Scanned payload" value={scanned} onChange={setScanned} />
          <ActButton
            primary={false}
            label="Check the scanned payload"
            onPress={async () => {
              const out = await check.run({ params: { batchId }, body: { payload: scanned } });
              if (out) setChecked(out.problem);
            }}
            disabled={scanned.trim() === '' || check.busy}
          />
          {check.error ? <RefusalMessage error={check.error} /> : null}
          {checked === null ? <Banner tone="ok" title="The payload is the one issued for this batch." /> : null}
          {typeof checked === 'string' ? <Banner tone="warning" title={checked} /> : null}
        </Section>
      ) : null}
    </>
  );
}
