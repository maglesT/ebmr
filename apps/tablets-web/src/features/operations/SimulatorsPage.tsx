/**
 * The simulators' test console (Phase 7 slice 7g-4; decision 0025 point 2; demo and sandbox installations only, tablets
 * 1485 refuses it on any other GMP one): each simulator of the external systems and the equipment (ERP/WMS, QMS, LIMS,
 * LMS, CMMS, EMS, the L3 serialisation system, the OPC UA press and line) runs as a process of the server; the system
 * administrator starts and stops it and switches its faults (a stale value, a gap in the feed, a cut link...), each with
 * a reason, recorded. The adapter's base URL is the endpoint shown; the integration health page shows what the faults do.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type DemoOrderTemplateView, type SimulatorView } from '@ebmr/api-contract';
import { Banner, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { SIMULATOR_READS, words } from './reads.ts';

function SimulatorCard({ s, reason }: { s: SimulatorView; reason: string }) {
  const control = useCommand(routes.operations.controlSimulator, SIMULATOR_READS);
  const fault = useCommand(routes.operations.simulatorFault, SIMULATOR_READS);
  const why = reason.trim() === '' ? 'test console' : reason.trim();
  const busy = control.busy || fault.busy;
  return (
    <section aria-label={s.title} data-testid={`simulator-${s.code}`} data-running={String(s.running)} style={{ marginBlock: '1rem' }}>
      <h2>
        {s.title} <StatusChip tone={s.running ? 'ok' : 'neutral'} label={s.running ? 'Running' : 'Stopped'} />
      </h2>
      {s.running ? (
        <p>
          Adapter endpoint <code data-testid={`simulator-endpoint-${s.code}`}>{s.endpoint}</code>; console <code>{s.url}</code>
        </p>
      ) : null}
      {s.problem ? <Banner tone="warning" title={s.problem} /> : null}
      {s.running ? (
        <ActButton label={`Stop the ${s.code} simulator`} primary={false} disabled={busy} onPress={() => control.run({ params: { simulator: s.code }, body: { action: 'STOP', reason: why } })} />
      ) : (
        <ActButton label={`Start the ${s.code} simulator`} disabled={busy} onPress={() => control.run({ params: { simulator: s.code }, body: { action: 'START', reason: why } })} />
      )}
      {control.busy ? <p>Working…</p> : null}
      <ActResult error={control.error} done={null} />
      {s.running ? (
        <fieldset>
          <legend>Faults</legend>
          <ul style={{ listStyle: 'none', paddingInlineStart: 0 }}>
            {s.available.map((f) => {
              const on = s.faults.includes(f);
              return (
                <li key={f} data-testid={`fault-${s.code}-${f}`} data-on={String(on)}>
                  <StatusChip tone={on ? 'warning' : 'neutral'} label={`${words(f)}: ${on ? 'on' : 'off'}`} />{' '}
                  <ActButton
                    label={`${on ? 'Switch off' : 'Switch on'} ${words(f)}`}
                    primary={false}
                    disabled={busy}
                    onPress={() => fault.run({ params: { simulator: s.code }, body: { fault: f, on: !on, reason: why } })}
                  />
                </li>
              );
            })}
          </ul>
          <ActResult error={fault.error} done={null} />
        </fieldset>
      ) : null}
    </section>
  );
}

/**
 * R5 (slice 7k): the ERP simulator sends one production order of a demo product (processing or packaging) as the ERP
 * interface, a new order number each time, so a presenter starts as many batches as the demo needs (it replaces the
 * hosted demo's post-demo-order script). The order then waits on the planning screen like any order the ERP sent.
 */
function SendOrder({ templates, reason }: { templates: readonly DemoOrderTemplateView[]; reason: string }) {
  const send = useCommand(routes.operations.sendProductionOrder, [...SIMULATOR_READS, routes.planning.orders.id], 'sending a production order');
  const [chosen, setChosen] = useState<string | null>(null);
  const key = (t: DemoOrderTemplateView) => `${t.productCode}:${t.kind}`;
  const t = templates.find((x) => key(x) === chosen);
  return (
    <section aria-label="Send a production order" data-testid="send-order" style={{ marginBlock: '1rem' }}>
      <h2>Send a production order (ERP simulator)</h2>
      <floor.ChoiceGroup
        label="Order"
        options={templates.map((x) => ({ value: key(x), label: `${x.productName}: ${x.kind === 'PROCESSING' ? 'processing' : 'packaging'}, ${x.batchSize} ${x.batchSizeUnit === '{tbl}' ? 'tablets' : x.batchSizeUnit}` }))}
        value={chosen}
        onChange={setChosen}
      />
      <ActButton
        label="Send the production order"
        disabled={send.busy || !t}
        onPress={() => (t ? send.run({ body: { productCode: t.productCode, kind: t.kind, reason: reason.trim() === '' ? 'test console' : reason.trim() } }) : undefined)}
      />
      <ActResult error={send.error} done={send.done} label={send.done ? `Order ${send.done.orderNo} sent: it waits on the planning screen.` : ''} />
    </section>
  );
}

export function SimulatorsPage() {
  const view = useApiQuery(routes.operations.simulators, {}, { refetchInterval: 5000 });
  const [reason, setReason] = useState('');
  const v = view.data;
  return (
    <>
      <h1>Simulators</h1>
      <p>
        SIMULATOR, DEMO-ONLY. Each simulator stands in for an external system or a piece of equipment so every feature can be tried and every failure shown. What a fault
        does is seen where the data arrives: the <Link to="/integrations">integration health page</Link> and the steps that read it.
      </p>
      {view.error ? <RefusalMessage error={view.error.error} /> : null}
      {v && !v.allowed ? (
        <Banner tone="warning" title="The simulators are refused on this installation.">
          <p>{v.refusal}</p>
        </Banner>
      ) : null}
      {v?.allowed ? <Field name="simulator-reason" label="Reason (recorded with each start, stop and fault; default: test console)" value={reason} onChange={setReason} /> : null}
      {v?.allowed && v.orderTemplates && v.orderTemplates.length > 0 ? <SendOrder templates={v.orderTemplates} reason={reason} /> : null}
      {v?.simulators.map((s) => (
        <SimulatorCard key={s.code} s={s} reason={reason} />
      ))}
    </>
  );
}
