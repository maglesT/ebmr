/**
 * Device configuration (Phase 7 slice 7g, work package 2; decision 0025): what the device registry's page of slice 7g-1
 * did not cover, each the database's own act with the reason recorded:
 *  - the per-entry attribution of each kiosk class, a badge tap or a tap with a PIN (tab.set_attribution_method:
 *    IAM.POLICY_MANAGE; decision D8, INV-40);
 *  - the revocation of a kiosk's hardening attestation (continuity.revoke_hardening_attestation:
 *    CONTINUITY.HARDENING_ATTEST; DI-19);
 *  - the identity of an OPC UA endpoint: enrolled with its opc.tcp URL under SignAndEncrypt and the units it serves, or
 *    retired (plant.enrol_opcua_endpoint, plant.retire_opcua_endpoint: IAM.DEVICE_MANAGE; DI-20, DI-31);
 *  - the plant unit of a process device binding (tab.link_process_device_unit: IAM.DEVICE_MANAGE; PR-22).
 */
import { useState } from 'react';
import { routes, type DeviceConfigurationView, type OpcuaEndpointView, type TerminalView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useSessionRole } from '../../app/roles.ts';
import { DEVICE_CONFIGURATION_READS, DEVICE_MANAGERS, offeredTo, POLICY_MANAGERS, Row, Select, words } from './shared.tsx';

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OPC = /^opc\.tcp:\/\/[!-~]{1,200}$/;
const POLICIES = ['Basic256Sha256', 'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsaPss'] as const;

export function DeviceConfigurationPage() {
  const q = useApiQuery(routes.deviceRegistry.configuration);
  const registry = useApiQuery(routes.deviceRegistry.list);
  const role = useSessionRole();
  const policy = offeredTo(role, POLICY_MANAGERS);
  const devices = offeredTo(role, DEVICE_MANAGERS);
  const v = q.data;
  const attested = (registry.data?.terminals ?? []).filter((t) => t.hardening !== null);
  return (
    <>
      <h1>Device configuration</h1>
      <p>How a kiosk attributes each entry, the hardening attestations of the kiosks, the identities of the OPC UA endpoints and the plant unit of each process device.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v ? <Attribution v={v} policy={policy} /> : null}
      <Section title="Kiosk hardening attestations" testId="hardening-attestations">
        {registry.data && attested.length === 0 ? <p>No kiosk holds a hardening attestation.</p> : null}
        <ul>
          {attested.map((t) => (
            <Attested key={t.deviceId} t={t} offered={policy} />
          ))}
        </ul>
      </Section>
      {v ? <Endpoints v={v} offered={devices} /> : null}
      {v ? <ProcessUnits v={v} offered={devices} /> : null}
    </>
  );
}

function Attribution({ v, policy }: { v: DeviceConfigurationView; policy: boolean }) {
  const set = useCommand(routes.deviceRegistry.setAttributionMethod, DEVICE_CONFIGURATION_READS, 'changing the attribution of a kiosk class');
  const [deviceClass, setDeviceClass] = useState('');
  const [method, setMethod] = useState('');
  const [reason, setReason] = useState('');
  return (
    <Section title="Per-entry attribution" testId="attribution">
      <ul>
        {v.attribution.map((a) => (
          <li key={a.deviceClass} data-testid={`attribution-${a.deviceClass}`}>
            {words(a.deviceClass)} kiosks: {a.method === 'TAP_PIN' ? 'a badge tap and a PIN' : 'a badge tap'} for each entry
          </li>
        ))}
      </ul>
      {policy ? (
        <>
          <Row>
            <Select name="attr-class" label="Kiosk class" value={deviceClass} onChange={setDeviceClass} options={[{ value: 'SHARED', label: 'Shared' }, { value: 'GRADE_A_B', label: 'Grade A/B' }]} />
            <Select name="attr-method" label="Attribution" value={method} onChange={setMethod} options={[{ value: 'TAP', label: 'Badge tap' }, { value: 'TAP_PIN', label: 'Badge tap and PIN' }]} />
          </Row>
          <Field name="attr-reason" label="Reason" value={reason} onChange={setReason} />
          <ActButton
            label="Set the attribution"
            disabled={deviceClass === '' || method === '' || reason.trim() === '' || set.busy}
            onPress={() =>
              set.run({ body: { deviceClass: deviceClass === 'GRADE_A_B' ? 'GRADE_A_B' : 'SHARED', method: method === 'TAP_PIN' ? 'TAP_PIN' : 'TAP', reason: reason.trim() } })
            }
          />
          <ActResult error={set.error} done={set.done} label="Set." />
        </>
      ) : null}
    </Section>
  );
}

function Attested({ t, offered }: { t: TerminalView; offered: boolean }) {
  const revoke = useCommand(routes.deviceRegistry.revokeHardening, DEVICE_CONFIGURATION_READS, 'revoking a hardening attestation');
  const [reason, setReason] = useState('');
  const h = t.hardening;
  if (!h) return null;
  return (
    <li data-testid={`attested-${t.code}`}>
      <p>
        {t.code} ({words(t.deviceClass)}): {words(h.result)} by {h.method === 'MANUAL_INSPECTION' ? 'inspection' : 'MDM report'} {h.evidenceRef}, attested by {h.attestedBy.legalName}
        {h.validUntil ? `, valid until ${h.validUntil.text}` : ''}.
      </p>
      {offered ? (
        <Row>
          <Field name={`revoke-${t.code}`} label={`Reason to revoke (${t.code})`} value={reason} onChange={setReason} />
          <ActButton label={`Revoke the attestation of ${t.code}`} primary={false} disabled={reason.trim() === '' || revoke.busy} onPress={() => revoke.run({ params: { attestationId: h.attestationId }, body: { reason: reason.trim() } })} />
        </Row>
      ) : null}
      <ActResult error={revoke.error} done={revoke.done} label="Revoked: the kiosk is no longer attested." />
    </li>
  );
}

function Endpoints({ v, offered }: { v: DeviceConfigurationView; offered: boolean }) {
  const enrol = useCommand(routes.deviceRegistry.enrolOpcuaEndpoint, DEVICE_CONFIGURATION_READS, 'enrolling an OPC UA endpoint');
  const [device, setDevice] = useState('');
  const [url, setUrl] = useState('');
  const [policy, setPolicy] = useState('');
  const [units, setUnits] = useState('');
  const [reason, setReason] = useState('');
  const unitList = units.split(',').map((u) => u.trim()).filter((u) => u !== '');
  const ok = CODE.test(device.trim()) && OPC.test(url.trim()) && policy !== '' && unitList.length > 0 && unitList.every((u) => CODE.test(u)) && reason.trim() !== '';
  return (
    <Section title="OPC UA endpoints" testId="opcua-endpoints">
      {v.opcuaEndpoints.length === 0 ? <p>No OPC UA endpoint is enrolled.</p> : null}
      <ul>
        {v.opcuaEndpoints.map((e) => (
          <Endpoint key={e.deviceCode} e={e} offered={offered} />
        ))}
      </ul>
      {offered ? (
        <>
          <h3>Enrol an endpoint</h3>
          <p>The endpoint is a registered instrument with its certificate thumbprint; its units are in its room or line.</p>
          <Row>
            <Field name="opc-device" label="Instrument code" value={device} onChange={setDevice} />
            <Field name="opc-url" label="Endpoint URL (opc.tcp://…)" value={url} onChange={setUrl} />
          </Row>
          <Select name="opc-policy" label="Security policy (SignAndEncrypt)" value={policy} onChange={setPolicy} options={POLICIES.map((p) => ({ value: p, label: p }))} />
          <Field name="opc-units" label="Units it serves (comma separated)" value={units} onChange={setUnits} />
          <Field name="opc-reason" label="Reason" value={reason} onChange={setReason} />
          <ActButton
            label="Enrol the endpoint"
            disabled={!ok || enrol.busy}
            onPress={() =>
              enrol.run({ body: { deviceCode: device.trim(), endpointUrl: url.trim(), securityPolicy: POLICIES.find((p) => p === policy) ?? 'Basic256Sha256', equipmentCodes: unitList, reason: reason.trim() } })
            }
          />
          <ActResult error={enrol.error} done={enrol.done} label="Enrolled." />
        </>
      ) : null}
    </Section>
  );
}

function Endpoint({ e, offered }: { e: OpcuaEndpointView; offered: boolean }) {
  const retire = useCommand(routes.deviceRegistry.retireOpcuaEndpoint, DEVICE_CONFIGURATION_READS, 'retiring an OPC UA endpoint');
  const [reason, setReason] = useState('');
  return (
    <li data-testid={`opcua-${e.deviceCode}`} data-status={e.status}>
      <p>
        {e.deviceCode} version {e.version.toString()}: {e.endpointUrl} ({e.securityPolicy}), units {e.equipmentCodes.join(', ') || 'none'}, certificate{' '}
        <code>{e.certificateThumbprint.slice(0, 16)}…</code>. <StatusChip tone={e.status === 'ENROLLED' ? 'ok' : 'neutral'} label={words(e.status)} /> {e.recordedBy.legalName},{' '}
        {e.recordedAt.text}: {e.reason}
      </p>
      {offered && e.status === 'ENROLLED' ? (
        <Row>
          <Field name={`opc-retire-${e.deviceCode}`} label={`Reason to retire (${e.deviceCode})`} value={reason} onChange={setReason} />
          <ActButton label={`Retire ${e.deviceCode}`} primary={false} disabled={reason.trim() === '' || retire.busy} onPress={() => retire.run({ params: { deviceCode: e.deviceCode }, body: { reason: reason.trim() } })} />
        </Row>
      ) : null}
      <ActResult error={retire.error} done={retire.done} label="Retired." />
    </li>
  );
}

function ProcessUnits({ v, offered }: { v: DeviceConfigurationView; offered: boolean }) {
  return (
    <Section title="Process devices and their plant units" testId="process-units">
      {v.processDeviceUnits.length === 0 ? <p>No process device is bound.</p> : null}
      <ul>
        {v.processDeviceUnits.map((p) => (
          <ProcessUnit key={p.bindingId} p={p} offered={offered} />
        ))}
      </ul>
    </Section>
  );
}

function ProcessUnit({ p, offered }: { p: DeviceConfigurationView['processDeviceUnits'][number]; offered: boolean }) {
  const link = useCommand(routes.deviceRegistry.linkProcessDeviceUnit, DEVICE_CONFIGURATION_READS, 'linking a process device to its unit');
  const [unit, setUnit] = useState('');
  const [reason, setReason] = useState('');
  return (
    <li data-testid={`process-unit-${p.deviceCode}`}>
      <p>
        {p.deviceCode}: {p.equipmentCode ? `unit ${p.equipmentCode}` : 'not linked to a unit yet'}
      </p>
      {offered && p.equipmentCode === null ? (
        <Row>
          <Field name={`unit-${p.bindingId}`} label={`Plant unit of ${p.deviceCode}`} value={unit} onChange={setUnit} />
          <Field name={`unit-reason-${p.bindingId}`} label="Reason" value={reason} onChange={setReason} />
          <ActButton
            label={`Link ${p.deviceCode}`}
            disabled={!CODE.test(unit.trim()) || reason.trim() === '' || link.busy}
            onPress={() => link.run({ params: { bindingId: p.bindingId }, body: { equipmentCode: unit.trim(), reason: reason.trim() } })}
          />
        </Row>
      ) : null}
      <ActResult error={link.error} done={link.done} label="Linked." />
    </li>
  );
}
