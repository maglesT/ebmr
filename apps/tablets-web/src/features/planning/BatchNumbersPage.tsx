/**
 * The batch-number register of the site (Phase 7 slice 7g, WP4; decision 0025; IN-18): every number given, registered
 * from outside or recovered after a restore, with its status; a voided number stays listed and is never given again.
 * The issuer registers a number issued outside the system, voids a number with a reason code and text, and re-enters a
 * number issued in the window a completed restore skipped, with its evidence. Every right and rule is the database's.
 * Slice 7h WP-C (gap C1): the site's numbering rules and the master-data steward's definition of a rule.
 */
import { useState } from 'react';
import { routes, type BatchNumberView, type RetiredSerialRangeView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { DefineForm, type FormField } from '../../app/define-form.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';

const READS = [routes.planning.batchNumbers.id];

const IDENTITY: readonly FormField[] = [
  { name: 'productCode', label: 'Product code', kind: 'text' },
  { name: 'productName', label: 'Product name', kind: 'text' },
  { name: 'edition', label: 'Edition', kind: 'choice', options: ['TABLETS', 'INJECTABLES', 'SUBSTANCE'] },
  { name: 'batchSize', label: 'Batch size', kind: 'decimal' },
  { name: 'batchSizeUnit', label: 'Batch size unit (e.g. {tbl}, kg)', kind: 'text' },
  { name: 'parentBatchNumber', label: 'Processing batch number (a packaging number only)', kind: 'text', optional: true },
];

const RETIRED_WHY: Readonly<Record<RetiredSerialRangeView['reason'], string>> = {
  SERVER_RESTART: 'retired after a server start (the rest of a reserved block may have been given before a rollback, so it is never given)',
  LEDGER_AHEAD: 'skipped because the external number ledger was ahead of the database',
  RESTORE_EVENT: 'skipped by a completed restore (a number issued in the lost window is re-entered under "Recover a number")',
  IDENTIFIERS_SECURED: 'skipped when a copy of the database secured its identifiers',
};

/**
 * Owner decision of 13 November 2026 (retest item 9c; IN-18): the serials each numbering rule skipped, with why and when,
 * as the database recorded them. They were never given and never will be; a gap in the register is explained here.
 */
function RetiredRanges({ ranges }: { ranges: readonly RetiredSerialRangeView[] }) {
  if (ranges.length === 0) return null;
  return (
    <Section title="Numbers skipped and never given" testId="retired-ranges">
      <ul>
        {ranges.map((r) => (
          <li key={`${r.ruleCode}-${r.firstSerial}`} data-testid={`retired-${r.ruleCode}-${r.firstSerial}`}>
            {r.firstNumber && r.lastNumber ? `${r.firstNumber}–${r.lastNumber}` : `Serials ${r.firstSerial}–${r.lastSerial}`} (rule {r.ruleCode}): {RETIRED_WHY[r.reason]}, {r.recordedAt.text}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function BatchNumbersPage() {
  const q = useApiQuery(routes.planning.batchNumbers);
  const issuer = useOffered('PLANNING');
  return (
    <>
      <h1>Batch-number register</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.numbers.length === 0 ? <p>No batch number yet.</p> : null}
      <table aria-label="Batch numbers">
        <thead>
          <tr>
            <th scope="col">Batch number</th>
            <th scope="col">Date</th>
            <th scope="col">Product</th>
            <th scope="col">Size</th>
            <th scope="col">Source</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {q.data?.numbers.map((n) => (
            <NumberRow key={n.allocationId} n={n} issuer={issuer} />
          ))}
        </tbody>
      </table>
      <RetiredRanges ranges={q.data?.retired ?? []} />
      {issuer ? (
        <>
          <Section title="Register a number issued outside the system" testId="register-external">
            <DefineForm
              title="External batch number"
              route={routes.planning.registerExternalBatchNumber}
              refresh={READS}
              submitLabel="Register the number"
              fields={[
                { name: 'batchNumber', label: 'Batch number', kind: 'text' },
                { name: 'batchKind', label: 'Kind', kind: 'choice', options: ['PROCESSING', 'PACKAGING'] },
                { name: 'externalReference', label: 'External reference (e.g. the ERP order)', kind: 'text' },
                ...IDENTITY,
              ]}
            />
          </Section>
          <Section title="Recover a number after a restore" testId="recover-number">
            <DefineForm
              title="Recovered batch number"
              route={routes.planning.recoverBatchNumber}
              refresh={READS}
              submitLabel="Recover the number"
              fields={[
                { name: 'restoreEventId', label: 'Completed restore event (id)', kind: 'text' },
                { name: 'ruleCode', label: 'Numbering rule', kind: 'text' },
                { name: 'serial', label: 'Serial in the skipped range', kind: 'text' },
                { name: 'batchNumber', label: 'Batch number', kind: 'text' },
                { name: 'evidenceReference', label: 'Evidence that it was issued (paper record, ERP document, label)', kind: 'text' },
                ...IDENTITY,
              ]}
            />
          </Section>
        </>
      ) : null}
      <NumberingRules />
    </>
  );
}

/**
 * Slice 7h WP-C (gap C1; IN-18): the site's numbering rules, and the master-data steward's definition of one
 * (planning.defineBatchNumberRule, site.define_batch_number_rule; BATCH_NUMBER.RULE_DEFINE). The site and its zone are the
 * session's; the database checks the format, its tokens and that a rule never takes effect in the past.
 */
function NumberingRules() {
  const q = useApiQuery(routes.planning.batchNumberRules);
  const steward = useOffered('FORMULA_AUTHOR');
  return (
    <Section title="Numbering rules" testId="numbering-rules">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.rules.length === 0 ? <p>No numbering rule yet: numbers are then only registered from outside.</p> : null}
      {q.data && q.data.rules.length > 0 ? (
        <table aria-label="Numbering rules">
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Format</th>
              <th scope="col">Kind</th>
              <th scope="col">Product</th>
              <th scope="col">From</th>
              <th scope="col">Defined by</th>
            </tr>
          </thead>
          <tbody>
            {q.data.rules.map((r) => (
              <tr key={r.ruleId} data-testid={`rule-${r.ruleCode}`}>
                <th scope="row">{r.ruleCode}</th>
                <td>{r.format}</td>
                <td>{r.batchKind.toLowerCase()}</td>
                <td>{r.productCode ?? 'every product of the site'}</td>
                <td>{r.effectiveFrom.text}</td>
                <td>
                  {r.definedBy.legalName}: {r.reason}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {steward ? (
        <DefineForm
          title="Numbering rule"
          route={routes.planning.defineBatchNumberRule}
          refresh={[routes.planning.batchNumberRules.id]}
          submitLabel="Define the rule"
          fields={[
            { name: 'ruleCode', label: 'Rule code', kind: 'text', description: 'Capitals, digits, _ -' },
            { name: 'batchKind', label: 'Kind', kind: 'choice', options: ['PROCESSING', 'PACKAGING'] },
            { name: 'format', label: 'Format', kind: 'text', description: 'A-Z 0-9 / . - and {SITE} {PRODUCT} {YYYY} {YY} {MM} {SEQ:n} {PARENT}; exactly one {SEQ:n}, e.g. B{YY}{SEQ:4}' },
            { name: 'productCode', label: 'Product code (empty: every product of the site)', kind: 'text', optional: true },
            { name: 'effectiveFrom', label: 'Effective from (empty: now)', kind: 'instant', optional: true, description: 'ISO-8601 with offset, e.g. 2027-01-01T00:00:00+05:30' },
            { name: 'reason', label: 'Reason (e.g. the numbering SOP)', kind: 'text' },
          ]}
        />
      ) : null}
    </Section>
  );
}

function NumberRow({ n, issuer }: { n: BatchNumberView; issuer: boolean }) {
  const voidIt = useCommand(routes.planning.voidBatchNumber, READS, 'voiding a batch number');
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <tr data-testid={`number-${n.batchNumber}`} data-status={n.status}>
      <th scope="row">
        {n.batchNumber}
        {n.parentBatchNumber ? ` (of ${n.parentBatchNumber})` : ''}
      </th>
      <td>{n.allocationDate}</td>
      <td>
        {n.productCode} {n.productName}
      </td>
      <td>
        {n.batchSize} {n.batchSizeUnit}
      </td>
      <td>
        {n.source.toLowerCase().replace(/_/g, ' ')}
        {n.externalReference ? `: ${n.externalReference}` : ''}
      </td>
      <td>
        <StatusChip tone={n.status === 'VOIDED' ? 'neutral' : 'ok'} label={n.status === 'VOIDED' ? `voided (${n.voidReasonCode ?? ''}: ${n.voidReasonText ?? ''})` : 'allocated'} />
        {issuer && n.status === 'ALLOCATED' && !open ? <ActButton primary={false} label={`Void ${n.batchNumber}`} onPress={() => setOpen(true)} /> : null}
        {open ? (
          <>
            <Field name={`void-code-${n.allocationId}`} label="Reason code (e.g. ORDER_CANCELLED)" value={code} onChange={setCode} />
            <Field name={`void-text-${n.allocationId}`} label="Reason" value={text} onChange={setText} />
            <ActButton
              label={`Void ${n.batchNumber} for good`}
              disabled={!/^[A-Z][A-Z0-9_]{1,39}$/.test(code.trim()) || text.trim() === '' || voidIt.busy}
              onPress={async () => {
                if (await voidIt.run({ params: { allocationId: n.allocationId }, body: { reasonCode: code.trim(), reasonText: text.trim() } })) setOpen(false);
              }}
            />
          </>
        ) : null}
        <ActResult error={voidIt.error} />
      </td>
    </tr>
  );
}
