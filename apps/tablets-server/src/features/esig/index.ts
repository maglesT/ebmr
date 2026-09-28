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
 *     Any failure rolls the whole command back (signature, seal, consumed event); esig.logSigningFailure then
 *     records it outside the rolled-back transaction (INV-10), with the authentication event it used, so the kernel
 *     checks the attempt for misuse and alerts the security unit on what the committed rows prove (DI-19; proxy
 *     signing included). Every signing failure is logged with its event whenever authentication produced one.
 *     Refused before signing (the dry run refused, or CONTENT_CHANGED): the attempt rolls back like any failure and
 *     is logged with its event. The kernel reads any committed use of the event as another command's (re-use,
 *     EBMR-IAM-091), so logging comes first. Then the refusal is written: a second command attributed by the same
 *     event runs the dry run again, commits only what the handler records on purpose (its refusal record, plan
 *     section 6), and stores the answer under the idempotency key. Nothing is signed, and the logged refusal is
 *     answered. A resend of a stored refusal rolls back too, and is logged with its own event.
 *  4. GET signatures: the stored manifestations of a record, with their current validity (DI-36, INV-09).
 *
 * Credentials: badge and PIN on kiosks (the badge of the challenge's tap is kept by the server, see badges.ts),
 * user ID and password on office PCs; never logged, cached or re-sent. A lost sign response is reconciled by the
 * browser reloading the signatures, never by sending the credentials again.
 */
import { routes, type ChallengeView, type ManifestationView, type Refusal, type SignableAction, type SignableContentView } from '@ebmr/api-contract';
import { esig, identity, type commands } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import { otherTerminal } from '../../platform/auth/attribution.ts';
import { without } from '../../platform/auth/device-proof.ts';
import { isShopFloor, type ResolvedSession } from '../../platform/auth/session.ts';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes, pathOf } from '../../platform/http/bind.ts';
import { HttpRefusal, refusal } from '../../platform/http/refusal.ts';
import type { SignableActionHandler, SignableActionRegistry } from '../../platform/ports.ts';
import { ChallengeBadgeStore } from './badges.ts';
import { kernelContent, type EsigSignableContext } from './content.ts';
import { ESIG_GUIDANCE } from './guidance.ts';
import { esigStubHandler } from './stub.ts';
import { manifestationView, meaningInfo, meaningPhrase, readChallenge, type StoredChallenge } from './views.ts';

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

function signableContext(session: ResolvedSession, actor: EsigSignableContext['actor'], meaning: string): EsigSignableContext {
  return { actor, room: session.roomCode, deviceClass: session.deviceClass, meaning };
}

/**
 * A refusal answered for a signing, recorded in the kernel's signing-failure log first (after the attempt rolled
 * back). With the signature authentication the attempt used, the kernel checks the attempt for misuse (re-use, an
 * authentication for another challenge or made before it, missing components, another person, account or terminal)
 * and alerts the security unit on what the committed rows prove (DI-19). It is omitted only when authentication
 * produced no event (a wrong PIN or password, a locked account).
 */
async function logged(app: AppContext, challengeId: string, error: unknown, authEventId?: string): Promise<void> {
  await esig.logSigningFailure(app.pools.app, challengeId, error, authEventId);
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

type RefusedWork = { refused: { status: number; refusal: Refusal } };
type SignedWork = { signed: { manifestation: ManifestationView; result: Record<string, unknown> | null } };
type SignWork = RefusedWork | SignedWork;

/**
 * A refusal before esig.sign (the handler's dry run, or content changed since the challenge), thrown so that the
 * attempt's command rolls back before the refusal is logged with its authentication event; `replayed`: the stored
 * answer of an earlier request with the same idempotency key. Its message carries no refusal code, so the command
 * wrapper passes it through unchanged.
 */
class RefusedBeforeSigning extends Error {
  constructor(
    readonly refused: RefusedWork['refused'],
    readonly replayed: boolean,
  ) {
    super('the signing was refused before signing; the attempt rolls back and is logged with its authentication');
    this.name = 'RefusedBeforeSigning';
  }
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
        const handler = app.signables.forAggregateType(query.aggregateType);
        const view: SignableContentView = handler ? await handler.previewContent(signableContext(s, actor(), query.intent), query) : await kernelContent(app.pools.app, query);
        if (view.aggregateType !== query.aggregateType || view.aggregateId !== query.aggregateId) throw mismatch('The preview names another record than the one asked for.');
        return view;
      },

      createChallenge: async ({ body, requireSession, actor, idempotencyKey, requestHash }) => {
        const s = requireSession();
        sealKeyOf(app);
        const handler = handlerFor(app, body.action.kind);
        const d = handler.describe(body.action);
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
          const stored = await readChallenge(client, ch.challengeId);
          if (!stored) throw new Error('the new challenge could not be read back');
          const preview = ch.manifestationPreview;
          const view: ChallengeView = {
            challengeId: ch.challengeId,
            aggregateType: body.aggregateType,
            aggregateId: body.aggregateId,
            contentVersion: ch.contentVersion,
            contentHash: ch.contentHash,
            meaning: ch.meaning.code,
            expiresAt: app.formatInstant(stored.expiresUs),
            expiresInSeconds: Math.max(1, stored.secondsLeft),
            requires: isShopFloor(s.deviceClass) ? ['PIN'] : ['USER_ID', 'PASSWORD'],
            manifestation: {
              legalName: typeof preview['printed_name'] === 'string' ? preview['printed_name'] : s.legalName,
              loginName: typeof preview['user_id'] === 'string' ? preview['user_id'] : s.loginName,
              role: typeof preview['role_code'] === 'string' ? preview['role_code'] : (s.roleCode ?? ''),
              meaning: ch.meaning.code,
              meaningText: meaningPhrase(ch.meaning.title),
              zone: typeof preview['site_zone'] === 'string' ? preview['site_zone'] : app.siteZone.current(),
            },
          };
          return view;
        });
        const view = out.result;
        if (out.replayed) {
          const stored = await readChallenge(app.pools.app, view.challengeId);
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
        const d = handler.describe(body.action);
        const ch: StoredChallenge | null = await readChallenge(app.pools.app, body.challengeId);
        if (!ch || ch.sessionId !== s.sessionId) {
          throw refusal(409, { code: 'EBMR-ESIG-031', kind: 'STALE', whatHappened: 'This signing request is not known here. Nothing was signed.', why: 'The challenge does not exist or belongs to another session.', controls: ['DI-38'], whatYouCanDo: ['Start the signing again.'] });
        }
        if (d.aggregateType !== ch.aggregateType || d.aggregateId !== ch.aggregateId || (d.meaning !== '' && d.meaning !== ch.meaning)) {
          throw mismatch('The action to apply is not the one the challenge was issued for.');
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
        let identifier: string;
        let secret: string;
        if (c.kind === 'PIN') {
          const badge = badges.peek(ch.challengeId, s.tokenHash, s.personId);
          if (!badge) {
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
          await logged(app, ch.challengeId, error);
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
          await logged(app, ch.challengeId, new Error(`EBMR-IAM-093 the signature authentication belongs to another person (no proxy signing)`), ev.authEventId);
          throw e;
        }
        const a = { ...actor(), authEventId: ev.authEventId };
        const ctx = signableContext(s, a, ch.meaning);
        const key = idempotencyKey ?? '';
        let signed: SignedWork['signed'];
        try {
          // The attempt. A refusal before esig.sign rolls it back (RefusedBeforeSigning), and so does the replay of a
          // stored refusal: the refusal is then logged while no committed row uses this authentication (see below).
          const out = await withIdempotentActorCommand(
            app.pools.app,
            a,
            key,
            requestHash,
            async (client) => {
              const dry = await handler.dryRun(client, ctx, body.action);
              if (!dry.accepted) throw new RefusedBeforeSigning({ status: dry.status, refusal: dry.refusal }, false);
              if (dry.contentHash !== ch.contentHash || dry.contentVersion !== ch.contentVersion) {
                throw new RefusedBeforeSigning({ status: 409, refusal: contentChanged(`The record is now at content version ${dry.contentVersion}; the challenge was for version ${ch.contentVersion}.`) }, false);
              }
              const sig = await esig.sign(client, { challengeId: ch.challengeId, authEventId: ev.authEventId, expectedState: d.expectedState ?? null }, sealKey);
              const applied = await handler.apply(client, ctx, body.action, { signatureId: sig.signatureId, meaning: ch.meaning, signer: ch.signerPerson });
              const result: SignWork = { signed: { manifestation: manifestationView(sig.manifestation, ch.signerPerson, true), result: applied } };
              return result as unknown as commands.JsonValue;
            },
            {
              beforeReplay: (stored) => {
                const w = stored as unknown as SignWork;
                if ('refused' in w) throw new RefusedBeforeSigning(w.refused, true);
              },
            },
          );
          signed = (out.result as unknown as SignedWork).signed;
        } catch (error) {
          if (!(error instanceof RefusedBeforeSigning)) {
            if (!(error instanceof HttpRefusal)) await logged(app, ch.challengeId, error, ev.authEventId);
            throw error;
          }
          // Logged with the authentication the attempt used while no committed row uses it (the attempt rolled back),
          // so the kernel runs every attempted-misuse check on it (DI-19: re-use, another challenge, pre-signing,
          // missing components; esig.signing_misuse reads a committed use as another command's).
          const { refused } = error;
          await logged(app, ch.challengeId, new Error(`${refused.refusal.code} ${refused.refusal.why || refused.refusal.whatHappened}`), ev.authEventId);
          // Then the refusal is written (plan section 6: the refused COMMAND row, attributed by this authentication):
          // the dry run runs again in a command that commits what the handler records on purpose (the refusal it
          // finds now, normally this one) and stores the answer given here under the idempotency key; it never signs.
          // A replayed refusal was written when it was first answered.
          if (!error.replayed) {
            let written: SignWork;
            try {
              const out = await withIdempotentActorCommand(app.pools.app, a, key, requestHash, async (client) => {
                await handler.dryRun(client, ctx, body.action);
                const result: SignWork = { refused };
                return result as unknown as commands.JsonValue;
              });
              written = out.result as unknown as SignWork;
            } catch (e) {
              if (!(e instanceof HttpRefusal)) await logged(app, ch.challengeId, e, ev.authEventId);
              throw e;
            }
            // A concurrent resend with the same key may have answered first: its stored result is the answer.
            if ('signed' in written) return written.signed;
            throw new HttpRefusal(written.refused.status, written.refused.refusal);
          }
          throw new HttpRefusal(refused.status, refused.refusal);
        }
        return signed;
      },

      signatures: async ({ query }) => {
        const list = await esig.recordSignatures(app.pools.app, query.aggregateType, query.aggregateId);
        const signatures: ManifestationView[] = [];
        for (const r of list) {
          const stored = await esig.getManifestation(app.pools.app, r.signatureId);
          signatures.push(manifestationView(stored.manifestation, r.signerPerson, stored.valid));
        }
        return { signatures };
      },
    },
    { rateLimits: { sign: { max: 20, timeWindow: '1 minute', by: 'SESSION' } } },
  );
  return Promise.resolve();
}
