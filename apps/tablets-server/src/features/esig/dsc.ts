/**
 * The India DSC option over HTTP (Phase 6 slice 6f; IN-10, decision 0001 item 3; kernel 1203, 1205). The mode, the trust
 * anchor and the per-meaning setting are configuration: each change runs in the quality unit's own command under the
 * change record the request names (DI-09), and the database refuses LICENSED until a licensed CA or eSign provider is
 * configured after the legal opinion. While the anchor is a test CA, every screen shows TEST_CA_BANNER.
 */
import { X509Certificate } from 'node:crypto';
import type { DscConfigurationView, DscEnrolmentView, DscSubmission } from '@ebmr/api-contract';
import { esig, type ActorContext } from '@ebmr/kernel';
import type pg from 'pg';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { refusal } from '../../platform/http/refusal.ts';

type Mode = DscConfigurationView['mode'];

export async function dscConfiguration(db: Pick<pg.Pool, 'query'>): Promise<DscConfigurationView> {
  const { rows } = await db.query<{ r: { mode: Mode; anchors: { anchorId: string; kind: 'TEST_CA' | 'LICENSED'; label: string; subject: string; rootSha256: string; recordedAt: string; live: boolean }[]; meanings: { meaning: string; required: boolean }[] } }>(
    'select esig.dsc_configuration() as r',
  );
  const r = rows[0]?.r ?? { mode: 'OFF' as const, anchors: [], meanings: [] };
  return { mode: r.mode, banner: r.mode === 'TEST_CA' ? esig.TEST_CA_BANNER : null, anchors: r.anchors, meanings: r.meanings };
}

interface ChangeInput {
  changeRecord: string;
  reason: string;
}

const underChange = (actor: ActorContext, body: ChangeInput, code: string): ActorContext & { changeRecord: string } => ({
  ...actor,
  reasonCode: code,
  reasonText: body.reason,
  changeRecord: body.changeRecord,
});

export async function setDscMode(pool: pg.Pool, actor: ActorContext, key: string, hash: string, body: ChangeInput & { mode: Mode }): Promise<DscConfigurationView> {
  await withIdempotentActorCommand(pool, underChange(actor, body, 'DSC_CONFIGURATION'), key, hash, async (c) => {
    await c.query("select esig.set_policy('esig.india_dsc', $1, $2, $3)", [body.mode, body.reason, body.changeRecord]);
    return null;
  });
  return dscConfiguration(pool);
}

/** The root certificate's subject, read by the server (the database does not parse X.509). */
function subjectOf(der: Buffer): string {
  try {
    const cert = new X509Certificate(der);
    if (!cert.ca || !cert.verify(cert.publicKey)) throw new Error('not a self-signed CA certificate');
    return cert.subject.replace(/\n/g, ', ');
  } catch (error) {
    throw refusal(422, {
      code: 'EBMR-ESIG-080',
      kind: 'INVALID_INPUT',
      whatHappened: 'The trust anchor was not registered.',
      why: `The root certificate is not a self-signed certification-authority certificate (${error instanceof Error ? error.message : String(error)}).`,
      controls: ['IN-10'],
      whatYouCanDo: ['Upload the root certificate of the certifying authority, base64 DER.'],
    });
  }
}

export async function registerDscAnchor(
  pool: pg.Pool,
  actor: ActorContext,
  key: string,
  hash: string,
  body: ChangeInput & { kind: 'TEST_CA' | 'LICENSED'; label: string; rootCertificate: string },
): Promise<DscConfigurationView> {
  const der = Buffer.from(body.rootCertificate, 'base64');
  const subject = subjectOf(der);
  await withIdempotentActorCommand(pool, underChange(actor, body, 'DSC_CONFIGURATION'), key, hash, async (c) => {
    await c.query('select esig.register_dsc_anchor($1, $2, $3, $4, $5)', [body.kind, body.label, subject, der, body.reason]);
    return null;
  });
  return dscConfiguration(pool);
}

export async function setDscMeaning(pool: pg.Pool, actor: ActorContext, key: string, hash: string, body: ChangeInput & { meaning: string; required: boolean }): Promise<DscConfigurationView> {
  await withIdempotentActorCommand(pool, underChange(actor, body, 'DSC_CONFIGURATION'), key, hash, async (c) => {
    await c.query('select esig.set_dsc_meaning($1, $2, $3)', [body.meaning, body.required, body.reason]);
    return null;
  });
  return dscConfiguration(pool);
}

/**
 * The signed-in person's DSC enrolments (kernel 1206; review fix of IN-10): a DSC is accepted only from the certificate
 * enrolled for the signer. The statement is what their token signs to enrol; none while the option is off.
 */
export async function dscEnrolment(db: Pick<pg.Pool, 'query'>, personId: string, accountId: string): Promise<DscEnrolmentView> {
  const mode = (await dscConfiguration(db)).mode;
  const { rows } = await db.query<{ l: DscEnrolmentView['enrolments'] }>('select esig.dsc_enrolments_of($1) as l', [personId]);
  return {
    statement: mode === 'OFF' ? null : await esig.dscEnrolmentStatement(db, personId, accountId),
    banner: mode === 'TEST_CA' ? esig.TEST_CA_BANNER : null,
    enrolments: rows[0]?.l ?? [],
  };
}

/** Enrols the certificate of the person's own token, in their own command (the server verifies the proof first). */
export async function enrolDsc(pool: pg.Pool, actor: ActorContext, key: string, hash: string, body: { dsc: DscSubmission }): Promise<DscEnrolmentView> {
  await withIdempotentActorCommand(pool, { ...actor, reasonCode: 'DSC_ENROLMENT', reasonText: 'enrol the certificate of my own token' }, key, hash, async (c) => {
    await esig.enrolDsc(c, body.dsc);
    return null;
  });
  return dscEnrolment(pool, actor.personId, actor.accountId);
}

/** Ends an enrolment: the person's own, or anyone's by the quality unit. */
export async function endDscEnrolment(pool: pg.Pool, actor: ActorContext, key: string, hash: string, body: { enrolmentId: string; reason: string }): Promise<DscEnrolmentView> {
  await withIdempotentActorCommand(pool, { ...actor, reasonCode: 'DSC_ENROLMENT_END', reasonText: body.reason }, key, hash, async (c) => {
    await c.query('select esig.end_dsc_enrolment($1, $2)', [body.enrolmentId, body.reason]);
    return null;
  });
  return dscEnrolment(pool, actor.personId, actor.accountId);
}
