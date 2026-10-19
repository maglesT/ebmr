/**
 * The device registry (Phase 7 slice 7g-1, decision 0025; routes deviceRegistry.*): terminals and devices with their
 * class, room and key fingerprint; the hardening attestation of a shared or Grade A/B kiosk; the gateway's signing key;
 * balances, printers and process equipment bound behind a gateway key; integration adapters and the OPC UA feed binding
 * of slice 7a. The database decides every act (IAM.DEVICE_MANAGE, CONTINUITY.HARDENING_ATTEST; a fingerprint that is not
 * the key's, a device that is not a registered instrument, a second adapter on one gateway's feed are refused with its
 * words). Only public key material is shown.
 */
import { useState } from 'react';
import { routes, type AdapterView, type BoundDeviceView, type DeviceRegistryView, type GatewayKeyView, type TerminalView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useSessionRole } from '../../app/roles.ts';
import { ADMINISTRATORS, Check, DEVICE_MANAGERS, DEVICE_READS, offeredTo, Row, Select, SUMMARY_STYLE, words } from './shared.tsx';

const CLASSES = ['PERSONAL', 'SHARED', 'GRADE_A_B', 'SERVER', 'INSTRUMENT'] as const;
const PRINT_KINDS = ['PRINTER', 'READER', 'VISION', 'CHECKWEIGHER', 'LEAFLET_DETECTOR'] as const;
const PROCESS_KINDS = ['BLENDER', 'BLISTER_MACHINE', 'BOTTLE_LINE', 'CARTONER', 'COATER', 'DRYER', 'GRANULATOR', 'PRESS', 'ROLLER_COMPACTOR'] as const;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const short = (fp: string) => `${fp.slice(0, 12)}…${fp.slice(-8)}`;

export function DevicesPage() {
  const q = useApiQuery(routes.deviceRegistry.list);
  const role = useSessionRole();
  const manager = offeredTo(role, DEVICE_MANAGERS);
  const data = q.data;
  return (
    <>
      <h1>Terminals and devices</h1>
      <p>
        Every terminal, balance, printer and gateway that takes part in GMP work is registered. A terminal proves itself on every request with its own key; its class decides how people
        sign in and how each entry is attributed. A shared or Grade A/B kiosk works only with a current hardening attestation.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {manager ? <RegisterTerminal /> : null}
      {data ? (
        <>
          <Section title="Registered terminals and devices" testId="terminals">
            <ul>
              {data.terminals.map((t) => (
                <Terminal key={t.deviceId} t={t} role={role} />
              ))}
            </ul>
          </Section>
          <GatewayKeys data={data} manager={manager} />
          <Bindings data={data} manager={manager} />
          <Adapters data={data} manager={manager} />
        </>
      ) : null}
    </>
  );
}

function RegisterTerminal() {
  const reg = useCommand(routes.deviceRegistry.registerTerminal, DEVICE_READS);
  const [code, setCode] = useState('');
  const [cls, setCls] = useState('PERSONAL');
  const [room, setRoom] = useState('');
  const [line, setLine] = useState('');
  const [fp, setFp] = useState('');
  const [description, setDescription] = useState('');
  const ok = code.trim() !== '' && cls !== '' && FINGERPRINT.test(fp.trim()) && description.trim() !== '';
  return (
    <Section title="Register a terminal or device" testId="terminal-register">
      <Row>
        <Field name="devCode" label="Code" value={code} onChange={setCode} />
        <Select name="devClass" label="Class" value={cls} onChange={setCls} options={CLASSES.map((c) => ({ value: c, label: words(c) }))} />
        <Field name="devRoom" label="Room (kiosks, Grade A/B and instruments)" value={room} onChange={setRoom} />
        <Field name="devLine" label="Line (optional)" value={line} onChange={setLine} />
      </Row>
      <Field name="devFingerprint" label="Key fingerprint (SHA-256 of the public key, 64 hexadecimal digits)" value={fp} onChange={setFp} />
      <Field name="devDescription" label="Description" value={description} onChange={setDescription} />
      <ActButton
        label="Register the device"
        disabled={!ok || reg.busy}
        onPress={() =>
          ok
            ? reg.run({
                body: {
                  code: code.trim(),
                  deviceClass: cls as (typeof CLASSES)[number],
                  ...(room.trim() ? { room: room.trim() } : {}),
                  ...(line.trim() ? { line: line.trim() } : {}),
                  fingerprint: fp.trim(),
                  description: description.trim(),
                },
              })
            : null
        }
      />
      <ActResult error={reg.error} done={reg.done} label="Registered." />
    </Section>
  );
}

function Terminal({ t, role }: { t: TerminalView; role: string | null }) {
  const manager = offeredTo(role, DEVICE_MANAGERS);
  const relocate = useCommand(routes.deviceRegistry.relocateTerminal, DEVICE_READS);
  const status = useCommand(routes.deviceRegistry.setTerminalStatus, DEVICE_READS);
  const [room, setRoom] = useState('');
  const [line, setLine] = useState('');
  const [reason, setReason] = useState('');
  const r = reason.trim();
  return (
    <li data-testid={`terminal-${t.code}`} data-status={t.status} style={{ marginBlock: '0.75rem' }}>
      <p>
        <strong>{t.code}</strong> ({words(t.deviceClass)}
        {t.roomCode ? `, room ${t.roomCode}` : ''}
        {t.lineCode ? `, line ${t.lineCode}` : ''}): {t.description}. Key {short(t.fingerprint)}. <StatusChip tone={t.status === 'ACTIVE' ? 'ok' : 'neutral'} label={words(t.status)} />{' '}
        {t.hardeningRequired ? (
          t.hardening ? (
            <StatusChip
              tone={t.hardening.result === 'PASS' ? 'ok' : 'error'}
              label={`${t.hardening.result === 'PASS' ? 'Hardening attested' : 'Hardening check failed'} (${t.hardening.evidenceRef}${t.hardening.validUntil ? `, until ${t.hardening.validUntil.text}` : ''})`}
            />
          ) : (
            <StatusChip tone="warning" label="No hardening attestation" />
          )
        ) : null}
      </p>
      {manager && t.status !== 'DECOMMISSIONED' ? (
        <details>
          <summary style={SUMMARY_STYLE}>Change {t.code}</summary>
          <Row>
            <Field name={`reloRoom-${t.deviceId}`} label="New room" value={room} onChange={setRoom} />
            <Field name={`reloLine-${t.deviceId}`} label="New line" value={line} onChange={setLine} />
          </Row>
          <Field name={`devReason-${t.deviceId}`} label={`Reason (${t.code})`} value={reason} onChange={setReason} />
          <Row>
            <ActButton
              label={`Move ${t.code}`}
              disabled={r === '' || (room.trim() === '' && line.trim() === '') || relocate.busy}
              onPress={() => relocate.run({ params: { deviceId: t.deviceId }, body: { ...(room.trim() ? { room: room.trim() } : {}), ...(line.trim() ? { line: line.trim() } : {}), reason: r } })}
            />
            {t.status === 'ACTIVE' ? <ActButton primary={false} label={`Block ${t.code}`} disabled={r === '' || status.busy} onPress={() => status.run({ params: { deviceId: t.deviceId }, body: { status: 'BLOCKED', reason: r } })} /> : null}
            {t.status === 'BLOCKED' ? <ActButton primary={false} label={`Re-activate ${t.code}`} disabled={r === '' || status.busy} onPress={() => status.run({ params: { deviceId: t.deviceId }, body: { status: 'ACTIVE', reason: r } })} /> : null}
            <ActButton primary={false} label={`Decommission ${t.code}`} disabled={r === '' || status.busy} onPress={() => status.run({ params: { deviceId: t.deviceId }, body: { status: 'DECOMMISSIONED', reason: r } })} />
          </Row>
          <ActResult error={relocate.error ?? status.error} done={relocate.done ?? status.done} />
        </details>
      ) : null}
      {offeredTo(role, ADMINISTRATORS) && t.hardeningRequired && t.status === 'ACTIVE' ? <AttestHardening t={t} /> : null}
    </li>
  );
}

function AttestHardening({ t }: { t: TerminalView }) {
  const attest = useCommand(routes.deviceRegistry.attestHardening, DEVICE_READS);
  const [usb, setUsb] = useState(false);
  const [kiosk, setKiosk] = useState(false);
  const [malware, setMalware] = useState(false);
  const [patch, setPatch] = useState(false);
  const [method, setMethod] = useState('MDM_COMPLIANCE_REPORT');
  const [evidence, setEvidence] = useState('');
  const [build, setBuild] = useState('');
  const ok = method !== '' && evidence.trim() !== '';
  return (
    <details>
      <summary style={SUMMARY_STYLE}>Attest the hardening of {t.code}</summary>
      <p>State what was checked; the database records the result (a check not met is recorded as failed and the kiosk does not open sessions).</p>
      <Check name={`hUsb-${t.deviceId}`} label="USB mass storage is blocked" checked={usb} onChange={setUsb} />
      <Check name={`hKiosk-${t.deviceId}`} label="Kiosk mode is enforced" checked={kiosk} onChange={setKiosk} />
      <Check name={`hMalware-${t.deviceId}`} label="Malware protection is active" checked={malware} onChange={setMalware} />
      <Check name={`hPatch-${t.deviceId}`} label="Operating-system patches are within the agreed time" checked={patch} onChange={setPatch} />
      <Row>
        <Select name={`hMethod-${t.deviceId}`} label="How it was checked" value={method} onChange={setMethod} options={[{ value: 'MDM_COMPLIANCE_REPORT', label: 'Device-management compliance report' }, { value: 'MANUAL_INSPECTION', label: 'Manual inspection' }]} />
        <Field name={`hEvidence-${t.deviceId}`} label="Evidence reference" value={evidence} onChange={setEvidence} />
        <Field name={`hBuild-${t.deviceId}`} label="Operating-system build (optional)" value={build} onChange={setBuild} />
      </Row>
      <ActButton
        label={`Record the attestation of ${t.code}`}
        disabled={!ok || attest.busy}
        onPress={() =>
          ok
            ? attest.run({
                params: { deviceId: t.deviceId },
                body: { usbMassStorageBlocked: usb, kioskModeEnforced: kiosk, malwareProtectionActive: malware, osPatchWithinSla: patch, method: method === 'MANUAL_INSPECTION' ? 'MANUAL_INSPECTION' : 'MDM_COMPLIANCE_REPORT', evidenceRef: evidence.trim(), ...(build.trim() ? { osBuild: build.trim() } : {}) },
              })
            : null
        }
      />
      <ActResult error={attest.error} done={attest.done} label="Attestation recorded." />
    </details>
  );
}

function GatewayKeys({ data, manager }: { data: DeviceRegistryView; manager: boolean }) {
  const enrol = useCommand(routes.deviceRegistry.enrolGatewayKey, DEVICE_READS);
  const [gateway, setGateway] = useState('');
  const [spki, setSpki] = useState('');
  const [login, setLogin] = useState('');
  const servers = data.terminals.filter((t) => t.deviceClass === 'SERVER' && t.status === 'ACTIVE');
  const ok = gateway !== '' && /^[A-Za-z0-9_+/-]+={0,2}$/.test(spki.trim()) && login !== '';
  return (
    <Section title="Gateway signing keys" testId="gateway-keys">
      <p>A gateway signs every envelope of its feed and every reading with its Ed25519 key. Its SERVER device is registered with the key's fingerprint; the key enrolled here must match it.</p>
      {manager ? (
        <div data-testid="gateway-key-enrol">
          <Row>
            <Select name="gkGateway" label="Gateway (SERVER device)" value={gateway} onChange={setGateway} options={servers.map((s) => ({ value: s.code, label: `${s.code}: ${s.description}` }))} />
            <Select name="gkLogin" label="Its INTEGRATION login" value={login} onChange={setLogin} options={data.integrationAccounts.map((a) => ({ value: a.loginName, label: `${a.loginName} (${words(a.status)})` }))} />
          </Row>
          <Field name="gkSpki" label="Public key (SPKI DER, base64)" value={spki} onChange={setSpki} />
          <ActButton label="Enrol the key" disabled={!ok || enrol.busy} onPress={() => (ok ? enrol.run({ body: { gatewayCode: gateway, publicKeySpki: spki.trim(), loginName: login } }) : null)} />
          <ActResult error={enrol.error} done={enrol.done} label="Key enrolled." />
        </div>
      ) : null}
      <ul>
        {data.gatewayKeys.map((k) => (
          <GatewayKey key={k.keyId} k={k} manager={manager} />
        ))}
      </ul>
    </Section>
  );
}

function GatewayKey({ k, manager }: { k: GatewayKeyView; manager: boolean }) {
  const revoke = useCommand(routes.deviceRegistry.revokeGatewayKey, DEVICE_READS);
  const [reason, setReason] = useState('');
  return (
    <li data-testid={`gateway-key-${k.gatewayCode}`} data-status={k.status}>
      {k.gatewayCode} ({k.loginName}), key {short(k.fingerprint)}, enrolled by {k.enrolledBy.legalName} on {k.enrolledAt.text}. <StatusChip tone={k.status === 'ACTIVE' ? 'ok' : 'neutral'} label={words(k.status)} />
      {k.revokedAt ? ` Revoked on ${k.revokedAt.text}: ${k.revokedReason ?? ''}.` : ''}
      {manager && k.status === 'ACTIVE' ? (
        <Row>
          <Field name={`gkRevoke-${k.keyId}`} label={`Reason to revoke the key of ${k.gatewayCode}`} value={reason} onChange={setReason} />
          <ActButton primary={false} label={`Revoke the key of ${k.gatewayCode}`} disabled={reason.trim() === '' || revoke.busy} onPress={() => revoke.run({ params: { keyId: k.keyId }, body: { reason: reason.trim() } })} />
        </Row>
      ) : null}
      <ActResult error={revoke.error} done={revoke.done} label="Key revoked." />
    </li>
  );
}

function Bindings({ data, manager }: { data: DeviceRegistryView; manager: boolean }) {
  const bind = useCommand(routes.deviceRegistry.bindDevice, DEVICE_READS);
  const [kind, setKind] = useState('BALANCE');
  const [key, setKey] = useState('');
  const [device, setDevice] = useState('');
  const [serial, setSerial] = useState('');
  const [unit, setUnit] = useState('kg');
  const [resolution, setResolution] = useState('');
  const [deviceKind, setDeviceKind] = useState('');
  const keys = data.gatewayKeys.filter((k) => k.status === 'ACTIVE');
  const instruments = data.terminals.filter((t) => t.deviceClass === 'INSTRUMENT' && t.status === 'ACTIVE');
  const balance = kind === 'BALANCE';
  const ok = kind !== '' && key !== '' && device !== '' && /^[!#-~]{1,32}$/.test(serial.trim()) && (balance ? unit.trim() !== '' && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(resolution.trim()) : deviceKind !== '');
  return (
    <Section title="Balances, printers and equipment behind a gateway" testId="device-bindings">
      <p>A balance reading is accepted only from a bound balance whose check is current; the reading keeps its raw text as the balance sent it.</p>
      {manager ? (
        <div data-testid="device-bind">
          <Row>
            <Select name="bindKind" label="Kind" value={kind} onChange={setKind} options={[{ value: 'BALANCE', label: 'Balance' }, { value: 'PRINT', label: 'Printer, reader or inspection device' }, { value: 'PROCESS', label: 'Process equipment' }]} />
            <Select name="bindKey" label="Gateway key" value={key} onChange={setKey} options={keys.map((k) => ({ value: k.keyId, label: `${k.gatewayCode} (${short(k.fingerprint)})` }))} />
            <Select name="bindDevice" label="Instrument (registered INSTRUMENT)" value={device} onChange={setDevice} options={instruments.map((t) => ({ value: t.code, label: `${t.code}: ${t.description}` }))} />
            <Field name="bindSerial" label="Serial" value={serial} onChange={setSerial} />
          </Row>
          {balance ? (
            <Row>
              <Field name="bindUnit" label="Unit" value={unit} onChange={setUnit} />
              <Field name="bindResolution" label="Resolution (e.g. 0.001)" value={resolution} onChange={setResolution} inputMode="decimal" />
            </Row>
          ) : (
            <Select name="bindDeviceKind" label="Device kind" value={deviceKind} onChange={setDeviceKind} options={(kind === 'PRINT' ? PRINT_KINDS : PROCESS_KINDS).map((k) => ({ value: k, label: words(k) }))} />
          )}
          <ActButton
            label="Bind the device"
            disabled={!ok || bind.busy}
            onPress={() =>
              ok
                ? bind.run({
                    body: {
                      kind: kind as 'BALANCE' | 'PRINT' | 'PROCESS',
                      gatewayKeyId: key,
                      deviceCode: device,
                      serial: serial.trim(),
                      ...(balance ? { unit: unit.trim(), resolution: resolution.trim() } : { deviceKind }),
                    },
                  })
                : null
            }
          />
          <ActResult error={bind.error} done={bind.done} label="Bound." />
        </div>
      ) : null}
      <ul>
        {data.bindings.map((b) => (
          <Binding key={`${b.kind}-${b.bindingId}`} b={b} manager={manager} />
        ))}
      </ul>
    </Section>
  );
}

function Binding({ b, manager }: { b: BoundDeviceView; manager: boolean }) {
  const end = useCommand(routes.deviceRegistry.endBinding, DEVICE_READS);
  const [reason, setReason] = useState('');
  return (
    <li data-testid={`binding-${b.deviceCode}`} data-ended={b.endedAt ? 'yes' : 'no'}>
      {words(b.kind)} {b.deviceCode} behind {b.gatewayCode}, serial {b.serial} ({b.detail}), bound by {b.boundBy.legalName} on {b.boundAt.text}.
      {b.endedAt ? ` Ended on ${b.endedAt.text}: ${b.endedReason ?? ''}.` : ''}
      {manager && !b.endedAt ? (
        <Row>
          <Field name={`endBind-${b.bindingId}`} label={`Reason to end the binding of ${b.deviceCode}`} value={reason} onChange={setReason} />
          <ActButton primary={false} label={`End the binding of ${b.deviceCode}`} disabled={reason.trim() === '' || end.busy} onPress={() => end.run({ params: { bindingId: b.bindingId }, body: { kind: b.kind, reason: reason.trim() } })} />
        </Row>
      ) : null}
      <ActResult error={end.error} done={end.done} label="Binding ended." />
    </li>
  );
}

function Adapters({ data, manager }: { data: DeviceRegistryView; manager: boolean }) {
  const register = useCommand(routes.deviceRegistry.registerAdapter, DEVICE_READS);
  const [code, setCode] = useState('');
  const [source, setSource] = useState('');
  const [account, setAccount] = useState('');
  const [device, setDevice] = useState('');
  const [description, setDescription] = useState('');
  const servers = data.terminals.filter((t) => t.deviceClass === 'SERVER' && t.status === 'ACTIVE');
  const ok = code.trim() !== '' && source !== '' && account !== '' && device !== '' && description.trim() !== '';
  return (
    <Section title="Integration adapters" testId="adapters">
      <p>An adapter runs under its own INTEGRATION account on a registered SERVER device. An OPC UA adapter pulls the signed feed of one gateway; a gateway's feed is pulled by one adapter.</p>
      {manager ? (
        <div data-testid="adapter-register">
          <Row>
            <Field name="adCode" label="Adapter code (capitals, digits, - or _)" value={code} onChange={setCode} />
            <Select name="adSource" label="Source system" value={source} onChange={setSource} options={data.sourceSystems.map((s) => ({ value: s, label: s }))} />
            <Select name="adAccount" label="INTEGRATION account" value={account} onChange={setAccount} options={data.integrationAccounts.map((a) => ({ value: a.accountId, label: a.loginName }))} />
            <Select name="adDevice" label="SERVER device" value={device} onChange={setDevice} options={servers.map((s) => ({ value: s.deviceId, label: s.code }))} />
          </Row>
          <Field name="adDescription" label="Description" value={description} onChange={setDescription} />
          <ActButton label="Register the adapter" disabled={!ok || register.busy} onPress={() => (ok ? register.run({ body: { code: code.trim(), sourceSystem: source, accountId: account, deviceId: device, description: description.trim() } }) : null)} />
          <ActResult error={register.error} done={register.done} label="Adapter registered." />
        </div>
      ) : null}
      <ul>
        {data.adapters.map((a) => (
          <Adapter key={a.adapterId} a={a} manager={manager} gateways={[...new Set(data.gatewayKeys.filter((k) => k.status === 'ACTIVE').map((k) => k.gatewayCode))]} />
        ))}
      </ul>
    </Section>
  );
}

function Adapter({ a, manager, gateways }: { a: AdapterView; manager: boolean; gateways: readonly string[] }) {
  const bind = useCommand(routes.deviceRegistry.bindGatewayFeed, DEVICE_READS);
  const [gateway, setGateway] = useState('');
  const [reason, setReason] = useState('');
  const ok = gateway !== '' && reason.trim() !== '';
  return (
    <li data-testid={`adapter-${a.code}`}>
      <strong>{a.code}</strong> ({a.sourceSystem}) under {a.loginName} on {a.deviceCode}: {a.description}. <StatusChip tone={a.status === 'ACTIVE' ? 'ok' : 'neutral'} label={words(a.status)} />{' '}
      {a.sourceSystem === 'OPCUA' ? (a.feed ? `Feed of gateway ${a.feed.gatewayCode}, bound by ${a.feed.boundBy.legalName} on ${a.feed.boundAt.text}.` : 'No gateway feed bound.') : null}
      {manager && a.sourceSystem === 'OPCUA' && a.status === 'ACTIVE' ? (
        <Row>
          <Select name={`feedGateway-${a.adapterId}`} label={`Gateway whose feed ${a.code} pulls`} value={gateway} onChange={setGateway} options={gateways.map((g) => ({ value: g, label: g }))} />
          <Field name={`feedReason-${a.adapterId}`} label={`Reason (${a.code})`} value={reason} onChange={setReason} />
          <ActButton label={`Bind the feed of ${a.code}`} disabled={!ok || bind.busy} onPress={() => (ok ? bind.run({ body: { adapterCode: a.code, gatewayCode: gateway, reason: reason.trim() } }) : null)} />
        </Row>
      ) : null}
      <ActResult error={bind.error} done={bind.done} label="Feed bound." />
    </li>
  );
}
