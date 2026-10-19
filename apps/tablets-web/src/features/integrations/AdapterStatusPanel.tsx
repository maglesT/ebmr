/**
 * An adapter's registration status (Phase 7 slice 7g, work package 2; kernel 1180; DI-31): the system administrator blocks,
 * re-activates or decommissions an integration adapter with the reason (iam.set_integration_adapter_status:
 * IAM.DEVICE_MANAGE). A blocked or decommissioned adapter's identity is refused by the database at its next message; the
 * worker on this server is started and stopped on the operations screen.
 */
import { useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { Field } from '@ebmr/ui-kit';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { useSessionRole } from '../../app/roles.ts';
import { Row, Select } from '../administration/shared.tsx';

const STATUSES = ['ACTIVE', 'BLOCKED', 'DECOMMISSIONED'] as const;
const READS = [routes.integrations.adapter.id, routes.integrations.adapters.id, routes.deviceRegistry.list.id] as const;

export function AdapterStatusPanel({ adapterCode, status }: { adapterCode: string; status: string }) {
  const role = useSessionRole();
  const set = useCommand(routes.deviceRegistry.setAdapterStatus, READS, 'changing an adapter\'s status');
  const [next, setNext] = useState('');
  const [reason, setReason] = useState('');
  // Display only: the database decides (IAM.DEVICE_MANAGE).
  if (role !== 'SYSTEM_ADMINISTRATOR' && role !== 'BREAK_GLASS_ADMIN') return null;
  const target = STATUSES.find((s) => s === next);
  return (
    <Section title="Registration status" testId="adapter-status">
      <p>Now {status.toLowerCase()}. A blocked or decommissioned adapter&apos;s messages are refused by the database.</p>
      <Row>
        <Select name="adapter-status" label="New status" value={next} onChange={setNext} options={STATUSES.filter((s) => s !== status).map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))} />
        <Field name="adapter-status-reason" label="Reason" value={reason} onChange={setReason} />
      </Row>
      <ActButton label="Change the status" disabled={!target || reason.trim() === '' || set.busy} onPress={() => (target ? set.run({ params: { adapterCode }, body: { status: target, reason: reason.trim() } }) : null)} />
      <ActResult error={set.error} done={set.done} label="Status changed." />
    </Section>
  );
}
