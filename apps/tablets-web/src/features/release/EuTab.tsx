/**
 * The EU tab of the release cockpit (Phase 4 slice 4c; outline 5.2.6; DI-30, DI-39, PR-55): the importer named in the
 * technical agreement, the certification register of the lot, and the certification intake:
 *  - a structured certification message signed by the importer, taken in as received (release.qpMessage): the database
 *    verifies it and the acknowledgement that goes back to the sender is shown (DI-39);
 *  - the transcribed fallback (QP_INTAKE): a QA person enters the certification as received; it counts only once a
 *    second person has verified it (QP_INTAKE_VERIFY, DI-30);
 *  - the in-system certification by a registered QP, only while its switch is on (QP_CERTIFY, PR-55);
 *  - the EU QP batch package: assembly, issue, the QP's time-boxed access (QpPackage.tsx).
 * Every state, gate and outcome is the server's; every signed act goes through esig.describe and the ceremony.
 */
import { useState } from 'react';
import { routes, type LotReleaseView } from '@ebmr/api-contract';
import { Banner, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { GateProblems } from '../review/parts.tsx';
import { QpPackageSection } from './QpPackage.tsx';
import { RELEASE_READS, words, type MarketDispositionView, type QpCertificationView } from './reads.ts';

const HEX64 = /^[0-9a-f]{64}$/;
const QP_OUTCOMES = ['CERTIFIED', 'REJECTED_BY_QP'] as const;
type QpOutcome = (typeof QP_OUTCOMES)[number];
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

/** `d` is null when EU was never in the lot's set: a structured message names its own lot, so it is taken in all the same. */
export function EuTab({ lot, d }: { lot: LotReleaseView; d: MarketDispositionView | null }) {
  const qa = useOffered('QA');
  const qp = useOffered('EU_QP');
  return (
    <>
      <Importer lot={lot} />
      {d ? <QpPackageSection lot={lot} offered={qa} /> : null}
      {d ? <Certifications lot={lot} d={d} offered={qa} /> : null}
      {qa ? <MessageIntake /> : null}
      {d && qa ? <TranscribedIntake lot={lot} /> : null}
      {d?.inSystemQp && qp ? <InSystemCertification lot={lot} d={d} /> : null}
    </>
  );
}

function Importer({ lot }: { lot: LotReleaseView }) {
  const q = useApiQuery(routes.release.importers, {});
  const named = (q.data?.importers ?? []).filter((i) => i.products.includes(lot.productCode));
  return (
    <Section title="EU importer" testId="eu-importer">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && named.length === 0 ? <p>No EU importer is named for {lot.productCode} in a technical agreement.</p> : null}
      <ul>
        {named.map((i) => (
          <li key={i.importerId}>
            {i.code} {i.name}: technical agreement {i.technicalAgreementRef}, MIA {i.miaNumber}, message key fingerprint {i.keyFingerprint}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function sourceWord(s: QpCertificationView['source']): string {
  return s === 'MESSAGE' ? 'structured message' : s === 'TRANSCRIBED' ? 'transcribed' : 'in-system QP';
}

function Certifications({ lot, d, offered }: { lot: LotReleaseView; d: MarketDispositionView; offered: boolean }) {
  const verify = useSignedAct(RELEASE_READS);
  return (
    <Section title="QP certifications of the lot" testId="eu-certifications">
      {d.certifications.length === 0 ? <p>No certification is recorded yet.</p> : null}
      <ul>
        {d.certifications.map((c) => (
          <li key={c.certificationId} data-testid={`certification-${c.reference}`} data-verified={String(c.verified)}>
            <StatusChip tone={c.outcome === 'CERTIFIED' ? 'ok' : 'error'} label={words(c.outcome)} /> {c.certifier}, MIA {c.miaNumber}, {c.certifiedAt.text}, reference {c.reference}
            {c.importerCode ? `, importer ${c.importerCode}` : ''} ({sourceWord(c.source)})
            {c.reason ? `: ${c.reason}` : ''}
            {c.recordedBy ? ` · recorded by ${c.recordedBy.legalName}` : ''}
            {c.verifiedBy ? ` · verified by ${c.verifiedBy.legalName}` : ''}{' '}
            {c.verified ? null : <StatusChip tone="pending" label="Waiting for a second person's verification" />}
            {!c.verified && offered ? (
              <ActButton
                primary={false}
                label={`Verify transcription ${c.reference}`}
                onPress={() =>
                  verify.sign(
                    { kind: 'RELEASE_ACT', act: 'QP_INTAKE_VERIFY', lotId: lot.lotId, input: { intakeId: c.certificationId } },
                    `Verify the transcribed certification ${c.reference} (${words(c.outcome)}, ${c.certifier}, MIA ${c.miaNumber}) of lot ${lot.lotCode} against the original`,
                  )
                }
                disabled={verify.busy}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <ActResult error={verify.error} outcome={verify.outcome} />
    </Section>
  );
}

/** A structured message as received, with the importer's signature; the database verifies both (DI-39). */
function MessageIntake() {
  const [message, setMessage] = useState('');
  const [signature, setSignature] = useState('');
  const send = useCommand(routes.release.qpMessage, RELEASE_READS, 'taking in the certification message');
  const ack = send.done;
  const sig = signature.trim();
  return (
    <Section title="Certification message from the importer" testId="qp-message">
      <p>Load the message file as received (its bytes are what the importer signed) and paste the importer's signature. The database checks the signature against the importer's key, and the acknowledgement below goes back to the sender.</p>
      <label>
        Message file{' '}
        <input
          type="file"
          accept=".json,application/json"
          aria-label="Message file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void f.text().then(setMessage);
          }}
        />
      </label>
      <div>
        <label htmlFor="qp-message-text">Message as received</label>
        <textarea id="qp-message-text" value={message} onChange={(e) => setMessage(e.target.value)} rows={6} style={{ display: 'block', inlineSize: '100%' }} />
      </div>
      <Field name="qpMessageSignature" label="Importer's signature (base64)" value={signature} onChange={setSignature} />
      <ActButton label="Take in the message" onPress={() => send.run({ body: { message, signature: sig } })} disabled={message.length < 2 || !SIGNATURE.test(sig) || send.busy} />
      {send.error ? <RefusalMessage error={send.error} /> : null}
      {ack ? (
        <Banner tone={ack.outcome === 'ACCEPTED' ? 'ok' : 'error'} title={ack.outcome === 'ACCEPTED' ? 'Message accepted; acknowledgement sent' : 'Message refused; acknowledgement sent'} live="polite">
          <p data-testid="qp-ack">
            Message {ack.messageId}, SHA-256 {ack.messageSha256}, received {ack.receivedAt.text}
            {ack.reason ? `: ${ack.reason}` : ''}
          </p>
        </Banner>
      ) : null}
    </Section>
  );
}

/** The fallback: the certification as received outside a structured message, transcribed (DI-30). */
function TranscribedIntake({ lot }: { lot: LotReleaseView }) {
  const [outcome, setOutcome] = useState('');
  const [certifier, setCertifier] = useState('');
  const [mia, setMia] = useState('');
  const [at, setAt] = useState('');
  const [reference, setReference] = useState('');
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const signed = useSignedAct(RELEASE_READS);
  const o: QpOutcome | undefined = QP_OUTCOMES.find((x) => x === outcome);
  const reason = code.trim() && text.trim() ? { code: code.trim(), text: text.trim() } : null;
  const filled = o !== undefined && certifier.trim() !== '' && mia.trim() !== '' && at.trim() !== '' && reference.trim() !== '' && (o === 'CERTIFIED' || reason !== null);
  const certification = { certifier: certifier.trim(), miaNumber: mia.trim(), certifiedAt: at.trim(), reference: reference.trim() };
  return (
    <Section title="Transcribe a certification" testId="qp-transcribe">
      <p>Only when the certification did not arrive as a structured message: enter it exactly as received. It counts once a second person has verified it against the original.</p>
      <floor.ChoiceGroup label="Outcome" options={QP_OUTCOMES.map((x) => ({ value: x, label: words(x) }))} value={outcome} onChange={setOutcome} />
      <Field name="qpCertifier" label="Qualified person" value={certifier} onChange={setCertifier} />
      <Field name="qpMia" label="MIA number" value={mia} onChange={setMia} />
      <Field name="qpCertifiedAt" label="Certified at (as written, with its offset, e.g. 2026-10-03T09:20:00+02:00)" value={at} onChange={setAt} />
      <Field name="qpReference" label="Certification reference" value={reference} onChange={setReference} />
      {o === 'REJECTED_BY_QP' ? (
        <>
          <Field name="qpReasonCode" label="Reason code" value={code} onChange={setCode} />
          <Field name="qpReasonText" label="The QP's reason, as written" value={text} onChange={setText} />
        </>
      ) : null}
      <ActButton
        label="Sign the transcription"
        onPress={() =>
          o &&
          signed.sign(
            { kind: 'RELEASE_ACT', act: 'QP_INTAKE', lotId: lot.lotId, input: { qpOutcome: o, certification, ...(o === 'REJECTED_BY_QP' && reason ? { reason } : {}) } },
            `Transcribed QP certification of lot ${lot.lotCode}: ${words(o)} by ${certification.certifier} (MIA ${certification.miaNumber}) at ${certification.certifiedAt}, reference ${certification.reference}`,
          )
        }
        disabled={!filled || signed.busy}
      />
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}

/** PR-55: a registered QP certifies here, only while the in-system QP switch is on. */
function InSystemCertification({ lot, d }: { lot: LotReleaseView; d: MarketDispositionView }) {
  const [outcome, setOutcome] = useState('');
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const signed = useSignedAct(RELEASE_READS);
  const g = d.grel;
  if (!g) return null;
  const epoch = HEX64.test(g.epoch) ? g.epoch : null;
  const o: QpOutcome | undefined = QP_OUTCOMES.find((x) => x === outcome);
  const reason = code.trim() && text.trim() ? { code: code.trim(), text: text.trim() } : null;
  return (
    <Section title="Certify as the qualified person" testId="qp-certify">
      <GateProblems gate={d.gates.certify} testId="qp-certify-problems" />
      <p>You sign G-REL for EU above as it stands now (evidence epoch {g.epoch}).</p>
      <floor.ChoiceGroup label="Certification outcome" options={QP_OUTCOMES.map((x) => ({ value: x, label: words(x) }))} value={outcome} onChange={setOutcome} isDisabled={!d.gates.certify.ready} />
      {o === 'REJECTED_BY_QP' ? (
        <>
          <Field name="qpCertifyCode" label="Reason code" value={code} onChange={setCode} />
          <Field name="qpCertifyText" label="Reason for the rejection" value={text} onChange={setText} />
        </>
      ) : null}
      <ActButton
        label="Sign the certification"
        onPress={() =>
          o &&
          epoch &&
          signed.sign(
            { kind: 'RELEASE_ACT', act: 'QP_CERTIFY', lotId: lot.lotId, input: { qpOutcome: o, expectedEpoch: epoch, ...(o === 'REJECTED_BY_QP' && reason ? { reason } : {}) } },
            `${words(o)}: lot ${lot.lotCode} for the EU at evidence epoch ${g.epoch}`,
          )
        }
        disabled={!d.gates.certify.ready || o === undefined || epoch === null || (o === 'REJECTED_BY_QP' && reason === null) || signed.busy}
      />
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}
