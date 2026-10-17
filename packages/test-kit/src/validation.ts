/**
 * The validation-summary approval and the approved system description of a test installation, through real signed
 * acts (Phase 7 slice 7-0; kernel 1300; interfaces slice-7-0-interfaces.md section 4; D-P7-12).
 *
 * Slice 7c makes a GMP batch issue need an approved validation summary of the running release (DI-03) and refuses an
 * interface missing from the approved system description (DI-06). GMP test databases, the golden set-ups and the
 * browser set-up approve both with these helpers, as QA and the system owner would:
 * - `approveValidationSummary`: a QA person signs VALIDATION_SUMMARY_APPROVED over the running release and the
 *   summary's SHA-256, then records the approval with that signature.
 * - `approveSystemDescription`: the system owner raises a change record for SYSTEM_DESCRIPTION, a QA person approves it
 *   with a CONFIG_CHANGE_APPROVED signature, the system owner records each interface under it, and closes it.
 *
 * The people are given as `ValidationActs` (a QA person who can sign, and the system owner), so the kernel's tests, the
 * server's feature seed (FeatureSeedContext.signAs) and seeded sites (`seededValidationActs`) all use the same steps.
 * Every key and secret made here is DEMO-ONLY.
 */
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { config, esig, identity, withCommand, type ActorContext } from '@ebmr/kernel';
import type { DatabaseHandle } from './db.ts';
import { openPersonaSession, passwordActor, personaOf, terminalOf, type SiteSeed } from './seed.ts';

export type SignFn = (aggregate: { type: string; id: string }, meaning: string, expectedState: string | null) => Promise<string>;

export interface ValidationActs {
  /** The application pool commands run on. */
  app: pg.Pool;
  /** A QA person (holding VALIDATION.APPROVE_SUMMARY and CONFIG.CHANGE_APPROVE): a fresh command context. */
  qa(): Promise<ActorContext>;
  /** That QA person's electronic signature through the kernel's ceremony. */
  qaSign: SignFn;
  /** The system owner (holding CONFIG.CHANGE_RAISE, CONFIG.CHANGE_CLOSE and CONFIG.SYSTEM_DESCRIPTION). */
  systemOwner(): Promise<ActorContext>;
}

export interface ApprovedSummary {
  id: string;
  schemaRelease: string;
  summarySha256: string;
}

const reason = (ctx: ActorContext, text: string): ActorContext => ({ ...ctx, reasonCode: 'TEST_SETUP', reasonText: text });

/**
 * Approves a validation summary of the running release. Without `summarySha256`, the summary is a fixed test text
 * naming the release, so the same release gives the same hash.
 */
export async function approveValidationSummary(
  acts: ValidationActs,
  opts: { summarySha256?: string; title?: string } = {},
): Promise<ApprovedSummary> {
  const schemaRelease = await (async () => {
    const c = await acts.app.connect();
    try {
      return await config.schemaRelease(c);
    } finally {
      c.release();
    }
  })();
  const summarySha256 =
    opts.summarySha256 ?? createHash('sha256').update(`TEST validation summary of release ${schemaRelease} (DEMO-ONLY)`, 'utf8').digest('hex');
  const signatureId = await acts.qaSign(
    { type: config.VALIDATION_SUMMARY_AGGREGATE, id: config.validationSummaryAggregateId(schemaRelease, summarySha256) },
    config.VALIDATION_SUMMARY_MEANING,
    'PROPOSED',
  );
  const qa = reason(await acts.qa(), 'test installation: approve the validation summary of the running release');
  const id = await withCommand(acts.app, qa, (c) =>
    config.approveValidationSummary(c, { schemaRelease, summarySha256, title: opts.title ?? 'TEST validation summary (DEMO-ONLY)', signatureId }),
  );
  return { id, schemaRelease, summarySha256 };
}

/**
 * Records `interfaces` as the approved system description under a new change record (raised by the system owner,
 * approved by QA's signature, closed afterwards). Returns the change record's number.
 */
export async function approveSystemDescription(acts: ValidationActs, interfaces: readonly config.SystemInterface[]): Promise<string> {
  const number = `CR-TEST-SYSDESC-${randomBytes(4).toString('hex').toUpperCase()}`;
  const owner = reason(await acts.systemOwner(), 'test installation: the approved system description');
  await withCommand(acts.app, owner, (c) =>
    config.raiseChangeRecord(c, {
      number,
      title: 'TEST system description',
      description: `The interfaces of the test installation: ${interfaces.map((i) => i.adapterCode).join(', ') || 'none'}`,
      areas: [config.SYSTEM_DESCRIPTION_AREA],
    }),
  );
  const signatureId = await acts.qaSign({ type: config.CHANGE_RECORD_AGGREGATE, id: number }, config.CHANGE_RECORD_MEANING, 'OPEN');
  await withCommand(acts.app, reason(await acts.qa(), 'test installation: approve the system description change'), (c) =>
    config.approveChangeRecord(c, number, signatureId),
  );
  const under = { ...reason(await acts.systemOwner(), 'test installation: the approved system description'), changeRecord: number };
  await withCommand(acts.app, under, async (c) => {
    for (const i of interfaces) await config.describeInterface(c, i);
  });
  await withCommand(acts.app, reason(await acts.systemOwner(), 'test installation: close the system description change'), (c) =>
    config.closeChangeRecord(c, number, 'the test installation\'s interfaces are recorded'),
  );
  return number;
}

/**
 * The validation acts of a seeded site: QA is persona `qa` (default the GMP site's QA reviewer `qaInvestigator`),
 * signing at its home terminal with user ID and password; the system owner is the bootstrap process owner. Registers
 * a DEMO-ONLY seal key for the signatures (unless `sealKey` is given).
 */
export async function seededValidationActs(
  db: DatabaseHandle,
  seed: SiteSeed,
  opts: { qa?: string; sealKey?: esig.SealKeyProvider } = {},
): Promise<ValidationActs> {
  const qaKey = opts.qa ?? 'qaInvestigator';
  const p = personaOf(seed, qaKey);
  const t = terminalOf(seed, p.homeTerminal);
  let key = opts.sealKey;
  if (!key) {
    key = esig.hmacSealKey(`test-validation-${randomBytes(4).toString('hex')}`, randomBytes(32));
    const admin = await passwordActor(db, seed.bootstrap.admin, seed.bootstrap.admin.fingerprint, {
      reasonCode: 'TEST_SETUP',
      reasonText: 'register a DEMO-ONLY seal key for the validation approvals',
    });
    const k = key;
    await withCommand(db.app, admin, (c) => esig.registerSealKey(c, k, 'DEMO-ONLY seal key (validation approvals)'));
  }
  const sealKey = key;
  const qa = async (): Promise<ActorContext> => openPersonaSession(db, seed, qaKey);
  return {
    app: db.app,
    qa,
    qaSign: async (aggregate, meaning, expectedState) => {
      const actor = reason(await qa(), 'test installation: a validation approval');
      const content = await esig.contentForSigning(db.admin, aggregate.type, aggregate.id);
      const challenge = await withCommand(db.app, actor, (c) =>
        esig.createChallenge(c, { aggregateType: aggregate.type, aggregateId: aggregate.id, contentVersion: content.contentVersion ?? '1', meaning, clientContentHash: content.contentHash ?? '' }),
      );
      const ev = await identity.authenticate(db.authn, { method: 'PASSWORD', identifier: p.loginName, secret: p.password, deviceFingerprint: t.fingerprint, purpose: 'SIGNATURE', challengeId: challenge.challengeId });
      const signed = await withCommand(db.app, actor, (c) => esig.sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState }, sealKey));
      return signed.signatureId;
    },
    systemOwner: () => passwordActor(db, seed.bootstrap.owner, seed.bootstrap.owner.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'test installation set-up' }),
  };
}
