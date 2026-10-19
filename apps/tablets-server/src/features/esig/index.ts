/**
 * Feature `esig` (module C1; plan section 6): the e-signature ceremony endpoints, both installations.
 *
 *  1. GET content: the exact canonical text to be signed, its hash and content version. A signable handler
 *     previews it (for engine actions: the step as it will be after the sweep and finalisation); otherwise the
 *     kernel's esig.content_for_signing. `intent` is the meaning code the signer is asked to sign.
 *  2. POST challenges (FRESH_ON_SHARED: the signer's own tap attributes it on a kiosk): one idempotent command
 *     runs handler.prepareForChallenge and esig.create_challenge, which refuses a client hash that is not the
 *     server's (EBMR-ESIG-013: "the record changed while you were reviewing it").
 *  3. POST sign: the signer authenticates for the challenge on the authentication pool (identity.authenticate,
 *     purpose SIGNATURE; a failure is recorded and counts toward lockout), then ONE idempotent command whose
 *     actor carries that event (it attributes the command and is consumed by the signature):
 *       handler.dryRun, with a placeholder signature (refused, or accepted with another content hash than the
 *       challenge's: see below);
 *       esig.sign and the seal (kernel: the only writer of signatures; unsealed signatures cannot commit);
 *       handler.apply with the real signature.
 *     Every signing failure is logged with its event whenever authentication produced one, and the kernel checks
 *     the attempt for misuse and alerts the security unit on what the committed rows prove (DI-19; proxy signing
 *     included).
 *     Refused before signing (the dry run returned a refusal, or CONTENT_CHANGED): the same one command logs the
 *     refusal with the event (tab.record_signing_failure, inside the command: the kernel's esig.record_signing_failure
 *     for a request made in this session, tablets 0620), stores the answer under the
 *     idempotency key and commits, together with what the handler records on purpose (its refusal record, plan
 *     section 6); nothing is signed. The kernel sets aside exactly this command's own use of the event (kernel
 *     0950: the COMMAND use of this transaction by the validated command the event attributes), so it runs every
 *     attempted-misuse check on the event (re-use by another command, another challenge, pre-signing, missing
 *     components) without reading the attempt's own attribution as re-use. That needs the command's validated actor
 *     context to still hold when the dry run returns: a handler never leaves a switched context behind. The dry
 *     run runs once: the refusal recorded, logged and answered is the one it found. A resend of a stored refusal
 *     is one command too: it is answered from the stored refusal without a new dry run and logged, inside its
 *     command, with its own fresh authentication event.
 *     Any other failure rolls the whole command back (signature, seal, consumed event, and whatever the dry run
 *     wrote), a refusal the handler throws included (an HttpRefusal, for example a run that is not found);
 *     esig.logSigningFailure then records it outside the rolled-back transaction (INV-10), through the same
 *     session-checked tab.record_signing_failure, with the authentication event it used and, for a thrown refusal,
 *     its code and reason as a returned refusal is logged.
 *  4. GET signatures: the stored manifestations of a record, with their current validity (DI-36, INV-09).
 * Steps 1 and 4 read for the session only what the database lets it read (tablets 0410, review F34): a record of its
 * role's read class (RECORD.READ, or a governance role for an investigation, a disposal or a restore, never the
 * investigation's own subject), previewed only with a meaning its role signs (on a shop-floor terminal the person who
 * taps signs, and esig.sign checks that person), and through the kernel's provider only the pairs this installation
 * signs that way.
 *
 * Credentials: badge and PIN on kiosks (the badge of the challenge's tap is kept by the server, see badges.ts),
 * user ID and password on office PCs; never logged, cached or re-sent. A lost sign response is reconciled by the
 * browser reloading the signatures, never by sending the credentials again. A kiosk sign request whose challenge
 * already holds its signature (a resend after a lost answer, a double submit) finds no badge kept and is answered
 * ESIG_ALREADY_SIGNED, never "nothing was signed" (Phase 2 exit review F40); one whose PIN another request already
 * confirmed, without a signature yet (still running, or refused), ESIG_REQUEST_USED; ESIG_TAP_AGAIN only when
 * nothing confirmed the challenge.
 */
import { routes, type ChallengeView, type ManifestationView, type Refusal, type SignableAction, type SignableContentView } from '@ebmr/api-contract';
import { esig, identity, type commands } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { otherTerminal } from '../../platform/auth/attribution.ts';
import { without } from '../../platform/auth/device-proof.ts';
import { isShopFloor, type ResolvedSession } from '../../platform/auth/session.ts';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes, pathOf } from '../../platform/http/bind.ts';
import { HttpRefusal, refusal } from '../../platform/http/refusal.ts';
import type { SignableActionHandler, SignableActionRegistry } from '../../platform/ports.ts';
import { ChallengeBadgeStore } from './badges.ts';
import { kernelContent, meaningOfIntent, recordContentForSigning, type EsigSignableContext } from './content.ts';
import { ESIG_GUIDANCE } from './guidance.ts';
import { addMeaningType, configureMeaningType, meaningTypes, retireSealKey, sealKeys } from './catalogue.ts';
import { dscConfiguration, dscEnrolment, endDscEnrolment, enrolDsc, registerDscAnchor, setDscMeaning, setDscMode } from './dsc.ts';
import { esigStubHandler } from './stub.ts';
import { manifestationView, meaningInfo, meaningPhrase, readChallenge, recordSignaturesFor, type StoredChallenge } from './views.ts';

export const guidance = ESIG_GUIDANCE;

/** DEMO-ONLY: the stub signable exists only on demo installations (the E2E ceremony spec and the owner demo). */
export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.demo.enabled) registry.register(esigStubHandler(app));
}

export { esigStubHandler } from './stub.ts';

const badgeStores = new WeakMap<AppContext, ChallengeBadgeStore>();

/** The server's store of challenge badges (one per AppContext). */
export function challengeBadges(app: AppContext): ChallengeBadgeStore {
  let s = badgeStores.get(app);
  if (!s) {
    s = new ChallengeBadgeStore();
    badgeStores.set(app, s);
  }
  return s;
}

function handlerFor(app: AppContext, kind: SignableAction['kind']): SignableActionHandler {
  const h = app.signables.forKind(kind);
  if (!h) {
    throw refusal(422, {
      code: 'SIGNABLE_NOT_ENABLED',
      kind: 'NOT_ENABLED',
      whatHappened: 'This kind of signature is not available on this installation.',
      why: `No signable action ${kind} is registered here.`,
      controls: ['DI-35'],
      whatYouCanDo: ['Check that you are on the right installation.'],
    });
  }
  return h;
}

function mismatch(why: string): Error {
  return refusal(422, {
    code: 'ESIG_ACTION_MISMATCH',
    kind: 'INVALID_INPUT',
    whatHappened: 'The signing request does not match the action it would sign. Nothing was signed.',
    why,
    controls: ['DI-37'],
    whatYouCanDo: ['Reload the screen and start the signing again.'],
  });
}

function sealKeyOf(app: AppContext): esig.SealKeyProvider {
  if (!app.sealKey) {
    throw refusal(503, {
      code: 'SIGNING_NOT_CONFIGURED',
      kind: 'NOT_ENABLED',
      whatHappened: 'Signing is not available on this installation: no seal key is configured.',
      why: 'Every signature is sealed with the installation key (EBMR_SEAL_KEY_FILE; a KMS or HSM in production).',
      controls: ['DI-37'],
      whatYouCanDo: ['Stop and report it.'],
      whoCanHelp: ['The system administrator'],
    });
  }
  return app.sealKey;
}

const contentChanged = (why: string): Refusal => ({
  code: 'CONTENT_CHANGED',
  kind: 'CONTENT_CHANGED',
  whatHappened: 'The record changed while you were reviewing it. Nothing was signed.',
  why,
  controls: ['DI-37'],
  whatYouCanDo: ['Review the current content, then sign again.'],
  whoCanHelp: [],
});

/**
 * How a challenge of this session was used: the signature made for it (a challenge signs once; read through the
 * session-checked tab.session_challenge, tablets 0610), and whether a signature authentication for it succeeded
 * (iam.auth_event, purpose SIGNATURE: the kiosk badge is forgotten right after it).
 */
async function challengeUse(db: pg.Pool | pg.PoolClient, tokenHash: string, challengeId: string): Promise<{ signatureId: string | null; authenticated: boolean }> {
  const { rows } = await db.query<{ signature_id: string | null; authenticated: boolean }>(
    `select (select c.signature_id::text from tab.session_challenge($1, $2::uuid) c) as signature_id,
            exists (select 1 from iam.auth_event e where e.challenge_id = $2::uuid and e.purpose = 'SIGNATURE') as authenticated`,
    [tokenHash, challengeId],
  );
  return { signatureId: rows[0]?.signature_id ?? null, authenticated: rows[0]?.authenticated === true };
}

/** A sign request for a challenge that already holds its signature: used, never "nothing was signed" (F40; DI-38, INV-10). */
const alreadySigned = (signatureId: string): Error =>
  refusal(409, {
    code: 'ESIG_ALREADY_SIGNED',
    kind: 'STALE',
    whatHappened: 'This signing request was already used: the record holds its signature. Nothing more was signed.',
    why: `Signature ${signatureId} was made for this signing request; a signing request is used once.`,
    controls: ['DI-38', 'INV-10'],
    whatYouCanDo: ["Reload the record's signatures; do not sign again."],
  });

/**
 * A sign request for a challenge whose PIN was already accepted by another request that has not signed (it is still
 * running, or it was refused): this request signed nothing more, and whether the signing went through is told by the
 * record's signatures, not by this answer (F40).
 */
const requestUsed = (): Error =>
  refusal(409, {
    code: 'ESIG_REQUEST_USED',
    kind: 'STALE',
    whatHappened: 'This signing request was already confirmed by another request with your PIN. This request signed nothing more.',
    why: 'A signing request is confirmed once; the badge tapped for it is not kept after its confirmation.',
    controls: ['DI-38', 'INV-10'],
    whatYouCanDo: ["Reload the record's signatures to see whether the signing went through; start a new signing only if it did not."],
  });

function signableContext(session: ResolvedSession, actor: EsigSignableContext['actor'], meaning: string): EsigSignableContext {
  return { actor, room: session.roomCode, deviceClass: session.deviceClass, meaning, tokenHash: session.tokenHash };
}

/** The database refused this session the preview (tablets 0410, review F34): nothing of the record is shown. */
function previewRefused(aggregateType: string, aggregateId: string, problem: string): Error {
  return refusal(403, {
    code: 'ESIG_PREVIEW_NOT_ALLOWED',
    kind: 'NOT_ALLOWED',
    whatHappened: 'You may not see this record as content to be signed. Nothing of it is shown.',
    why: `${aggregateType} ${aggregateId}: ${problem}.`,
    controls: ['DI-17', 'DI-50'],
    whatYouCanDo: ['Sign only what your role signs; ask the person whose role signs it.'],
    whoCanHelp: ['The system administrator (role grants)'],
  });
}

type RefusedWork = { refused: { status: number; refusal: Refusal } };
type SignedWork = { signed: { manifestation: ManifestationView; result: Record<string, unknown> | null; companion?: ManifestationView } };

/** What the action signs, read now when the handler can (a record whose id or meaning depends on the database). */
async function describeAction(app: AppContext, handler: SignableActionHandler, action: SignableAction): Promise<ReturnType<SignableActionHandler['describe']>> {
  return handler.describeNow ? handler.describeNow(app.pools.app, action) : handler.describe(action);
}
type SignWork = RefusedWork | SignedWork;

/**
 * The message a refusal is logged with: its code first, then why (the kernel keeps an EBMR code as the failure's
 * code and logs any other code as UNKNOWN, with this message).
 */
function refusalMessage(r: Refusal): string {
  return `${r.code} ${r.why || r.whatHappened}`;
}

/**
 * A failed signing, recorded in the kernel's signing-failure log after the attempt rolled back. With the signature
 * authentication the attempt used, the kernel checks the attempt for misuse (re-use, an authentication for another
 * challenge or made before it, missing components, another person, account or terminal) and alerts the security
 * unit on what the committed rows prove (DI-19). It is omitted only when authentication produced no event (a wrong
 * PIN or password, a locked account). A refusal thrown as an HttpRefusal (by a handler, for example) is logged with
 * its code and reason, as a refusal the dry run returns is logged inside the command.
 */
async function logged(app: AppContext, tokenHash: string, challengeId: string, error: unknown, authEventId?: string): Promise<void> {
  const failure = error instanceof HttpRefusal ? new Error(refusalMessage(error.refusal), { cause: error }) : error;
  await esig.logSigningFailure(app.pools.app, challengeId, failure, authEventId, {
    record: (code, message) => app.pools.app.query('select tab.record_signing_failure($1, $2, $3, $4, $5)', [tokenHash, challengeId, authEventId ?? null, code, message]),
  });
}

/**
 * A refusal before signing, recorded in the kernel's signing-failure log INSIDE the attempt's own command, the one
 * its signature authentication attributes: the kernel runs the same misuse checks and sets aside only this
 * command's own use of the event (kernel 0950). Called here, the log commits with the refusal record and the
 * stored answer, or not at all: an error rolls the command back and is logged after the rollback like any failure.
 * It runs on the command's own client and lets errors through (esig.logSigningFailure, on the pool, swallows them:
 * inside a transaction that would leave it aborted).
 */
async function loggedInCommand(client: pg.PoolClient, tokenHash: string, challengeId: string, refused: RefusedWork['refused'], authEventId: string): Promise<void> {
  await client.query('select tab.record_signing_failure($1, $2, $3, $4, $5)', [tokenHash, challengeId, authEventId, refused.refusal.code, refusalMessage(refused.refusal)]);
}

/** A failed signature authentication in plain language; why it failed stays in the security log (DI-19). */
function signingAuthRefusal(error: unknown, kind: 'PIN' | 'PASSWORD'): unknown {
  if (!(error instanceof identity.AuthenticationFailedError)) return error;
  if (error.locked || error.reason === 'ACCOUNT_LOCKED') {
    return refusal(423, {
      code: 'AUTH_LOCKED',
      kind: 'LOCKED',
      whatHappened: 'The account is locked after too many failed attempts. Nothing was signed.',
      why: 'Failed signing attempts count toward the account lock.',
      controls: ['DI-19', 'DI-38'],
      whatYouCanDo: ['Ask for the account to be unlocked; do not keep trying.'],
      whoCanHelp: ['The system administrator'],
    });
  }
  return refusal(
    401,
    {
      code: 'EBMR-IAM-140',
      kind: 'AUTH_FAILED',
      whatHappened: kind === 'PIN' ? 'The PIN was not accepted. Nothing was signed.' : 'The user ID or password was not accepted. Nothing was signed.',
      why: 'Each failed attempt counts toward the account lock.',
      controls: ['DI-19', 'DI-38'],
      whatYouCanDo: [kind === 'PIN' ? 'Enter your own PIN again.' : 'Enter your own user ID and password again.'],
      whoCanHelp: ['Your supervisor', 'The system administrator (to unlock or reset)'],
    },
    true,
  );
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const badges = challengeBadges(app);

  bindRoutes(
    scope,
    app,
    routes.esig,
    {
      content: async ({ query, requireSession, actor }) => {
        const s = requireSession();
        // DI-17, DI-50 (tablets 0410, review F34): the database decides whether this session may read the record and
        // preview it as content to be signed with this meaning, before any handler or the kernel's provider reads it.
        const meaning = meaningOfIntent(query.intent);
        await meaningInfo(app.pools.app, meaning);
        const { rows } = await app.pools.app.query<{ p: string | null }>('select tab.signing_preview_problem($1, $2, $3, $4) as p', [s.tokenHash, query.aggregateType, query.aggregateId, meaning]);
        const problem = rows[0]?.p ?? null;
        if (problem !== null) throw previewRefused(query.aggregateType, query.aggregateId, problem);
        const handler = app.signables.forAggregateType(query.aggregateType);
        const view: SignableContentView = handler
          ? await handler.previewContent(signableContext(s, actor(), query.intent), query)
          : await kernelContent(app.pools.app, s.tokenHash, query);
        if (view.aggregateType !== query.aggregateType || view.aggregateId !== query.aggregateId) throw mismatch('The preview names another record than the one asked for.');
        return view;
      },

      createChallenge: async ({ body, requireSession, actor, idempotencyKey, requestHash }) => {
        const s = requireSession();
        sealKeyOf(app);
        const handler = handlerFor(app, body.action.kind);
        // Phase 4 slice 4 (D-P4-5): a two-row action opens a challenge for each of its records.
        const primary = await describeAction(app, handler, body.action);
        const companion = handler.companionOf?.(body.action);
        const d = companion && companion.aggregateType === body.aggregateType && companion.aggregateId === body.aggregateId ? companion : primary;
        if (d.aggregateType !== body.aggregateType || d.aggregateId !== body.aggregateId) throw mismatch(`The action signs ${d.aggregateType} ${d.aggregateId}.`);
        if (d.meaning !== '' && d.meaning !== body.meaning) throw mismatch(`The action is signed ${d.meaning}, not ${body.meaning}.`);
        await meaningInfo(app.pools.app, body.meaning);
        const a = actor();
        const ctx = signableContext(s, a, body.meaning);
        const out = await withIdempotentActorCommand(app.pools.app, a, idempotencyKey ?? '', requestHash, async (client) => {
          await handler.prepareForChallenge(client, ctx, body.action);
          const ch = await esig.createChallenge(client, {
            aggregateType: body.aggregateType,
            aggregateId: body.aggregateId,
            contentVersion: body.contentVersion,
            meaning: body.meaning,
            clientContentHash: body.clientContentHash,
          });
          const stored = await readChallenge(client, s.tokenHash, ch.challengeId);
          if (!stored) throw new Error('the new challenge could not be read back');
          const preview = ch.manifestationPreview;
          const view = {
            challengeId: ch.challengeId,
            aggregateType: body.aggregateType,
            aggregateId: body.aggregateId,
            contentVersion: ch.contentVersion,
            contentHash: ch.contentHash,
            meaning: ch.meaning.code,
            expiresAt: app.formatInstant(stored.expiresUs),
            expiresInSeconds: Math.max(1, stored.secondsLeft),
            requires: (isShopFloor(s.deviceClass) ? ['PIN'] : ['USER_ID', 'PASSWORD']) as ChallengeView['requires'],
            manifestation: {
              legalName: typeof preview['printed_name'] === 'string' ? preview['printed_name'] : s.legalName,
              loginName: typeof preview['user_id'] === 'string' ? preview['user_id'] : s.loginName,
              role: typeof preview['role_code'] === 'string' ? preview['role_code'] : (s.roleCode ?? ''),
              meaning: ch.meaning.code,
              meaningText: meaningPhrase(ch.meaning.title),
              zone: typeof preview['site_zone'] === 'string' ? preview['site_zone'] : app.siteZone.current(),
            },
          };
          // IN-10 (kernel 1203): the DSC statement the signer's token signs, when this meaning needs a DSC now.
          const dsc = await esig.dscRequirement(client, ch.challengeId);
          if (dsc.required && dsc.statement && dsc.mode !== 'OFF') return { ...view, dsc: { mode: dsc.mode, statement: dsc.statement, banner: dsc.banner } };
          return view;
        });
        const view = out.result;
        if (out.replayed) {
          const stored = await readChallenge(app.pools.app, s.tokenHash, view.challengeId);
          if (!stored || stored.secondsLeft <= 0) {
            throw refusal(409, { code: 'EBMR-ESIG-033', kind: 'STALE', whatHappened: 'The time to sign ran out. Nothing was signed.', why: 'This signing request has expired.', controls: ['DI-38'], whatYouCanDo: ['Start the signing again.'] });
          }
          view.expiresInSeconds = stored.secondsLeft;
        }
        // Kiosk: keep the badge of this tap for the PIN step (see badges.ts). Never logged or stored.
        if (isShopFloor(s.deviceClass) && body.attribution) badges.remember(view.challengeId, { badgeUid: body.attribution.badgeUid, tokenHash: s.tokenHash, personId: s.personId });
        return view;
      },

      sign: async ({ body, request, requireSession, actor, idempotencyKey, requestHash }) => {
        const s = requireSession();
        const sealKey = sealKeyOf(app);
        const handler = handlerFor(app, body.action.kind);
        const d = await describeAction(app, handler, body.action);
        const ch: StoredChallenge | null = await readChallenge(app.pools.app, s.tokenHash, body.challengeId);
        if (!ch || ch.sessionId !== s.sessionId) {
          throw refusal(409, { code: 'EBMR-ESIG-031', kind: 'STALE', whatHappened: 'This signing request is not known here. Nothing was signed.', why: 'The challenge does not exist or belongs to another session.', controls: ['DI-38'], whatYouCanDo: ['Start the signing again.'] });
        }
        if (d.aggregateType !== ch.aggregateType || d.aggregateId !== ch.aggregateId || (d.meaning !== '' && d.meaning !== ch.meaning)) {
          throw mismatch('The action to apply is not the one the challenge was issued for.');
        }
        // Phase 4 slice 4 (D-P4-5): a two-row action names its companion challenge (the same signer, its own record and
        // meaning); a one-row action names none.
        const comp = handler.companionOf?.(body.action);
        let ch2: StoredChallenge | null = null;
        if (comp || body.companionChallengeId) {
          if (!comp || !body.companionChallengeId) {
            throw mismatch(comp ? `This action is signed in two rows: the second is ${comp.meaning} on ${comp.aggregateType} ${comp.aggregateId}.` : 'This action is signed in one row; it takes no second challenge.');
          }
          ch2 = await readChallenge(app.pools.app, s.tokenHash, body.companionChallengeId);
          if (!ch2 || ch2.sessionId !== s.sessionId) {
            throw refusal(409, { code: 'EBMR-ESIG-031', kind: 'STALE', whatHappened: 'The second signing request is not known here. Nothing was signed.', why: 'The challenge does not exist or belongs to another session.', controls: ['DI-38'], whatYouCanDo: ['Start the signing again.'] });
          }
          if (ch2.challengeId === ch.challengeId || ch2.aggregateType !== comp.aggregateType || ch2.aggregateId !== comp.aggregateId || ch2.meaning !== comp.meaning || ch2.signerPerson !== ch.signerPerson) {
            throw mismatch('The second challenge is not the one this action signs with the first.');
          }
        }
        const { fingerprint, device } = await app.devices.identify(body.proof, { method: request.method, path: pathOf(request), body: without(body, 'proof') });
        if (device.deviceId !== s.deviceId) throw otherTerminal();
        const floor = isShopFloor(s.deviceClass);
        const c = body.credentials;
        if ((c.kind === 'PIN') !== floor) {
          throw refusal(422, {
            code: 'LOGIN_METHOD',
            kind: 'NOT_ALLOWED',
            whatHappened: floor ? 'On a kiosk you sign with your badge and PIN.' : 'On an office PC you sign with your user ID and password.',
            why: `${s.deviceCode} is a ${s.deviceClass} terminal.`,
            controls: ['DI-38'],
            whatYouCanDo: ['Sign with the components this terminal asks for.'],
          });
        }
        if (ch2 && floor) {
          throw refusal(422, {
            code: 'LOGIN_METHOD',
            kind: 'NOT_ALLOWED',
            whatHappened: 'A signing in two rows is made on an office PC. Nothing was signed.',
            why: `${s.deviceCode} is a ${s.deviceClass} terminal.`,
            controls: ['DI-38'],
            whatYouCanDo: ['Sign from an office PC.'],
          });
        }
        let identifier: string;
        let secret: string;
        if (c.kind === 'PIN') {
          const badge = badges.peek(ch.challengeId, s.tokenHash, s.personId);
          if (!badge) {
            // The badge is forgotten once the signing authenticated, so a resend of a signing that succeeded (an
            // answer lost, a double submit) arrives here: it is told that the request was used, never that nothing
            // was signed (Phase 2 exit review F40). The challenge is this session's own (checked above); nothing is
            // replayed without credentials.
            const used = await challengeUse(app.pools.app, s.tokenHash, ch.challengeId);
            if (used.signatureId !== null) throw alreadySigned(used.signatureId);
            if (used.authenticated) throw requestUsed();
            throw refusal(409, { code: 'ESIG_TAP_AGAIN', kind: 'STALE', whatHappened: 'The badge tap of this signing is no longer known. Nothing was signed.', why: 'A signing on a kiosk uses the badge tapped for it within its time limit.', controls: ['DI-38'], whatYouCanDo: ['Start the signing again and tap your badge.'] });
          }
          identifier = badge;
          secret = c.pin;
        } else {
          identifier = c.loginName;
          secret = c.password;
        }
        let ev: identity.AuthenticationEvent;
        try {
          ev = await identity.authenticate(app.pools.authn, { method: c.kind === 'PIN' ? 'BADGE_PIN' : 'PASSWORD', identifier, secret, deviceFingerprint: fingerprint, purpose: 'SIGNATURE', challengeId: ch.challengeId });
        } catch (error) {
          await logged(app, s.tokenHash, ch.challengeId, error);
          if (error instanceof identity.AuthenticationFailedError && (error.locked || error.reason === 'ACCOUNT_LOCKED')) badges.forget(ch.challengeId);
          throw signingAuthRefusal(error, c.kind);
        }
        badges.forget(ch.challengeId);
        if (ev.personId !== ch.signerPerson || ev.accountId !== ch.signerAccount) {
          const e = refusal(403, {
            code: 'EBMR-IAM-093',
            kind: 'INDEPENDENCE',
            whatHappened: 'Only the signer can confirm their own signature; nobody signs for another person. Nothing was signed.',
            why: 'The credentials entered belong to another person than the one named on the signature.',
            controls: ['DI-38'],
            whatYouCanDo: ['The person named on the signature enters their own credentials.'],
          });
          await logged(app, s.tokenHash, ch.challengeId, new Error(`EBMR-IAM-093 the signature authentication belongs to another person (no proxy signing)`), ev.authEventId);
          throw e;
        }
        // D-P4-5: the credentials are entered once; the second row gets an authentication event of its own, bound to its
        // own challenge (the kernel uses one event for one signature, INV-10).
        let ev2: identity.AuthenticationEvent | null = null;
        if (ch2) {
          try {
            ev2 = await identity.authenticate(app.pools.authn, { method: 'PASSWORD', identifier, secret, deviceFingerprint: fingerprint, purpose: 'SIGNATURE', challengeId: ch2.challengeId });
          } catch (error) {
            await logged(app, s.tokenHash, ch2.challengeId, error);
            throw signingAuthRefusal(error, c.kind);
          }
        }
        const a = { ...actor(handler.reasonOf?.(body.action)), authEventId: ev.authEventId };
        const ctx = signableContext(s, a, ch.meaning);
        const key = idempotencyKey ?? '';
        // The attempt, one command. A refusal before esig.sign is logged inside it, with this authentication, and
        // commits with what the handler recorded and the stored answer; a replayed refusal is logged the same way
        // with the resend's own authentication. Any other failure rolls it back and is logged afterwards.
        let work: SignWork;
        try {
          const out = await withIdempotentActorCommand(
            app.pools.app,
            a,
            key,
            requestHash,
            async (client) => {
              const dry = await handler.dryRun(client, ctx, body.action);
              const refused: RefusedWork['refused'] | null = !dry.accepted
                ? { status: dry.status, refusal: dry.refusal }
                : dry.contentHash !== ch.contentHash || dry.contentVersion !== ch.contentVersion
                  ? { status: 409, refusal: contentChanged(`The record is now at content version ${dry.contentVersion}; the challenge was for version ${ch.contentVersion}.`) }
                  : null;
              if (refused) {
                await loggedInCommand(client, s.tokenHash, ch.challengeId, refused, ev.authEventId);
                const result: SignWork = { refused };
                return result as unknown as commands.JsonValue;
              }
              const expectedState = d.expectedState ?? (handler.expectedStateNow ? await handler.expectedStateNow(client, body.action) : null);
              const delegationId = handler.delegationOf?.(body.action);
              const sig = await esig.sign(client, { challengeId: ch.challengeId, authEventId: ev.authEventId, expectedState, ...(delegationId ? { delegationId } : {}) }, sealKey);
              // IN-10 (kernel 1203): the DSC over the same content hash, verified against the configured anchor before it is
              // stored; a meaning that needs one cannot commit without it (EBMR-ESIG-084).
              await esig.recordDsc(client, sig.signatureId, body.dsc);
              let sig2: Awaited<ReturnType<typeof esig.sign>> | null = null;
              if (ch2 && ev2 && comp) {
                const state2 = comp.expectedState ?? (await recordContentForSigning(client, comp.aggregateType, comp.aggregateId)).state ?? null;
                sig2 = await esig.sign(client, { challengeId: ch2.challengeId, authEventId: ev2.authEventId, expectedState: state2 }, sealKey);
                await esig.recordDsc(client, sig2.signatureId, undefined);
              }
              const applied = await handler.apply(client, ctx, body.action, {
                signatureId: sig.signatureId,
                meaning: ch.meaning,
                signer: ch.signerPerson,
                ...(sig2 ? { companionSignatureId: sig2.signatureId } : {}),
              });
              const result: SignWork = {
                signed: {
                  manifestation: manifestationView(sig.manifestation, ch.signerPerson, true),
                  result: applied,
                  ...(sig2 && ch2 ? { companion: manifestationView(sig2.manifestation, ch2.signerPerson, true) } : {}),
                },
              };
              return result as unknown as commands.JsonValue;
            },
            {
              onReplay: async (client, stored) => {
                const w = stored as unknown as SignWork;
                if ('refused' in w) await loggedInCommand(client, s.tokenHash, ch.challengeId, w.refused, ev.authEventId);
              },
            },
          );
          work = out.result as unknown as SignWork;
        } catch (error) {
          // Every failure of the authenticated attempt is logged with its authentication, a refusal a handler threw
          // (which the command wrapper passes through as it is) included (INV-10, DI-19).
          await logged(app, s.tokenHash, ch.challengeId, error, ev.authEventId);
          throw error;
        }
        if ('refused' in work) throw new HttpRefusal(work.refused.status, work.refused.refusal);
        return work.signed;
      },

      // Phase 3 slice 6: what an action signs, as the handler computes it (the browser never derives it).
      describe: async ({ body, requireSession }) => {
        requireSession();
        const handler = handlerFor(app, body.action.kind);
        const d = await describeAction(app, handler, body.action);
        const comp = handler.companionOf?.(body.action);
        return {
          kind: body.action.kind,
          aggregateType: d.aggregateType,
          aggregateId: d.aggregateId,
          meaning: d.meaning === '' ? null : d.meaning,
          expectedState: d.expectedState ?? null,
          ...(comp ? { companion: { aggregateType: comp.aggregateType, aggregateId: comp.aggregateId, meaning: comp.meaning, expectedState: comp.expectedState ?? null } } : {}),
        };
      },

      // DI-17, DI-36, DI-50 (tablets 0410, review F34): only when the session's role may read the record.
      signatures: async ({ query, requireSession }) => {
        const s = requireSession();
        return { signatures: await recordSignaturesFor(app.pools.app, s.tokenHash, query.aggregateType, query.aggregateId) };
      },

      // Phase 6 slice 6f (IN-10): the India DSC option, under change records (dsc.ts).
      dscConfiguration: async ({ requireSession }) => {
        requireSession();
        return dscConfiguration(app.pools.app);
      },
      setDscMode: async ({ body, actor, idempotencyKey, requestHash }) => setDscMode(app.pools.app, actor(), idempotencyKey ?? '', requestHash, body),
      registerDscAnchor: async ({ body, actor, idempotencyKey, requestHash }) => registerDscAnchor(app.pools.app, actor(), idempotencyKey ?? '', requestHash, body),
      setDscMeaning: async ({ body, actor, idempotencyKey, requestHash }) => setDscMeaning(app.pools.app, actor(), idempotencyKey ?? '', requestHash, body),
      dscEnrolment: async ({ requireSession }) => {
        const s = requireSession();
        return dscEnrolment(app.pools.app, s.personId, s.accountId);
      },
      enrolDsc: async ({ body, actor, idempotencyKey, requestHash }) => enrolDsc(app.pools.app, actor(), idempotencyKey ?? '', requestHash, body),
      endDscEnrolment: async ({ body, actor, idempotencyKey, requestHash }) => endDscEnrolment(app.pools.app, actor(), idempotencyKey ?? '', requestHash, body),
      // Phase 7 slice 7g-3 (WP1): the signature catalogue and the seal keys (catalogue.ts).
      meaningTypes: async ({ requireSession }) => {
        requireSession();
        return { meaningTypes: await meaningTypes(app, app.pools.app) };
      },
      addMeaningType: async ({ body, actor }) => addMeaningType(app, actor(), body),
      configureMeaningType: async ({ params, body, actor }) => configureMeaningType(app, actor(), params.code, body),
      sealKeys: async ({ requireSession }) => {
        requireSession();
        return { sealKeys: await sealKeys(app, app.pools.app) };
      },
      retireSealKey: async ({ params, body, actor }) => ({ sealKeys: await retireSealKey(app, actor(), params.keyId, body) }),
    },
    { rateLimits: { sign: { max: 20, timeWindow: '1 minute', by: 'SESSION' } } },
  );
  return Promise.resolve();
}
