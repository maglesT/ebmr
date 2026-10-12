/**
 * The PQR extracts (Phase 4 slice 6c; IN-01, PR-58): the extracts run, newest first, optionally of one product, and the
 * run of a new one for a product and a period of issue days (QA, the head of QC or the AP). A run that does not
 * reconcile to the registers is refused by the server and stores nothing.
 */
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { PQR_READS } from './reads.ts';

const CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function PqrExtractsPage() {
  const [filter, setFilter] = useState('');
  const product = CODE.test(filter.trim()) ? filter.trim() : undefined;
  const q = useApiQuery(routes.pqr.extracts, { query: product ? { productCode: product } : {} });
  return (
    <>
      <h1>Product quality review</h1>
      <p>
        The extract of a product and period is a versioned query run by the database: its result and SHA-256 are stored, and it is reconciled to the batch number register, the deviation register and
        the change records. A mismatch fails the extract. The authorised person signs it off.
      </p>
      <RunExtract />
      <Section title="Extracts" testId="pqr-extracts">
        <Field name="pqrFilter" label="Product code (filter)" value={filter} onChange={setFilter} />
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        {q.data && q.data.extracts.length === 0 ? <p>No extract was run.</p> : null}
        <ul>
          {q.data?.extracts.map((x) => (
            <li key={x.extractId} data-testid={`pqr-extract-${x.extractId}`}>
              <Link to="/pqr/$extractId" params={{ extractId: x.extractId }}>
                {x.productCode} {x.periodFrom} to {x.periodTo}
              </Link>{' '}
              {x.counts.batches} batches, {x.counts.deviations} deviations, run by {x.ranBy.legalName} {x.ranAt.text}{' '}
              <StatusChip tone={x.signOff ? 'ok' : 'neutral'} label={x.signOff ? 'Signed off' : 'Not signed off'} />
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function RunExtract() {
  const qa = useOffered('QA');
  const qc = useOffered('QC');
  const offered = qa || qc;
  const run = useCommand(routes.pqr.run, PQR_READS);
  const navigate = useNavigate();
  const [product, setProduct] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  if (!offered) return null;
  const ok = CODE.test(product.trim()) && DAY.test(from.trim()) && DAY.test(to.trim());
  return (
    <Section title="Run an extract" testId="pqr-run">
      <Field name="pqrProduct" label="Product code" value={product} onChange={setProduct} />
      <Field name="pqrFrom" label="First issue day (YYYY-MM-DD)" value={from} onChange={setFrom} />
      <Field name="pqrTo" label="Last issue day (YYYY-MM-DD)" value={to} onChange={setTo} />
      <ActButton
        label="Run the extract"
        onPress={async () => {
          if (!ok) return;
          const x = await run.run({ body: { productCode: product.trim(), periodFrom: from.trim(), periodTo: to.trim() } });
          if (x) await navigate({ to: '/pqr/$extractId', params: { extractId: x.extractId } });
        }}
        disabled={!ok || run.busy}
      />
      <ActResult error={run.error} done={run.done} label="The extract is stored." />
    </Section>
  );
}
